"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Terminal } from "lucide-react";
import { motion } from "motion/react";
import type {
  DashboardState,
  PendingEscalationView,
  PreflightCheck,
} from "@/runtime/agentGuardRuntime";
import { DashboardHeader } from "./components/DashboardHeader";
import { DashboardTabs } from "./components/DashboardTabs";
import { PolicyCard } from "./components/PolicyCard";
import { PipelineVisualizer } from "./components/PipelineVisualizer";
import { SimulationPanel, InjectionEvidence } from "./components/SimulationPanel";
import { EscalationPanel } from "./components/EscalationPanel";
import { AuditLogViewer } from "./components/AuditLogViewer";
import { SystemPanel } from "./components/SystemPanel";
import { BudgetOverview } from "./components/BudgetOverview";
import { notify } from "./components/NotificationProvider";
import { Card, FOCUS_RING } from "./components/ui";
import { clockTime, displayMoneyText, rupees } from "./lib/format";
import { DEFAULT_APPROVER_ID } from "./lib/constants";
import { errorMessage } from "./lib/errorMessages";

type TabId = "dashboard" | "policies" | "transactions" | "audit" | "settings";

const SETTINGS_APPROVER_INPUT_ID = "default-approver-persona";

export function DashboardClient({ initialState }: { initialState: DashboardState }) {
  const [state, setState] = useState<DashboardState>(initialState);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [approverId, setApproverId] = useState(DEFAULT_APPROVER_ID);
  const [preflight, setPreflight] = useState<{
    allPassed: boolean;
    checks: PreflightCheck[];
  } | null>(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<string | null>(null);

  /** Every mutating route returns a fresh DashboardState, so one helper covers them all. */
  const call = useCallback(
    async (
      key: string,
      url: string,
      body?: unknown,
      method: "POST" | "GET" = "POST",
    ): Promise<any> => {
      if (busyRef.current !== null) return null;
      busyRef.current = key;
      setBusy(key);
      try {
        const toastId = notify.loading(`Processing ${key}...`);
        const response = await fetch(url, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
        });
        const payload = await response.json();
        if (payload?.state) setState(payload.state);
        notify.dismiss(toastId);
        return payload;
      } catch (error) {
        notify.error(error instanceof Error ? error.message : "Request failed");
        return null;
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    const response = await fetch("/api/agentguard/state", { cache: "no-store" });
    setState(await response.json());
  }, []);

  const runScenario = useCallback(
    async (scenarioId: string) => {
      const payload = await call(scenarioId, "/api/agentguard/simulate", { scenarioId });
      if (!payload) return;
      const outcome = payload.outcome;
      if (outcome?.passed) {
        notify.success("Scenario completed", { description: displayMoneyText(payload.message) });
      } else {
        notify.error("Scenario blocked", { description: displayMoneyText(payload.message) });
      }
    },
    [call],
  );

  const runLive = useCallback(
    async (actionId: string) => {
      const payload = await call(actionId, "/api/agentguard/live", { actionId });
      if (!payload) return;
      const result = payload.result;
      if (!result) {
        notify.error("Request failed");
      } else if (result.success) {
        notify.success("Transaction executed", {
          description: `Order ID: ${result.orderId}`,
        });
      } else if (result.code === "PENDING_HUMAN_APPROVAL") {
        notify.warning("Awaiting approval", {
          description: `Budget is reserved for ${rupees(result.details?.quoteAmountInPaisa || 0)}`,
        });
      } else {
        // The engine code is precise but unreadable; the operator gets the
        // sentence and the code stays in the audit log where it belongs.
        notify.error("Transaction blocked", {
          description: errorMessage(result.code),
        });
      }
    },
    [call],
  );

  const decide = useCallback(
    async (escalation: PendingEscalationView, decision: "approve" | "deny") => {
      const payload = await call(escalation.idempotencyKey, "/api/agentguard/approve", {
        authorizationId: escalation.authorizationId,
        idempotencyKey: escalation.idempotencyKey,
        approverId: approverId.trim(),
        decision,
        settle: decision === "approve",
      });
      if (!payload) return;

      if (payload.ok === false) {
        notify.error("Approval failed", { description: payload.message });
        return;
      }
      if (decision === "deny") {
        notify.info("Escalation denied", { description: "Reservation released." });
        return;
      }
      const result = payload.result;
      if (result?.success) {
        notify.success("Transaction settled", { description: `Order: ${result.orderId}` });
      } else {
        notify.error("Settlement failed", { description: errorMessage(result?.code) });
      }
    },
    [approverId, call],
  );

  const verify = useCallback(async () => {
    const payload = await call("verify", "/api/agentguard/verify");
    if (!payload) return;
    setLastVerifiedAt(new Date().toISOString());
    if (payload.integrity?.valid) {
      notify.success("Chain verified", {
        description: `${payload.integrity.blockCount} blocks recompute cleanly.`,
      });
    } else {
      notify.error("Chain broken", {
        description: payload.integrity?.reason ?? "unknown",
      });
    }
  }, [call]);

  const tamper = useCallback(async () => {
    const payload = await call("tamper", "/api/agentguard/tamper");
    if (!payload) return;
    notify[payload.tampered ? "warning" : "info"](
      payload.tampered ? "Tampering enabled" : "Tampering disabled"
    );
  }, [call]);

  const runPreflight = useCallback(async () => {
    const payload = await call("preflight", "/api/agentguard/preflight", undefined, "GET");
    if (!payload) return;
    setPreflight(payload);
    await refresh();
    if (payload.allPassed) {
      notify.success(`All ${payload.checks.length} pre-flight checks passed`);
    } else {
      notify.error(
        `${payload.checks.filter((check: PreflightCheck) => !check.passed).length} pre-flight check(s) failed`
      );
    }
  }, [call, refresh]);

  const reset = useCallback(async () => {
    const payload = await call("reset", "/api/agentguard/reset");
    if (!payload) return;
    setPreflight(null);
    setLastVerifiedAt(null);
    notify.info("System reset");
  }, [call]);

  const injectionOutcome = useMemo(
    () => state.scenarios.find((scenario) => scenario.id === "prompt_injection")?.outcome ?? null,
    [state.scenarios],
  );

  // Same signal the approval queue shows: the field looks inert, so it has to
  // say when it is no longer the identity approvals get signed under.
  const approverIdIsModified = approverId.trim() !== DEFAULT_APPROVER_ID;

  return (
    <div className="min-h-screen bg-[#0B0F19] text-neutral-100">
      <DashboardHeader
        status={state.gateway.mode === "SIMULATED" ? "SIMULATED" : "CONNECTED"}
        lastSyncTime={clockTime(state.generatedAt)}
      />

      <DashboardTabs activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* Dashboard Tab */}
        {activeTab === "dashboard" && (
          <TabPanel id="dashboard" className="space-y-8">
            <BudgetOverview policies={state.policies} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <PipelineVisualizer lastRun={state.lastRun} />
              </div>
              <div>
                <SystemPanel
                  state={state}
                  preflight={preflight}
                  busy={busy}
                  onPreflight={runPreflight}
                  onReset={reset}
                />
              </div>
            </div>

            <SimulationPanel
              scenarios={state.scenarios}
              liveActions={state.liveActions}
              busyId={busy}
              onRunScenario={runScenario}
              onRunLive={runLive}
            />
          </TabPanel>
        )}

        {/* Policies Tab */}
        {activeTab === "policies" && (
          <TabPanel id="policies" className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white mb-6">Authorization Policies</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {state.policies.map((policy) => (
                  <PolicyCard key={policy.authorizationId} policy={policy} />
                ))}
              </div>
              {state.policies.length === 0 && (
                <div className="text-center py-12 text-neutral-400">
                  No active policies
                </div>
              )}
            </div>
          </TabPanel>
        )}

        {/* Transactions Tab */}
        {activeTab === "transactions" && (
          <TabPanel id="transactions" className="space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-white mb-6">Recent Transactions</h2>
              <SimulationPanel
                scenarios={state.scenarios}
                liveActions={state.liveActions}
                busyId={busy}
                onRunScenario={runScenario}
                onRunLive={runLive}
              />
            </div>

            {state.pendingEscalations.length > 0 && (
              <div>
                <h3 className="text-xl font-semibold text-white mb-4">Pending Approvals</h3>
                <EscalationPanel
                  escalations={state.pendingEscalations}
                  busyKey={busy}
                  approverId={approverId}
                  onApproverIdChange={setApproverId}
                  onDecide={decide}
                />
              </div>
            )}
          </TabPanel>
        )}

        {/* Audit Log Tab */}
        {activeTab === "audit" && (
          <TabPanel id="audit" className="space-y-6">
            <AuditLogViewer
              blocks={state.audit.blocks}
              totalBlocks={state.audit.totalBlocks}
              integrity={state.audit.integrity}
              tampered={state.audit.tampered}
              verifying={busy === "verify"}
              tampering={busy === "tamper"}
              lastVerifiedAt={lastVerifiedAt}
              onVerify={verify}
              onTamper={tamper}
            />

            <Card
              title="Vendor Catalog Analysis"
              subtitle="Sanitization results and denylist effectiveness"
              icon={<Terminal size={14} />}
            >
              <p className="mb-2.5 text-[10.5px] leading-relaxed text-neutral-400">
                Untrusted catalog text is NFKC-normalized, stripped of zero-width characters
                and HTML, truncated multi-byte-safely, and delivered inside an enclave with a
                system-prompt rule that the region is passive data. That structural boundary
                is the defense.
              </p>
              <InjectionEvidence outcome={injectionOutcome} />
            </Card>
          </TabPanel>
        )}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <TabPanel id="settings" className="space-y-6">
            <div className="rounded-xl border border-white/[0.08] bg-[#11192E]/95 p-6 shadow-xl backdrop-blur-md">
              <h3 className="text-base font-semibold text-white mb-4">System Identity & Configuration</h3>
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor={SETTINGS_APPROVER_INPUT_ID}
                    className="mb-2 block font-display text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400"
                  >
                    Default Approver Persona
                  </label>
                  <input
                    id={SETTINGS_APPROVER_INPUT_ID}
                    name="defaultApproverPersona"
                    type="text"
                    value={approverId}
                    aria-label="Default Approver Persona"
                    aria-describedby={`${SETTINGS_APPROVER_INPUT_ID}-hint`}
                    onChange={(e) => setApproverId(e.target.value)}
                    className={`w-full rounded-lg border bg-[#0B0F19] px-3.5 py-2 font-mono text-xs text-white transition-colors ${FOCUS_RING} ${
                      approverIdIsModified
                        ? "border-razorpay-500/70 shadow-[0_0_0_3px_rgba(0,102,255,0.12)]"
                        : "border-white/[0.08] hover:border-neutral-600"
                    }`}
                  />
                  <p
                    id={`${SETTINGS_APPROVER_INPUT_ID}-hint`}
                    className="mt-1.5 text-[11px] text-neutral-400"
                  >
                    {approverIdIsModified
                      ? `Changed from the default — approvals will be signed as this identity.`
                      : "Shared with the approval queue; every approval is HMAC-signed under this identity."}
                  </p>
                </div>
                <div className="pt-4 border-t border-white/[0.06]">
                  <h4 className="font-display text-xs font-semibold uppercase tracking-[0.1em] text-neutral-400 mb-2.5">
                    Payment Gateway Mode
                  </h4>
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        state.gateway.mode === "SIMULATED"
                          ? "bg-amber-400"
                          : "bg-emerald-400"
                      } pulse-dot`}
                    />
                    <span className="text-xs font-semibold text-neutral-200">
                      {state.gateway.mode === "SIMULATED" ? "Simulated Sandbox Gateway" : "Connected to Razorpay Test Orders API"}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <SystemPanel
              state={state}
              preflight={preflight}
              busy={busy}
              onPreflight={runPreflight}
              onReset={reset}
            />
          </TabPanel>
        )}
      </main>

      <Footer state={state} />
    </div>
  );
}

/**
 * The rendered half of the ARIA tabs pattern in `DashboardTabs`. Each tab button
 * emits `aria-controls="panel-<id>"`, so the panel has to answer with the
 * matching id and point back at its tab, or the relationship is advertised but
 * never resolves for a screen reader.
 */
function TabPanel({
  id,
  className,
  children,
}: {
  id: TabId;
  className?: string;
  children: ReactNode;
}) {
  return (
    <motion.div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function Footer({ state }: { state: DashboardState }) {
  return (
    <footer className="mx-auto max-w-7xl border-t border-white/[0.06] px-4 py-6 text-xs text-neutral-400 sm:px-6">
      <p className="mb-2">
        Single-instance by design: one process, one JSON snapshot written synchronously after
        every mutation.
      </p>
      <div className="flex flex-wrap gap-4 text-neutral-500 font-mono text-[11px]">
        <span>State: {clockTime(state.generatedAt)}</span>
        <span>•</span>
        <span>{state.audit.totalBlocks} audit blocks</span>
        <span>•</span>
        <span>{state.persistence.snapshotWriteCount} writes</span>
      </div>
    </footer>
  );
}
