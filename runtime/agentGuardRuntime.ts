import fs from "node:fs";
import path from "node:path";
import { GuardrailEngine, RATE_LIMIT_MAX_PROPOSALS, RATE_LIMIT_WINDOW_MS } from "@/engine/guardrailEngine";
import { HashChainLogger, type ChainVerificationResult } from "@/logger/hashChainLogger";
import { SnapshotStore, DEFAULT_STATE_FILE } from "@/state/snapshotStore";
import { PgStore } from "@/state/pgStore";
import type { StateStore } from "@/state/stateStore";
import { createPool } from "@/db/pool";
import {
  createAuthorizationPolicy,
  remainingHeadroomInPaisa,
  verifyPolicySignature,
} from "@/policy/policyFactory";
import { createGateway, type GatewayHandle } from "@/payments/razorpayClient";
import { computeIdempotencyKey, randomHex } from "@/security/crypto";
import { createSecretProvider, type SecretProvider } from "@/security/secretProvider";
import { handleApprovalRequest, type ApprovalRequestBody, type ApprovalResponse } from "@/api/approve";
import { MockMerchantCartApi, DEFAULT_CATALOG } from "@/mocks/merchantCartApi";
import { INJECTION_CATALOG, injectionCatalogAsCatalog } from "@/mocks/injectionFeed";
import {
  ATTACK_SCENARIOS,
  getScenario,
  buildProposal,
  type AttackScenarioId,
  type ScenarioOutcome,
} from "@/mocks/attackSuite";
import type {
  AuditLogBlock,
  AuthorizationPolicy,
  IntentProposal,
  PipelineStep,
  TransactionResult,
} from "@/types/agentGuard";

/**
 * Process-wide AgentGuard runtime.
 *
 * Next.js dev-server hot reloading re-evaluates modules, which would otherwise fork
 * the ledger into several disconnected copies. Pinning the runtime to `globalThis`
 * keeps exactly one `SnapshotStore`, one audit chain, and one gateway call counter
 * for the lifetime of the process — consistent with the single-instance design.
 */

const DEFAULT_AUDIT_FILE = "agentguard-audit.json";
const DEMO_AUTHORIZATION_ID = "auth_demo_primary";

/** How long the seeded demo mandate stays valid. */
const DEMO_POLICY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LiveDemoAction {
  actionId: string;
  label: string;
  description: string;
  itemId: string;
  merchantId: string;
  category: string;
  proposedAmountInPaisa: number;
  expectedOutcome: string;
}

export interface LastRunRecord {
  label: string;
  authorizationId: string;
  at: string;
  /** "EXECUTED" | "REPLAYED" | a GuardrailErrorCode | "SCENARIO" for a multi-step run. */
  outcome: string;
  code: string | null;
  orderId: string | null;
  reason: string | null;
  steps: PipelineStep[];
}

function lastRunFromResult(
  label: string,
  authorizationId: string,
  result: TransactionResult,
): LastRunRecord {
  return {
    label,
    authorizationId,
    at: new Date().toISOString(),
    outcome: result.success ? (result.replayed ? "REPLAYED" : "EXECUTED") : result.code,
    code: result.success ? null : result.code,
    orderId: result.success ? result.orderId : null,
    reason: result.success ? null : result.reason,
    steps: result.steps,
  };
}

