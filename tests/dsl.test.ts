import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { compilePolicyDsl } from "@/policy/dsl";
import {
  createAuthorizationPolicy,
  PolicyValidationError,
  verifyPolicySignature,
} from "@/policy/policyFactory";

// ===========================================================================
// Valid YAML compilation
// ===========================================================================

const VALID_YAML = `
authorizationId: auth_dsl_test_001
userId: user_123
purpose: "Office supplies procurement"
budget:
  maxAmountInPaisa: 500000
  currency: INR
  expiresAt: "2027-12-31T23:59:59Z"
categories:
  - office_supplies
  - software_licenses
merchants:
  - amazon_business
  - staples_api
escalation:
  requiresHumanApprovalAbovePaisa: 300000
`;

describe("compilePolicyDsl — valid inputs", () => {
  it("compiles a valid YAML into an AuthorizationPolicy", () => {
    const policy = compilePolicyDsl(VALID_YAML);
    expect(policy.authorizationId).toBe("auth_dsl_test_001");
    expect(policy.userId).toBe("user_123");
    expect(policy.purpose).toBe("Office supplies procurement");
    expect(policy.constraints.maxAmountInPaisa).toBe(500000);
    expect(policy.constraints.currency).toBe("INR");
    expect(policy.constraints.allowedCategories).toEqual(["office_supplies", "software_licenses"]);
    expect(policy.constraints.allowedMerchants).toEqual(["amazon_business", "staples_api"]);
    expect(policy.constraints.requiresHumanApprovalAbovePaisa).toBe(300000);
  });

  it("the compiled policy has a valid HMAC signature", () => {
    const policy = compilePolicyDsl(VALID_YAML);
    expect(verifyPolicySignature(policy)).toBe(true);
  });

  it("produces the same shape as a hand-built policy", () => {
    const dslPolicy = compilePolicyDsl(VALID_YAML);
    const handBuilt = createAuthorizationPolicy({
      authorizationId: "auth_hand_built",
      userId: "user_123",
      purpose: "Office supplies procurement",
      maxAmountInPaisa: 500000,
      allowedCategories: ["office_supplies", "software_licenses"],
      allowedMerchants: ["amazon_business", "staples_api"],
      expiresAt: "2027-12-31T23:59:59Z",
      requiresHumanApprovalAbovePaisa: 300000,
    });

    // Same structural shape — fields match (except authorizationId and security nonce)
    expect(dslPolicy.userId).toBe(handBuilt.userId);
    expect(dslPolicy.constraints.maxAmountInPaisa).toBe(handBuilt.constraints.maxAmountInPaisa);
    expect(dslPolicy.constraints.currency).toBe(handBuilt.constraints.currency);
    expect(dslPolicy.constraints.allowedCategories).toEqual(handBuilt.constraints.allowedCategories);
    expect(dslPolicy.constraints.allowedMerchants).toEqual(handBuilt.constraints.allowedMerchants);
    expect(dslPolicy.constraints.requiresHumanApprovalAbovePaisa).toBe(
      handBuilt.constraints.requiresHumanApprovalAbovePaisa,
    );
    expect(dslPolicy.state.status).toBe("ACTIVE");
    expect(dslPolicy.state.consumedAmountInPaisa).toBe(0);
    expect(dslPolicy.state.reservedAmountInPaisa).toBe(0);
  });

  it("defaults requiresHumanApprovalAbovePaisa to maxAmountInPaisa when escalation is omitted", () => {
    const yaml = `
authorizationId: auth_no_escalation
userId: user_456
purpose: No escalation
budget:
  maxAmountInPaisa: 100000
  currency: INR
  expiresAt: "2027-06-01T00:00:00Z"
categories: [office_supplies]
merchants: [merchant_a]
`;
    const policy = compilePolicyDsl(yaml);
    expect(policy.constraints.requiresHumanApprovalAbovePaisa).toBe(100000);
  });
});

// ===========================================================================
// Rejection parity — same rejections as the hand-built path
// ===========================================================================

