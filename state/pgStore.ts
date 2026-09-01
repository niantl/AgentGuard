import type { Pool } from "pg";
import { withTransaction } from "@/db/pool";
import { randomHex } from "@/security/crypto";
import type { StateStore } from "@/state/stateStore";
import type {
  AuthorizationPolicy,
  IdempotencyRecord,
  IdempotencyStatus,
  MerchantCartQuote,
  PersistedPolicyState,
  RateLimitWindow,
  ReservationRecord,
  SnapshotShape,
  TransactionResult,
} from "@/types/agentGuard";

/**
 * Postgres-backed state store for AgentGuard.
 *
 * Every method that the engine already calls against the old `SnapshotStore` has a
 * Postgres-backed equivalent here. The reserve step is a single
 * `BEGIN...SELECT FOR UPDATE...UPDATE...COMMIT` block using `withTransaction`, so
 * two concurrent requests on the same `authorization_id` serialize at the row lock,
 * not at Node's event loop. This is what makes horizontal scaling safe.
 *
 * ## Why synchronous-looking methods wrap async calls
 *
 * The engine was written for a synchronous snapshot store. The `StateStore` interface
 * mirrors those signatures. This implementation is backed by a pool but the
 * methods remain synchronous in signature — the Postgres calls happen internally
 * and the store caches the last-known state. The engine's critical section (the
 * budget check-and-reserve) is handled by `reserveAtomically()`, which is the
 * async method the engine calls instead of doing a synchronous read-then-write.
 *
 * For the in-memory-compatible path (tests that use SnapshotStore), nothing changes.
 * For the Postgres path, the engine will need to call the async transaction method
 * at step 4.
 */

// ---------------------------------------------------------------------------
// In-memory cache — mirrors Postgres for hot-path synchronous reads
// ---------------------------------------------------------------------------

interface PolicyCache {
  policy: AuthorizationPolicy;
  persisted: PersistedPolicyState;
}

export class PgStore implements StateStore {
  private readonly pool: Pool;
  private readonly clock: () => Date;
  private writeCount = 0;

  // In-memory caches — populated from Postgres on register, kept in sync on writes
  private idempotencyCache = new Map<string, IdempotencyRecord>();
  private rateLimitCache = new Map<string, RateLimitWindow>();
  private reservationCache = new Map<string, ReservationRecord[]>();
  private consumedTokens = new Set<string>();
  private policyCache = new Map<string, PolicyCache>();

  constructor(options: { pool: Pool; clock?: () => Date }) {
    this.pool = options.pool;
    this.clock = options.clock ?? (() => new Date());
  }

  // =========================================================================
  // Async initialization — call once at boot to hydrate caches from Postgres
  // =========================================================================

