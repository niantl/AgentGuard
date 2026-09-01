import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { GuardrailEngine } from "@/engine/guardrailEngine";
import { HashChainLogger } from "@/logger/hashChainLogger";
import { SnapshotStore } from "@/state/snapshotStore";
import { createAuthorizationPolicy } from "@/policy/policyFactory";
import { SimulatedRazorpayGateway, type GatewayHandle } from "@/payments/razorpayClient";
import { handleApprovalRequest } from "@/api/approve";
import type { AuthorizationPolicy, IntentProposal, MerchantCartQuote, TransactionResult } from "@/types/agentGuard";

const TMP_DIR = path.join(process.cwd(), ".tmp-test");
const STATE_FILE = path.join(TMP_DIR, "fuzz-state.json");

interface FuzzHarness {
  store: SnapshotStore;
  logger: HashChainLogger;
  gateway: GatewayHandle;
  simulated: SimulatedRazorpayGateway;
  engine: GuardrailEngine;
}

class FastFuzzStore extends SnapshotStore {
  override load(): void {
    (this as any).snapshot = {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      idempotencyStore: {},
      rateLimitStore: {},
      reservations: {},
      consumedApprovalTokenSignatures: [],
      policies: {},
    };
    (this as any).consumedTokens = new Set();
  }

  override persist(): void {
    // In-memory persist without synchronous disk write per op,
    // allowing thousands of property fuzz iterations to run in seconds.
    const snap = this.getSnapshot();
    snap.updatedAt = new Date().toISOString();
  }
}

function makeFuzzHarness(stateFile: string): FuzzHarness {
  const store = new FastFuzzStore({ filePath: stateFile });
  const logger = new HashChainLogger();
  const simulated = new SimulatedRazorpayGateway();
  const gateway: GatewayHandle = {
    client: simulated,
    mode: "SIMULATED",
    callCount: () => simulated.callCount(),
    description: "fuzz test gateway",
  };
  const engine = new GuardrailEngine({ store, logger, gateway });
  return { store, logger, gateway, simulated, engine };
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.rmSync(STATE_FILE, { force: true });
});

afterEach(() => {
  fs.rmSync(STATE_FILE, { force: true });
});

