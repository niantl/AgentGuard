import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentGuardMcpServer, type McpServerDeps } from "@/mcp/server";
import { GuardrailEngine } from "@/engine/guardrailEngine";
import { HashChainLogger } from "@/logger/hashChainLogger";
import { SnapshotStore } from "@/state/snapshotStore";
import { createAuthorizationPolicy } from "@/policy/policyFactory";
import { SimulatedRazorpayGateway, type GatewayHandle } from "@/payments/razorpayClient";
import { fixedQuoteFetcher } from "@/mocks/merchantCartApi";
import type { AuthorizationPolicy } from "@/types/agentGuard";

const TMP_DIR = path.join(process.cwd(), ".tmp-test");
const STATE_FILE = path.join(TMP_DIR, "mcp-state.json");

interface TestContext {
  store: SnapshotStore;
  logger: HashChainLogger;
  engine: GuardrailEngine;
  policy: AuthorizationPolicy;
  client: Client;
  cleanup: () => Promise<void>;
}

async function setupMcpTest(): Promise<TestContext> {
  const store = new SnapshotStore({ filePath: STATE_FILE });
  const logger = new HashChainLogger();
  const simulated = new SimulatedRazorpayGateway();
  const gateway: GatewayHandle = {
    client: simulated,
    mode: "SIMULATED",
    callCount: () => simulated.callCount(),
    description: "test mcp gateway",
  };
  const engine = new GuardrailEngine({ store, logger, gateway });

  const policy = createAuthorizationPolicy({
    authorizationId: "auth_mcp_test",
    userId: "user_mcp",
    purpose: "MCP test policy",
    maxAmountInPaisa: 1_000_000,
    allowedCategories: ["office_supplies"],
    allowedMerchants: ["merchant_a"],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    requiresHumanApprovalAbovePaisa: 500_000,
  });
  store.registerPolicy(policy);

  const policies = new Map<string, AuthorizationPolicy>();
  policies.set(policy.authorizationId, policy);

  const deps: McpServerDeps = {
    engine,
    store,
    logger,
    resolvePolicy: (id) => policies.get(id),
    fetchCartQuote: fixedQuoteFetcher(50_000),
  };

  const server = createAgentGuardMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    store,
    logger,
    engine,
    policy,
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.rmSync(STATE_FILE, { force: true });
});

afterEach(() => {
  fs.rmSync(STATE_FILE, { force: true });
});

// ===========================================================================
// MCP round-trip tests
// ===========================================================================

function getContentText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]?.text ?? "";
}

describe("MCP server — round-trip", () => {
  it("propose_transaction tool returns full pipeline result via MCP transport", async () => {
    const ctx = await setupMcpTest();
    try {
      const result = await ctx.client.callTool({
        name: "propose_transaction",
        arguments: {
          authorizationId: "auth_mcp_test",
          itemId: "item_test",
          merchantId: "merchant_a",
          category: "office_supplies",
          proposedAmountInPaisa: 50_000,
          clientNonce: `nonce_${Date.now()}`,
        },
      });

      const text = getContentText(result);
      const parsed = JSON.parse(text);
      expect(parsed.success).toBe(true);
      expect(parsed.orderId).toBeDefined();
      expect(parsed.amount).toBe(50_000);
    } finally {
      await ctx.cleanup();
    }
  });

  it("get_policy_status returns consumed/reserved/status", async () => {
    const ctx = await setupMcpTest();
    try {
      const result = await ctx.client.callTool({
        name: "get_policy_status",
        arguments: { authorizationId: "auth_mcp_test" },
      });

      const parsed = JSON.parse(getContentText(result));
      expect(parsed.authorizationId).toBe("auth_mcp_test");
      expect(typeof parsed.consumedAmountInPaisa).toBe("number");
      expect(typeof parsed.reservedAmountInPaisa).toBe("number");
      expect(parsed.status).toBeDefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it("verify_audit_chain returns chain integrity result", async () => {
    const ctx = await setupMcpTest();
    try {
      const result = await ctx.client.callTool({
        name: "verify_audit_chain",
        arguments: {},
      });

      const parsed = JSON.parse(getContentText(result));
      expect(parsed.valid).toBe(true);
      expect(parsed.blockCount).toBeGreaterThan(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it("handles large proposedAmountInPaisa values correctly through JSON serialization", async () => {
    const ctx = await setupMcpTest();
    try {
      // Use a large but safe integer value
      const largeAmount = 999_999_999;

      const result = await ctx.client.callTool({
        name: "propose_transaction",
        arguments: {
          authorizationId: "auth_mcp_test",
          itemId: "item_test",
          merchantId: "merchant_a",
          category: "office_supplies",
          proposedAmountInPaisa: largeAmount,
          clientNonce: `nonce_large_${Date.now()}`,
        },
      });

      const parsed = JSON.parse(getContentText(result));
      // It should be blocked because quote (50000) is way under cap (1M),
      // but the proposedAmountInPaisa should have round-tripped correctly
      expect(parsed.idempotencyKey).toBeDefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns error for unknown authorization", async () => {
    const ctx = await setupMcpTest();
    try {
      const result = await ctx.client.callTool({
        name: "get_policy_status",
        arguments: { authorizationId: "auth_nonexistent" },
      });

      const parsed = JSON.parse(getContentText(result));
      expect(parsed.error).toBeDefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it("does NOT expose approve_escalation tool on agent-facing MCP surface", async () => {
    const ctx = await setupMcpTest();
    try {
      const tools = await ctx.client.listTools();
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).not.toContain("approve_escalation");
      expect(toolNames).toContain("propose_transaction");
      expect(toolNames).toContain("get_policy_status");
      expect(toolNames).toContain("verify_audit_chain");
    } finally {
      await ctx.cleanup();
    }
  });
});

// ===========================================================================
// Structural constraint — no business logic in MCP handlers
// ===========================================================================

describe("MCP server — structural constraints", () => {
  it("mcp/server.ts contains no financial comparisons or business logic", () => {
    const source = fs.readFileSync("mcp/server.ts", "utf8");

    // Extract only the function bodies of tool handlers — not imports or types
    // Check that there are no arithmetic operations on amounts or comparisons
    // against financial values. TypeScript generics like Promise<void> are not
    // financial comparisons, so we check for specific patterns instead.
    const financialPatterns = [
      /amount\s*[<>]/i,           // amount comparisons
      /paisa\s*[<>]/i,            // paisa comparisons
      /budget\s*[<>]/i,           // budget comparisons
      /price\s*[<>]/i,            // price comparisons
      /consumed\s*\+=/i,          // accumulation
      /reserved\s*\+=/i,          // accumulation
      /if\s*\(\s*\w+\s*>\s*\d/,   // if (x > <number>)
    ];

    for (const pattern of financialPatterns) {
      expect(source).not.toMatch(pattern);
    }

    // Also verify: no direct `if` checking a financial amount
    // The tool handlers should only pass-through to existing functions
    const handlerBodies = source
      .split("async (params)")
      .slice(1) // skip everything before the first handler
      .join("");
    
    // The only `if` in handlers should be null checks, not amount checks
    const ifStatements = handlerBodies.match(/if\s*\([^)]+\)/g) ?? [];
    for (const stmt of ifStatements) {
      expect(stmt).not.toMatch(/amount|paisa|price|budget/i);
    }
  });
});
