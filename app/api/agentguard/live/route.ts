import { NextResponse } from "next/server";
import { getDashboardState, runLiveAction } from "@/runtime/agentGuardRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { actionId } — the agent proposes a purchase against the demo mandate.
 *
 * This is the only way in: the caller never names an amount to charge, only an intent.
 * AgentGuard fetches its own quote and decides.
 */
export async function POST(request: Request) {
  let body: { actionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Body must be JSON" }, { status: 400 });
  }

  if (typeof body.actionId !== "string" || body.actionId.length === 0) {
    return NextResponse.json({ ok: false, message: "actionId is required" }, { status: 400 });
  }

  const outcome = await runLiveAction(body.actionId);
  return NextResponse.json(
    { ...outcome, state: getDashboardState() },
    { status: outcome.ok ? 200 : 404 },
  );
}
