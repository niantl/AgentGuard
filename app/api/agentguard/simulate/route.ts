import { NextResponse } from "next/server";
import { getDashboardState, runScenario } from "@/runtime/agentGuardRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { scenarioId } — runs one adversarial scenario against the live engine. */
export async function POST(request: Request) {
  let body: { scenarioId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Body must be JSON" }, { status: 400 });
  }

  if (typeof body.scenarioId !== "string" || body.scenarioId.length === 0) {
    return NextResponse.json({ ok: false, message: "scenarioId is required" }, { status: 400 });
  }

  const outcome = await runScenario(body.scenarioId);
  return NextResponse.json(
    { ...outcome, state: getDashboardState() },
    { status: outcome.ok ? 200 : 404 },
  );
}
