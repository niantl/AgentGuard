import { NextResponse } from "next/server";
import { runPreflightChecks } from "@/runtime/agentGuardRuntime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The pre-flight assertions, also runnable as `npm run preflight`.
 *
 * Returns 503 when any check fails, so a demo can be aborted before it starts rather
 * than discovering a broken invariant on stage.
 */
export function GET() {
  const report = runPreflightChecks();
  return NextResponse.json(report, { status: report.allPassed ? 200 : 503 });
}
