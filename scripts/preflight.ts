/**
 * CLI pre-flight check — `npm run preflight`.
 *
 * Runs the same assertions the dashboard's Pre-flight button runs, but in a fresh process,
 * which is the point: it loads `agentguard-state.json` from disk and reports the consumed /
 * reserved figures it found there. Run it after killing and restarting the dev server to
 * confirm a partially-reserved transaction survived the restart.
 *
 * Exits 1 if any check fails, so it can gate a demo or a CI step.
 */
import {
  DEMO_AUTHORIZATION_ID,
  getDashboardState,
  runPreflightChecks,
} from "@/runtime/agentGuardRuntime";

function main(): void {
  const { allPassed, checks } = runPreflightChecks();
  const state = getDashboardState();
  const policy = state.activePolicy;

  console.log("AgentGuard pre-flight");
  console.log("─".repeat(72));

  for (const check of checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
    console.log(`      ${check.detail}`);
  }

  console.log("─".repeat(72));
  console.log("Ledger recovered from snapshot:");
  console.log(`  authorization        ${policy?.authorizationId ?? DEMO_AUTHORIZATION_ID}`);
  console.log(`  status               ${policy?.status ?? "(no policy loaded)"}`);
  console.log(`  cap (paisa)          ${policy?.maxAmountInPaisa ?? 0}`);
  console.log(`  consumed (paisa)     ${policy?.consumedAmountInPaisa ?? 0}`);
  console.log(`  reserved (paisa)     ${policy?.reservedAmountInPaisa ?? 0}`);
  console.log(`  headroom (paisa)     ${policy?.remainingHeadroomInPaisa ?? 0}`);
  console.log(`  orders executed      ${policy?.executedTransactionIds.length ?? 0}`);
  console.log(`  open escalations     ${state.pendingEscalations.length}`);
  console.log(`  audit blocks         ${state.audit.totalBlocks}`);
  console.log(`  chain integrity      ${state.audit.integrity.valid ? "VALID" : "BROKEN"}`);
  console.log(`  snapshot file        ${state.persistence.stateFilePath}`);
  console.log("─".repeat(72));

  const failed = checks.filter((check) => !check.passed);
  if (allPassed) {
    console.log(`All ${checks.length} checks passed.`);
    return;
  }
  console.error(`${failed.length} of ${checks.length} checks FAILED.`);
  process.exitCode = 1;
}

main();
