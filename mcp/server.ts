import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { GuardrailEngine, FetchCartQuote } from "@/engine/guardrailEngine";
import type { HashChainLogger } from "@/logger/hashChainLogger";
import type { StateStore } from "@/state/stateStore";
import type { AuthorizationPolicy } from "@/types/agentGuard";

/**
 * AgentGuard MCP Server — Model Context Protocol wrapper around the existing engine.
 *
 * Every tool handler is a thin pass-through to existing, already-tested functions.
 * The MCP layer contains NO new financial logic — no amount comparisons, no `if`
 * statements evaluating financial rules, no business logic of any kind.
 *
 * ## Tools exposed
 *
 * - `propose_transaction` — calls `engine.processTransaction` directly
 * - `get_policy_status` — read-only projection of consumed/reserved/status
 * - `verify_audit_chain` — calls `verifyChainIntegrity()`
 *
 * NOTE: `approve_escalation` is intentionally NOT exposed on this agent-facing
 * MCP surface. An autonomous buying agent must never hold the authority to approve
 * its own financial escalations. Approvals are strictly restricted to the human-in-
 * the-loop interface.
 */

export interface McpServerDeps {
  engine: GuardrailEngine;
  store: StateStore;
  logger: HashChainLogger;
  resolvePolicy: (authorizationId: string) => AuthorizationPolicy | undefined;
  fetchCartQuote: FetchCartQuote;
}

export function createAgentGuardMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({
    name: "agentguard",
    version: "1.0.0",
  });

  // ---- propose_transaction ------------------------------------------------
  server.tool(
    "propose_transaction",
    "Propose a purchase transaction for AgentGuard to validate against the authorization policy. Returns the full pipeline result unmodified.",
    {
      authorizationId: z.string().describe("The authorization policy ID"),
      itemId: z.string().describe("The item to purchase"),
      merchantId: z.string().describe("The merchant identifier"),
      category: z.string().describe("The item category"),
      proposedAmountInPaisa: z.number().int().describe("The proposed amount in paisa"),
      clientNonce: z.string().describe("Unique nonce for idempotency"),
      humanApprovalToken: z.string().optional().describe("Approval token for escalated resubmission"),
    },
    async (params) => {
      const policy = deps.resolvePolicy(params.authorizationId);
      if (!policy) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `No policy found for ${params.authorizationId}` }),
          }],
        };
      }

      const result = await deps.engine.processTransaction(
        policy,
        {
          authorizationId: params.authorizationId,
          itemId: params.itemId,
          merchantId: params.merchantId,
          category: params.category,
          proposedAmountInPaisa: params.proposedAmountInPaisa,
          clientNonce: params.clientNonce,
          humanApprovalToken: params.humanApprovalToken,
        },
        deps.fetchCartQuote,
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ---- get_policy_status --------------------------------------------------
  server.tool(
    "get_policy_status",
    "Get the current status of an authorization policy, including consumed and reserved amounts.",
    {
      authorizationId: z.string().describe("The authorization policy ID"),
    },
    async (params) => {
      const persisted = deps.store.getPolicyState(params.authorizationId);
      if (!persisted) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `No policy state for ${params.authorizationId}` }),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            authorizationId: persisted.authorizationId,
            consumedAmountInPaisa: persisted.consumedAmountInPaisa,
            reservedAmountInPaisa: persisted.reservedAmountInPaisa,
            status: persisted.status,
          }),
        }],
      };
    },
  );

  // ---- verify_audit_chain -------------------------------------------------
  server.tool(
    "verify_audit_chain",
    "Verify the integrity of the AgentGuard audit hash chain.",
    {},
    async () => {
      const result = deps.logger.verifyChainIntegrityDetailed();

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

/**
 * Standalone entry point: run the MCP server over stdio.
 * Usage: `tsx mcp/server.ts`
 */
export async function startStdioServer(deps: McpServerDeps): Promise<void> {
  const server = createAgentGuardMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
