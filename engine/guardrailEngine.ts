import { canonicalJson, computeIdempotencyKey, getServerSecret, hmacHex } from "@/security/crypto";
import { verifyApprovalToken } from "@/security/approvalToken";
import type { SecretProvider } from "@/security/secretProvider";
import {
  commitReservation,
  refreshLifecycleStatus,
  releaseReservation,
} from "@/state/reservationLedger";
import type { HashChainLogger } from "@/logger/hashChainLogger";
import type { StateStore } from "@/state/stateStore";
import type { GatewayHandle } from "@/payments/razorpayClient";
import type {
  AuthorizationPolicy,
  GuardrailErrorCode,
  IntentProposal,
  MerchantCartQuote,
  PipelineStep,
  PipelineStepStatus,
  ReservationRecord,
  TransactionFailure,
  TransactionResult,
} from "@/types/agentGuard";

/**
 * AgentGuard guardrail engine — the sole authority for money movement.
 *
 * The agent proposes; this module decides and executes. Nothing the agent can say,
 * and nothing a hostile vendor can inject into catalog text, reaches the decision:
 * every constraint is read from a server-signed `AuthorizationPolicy` that the
 * agent cannot address or edit.
 *
 * ## Concurrency model — read this before refactoring
 *
 * Steps 0–3 and steps 4b–4d each form a single synchronous block with NO `await`
 * inside them. In Node's single-threaded event loop an unbroken synchronous block
 * cannot be interleaved with another request's block, which is what makes
 * check-and-reserve atomic without a mutex.
 *
 * Inserting an `await` between the budget check (4b) and the reservation write (4d)
 * reintroduces a TOCTOU ledger race in which two concurrent proposals both observe
 * headroom and both commit, draining past the cap. Do not split step 4 into two
 * async helpers. `tests/attacks.test.ts` → "concurrent budget drain" is the
 * regression test for exactly that bug.
 */

export const RATE_LIMIT_MAX_PROPOSALS = 5;
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const RESERVATION_TTL_MS = 300 * 1000; // 300 seconds

export const STEP_NAMES: Record<number, string> = {
  0: "Expired reservation sweep",
  1: "Idempotency guard",
  2: "Rate limit / agent loop guard",
  3: "Policy constraint checks",
  4: "Quote fetch + atomic budget reservation",
  5: "Human escalation gate",
  6: "Signed gateway execution",
};

export type FetchCartQuote = (itemId: string) => Promise<MerchantCartQuote>;

class PipelineTrace {
  private readonly steps: PipelineStep[] = [];

  record(step: number, status: PipelineStepStatus, detail: string): void {
    this.steps.push({ step, name: STEP_NAMES[step] ?? `Step ${step}`, status, detail });
  }

  /** Fill in every step the run never reached, so the visualizer shows all 7 rows. */
  finalize(): PipelineStep[] {
    const seen = new Set(this.steps.map((entry) => entry.step));
    for (let step = 0; step <= 6; step += 1) {
      if (!seen.has(step)) {
        this.steps.push({
          step,
          name: STEP_NAMES[step] ?? `Step ${step}`,
          status: "NOT_REACHED",
          detail: "Not evaluated — an earlier step returned",
        });
      }
    }
    return [...this.steps].sort((a, b) => a.step - b.step);
  }
}

export const DEFAULT_QUOTE_FETCH_TIMEOUT_MS = 5_000;

export interface GuardrailEngineDeps {
  store: StateStore;
  logger: HashChainLogger;
  gateway: GatewayHandle;
  secretProvider?: SecretProvider;
  /** Timeout for merchant cart quote fetch in milliseconds (defaults to 5,000ms). */
  quoteTimeoutMs?: number;
  /** Injectable clock (milliseconds since epoch) for deterministic expiry tests. */
  nowMs?: () => number;
}

export class GuardrailEngine {
  private readonly store: StateStore;
  private readonly logger: HashChainLogger;
  private readonly gateway: GatewayHandle;
  private readonly secretProvider?: SecretProvider;
  private readonly quoteTimeoutMs: number;
  private readonly nowMs: () => number;

