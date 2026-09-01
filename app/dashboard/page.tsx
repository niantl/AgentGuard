import { getDashboardState } from "@/runtime/agentGuardRuntime";
import { DashboardClient } from "./DashboardClient";

/**
 * The dashboard reads live engine state, so it can never be statically rendered or cached.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return <DashboardClient initialState={getDashboardState()} />;
}
