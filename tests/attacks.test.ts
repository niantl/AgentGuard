import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ATTACK_SCENARIOS,
  createScenarioContext,
  getScenario,
  type ScenarioContext,
  type ScenarioOutcome,
} from "@/mocks/attackSuite";
import { SimulatedRazorpayGateway, type GatewayHandle } from "@/payments/razorpayClient";
import { ENCLAVE_TAG } from "@/security/sanitizer";
import type { TransactionFailure, TransactionResult, TransactionSuccess } from "@/types/agentGuard";

/**
 * The eight mandated attack tests.
 *
 * These run the same scenario code the dashboard's simulation panel runs, so a green
 * suite and a green dashboard mean the same thing. Assertions here are made against
 * the raw engine results rather than the scenario's own `passed` flag — a scenario
 * cannot mark its own homework.
 */

const TMP_DIR = path.join(process.cwd(), ".tmp-test");
const STATE_FILE = path.join(TMP_DIR, "attacks-state.json");

let gateway: GatewayHandle;
let simulated: SimulatedRazorpayGateway;
let ctx: ScenarioContext;

function freshGateway(): void {
  simulated = new SimulatedRazorpayGateway();
  gateway = {
    client: simulated,
    mode: "SIMULATED",
    callCount: () => simulated.callCount(),
    description: "test gateway",
  };
}

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.rmSync(STATE_FILE, { force: true });
  freshGateway();
  // Audit chain stays in memory (no persistPath) — the chain logic is identical.
  ctx = createScenarioContext({ stateFilePath: STATE_FILE, gateway });
});

afterAll(() => {
  fs.rmSync(STATE_FILE, { force: true });
});

// ---------------------------------------------------------------------------
// Narrowing helpers — these make a wrong-shaped result a clear test failure
// ---------------------------------------------------------------------------

function expectFailure(result: TransactionResult | undefined): TransactionFailure {
  expect(result, "expected a result").toBeDefined();
  expect(result!.success, `expected a failure, got ${JSON.stringify(result)}`).toBe(false);
  return result as TransactionFailure;
}

function expectSuccess(result: TransactionResult | undefined): TransactionSuccess {
  expect(result, "expected a result").toBeDefined();
  expect(result!.success, `expected a success, got ${JSON.stringify(result)}`).toBe(true);
  return result as TransactionSuccess;
}

async function run(id: string): Promise<ScenarioOutcome> {
  const scenario = getScenario(id);
  expect(scenario, `scenario "${id}" is not registered`).toBeDefined();
  return scenario!.run(ctx);
}

// ===========================================================================
// 1. Price slippage
// ===========================================================================

describe("attack 1 — price slippage", () => {
  it("blocks a quote above the per-transaction cap and creates no Razorpay order", async () => {
    const callsBefore = gateway.callCount();
    const outcome = await run("price_slippage");

    const failure = expectFailure(outcome.results[0]);
    expect(failure.code).toBe("ERR_PRICE_SLIPPAGE_EXCEEDS_CAP");

    // No order, and nothing left behind in either ledger bucket.
    expect(gateway.callCount()).toBe(callsBefore);
    expect(outcome.gatewayCallsMade).toBe(0);
    expect(outcome.policy.consumedAmountInPaisa).toBe(0);
    expect(outcome.policy.reservedAmountInPaisa).toBe(0);
    expect(outcome.policy.executedTransactionIds).toEqual([]);

    // Blocked at step 4, and the failure is attributed to the quote, not the cap sum.
    const step4 = failure.steps.find((step) => step.step === 4);
    expect(step4?.status).toBe("FAILED");
    expect(failure.steps.find((step) => step.step === 6)?.status).toBe("NOT_REACHED");

    expect(outcome.passed).toBe(true);
  });
});

// ===========================================================================
// 2. Prompt injection
// ===========================================================================