interface RuntimeShape {
  store: StateStore;
  logger: HashChainLogger;
  gateway: GatewayHandle;
  secretProvider: SecretProvider;
  engine: GuardrailEngine;
  cart: MockMerchantCartApi;
  injectionCart: MockMerchantCartApi;
  policies: Map<string, AuthorizationPolicy>;
  /** idempotencyKey → the exact proposal that escalated, so it can be resubmitted. */
  liveProposals: Map<string, IntentProposal>;
  scenarioOutcomes: Map<AttackScenarioId, ScenarioOutcome>;
  lastRun: LastRunRecord | null;
  activeAuthorizationId: string;
  tamperHandle: { restore: () => void } | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __agentGuardRuntime: RuntimeShape | undefined;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function resolveStateFile(): string {
  return process.env.AGENTGUARD_STATE_FILE ?? path.join(process.cwd(), DEFAULT_STATE_FILE);
}

function resolveAuditFile(): string {
  return process.env.AGENTGUARD_AUDIT_FILE ?? path.join(process.cwd(), DEFAULT_AUDIT_FILE);
}

function buildDemoPolicy(): AuthorizationPolicy {
  return createAuthorizationPolicy({
    authorizationId: DEMO_AUTHORIZATION_ID,
    userId: "user_priya_sharma",
    purpose: "Office restocking assistant — stationery and IT peripherals for Q3",
    maxAmountInPaisa: 2_000_000, // ₹20,000
    allowedCategories: ["office_supplies", "electronics"],
    allowedMerchants: ["merchant_officedepot_in", "merchant_techmart_in"],
    expiresAt: new Date(Date.now() + DEMO_POLICY_TTL_MS).toISOString(),
    requiresHumanApprovalAbovePaisa: 500_000, // ₹5,000
  });
}

function createStateStore(): StateStore {
  if (process.env.AGENTGUARD_STATE_BACKEND === "postgres" || process.env.AGENTGUARD_DATABASE_URL) {
    const pool = createPool();
    return new PgStore({ pool });
  }
  return new SnapshotStore({ filePath: resolveStateFile() });
}

function buildRuntime(): RuntimeShape {
  const store = createStateStore();
  const logger = new HashChainLogger({ persistPath: resolveAuditFile() });
  const gateway = createGateway();
  const secretProvider = createSecretProvider();
  const engine = new GuardrailEngine({ store, logger, gateway, secretProvider });

  const policies = new Map<string, AuthorizationPolicy>();
  const demoPolicy = buildDemoPolicy();
  // The on-disk ledger wins here — this is what proves a reservation survived a
  // restart rather than being quietly reset by the in-code policy definition.
  store.registerPolicy(demoPolicy);
  policies.set(demoPolicy.authorizationId, demoPolicy);

  return {
    store,
    logger,
    gateway,
    secretProvider,
    engine,
    cart: new MockMerchantCartApi({ latencyMs: 4 }),
    injectionCart: new MockMerchantCartApi({ latencyMs: 4, catalog: injectionCatalogAsCatalog() }),
    policies,
    liveProposals: new Map(),
    scenarioOutcomes: new Map(),
    lastRun: null,
    activeAuthorizationId: DEMO_AUTHORIZATION_ID,
    tamperHandle: null,
  };
}

export function getRuntime(): RuntimeShape {
  if (!globalThis.__agentGuardRuntime) {
    globalThis.__agentGuardRuntime = buildRuntime();
  }
  return globalThis.__agentGuardRuntime;
}

/** Wipes the ledger and audit chain from disk, then re-seeds the demo policy. */
export function resetRuntime(): RuntimeShape {
  const existing = globalThis.__agentGuardRuntime;
  existing?.tamperHandle?.restore();

  // Remove both files so the rebuilt runtime cannot reload the old ledger or the
  // old chain. A reset that left the audit file in place would produce a chain
  // whose history no longer matches the ledger it claims to describe.
  for (const filePath of [resolveStateFile(), resolveAuditFile()]) {
    try {
      if (fs.existsSync(filePath)) fs.rmSync(filePath);
    } catch {
      // Non-fatal: the rebuilt store overwrites on its first mutation anyway.
    }
  }

  const runtime = buildRuntime();
  globalThis.__agentGuardRuntime = runtime;
  runtime.logger.log(DEMO_AUTHORIZATION_ID, "DEMO_STATE_RESET", {
    note: "Dashboard reset: ledger and audit chain cleared, demo authorization re-seeded",
    stateFile: runtime.store.getFilePath(),
  });
  return runtime;
}

// ---------------------------------------------------------------------------
// Live demo actions (the human-in-the-loop flow)
// ---------------------------------------------------------------------------

export const LIVE_DEMO_ACTIONS: LiveDemoAction[] = [
  {
    actionId: "buy_paper",
    label: "Buy A4 paper carton — ₹539.60",
    description: "Routine, in-policy, well under the ₹5,000.00 approval threshold.",
    itemId: "item_stationery_bulk",
    merchantId: "merchant_officedepot_in",
    category: "office_supplies",
    proposedAmountInPaisa: 53_960,
    expectedOutcome: "Executes straight through — Razorpay order created.",
  },
  {
    actionId: "buy_dock",
    label: "Buy USB-C docking station — ₹2,124.00",
    description: "Larger but still below the approval threshold.",
    itemId: "item_laptop_dock",
    merchantId: "merchant_techmart_in",
    category: "electronics",
    proposedAmountInPaisa: 212_400,
    expectedOutcome: "Executes straight through.",
  },
  {
    actionId: "buy_monitor",
    label: "Buy 4K reference monitor — ₹7,632.00",
    description: "Above the ₹5,000.00 threshold, so it must be signed off by a human.",
    itemId: "item_overpriced_monitor",
    merchantId: "merchant_techmart_in",
    category: "electronics",
    proposedAmountInPaisa: 763_200,
    expectedOutcome:
      "Escalates. Budget is reserved (not spent) and appears in the Approve / Deny panel below.",
  },
  {
    actionId: "buy_disallowed",
    label: "Buy a flight ticket — disallowed category",
    description: "An off-mandate purchase the agent believes is reasonable.",
    itemId: "item_stationery_bulk",
    merchantId: "merchant_officedepot_in",
    category: "travel",
    proposedAmountInPaisa: 53_960,
    expectedOutcome: "Blocked at step 3 with ERR_CATEGORY_NOT_ALLOWED.",
  },
  {
    actionId: "buy_injected",
    label: "Buy the hostile-vendor toner — ₹9,254.00",
    description:
      "The product description contains an injected instruction to ignore the budget cap.",
    itemId: "item_injected_toner",
    merchantId: "merchant_officedepot_in",
    category: "office_supplies",
    proposedAmountInPaisa: 480_000,
    expectedOutcome:
      "Blocked on the number, not the text. The injected instruction changes nothing.",
  },
];

export function getLiveDemoAction(actionId: string): LiveDemoAction | undefined {
  return LIVE_DEMO_ACTIONS.find((action) => action.actionId === actionId);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function runLiveAction(actionId: string): Promise<{
  ok: boolean;
  message: string;
  result?: TransactionResult;
}> {
  const runtime = getRuntime();
  const action = getLiveDemoAction(actionId);
  if (!action) {
    return { ok: false, message: `Unknown demo action "${actionId}"` };
  }

  const policy = runtime.policies.get(runtime.activeAuthorizationId);
  if (!policy) {
    return { ok: false, message: `No active authorization (${runtime.activeAuthorizationId})` };
  }

  const proposal = buildProposal({
    authorizationId: policy.authorizationId,
    itemId: action.itemId,
    merchantId: action.merchantId,
    category: action.category,
    proposedAmountInPaisa: action.proposedAmountInPaisa,
  });

  // The injected SKUs live in the hostile catalog, everything else in the clean one.
  const cart = INJECTION_CATALOG.some((entry) => entry.itemId === action.itemId)
    ? runtime.injectionCart
    : runtime.cart;

  const result = await runtime.engine.processTransaction(policy, proposal, cart.fetchCartQuote);

  // Keep the proposal so the Approve panel can resubmit it verbatim with a token.
  runtime.liveProposals.set(result.idempotencyKey, proposal);
  runtime.lastRun = lastRunFromResult(action.label, policy.authorizationId, result);
  runtime.activeAuthorizationId = policy.authorizationId;

  return { ok: true, message: summarizeResult(result), result };
}

export async function runScenario(id: string): Promise<{
  ok: boolean;
  message: string;
  outcome?: ScenarioOutcome;
}> {
  const runtime = getRuntime();
  const scenario = getScenario(id);
  if (!scenario) {
    return { ok: false, message: `Unknown scenario "${id}"` };
  }

  const outcome = await scenario.run({
    store: runtime.store,
    logger: runtime.logger,
    gateway: runtime.gateway,
    engine: runtime.engine,
    registerPolicy: (policy) => {
      runtime.store.registerPolicy(policy);
      return policy;
    },
  });

  runtime.scenarioOutcomes.set(outcome.id, outcome);
  // The visualizer shows the pipeline of the scenario's *final* proposal, which is
  // the one carrying the blocked/escalated decision the scenario is demonstrating.
  runtime.lastRun = {
    label: outcome.title,
    authorizationId: outcome.authorizationId,
    at: new Date().toISOString(),
    outcome: outcome.passed ? "SCENARIO_PASSED" : "SCENARIO_FAILED",
    code: null,
    orderId: null,
    reason: outcome.verdict,
    steps: outcome.finalPipeline,
  };

  return { ok: true, message: outcome.verdict, outcome };
}

export async function submitApproval(body: Partial<ApprovalRequestBody>): Promise<ApprovalResponse> {
  const runtime = getRuntime();
  return handleApprovalRequest(body, {
    store: runtime.store,
    logger: runtime.logger,
    resolvePolicy: (authorizationId) => runtime.policies.get(authorizationId),
  });
}

/**
 * Resubmit the original escalated proposal with an approval token attached.
 *
 * The proposal is replayed verbatim from the runtime's in-memory record — the caller
 * cannot substitute a different item, merchant, or amount, because any change would
 * produce a different idempotency key and fail the token's binding check anyway.
 */
export async function resubmitWithApproval(
  idempotencyKey: string,
  encodedToken: string,
): Promise<{ ok: boolean; message: string; result?: TransactionResult }> {
  const runtime = getRuntime();
  const original = runtime.liveProposals.get(idempotencyKey);
  if (!original) {
    return {
      ok: false,
      message:
        "The original proposal for this escalation is no longer in memory (the server restarted). " +
        "Ask the agent to re-propose.",
    };
  }

  const policy = runtime.policies.get(original.authorizationId);
  if (!policy) {
    return { ok: false, message: `No policy registered for ${original.authorizationId}` };
  }

  const cart = INJECTION_CATALOG.some((entry) => entry.itemId === original.itemId)
    ? runtime.injectionCart
    : runtime.cart;

  const result = await runtime.engine.processTransaction(
    policy,
    { ...original, humanApprovalToken: encodedToken },
    cart.fetchCartQuote,
  );

  runtime.lastRun = lastRunFromResult(
    `Resubmission with approval token (${original.itemId})`,
    policy.authorizationId,
    result,
  );
  runtime.activeAuthorizationId = policy.authorizationId;

  return { ok: true, message: summarizeResult(result), result };
}

/** Approve and immediately resubmit — one click in the dashboard. */
export async function approveAndSettle(input: {
  authorizationId: string;
  idempotencyKey: string;
  approverId: string;
}): Promise<{ ok: boolean; message: string; result?: TransactionResult; approval: ApprovalResponse }> {
  const approval = await submitApproval({ ...input, decision: "approve" });
  if (!approval.ok || approval.decision !== "approve") {
    return {
      ok: false,
      message: approval.ok ? "Unexpected approval response" : approval.message,
      approval,
    };
  }
  const settled = await resubmitWithApproval(input.idempotencyKey, approval.encodedToken);
  return { ...settled, approval };
}

export function verifyAuditChain(): ChainVerificationResult {
  return getRuntime().logger.verifyChainIntegrityDetailed();
}

/**
 * DEMO ONLY. Edits one historical block's `details` without recomputing its hash —
 * exactly what an attacker rewriting the log file would produce. Call again to restore.
 */
export function toggleAuditTamper(): {
  tampered: boolean;
  targetEntryId: string | null;
  verification: ChainVerificationResult;
  message: string;
} {
  const runtime = getRuntime();

  if (runtime.tamperHandle) {
    runtime.tamperHandle.restore();
    runtime.tamperHandle = null;
    return {
      tampered: false,
      targetEntryId: null,
      verification: runtime.logger.verifyChainIntegrityDetailed(),
      message: "Original block contents restored — the chain verifies again.",
    };
  }

  const chain = runtime.logger.getChain();
  // Prefer a block that actually records a decision, so the tamper is meaningful.
  const targetIndex = findTamperTarget(chain);
  if (targetIndex === null) {
    return {
      tampered: false,
      targetEntryId: null,
      verification: runtime.logger.verifyChainIntegrityDetailed(),
      message: "Nothing to tamper with yet — run a scenario or a purchase first.",
    };
  }

  const handle = runtime.logger.__tamperBlockForDemo(targetIndex, {
    tamperedBy: "attacker_editing_the_log_file",
    reason: "Rewritten to hide a blocked transaction",
  });
  if (!handle) {
    return {
      tampered: false,
      targetEntryId: null,
      verification: runtime.logger.verifyChainIntegrityDetailed(),
      message: "Could not access that block.",
    };
  }
  runtime.tamperHandle = handle;
  const target = chain[targetIndex];

  return {
    tampered: true,
    targetEntryId: target?.entryId ?? null,
    verification: runtime.logger.verifyChainIntegrityDetailed(),
    message:
      `Edited ${target?.entryId ?? "a block"}'s details in place without recomputing its hash. ` +
      `Run "Verify Hash Chain Integrity" — the break is detected at that block.`,
  };
}

function findTamperTarget(chain: AuditLogBlock[]): number | null {
  const interesting = new Set([
    "TRANSACTION_BLOCKED",
    "RAZORPAY_ORDER_CREATED",
    "BUDGET_RESERVED",
    "ESCALATED_TO_HUMAN",
  ]);
  for (let index = chain.length - 1; index >= 1; index -= 1) {
    if (interesting.has(chain[index]!.event)) return index;
  }
  return chain.length > 1 ? 1 : null;
}

// ---------------------------------------------------------------------------
// Dashboard projection
// ---------------------------------------------------------------------------

export interface PolicyView {
  authorizationId: string;
  userId: string;
  purpose: string;
  status: string;
  currency: string;
  maxAmountInPaisa: number;
  consumedAmountInPaisa: number;
  reservedAmountInPaisa: number;
  remainingHeadroomInPaisa: number;
  requiresHumanApprovalAbovePaisa: number;
  allowedCategories: string[];
  allowedMerchants: string[];
  expiresAt: string;
  executedTransactionIds: string[];
  nonce: string;
  signaturePreview: string;
  signatureValid: boolean;
  isDemoPolicy: boolean;
}

export interface PendingEscalationView {
  authorizationId: string;
  idempotencyKey: string;
  quotedAmountInPaisa: number;
  reservationId: string | null;
  reservationExpiresAt: string | null;
  secondsRemaining: number | null;
  purpose: string;
  itemId: string | null;
  canResubmit: boolean;
}

export interface DashboardState {
  generatedAt: string;
  gateway: { mode: string; description: string; callCount: number };
  persistence: {
    stateFilePath: string;
    auditFilePath: string;
    snapshotWriteCount: number;
    snapshotUpdatedAt: string;
    auditBlockCount: number;
  };
  serverSecretConfigured: boolean;
  activePolicy: PolicyView | null;
  policies: PolicyView[];
  rateLimit: { count: number; max: number; windowResetsAt: string } | null;
  lastRun: LastRunRecord | null;
  pendingEscalations: PendingEscalationView[];
  scenarios: Array<{
    id: AttackScenarioId;
    title: string;
    attackerGoal: string;
    expectation: string;
    outcome: ScenarioOutcome | null;
  }>;
  liveActions: LiveDemoAction[];
  audit: {
    integrity: ChainVerificationResult;
    tampered: boolean;
    totalBlocks: number;
    blocks: AuditLogBlock[];
  };
  catalog: {
    cleanItemCount: number;
    hostileItemCount: number;
    hostileVectors: Array<{ itemId: string; title: string; attackVector: string; injectionGoal: string }>;
  };
  limits: { rateLimitMaxProposals: number; rateLimitWindowMinutes: number; reservationTtlSeconds: number };
}

const AUDIT_BLOCK_LIMIT = 80;

export function getDashboardState(): DashboardState {
  const runtime = getRuntime();
  const now = Date.now();

  const policyViews = Array.from(runtime.policies.values()).map((policy) => {
    const persisted = runtime.store.getPolicyState(policy.authorizationId);
    if (persisted) {
      policy.state.status = persisted.status;
      policy.state.consumedAmountInPaisa = persisted.consumedAmountInPaisa;
      policy.state.reservedAmountInPaisa = persisted.reservedAmountInPaisa;
      policy.state.executedTransactionIds = [...persisted.executedTransactionIds];
    }
    return toPolicyView(policy);
  });
  const active =
    policyViews.find((view) => view.authorizationId === runtime.activeAuthorizationId) ??
    policyViews.find((view) => view.isDemoPolicy) ??
    policyViews[0] ??
    null;

  const rateWindow = active ? runtime.store.peekRateLimit(active.authorizationId) : undefined;

  const chain = runtime.logger.getChain();

  return {
    generatedAt: new Date(now).toISOString(),
    gateway: {
      mode: runtime.gateway.mode,
      description: runtime.gateway.description,
      callCount: runtime.gateway.callCount(),
    },
    persistence: {
      stateFilePath: runtime.store.getFilePath(),
      auditFilePath: resolveAuditFile(),
      snapshotWriteCount: runtime.store.getWriteCount(),
      snapshotUpdatedAt: runtime.store.getSnapshot().updatedAt,
      auditBlockCount: runtime.logger.getBlockCount(),
    },
    serverSecretConfigured: Boolean(process.env.AGENTGUARD_SERVER_SECRET),
    activePolicy: active,
    policies: policyViews,
    rateLimit: rateWindow
      ? {
          count: rateWindow.count,
          max: RATE_LIMIT_MAX_PROPOSALS,
          windowResetsAt: new Date(rateWindow.windowStartMs + RATE_LIMIT_WINDOW_MS).toISOString(),
        }
      : null,
    lastRun: runtime.lastRun,
    pendingEscalations: collectPendingEscalations(runtime, now),
    scenarios: ATTACK_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      attackerGoal: scenario.attackerGoal,
      expectation: scenario.expectation,
      outcome: runtime.scenarioOutcomes.get(scenario.id) ?? null,
    })),
    liveActions: LIVE_DEMO_ACTIONS,
    audit: {
      integrity: runtime.logger.verifyChainIntegrityDetailed(),
      tampered: runtime.tamperHandle !== null,
      totalBlocks: chain.length,
      blocks: chain.slice(-AUDIT_BLOCK_LIMIT).reverse(),
    },
    catalog: {
      cleanItemCount: DEFAULT_CATALOG.length,
      hostileItemCount: INJECTION_CATALOG.length,
      hostileVectors: INJECTION_CATALOG.map((entry) => ({
        itemId: entry.itemId,
        title: entry.title,
        attackVector: entry.attackVector,
        injectionGoal: entry.injectionGoal,
      })),
    },
    limits: {
      rateLimitMaxProposals: RATE_LIMIT_MAX_PROPOSALS,
      rateLimitWindowMinutes: RATE_LIMIT_WINDOW_MS / 60_000,
      reservationTtlSeconds: 300,
    },
  };
}

