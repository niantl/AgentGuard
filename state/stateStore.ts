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

export interface ReserveAtomicallyInput {
  authorizationId: string;
  idempotencyKey: string;
  quoteTotal: number;
  maxAmount: number;
  isEscalation: boolean;
  nowMs: number;
  ttlMs: number;
}

export type ReserveAtomicallyResult =
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
    };

/**
 * The contract every state backend must satisfy.
 *
 * Both the in-memory snapshot store and the Postgres store implement this. The
 * engine, reservation ledger, and approval endpoint program against this
 * interface — never against a concrete class — so swapping backends is a
 * constructor-time decision with no control-flow changes in the engine.
 */
export interface StateStore {
  // ---- Idempotency --------------------------------------------------------
  getIdempotency(key: string): IdempotencyRecord | undefined;
  setIdempotency(
    key: string,
    authorizationId: string,
    status: IdempotencyStatus,
    extra?: { quote?: MerchantCartQuote; result?: TransactionResult },
  ): Promise<IdempotencyRecord> | IdempotencyRecord;
  findAwaitingApproval(authorizationId: string, idempotencyKey: string): IdempotencyRecord | undefined;
  listPendingEscalations(): IdempotencyRecord[];

  // ---- Rate limit / loop guard -------------------------------------------
  recordProposalAttempt(
    authorizationId: string,
    windowMs: number,
    maxProposals: number,
    nowMs: number,
  ): Promise<{ allowed: boolean; count: number; windowResetsAtMs: number }> | { allowed: boolean; count: number; windowResetsAtMs: number };
  peekRateLimit(authorizationId: string): RateLimitWindow | undefined;

  // ---- Reservations -------------------------------------------------------
  listReservations(authorizationId: string): ReservationRecord[];
  addReservation(input: {
    authorizationId: string;
    idempotencyKey: string;
    amountInPaisa: number;
    isEscalation: boolean;
    nowMs: number;
    ttlMs: number;
  }): Promise<ReservationRecord> | ReservationRecord;
  findReservationByIdempotencyKey(
    authorizationId: string,
    idempotencyKey: string,
  ): ReservationRecord | undefined;
  markReservationApprovalConsumed(authorizationId: string, reservationId: string): Promise<void> | void;
  removeReservation(authorizationId: string, reservationId: string): Promise<ReservationRecord | undefined> | ReservationRecord | undefined;

  // ---- Atomic reserve (critical section) -----------------------------------
  reserveAtomically(input: ReserveAtomicallyInput): Promise<ReserveAtomicallyResult>;

  // ---- Approval-token replay protection -----------------------------------
  hasConsumedApprovalToken(signature: string): boolean;
  consumeApprovalToken(signature: string): Promise<void> | void;

  // ---- Policy state -------------------------------------------------------
  registerPolicy(policy: AuthorizationPolicy): AuthorizationPolicy;
  savePolicyState(policy: AuthorizationPolicy): Promise<void> | void;
  getPolicyState(authorizationId: string): PersistedPolicyState | undefined;

  // ---- Lifecycle ----------------------------------------------------------
  reset(): void;

  // ---- Diagnostics (used by dashboard / preflight) ------------------------
  getFilePath(): string;
  getWriteCount(): number;
  getSnapshot(): SnapshotShape;
}
