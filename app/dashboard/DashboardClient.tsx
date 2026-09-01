"use client";

import { useCallback, useMemo, useState } from "react";
import { Terminal } from "lucide-react";
import { motion } from "framer-motion";
import { toast } from "sonner";
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
import { Badge, Card } from "./components/ui";
import { clockTime } from "./lib/format";

type TabId = "dashboard" | "policies" | "transactions" | "audit" | "settings";

export function DashboardClient({ initialState }: { initialState: DashboardState }) {
  const [state, setState] = useState<DashboardState>(initialState);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [approverId, setApproverId] = useState("approver_finance_ops");
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
      setBusy(key);
      try {
        const toastId = toast.loading(`Processing ${key}...`);
        const response = await fetch(url, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
        });
        const payload = await response.json();
        if (payload?.state) setState(payload.state);
        toast.dismiss(toastId);
        return payload;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Request failed");
        return null;
      } finally {
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
        toast.success("Scenario completed", { description: payload.message });
      } else {
        toast.error("Scenario blocked", { description: payload.message });
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
        toast.error("Request failed");
      } else if (result.success) {
        toast.success("Transaction executed", {
          description: `Order ID: ${result.orderId}`,
        });
      } else if (result.code === "PENDING_HUMAN_APPROVAL") {
        toast.warning("Awaiting approval", {
          description: `Budget is reserved for ₹${(result.details?.quoteAmountInPaisa || 0) / 100}`,
        });
      } else {
        toast.error("Transaction blocked", {
          description: result.code,
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
        toast.error("Approval failed", { description: payload.message });
        return;
      }
      if (decision === "deny") {
        toast.info("Escalation denied", { description: "Reservation released." });
        return;
      }
      const result = payload.result;
      if (result?.success) {
        toast.success("Transaction settled", { description: `Order: ${result.orderId}` });
      } else {
        toast.error("Settlement failed");
      }
    },
    [approverId, call],
  );

  const verify = useCallback(async () => {
    const payload = await call("verify", "/api/agentguard/verify");
    if (!payload) return;
    setLastVerifiedAt(new Date().toISOString());
    if (payload.integrity?.valid) {
      toast.success("Chain verified", {
        description: `${payload.integrity.blockCount} blocks recompute cleanly.`,
      });
    } else {
      toast.error("Chain broken", {
        description: payload.integrity?.reason ?? "unknown",
      });
    }
  }, [call]);

  const tamper = useCallback(async () => {
    const payload = await call("tamper", "/api/agentguard/tamper");
    if (!payload) return;
    toast[payload.tampered ? "warning" : "info"](
      payload.tampered ? "Tampering enabled" : "Tampering disabled"
    );
  }, [call]);

  const runPreflight = useCallback(async () => {
    const payload = await call("preflight", "/api/agentguard/preflight", undefined, "GET");
    if (!payload) return;
    setPreflight(payload);
    await refresh();
    if (payload.allPassed) {
      toast.success(`All ${payload.checks.length} pre-flight checks passed`);
    } else {
      toast.error(
        `${payload.checks.filter((check: PreflightCheck) => !check.passed).length} pre-flight check(s) failed`
      );
    }
  }, [call, refresh]);

  const reset = useCallback(async () => {
    const payload = await call("reset", "/api/agentguard/reset");
    if (!payload) return;
    setPreflight(null);
    setLastVerifiedAt(null);
    toast.info("System reset");
  }, [call]);

  const injectionOutcome = useMemo(
    () => state.scenarios.find((scenario) => scenario.id === "prompt_injection")?.outcome ?? null,
    [state.scenarios],
  );

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-100">
      <DashboardHeader
        status={state.gateway.mode === "SIMULATED" ? "SIMULATED" : "CONNECTED"}
        lastSyncTime={clockTime(state.generatedAt)}
      />

      <DashboardTabs activeTab={activeTab} onTabChange={setActiveTab} />

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Dashboard Tab */}
        {activeTab === "dashboard" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="space-y-8"
          >
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
          </motion.div>
        )}

        {/* Policies Tab */}
        {activeTab === "policies" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="space-y-6"
          >
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
          </motion.div>
        )}

        {/* Transactions Tab */}
        {activeTab === "transactions" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="space-y-6"
          >
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
          </motion.div>
        )}

        {/* Audit Log Tab */}
        {activeTab === "audit" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="space-y-6"
          >
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
          </motion.div>
        )}

        {/* Settings Tab */}
        {activeTab === "settings" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="space-y-6"
          >
            <div className="rounded-xl border border-white/[0.08] bg-[#11192E]/95 p-6 shadow-xl backdrop-blur-md">
              <h3 className="text-base font-semibold text-white mb-4">System Identity & Configuration</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-neutral-400 mb-2 uppercase tracking-wider">
                    Default Approver Persona
                  </label>
                  <input
                    type="text"
                    value={approverId}
                    onChange={(e) => setApproverId(e.target.value)}
                    className="w-full px-3.5 py-2 bg-[#0B0F19] border border-white/[0.08] rounded-lg text-white text-xs font-mono focus:outline-none focus:border-razorpay-500 transition-colors"
                  />
                </div>
                <div className="pt-4 border-t border-white/[0.06]">
                  <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2.5">
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
          </motion.div>
        )}
      </main>

      <Footer state={state} />
    </div>
  );
}

function Footer({ state }: { state: DashboardState }) {
  return (
    <footer className="max-w-7xl mx-auto px-6 py-6 border-t border-white/[0.06] text-xs text-neutral-400">
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
