import crypto from "node:crypto";

/**
 * Server-side cryptographic helpers.
 *
 * The signing secret is read from the environment and never leaves the server
 * process. It is not placed in any prompt, tool schema, or agent-visible payload.
 */

const DEV_FALLBACK_SECRET =
  "agentguard-dev-only-secret-do-not-use-in-production-0000000000000000";

export function getServerSecret(): string {
  const secret = process.env.AGENTGUARD_SERVER_SECRET;
  if (secret && secret.length >= 16 && secret !== "replace-with-a-long-random-string") {
    return secret;
  }
  if (process.env.NODE_ENV === "production" || process.env.AGENTGUARD_ENV === "production") {
    throw new Error(
      "[AgentGuard] AGENTGUARD_SERVER_SECRET must be set to a secure string (at least 16 characters) in production. Refusing to use dev fallback secret.",
    );
  }
  return DEV_FALLBACK_SECRET;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export function hmacHex(payload: string, secret: string = getServerSecret()): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** Constant-time hex-digest comparison. Length mismatch short-circuits to false. */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export function randomHex(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Deterministic composite key over the fields that make a proposal unique.
 * Each component is percent-encoded before joining so that a value containing
 * the delimiter cannot forge a different tuple with the same digest.
 */
export function computeIdempotencyKey(parts: {
  authorizationId: string;
  merchantId: string;
  proposedAmountInPaisa: number;
  clientNonce: string;
}): string {
  const composite = [
    parts.authorizationId,
    parts.merchantId,
    String(parts.proposedAmountInPaisa),
    parts.clientNonce,
  ]
    .map((component) => encodeURIComponent(component))
    .join("|");
  return sha256Hex(composite);
}

/** Stable JSON stringify (sorted keys) so signatures do not depend on key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortDeep(source[key]);
    }
    return out;
  }
  return value;
}