function toPolicyView(policy: AuthorizationPolicy): PolicyView {
  return {
    authorizationId: policy.authorizationId,
    userId: policy.userId,
    purpose: policy.purpose,
    status: policy.state.status,
    currency: policy.constraints.currency,
    maxAmountInPaisa: policy.constraints.maxAmountInPaisa,
    consumedAmountInPaisa: policy.state.consumedAmountInPaisa,
    reservedAmountInPaisa: policy.state.reservedAmountInPaisa,
    remainingHeadroomInPaisa: remainingHeadroomInPaisa(policy),
    requiresHumanApprovalAbovePaisa: policy.constraints.requiresHumanApprovalAbovePaisa,
    allowedCategories: policy.constraints.allowedCategories,
    allowedMerchants: policy.constraints.allowedMerchants,
    expiresAt: policy.constraints.expiresAt,
    executedTransactionIds: policy.state.executedTransactionIds,
    nonce: policy.security.nonce,
    signaturePreview: `${policy.security.signature.slice(0, 16)}…`,
    signatureValid: verifyPolicySignature(policy),
    isDemoPolicy: policy.authorizationId === DEMO_AUTHORIZATION_ID,
  };
}

function collectPendingEscalations(runtime: RuntimeShape, nowMs: number): PendingEscalationView[] {
  return runtime.store
    .listPendingEscalations()
    .map((record) => {
      const reservation = runtime.store.findReservationByIdempotencyKey(
        record.authorizationId,
        record.key,
      );
      const expiresAtMs = reservation ? Date.parse(reservation.expiresAt) : NaN;
      const policy = runtime.policies.get(record.authorizationId);
      const original = runtime.liveProposals.get(record.key);

      return {
        authorizationId: record.authorizationId,
        idempotencyKey: record.key,
        quotedAmountInPaisa: record.quote?.totalQuoteInPaisa ?? 0,
        reservationId: reservation?.reservationId ?? null,
        reservationExpiresAt: reservation?.expiresAt ?? null,
        secondsRemaining: Number.isNaN(expiresAtMs)
          ? null
          : Math.max(0, Math.round((expiresAtMs - nowMs) / 1000)),
        purpose: policy?.purpose ?? "(policy not registered in this process)",
        itemId: original?.itemId ?? null,
        canResubmit: Boolean(original),
      };
    })
    .sort((a, b) => (a.reservationExpiresAt ?? "").localeCompare(b.reservationExpiresAt ?? ""));
}