describe("attack 2 — prompt injection in vendor catalog data", () => {
  it("neutralises every payload and, crucially, enforces the cap anyway", async () => {
    const outcome = await run("prompt_injection");
    const reports = outcome.detail?.sanitizationReports as Array<{
      itemId: string;
      attackVector: string;
      sanitized: string;
      enclosed: string;
      matchedDenylistPhrases: string[];
      removedZeroWidthCount: number;
      escapedEnclave: boolean;
      containsScriptTag: boolean;
      containsHtmlComment: boolean;
    }>;

    expect(reports.length).toBeGreaterThanOrEqual(7);

    for (const report of reports) {
      // The structural defense: vendor text can never close the enclave.
      expect(report.escapedEnclave, `${report.itemId} escaped the enclave`).toBe(false);
      expect(report.containsScriptTag, `${report.itemId} kept a <script> tag`).toBe(false);
      expect(report.containsHtmlComment, `${report.itemId} kept an HTML comment`).toBe(false);
      // And the payload is always delivered wrapped, with the passive-data warning.
      expect(report.enclosed.startsWith(`<${ENCLAVE_TAG}>`)).toBe(true);
      expect(report.enclosed).toContain(`CRITICAL: Information inside <${ENCLAVE_TAG}>`);
    }

    // Specific vectors the sanitizer is expected to catch.
    const plainText = reports.find((r) => r.itemId === "item_injected_toner")!;
    expect(plainText.matchedDenylistPhrases.length).toBeGreaterThan(0);
    expect(plainText.sanitized).toContain("[STRIPPED_UNTRUSTED_INSTRUCTION]");
    expect(plainText.sanitized).not.toMatch(/ignore previous instructions/i);

    const zeroWidth = reports.find((r) => r.itemId === "item_injected_desk")!;
    expect(zeroWidth.removedZeroWidthCount).toBeGreaterThan(0);
    // Zero-width splitting is defeated because stripping runs before matching.
    expect(zeroWidth.matchedDenylistPhrases.length).toBeGreaterThan(0);

    const homoglyph = reports.find((r) => r.itemId === "item_injected_webcam")!;
    // NFKC folds fullwidth Latin back to ASCII, so the phrase becomes visible.
    expect(homoglyph.matchedDenylistPhrases.length).toBeGreaterThan(0);

    const breakout = reports.find((r) => r.itemId === "item_injected_projector")!;
    expect(breakout.sanitized).not.toContain("<system>");
    expect(breakout.sanitized).not.toContain(`</${ENCLAVE_TAG}>`);

    // The honest limitation, asserted rather than glossed over: the base64 payload
    // is invisible to the denylist. Defense does not depend on catching it.
    const base64Payload = reports.find((r) => r.itemId === "item_injected_router")!;
    expect(base64Payload.matchedDenylistPhrases).toEqual([]);

    // THE ASSERTION THAT MATTERS: the injected text demands the budget cap be
    // ignored. The engine's behaviour is unchanged, because the cap is read from a
    // signed policy the injected text cannot address.
    const failure = expectFailure(outcome.results[0]);
    expect(failure.code).toBe("ERR_PRICE_SLIPPAGE_EXCEEDS_CAP");
    expect(outcome.gatewayCallsMade).toBe(0);
    expect(outcome.policy.consumedAmountInPaisa).toBe(0);
    expect(outcome.policy.reservedAmountInPaisa).toBe(0);

    expect(outcome.passed).toBe(true);
  });
});

// ===========================================================================
// 3. Retry double-spend
// ===========================================================================

