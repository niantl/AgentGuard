import { NextResponse } from "next/server";
import { getDashboardState, resetRuntime } from "@/runtime/agentGuardRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Clears the on-disk ledger and audit chain, then re-seeds the demo mandate. */
export function POST() {
  resetRuntime();
  return NextResponse.json({
    ok: true,
    message: "Ledger and audit chain cleared. Demo authorization re-seeded.",
    state: getDashboardState(),
  });
}