  constructor(deps: GuardrailEngineDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
    this.gateway = deps.gateway;
    this.secretProvider = deps.secretProvider;
    this.quoteTimeoutMs = deps.quoteTimeoutMs ?? DEFAULT_QUOTE_FETCH_TIMEOUT_MS;
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  // =========================================================================
  // Main entry point
  // =========================================================================

  async processTransaction(
    policy: AuthorizationPolicy,
    proposal: IntentProposal,
    fetchCartQuote: FetchCartQuote,
  ): Promise<TransactionResult> {
    const trace = new PipelineTrace();
    const now = this.nowMs();
    const key = computeIdempotencyKey({
      authorizationId: proposal.authorizationId,
      merchantId: proposal.merchantId,
      proposedAmountInPaisa: proposal.proposedAmountInPaisa,
      clientNonce: proposal.clientNonce,
    });

    this.logger.log(policy.authorizationId, "INTENT_PROPOSAL_RECEIVED", {
      idempotencyKey: key,
      itemId: proposal.itemId,
      merchantId: proposal.merchantId,
      category: proposal.category,
      proposedAmountInPaisa: proposal.proposedAmountInPaisa,
      clientNonce: proposal.clientNonce,
      carriesApprovalToken: Boolean(proposal.humanApprovalToken),
    });

    // ---------------------------------------------------------------------
    // STEP 0 — sweep expired reservations (awaited)
    // ---------------------------------------------------------------------
    const swept = await this.sweepExpiredReservations(policy, now);
    trace.record(
      0,
      "PASSED",
      swept.length === 0
        ? "No expired reservations"
        : `Released ${swept.length} expired reservation(s) totalling ${swept.reduce(
            (sum, r) => sum + r.amountInPaisa,
            0,
          )} paisa`,
    );

    // ---------------------------------------------------------------------
    // STEP 1 — idempotency guard
    // ---------------------------------------------------------------------
    const existing = this.store.getIdempotency(key);
    let resumingEscalation = false;
    let quote: MerchantCartQuote | null = null;
    let reservation: ReservationRecord | null = null;

    if (existing?.status === "COMPLETED" && existing.result) {
      trace.record(1, "PASSED", "Replaying cached COMPLETED result — no re-execution");
      this.logger.log(policy.authorizationId, "IDEMPOTENT_REPLAY", {
        idempotencyKey: key,
        note: "Duplicate submission with an identical clientNonce; cached result returned",
        cachedOrderId: existing.result.success ? existing.result.orderId : null,
      });
      const cached = existing.result;
      if (cached.success) {
        return { ...cached, replayed: true, steps: trace.finalize() };
      }
      return { ...cached, steps: trace.finalize() };
    }

    if (existing?.status === "PENDING") {
      trace.record(1, "FAILED", "Another call already holds this idempotency key");
      return await this.fail(policy, key, trace, "ERR_CONCURRENT_MUTATION", 1, {
        reason: "A concurrent request is already processing this exact proposal",
        markFailed: false, // the in-flight owner decides this key's terminal status
      });
    }

    if (existing?.status === "AWAITING_APPROVAL") {
      quote = existing.quote ?? null;
      reservation = this.store.findReservationByIdempotencyKey(policy.authorizationId, key) ?? null;

      if (!quote || !reservation) {
        trace.record(1, "FAILED", "Escalation record is missing its quote or reservation");
        return await this.fail(policy, key, trace, "ERR_INTERNAL_INVARIANT", 1, {
          reason:
            "Idempotency key is AWAITING_APPROVAL but the locked quote or held reservation is gone",
        });
      }

      resumingEscalation = true;
      // Take ownership of the key for the duration of this call so that two
      // simultaneous resubmissions cannot both verify the same token and then both
      // try to settle the one reservation.
      await this.store.setIdempotency(key, policy.authorizationId, "PENDING", { quote });
      trace.record(
        1,
        "PASSED",
        `Resuming escalated proposal — reusing held reservation ${reservation.reservationId} ` +
          `and the quote locked at escalation time (${quote.totalQuoteInPaisa} paisa)`,
      );
      trace.record(2, "SKIPPED", "Skipped on escalation resubmission (not a new proposal)");
      trace.record(3, "SKIPPED", "Skipped on escalation resubmission (already validated)");
      trace.record(
        4,
        "SKIPPED",
        "Skipped on escalation resubmission — no re-quote, no second reservation",
      );
    } else {
      await this.store.setIdempotency(key, policy.authorizationId, "PENDING");
      trace.record(1, "PASSED", `New proposal, idempotency key claimed (${key.slice(0, 16)}…)`);
    }

    if (!resumingEscalation) {
      // -------------------------------------------------------------------
      // STEP 2 — rate limit / loop guard
      // -------------------------------------------------------------------
      const rate = await this.store.recordProposalAttempt(
        policy.authorizationId,
        RATE_LIMIT_WINDOW_MS,
        RATE_LIMIT_MAX_PROPOSALS,
        now,
      );
      if (!rate.allowed) {
        trace.record(
          2,
          "FAILED",
          `${rate.count} proposals in the current ${RATE_LIMIT_WINDOW_MS / 60000}-minute window ` +
            `(max ${RATE_LIMIT_MAX_PROPOSALS})`,
        );
        return await this.fail(policy, key, trace, "ERR_AGENT_LOOP_DETECTED", 2, {
          reason:
            `Agent submitted ${rate.count} proposals for this authorization within ` +
            `${RATE_LIMIT_WINDOW_MS / 60000} minutes; limit is ${RATE_LIMIT_MAX_PROPOSALS}`,
          details: { proposalCount: rate.count, windowResetsAt: new Date(rate.windowResetsAtMs).toISOString() },
        });
      }
      trace.record(2, "PASSED", `Proposal ${rate.count} of ${RATE_LIMIT_MAX_PROPOSALS} in window`);

      // -------------------------------------------------------------------
      // STEP 3 — policy constraint checks (synchronous)
      // -------------------------------------------------------------------
      if (policy.state.status === "EXHAUSTED" || policy.state.status === "REVOKED") {
        trace.record(3, "FAILED", `Authorization status is ${policy.state.status}`);
        return await this.fail(policy, key, trace, "ERR_POLICY_NOT_ACTIVE", 3, {
          reason: `Authorization is ${policy.state.status} and can no longer be spent against`,
        });
      }

      const expiresAtMs = Date.parse(policy.constraints.expiresAt);
      if (Number.isNaN(expiresAtMs) || now >= expiresAtMs) {
        trace.record(3, "FAILED", `Authorization expired at ${policy.constraints.expiresAt}`);
        return await this.fail(policy, key, trace, "ERR_AUTHORIZATION_EXPIRED", 3, {
          reason: `Authorization expired at ${policy.constraints.expiresAt}`,
        });
      }

      if (!policy.constraints.allowedCategories.includes(proposal.category)) {
        trace.record(3, "FAILED", `Category "${proposal.category}" is not in the allowlist`);
        return await this.fail(policy, key, trace, "ERR_CATEGORY_NOT_ALLOWED", 3, {
          reason: `Category "${proposal.category}" is not permitted by this authorization`,
          details: { allowedCategories: policy.constraints.allowedCategories },
        });
      }

      if (!policy.constraints.allowedMerchants.includes(proposal.merchantId)) {
        trace.record(3, "FAILED", `Merchant "${proposal.merchantId}" is not in the allowlist`);
        return await this.fail(policy, key, trace, "ERR_MERCHANT_NOT_ALLOWED", 3, {
          reason: `Merchant "${proposal.merchantId}" is not permitted by this authorization`,
          details: { allowedMerchants: policy.constraints.allowedMerchants },
        });
      }

      trace.record(
        3,
        "PASSED",
        `Status ${policy.state.status}, within validity window, category and merchant allowlisted`,
      );

      // -------------------------------------------------------------------
      // STEP 4 — fetch quote, then atomically check-and-reserve
      // -------------------------------------------------------------------

      let fetched: MerchantCartQuote;
      let quoteTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          quoteTimer = setTimeout(
            () => reject(new Error(`Merchant cart quote fetch timed out after ${this.quoteTimeoutMs}ms`)),
            this.quoteTimeoutMs,
          );
        });

        fetched = await Promise.race([
          fetchCartQuote(proposal.itemId),
          timeoutPromise,
        ]);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const isTimeout =
          errorMsg.includes("timed out") ||
          (err as any)?.name === "TimeoutError" ||
          (err as any)?.code === "ETIMEDOUT";

        const code: GuardrailErrorCode = isTimeout
          ? "ERR_QUOTE_FETCH_TIMEOUT"
          : "ERR_QUOTE_FETCH_FAILED";

        trace.record(
          4,
          "FAILED",
          isTimeout
            ? `Quote fetch timed out after ${this.quoteTimeoutMs}ms for item ${proposal.itemId}`
            : `Quote fetch failed for item ${proposal.itemId}: ${errorMsg}`,
        );

        return await this.fail(policy, key, trace, code, 4, {
          reason: isTimeout
            ? `Merchant cart quote service did not respond within ${this.quoteTimeoutMs}ms for item "${proposal.itemId}". Nothing was reserved.`
            : `Merchant cart quote fetch failed for item "${proposal.itemId}": ${errorMsg}. Nothing was reserved.`,
          details: { itemId: proposal.itemId, error: errorMsg, timeoutMs: this.quoteTimeoutMs },
          markFailed: true,
        });
      } finally {
        if (quoteTimer) {
          clearTimeout(quoteTimer);
        }
      }

