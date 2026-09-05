import { timingSafeEqual } from "node:crypto";

const DEFAULT_DEMO_ADMIN_TOKEN = "ag-admin-demo-token-2026";

export function getExpectedAdminToken(): string {
  return (
    process.env.AGENTGUARD_ADMIN_TOKEN ||
    process.env.NEXT_PUBLIC_AGENTGUARD_ADMIN_TOKEN ||
    DEFAULT_DEMO_ADMIN_TOKEN
  );
}

/**
 * Validates the `x-agentguard-admin-token` header against the configured admin token.
 * Uses timingSafeEqual to protect against timing attacks.
 */
export function verifyAdminToken(request: Request): boolean {
  const expected = getExpectedAdminToken();
  const provided = request.headers.get("x-agentguard-admin-token");
  if (!provided) {
    return false;
  }
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}
