"use client";

import { Cpu, HardDrive, Gauge, ListChecks, Loader2, RotateCcw } from "lucide-react";
import type { DashboardState, PreflightCheck } from "@/runtime/agentGuardRuntime";
import { Badge, Button, Card, Field, Relative } from "./ui";
import { clockTime } from "../lib/format";

export function SystemPanel({
  state,
  preflight,
  busy,
  onPreflight,
  onReset,
}: {
  state: DashboardState;
  preflight: { allPassed: boolean; checks: PreflightCheck[] } | null;
  busy: string | null;
  onPreflight: () => void;
  onReset: () => void;
}) {
  const { gateway, persistence, rateLimit, limits } = state;
  const simulated = gateway.mode === "SIMULATED";

  return (
    <Card
      title="Runtime"
      subtitle="Single instance, single JSON snapshot, synchronous writes."
      icon={<Cpu size={14} />}
      actions={
        <>
          <Button size="sm" onClick={onPreflight} disabled={busy !== null}>
            {busy === "preflight" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <span className="flex items-center gap-1">
                <ListChecks size={10} /> Pre-flight
              </span>
            )}
          </Button>
          <Button size="sm" tone="danger" onClick={onReset} disabled={busy !== null}>
            {busy === "reset" ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <span className="flex items-center gap-1">
                <RotateCcw size={10} /> Reset
              </span>
            )}
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field
          label="Payment gateway"
          value={
            <span className="flex items-center gap-1.5">
              <Badge tone={simulated ? "warn" : "ok"}>{gateway.mode}</Badge>
            </span>
          }
          title={gateway.description}
        />
        <Field label="orders.create calls" value={gateway.callCount} />
        <Field
          label="Signing secret"
          value={state.serverSecretConfigured ? "from env" : "ephemeral (dev)"}
          tone={state.serverSecretConfigured ? "ok" : "warn"}
          title={
            state.serverSecretConfigured
              ? "AGENTGUARD_SERVER_SECRET is set. Never sent to the agent or the browser."
              : "No AGENTGUARD_SERVER_SECRET set — a random per-process key is used, so tokens and signatures do not survive a restart."
          }
        />
        <Field label="Snapshot writes" value={persistence.snapshotWriteCount} />
        <Field
          label="Snapshot updated"
          value={
            Date.parse(persistence.snapshotUpdatedAt) <= 0 ? (
              <span className="text-neutral-400 font-mono text-[11px]">Initial (clean)</span>
            ) : (
              <>
                {clockTime(persistence.snapshotUpdatedAt)}
                <Relative iso={persistence.snapshotUpdatedAt} prefix=" · " />
              </>
            )
          }
        />
        <Field label="Audit blocks" value={persistence.auditBlockCount} />
        <Field
          label="Proposal rate"
          value={
            rateLimit
              ? `${rateLimit.count} / ${rateLimit.max} in window`
              : `0 / ${limits.rateLimitMaxProposals} in window`
          }
          tone={rateLimit && rateLimit.count >= rateLimit.max ? "bad" : undefined}
          title={`Max ${limits.rateLimitMaxProposals} proposals per authorization per ${limits.rateLimitWindowMinutes} minutes.`}
        />
        <Field label="Reservation TTL" value={`${limits.reservationTtlSeconds}s`} />
        <Field
          label="Hostile catalog"
          value={`${state.catalog.hostileItemCount} injected SKUs`}
          title={state.catalog.hostileVectors.map((entry) => `${entry.itemId}: ${entry.attackVector}`).join("\n")}
        />
      </dl>

      <div className="mt-3 flex items-start gap-2 border-t border-white/[0.06] pt-2.5">
        <HardDrive size={12} className="mt-0.5 shrink-0 text-neutral-400" />
        <p className="tabular font-mono text-[10.5px] leading-relaxed text-neutral-400">
          {persistence.stateFilePath}
          <br />
          {persistence.auditFilePath}
        </p>
      </div>

      {simulated ? (
        <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
          No Razorpay test keys configured; running in simulated sandbox mode. Set
          RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to hit the live Test-mode Orders API.
        </p>
      ) : null}

      {preflight ? (
        <div className="mt-3 border-t border-white/[0.06] pt-2.5">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Gauge size={12} className="text-razorpay-400" />
              <span className="text-xs font-semibold text-white">Pre-flight Diagnostics</span>
            </div>
            <Badge tone={preflight.allPassed ? "ok" : "bad"}>
              {preflight.allPassed
                ? `${preflight.checks.length}/${preflight.checks.length} passed`
                : `${preflight.checks.filter((check) => !check.passed).length} failed`}
            </Badge>
          </div>
          <ul className="space-y-1.5 rounded-lg bg-neutral-900/60 p-2.5 border border-white/[0.04]">
            {preflight.checks.map((check) => (
              <li key={check.name} className="flex items-start gap-2 text-[11px]">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                    check.passed ? "bg-emerald-400" : "bg-rose-400"
                  }`}
                />
                <span className="min-w-0">
                  <span className={check.passed ? "text-neutral-200 font-medium" : "text-rose-300 font-medium"}>
                    {check.name}
                  </span>
                  <span className="tabular block font-mono text-[10px] text-neutral-400">{check.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
