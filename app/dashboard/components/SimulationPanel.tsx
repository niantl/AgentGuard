"use client";

import { useState } from "react";
import {
  Bug,
  Check,
  ChevronDown,
  Loader2,
  ShoppingCart,
  Swords,
  X,
} from "lucide-react";
import type { ScenarioOutcome, ScenarioStepReport } from "@/mocks/attackSuite";
import type { DashboardState, LiveDemoAction } from "@/runtime/agentGuardRuntime";
import type { TransactionResult } from "@/types/agentGuard";
import { Badge, Button, Card, EmptyState, FOCUS_RING } from "./ui";
import { displayMoneyText, rupees } from "../lib/format";
import { errorLabel, errorMessage } from "../lib/errorMessages";

/**
 * Interactive simulation panel.
 *
 * The scenario buttons run the exact same code as `tests/attacks.test.ts`, against the
 * same engine instance the live purchases use. Nothing here is a mock of the guardrail —
 * only the merchant, the catalog, and the adversary are mocked.
 */

type ScenarioSummary = DashboardState["scenarios"][number];

export function SimulationPanel({
  scenarios,
  liveActions,
  busyId,
  onRunScenario,
  onRunLive,
}: {
  scenarios: ScenarioSummary[];
  liveActions: LiveDemoAction[];
  busyId: string | null;
  onRunScenario: (id: string) => void;
  onRunLive: (actionId: string) => void;
}) {
  const [tab, setTab] = useState<"attacks" | "live">("attacks");
  const ranCount = scenarios.filter((scenario) => scenario.outcome).length;
  const failedCount = scenarios.filter(
    (scenario) => scenario.outcome && !scenario.outcome.passed,
  ).length;

  return (
    <Card
      title="Adversarial simulation"
      subtitle="Seven attacks a real buying agent would face — run them against the live engine."
      icon={<Swords size={16} className="text-razorpay-400" />}
      actions={
        <div className="flex items-center gap-2">
          {ranCount > 0 ? (
            <Badge tone={failedCount === 0 ? "ok" : "bad"}>
              {failedCount === 0 ? `${ranCount}/7 held` : `${failedCount} breached`}
            </Badge>
          ) : null}
          <div className="flex overflow-hidden rounded-lg border border-white/[0.08] bg-[#0B0F19]">
            <TabButton active={tab === "attacks"} onClick={() => setTab("attacks")}>
              <Bug size={11} /> Red-Team Attacks
            </TabButton>
            <TabButton active={tab === "live"} onClick={() => setTab("live")}>
              <ShoppingCart size={11} /> Live Purchases
            </TabButton>
          </div>
        </div>
      }
    >
      {tab === "attacks" ? (
        <div className="space-y-2">
          {scenarios.map((scenario, index) => (
            <ScenarioRow
              key={scenario.id}
              index={index + 1}
              scenario={scenario}
              busy={busyId === scenario.id}
              disabled={busyId !== null}
              onRun={() => onRunScenario(scenario.id)}
            />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="mb-1 text-[11px] leading-relaxed text-neutral-400">
            These are ordinary proposals from the agent against the mandate above. The agent
            names an item and a merchant; it never names the amount that gets charged —
            AgentGuard fetches its own quote and decides.
          </p>
          {liveActions.map((action) => (
            <LiveActionRow
              key={action.actionId}
              action={action}
              busy={busyId === action.actionId}
              disabled={busyId !== null}
              onRun={() => onRunLive(action.actionId)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold tracking-wide transition-colors ${FOCUS_RING} ${
        active
          ? "border-b-2 border-razorpay-400 bg-razorpay-500/20 text-razorpay-300"
          : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}

function ScenarioRow({
  index,
  scenario,
  busy,
  disabled,
  onRun,
}: {
  index: number;
  scenario: ScenarioSummary;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const [open, setOpen] = useState(false);
  const outcome = scenario.outcome;
  const detailId = `scenario-detail-${scenario.id}`;

  return (
    <div
      className={`rounded-xl border transition-colors ${
        outcome
          ? outcome.passed
            ? "border-emerald-500/30 bg-[#0B0F19]/90"
            : "border-rose-500/40 bg-rose-950/20"
          : "border-white/[0.08] bg-[#0B0F19]/70 hover:border-white/[0.15]"
      }`}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="tabular font-mono mt-0.5 w-5 text-right text-xs text-neutral-500">{index}</span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-white">{scenario.title}</span>
            {outcome ? (
              <Badge tone={outcome.passed ? "ok" : "bad"}>
                {outcome.passed ? (
                  <>
                    <Check size={9} /> held
                  </>
                ) : (
                  <>
                    <X size={9} /> breached
                  </>
                )}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-400">
            <span className="text-neutral-500">goal: </span>
            {scenario.attackerGoal}
          </p>
          {outcome ? (
            <p
              className={`mt-1 text-[11px] leading-relaxed ${
                outcome.passed ? "text-emerald-300/90" : "text-rose-300"
              }`}
            >
              {displayMoneyText(outcome.verdict)}
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-400">
              <span className="text-neutral-500">expect: </span>
              {scenario.expectation}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {outcome ? (
            <Button
              size="sm"
              tone="ghost"
              onClick={() => setOpen((value) => !value)}
              ariaLabel={`${open ? "Hide" : "Show"} step-by-step detail for ${scenario.title}`}
              ariaExpanded={open}
              ariaControls={detailId}
            >
              <ChevronDown
                size={12}
                aria-hidden="true"
                className={`transition-transform ${open ? "rotate-180" : ""}`}
              />
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={onRun}
            disabled={disabled}
            ariaLabel={`${outcome ? "Re-run" : "Run"} attack scenario: ${scenario.title}`}
          >
            {busy ? (
              <span className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" /> running
              </span>
            ) : outcome ? (
              "re-run"
            ) : (
              "run"
            )}
          </Button>
        </div>
      </div>

      {open && outcome ? <ScenarioDetail id={detailId} outcome={outcome} /> : null}
    </div>
  );
}

function ScenarioDetail({ id, outcome }: { id: string; outcome: ScenarioOutcome }) {
  return (
    <div id={id} className="rounded-b-xl border-t border-white/[0.06] bg-[#070A12] px-4 py-3">
      <dl className="mb-3 grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="cap" value={rupees(outcome.policy.maxAmountInPaisa)} />
        <Stat label="committed" value={rupees(outcome.policy.consumedAmountInPaisa)} />
        <Stat
          label="reserved"
          value={rupees(outcome.policy.reservedAmountInPaisa)}
          tone={outcome.policy.reservedAmountInPaisa === 0 ? undefined : "warn"}
        />
        <Stat label="gateway calls" value={String(outcome.gatewayCallsMade)} />
      </dl>

      <ol className="space-y-1.5">
        {outcome.steps.map((step, index) => (
          <ScenarioStepLine key={index} index={index + 1} step={step} />
        ))}
      </ol>
    </div>
  );
}

function ScenarioStepLine({ index, step }: { index: number; step: ScenarioStepReport }) {
  const result = step.result;
  return (
    <li className="flex gap-2 border-l border-razorpay-400 pl-2.5 text-[11px]">
      <span className="tabular shrink-0 text-neutral-500">{index}.</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-neutral-200">{step.label}</span>
          {result ? <ResultChip result={result} /> : null}
        </div>
        {step.note ? (
          <p className="mt-0.5 leading-relaxed text-neutral-400">{displayMoneyText(step.note)}</p>
        ) : null}
      </div>
    </li>
  );
}

function ResultChip({ result }: { result: TransactionResult }) {
  if (result.success) {
    return (
      <Badge tone={result.replayed ? "info" : "ok"}>
        {result.replayed ? "replayed" : "executed"} {result.orderId}
      </Badge>
    );
  }
  // A chip has no room for a sentence, so it carries the short label and the
  // full plain-language explanation rides along as the tooltip.
  return (
    <Badge
      tone={result.code === "PENDING_HUMAN_APPROVAL" ? "warn" : "bad"}
      title={errorMessage(result.code)}
    >
      {errorLabel(result.code)}
    </Badge>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <div>
      <dt className="font-display text-[10px] uppercase tracking-[0.1em] text-neutral-400">
        {label}
      </dt>
      <dd className={`tabular ${tone === "warn" ? "text-amber-300" : "text-neutral-200"}`}>
        {value}
      </dd>
    </div>
  );
}

function LiveActionRow({
  action,
  busy,
  disabled,
  onRun,
}: {
  action: LiveDemoAction;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-white/[0.08] bg-[#0B0F19]/70 px-3.5 py-3 hover:border-razorpay-500/30 transition-all">
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-semibold text-white">{action.label}</span>
        <p className="mt-0.5 text-xs leading-relaxed text-neutral-400">{action.description}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
          <span className="text-neutral-400 font-semibold">Expected: </span>
          {action.expectedOutcome}
        </p>
      </div>
      <Button size="sm" tone="primary" onClick={onRun} disabled={disabled} className="px-3 py-1.5 text-xs font-semibold">
        {busy ? (
          <span className="flex items-center gap-1">
            <Loader2 size={10} className="animate-spin" /> running
          </span>
        ) : (
          "Propose Order"
        )}
      </Button>
    </div>
  );
}

/** Rendered separately so the injection scenario's evidence is inspectable. */
export function InjectionEvidence({ outcome }: { outcome: ScenarioOutcome | null }) {
  const reports = outcome?.detail?.sanitizationReports as
    | Array<{
        itemId: string;
        attackVector: string;
        injectionGoal: string;
        sanitized: string;
        matchedDenylistPhrases: string[];
        removedZeroWidthCount: number;
        strippedHtmlConstructCount: number;
        escapedEnclave: boolean;
      }>
    | undefined;

  if (!reports || reports.length === 0) {
    return (
      <EmptyState>
        Run the prompt-injection scenario to see each hostile payload and what survived
        sanitization.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-2.5">
      {reports.map((report) => (
        <div key={report.itemId} className="rounded-xl border border-white/[0.08] bg-[#0B0F19]/80 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tabular font-mono text-xs text-neutral-300 font-semibold">{report.itemId}</span>
            <Badge tone="info">{report.attackVector}</Badge>
            <Badge tone={report.escapedEnclave ? "bad" : "ok"}>
              {report.escapedEnclave ? "ENCLAVE ESCAPED" : "enclave intact"}
            </Badge>
            {report.matchedDenylistPhrases.length > 0 ? (
              <Badge tone="warn">
                {report.matchedDenylistPhrases.length} denylist hit
                {report.matchedDenylistPhrases.length === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge tone="neutral" title="The regex denylist does not see this payload at all.">
                denylist blind
              </Badge>
            )}
            {report.removedZeroWidthCount > 0 ? (
              <Badge tone="neutral">{report.removedZeroWidthCount} zero-width removed</Badge>
            ) : null}
            {report.strippedHtmlConstructCount > 0 ? (
              <Badge tone="neutral">{report.strippedHtmlConstructCount} tags stripped</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
            <span className="text-neutral-500">attacker wants: </span>
            {report.injectionGoal}
          </p>
          <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-razorpay-500/20 bg-ink-950 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-neutral-300">
            {report.sanitized}
          </pre>
        </div>
      ))}
    </div>
  );
}