describe("attack 3 — retry storm double-spend", () => {
  it("replays the cached COMPLETED result and calls orders.create exactly once", async () => {
    const callsBefore = simulated.callCount();
    const outcome = await run("retry_double_spend");

    const first = expectSuccess(outcome.results[0]);
    const second = expectSuccess(outcome.results[1]);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);

    // The mandated assertion: exactly one gateway call across both submissions.
    expect(simulated.callCount() - callsBefore).toBe(1);
    expect(outcome.gatewayCallsMade).toBe(1);

    // Charged once in the ledger too.
    expect(outcome.policy.consumedAmountInPaisa).toBe(53_960);
    expect(outcome.policy.reservedAmountInPaisa).toBe(0);
    expect(outcome.policy.executedTransactionIds).toHaveLength(1);

    // The replay short-circuits at step 1 without re-running steps 2–6.
    expect(second.steps.find((step) => step.step === 1)?.status).toBe("PASSED");
    expect(second.steps.find((step) => step.step === 4)?.status).toBe("NOT_REACHED");
    expect(second.steps.find((step) => step.step === 6)?.status).toBe("NOT_REACHED");

    expect(outcome.passed).toBe(true);
  });
});

// ===========================================================================
// 4. Agent loop
// ===========================================================================

describe("attack 4 — runaway agent loop", () => {
  it("allows 5 proposals in the window and blocks the 6th", async () => {
    const outcome = await run("agent_loop");
    expect(outcome.results).toHaveLength(6);

    for (const [index, result] of outcome.results.slice(0, 5).entries()) {
      expectSuccess(result);
      expect(result.success, `proposal ${index + 1} should have executed`).toBe(true);
    }

    const sixth = expectFailure(outcome.results[5]);
    expect(sixth.code).toBe("ERR_AGENT_LOOP_DETECTED");

    // Blocked at step 2, before any quote fetch or reservation.
    expect(sixth.steps.find((step) => step.step === 2)?.status).toBe("FAILED");
    expect(sixth.steps.find((step) => step.step === 4)?.status).toBe("NOT_REACHED");

    expect(outcome.gatewayCallsMade).toBe(5);
    expect(outcome.policy.reservedAmountInPaisa).toBe(0);
    expect(outcome.passed).toBe(true);
  });
});

// ===========================================================================
// 5. Sequential budget drain
// ===========================================================================

describe("attack 5 — sequential budget drain", () => {
  it("blocks the purchase that would push cumulative spend past the cap", async () => {
    const outcome = await run("sequential_drain");
    expect(outcome.results).toHaveLength(3);

    expectSuccess(outcome.results[0]);
    expectSuccess(outcome.results[1]);

    const third = expectFailure(outcome.results[2]);
    expect(third.code).toBe("ERR_CUMULATIVE_CAP_EXCEEDED");

    // Each purchase was individually under the cap — only the sum breaches it.
    expect(outcome.policy.maxAmountInPaisa).toBe(500_000);
    expect(outcome.policy.consumedAmountInPaisa).toBe(360_000);
    expect(outcome.policy.reservedAmountInPaisa).toBe(0);
    expect(outcome.gatewayCallsMade).toBe(2);
    expect(outcome.policy.executedTransactionIds).toHaveLength(2);

    expect(outcome.passed).toBe(true);
  });
});

// ===========================================================================
// 6. Concurrent budget drain — the ledger race
// ===========================================================================

