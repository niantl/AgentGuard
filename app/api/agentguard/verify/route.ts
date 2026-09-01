import { NextResponse } from "next/server";
import { getDashboardState, verifyAuditChain } from "@/runtime/agentGuardRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recomputes every block hash and every link from the genesis block forward.
 *
 * Nothing is trusted from the stored `currentHash` values — a tampered log whose hashes
 * were also rewritten still breaks, because the chain of `previousHash` references no
 * longer matches.
 */
export function POST() {
  const integrity = verifyAuditChain();
  return NextResponse.json({ ok: true, integrity, state: getDashboardState() });
}

export function GET() {
  return NextResponse.json({ ok: true, integrity: verifyAuditChain() });
}
