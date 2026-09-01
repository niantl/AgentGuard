import fs from "node:fs";
import path from "node:path";
import { randomHex } from "@/security/crypto";
import type {
  ReserveAtomicallyInput,
  ReserveAtomicallyResult,
  StateStore,
} from "@/state/stateStore";
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
 * Crash-durable state for AgentGuard, held in a single JSON snapshot file.
 *
 * ## SINGLE INSTANCE ONLY — by design
 *
 * This store assumes exactly one Node process owns the snapshot file. There is no
 * distributed lock, no Redis, no multi-process coordination, and none should be
 * added here: the whole safety argument for the ledger rests on Node's
 * single-threaded event loop, where a block of code containing no `await` cannot
 * be interleaved. Introducing a second writer would silently invalidate that
 * argument. Horizontal scaling is explicitly out of scope for this build.
 *
 * Every mutation persists via `fs.writeFileSync` — synchronous on purpose. The
 * engine's check-and-reserve critical section must be able to durably record a
 * reservation without yielding to the event loop, which `fs.promises.writeFile`
 * would force it to do.
 */

export const DEFAULT_STATE_FILE = "agentguard-state.json";

const SNAPSHOT_VERSION = 1;

function emptySnapshot(): SnapshotShape {
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: new Date(0).toISOString(),
    idempotencyStore: {},
    rateLimitStore: {},
    reservations: {},
    consumedApprovalTokenSignatures: [],
    policies: {},
  };
}

export class SnapshotStore implements StateStore {
  private snapshot: SnapshotShape;
  private consumedTokens: Set<string>;
  private readonly filePath: string;
  private readonly clock: () => Date;
  /** Incremented on every successful write — used by tests/preflight to prove durability. */
  private writeCount = 0;

  constructor(options: { filePath?: string; clock?: () => Date } = {}) {
    this.filePath =
      options.filePath ??
      process.env.AGENTGUARD_STATE_FILE ??
      path.join(process.cwd(), DEFAULT_STATE_FILE);
    this.clock = options.clock ?? (() => new Date());
    this.snapshot = emptySnapshot();
    this.consumedTokens = new Set();
    this.load();
  }

  // -------------------------------------------------------------------------
  // Load / persist
  // -------------------------------------------------------------------------