describe("invariant fuzzing with fast-check (≥2000 runs)", () => {
  it("never violates ledger budget invariants across arbitrary proposal sequences", { timeout: 60000 }, async () => {
    let runCounter = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          maxAmountInPaisa: fc.integer({ min: 10_000, max: 1_000_000 }),
          thresholdRatio: fc.double({ min: 0.1, max: 1.0, noNaN: true }),
          operations: fc.array(
            fc.record({
              proposedAmount: fc.integer({ min: 500, max: 600_000 }),
              quoteAmount: fc.integer({ min: 500, max: 600_000 }),
              merchantValid: fc.boolean(),
              categoryValid: fc.boolean(),
              clientNonceSuffix: fc.integer({ min: 1, max: 20 }),
              approveEscalation: fc.boolean(),
            }),
            { minLength: 1, maxLength: 8 },
          ),
        }),
        async ({ maxAmountInPaisa, thresholdRatio, operations }) => {
          runCounter++;
          const file = path.join(TMP_DIR, `fuzz-run-${runCounter % 50}.json`);
          const { store, logger, engine } = makeFuzzHarness(file);

          const approvalThreshold = Math.floor(maxAmountInPaisa * thresholdRatio);
          const policy = createAuthorizationPolicy({
            authorizationId: `auth_fuzz_${runCounter}`,
            userId: "user_fuzz",
            purpose: "Fuzz invariant mandate",
            maxAmountInPaisa,
            allowedCategories: ["office_supplies", "electronics"],
            allowedMerchants: ["merchant_officedepot_in", "merchant_techmart_in"],
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            requiresHumanApprovalAbovePaisa: approvalThreshold,
          });
          store.registerPolicy(policy);

          for (const op of operations) {
            const merchantId = op.merchantValid
              ? "merchant_officedepot_in"
              : "merchant_unauthorized_xyz";
            const category = op.categoryValid ? "office_supplies" : "prohibited_cat";

            const proposal: IntentProposal = {
              authorizationId: policy.authorizationId,
              itemId: `item_${op.proposedAmount}`,
              merchantId,
              category,
              proposedAmountInPaisa: op.proposedAmount,
              clientNonce: `nonce_${op.clientNonceSuffix}`,
            };

            const quoteFetcher = async (): Promise<MerchantCartQuote> => ({
              itemId: proposal.itemId,
              basePriceInPaisa: op.quoteAmount,
              taxInPaisa: 0,
              shippingInPaisa: 0,
              totalQuoteInPaisa: op.quoteAmount,
            });

            await engine.processTransaction(policy, proposal, quoteFetcher);

            // Invariant assertions:
            expect(policy.state.consumedAmountInPaisa).toBeGreaterThanOrEqual(0);
            expect(policy.state.reservedAmountInPaisa).toBeGreaterThanOrEqual(0);
            expect(
              policy.state.consumedAmountInPaisa + policy.state.reservedAmountInPaisa,
            ).toBeLessThanOrEqual(policy.constraints.maxAmountInPaisa);

            // Duplicate transaction ID check
            const ids = policy.state.executedTransactionIds;
            const uniqueIds = new Set(ids);
            expect(ids.length).toBe(uniqueIds.size);
          }

          try {
            fs.rmSync(file, { force: true });
          } catch {
            // cleanup
          }

          return true;
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("never violates invariants across concurrent asynchronous randomized proposals", { timeout: 60000 }, async () => {
    let runCounter = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          maxAmountInPaisa: fc.integer({ min: 20_000, max: 1_000_000 }),
          thresholdRatio: fc.double({ min: 0.2, max: 1.0, noNaN: true }),
          operations: fc.array(
            fc.record({
              proposedAmount: fc.integer({ min: 1000, max: 400_000 }),
              quoteAmount: fc.integer({ min: 1000, max: 400_000 }),
              merchantValid: fc.boolean(),
              categoryValid: fc.boolean(),
              clientNonceSuffix: fc.integer({ min: 1, max: 10 }),
              delayMs: fc.integer({ min: 0, max: 5 }),
              approveEscalation: fc.boolean(),
            }),
            { minLength: 2, maxLength: 6 },
          ),
        }),
        async ({ maxAmountInPaisa, thresholdRatio, operations }) => {
          runCounter++;
          const file = path.join(TMP_DIR, `fuzz-async-${runCounter % 50}.json`);
          const { store, logger, engine, simulated } = makeFuzzHarness(file);

          const approvalThreshold = Math.floor(maxAmountInPaisa * thresholdRatio);
          const policy = createAuthorizationPolicy({
            authorizationId: `auth_fuzz_async_${runCounter}`,
            userId: "user_fuzz_async",
            purpose: "Async Fuzz invariant mandate",
            maxAmountInPaisa,
            allowedCategories: ["office_supplies", "electronics"],
            allowedMerchants: ["merchant_officedepot_in", "merchant_techmart_in"],
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            requiresHumanApprovalAbovePaisa: approvalThreshold,
          });
          store.registerPolicy(policy);

          // Dispatch all operations concurrently with random latency
          const promises = operations.map(async (op) => {
            const merchantId = op.merchantValid
              ? "merchant_officedepot_in"
              : "merchant_unauthorized_xyz";
            const category = op.categoryValid ? "office_supplies" : "prohibited_cat";

            const proposal: IntentProposal = {
              authorizationId: policy.authorizationId,
              itemId: `item_${op.proposedAmount}`,
              merchantId,
              category,
              proposedAmountInPaisa: op.proposedAmount,
              clientNonce: `nonce_${op.clientNonceSuffix}`,
            };

            const quoteFetcher = async (): Promise<MerchantCartQuote> => {
              if (op.delayMs > 0) {
                await new Promise((r) => setTimeout(r, op.delayMs));
              }
              return {
                itemId: proposal.itemId,
                basePriceInPaisa: op.quoteAmount,
                taxInPaisa: 0,
                shippingInPaisa: 0,
                totalQuoteInPaisa: op.quoteAmount,
              };
            };

            const result = await engine.processTransaction(policy, proposal, quoteFetcher);

            if (result.success === false && result.code === "PENDING_HUMAN_APPROVAL" && op.approveEscalation) {
              const approval = await handleApprovalRequest(
                {
                  authorizationId: policy.authorizationId,
                  idempotencyKey: result.idempotencyKey,
                  approverId: "approver_fuzz",
                  decision: "approve",
                },
                {
                  store,
                  logger,
                  resolvePolicy: () => policy,
                },
              );

              if (approval.ok && approval.decision === "approve") {
                await engine.processTransaction(
                  policy,
                  { ...proposal, humanApprovalToken: approval.encodedToken },
                  quoteFetcher,
                );
              }
            }

            return result;
          });

          await Promise.all(promises);

          // Post-run invariant assertions:
          expect(policy.state.consumedAmountInPaisa).toBeGreaterThanOrEqual(0);
          expect(policy.state.reservedAmountInPaisa).toBeGreaterThanOrEqual(0);
          expect(
            policy.state.consumedAmountInPaisa + policy.state.reservedAmountInPaisa,
          ).toBeLessThanOrEqual(policy.constraints.maxAmountInPaisa);

          const ids = policy.state.executedTransactionIds;
          const uniqueIds = new Set(ids);
          expect(ids.length).toBe(uniqueIds.size);

          try {
            fs.rmSync(file, { force: true });
          } catch {
            // cleanup
          }

          return true;
        },
      ),
      { numRuns: 2000 },
    );
  });
});