      const cap = policy.constraints.maxAmountInPaisa;
      const total = fetched.totalQuoteInPaisa;
      const slippage = total - proposal.proposedAmountInPaisa;
      const willEscalate = total > policy.constraints.requiresHumanApprovalAbovePaisa;

      const reserveResult = await this.store.reserveAtomically({
        authorizationId: policy.authorizationId,
        idempotencyKey: key,
        quoteTotal: total,
        maxAmount: cap,
        isEscalation: willEscalate,
        nowMs: now,
        ttlMs: RESERVATION_TTL_MS,
      });

      if (!reserveResult.ok) {
        if (reserveResult.code === "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP") {
          trace.record(
            4,
            "FAILED",
            `Quote ${total} paisa exceeds the per-transaction cap of ${cap} paisa ` +
              `(agent proposed ${proposal.proposedAmountInPaisa}, slippage ${slippage})`,
          );
          return await this.fail(policy, key, trace, "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP", 4, {
            reason:
              `Merchant quoted ${total} paisa against a proposal of ` +
              `${proposal.proposedAmountInPaisa} paisa; the quote exceeds the ` +
              `${cap} paisa per-transaction cap. Nothing was reserved.`,
            details: { quote: fetched, capInPaisa: cap, slippageInPaisa: slippage },
          });
        } else {
          trace.record(
            4,
            "FAILED",
            `Projected exposure ${reserveResult.projectedExposure} paisa (consumed ${reserveResult.consumedAmountInPaisa} ` +
              `+ reserved ${reserveResult.reservedAmountInPaisa} + quote ${total}) exceeds cap ${cap}`,
          );
          return await this.fail(policy, key, trace, "ERR_CUMULATIVE_CAP_EXCEEDED", 4, {
            reason:
              `This quote individually fits the cap, but committed spend ` +
              `(${reserveResult.consumedAmountInPaisa}) plus in-flight reservations ` +
              `(${reserveResult.reservedAmountInPaisa}) plus ${total} would reach ${reserveResult.projectedExposure} ` +
              `paisa against a ${cap} paisa cap. Nothing was reserved.`,
            details: {
              quote: fetched,
              capInPaisa: cap,
              consumedAmountInPaisa: reserveResult.consumedAmountInPaisa,
              reservedAmountInPaisa: reserveResult.reservedAmountInPaisa,
              projectedExposureInPaisa: reserveResult.projectedExposure,
            },
          });
        }
      }

