import { canonicalJson, hmacHex, timingSafeHexEqual } from "@/security/crypto";
import type { HumanApprovalToken } from "@/types/agentGuard";

/**
 * Issuance, encoding, and verification of `HumanApprovalToken`s.
 *
 * A token is a bearer capability for exactly one escalated proposal. It is bound
 * to the idempotency key AND the exact quoted amount, so a human who approves
 * ₹4,000 for cart X cannot have that approval replayed against cart Y or against a
 * re-quoted, more expensive cart X.
 */

export const APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type ApprovalTokenRejectionReason =
  | "MALFORMED"
  | "SIGNATURE_INVALID"
  | "EXPIRED"
  | "ALREADY_CONSUMED"
  | "IDEMPOTENCY_KEY_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "AUTHORIZATION_MISMATCH";

/** Canonical payload the signature covers: every field except the signature itself. */
function tokenSigningPayload(token: Omit<HumanApprovalToken, "signature">): string {
  return canonicalJson({
    authorizationId: token.authorizationId,
    idempotencyKey: token.idempotencyKey,
    approvedAmountInPaisa: token.approvedAmountInPaisa,
    approverId: token.approverId,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
  });
}

export function signApprovalToken(token: Omit<HumanApprovalToken, "signature">): string {
  return hmacHex(tokenSigningPayload(token));
}

export function issueApprovalToken(input: {
  authorizationId: string;
  idempotencyKey: string;
  approvedAmountInPaisa: number;
  approverId: string;
  nowMs: number;
  ttlMs?: number;
}): HumanApprovalToken {
  const unsigned: Omit<HumanApprovalToken, "signature"> = {
    authorizationId: input.authorizationId,
    idempotencyKey: input.idempotencyKey,
    approvedAmountInPaisa: input.approvedAmountInPaisa,
    approverId: input.approverId,
    issuedAt: new Date(input.nowMs).toISOString(),
    expiresAt: new Date(input.nowMs + (input.ttlMs ?? APPROVAL_TOKEN_TTL_MS)).toISOString(),
  };
  return { ...unsigned, signature: signApprovalToken(unsigned) };
}

/** Tokens travel on `IntentProposal.humanApprovalToken` as base64url JSON. */
export function encodeApprovalToken(token: HumanApprovalToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

export function decodeApprovalToken(encoded: string): HumanApprovalToken | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      !parsed ||
      typeof parsed.authorizationId !== "string" ||
      typeof parsed.idempotencyKey !== "string" ||
      typeof parsed.approvedAmountInPaisa !== "number" ||
      typeof parsed.approverId !== "string" ||
      typeof parsed.issuedAt !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.signature !== "string"
    ) {
      return null;
    }
    return parsed as HumanApprovalToken;
  } catch {
    return null;
  }
}

export interface ApprovalTokenVerification {
  valid: boolean;
  reason: ApprovalTokenRejectionReason | null;
  token: HumanApprovalToken | null;
  detail: string;
}

/**
 * Verify a token against the escalation it claims to authorize.
 *
 * Check order is deliberate and matches the engine's documented sequence:
 * signature → expiry → replay → idempotency binding → amount binding. Replay is
 * checked before the binding checks so that presenting an already-spent token
 * against a *different* proposal is reported as a replay rather than a mismatch.
 */
export function verifyApprovalToken(input: {
  encoded: string;
  expectedAuthorizationId: string;
  expectedIdempotencyKey: string;
  expectedAmountInPaisa: number;
  nowMs: number;
  isConsumed: (signature: string) => boolean;
}): ApprovalTokenVerification {
  const token = decodeApprovalToken(input.encoded);
  if (!token) {
    return {
      valid: false,
      reason: "MALFORMED",
      token: null,
      detail: "Approval token is not decodable base64url JSON with the required fields",
    };
  }

  const expectedSignature = signApprovalToken({
    authorizationId: token.authorizationId,
    idempotencyKey: token.idempotencyKey,
    approvedAmountInPaisa: token.approvedAmountInPaisa,
    approverId: token.approverId,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
  });

  if (!timingSafeHexEqual(token.signature, expectedSignature)) {
    return {
      valid: false,
      reason: "SIGNATURE_INVALID",
      token,
      detail: "HMAC signature does not match — token was forged or its fields were edited",
    };
  }

  const expiresAtMs = Date.parse(token.expiresAt);
  if (Number.isNaN(expiresAtMs) || input.nowMs >= expiresAtMs) {
    return {
      valid: false,
      reason: "EXPIRED",
      token,
      detail: `Token expired at ${token.expiresAt}`,
    };
  }

  if (input.isConsumed(token.signature)) {
    return {
      valid: false,
      reason: "ALREADY_CONSUMED",
      token,
      detail: "Token has already been spent — replay rejected",
    };
  }

  if (token.authorizationId !== input.expectedAuthorizationId) {
    return {
      valid: false,
      reason: "AUTHORIZATION_MISMATCH",
      token,
      detail: `Token authorizes ${token.authorizationId}, proposal targets ${input.expectedAuthorizationId}`,
    };
  }

  if (token.idempotencyKey !== input.expectedIdempotencyKey) {
    return {
      valid: false,
      reason: "IDEMPOTENCY_KEY_MISMATCH",
      token,
      detail: "Token is bound to a different proposal than the one being resubmitted",
    };
  }

  if (token.approvedAmountInPaisa !== input.expectedAmountInPaisa) {
    return {
      valid: false,
      reason: "AMOUNT_MISMATCH",
      token,
      detail:
        `Human approved ${token.approvedAmountInPaisa} paisa but the escalated quote is ` +
        `${input.expectedAmountInPaisa} paisa`,
    };
  }

  return { valid: true, reason: null, token, detail: "Approval token verified" };
}