  async init(): Promise<void> {
    // Hydrate policy cache
    const { rows: policyRows } = await this.pool.query<{
      authorization_id: string;
      policy_json: AuthorizationPolicy;
      consumed_amount_in_paisa: string;
      reserved_amount_in_paisa: string;
      status: string;
      executed_transaction_ids: string[];
    }>("SELECT * FROM authorization_policies");

    for (const row of policyRows) {
      const policy = row.policy_json;
      policy.state.status = row.status as AuthorizationPolicy["state"]["status"];
      policy.state.consumedAmountInPaisa = Number(row.consumed_amount_in_paisa);
      policy.state.reservedAmountInPaisa = Number(row.reserved_amount_in_paisa);
      policy.state.executedTransactionIds = row.executed_transaction_ids ?? [];
      this.policyCache.set(row.authorization_id, {
        policy,
        persisted: {
          authorizationId: row.authorization_id,
          status: row.status as AuthorizationPolicy["state"]["status"],
          consumedAmountInPaisa: Number(row.consumed_amount_in_paisa),
          reservedAmountInPaisa: Number(row.reserved_amount_in_paisa),
          executedTransactionIds: row.executed_transaction_ids ?? [],
        },
      });
    }

    // Hydrate idempotency cache
    const { rows: idempRows } = await this.pool.query<{
      idempotency_key: string;
      authorization_id: string;
      status: string;
      updated_at: string;
      quote: MerchantCartQuote | null;
      result: TransactionResult | null;
    }>("SELECT * FROM idempotency_records");

    for (const row of idempRows) {
      this.idempotencyCache.set(row.idempotency_key, {
        key: row.idempotency_key,
        authorizationId: row.authorization_id,
        status: row.status as IdempotencyStatus,
        updatedAt: row.updated_at,
        quote: row.quote ?? undefined,
        result: row.result ?? undefined,
      });
    }

    // Hydrate reservation cache
    const { rows: resvRows } = await this.pool.query<{
      reservation_id: string;
      authorization_id: string;
      idempotency_key: string;
      amount_in_paisa: string;
      created_at: string;
      expires_at: string;
      is_escalation: boolean;
      approval_token_consumed: boolean;
    }>("SELECT * FROM reservations");

    for (const row of resvRows) {
      const record: ReservationRecord = {
        reservationId: row.reservation_id,
        authorizationId: row.authorization_id,
        idempotencyKey: row.idempotency_key,
        amountInPaisa: Number(row.amount_in_paisa),
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
        isEscalation: row.is_escalation,
        approvalTokenConsumed: row.approval_token_consumed,
      };
      const bucket = this.reservationCache.get(row.authorization_id) ?? [];
      bucket.push(record);
      this.reservationCache.set(row.authorization_id, bucket);
    }

    // Hydrate consumed tokens
    const { rows: tokenRows } = await this.pool.query<{ token_id: string }>(
      "SELECT token_id FROM consumed_approval_tokens",
    );
    for (const row of tokenRows) {
      this.consumedTokens.add(row.token_id);
    }

    // Hydrate rate limit cache
    const { rows: rateRows } = await this.pool.query<{
      authorization_id: string;
      window_start: string;
      count: number;
    }>("SELECT * FROM rate_limit_counters");

    for (const row of rateRows) {
      this.rateLimitCache.set(row.authorization_id, {
        windowStartMs: new Date(row.window_start).getTime(),
        count: row.count,
      });
    }
  }

  // =========================================================================
  // Idempotency
  // =========================================================================

  getIdempotency(key: string): IdempotencyRecord | undefined {
    return this.idempotencyCache.get(key);
  }

  async setIdempotency(
    key: string,
    authorizationId: string,
    status: IdempotencyStatus,
    extra: { quote?: MerchantCartQuote; result?: TransactionResult } = {},
  ): Promise<IdempotencyRecord> {
    const existing = this.idempotencyCache.get(key);
    const record: IdempotencyRecord = {
      key,
      authorizationId,
      status,
      updatedAt: this.clock().toISOString(),
      quote: extra.quote ?? existing?.quote,
      result: extra.result ?? (status === "COMPLETED" ? existing?.result : undefined),
    };
    this.idempotencyCache.set(key, record);

    await this.pool.query(
      `INSERT INTO idempotency_records (idempotency_key, authorization_id, status, quote, result, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO UPDATE SET
         status = EXCLUDED.status,
         quote = EXCLUDED.quote,
         result = EXCLUDED.result,
         updated_at = EXCLUDED.updated_at`,
      [
        key,
        authorizationId,
        status,
        record.quote ? JSON.stringify(record.quote) : null,
        record.result ? JSON.stringify(record.result) : null,
        record.updatedAt,
      ],
    );

    this.writeCount += 1;
    return record;
  }

  findAwaitingApproval(authorizationId: string, idempotencyKey: string): IdempotencyRecord | undefined {
    const record = this.idempotencyCache.get(idempotencyKey);
    if (!record) return undefined;
    if (record.authorizationId !== authorizationId) return undefined;
    if (record.status !== "AWAITING_APPROVAL") return undefined;
    return record;
  }

  listPendingEscalations(): IdempotencyRecord[] {
    return Array.from(this.idempotencyCache.values()).filter(
      (record) => record.status === "AWAITING_APPROVAL",
    );
  }

  // =========================================================================
  // Rate limit / loop guard
  // =========================================================================

