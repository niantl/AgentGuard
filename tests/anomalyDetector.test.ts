import { describe, expect, it } from "vitest";
import { HashChainLogger } from "@/logger/hashChainLogger";
import { detectAnomalies, runAnomalyDetection } from "@/analysis/anomalyDetector";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLogger(): HashChainLogger {
  return new HashChainLogger({ clock: () => new Date() });
}

/**
 * Log a blocked event for a merchant under a specific authorization.
 */
function logBlocked(
  logger: HashChainLogger,
  authorizationId: string,
  merchantId: string,
): void {
  logger.log(authorizationId, "TRANSACTION_BLOCKED", {
    code: "ERR_CUMULATIVE_CAP_EXCEEDED",
    merchantId,
    reason: "test blocked event",
  });
}

// ===========================================================================
// Anomaly detection rules
// ===========================================================================

describe("anomalyDetector", () => {
  it("does not flag when fewer than threshold distinct authorizations are affected", () => {
    const logger = buildLogger();
    // Same merchant blocked under 2 authorizations — below default threshold of 3
    logBlocked(logger, "auth_1", "merchant_evil");
    logBlocked(logger, "auth_2", "merchant_evil");

    const alerts = detectAnomalies(logger.getChain());
    expect(alerts).toHaveLength(0);
  });

  it("flags when threshold is reached across distinct authorizations", () => {
    const logger = buildLogger();
    logBlocked(logger, "auth_1", "merchant_evil");
    logBlocked(logger, "auth_2", "merchant_evil");
    logBlocked(logger, "auth_3", "merchant_evil");

    const alerts = detectAnomalies(logger.getChain());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.merchantId).toBe("merchant_evil");
    expect(alerts[0]!.distinctAuthorizationIds).toHaveLength(3);
  });

  it("does not count the same authorization multiple times", () => {
    const logger = buildLogger();
    // Same auth blocked 5 times — still only 1 distinct authorization
    for (let i = 0; i < 5; i++) {
      logBlocked(logger, "auth_1", "merchant_suspicious");
    }
    logBlocked(logger, "auth_2", "merchant_suspicious");

    const alerts = detectAnomalies(logger.getChain());
    expect(alerts).toHaveLength(0);
  });

  it("supports custom thresholds", () => {
    const logger = buildLogger();
    logBlocked(logger, "auth_1", "merchant_x");
    logBlocked(logger, "auth_2", "merchant_x");

    // With threshold=2, this should flag
    const alerts = detectAnomalies(logger.getChain(), {
      windowMs: 10 * 60 * 1000,
      threshold: 2,
    });
    expect(alerts).toHaveLength(1);
  });

  it("logs ANOMALY_DETECTED to the audit chain via runAnomalyDetection", () => {
    const logger = buildLogger();
    logBlocked(logger, "auth_a", "merchant_bad");
    logBlocked(logger, "auth_b", "merchant_bad");
    logBlocked(logger, "auth_c", "merchant_bad");

    const blocksBefore = logger.getBlockCount();
    const alerts = runAnomalyDetection(logger);

    expect(alerts).toHaveLength(1);
    expect(logger.getBlockCount()).toBe(blocksBefore + 1);

    const chain = logger.getChain();
    const last = chain[chain.length - 1]!;
    expect(last.event).toBe("ANOMALY_DETECTED");
    expect(last.authorizationId).toBe("CROSS_AUTHORIZATION");
    expect(last.details.merchantId).toBe("merchant_bad");
  });

  it("detects multiple merchants independently", () => {
    const logger = buildLogger();
    // Merchant A across 3 authorizations
    logBlocked(logger, "auth_1", "merchant_a");
    logBlocked(logger, "auth_2", "merchant_a");
    logBlocked(logger, "auth_3", "merchant_a");
    // Merchant B across 3 different authorizations
    logBlocked(logger, "auth_4", "merchant_b");
    logBlocked(logger, "auth_5", "merchant_b");
    logBlocked(logger, "auth_6", "merchant_b");

    const alerts = detectAnomalies(logger.getChain());
    expect(alerts).toHaveLength(2);
    const merchantIds = alerts.map((a) => a.merchantId).sort();
    expect(merchantIds).toEqual(["merchant_a", "merchant_b"]);
  });

  it("anomaly detection has zero effect on any processTransaction result", async () => {
    // This test proves the structural boundary: anomaly detection reads audit
    // events and writes ANOMALY_DETECTED entries. It never calls processTransaction
    // and processTransaction never calls it.
    //
    // We verify this by:
    // 1. Importing the anomaly detector module
    // 2. Confirming it has no import from engine/guardrailEngine.ts
    // 3. Running anomaly detection concurrently with a processTransaction call
    //    and asserting the engine result is unaffected.

    const fs = await import("node:fs");
    const anomalySource = fs.readFileSync(
      "analysis/anomalyDetector.ts",
      "utf8",
    );

    // Extract only import lines (not comments or docstrings)
    const importLines = anomalySource
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import "));

    // Structural check: no import from engine
    const importBlock = importLines.join("\n");
    expect(importBlock).not.toContain("guardrailEngine");
    expect(importBlock).not.toContain("processTransaction");

    // Strip comments before checking for code references
    const codeWithoutComments = anomalySource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // Also verify no mutation of policy state anywhere in executable code
    expect(codeWithoutComments).not.toContain("policy.state");
    expect(codeWithoutComments).not.toContain("consumedAmount");
    expect(codeWithoutComments).not.toContain("reservedAmount");
  });

  it("concurrently triggering anomaly rule during processTransaction does not alter transaction outcome", async () => {
    const { GuardrailEngine } = await import("@/engine/guardrailEngine");
    const { SnapshotStore } = await import("@/state/snapshotStore");
    const { createAuthorizationPolicy } = await import("@/policy/policyFactory");
    const { SimulatedRazorpayGateway } = await import("@/payments/razorpayClient");

    const fs = await import("node:fs");
    const stateFile = `.tmp-test/anomaly-concurrent-${Date.now()}.json`;
    try { fs.rmSync(stateFile, { force: true }); } catch {}

    const logger = buildLogger();
    const store = new SnapshotStore({ filePath: stateFile });
    const simulated = new SimulatedRazorpayGateway();
    const gateway = {
      client: simulated,
      mode: "SIMULATED" as const,
      callCount: () => simulated.callCount(),
      description: "test gateway",
    };
    const engine = new GuardrailEngine({ store, logger, gateway });

    // Seed anomaly triggers in logger for merchant_evil
    logBlocked(logger, "auth_other_1", "merchant_evil");
    logBlocked(logger, "auth_other_2", "merchant_evil");
    logBlocked(logger, "auth_other_3", "merchant_evil");

    const policy = createAuthorizationPolicy({
      authorizationId: "auth_active_user",
      userId: "user_active",
      purpose: "Concurrent anomaly isolation test",
      maxAmountInPaisa: 500_000,
      allowedCategories: ["office_supplies"],
      allowedMerchants: ["merchant_legit"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      requiresHumanApprovalAbovePaisa: 500_000,
    });
    store.registerPolicy(policy);

    const proposal = {
      authorizationId: policy.authorizationId,
      itemId: "item_legit",
      merchantId: "merchant_legit",
      category: "office_supplies",
      proposedAmountInPaisa: 50_000,
      clientNonce: `nonce_concurrent_${Date.now()}`,
    };

    const quoteFetcher = async () => {
      // Simulate network latency in quote fetch
      await new Promise((r) => setTimeout(r, 20));
      return {
        itemId: proposal.itemId,
        basePriceInPaisa: 50_000,
        taxInPaisa: 0,
        shippingInPaisa: 0,
        totalQuoteInPaisa: 50_000,
      };
    };

    // Run anomaly detection concurrently with transaction processing
    const [anomalyAlerts, txResult] = await Promise.all([
      (async () => {
        await new Promise((r) => setTimeout(r, 5));
        return runAnomalyDetection(logger);
      })(),
      engine.processTransaction(policy, proposal, quoteFetcher),
    ]);

    // Anomaly detection correctly flagged merchant_evil
    expect(anomalyAlerts).toHaveLength(1);
    expect(anomalyAlerts[0]!.merchantId).toBe("merchant_evil");

    // Concurrent transaction was completely unaffected — succeeded normally
    expect(txResult.success).toBe(true);
    if (txResult.success) {
      expect(txResult.orderId).toBeDefined();
      expect(txResult.amount).toBe(50_000);
    }
    expect(policy.state.consumedAmountInPaisa).toBe(50_000);
    expect(policy.state.reservedAmountInPaisa).toBe(0);
  });
});
