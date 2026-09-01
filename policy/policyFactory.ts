import { canonicalJson, hmacHex, randomHex, timingSafeHexEqual } from "@/security/crypto";
import type { AuthorizationPolicy, AuthorizationStatus } from "@/types/agentGuard";

/**
 * Construction and signing of `AuthorizationPolicy` objects.
 *
 * The policy is the *only* source of spending authority. The agent never receives
 * it, cannot address it, and cannot modify it — it is signed server-side with the
 * server secret and every field is validated at creation time.
 */

export class PolicyValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyValidationError";
    this.code = code;
  }
}

export interface CreatePolicyInput {
  authorizationId?: string;
  userId: string;
  purpose: string;
  maxAmountInPaisa: number;
  allowedCategories: string[];
  allowedMerchants: string[];
  /** ISO 8601, or a Date. */
  expiresAt: string | Date;
  requiresHumanApprovalAbovePaisa: number;
  currency?: "INR";
  initialStatus?: AuthorizationStatus;
}

/** Fields covered by the policy signature. `state` is deliberately excluded — it mutates. */
function policySigningPayload(policy: AuthorizationPolicy): string {
  return canonicalJson({
    authorizationId: policy.authorizationId,
    userId: policy.userId,
    purpose: policy.purpose,
    constraints: policy.constraints,
    nonce: policy.security.nonce,
  });
}

export function signPolicy(policy: AuthorizationPolicy): string {
  return hmacHex(policySigningPayload(policy));
}

export function verifyPolicySignature(policy: AuthorizationPolicy): boolean {
  return timingSafeHexEqual(policy.security.signature, signPolicy(policy));
}

/**
 * Shared validation: `requiresHumanApprovalAbovePaisa` must not exceed
 * `maxAmountInPaisa`. A policy that violates this would have an unreachable
 * escalation branch — silently disabling human oversight while appearing to
 * have it. Throws `PolicyValidationError` on violation.
 *
 * Called from both `createAuthorizationPolicy` and `compilePolicyDsl`, so
 * there is exactly one copy of this check. Do not duplicate it.
 */
export function validateEscalationReachability(
  requiresHumanApprovalAbovePaisa: number,
  maxAmountInPaisa: number,
): void {
  if (requiresHumanApprovalAbovePaisa > maxAmountInPaisa) {
    throw new PolicyValidationError(
      "ERR_POLICY_UNREACHABLE_ESCALATION",
      `requiresHumanApprovalAbovePaisa (${requiresHumanApprovalAbovePaisa}) exceeds ` +
        `maxAmountInPaisa (${maxAmountInPaisa}). The human-escalation branch would be ` +
        `unreachable: any quote big enough to require approval is already blocked by the ` +
        `per-transaction cap, so this policy would appear to have human oversight while ` +
        `having none. Rejected at creation time.`,
    );
  }
}

/**
 * Build and sign a policy, rejecting structurally invalid mandates up front.
 *
 * The load-bearing check is the last one: a policy with
 * `requiresHumanApprovalAbovePaisa > maxAmountInPaisa` can never escalate, because
 * any quote large enough to need a human would already have been rejected by the
 * per-transaction cap. Such a policy silently disables human oversight while
 * *looking* like it has some, so it is refused at creation rather than at runtime.
 */
export function createAuthorizationPolicy(input: CreatePolicyInput): AuthorizationPolicy {
  const {
    userId,
    purpose,
    maxAmountInPaisa,
    allowedCategories,
    allowedMerchants,
    requiresHumanApprovalAbovePaisa,
  } = input;

  if (!userId || typeof userId !== "string") {
    throw new PolicyValidationError("ERR_POLICY_INVALID_USER", "userId is required");
  }
  if (!purpose || typeof purpose !== "string") {
    throw new PolicyValidationError("ERR_POLICY_INVALID_PURPOSE", "purpose is required");
  }
  if (!Number.isInteger(maxAmountInPaisa) || maxAmountInPaisa <= 0) {
    throw new PolicyValidationError(
      "ERR_POLICY_INVALID_CAP",
      `maxAmountInPaisa must be a positive integer number of paisa, received ${maxAmountInPaisa}`,
    );
  }
  if (!Number.isInteger(requiresHumanApprovalAbovePaisa) || requiresHumanApprovalAbovePaisa < 0) {
    throw new PolicyValidationError(
      "ERR_POLICY_INVALID_APPROVAL_THRESHOLD",
      `requiresHumanApprovalAbovePaisa must be a non-negative integer, received ${requiresHumanApprovalAbovePaisa}`,
    );
  }
  if (!Array.isArray(allowedCategories) || allowedCategories.length === 0) {
    throw new PolicyValidationError(
      "ERR_POLICY_NO_CATEGORIES",
      "allowedCategories must contain at least one category (deny-by-default)",
    );
  }
  if (!Array.isArray(allowedMerchants) || allowedMerchants.length === 0) {
    throw new PolicyValidationError(
      "ERR_POLICY_NO_MERCHANTS",
      "allowedMerchants must contain at least one merchant (deny-by-default)",
    );
  }

  const expiresAtIso =
    input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt;
  if (Number.isNaN(Date.parse(expiresAtIso))) {
    throw new PolicyValidationError(
      "ERR_POLICY_INVALID_EXPIRY",
      `expiresAt must be a valid ISO 8601 timestamp, received "${String(input.expiresAt)}"`,
    );
  }

  // The unreachable-escalation check — calls the shared function.
  validateEscalationReachability(requiresHumanApprovalAbovePaisa, maxAmountInPaisa);

  const policy: AuthorizationPolicy = {
    authorizationId: input.authorizationId ?? `auth_${randomHex(8)}`,
    userId,
    purpose,
    constraints: {
      maxAmountInPaisa,
      currency: input.currency ?? "INR",
      allowedCategories: [...allowedCategories],
      allowedMerchants: [...allowedMerchants],
      expiresAt: expiresAtIso,
      requiresHumanApprovalAbovePaisa,
    },
    state: {
      status: input.initialStatus ?? "ACTIVE",
      consumedAmountInPaisa: 0,
      reservedAmountInPaisa: 0,
      executedTransactionIds: [],
    },
    security: { nonce: randomHex(16), signature: "" },
  };

  policy.security.signature = signPolicy(policy);
  return policy;
}

/** Remaining spendable headroom: cap minus committed minus in-flight. */
export function remainingHeadroomInPaisa(policy: AuthorizationPolicy): number {
  return Math.max(
    0,
    policy.constraints.maxAmountInPaisa -
      policy.state.consumedAmountInPaisa -
      policy.state.reservedAmountInPaisa,
  );
}