      // Keep in-memory policy state in sync with the atomic reservation
      policy.state.consumedAmountInPaisa = reserveResult.consumedAmountInPaisa;
      policy.state.reservedAmountInPaisa = reserveResult.reservedAmountInPaisa;
      reservation = reserveResult.reservation;
      quote = fetched;

      this.logger.log(policy.authorizationId, "BUDGET_RESERVED", {
        idempotencyKey: key,
        reservationId: reservation.reservationId,
        amountInPaisa: total,
        reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
        consumedAmountInPaisa: policy.state.consumedAmountInPaisa,
        capInPaisa: cap,
        expiresAt: reservation.expiresAt,
      });

      trace.record(
        4,
        "PASSED",
        `Quote ${total} paisa within per-transaction cap and cumulative headroom; ` +
          `reserved atomically as ${reservation.reservationId}`,
      );
    }

    if (!quote || !reservation) {
      trace.record(5, "FAILED", "Missing quote or reservation after step 4");
      return await this.fail(policy, key, trace, "ERR_INTERNAL_INVARIANT", 5, {
        reason: "Engine reached the escalation gate without a quote or reservation",
      });
    }

    // ---------------------------------------------------------------------
    // STEP 5 — human escalation gate (synchronous)
    // ---------------------------------------------------------------------
    const threshold = policy.constraints.requiresHumanApprovalAbovePaisa;
    if (quote.totalQuoteInPaisa > threshold) {
      if (!proposal.humanApprovalToken) {
        // Hold the reservation open. The step-0 sweep releases it after 300s.
        await this.store.setIdempotency(key, policy.authorizationId, "AWAITING_APPROVAL", { quote });
        policy.state.status = "PENDING_HUMAN_APPROVAL";
        await this.store.savePolicyState(policy);

        this.logger.log(policy.authorizationId, "ESCALATED_TO_HUMAN", {
          idempotencyKey: key,
          reservationId: reservation.reservationId,
          quotedAmountInPaisa: quote.totalQuoteInPaisa,
          requiresHumanApprovalAbovePaisa: threshold,
          reservationExpiresAt: reservation.expiresAt,
        });

        trace.record(
          5,
          "ESCALATED",
          `Quote ${quote.totalQuoteInPaisa} paisa exceeds the human-approval threshold of ` +
            `${threshold} paisa; ${reservation.amountInPaisa} paisa held until ${reservation.expiresAt}`,
        );

        return {
          success: false,
          code: "PENDING_HUMAN_APPROVAL",
          reason:
            `Quote of ${quote.totalQuoteInPaisa} paisa requires human approval ` +
            `(threshold ${threshold} paisa). Budget is reserved, not spent. ` +
            `Approve at POST /agentguard/approve, then resubmit this proposal with the token.`,
          idempotencyKey: key,
          steps: trace.finalize(),
          escalation: {
            idempotencyKey: key,
            quotedAmountInPaisa: quote.totalQuoteInPaisa,
            reservationExpiresAt: reservation.expiresAt,
          },
        };
      }

      // Token present — verify it against THIS escalation.
      const verification = verifyApprovalToken({
        encoded: proposal.humanApprovalToken,
        expectedAuthorizationId: policy.authorizationId,
        expectedIdempotencyKey: key,
        expectedAmountInPaisa: quote.totalQuoteInPaisa,
        nowMs: now,
        isConsumed: (signature) => this.store.hasConsumedApprovalToken(signature),
      });

      if (!verification.valid) {
        // Release the held reservation — a bad token must not leave budget stranded.
        await this.releaseReservation(policy, reservation, "APPROVAL_TOKEN_REJECTED");
        this.refreshLifecycleStatus(policy);
        await this.store.savePolicyState(policy);

        trace.record(5, "FAILED", `Approval token rejected: ${verification.reason} — ${verification.detail}`);
        return await this.fail(policy, key, trace, "ERR_INVALID_APPROVAL_TOKEN", 5, {
          reason: `${verification.reason}: ${verification.detail}`,
          details: {
            rejectionReason: verification.reason,
            releasedReservationId: reservation.reservationId,
            reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
          },
        });
      }

      const verifiedToken = verification.token!;
      await this.store.consumeApprovalToken(verifiedToken.signature);
      await this.store.markReservationApprovalConsumed(policy.authorizationId, reservation.reservationId);
      reservation.approvalTokenConsumed = true;

      this.logger.log(policy.authorizationId, "HUMAN_APPROVAL_ACCEPTED", {
        idempotencyKey: key,
        approverId: verifiedToken.approverId,
        approvedAmountInPaisa: verifiedToken.approvedAmountInPaisa,
        tokenIssuedAt: verifiedToken.issuedAt,
        tokenExpiresAt: verifiedToken.expiresAt,
      });

      trace.record(
        5,
        "PASSED",
        `Approval token verified — approved by ${verifiedToken.approverId} for ` +
          `${verifiedToken.approvedAmountInPaisa} paisa; token marked consumed`,
      );
    } else {
      trace.record(
        5,
        "PASSED",
        `Quote ${quote.totalQuoteInPaisa} paisa is at or below the ${threshold} paisa ` +
          `human-approval threshold — no escalation required`,
      );
    }

    // ---------------------------------------------------------------------
    // STEP 6 — sign the payload, then execute against Razorpay
    // ---------------------------------------------------------------------
    const executionPayload = canonicalJson({
      authorizationId: policy.authorizationId,
      idempotencyKey: key,
      reservationId: reservation.reservationId,
      itemId: proposal.itemId,
      merchantId: proposal.merchantId,
      category: proposal.category,
      amountInPaisa: quote.totalQuoteInPaisa,
      currency: policy.constraints.currency,
    });
    // Signed with the server secret. The agent never sees this secret or this
    // signature input, so it cannot mint an execution payload of its own.
    const secretBuffer = this.secretProvider
      ? await this.secretProvider.getHmacSecret()
      : Buffer.from(getServerSecret(), "utf8");
    const executionSignature = hmacHex(executionPayload, secretBuffer.toString("utf8"));

    try {
      const order = await this.gateway.client.orders.create({
        amount: quote.totalQuoteInPaisa,
        currency: policy.constraints.currency,
        receipt: `ag_${key.slice(0, 32)}`,
        notes: {
          agentguard_authorization_id: policy.authorizationId,
          agentguard_idempotency_key: key,
          agentguard_execution_signature: executionSignature,
          agentguard_merchant_id: proposal.merchantId,
          agentguard_item_id: proposal.itemId,
        },
      });

      // Commit: move the amount from reserved to consumed.
      await this.commitReservation(policy, reservation);
      policy.state.executedTransactionIds.push(order.id);
      this.refreshLifecycleStatus(policy);
      await this.store.savePolicyState(policy);

      const result: TransactionResult = {
        success: true,
        orderId: order.id,
        amount: quote.totalQuoteInPaisa,
        idempotencyKey: key,
        replayed: false,
        steps: [],
      };
      await this.store.setIdempotency(key, policy.authorizationId, "COMPLETED", {
        quote,
        result,
      });

      this.logger.log(policy.authorizationId, "RAZORPAY_ORDER_CREATED", {
        orderId: order.id,
        amount: quote.totalQuoteInPaisa,
        currency: policy.constraints.currency,
        idempotencyKey: key,
        gatewayMode: this.gateway.mode,
        executionSignature,
        consumedAmountInPaisa: policy.state.consumedAmountInPaisa,
        reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
        remainingHeadroomInPaisa:
          policy.constraints.maxAmountInPaisa -
          policy.state.consumedAmountInPaisa -
          policy.state.reservedAmountInPaisa,
      });

      trace.record(
        6,
        "PASSED",
        `Razorpay order ${order.id} created for ${quote.totalQuoteInPaisa} paisa ` +
          `(${this.gateway.mode}); reservation committed to consumed`,
      );

      return { ...result, steps: trace.finalize() };
    } catch (error) {
      // Gateway failed — release, never commit.
      await this.releaseReservation(policy, reservation, "GATEWAY_FAILURE");
      this.refreshLifecycleStatus(policy);
      await this.store.savePolicyState(policy);

      const message = error instanceof Error ? error.message : String(error);
      this.logger.log(policy.authorizationId, "RAZORPAY_API_ERROR", {
        idempotencyKey: key,
        error: message,
        amountInPaisa: quote.totalQuoteInPaisa,
        releasedReservationId: reservation.reservationId,
        reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
      });

      trace.record(6, "FAILED", `Razorpay rejected the order: ${message}. Reservation released.`);
      return await this.fail(policy, key, trace, "ERR_RAZORPAY_GATEWAY", 6, {
        reason: `Payment gateway error: ${message}. No amount was committed.`,
        alreadyLogged: true,
      });
    }
  }

  // =========================================================================
  // Reservation lifecycle
  // =========================================================================

  /**
   * STEP 0. Release every reservation past its expiry that never had an approval
   * token consumed against it. An escalation that times out also flips the
   * authorization to EXPIRED_UNAPPROVED so the timeout is visible after the fact.
   */
  private async sweepExpiredReservations(policy: AuthorizationPolicy, nowMs: number): Promise<ReservationRecord[]> {
    const swept: ReservationRecord[] = [];
    // Copy first: `releaseReservation` mutates the underlying array.
    const candidates = [...this.store.listReservations(policy.authorizationId)];

    for (const reservation of candidates) {
      const expiresAtMs = Date.parse(reservation.expiresAt);
      const isExpired = !Number.isNaN(expiresAtMs) && nowMs >= expiresAtMs;
      if (!isExpired || reservation.approvalTokenConsumed) continue;

      await this.releaseReservation(policy, reservation, "RESERVATION_EXPIRED");

      // The locked quote can no longer be settled, so retire the idempotency key.
      const record = this.store.getIdempotency(reservation.idempotencyKey);
      if (record && (record.status === "AWAITING_APPROVAL" || record.status === "PENDING")) {
        await this.store.setIdempotency(
          reservation.idempotencyKey,
          policy.authorizationId,
          "FAILED",
          { quote: record.quote },
        );
      }

      if (reservation.isEscalation) {
        // Informational, recoverable state: it records that a human did not answer
        // in time. Step 3 intentionally does not treat it as terminal (only
        // EXHAUSTED and REVOKED block), so the agent may re-propose and re-escalate.
        policy.state.status = "EXPIRED_UNAPPROVED";
      }
      await this.store.savePolicyState(policy);

      this.logger.log(policy.authorizationId, "RESERVATION_EXPIRED_RELEASED", {
        reservationId: reservation.reservationId,
        idempotencyKey: reservation.idempotencyKey,
        amountInPaisa: reservation.amountInPaisa,
        wasEscalation: reservation.isEscalation,
        reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
        policyStatus: policy.state.status,
      });

      swept.push(reservation);
    }

    return swept;
  }

  /** Reserved → released. Delegates to the shared ledger (single implementation). */
  private async releaseReservation(
    policy: AuthorizationPolicy,
    reservation: ReservationRecord,
    cause: string,
  ): Promise<void> {
    await releaseReservation(policy, reservation, cause, { store: this.store, logger: this.logger });
  }

  /** Reserved → consumed. The only path that increases committed spend. */
  private async commitReservation(policy: AuthorizationPolicy, reservation: ReservationRecord): Promise<void> {
    await commitReservation(policy, reservation, { store: this.store, logger: this.logger });
  }

  private refreshLifecycleStatus(policy: AuthorizationPolicy): void {
    refreshLifecycleStatus(policy, { store: this.store, logger: this.logger });
  }

  // =========================================================================
  // Failure helper
  // =========================================================================

  private async fail(
    policy: AuthorizationPolicy,
    key: string,
    trace: PipelineTrace,
    code: GuardrailErrorCode,
    step: number,
    options: {
      reason: string;
      details?: Record<string, any>;
      markFailed?: boolean;
      alreadyLogged?: boolean;
    },
  ): Promise<TransactionFailure> {
    const { reason, details = {}, markFailed = true, alreadyLogged = false } = options;

    if (markFailed) {
      const existing = this.store.getIdempotency(key);
      await this.store.setIdempotency(key, policy.authorizationId, "FAILED", { quote: existing?.quote });
    }

    if (!alreadyLogged) {
      this.logger.log(policy.authorizationId, "TRANSACTION_BLOCKED", {
        idempotencyKey: key,
        blockedAtStep: step,
        stepName: STEP_NAMES[step],
        code,
        reason,
        consumedAmountInPaisa: policy.state.consumedAmountInPaisa,
        reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
        ...details,
      });
    }

    return { success: false, code, reason, idempotencyKey: key, steps: trace.finalize() };
  }
}
