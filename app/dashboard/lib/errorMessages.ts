import type { GuardrailErrorCode } from "@/types/agentGuard";

/**
 * Plain-language translations of engine denial codes, for anything a human reads
 * directly — toasts, badges, verdict callouts.
 *
 * This is deliberately NOT `engine/denialExplanations.ts`. That module builds
 * forensic, value-substituted sentences ("₹8,200 would take exposure to
 * ₹52,400 against a ₹50,000 cap") and writes them into the audit log, where
 * precision is the whole point. This map answers a different question — "what
 * just happened and is it my fault?" — for someone watching a toast for four
 * seconds. Both are deterministic string lookups; neither involves a model.
 *
 * Keyed by the full `GuardrailErrorCode` union, so adding a code to the engine
 * surfaces here as a type error rather than silently falling through to the
 * generic fallback.
 */

interface ErrorCopy {
  /** Terse form for chips and badges, where a sentence will not fit. */
  label: string;
  /** One-sentence explanation for toasts, tooltips and callouts. */
  message: string;
}

const ERROR_COPY: Record<GuardrailErrorCode, ErrorCopy> = {
  ERR_CONCURRENT_MUTATION: {
    label: "Already in flight",
    message:
      "Another request is already processing this exact proposal. Nothing was charged twice.",
  },
  ERR_AGENT_LOOP_DETECTED: {
    label: "Rate limit hit",
    message:
      "The agent proposed too many times in a short window, which usually means it is stuck in a loop. Further proposals are refused until the window resets.",
  },
  ERR_POLICY_NOT_ACTIVE: {
    label: "Mandate inactive",
    message:
      "This mandate is no longer active — it has been exhausted, revoked, or expired without approval.",
  },
  ERR_AUTHORIZATION_EXPIRED: {
    label: "Mandate expired",
    message: "This mandate is past its expiry date, so no further spending is authorized.",
  },
  ERR_CATEGORY_NOT_ALLOWED: {
    label: "Category blocked",
    message:
      "The item's category is not on this mandate's allowlist. The agent may only buy within the categories it was granted.",
  },
  ERR_MERCHANT_NOT_ALLOWED: {
    label: "Merchant blocked",
    message:
      "This merchant is not on the mandate's allowlist, so the purchase was refused before any quote was committed.",
  },
  ERR_PRICE_SLIPPAGE_EXCEEDS_CAP: {
    label: "Over per-transaction cap",
    message:
      "The merchant's actual quote is above the per-transaction limit for this mandate. AgentGuard priced the cart itself rather than trusting the agent's figure.",
  },
  ERR_CUMULATIVE_CAP_EXCEEDED: {
    label: "Over remaining budget",
    message:
      "Committed spend plus in-flight escrow plus this quote would breach the mandate cap. The purchase was refused and nothing was reserved.",
  },
  PENDING_HUMAN_APPROVAL: {
    label: "Awaiting approval",
    message:
      "The amount is above the approval threshold. Budget is held in escrow — not charged — until someone approves or denies it.",
  },
  ERR_INVALID_APPROVAL_TOKEN: {
    label: "Approval rejected",
    message:
      "The approval token was forged, expired, already used, or bound to a different proposal. The settlement was refused.",
  },
  ERR_QUOTE_FETCH_TIMEOUT: {
    label: "Merchant timed out",
    message:
      "The merchant did not return a price in time. AgentGuard will not guess an amount, so the purchase was refused.",
  },
  ERR_QUOTE_FETCH_FAILED: {
    label: "Quote unavailable",
    message:
      "The merchant's quote could not be read. Without a verified price, AgentGuard refuses rather than trusting the agent's number.",
  },
  ERR_RAZORPAY_GATEWAY: {
    label: "Gateway error",
    message:
      "Razorpay rejected or failed the order. No money moved and the reserved budget was released.",
  },
  ERR_INTERNAL_INVARIANT: {
    label: "Internal invariant",
    message:
      "An internal consistency check failed, so AgentGuard stopped instead of proceeding. This always fails closed — nothing was charged.",
  },
};

const FALLBACK: ErrorCopy = {
  label: "Blocked",
  message: "The proposal was refused by the guardrail engine. Nothing was charged.",
};

function lookup(code: string | null | undefined): ErrorCopy {
  if (!code) return FALLBACK;
  return ERROR_COPY[code as GuardrailErrorCode] ?? FALLBACK;
}

/** One-sentence explanation. Safe to call with any string, including unknown codes. */
export function errorMessage(code: string | null | undefined): string {
  return lookup(code).message;
}

/** Terse label for chips and badges where a sentence will not fit. */
export function errorLabel(code: string | null | undefined): string {
  return lookup(code).label;
}