  /** Called on construction. A missing file is normal: start from empty state. */
  load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.snapshot = emptySnapshot();
        this.consumedTokens = new Set();
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<SnapshotShape>;
      const base = emptySnapshot();
      this.snapshot = {
        version: parsed.version ?? SNAPSHOT_VERSION,
        updatedAt: parsed.updatedAt ?? base.updatedAt,
        idempotencyStore: parsed.idempotencyStore ?? {},
        rateLimitStore: parsed.rateLimitStore ?? {},
        reservations: parsed.reservations ?? {},
        consumedApprovalTokenSignatures: parsed.consumedApprovalTokenSignatures ?? [],
        policies: parsed.policies ?? {},
      };
      this.consumedTokens = new Set(this.snapshot.consumedApprovalTokenSignatures);
    } catch {
      // A corrupt snapshot must not silently resurrect as "no spend recorded".
      // Fail closed by keeping the file and refusing to start from a blank ledger.
      throw new Error(
        `AgentGuard snapshot at ${this.filePath} is unreadable or corrupt. ` +
          `Refusing to start from an empty ledger — inspect or remove the file manually.`,
      );
    }
  }

  /** Synchronous write. Called after EVERY state mutation. */
  persist(): void {
    this.snapshot.updatedAt = this.clock().toISOString();
    this.snapshot.consumedApprovalTokenSignatures = Array.from(this.consumedTokens);
    const dir = path.dirname(this.filePath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot, null, 2), "utf8");
    this.writeCount += 1;
  }

  getFilePath(): string {
    return this.filePath;
  }

  getWriteCount(): number {
    return this.writeCount;
  }

  getSnapshot(): SnapshotShape {
    return this.snapshot;
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  getIdempotency(key: string): IdempotencyRecord | undefined {
    return this.snapshot.idempotencyStore[key];
  }

  setIdempotency(
    key: string,
    authorizationId: string,
    status: IdempotencyStatus,
    extra: { quote?: MerchantCartQuote; result?: TransactionResult } = {},
  ): IdempotencyRecord {
    const existing = this.snapshot.idempotencyStore[key];
    const record: IdempotencyRecord = {
      key,
      authorizationId,
      status,
      updatedAt: this.clock().toISOString(),
      quote: extra.quote ?? existing?.quote,
      result: extra.result ?? (status === "COMPLETED" ? existing?.result : undefined),
    };
    this.snapshot.idempotencyStore[key] = record;
    this.persist();
    return record;
  }

  listIdempotency(): IdempotencyRecord[] {
    return Object.values(this.snapshot.idempotencyStore);
  }

  findAwaitingApproval(authorizationId: string, idempotencyKey: string): IdempotencyRecord | undefined {
    const record = this.snapshot.idempotencyStore[idempotencyKey];
    if (!record) return undefined;
    if (record.authorizationId !== authorizationId) return undefined;
    if (record.status !== "AWAITING_APPROVAL") return undefined;
    return record;
  }

  listPendingEscalations(): IdempotencyRecord[] {
    return this.listIdempotency().filter((record) => record.status === "AWAITING_APPROVAL");
  }

  // -------------------------------------------------------------------------
  // Rate limit / loop guard
  // -------------------------------------------------------------------------

  /**
   * Read-then-write the sliding-window counter with no `await` in between. Safe
   * against interleaving in Node's single-threaded event loop precisely because
   * this method is fully synchronous — do not make it async.
   */
  recordProposalAttempt(
    authorizationId: string,
    windowMs: number,
    maxProposals: number,
    nowMs: number,
  ): { allowed: boolean; count: number; windowResetsAtMs: number } {
    const existing = this.snapshot.rateLimitStore[authorizationId];
    const windowExpired = !existing || nowMs - existing.windowStartMs >= windowMs;

    const window: RateLimitWindow = windowExpired
      ? { windowStartMs: nowMs, count: 1 }
      : { windowStartMs: existing.windowStartMs, count: existing.count + 1 };

    this.snapshot.rateLimitStore[authorizationId] = window;
    this.persist();

    return {
      allowed: window.count <= maxProposals,
      count: window.count,
      windowResetsAtMs: window.windowStartMs + windowMs,
    };
  }

  peekRateLimit(authorizationId: string): RateLimitWindow | undefined {
    return this.snapshot.rateLimitStore[authorizationId];
  }

  // -------------------------------------------------------------------------
  // Reservations
  // -------------------------------------------------------------------------

  listReservations(authorizationId: string): ReservationRecord[] {
    return this.snapshot.reservations[authorizationId] ?? [];
  }

  addReservation(input: {
    authorizationId: string;
    idempotencyKey: string;
    amountInPaisa: number;
    isEscalation: boolean;
    nowMs: number;
    ttlMs: number;
  }): ReservationRecord {
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
    const bucket = this.snapshot.reservations[input.authorizationId] ?? [];
    bucket.push(record);
    this.snapshot.reservations[input.authorizationId] = bucket;
    this.persist();
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

  markReservationApprovalConsumed(authorizationId: string, reservationId: string): void {
    const reservation = this.listReservations(authorizationId).find(
      (candidate) => candidate.reservationId === reservationId,
    );
    if (!reservation) return;
    reservation.approvalTokenConsumed = true;
    this.persist();
  }

  removeReservation(authorizationId: string, reservationId: string): ReservationRecord | undefined {
    const bucket = this.listReservations(authorizationId);
    const index = bucket.findIndex((reservation) => reservation.reservationId === reservationId);
    if (index === -1) return undefined;
    const [removed] = bucket.splice(index, 1);
    this.snapshot.reservations[authorizationId] = bucket;
    this.persist();
    return removed;
  }

  // -------------------------------------------------------------------------
  // Atomic reserve (critical section)
  // -------------------------------------------------------------------------

  /**
   * Synchronous check-and-reserve in memory, persisting atomically via fs.writeFileSync.
   * Preserves unbroken single-threaded event loop atomicity without yielding between check and reserve.
   */
  async reserveAtomically(input: ReserveAtomicallyInput): Promise<ReserveAtomicallyResult> {
    const policy = this.snapshot.policies[input.authorizationId];
    if (!policy) {
      throw new Error(`[SnapshotStore] authorizationId ${input.authorizationId} not found in store`);
    }

    const consumed = policy.consumedAmountInPaisa;
    const reserved = policy.reservedAmountInPaisa;

    // Per-transaction cap check
    if (input.quoteTotal > input.maxAmount) {
      return {
        ok: false,
        code: "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP",
        consumedAmountInPaisa: consumed,
        reservedAmountInPaisa: reserved,
        projectedExposure: consumed + reserved + input.quoteTotal,
      };
    }

    // Cumulative cap check
    const projected = consumed + reserved + input.quoteTotal;
    if (projected > input.maxAmount) {
      return {
        ok: false,
        code: "ERR_CUMULATIVE_CAP_EXCEEDED",
        consumedAmountInPaisa: consumed,
        reservedAmountInPaisa: reserved,
        projectedExposure: projected,
      };
    }

    // Synchronously update policy reservation and create reservation record
    policy.reservedAmountInPaisa += input.quoteTotal;

    const reservation = this.addReservation({
      authorizationId: input.authorizationId,
      idempotencyKey: input.idempotencyKey,
      amountInPaisa: input.quoteTotal,
      isEscalation: input.isEscalation,
      nowMs: input.nowMs,
      ttlMs: input.ttlMs,
    });

    this.persist();

    return {
      ok: true,
      reservation,
      consumedAmountInPaisa: consumed,
      reservedAmountInPaisa: policy.reservedAmountInPaisa,
    };
  }

  // -------------------------------------------------------------------------
  // Approval-token replay protection
  // -------------------------------------------------------------------------

  hasConsumedApprovalToken(signature: string): boolean {
    return this.consumedTokens.has(signature);
  }

  consumeApprovalToken(signature: string): void {
    this.consumedTokens.add(signature);
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Policy state
  // -------------------------------------------------------------------------

  /**
   * Attach a policy to durable state.
   *
   * If the snapshot already knows this authorizationId, the on-disk ledger wins and
   * is copied back onto the in-memory policy object. That is what makes a mid-flight
   * reservation survive a process restart: an in-code policy definition can never
   * quietly reset `consumedAmountInPaisa` to zero.
   */
  registerPolicy(policy: AuthorizationPolicy): AuthorizationPolicy {
    const persisted = this.snapshot.policies[policy.authorizationId];
    if (persisted) {
      policy.state.status = persisted.status;
      policy.state.consumedAmountInPaisa = persisted.consumedAmountInPaisa;
      policy.state.reservedAmountInPaisa = persisted.reservedAmountInPaisa;
      policy.state.executedTransactionIds = [...persisted.executedTransactionIds];
    } else {
      this.savePolicyState(policy);
    }
    return policy;
  }

  savePolicyState(policy: AuthorizationPolicy): void {
    const persisted: PersistedPolicyState = {
      authorizationId: policy.authorizationId,
      status: policy.state.status,
      consumedAmountInPaisa: policy.state.consumedAmountInPaisa,
      reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
      executedTransactionIds: [...policy.state.executedTransactionIds],
    };
    this.snapshot.policies[policy.authorizationId] = persisted;
    this.persist();
  }

  getPolicyState(authorizationId: string): PersistedPolicyState | undefined {
    return this.snapshot.policies[authorizationId];
  }

  // -------------------------------------------------------------------------
  // Test / demo helpers
  // -------------------------------------------------------------------------

  /** Wipes all state, including the file on disk. Used by the dashboard reset button. */
  reset(): void {
    this.snapshot = emptySnapshot();
    this.consumedTokens = new Set();
    this.persist();
  }
}
