/**
 * AgentGuard — canonical data contracts.
 *
 * Core axiom: the AI agent is a *planner* that proposes purchase intents. It never
 * holds authority to execute money movement. AgentGuard is the sole authority that
 * validates an `IntentProposal` against an `AuthorizationPolicy` and executes.
 */

// ---------------------------------------------------------------------------
// Authorization policy (the mandate a human grants to an agent)
// ---------------------------------------------------------------------------

export type AuthorizationStatus =
  | "ACTIVE"
  | "PENDING_HUMAN_APPROVAL"
  | "EXPIRED_UNAPPROVED"
  | "EXHAUSTED"
  | "REVOKED";

export interface AuthorizationPolicy {
  authorizationId: string;
  userId: string;
  purpose: string;
  constraints: {
    maxAmountInPaisa: number;
    currency: "INR";
    allowedCategories: string[];
    allowedMerchants: string[];
    expiresAt: string; // ISO 8601
    requiresHumanApprovalAbovePaisa: number;
  };
  state: {
    status: AuthorizationStatus;
    consumedAmountInPaisa: number; // committed spend only
    reservedAmountInPaisa: number; // in-flight, not yet committed
    executedTransactionIds: string[];
  };
  security: { nonce: string; signature: string };
}

// ---------------------------------------------------------------------------
// Agent-supplied proposal (untrusted — the agent may be confused or hijacked)
// ---------------------------------------------------------------------------

export interface IntentProposal {
  authorizationId: string;
  itemId: string;
  merchantId: string;
  category: string;
  proposedAmountInPaisa: number;
  clientNonce: string;
  humanApprovalToken?: string; // present only on resubmission after escalation
}

// ---------------------------------------------------------------------------
// Human-in-the-loop approval
// ---------------------------------------------------------------------------

export interface HumanApprovalToken {
  authorizationId: string;
  idempotencyKey: string; // binds token to the exact escalated proposal
  approvedAmountInPaisa: number; // must equal the quote that triggered escalation
  approverId: string;
  issuedAt: string;
  expiresAt: string; // short-lived, 5 minutes from issuance
  signature: string; // HMAC over all fields above, server secret key
}

// ---------------------------------------------------------------------------
// Merchant cart quote (trusted input for this build — see README "Out of scope")
// ---------------------------------------------------------------------------

export interface MerchantCartQuote {
  itemId: string;
  basePriceInPaisa: number;
  taxInPaisa: number;
  shippingInPaisa: number;
  totalQuoteInPaisa: number;
}

// ---------------------------------------------------------------------------
// Tamper-evident audit log
// ---------------------------------------------------------------------------

export interface AuditLogBlock {
  entryId: string;
  timestamp: string;
  authorizationId: string;
  event: string;
  details: Record<string, any>;
  previousHash: string;
  currentHash: string;
}

// ---------------------------------------------------------------------------
// Engine results
// ---------------------------------------------------------------------------

export type GuardrailErrorCode =
  /** Another in-flight call already holds this idempotency key. */
  | "ERR_CONCURRENT_MUTATION"
  /** > 5 proposals per authorizationId per 10 minute window. */
  | "ERR_AGENT_LOOP_DETECTED"
  /** Policy is EXHAUSTED / REVOKED / EXPIRED_UNAPPROVED. */
  | "ERR_POLICY_NOT_ACTIVE"
  /** `now >= constraints.expiresAt`. */
  | "ERR_AUTHORIZATION_EXPIRED"
  | "ERR_CATEGORY_NOT_ALLOWED"
  | "ERR_MERCHANT_NOT_ALLOWED"
  /** A single quote exceeds the per-transaction cap. */
  | "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP"
  /** consumed + reserved + quote would exceed the cap. */
  | "ERR_CUMULATIVE_CAP_EXCEEDED"
  /** Escalated to a human; reservation is held pending their decision. */
  | "PENDING_HUMAN_APPROVAL"
  /** Forged, stale, replayed, or mis-bound approval token. */
  | "ERR_INVALID_APPROVAL_TOKEN"
  /** Merchant quote service failed to respond within the timeout limit. */
  | "ERR_QUOTE_FETCH_TIMEOUT"
  /** Merchant quote service returned an error or unparseable quote. */
  | "ERR_QUOTE_FETCH_FAILED"
  /** Razorpay rejected or errored; nothing was committed. */
  | "ERR_RAZORPAY_GATEWAY"
  /** Internal invariant broken — fail closed. */
  | "ERR_INTERNAL_INVARIANT";

export type PipelineStepStatus = "PASSED" | "FAILED" | "SKIPPED" | "ESCALATED" | "NOT_REACHED";

export interface PipelineStep {
  step: number;
  name: string;
  status: PipelineStepStatus;
  detail: string;
}

export interface TransactionSuccess {
  success: true;
  orderId: string;
  amount: number;
  idempotencyKey: string;
  /** True when this call replayed a cached COMPLETED result instead of charging again. */
  replayed: boolean;
  steps: PipelineStep[];
}

export interface TransactionFailure {
  success: false;
  code: GuardrailErrorCode;
  reason: string;
  idempotencyKey: string;
  steps: PipelineStep[];
  /** Populated when code === "PENDING_HUMAN_APPROVAL". */
  escalation?: {
    idempotencyKey: string;
    quotedAmountInPaisa: number;
    reservationExpiresAt: string;
  };
}

export type TransactionResult = TransactionSuccess | TransactionFailure;

// ---------------------------------------------------------------------------
// Persistence shapes (single JSON snapshot file — single instance only)
// ---------------------------------------------------------------------------

export type IdempotencyStatus = "PENDING" | "AWAITING_APPROVAL" | "COMPLETED" | "FAILED";

export interface IdempotencyRecord {
  key: string;
  authorizationId: string;
  status: IdempotencyStatus;
  updatedAt: string;
  /** The quote that was locked in for this key. Reused verbatim on resubmission
   *  so that a post-escalation price change cannot slip past the human's approval. */
  quote?: MerchantCartQuote;
  /** Cached terminal result, replayed on retry when status === "COMPLETED". */
  result?: TransactionResult;
}

export interface ReservationRecord {
  reservationId: string;
  authorizationId: string;
  idempotencyKey: string;
  amountInPaisa: number;
  createdAt: string;
  expiresAt: string;
  /** True when the reservation is being held open awaiting a human decision. */
  isEscalation: boolean;
  /** Set once an approval token has been verified + consumed for this reservation. */
  approvalTokenConsumed: boolean;
}

export interface RateLimitWindow {
  windowStartMs: number;
  count: number;
}

export interface PersistedPolicyState {
  authorizationId: string;
  status: AuthorizationStatus;
  consumedAmountInPaisa: number;
  reservedAmountInPaisa: number;
  executedTransactionIds: string[];
}

export interface SnapshotShape {
  version: number;
  updatedAt: string;
  idempotencyStore: Record<string, IdempotencyRecord>;
  rateLimitStore: Record<string, RateLimitWindow>;
  /** Keyed by authorizationId. */
  reservations: Record<string, ReservationRecord[]>;
  /** Signatures of approval tokens already spent — replay protection. */
  consumedApprovalTokenSignatures: string[];
  policies: Record<string, PersistedPolicyState>;
}