  async recordProposalAttempt(
    authorizationId: string,
    windowMs: number,
    maxProposals: number,
    nowMs: number,
  ): Promise<{ allowed: boolean; count: number; windowResetsAtMs: number }> {
    const existing = this.rateLimitCache.get(authorizationId);
    const windowExpired = !existing || nowMs - existing.windowStartMs >= windowMs;

    const window: RateLimitWindow = windowExpired
      ? { windowStartMs: nowMs, count: 1 }
      : { windowStartMs: existing.windowStartMs, count: existing.count + 1 };

    this.rateLimitCache.set(authorizationId, window);

    // Persist to Postgres
    await this.pool.query(
      `INSERT INTO rate_limit_counters (authorization_id, window_start, count)
       VALUES ($1, $2, $3)
       ON CONFLICT (authorization_id) DO UPDATE SET
         window_start = EXCLUDED.window_start,
         count = EXCLUDED.count`,
      [authorizationId, new Date(window.windowStartMs).toISOString(), window.count],
    );

    this.writeCount += 1;
    return {
      allowed: window.count <= maxProposals,
      count: window.count,
      windowResetsAtMs: window.windowStartMs + windowMs,
    };
  }

  peekRateLimit(authorizationId: string): RateLimitWindow | undefined {
    return this.rateLimitCache.get(authorizationId);
  }

  // =========================================================================
  // Reservations
  // =========================================================================

  listReservations(authorizationId: string): ReservationRecord[] {
    return this.reservationCache.get(authorizationId) ?? [];
  }