function summarizeResult(result: TransactionResult): string {
  if (result.success) {
    return result.replayed
      ? `Replayed cached result — order ${result.orderId}, no second charge.`
      : `Executed — Razorpay order ${result.orderId} for ${result.amount} paisa.`;
  }
  return `${result.code} — ${result.reason}`;
}

// ---------------------------------------------------------------------------
// Pre-flight assertions, surfaced in the dashboard as well as the CLI script
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export function runPreflightChecks(): { allPassed: boolean; checks: PreflightCheck[] } {
  const runtime = getRuntime();
  const checks: PreflightCheck[] = [];

  // 1. Every seeded policy must have a reachable escalation branch.
  for (const policy of runtime.policies.values()) {
    const { requiresHumanApprovalAbovePaisa, maxAmountInPaisa } = policy.constraints;
    checks.push({
      name: `Escalation branch reachable — ${policy.authorizationId}`,
      passed: requiresHumanApprovalAbovePaisa <= maxAmountInPaisa,
      detail: `requiresHumanApprovalAbovePaisa=${requiresHumanApprovalAbovePaisa} <= maxAmountInPaisa=${maxAmountInPaisa}`,
    });
    checks.push({
      name: `Policy signature valid — ${policy.authorizationId}`,
      passed: verifyPolicySignature(policy),
      detail: "HMAC over authorizationId, userId, purpose, constraints and nonce recomputes",
    });
  }

  // 2. The snapshot file exists and the in-memory ledger matches what is on disk.
  const stateFile = runtime.store.getFilePath();
  checks.push({
    name: "Snapshot file present on disk",
    passed: fs.existsSync(stateFile),
    detail: stateFile,
  });

  for (const policy of runtime.policies.values()) {
    const persisted = runtime.store.getPolicyState(policy.authorizationId);
    const matches =
      !!persisted &&
      persisted.consumedAmountInPaisa === policy.state.consumedAmountInPaisa &&
      persisted.reservedAmountInPaisa === policy.state.reservedAmountInPaisa;
    checks.push({
      name: `Ledger matches disk — ${policy.authorizationId}`,
      passed: matches,
      detail: persisted
        ? `disk consumed=${persisted.consumedAmountInPaisa} reserved=${persisted.reservedAmountInPaisa}; ` +
          `memory consumed=${policy.state.consumedAmountInPaisa} reserved=${policy.state.reservedAmountInPaisa}`
        : "No persisted state found for this authorization",
    });
  }

  // 3. The audit chain must verify before anything else is trusted.
  const integrity = runtime.logger.verifyChainIntegrityDetailed();
  checks.push({
    name: "Audit hash chain verifies",
    passed: integrity.valid,
    detail: integrity.valid
      ? `${integrity.blockCount} blocks, all links and content hashes recompute`
      : (integrity.reason ?? "unknown break"),
  });

  return { allPassed: checks.every((check) => check.passed), checks };
}

export { DEMO_AUTHORIZATION_ID, computeIdempotencyKey, randomHex };
