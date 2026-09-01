import type { HashChainLogger } from "@/logger/hashChainLogger";
import type { AuditLogBlock } from "@/types/agentGuard";

/**
 * Cross-authorization anomaly detection — advisory only.
 *
 * Operates across all `authorizationId`s, something no single policy can see
 * on its own. When the same `merchantId` appears in blocked or error events
 * across ≥ N distinct `authorizationId`s within a rolling window, it flags
 * `ANOMALY_DETECTED` and logs it to the audit chain.
 *
 * ## Hard constraint
 *
 * This module only reads audit events and writes `ANOMALY_DETECTED` log entries.
 * It must never call anything that mutates `policy.state`, and it must never be
 * in a code path that `processTransaction` checks before returning a result.
 * It is a side-channel signal for a human to look at, not an enforcement input.
 *
 * ## Structural boundary
 *
 * This module has NO imports from `engine/guardrailEngine.ts`. It reads only the
 * audit log blocks and writes only through `HashChainLogger.log()`. The engine
 * does not import this module either — the dependency graph is completely separate.
 */

const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_THRESHOLD = 3;

export interface AnomalyRule {
  /** Rolling window in milliseconds. */
  windowMs: number;
  /** How many distinct authorizationIds must be affected before flagging. */
  threshold: number;
}

export interface AnomalyAlert {
  merchantId: string;
  distinctAuthorizationIds: string[];
  eventCount: number;
  windowMs: number;
  threshold: number;
}

/** Event types that indicate a merchant was involved in a blocked or error outcome. */
const SUSPICIOUS_EVENTS = new Set([
  "TRANSACTION_BLOCKED",
  "PRICE_SLIPPAGE_BLOCKED",
]);

/**
 * Scan audit blocks for cross-authorization anomalies.
 *
 * Checks whether the same `merchantId` appears in blocked or error events across
 * ≥ `threshold` distinct `authorizationId`s within a rolling `windowMs`.
 *
 * This function is pure: it reads the blocks array and returns alerts. The caller
 * decides whether to log them.
 */
export function detectAnomalies(
  blocks: AuditLogBlock[],
  rule: AnomalyRule = { windowMs: DEFAULT_WINDOW_MS, threshold: DEFAULT_THRESHOLD },
): AnomalyAlert[] {
  const now = Date.now();
  const cutoffMs = now - rule.windowMs;

  // Group suspicious events by merchantId → Set of authorizationIds
  const merchantMap = new Map<string, Set<string>>();
  const merchantEventCounts = new Map<string, number>();

  for (const block of blocks) {
    // Only consider blocks within the rolling window
    const blockMs = Date.parse(block.timestamp);
    if (Number.isNaN(blockMs) || blockMs < cutoffMs) continue;

    // Check if this is a suspicious event
    if (!SUSPICIOUS_EVENTS.has(block.event)) {
      // Also check for ERR_ codes in the details
      const code = block.details?.code;
      if (typeof code !== "string" || !code.startsWith("ERR_")) continue;
    }

    // Extract merchantId from block details
    const merchantId = block.details?.merchantId;
    if (typeof merchantId !== "string" || merchantId.length === 0) continue;

    const authSet = merchantMap.get(merchantId) ?? new Set<string>();
    authSet.add(block.authorizationId);
    merchantMap.set(merchantId, authSet);

    const count = merchantEventCounts.get(merchantId) ?? 0;
    merchantEventCounts.set(merchantId, count + 1);
  }

  // Find merchants that breach the threshold
  const alerts: AnomalyAlert[] = [];
  for (const [merchantId, authIds] of merchantMap) {
    if (authIds.size >= rule.threshold) {
      alerts.push({
        merchantId,
        distinctAuthorizationIds: Array.from(authIds),
        eventCount: merchantEventCounts.get(merchantId) ?? 0,
        windowMs: rule.windowMs,
        threshold: rule.threshold,
      });
    }
  }

  return alerts;
}

/**
 * Run anomaly detection and log any alerts to the audit chain.
 *
 * This is the top-level function: it reads the audit log, calls `detectAnomalies`,
 * and writes `ANOMALY_DETECTED` entries for each alert. The logger is the only
 * external dependency — no policy state is ever read or written.
 */
export function runAnomalyDetection(
  logger: HashChainLogger,
  rule?: AnomalyRule,
): AnomalyAlert[] {
  const blocks = logger.getChain();
  const alerts = detectAnomalies(blocks, rule);

  for (const alert of alerts) {
    logger.log("CROSS_AUTHORIZATION", "ANOMALY_DETECTED", {
      merchantId: alert.merchantId,
      distinctAuthorizationIds: alert.distinctAuthorizationIds,
      eventCount: alert.eventCount,
      windowMs: alert.windowMs,
      threshold: alert.threshold,
      note:
        `Merchant ${alert.merchantId} appeared in blocked/error events across ` +
        `${alert.distinctAuthorizationIds.length} distinct authorizations within ` +
        `${alert.windowMs / 60_000} minutes (threshold: ${alert.threshold}).`,
    });
  }

  return alerts;
}
