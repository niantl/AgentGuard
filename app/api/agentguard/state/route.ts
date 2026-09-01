import { NextResponse } from "next/server";
import { getDashboardState } from "@/runtime/agentGuardRuntime";

/**
 * Everything the dashboard renders, in one snapshot.
 *
 * Node runtime and force-dynamic are required on every AgentGuard route: the engine
 * uses `node:crypto` and `node:fs`, and the ledger must never be served from a cache.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getDashboardState());
}
