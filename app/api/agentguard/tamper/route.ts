import { NextResponse } from "next/server";
import { getDashboardState, toggleAuditTamper } from "@/runtime/agentGuardRuntime";
import { verifyAdminToken } from "@/security/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * DEMO ONLY. Rewrites one historical block's `details` in place, leaving its stored hash
 * untouched — the exact footprint of someone editing the audit file by hand. Call again
 * to restore the original contents.
 */
export function POST(request: Request) {
  if (!verifyAdminToken(request)) {
    return NextResponse.json(
      { ok: false, code: "ERR_UNAUTHORIZED", message: "Unauthorized: valid x-agentguard-admin-token header required" },
      { status: 401 },
    );
  }

  const outcome = toggleAuditTamper();
  return NextResponse.json({ ok: true, ...outcome, state: getDashboardState() });
}