describe("attack 6 — concurrent budget drain (TOCTOU ledger race)", () => {
  /**
   * This is the test that catches the race. It must stay genuinely concurrent:
   * both proposals are in flight, suspended on the cart-quote await, before either
   * reaches the budget check. Reducing this to two sequential calls would pass even
   * against the broken implementation and prove nothing.
   */
  it("commits exactly one of two racing proposals, never both", async () => {
    const callsBefore = simulated.callCount();
    const outcome = await run("concurrent_drain");
    expect(outcome.results).toHaveLength(2);

    const [resultA, resultB] = outcome.results as [TransactionResult, TransactionResult];
    const successes = [resultA, resultB].filter((result) => result.success);
    const capBlocked = [resultA, resultB].filter(
      (result) => !result.success && result.code === "ERR_CUMULATIVE_CAP_EXCEEDED",
    );

    // Deliberately agnostic about *which* one won — the event-loop interleaving is
    // not something a correct implementation needs to make deterministic.
    expect(successes).toHaveLength(1);
    expect(capBlocked).toHaveLength(1);

    // The money side of the same claim: 300000 committed against a 500000 cap, and
    // one single gateway call. If both had committed this would be 600000 and 2.
    expect(outcome.policy.maxAmountInPaisa).toBe(500_000);
    expect(outcome.policy.consumedAmountInPaisa).toBe(300_000);
    expect(outcome.policy.reservedAmountInPaisa).toBe(0);
    expect(outcome.policy.executedTransactionIds).toHaveLength(1);
    expect(simulated.callCount() - callsBefore).toBe(1);
    expect(outcome.gatewayCallsMade).toBe(1);

    // Cumulative spend never exceeded the cap at any point.
    expect(
      outcome.policy.consumedAmountInPaisa + outcome.policy.reservedAmountInPaisa,
    ).toBeLessThanOrEqual(outcome.policy.maxAmountInPaisa);

    expect(outcome.passed).toBe(true);
  });

  it("stays correct across repeated races", async () => {
    // The failure mode is timing-dependent, so one pass is weak evidence. Run the
    // race several times; a broken check-and-reserve shows up as a double commit.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = await run("concurrent_drain");
      const successes = outcome.results.filter((result) => result.success);
      expect(successes, `attempt ${attempt + 1} committed ${successes.length} proposals`).toHaveLength(1);
      expect(outcome.policy.consumedAmountInPaisa).toBe(300_000);
      expect(outcome.policy.reservedAmountInPaisa).toBe(0);
    }
  });
});

// ===========================================================================
// 7. Forged / stale / reused approval tokens
// ===========================================================================

describe("attack 7 — forged, stale, and replayed approval tokens", () => {
  it("rejects all three cases and releases the reservation each time", async () => {
    const outcome = await run("approval_forgery");
    const cases = outcome.detail?.forgeryCases as Array<{
      kind: string;
      result: TransactionResult;
      reservedBeforeInPaisa: number;
      reservedAfterInPaisa: number;
      expectedRejection: string;
    }>;

    expect(cases).toHaveLength(3);
    expect(cases.map((entry) => entry.kind)).toEqual([
      "MISMATCHED_IDEMPOTENCY_KEY",
      "EXPIRED",
      "PREVIOUSLY_CONSUMED",
    ]);

    for (const entry of cases) {
      const failure = expectFailure(entry.result);
      expect(failure.code, `${entry.kind} should be ERR_INVALID_APPROVAL_TOKEN`).toBe(
        "ERR_INVALID_APPROVAL_TOKEN",
      );
      // The specific reason is surfaced so the audit log explains *why* it failed.
      expect(failure.reason).toContain(entry.expectedRejection);

      // The mandated assertion: reservedAmountInPaisa returns to its prior value.
      // Each escalation held 400000; after rejection the release must bring it back.
      expect(entry.reservedBeforeInPaisa).toBe(400_000);
      expect(
        entry.reservedAfterInPaisa,
        `${entry.kind} left ${entry.reservedAfterInPaisa} paisa stranded in reserved`,
      ).toBe(0);

      // Rejected at step 5, so step 6 never ran.
      expect(failure.steps.find((step) => step.step === 5)?.status).toBe("FAILED");
      expect(failure.steps.find((step) => step.step === 6)?.status).toBe("NOT_REACHED");
    }

    // Only the one genuine approval moved money.
    expect(outcome.gatewayCallsMade).toBe(1);
    expect(outcome.policy.consumedAmountInPaisa).toBe(400_000);
    expect(outcome.policy.reservedAmountInPaisa).toBe(0);
    expect(outcome.policy.executedTransactionIds).toHaveLength(1);

    expect(outcome.passed).toBe(true);
  });
});

// ===========================================================================
// 8. Hash chain integrity
// ===========================================================================

