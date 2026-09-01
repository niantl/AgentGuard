import { describe, expect, it } from "vitest";
import { explainDenial, type DenialContext } from "@/engine/denialExplanations";

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Extract all paisa values from a denial explanation string.
 * Matches patterns like "42000 paisa" in the formatted output.
 */
function extractPaisaValues(text: string): number[] {
  const matches = text.match(/(\d+) paisa/g);
  if (!matches) return [];
  return matches.map((m) => parseInt(m.replace(" paisa", ""), 10));
}

/**
 * Extract rupee values like "₹420.00" from the formatted output.
 */
function extractRupeeValues(text: string): number[] {
  const matches = text.match(/₹([\d.]+)/g);
  if (!matches) return [];
  return matches.map((m) => parseFloat(m.replace("₹", "")));
}

// ===========================================================================
// Template correctness
// ===========================================================================

describe("explainDenial", () => {
  it("ERR_CUMULATIVE_CAP_EXCEEDED — embedded numbers match actual decision variables", () => {
    const context: DenialContext = {
      code: "ERR_CUMULATIVE_CAP_EXCEEDED",
      consumedAmountInPaisa: 300_000,
      reservedAmountInPaisa: 150_000,
      quoteAmountInPaisa: 100_000,
      projectedExposureInPaisa: 550_000,
      capInPaisa: 500_000,
    };

    const explanation = explainDenial(context);
    const paisaValues = extractPaisaValues(explanation);

    expect(paisaValues).toContain(300_000); // consumed
    expect(paisaValues).toContain(150_000); // reserved
    expect(paisaValues).toContain(100_000); // quote
    expect(paisaValues).toContain(550_000); // projected
    expect(paisaValues).toContain(500_000); // cap
    expect(explanation).toContain("Blocked");
  });

  it("ERR_PRICE_SLIPPAGE_EXCEEDS_CAP — embedded numbers match", () => {
    const context: DenialContext = {
      code: "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP",
      quoteAmountInPaisa: 800_000,
      proposedAmountInPaisa: 750_000,
      slippageInPaisa: 50_000,
      capInPaisa: 500_000,
    };

    const explanation = explainDenial(context);
    const paisaValues = extractPaisaValues(explanation);

    expect(paisaValues).toContain(800_000); // quote
    expect(paisaValues).toContain(750_000); // proposed
    expect(paisaValues).toContain(50_000); // slippage
    expect(paisaValues).toContain(500_000); // cap
  });

  it("ERR_AGENT_LOOP_DETECTED — count and window match", () => {
    const context: DenialContext = {
      code: "ERR_AGENT_LOOP_DETECTED",
      proposalCount: 6,
      maxProposals: 5,
      windowMinutes: 10,
    };

    const explanation = explainDenial(context);
    expect(explanation).toContain("6");
    expect(explanation).toContain("10");
    expect(explanation).toContain("5");
  });

  it("ERR_POLICY_NOT_ACTIVE — status matches", () => {
    const context: DenialContext = {
      code: "ERR_POLICY_NOT_ACTIVE",
      status: "EXHAUSTED",
    };

    const explanation = explainDenial(context);
    expect(explanation).toContain("EXHAUSTED");
  });

  it("ERR_AUTHORIZATION_EXPIRED — expiry matches", () => {
    const context: DenialContext = {
      code: "ERR_AUTHORIZATION_EXPIRED",
      expiresAt: "2026-01-15T12:00:00Z",
    };

    const explanation = explainDenial(context);
    expect(explanation).toContain("2026-01-15T12:00:00Z");
  });

  it("ERR_CATEGORY_NOT_ALLOWED — category and allowlist match", () => {
    const context: DenialContext = {
      code: "ERR_CATEGORY_NOT_ALLOWED",
      category: "travel",
      allowedCategories: ["office_supplies", "electronics"],
    };

    const explanation = explainDenial(context);
    expect(explanation).toContain("travel");
    expect(explanation).toContain("office_supplies");
    expect(explanation).toContain("electronics");
  });

  it("ERR_MERCHANT_NOT_ALLOWED — merchant and allowlist match", () => {
    const context: DenialContext = {
      code: "ERR_MERCHANT_NOT_ALLOWED",
      merchantId: "merchant_shady",
      allowedMerchants: ["merchant_a", "merchant_b"],
    };

    const explanation = explainDenial(context);
    expect(explanation).toContain("merchant_shady");
    expect(explanation).toContain("merchant_a");
    expect(explanation).toContain("merchant_b");
  });

  it("ERR_INVALID_APPROVAL_TOKEN — rejection reason matches", () => {
    const context: DenialContext = {
      code: "ERR_INVALID_APPROVAL_TOKEN",
      tokenRejectionReason: "EXPIRED",
      tokenRejectionDetail: "Token expired at 2026-01-01T00:00:00Z",
    };

    const explanation = explainDenial(context);
    expect(explanation).toContain("EXPIRED");
    expect(explanation).toContain("Token expired at 2026-01-01T00:00:00Z");
  });

  it("PENDING_HUMAN_APPROVAL — quote and threshold match", () => {
    const context: DenialContext = {
      code: "PENDING_HUMAN_APPROVAL",
      quoteAmountInPaisa: 600_000,
      requiresHumanApprovalAbovePaisa: 500_000,
    };

    const explanation = explainDenial(context);
    const paisaValues = extractPaisaValues(explanation);
    expect(paisaValues).toContain(600_000);
    expect(paisaValues).toContain(500_000);
    expect(explanation).toContain("Escalated");
  });

  it("ERR_CONCURRENT_MUTATION — deterministic message", () => {
    const explanation = explainDenial({ code: "ERR_CONCURRENT_MUTATION" });
    expect(explanation).toContain("concurrent");
  });

  it("ERR_RAZORPAY_GATEWAY — deterministic message", () => {
    const explanation = explainDenial({ code: "ERR_RAZORPAY_GATEWAY" });
    expect(explanation).toContain("gateway");
    expect(explanation).toContain("No amount was committed");
  });

  it("ERR_QUOTE_FETCH_TIMEOUT — deterministic message", () => {
    const explanation = explainDenial({ code: "ERR_QUOTE_FETCH_TIMEOUT" });
    expect(explanation).toContain("quote service timed out");
    expect(explanation).toContain("Nothing was reserved");
  });

  it("ERR_QUOTE_FETCH_FAILED — deterministic message", () => {
    const explanation = explainDenial({ code: "ERR_QUOTE_FETCH_FAILED" });
    expect(explanation).toContain("quote service error");
    expect(explanation).toContain("Nothing was reserved");
  });
});

// ===========================================================================
// Exhaustive coverage
// ===========================================================================

describe("explainDenial — coverage", () => {
  it("produces a non-empty string for every known error code", () => {
    const codes: DenialContext["code"][] = [
      "ERR_CONCURRENT_MUTATION",
      "ERR_AGENT_LOOP_DETECTED",
      "ERR_POLICY_NOT_ACTIVE",
      "ERR_AUTHORIZATION_EXPIRED",
      "ERR_CATEGORY_NOT_ALLOWED",
      "ERR_MERCHANT_NOT_ALLOWED",
      "ERR_PRICE_SLIPPAGE_EXCEEDS_CAP",
      "ERR_CUMULATIVE_CAP_EXCEEDED",
      "PENDING_HUMAN_APPROVAL",
      "ERR_INVALID_APPROVAL_TOKEN",
      "ERR_QUOTE_FETCH_TIMEOUT",
      "ERR_QUOTE_FETCH_FAILED",
      "ERR_RAZORPAY_GATEWAY",
      "ERR_INTERNAL_INVARIANT",
    ];

    for (const code of codes) {
      const explanation = explainDenial({ code });
      expect(explanation.length, `empty explanation for ${code}`).toBeGreaterThan(0);
    }
  });
});
