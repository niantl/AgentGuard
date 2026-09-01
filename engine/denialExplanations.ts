import type { GuardrailErrorCode } from "@/types/agentGuard";

/**
 * Deterministic human-readable denial explanations.
 *
 * One template per existing error code. Built ONLY from values the check already
 * computed — never a separately-generated narrative. It must be mechanically
 * impossible for this string to say something different from what the code
 * actually enforced.
 *
 * Attached as `details.humanReadableReason` on the relevant audit log entry.
 *
 * ## No LLM in the explanation path
 *
 * These are deterministic string templates filled from numeric variables. If you
 * find yourself calling a model to generate a reason string, stop — that
 * reintroduces non-determinism into the exact place it was removed from in v1/v2.
 */

export interface DenialContext {
  code: GuardrailErrorCode;
  /** The actual consumed amount at the time of the check. */
  consumedAmountInPaisa?: number;
  /** The actual reserved amount at the time of the check. */
  reservedAmountInPaisa?: number;
  /** The quote total for this proposal. */
  quoteAmountInPaisa?: number;
  /** The per-transaction / cumulative cap from the policy. */
  capInPaisa?: number;
  /** The projected exposure: consumed + reserved + quote. */
  projectedExposureInPaisa?: number;
  /** The price the agent proposed. */
  proposedAmountInPaisa?: number;
  /** The slippage between quote and proposal. */
  slippageInPaisa?: number;
  /** Category from the proposal. */
  category?: string;
  /** Merchant from the proposal. */
  merchantId?: string;
  /** Allowed categories from the policy. */
  allowedCategories?: string[];
  /** Allowed merchants from the policy. */
  allowedMerchants?: string[];
  /** The human-approval threshold. */
  requiresHumanApprovalAbovePaisa?: number;
  /** Rate limit count. */
  proposalCount?: number;
  /** Rate limit maximum. */
  maxProposals?: number;
  /** Rate limit window in minutes. */
  windowMinutes?: number;
  /** Expiration timestamp. */
  expiresAt?: string;
  /** Policy status. */
  status?: string;
  /** Reason from approval token verification. */
  tokenRejectionReason?: string;
  /** Detail from approval token verification. */
  tokenRejectionDetail?: string;
}

function formatPaisa(paisa: number | undefined): string {
  if (paisa === undefined) return "?";
  const rupees = (paisa / 100).toFixed(2);
  return `₹${rupees} (${paisa} paisa)`;
}

/**
 * Generate a deterministic human-readable explanation for a denial.
 *
 * The returned string uses only the values passed in `context` — the same values
 * the engine's check already computed. A test should parse the numbers back out
 * of the string and confirm they match exactly.
 */
export function explainDenial(context: DenialContext): string {
  switch (context.code) {
    case "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP":
      return (
        `Blocked: merchant quoted ${formatPaisa(context.quoteAmountInPaisa)} ` +
        `against a proposal of ${formatPaisa(context.proposedAmountInPaisa)} ` +
        `(slippage ${formatPaisa(context.slippageInPaisa)}). ` +
        `The quote exceeds the per-transaction cap of ${formatPaisa(context.capInPaisa)}.`
      );

    case "ERR_CUMULATIVE_CAP_EXCEEDED":
      return (
        `Blocked: consumed ${formatPaisa(context.consumedAmountInPaisa)} ` +
        `+ reserved ${formatPaisa(context.reservedAmountInPaisa)} ` +
        `+ this request ${formatPaisa(context.quoteAmountInPaisa)} ` +
        `= ${formatPaisa(context.projectedExposureInPaisa)}, ` +
        `exceeds cap ${formatPaisa(context.capInPaisa)}.`
      );

    case "ERR_AGENT_LOOP_DETECTED":
      return (
        `Blocked: ${context.proposalCount ?? "?"} proposals in the current ` +
        `${context.windowMinutes ?? "?"}-minute window ` +
        `(maximum ${context.maxProposals ?? "?"}).`
      );

    case "ERR_POLICY_NOT_ACTIVE":
      return (
        `Blocked: authorization status is ${context.status ?? "unknown"}. ` +
        `It can no longer be spent against.`
      );

    case "ERR_AUTHORIZATION_EXPIRED":
      return `Blocked: authorization expired at ${context.expiresAt ?? "unknown"}.`;

    case "ERR_CATEGORY_NOT_ALLOWED":
      return (
        `Blocked: category "${context.category ?? "?"}" is not in the allowlist ` +
        `[${(context.allowedCategories ?? []).join(", ")}].`
      );

    case "ERR_MERCHANT_NOT_ALLOWED":
      return (
        `Blocked: merchant "${context.merchantId ?? "?"}" is not in the allowlist ` +
        `[${(context.allowedMerchants ?? []).join(", ")}].`
      );

    case "ERR_INVALID_APPROVAL_TOKEN":
      return (
        `Blocked: approval token rejected — ` +
        `${context.tokenRejectionReason ?? "unknown"}: ` +
        `${context.tokenRejectionDetail ?? "no detail"}.`
      );

    case "ERR_CONCURRENT_MUTATION":
      return `Blocked: a concurrent request is already processing this exact proposal.`;

    case "PENDING_HUMAN_APPROVAL":
      return (
        `Escalated: quote of ${formatPaisa(context.quoteAmountInPaisa)} ` +
        `requires human approval (threshold ${formatPaisa(context.requiresHumanApprovalAbovePaisa)}). ` +
        `Budget is reserved, not spent.`
      );

    case "ERR_QUOTE_FETCH_TIMEOUT":
      return `Blocked: cart quote service timed out. Nothing was reserved.`;

    case "ERR_QUOTE_FETCH_FAILED":
      return `Blocked: cart quote service error. Nothing was reserved.`;

    case "ERR_RAZORPAY_GATEWAY":
      return `Blocked: payment gateway error. No amount was committed.`;

    case "ERR_INTERNAL_INVARIANT":
      return `Blocked: internal invariant violation. Failed closed for safety.`;

    default:
      return `Blocked: ${context.code}.`;
  }
}