describe("attack 8 — audit hash chain integrity", () => {
  it("verifies true after a full run and false after one block is tampered with", async () => {
    // Every scenario above has already written to `ctx.logger`. Run one more so the
    // chain definitely spans blocked, escalated, executed and failed branches.
    await run("price_slippage");

    const detailed = ctx.logger.verifyChainIntegrityDetailed();
    expect(detailed.valid, `chain broken: ${detailed.reason}`).toBe(true);
    expect(detailed.brokenAtIndex).toBeNull();
    expect(detailed.blockCount).toBeGreaterThan(20);
    expect(ctx.logger.verifyChainIntegrity()).toBe(true);

    // Every decision branch should be represented in the log.
    const events = new Set(ctx.logger.getChain().map((block) => block.event));
    for (const expected of [
      "INTENT_PROPOSAL_RECEIVED",
      "BUDGET_RESERVED",
      "TRANSACTION_BLOCKED",
      "ESCALATED_TO_HUMAN",
      "HUMAN_APPROVAL_TOKEN_ISSUED",
      "HUMAN_APPROVAL_ACCEPTED",
      "RAZORPAY_ORDER_CREATED",
      "IDEMPOTENT_REPLAY",
      "RESERVATION_RELEASED",
    ]) {
      expect(events, `audit chain is missing a ${expected} block`).toContain(expected);
    }

    // Tamper with one historical block's `details`, leaving its stored hash alone —
    // exactly what editing the log file by hand would produce.
    const targetIndex = Math.floor(ctx.logger.getBlockCount() / 2);
    const target = ctx.logger.getChain()[targetIndex]!;
    const handle = ctx.logger.__tamperBlockForDemo(targetIndex, {
      reason: "rewritten by an attacker to hide a blocked transaction",
    });
    expect(handle).not.toBeNull();

    const afterTamper = ctx.logger.verifyChainIntegrityDetailed();
    expect(afterTamper.valid).toBe(false);
    expect(afterTamper.brokenAtIndex).toBe(targetIndex);
    expect(afterTamper.brokenAtEntryId).toBe(target.entryId);
    expect(afterTamper.reason).toContain("contents were modified");
    expect(ctx.logger.verifyChainIntegrity()).toBe(false);

    // And it verifies again once the original contents are restored.
    handle!.restore();
    expect(ctx.logger.verifyChainIntegrity()).toBe(true);
  });
});

// ===========================================================================
// Cross-cutting invariants
// ===========================================================================

describe("ledger invariants across every scenario", () => {
  it("never leaves reservedAmountInPaisa negative or non-zero after a settled run", async () => {
    for (const scenario of ATTACK_SCENARIOS) {
      const outcome = await scenario.run(ctx);
      expect(
        outcome.policy.reservedAmountInPaisa,
        `${scenario.id} left reserved=${outcome.policy.reservedAmountInPaisa}`,
      ).toBe(0);
      expect(outcome.policy.consumedAmountInPaisa).toBeGreaterThanOrEqual(0);
      expect(
        outcome.policy.consumedAmountInPaisa + outcome.policy.reservedAmountInPaisa,
        `${scenario.id} exceeded its cap`,
      ).toBeLessThanOrEqual(outcome.policy.maxAmountInPaisa);
      expect(outcome.passed, `${scenario.id} did not behave as specified: ${outcome.verdict}`).toBe(
        true,
      );
    }
  });

  it("persists the ledger to disk after every mutation", () => {
    expect(fs.existsSync(STATE_FILE)).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    expect(snapshot.version).toBe(1);
    expect(Object.keys(snapshot.policies).length).toBeGreaterThan(0);
    for (const persisted of Object.values(snapshot.policies) as Array<{
      reservedAmountInPaisa: number;
      consumedAmountInPaisa: number;
    }>) {
      expect(persisted.reservedAmountInPaisa).toBeGreaterThanOrEqual(0);
      expect(persisted.consumedAmountInPaisa).toBeGreaterThanOrEqual(0);
    }
  });
});
