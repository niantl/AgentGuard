import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { runMigrations, truncateAll } from "@/db/migrate";
import { PgStore } from "@/state/pgStore";
import { GuardrailEngine } from "@/engine/guardrailEngine";
import { HashChainLogger } from "@/logger/hashChainLogger";
import { createAuthorizationPolicy } from "@/policy/policyFactory";
import { SimulatedRazorpayGateway, type GatewayHandle } from "@/payments/razorpayClient";
import type { AuthorizationPolicy, IntentProposal, MerchantCartQuote } from "@/types/agentGuard";

const PG_PORT = 5435;
const DB_DIR = path.join(process.cwd(), ".tmp-test", "pg-test-data");
const CONNECTION_STRING = `postgres://agentguard:agentguard@127.0.0.1:${PG_PORT}/agentguard`;

describe("PgStore — Postgres-backed state store with row-level locking", () => {
  let embeddedPg: EmbeddedPostgres;
  let pool: Pool;
  let pgStore: PgStore;

  beforeAll(async () => {
    embeddedPg = new EmbeddedPostgres({
      port: PG_PORT,
      databaseDir: DB_DIR,
      user: "agentguard",
      password: "agentguard",
    });

    try {
      await embeddedPg.initialise();
    } catch {
      // already initialized
    }
    await embeddedPg.start();

    // Connect to the default 'postgres' database with agentguard credentials to create the 'agentguard' database
    const adminPool = new Pool({
      connectionString: `postgres://agentguard:agentguard@127.0.0.1:${PG_PORT}/postgres`,
    });
    try {
      await adminPool.query("CREATE DATABASE agentguard");
    } catch {
      // already created
    }
    await adminPool.end();

    // Now connect to the dedicated agentguard database
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      max: 10,
      connectionTimeoutMillis: 5000,
    });

    // Run real migrations (001_init.sql and 002_engine_contract.sql)
    await runMigrations(pool);
    pgStore = new PgStore({ pool });
  }, 45000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (embeddedPg) await embeddedPg.stop();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  it("checks out independent pg connections and serializes racing reserveAtomically calls on FOR UPDATE lock", async () => {
    const policy = createAuthorizationPolicy({
      authorizationId: "auth_pg_race_001",
      userId: "user_pg_race",
      purpose: "Postgres row-lock contention test",
      maxAmountInPaisa: 500_000, // ₹5,000 cap
      allowedCategories: ["office_supplies"],
      allowedMerchants: ["merchant_a"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      requiresHumanApprovalAbovePaisa: 500_000,
    });

    // Save policy state to Postgres
    await pgStore.savePolicyStateAsync(policy);

    // Verify row was inserted into authorization_policies in PostgreSQL
    const { rows: initialRows } = await pool.query(
      "SELECT consumed_amount_in_paisa, reserved_amount_in_paisa, max_amount_in_paisa FROM authorization_policies WHERE authorization_id = $1",
      [policy.authorizationId],
    );
    expect(initialRows).toHaveLength(1);
    expect(Number(initialRows[0]!.consumed_amount_in_paisa)).toBe(0);
    expect(Number(initialRows[0]!.reserved_amount_in_paisa)).toBe(0);
    expect(Number(initialRows[0]!.max_amount_in_paisa)).toBe(500_000);

    // Two independent transactions each requesting 300,000 paisa (combined 600k > 500k cap)
    // Fired concurrently across genuinely separate connections in pool
    const now = Date.now();
    const [resultA, resultB] = await Promise.all([
      pgStore.reserveAtomically({
        authorizationId: policy.authorizationId,
        idempotencyKey: `idemp_pg_a_${now}`,
        quoteTotal: 300_000,
        maxAmount: 500_000,
        isEscalation: false,
        nowMs: now,
        ttlMs: 60_000,
      }),
      pgStore.reserveAtomically({
        authorizationId: policy.authorizationId,
        idempotencyKey: `idemp_pg_b_${now}`,
        quoteTotal: 300_000,
        maxAmount: 500_000,
        isEscalation: false,
        nowMs: now,
        ttlMs: 60_000,
      }),
    ]);

    // Exactly one must succeed, and exactly one must fail with cap exceeded
    const successes = [resultA, resultB].filter((r) => r.ok);
    const failures = [resultA, resultB].filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.code).toBe("ERR_CUMULATIVE_CAP_EXCEEDED");

    // Query raw Postgres table directly to verify DB-level state
    const { rows: postRows } = await pool.query(
      "SELECT consumed_amount_in_paisa, reserved_amount_in_paisa FROM authorization_policies WHERE authorization_id = $1",
      [policy.authorizationId],
    );
    expect(Number(postRows[0]!.consumed_amount_in_paisa)).toBe(0);
    expect(Number(postRows[0]!.reserved_amount_in_paisa)).toBe(300_000); // exactly 300k, not 600k

    // Query reservations table in Postgres
    const { rows: resRows } = await pool.query(
      "SELECT reservation_id, amount_in_paisa FROM reservations WHERE authorization_id = $1",
      [policy.authorizationId],
    );
    expect(resRows).toHaveLength(1);
    expect(Number(resRows[0]!.amount_in_paisa)).toBe(300_000);
  });

  it("database-level CHECK constraint blocks direct out-of-cap mutations as a hard backstop", async () => {
    const policy = createAuthorizationPolicy({
      authorizationId: "auth_check_constraint_test",
      userId: "user_check",
      purpose: "CHECK constraint test",
      maxAmountInPaisa: 100_000, // ₹1,000 cap
      allowedCategories: ["office_supplies"],
      allowedMerchants: ["merchant_a"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      requiresHumanApprovalAbovePaisa: 100_000,
    });

    await pgStore.savePolicyStateAsync(policy);

    // Attempt an illegal raw SQL update bypassing application logic
    let threw = false;
    try {
      await pool.query(
        "UPDATE authorization_policies SET reserved_amount_in_paisa = 200000 WHERE authorization_id = $1",
        [policy.authorizationId],
      );
    } catch (error: any) {
      threw = true;
      expect(error.message).toContain("authorization_policies_ledger_within_cap");
    }
    expect(threw).toBe(true);
  });

  it("GuardrailEngine with PgStore processes transactions end-to-end against real PostgreSQL", async () => {
    const logger = new HashChainLogger();
    const simulated = new SimulatedRazorpayGateway();
    const gateway: GatewayHandle = {
      client: simulated,
      mode: "SIMULATED",
      callCount: () => simulated.callCount(),
      description: "pg test gateway",
    };

    const engine = new GuardrailEngine({ store: pgStore, logger, gateway });

    const policy = createAuthorizationPolicy({
      authorizationId: "auth_pg_engine_test",
      userId: "user_pg_engine",
      purpose: "PG Engine test",
      maxAmountInPaisa: 500_000,
      allowedCategories: ["office_supplies"],
      allowedMerchants: ["merchant_officedepot_in"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      requiresHumanApprovalAbovePaisa: 500_000,
    });
    await pgStore.savePolicyStateAsync(policy);

    const proposal: IntentProposal = {
      authorizationId: policy.authorizationId,
      itemId: "item_paper",
      merchantId: "merchant_officedepot_in",
      category: "office_supplies",
      proposedAmountInPaisa: 50_000,
      clientNonce: `nonce_pg_${Date.now()}`,
    };

    const quoteFetcher = async (): Promise<MerchantCartQuote> => ({
      itemId: proposal.itemId,
      basePriceInPaisa: 50_000,
      taxInPaisa: 0,
      shippingInPaisa: 0,
      totalQuoteInPaisa: 50_000,
    });

    const result = await engine.processTransaction(policy, proposal, quoteFetcher);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.orderId).toBeDefined();
      expect(result.amount).toBe(50_000);
    }

    // Persisted state in Postgres is immediately durable (all writes awaited)
    const { rows } = await pool.query(
      "SELECT consumed_amount_in_paisa, reserved_amount_in_paisa FROM authorization_policies WHERE authorization_id = $1",
      [policy.authorizationId],
    );
    expect(Number(rows[0]!.consumed_amount_in_paisa)).toBe(50_000);
    expect(Number(rows[0]!.reserved_amount_in_paisa)).toBe(0);
  });

  it("GuardrailEngine serializes racing proposals through processTransaction on PostgreSQL FOR UPDATE lock", async () => {
    const logger = new HashChainLogger();
    const simulated = new SimulatedRazorpayGateway();
    let gatewayCalls = 0;
    const gateway: GatewayHandle = {
      client: simulated,
      mode: "SIMULATED",
      callCount: () => gatewayCalls,
      description: "pg contention test gateway",
    };
    const originalCreate = simulated.orders.create.bind(simulated.orders);
    simulated.orders.create = async (params: any) => {
      gatewayCalls++;
      return originalCreate(params);
    };

    const engine = new GuardrailEngine({ store: pgStore, logger, gateway });

    const policy = createAuthorizationPolicy({
      authorizationId: "auth_pg_engine_contention",
      userId: "user_pg_contention",
      purpose: "PG Engine processTransaction contention test",
      maxAmountInPaisa: 500_000, // ₹5,000 cap
      allowedCategories: ["office_supplies"],
      allowedMerchants: ["merchant_officedepot_in"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      requiresHumanApprovalAbovePaisa: 500_000,
    });
    await pgStore.savePolicyState(policy);

    // Two distinct proposals, each for ₹3,000 (300,000 paisa). Combined ₹6,000 > ₹5,000 cap.
    const proposalA: IntentProposal = {
      authorizationId: policy.authorizationId,
      itemId: "item_desk",
      merchantId: "merchant_officedepot_in",
      category: "office_supplies",
      proposedAmountInPaisa: 300_000,
      clientNonce: `nonce_pg_contention_a_${Date.now()}`,
    };

    const proposalB: IntentProposal = {
      authorizationId: policy.authorizationId,
      itemId: "item_chair",
      merchantId: "merchant_officedepot_in",
      category: "office_supplies",
      proposedAmountInPaisa: 300_000,
      clientNonce: `nonce_pg_contention_b_${Date.now()}`,
    };

    const quoteFetcherA = async (): Promise<MerchantCartQuote> => ({
      itemId: proposalA.itemId,
      basePriceInPaisa: 300_000,
      taxInPaisa: 0,
      shippingInPaisa: 0,
      totalQuoteInPaisa: 300_000,
    });

    const quoteFetcherB = async (): Promise<MerchantCartQuote> => ({
      itemId: proposalB.itemId,
      basePriceInPaisa: 300_000,
      taxInPaisa: 0,
      shippingInPaisa: 0,
      totalQuoteInPaisa: 300_000,
    });

    // Run both proposals concurrently through GuardrailEngine.processTransaction
    const [resultA, resultB] = await Promise.all([
      engine.processTransaction(policy, proposalA, quoteFetcherA),
      engine.processTransaction(policy, proposalB, quoteFetcherB),
    ]);

    // Exactly one transaction must succeed, and one must fail with ERR_CUMULATIVE_CAP_EXCEEDED
    const results = [resultA, resultB];
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const winner = successes[0]!;
    const loser = failures[0]!;

    expect(winner.success).toBe(true);
    if (winner.success) {
      expect(winner.amount).toBe(300_000);
      expect(winner.orderId).toBeDefined();
    }

    expect(loser.success).toBe(false);
    if (!loser.success) {
      expect(loser.code).toBe("ERR_CUMULATIVE_CAP_EXCEEDED");
      expect(loser.reason).toContain("Nothing was reserved");
    }

    // Gateway must be invoked exactly once
    expect(gatewayCalls).toBe(1);

    // Verify raw PostgreSQL table rows directly
    const { rows: policyRows } = await pool.query(
      "SELECT consumed_amount_in_paisa, reserved_amount_in_paisa FROM authorization_policies WHERE authorization_id = $1",
      [policy.authorizationId],
    );
    expect(policyRows).toHaveLength(1);
    expect(Number(policyRows[0]!.consumed_amount_in_paisa)).toBe(300_000);
    expect(Number(policyRows[0]!.reserved_amount_in_paisa)).toBe(0);

    // Reservations table in Postgres must have 0 active reservations (committed and removed)
    const { rows: resRows } = await pool.query(
      "SELECT reservation_id, amount_in_paisa FROM reservations WHERE authorization_id = $1",
      [policy.authorizationId],
    );
    expect(resRows).toHaveLength(0);

    // Idempotency records table in Postgres must contain both records: 1 COMPLETED, 1 FAILED
    const { rows: idempRows } = await pool.query(
      "SELECT idempotency_key, status FROM idempotency_records WHERE authorization_id = $1 ORDER BY status ASC",
      [policy.authorizationId],
    );
    expect(idempRows).toHaveLength(2);
    const statuses = idempRows.map((r) => r.status).sort();
    expect(statuses).toEqual(["COMPLETED", "FAILED"]);
  });
});