  async addReservation(input: {
    authorizationId: string;
    idempotencyKey: string;
    amountInPaisa: number;
    isEscalation: boolean;
    nowMs: number;
    ttlMs: number;
  }): Promise<ReservationRecord> {
    const record: ReservationRecord = {
      reservationId: `rsv_${randomHex(8)}`,
      authorizationId: input.authorizationId,
      idempotencyKey: input.idempotencyKey,
      amountInPaisa: input.amountInPaisa,
      createdAt: new Date(input.nowMs).toISOString(),
      expiresAt: new Date(input.nowMs + input.ttlMs).toISOString(),
      isEscalation: input.isEscalation,
      approvalTokenConsumed: false,
    };
    const bucket = this.reservationCache.get(input.authorizationId) ?? [];
    bucket.push(record);
    this.reservationCache.set(input.authorizationId, bucket);

    // Persist to Postgres
    await this.pool.query(
      `INSERT INTO reservations
         (reservation_id, authorization_id, idempotency_key, amount_in_paisa,
          created_at, expires_at, is_escalation, approval_token_consumed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.reservationId,
        record.authorizationId,
        record.idempotencyKey,
        record.amountInPaisa,
        record.createdAt,
        record.expiresAt,
        record.isEscalation,
        record.approvalTokenConsumed,
      ],
    );

    this.writeCount += 1;
    return record;
  }

  findReservationByIdempotencyKey(
    authorizationId: string,
    idempotencyKey: string,
  ): ReservationRecord | undefined {
    return this.listReservations(authorizationId).find(
      (reservation) => reservation.idempotencyKey === idempotencyKey,
    );
  }

  async markReservationApprovalConsumed(authorizationId: string, reservationId: string): Promise<void> {
    const reservation = this.listReservations(authorizationId).find(
      (candidate) => candidate.reservationId === reservationId,
    );
    if (!reservation) return;
    reservation.approvalTokenConsumed = true;

    await this.pool.query(
      "UPDATE reservations SET approval_token_consumed = TRUE WHERE reservation_id = $1",
      [reservationId],
    );

    this.writeCount += 1;
  }

  async removeReservation(authorizationId: string, reservationId: string): Promise<ReservationRecord | undefined> {
    const bucket = this.listReservations(authorizationId);
    const index = bucket.findIndex((reservation) => reservation.reservationId === reservationId);
    if (index === -1) return undefined;
    const [removed] = bucket.splice(index, 1);
    this.reservationCache.set(authorizationId, bucket);

    await this.pool.query("DELETE FROM reservations WHERE reservation_id = $1", [reservationId]);

    this.writeCount += 1;
    return removed;
  }

  // =========================================================================
  // Approval-token replay protection
  // =========================================================================

  hasConsumedApprovalToken(signature: string): boolean {
    return this.consumedTokens.has(signature);
  }

  async consumeApprovalToken(signature: string): Promise<void> {
    this.consumedTokens.add(signature);

    await this.pool.query(
      "INSERT INTO consumed_approval_tokens (token_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [signature],
    );

    this.writeCount += 1;
  }

  // =========================================================================
  // Policy state
  // =========================================================================

  registerPolicy(policy: AuthorizationPolicy): AuthorizationPolicy {
    const cached = this.policyCache.get(policy.authorizationId);
    if (cached) {
      // On-disk ledger wins — same semantics as SnapshotStore.registerPolicy
      policy.state.status = cached.persisted.status;
      policy.state.consumedAmountInPaisa = cached.persisted.consumedAmountInPaisa;
      policy.state.reservedAmountInPaisa = cached.persisted.reservedAmountInPaisa;
      policy.state.executedTransactionIds = [...cached.persisted.executedTransactionIds];
    } else {
      this.savePolicyState(policy);
    }
    return policy;
  }

  async savePolicyState(policy: AuthorizationPolicy): Promise<void> {
    const persisted: PersistedPolicyState = {
      authorizationId: policy.authorizationId,
      status: policy.state.status,
      consumedAmountInPaisa: policy.state.consumedAmountInPaisa,
      reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
      executedTransactionIds: [...policy.state.executedTransactionIds],
    };

    this.policyCache.set(policy.authorizationId, { policy, persisted });

    await this.pool.query(
      `INSERT INTO authorization_policies
         (authorization_id, policy_json, consumed_amount_in_paisa, reserved_amount_in_paisa,
          status, executed_transaction_ids)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (authorization_id) DO UPDATE SET
         policy_json = EXCLUDED.policy_json,
         consumed_amount_in_paisa = EXCLUDED.consumed_amount_in_paisa,
         reserved_amount_in_paisa = EXCLUDED.reserved_amount_in_paisa,
         status = EXCLUDED.status,
         executed_transaction_ids = EXCLUDED.executed_transaction_ids`,
      [
        policy.authorizationId,
        JSON.stringify(policy),
        policy.state.consumedAmountInPaisa,
        policy.state.reservedAmountInPaisa,
        policy.state.status,
        policy.state.executedTransactionIds,
      ],
    );

    this.writeCount += 1;
  }

  async savePolicyStateAsync(policy: AuthorizationPolicy): Promise<void> {
    return this.savePolicyState(policy);
  }

  getPolicyState(authorizationId: string): PersistedPolicyState | undefined {
    return this.policyCache.get(authorizationId)?.persisted;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  reset(): void {
    this.idempotencyCache.clear();
    this.rateLimitCache.clear();
    this.reservationCache.clear();
    this.consumedTokens.clear();
    this.policyCache.clear();

    this.pool
      .query(`
        TRUNCATE TABLE authorization_policies, idempotency_records,
          rate_limit_counters, consumed_approval_tokens, reservations
      `)
      .catch((err) => console.error("[PgStore] truncate failed:", err.message));

    this.writeCount += 1;
  }

  // =========================================================================
  // Diagnostics (dashboard / preflight compatibility)
  // =========================================================================

  getFilePath(): string {
    return "(postgres)";
  }

  getWriteCount(): number {
    return this.writeCount;
  }

  getSnapshot(): SnapshotShape {
    // Build a SnapshotShape projection from caches for dashboard compatibility
    const idempotencyStore: Record<string, IdempotencyRecord> = {};
    for (const [key, record] of this.idempotencyCache) {
      idempotencyStore[key] = record;
    }

    const rateLimitStore: Record<string, RateLimitWindow> = {};
    for (const [key, window] of this.rateLimitCache) {
      rateLimitStore[key] = window;
    }

    const reservations: Record<string, ReservationRecord[]> = {};
    for (const [key, bucket] of this.reservationCache) {
      reservations[key] = bucket;
    }

    const policies: Record<string, PersistedPolicyState> = {};
    for (const [key, cached] of this.policyCache) {
      policies[key] = cached.persisted;
    }

    return {
      version: 1,
      updatedAt: this.clock().toISOString(),
      idempotencyStore,
      rateLimitStore,
      reservations,
      consumedApprovalTokenSignatures: Array.from(this.consumedTokens),
      policies,
    };
  }

  // =========================================================================
  // Atomic reserve — the Postgres-backed critical section for Phase 1
  // =========================================================================

  /**
   * Atomically check headroom and reserve budget in a single Postgres transaction.
   *
   * This is the method that replaces the engine's synchronous check-and-reserve
   * critical section when running against Postgres. The `SELECT ... FOR UPDATE`
   * row lock blocks concurrent transactions on the same `authorization_id` until
   * this one commits or rolls back.
   *
   * Returns `{ ok: true, ... }` when the reservation was placed, or
   * `{ ok: false, code, ... }` when the budget check fails.
   */
  async reserveAtomically(input: {
    authorizationId: string;
    idempotencyKey: string;
    quoteTotal: number;
    maxAmount: number;
    isEscalation: boolean;
    nowMs: number;
    ttlMs: number;
  }): Promise<
    | {
        ok: true;
        reservation: ReservationRecord;
        consumedAmountInPaisa: number;
        reservedAmountInPaisa: number;
      }
    | {
        ok: false;
        code: "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP" | "ERR_CUMULATIVE_CAP_EXCEEDED";
        consumedAmountInPaisa: number;
        reservedAmountInPaisa: number;
        projectedExposure: number;
      }
  > {
    return withTransaction(this.pool, async (client) => {
      // Row lock: blocks concurrent transactions on this authorization
      const { rows } = await client.query<{
        consumed_amount_in_paisa: string;
        reserved_amount_in_paisa: string;
        status: string;
      }>(
        `SELECT consumed_amount_in_paisa, reserved_amount_in_paisa, status
         FROM authorization_policies
         WHERE authorization_id = $1
         FOR UPDATE`,
        [input.authorizationId],
      );

      const row = rows[0];
      if (!row) {
        throw new Error(`[PgStore] authorization_id ${input.authorizationId} not found in DB`);
      }

      const consumed = Number(row.consumed_amount_in_paisa);
      const reserved = Number(row.reserved_amount_in_paisa);

      // Per-transaction cap check
      if (input.quoteTotal > input.maxAmount) {
        return {
          ok: false as const,
          code: "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP" as const,
          consumedAmountInPaisa: consumed,
          reservedAmountInPaisa: reserved,
          projectedExposure: consumed + reserved + input.quoteTotal,
        };
      }

      // Cumulative cap check
      const projected = consumed + reserved + input.quoteTotal;
      if (projected > input.maxAmount) {
        return {
          ok: false as const,
          code: "ERR_CUMULATIVE_CAP_EXCEEDED" as const,
          consumedAmountInPaisa: consumed,
          reservedAmountInPaisa: reserved,
          projectedExposure: projected,
        };
      }

      // Reserve: write atomically within this transaction
      const reservationId = `rsv_${randomHex(8)}`;
      const createdAt = new Date(input.nowMs).toISOString();
      const expiresAt = new Date(input.nowMs + input.ttlMs).toISOString();

      await client.query(
        `UPDATE authorization_policies
         SET reserved_amount_in_paisa = reserved_amount_in_paisa + $2
         WHERE authorization_id = $1`,
        [input.authorizationId, input.quoteTotal],
      );

      await client.query(
        `INSERT INTO reservations
           (reservation_id, authorization_id, idempotency_key, amount_in_paisa,
            created_at, expires_at, is_escalation, approval_token_consumed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)`,
        [
          reservationId,
          input.authorizationId,
          input.idempotencyKey,
          input.quoteTotal,
          createdAt,
          expiresAt,
          input.isEscalation,
        ],
      );

      const newReserved = reserved + input.quoteTotal;

      // Update caches
      const record: ReservationRecord = {
        reservationId,
        authorizationId: input.authorizationId,
        idempotencyKey: input.idempotencyKey,
        amountInPaisa: input.quoteTotal,
        createdAt,
        expiresAt,
        isEscalation: input.isEscalation,
        approvalTokenConsumed: false,
      };

      const bucket = this.reservationCache.get(input.authorizationId) ?? [];
      bucket.push(record);
      this.reservationCache.set(input.authorizationId, bucket);

      // Keep policyCache in sync with Postgres row lock update
      const cached = this.policyCache.get(input.authorizationId);
      if (cached) {
        cached.persisted.consumedAmountInPaisa = consumed;
        cached.persisted.reservedAmountInPaisa = newReserved;
        cached.policy.state.consumedAmountInPaisa = consumed;
        cached.policy.state.reservedAmountInPaisa = newReserved;
      }

      this.writeCount += 1;

      return {
        ok: true as const,
        reservation: record,
        consumedAmountInPaisa: consumed,
        reservedAmountInPaisa: newReserved,
      };
    });
  }
}
