import { encodeApprovalToken, issueApprovalToken, APPROVAL_TOKEN_TTL_MS } from "@/security/approvalToken";
import { refreshLifecycleStatus, releaseReservation } from "@/state/reservationLedger";
import type { HashChainLogger } from "@/logger/hashChainLogger";
import type { StateStore } from "@/state/stateStore";
import type { AuthorizationPolicy, HumanApprovalToken } from "@/types/agentGuard";

/**
 * POST /agentguard/approve — the human-in-the-loop decision endpoint.
 *
 * Served by `app/api/agentguard/approve/route.ts`; the logic lives here so it can be
 * unit-tested without an HTTP server.
 *
 * ## What approval does and does not do
 *
 * Approving does NOT execute a payment. It mints a short-lived, single-use
 * `HumanApprovalToken` bound to one idempotency key and one exact amount. The caller
 * must resubmit the *original* `IntentProposal` with that token attached; the engine
 * re-validates everything and only then executes.
 *
 * The amount in the token is copied from the quote that was locked at escalation
 * time — never re-fetched. That is what stops a merchant from raising the price
 * after a human approves the cheaper figure.
 *
 * ## Timeout
 *
 * If no decision arrives within 300s the reservation is released and the
 * authorization flips to EXPIRED_UNAPPROVED. That is evaluated lazily by the
 * engine's step-0 sweep on the next proposal — there is no background timer, so a
 * restarted process cannot lose a pending timeout.
 */

export type ApprovalDecision = "approve" | "deny";

export interface ApprovalRequestBody {
  authorizationId: string;
  idempotencyKey: string;
  approverId: string;
  decision: ApprovalDecision;
}

export interface ApprovalDeps {
  store: StateStore;
  logger: HashChainLogger;
  resolvePolicy: (authorizationId: string) => AuthorizationPolicy | undefined;
  nowMs?: () => number;
}

export interface ApprovalIssued {
  ok: true;
  decision: "approve";
  /** Attach this to `IntentProposal.humanApprovalToken` and resubmit. */
  encodedToken: string;
  token: HumanApprovalToken;
  approvedAmountInPaisa: number;
  expiresAt: string;
  message: string;
}

export interface ApprovalDenied {
  ok: true;
  decision: "deny";
  releasedAmountInPaisa: number;
  reservedAmountInPaisa: number;
  message: string;
}

export interface ApprovalError {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export type ApprovalResponse = ApprovalIssued | ApprovalDenied | ApprovalError;

export async function handleApprovalRequest(
  body: Partial<ApprovalRequestBody>,
  deps: ApprovalDeps,
): Promise<ApprovalResponse> {
  const now = deps.nowMs?.() ?? Date.now();

  // ---- Request validation -------------------------------------------------
  const { authorizationId, idempotencyKey, approverId, decision } = body;

  if (!authorizationId || typeof authorizationId !== "string") {
    return badRequest("ERR_MISSING_AUTHORIZATION_ID", "authorizationId is required");
  }
  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    return badRequest("ERR_MISSING_IDEMPOTENCY_KEY", "idempotencyKey is required");
  }
  if (!approverId || typeof approverId !== "string") {
    return badRequest("ERR_MISSING_APPROVER_ID", "approverId is required");
  }
  if (decision !== "approve" && decision !== "deny") {
    return badRequest("ERR_INVALID_DECISION", 'decision must be exactly "approve" or "deny"');
  }

  const policy = deps.resolvePolicy(authorizationId);
  if (!policy) {
    return {
      ok: false,
      status: 404,
      code: "ERR_UNKNOWN_AUTHORIZATION",
      message: `No authorization policy registered for ${authorizationId}`,
    };
  }

  // ---- Locate the escalation ---------------------------------------------
  const record = deps.store.findAwaitingApproval(authorizationId, idempotencyKey);
  if (!record) {
    const anyRecord = deps.store.getIdempotency(idempotencyKey);
    return {
      ok: false,
      status: 409,
      code: "ERR_NO_PENDING_ESCALATION",
      message: anyRecord
        ? `Proposal ${idempotencyKey.slice(0, 16)}… is ${anyRecord.status}, not AWAITING_APPROVAL`
        : `No escalation found for idempotency key ${idempotencyKey.slice(0, 16)}…`,
    };
  }

  const reservation = deps.store.findReservationByIdempotencyKey(authorizationId, idempotencyKey);
  if (!reservation) {
    return {
      ok: false,
      status: 409,
      code: "ERR_RESERVATION_MISSING",
      message: "The escalation's budget reservation is no longer held; ask the agent to re-propose",
    };
  }

  const reservationExpiresAtMs = Date.parse(reservation.expiresAt);
  if (!Number.isNaN(reservationExpiresAtMs) && now >= reservationExpiresAtMs) {
    return {
      ok: false,
      status: 410,
      code: "ERR_ESCALATION_EXPIRED",
      message:
        `The 300s approval window closed at ${reservation.expiresAt}. The reservation will be ` +
        `released and the authorization marked EXPIRED_UNAPPROVED on the next proposal.`,
    };
  }

  const lockedQuote = record.quote;
  if (!lockedQuote) {
    return {
      ok: false,
      status: 409,
      code: "ERR_QUOTE_MISSING",
      message: "The escalation has no locked quote to approve against",
    };
  }

  // ---- DENY ---------------------------------------------------------------
  if (decision === "deny") {
    const released = reservation.amountInPaisa;
    await releaseReservation(policy, reservation, "HUMAN_DENIED", deps);
    await deps.store.setIdempotency(idempotencyKey, authorizationId, "FAILED", { quote: lockedQuote });
    refreshLifecycleStatus(policy, deps);
    await deps.store.savePolicyState(policy);

    deps.logger.log(authorizationId, "HUMAN_APPROVAL_DENIED", {
      idempotencyKey,
      approverId,
      deniedAmountInPaisa: released,
      releasedReservationId: reservation.reservationId,
      reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
      policyStatus: policy.state.status,
    });

    return {
      ok: true,
      decision: "deny",
      releasedAmountInPaisa: released,
      reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
      message: `Denied. ${released} paisa released back to available headroom.`,
    };
  }

  // ---- APPROVE ------------------------------------------------------------
  // The approved amount is the quote captured at escalation time, not a fresh
  // quote. A re-quote here would let the merchant raise the price after approval.
  const token = issueApprovalToken({
    authorizationId,
    idempotencyKey,
    approvedAmountInPaisa: lockedQuote.totalQuoteInPaisa,
    approverId,
    nowMs: now,
    ttlMs: APPROVAL_TOKEN_TTL_MS,
  });

  // The record stays AWAITING_APPROVAL so the engine resumes at step 5 on
  // resubmission and reuses the reservation already held.
  deps.logger.log(authorizationId, "HUMAN_APPROVAL_TOKEN_ISSUED", {
    idempotencyKey,
    approverId,
    approvedAmountInPaisa: token.approvedAmountInPaisa,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    reservationId: reservation.reservationId,
    note: "Single-use token, bound to this idempotency key and this exact amount",
  });

  return {
    ok: true,
    decision: "approve",
    encodedToken: encodeApprovalToken(token),
    token,
    approvedAmountInPaisa: token.approvedAmountInPaisa,
    expiresAt: token.expiresAt,
    message:
      `Approved ${token.approvedAmountInPaisa} paisa. Resubmit the original IntentProposal with ` +
      `this token attached before ${token.expiresAt}.`,
  };
}

function badRequest(code: string, message: string): ApprovalError {
  return { ok: false, status: 400, code, message };
}
