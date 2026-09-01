import { describe, expect, it } from "vitest";
import {
  EnvSecretProvider,
  KmsSecretProvider,
  createSecretProvider,
} from "@/security/secretProvider";

// ===========================================================================
// EnvSecretProvider (default path)
// ===========================================================================

describe("EnvSecretProvider", () => {
  it("returns a Buffer from the environment variable", async () => {
    const provider = new EnvSecretProvider();
    const secret = await provider.getHmacSecret();
    expect(Buffer.isBuffer(secret)).toBe(true);
    expect(secret.length).toBeGreaterThan(0);
  });

  it("returns the dev fallback when no env var is set", async () => {
    const original = process.env.AGENTGUARD_SERVER_SECRET;
    try {
      delete process.env.AGENTGUARD_SERVER_SECRET;
      const provider = new EnvSecretProvider();
      const secret = await provider.getHmacSecret();
      expect(secret.toString("utf8")).toContain("dev-only");
    } finally {
      if (original !== undefined) process.env.AGENTGUARD_SERVER_SECRET = original;
    }
  });
});

// ===========================================================================
// KmsSecretProvider (fail-closed behavior)
// ===========================================================================

describe("KmsSecretProvider", () => {
  it("throws on KMS failure — does NOT silently fall back to env var", async () => {
    const provider = new KmsSecretProvider({
      keyId: "arn:aws:kms:ap-south-1:123456:key/test-key",
      region: "ap-south-1",
      timeoutMs: 100,
    });

    await expect(provider.getHmacSecret()).rejects.toThrow(
      /KMS secret provider failed/,
    );
  });

  it("the error message explicitly says not to fall back", async () => {
    const provider = new KmsSecretProvider({
      keyId: "test-key",
      region: "ap-south-1",
      timeoutMs: 100,
    });

    try {
      await provider.getHmacSecret();
      expect.fail("Should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("will NOT start");
      expect(message).toContain("Do not silently fall back");
    }
  });

  it("caches the secret after a successful fetch", async () => {
    // Subclass to simulate a successful KMS call
    class MockKms extends KmsSecretProvider {
      callCount = 0;
      protected async fetchFromKms(): Promise<Buffer> {
        this.callCount++;
        return Buffer.from("kms-derived-secret-key-material-32b", "utf8");
      }
    }

    const provider = new MockKms({ keyId: "test", region: "us-east-1" });
    const secret1 = await provider.getHmacSecret();
    const secret2 = await provider.getHmacSecret();

    expect(secret1).toEqual(secret2);
    expect(provider.callCount).toBe(1); // Only one KMS call, cached after
  });

  it("times out on a slow KMS call", async () => {
    class SlowKms extends KmsSecretProvider {
      protected async fetchFromKms(): Promise<Buffer> {
        // Simulate a KMS call that takes too long
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return Buffer.from("should-not-reach", "utf8");
      }
    }

    const provider = new SlowKms({
      keyId: "test",
      region: "us-east-1",
      timeoutMs: 50,
    });

    await expect(provider.getHmacSecret()).rejects.toThrow(/timed out/);
  });
});

// ===========================================================================
// Factory
// ===========================================================================

describe("createSecretProvider", () => {
  it("returns EnvSecretProvider when no KMS key is configured", () => {
    const original = process.env.AGENTGUARD_KMS_KEY_ID;
    try {
      delete process.env.AGENTGUARD_KMS_KEY_ID;
      const provider = createSecretProvider();
      expect(provider).toBeInstanceOf(EnvSecretProvider);
    } finally {
      if (original !== undefined) process.env.AGENTGUARD_KMS_KEY_ID = original;
    }
  });

  it("returns KmsSecretProvider when KMS key is configured", () => {
    const original = process.env.AGENTGUARD_KMS_KEY_ID;
    try {
      process.env.AGENTGUARD_KMS_KEY_ID = "arn:aws:kms:ap-south-1:123:key/test";
      const provider = createSecretProvider();
      expect(provider).toBeInstanceOf(KmsSecretProvider);
    } finally {
      if (original !== undefined) {
        process.env.AGENTGUARD_KMS_KEY_ID = original;
      } else {
        delete process.env.AGENTGUARD_KMS_KEY_ID;
      }
    }
  });
});

// ===========================================================================
// Production Fail-Closed Validation
// ===========================================================================

import { getServerSecret } from "@/security/crypto";
import { GuardrailEngine } from "@/engine/guardrailEngine";
import { SnapshotStore } from "@/state/snapshotStore";
import { HashChainLogger } from "@/logger/hashChainLogger";
import { SimulatedRazorpayGateway, type GatewayHandle } from "@/payments/razorpayClient";
import { createAuthorizationPolicy } from "@/policy/policyFactory";
import type { SecretProvider } from "@/security/secretProvider";

describe("Production fail-closed secret validation", () => {
  it("getServerSecret throws in production if AGENTGUARD_SERVER_SECRET is missing or placeholder", () => {
    const origEnv = process.env.NODE_ENV;
    const origAgentEnv = process.env.AGENTGUARD_ENV;
    const origSecret = process.env.AGENTGUARD_SERVER_SECRET;
    try {
      (process.env as any).NODE_ENV = "production";
      delete process.env.AGENTGUARD_SERVER_SECRET;
      expect(() => getServerSecret()).toThrow(/Refusing to use dev fallback secret/);

      process.env.AGENTGUARD_SERVER_SECRET = "replace-with-a-long-random-string";
      expect(() => getServerSecret()).toThrow(/Refusing to use dev fallback secret/);

      process.env.AGENTGUARD_SERVER_SECRET = "too-short";
      expect(() => getServerSecret()).toThrow(/Refusing to use dev fallback secret/);

      process.env.AGENTGUARD_SERVER_SECRET = "a-secure-production-secret-at-least-16-chars";
      expect(getServerSecret()).toBe("a-secure-production-secret-at-least-16-chars");

      // Also test with AGENTGUARD_ENV="production"
      (process.env as any).NODE_ENV = "test";
      process.env.AGENTGUARD_ENV = "production";
      delete process.env.AGENTGUARD_SERVER_SECRET;
      expect(() => getServerSecret()).toThrow(/Refusing to use dev fallback secret/);
    } finally {
      (process.env as any).NODE_ENV = origEnv;
      if (origAgentEnv !== undefined) {
        process.env.AGENTGUARD_ENV = origAgentEnv;
      } else {
        delete process.env.AGENTGUARD_ENV;
      }
      if (origSecret !== undefined) {
        process.env.AGENTGUARD_SERVER_SECRET = origSecret;
      } else {
        delete process.env.AGENTGUARD_SERVER_SECRET;
      }
    }
  });

  it("EnvSecretProvider throws in production if AGENTGUARD_SERVER_SECRET is missing", async () => {
    const origEnv = process.env.NODE_ENV;
    const origSecret = process.env.AGENTGUARD_SERVER_SECRET;
    try {
      (process.env as any).NODE_ENV = "production";
      delete process.env.AGENTGUARD_SERVER_SECRET;
      const provider = new EnvSecretProvider();
      await expect(provider.getHmacSecret()).rejects.toThrow(/Refusing to use dev fallback secret/);
    } finally {
      (process.env as any).NODE_ENV = origEnv;
      if (origSecret !== undefined) {
        process.env.AGENTGUARD_SERVER_SECRET = origSecret;
      } else {
        delete process.env.AGENTGUARD_SERVER_SECRET;
      }
    }
  });

  it("GuardrailEngine signs execution payload using the injected SecretProvider", async () => {
    const customSecret = "custom-injected-secret-material-123456";
    const mockProvider: SecretProvider = {
      getHmacSecret: async () => Buffer.from(customSecret, "utf8"),
    };

    let capturedSignature: string | undefined;
    const simulated = new SimulatedRazorpayGateway();
    const origCreate = simulated.orders.create.bind(simulated.orders);
    simulated.orders.create = async (params: any) => {
      capturedSignature = params.notes?.agentguard_execution_signature;
      return origCreate(params);
    };

    const gateway: GatewayHandle = {
      client: simulated,
      mode: "SIMULATED",
      callCount: () => simulated.callCount(),
      description: "secret test gateway",
    };

    const store = new SnapshotStore();
    store.reset();
    const logger = new HashChainLogger();
    const engine = new GuardrailEngine({ store, logger, gateway, secretProvider: mockProvider });

    const authId = `auth_custom_secret_${Date.now()}`;
    const policy = createAuthorizationPolicy({
      authorizationId: authId,
      userId: "user_secret_test",
      purpose: "Secret provider injection test",
      maxAmountInPaisa: 100_000,
      allowedCategories: ["office_supplies"],
      allowedMerchants: ["merchant_a"],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      requiresHumanApprovalAbovePaisa: 100_000,
    });
    store.registerPolicy(policy);

    const proposal = {
      authorizationId: policy.authorizationId,
      itemId: "item_paper",
      merchantId: "merchant_a",
      category: "office_supplies",
      proposedAmountInPaisa: 50_000,
      clientNonce: `nonce_sec_${Date.now()}`,
    };

    const quoteFetcher = async () => ({
      itemId: proposal.itemId,
      basePriceInPaisa: 50_000,
      taxInPaisa: 0,
      shippingInPaisa: 0,
      totalQuoteInPaisa: 50_000,
    });

    const result = await engine.processTransaction(policy, proposal, quoteFetcher);
    expect(result.success).toBe(true);
    expect(capturedSignature).toBeDefined();

    // Verify signature was generated using customSecret
    const { canonicalJson, hmacHex } = await import("@/security/crypto");
    const reservedBlock = logger
      .getChain()
      .find((b) => b.event === "BUDGET_RESERVED");
    const reservationId = reservedBlock?.details.reservationId;
    expect(reservationId).toBeDefined();

    // Recompute expected signature with customSecret
    const expectedPayload = canonicalJson({
      authorizationId: policy.authorizationId,
      idempotencyKey: result.idempotencyKey,
      reservationId,
      itemId: proposal.itemId,
      merchantId: proposal.merchantId,
      category: proposal.category,
      amountInPaisa: 50_000,
      currency: "INR",
    });
    const expectedSignature = hmacHex(expectedPayload, customSecret);
    expect(capturedSignature).toBe(expectedSignature);

    // And verify it does NOT match dev fallback secret
    const devFallbackSignature = hmacHex(expectedPayload);
    expect(capturedSignature).not.toBe(devFallbackSignature);
  });
});