describe("compilePolicyDsl — rejections match hand-built path", () => {
  it("rejects unreachable escalation (same check as createAuthorizationPolicy)", () => {
    const yaml = `
authorizationId: auth_bad_escalation
userId: user_test
purpose: Bad escalation
budget:
  maxAmountInPaisa: 100000
  currency: INR
  expiresAt: "2027-01-01T00:00:00Z"
categories: [cat]
merchants: [merch]
escalation:
  requiresHumanApprovalAbovePaisa: 200000
`;
    expect(() => compilePolicyDsl(yaml)).toThrow(PolicyValidationError);
    try {
      compilePolicyDsl(yaml);
      expect.fail("Should have thrown");
    } catch (e) {
      expect((e as PolicyValidationError).code).toBe("ERR_POLICY_UNREACHABLE_ESCALATION");
    }

    // Same rejection from hand-built path
    try {
      createAuthorizationPolicy({
        userId: "user_test",
        purpose: "Bad escalation",
        maxAmountInPaisa: 100000,
        allowedCategories: ["cat"],
        allowedMerchants: ["merch"],
        expiresAt: "2027-01-01T00:00:00Z",
        requiresHumanApprovalAbovePaisa: 200000,
      });
      expect.fail("Should have thrown");
    } catch (e) {
      expect((e as PolicyValidationError).code).toBe("ERR_POLICY_UNREACHABLE_ESCALATION");
    }
  });

  it("rejects missing userId via schema", () => {
    const yaml = `
authorizationId: auth_no_user
purpose: Missing user
budget:
  maxAmountInPaisa: 100000
  currency: INR
  expiresAt: "2027-01-01T00:00:00Z"
categories: [cat]
merchants: [merch]
`;
    expect(() => compilePolicyDsl(yaml)).toThrow(PolicyValidationError);
  });

  it("rejects empty categories via schema", () => {
    const yaml = `
authorizationId: auth_empty_cats
userId: user_test
purpose: Empty categories
budget:
  maxAmountInPaisa: 100000
  currency: INR
  expiresAt: "2027-01-01T00:00:00Z"
categories: []
merchants: [merch]
`;
    expect(() => compilePolicyDsl(yaml)).toThrow(PolicyValidationError);
  });

  it("rejects non-integer maxAmountInPaisa via schema", () => {
    const yaml = `
authorizationId: auth_float
userId: user_test
purpose: Float cap
budget:
  maxAmountInPaisa: 99.5
  currency: INR
  expiresAt: "2027-01-01T00:00:00Z"
categories: [cat]
merchants: [merch]
`;
    expect(() => compilePolicyDsl(yaml)).toThrow(PolicyValidationError);
  });

  it("rejects invalid YAML syntax", () => {
    expect(() => compilePolicyDsl("{{{{invalid yaml")).toThrow(PolicyValidationError);
    try {
      compilePolicyDsl("{{{{invalid yaml");
      expect.fail("Should have thrown");
    } catch (e) {
      expect((e as PolicyValidationError).code).toBe("ERR_DSL_YAML_PARSE");
    }
  });

  it("rejects additional properties not in the schema", () => {
    const yaml = `
authorizationId: auth_extra
userId: user_test
purpose: Extra field
budget:
  maxAmountInPaisa: 100000
  currency: INR
  expiresAt: "2027-01-01T00:00:00Z"
categories: [cat]
merchants: [merch]
extraField: should_not_be_here
`;
    expect(() => compilePolicyDsl(yaml)).toThrow(PolicyValidationError);
    try {
      compilePolicyDsl(yaml);
      expect.fail("Should have thrown");
    } catch (e) {
      expect((e as PolicyValidationError).code).toBe("ERR_DSL_SCHEMA_VIOLATION");
    }
  });
});

// ===========================================================================
// Structural constraint — no LLM imports
// ===========================================================================

describe("compilePolicyDsl — structural constraints", () => {
  it("dsl.ts has zero imports of any LLM/model client", () => {
    const source = fs.readFileSync("policy/dsl.ts", "utf8");
    // Check import lines only — not comments or variable names like "allErrors"
    const importLines = source
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import "))
      .join("\n")
      .toLowerCase();
    const modelPatterns = [
      "openai",
      "anthropic",
      "langchain",
      "llm",
      "chatcompletion",
      "generativemodel",
      "@google-ai",
      "bedrock",
    ];
    for (const pattern of modelPatterns) {
      expect(importLines).not.toContain(pattern);
    }
  });

  it("calls the shared validateEscalationReachability function", () => {
    const source = fs.readFileSync("policy/dsl.ts", "utf8");
    expect(source).toContain("validateEscalationReachability");
    // Verify it's imported from policyFactory
    expect(source).toContain("from \"@/policy/policyFactory\"");
  });
});
