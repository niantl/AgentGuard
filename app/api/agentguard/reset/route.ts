import { NextResponse } from "next/server";
import { getDashboardState, resetRuntime } from "@/runtime/agentGuardRuntime";
import { verifyAdminToken } from "@/security/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clears the on-disk ledger and audit chain, then re-seeds the demo mandate. */
export function POST(request: Request) {
  if (!verifyAdminToken(request)) {
    return NextResponse.json(
      { ok: false, code: "ERR_UNAUTHORIZED", message: "Unauthorized: valid x-agentguard-admin-token header required" },
      { status: 401 },
    );
  }

  resetRuntime();
  return NextResponse.json({
    ok: true,
    message: "Ledger and audit chain cleared. Demo authorization re-seeded.",
    state: getDashboardState(),
  });
}
