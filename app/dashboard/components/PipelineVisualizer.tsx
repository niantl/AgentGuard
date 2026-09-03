"use client";

import { motion } from "motion/react";
import {
  Check,
  ChevronRight,
  CircleDashed,
  MinusCircle,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  X,
} from "lucide-react";
import type { PipelineStep, PipelineStepStatus } from "@/types/agentGuard";
import type { LastRunRecord } from "@/runtime/agentGuardRuntime";
import { Badge, Card, type Tone } from "./ui";
import { clockTime, displayMoneyText, humanizeCode } from "../lib/format";
import { errorLabel, errorMessage } from "../lib/errorMessages";
import { useMotionKit } from "../lib/motion";

/**
 * The canonical seven-step decision pipeline from engine/guardrailEngine.ts (lines 49-57).
 * Steps are evaluated in strict sequence; the first failure immediately stops execution.
 */
const CANONICAL_STEPS: Array<{ step: number; name: string; description: string }> = [
  {
    step: 0,
    name: "Expired reservation sweep",
    description: "Releases stale in-flight reservations past 300s TTL before processing new proposals.",
  },
  {
    step: 1,
    name: "Idempotency guard",
    description: "Locks idempotency key, prevents concurrent mutations, and replays cached results on duplicate submissions.",
  },
  {
    step: 2,
    name: "Rate limit / agent loop guard",
    description: "Enforces max 5 proposals per 10-minute rolling window per authorization.",
  },
  {
    step: 3,
    name: "Policy constraint checks",
    description: "Validates active status, expiration timestamp, category allowlist, and merchant allowlist.",
  },
  {
    step: 4,
    name: "Quote fetch + atomic budget reservation",
    description: "Fetches cart quote and atomically verifies per-transaction cap & cumulative headroom before reserving.",
  },
  {
    step: 5,
    name: "Human escalation gate",
    description: "Evaluates approval threshold, verifies HMAC signature if resubmitted, or holds reservation in escrow.",
  },
  {
    step: 6,
    name: "Signed gateway execution",
    description: "Signs execution payload with server secret, creates Razorpay order, and commits reserved budget to consumed.",
  },
];

const STATUS_META: Record<
  PipelineStepStatus,
  {
    tone: Tone;
    icon: typeof Check;
    label: string;
    nodeBg: string;
    nodeBorder: string;
    textColor: string;
    lineColor: string;
  }
> = {
  PASSED: {
    tone: "ok",
    icon: Check,
    label: "passed",
    nodeBg: "bg-emerald-950/80",
    nodeBorder: "border-emerald-500/60 shadow-[0_0_12px_rgba(0,179,134,0.35)]",
    textColor: "text-emerald-400",
    lineColor: "bg-emerald-500/60",
  },
  FAILED: {
    tone: "bad",
    icon: X,
    label: "blocked",
    nodeBg: "bg-rose-950/80",
    nodeBorder: "border-rose-500/70 shadow-[0_0_12px_rgba(255,51,51,0.35)]",
    textColor: "text-rose-400",
    lineColor: "bg-rose-500/60",
  },
  ESCALATED: {
    tone: "warn",
    icon: UserCheck,
    label: "escalated",
    nodeBg: "bg-amber-950/80",
    nodeBorder: "border-amber-500/70 shadow-[0_0_12px_rgba(255,184,0,0.35)]",
    textColor: "text-amber-400",
    lineColor: "bg-amber-500/60",
  },
  SKIPPED: {
    tone: "info",
    icon: MinusCircle,
    label: "skipped",
    nodeBg: "bg-blue-950/50",
    nodeBorder: "border-blue-500/40",
    textColor: "text-blue-400",
    lineColor: "bg-blue-500/40",
  },
  NOT_REACHED: {
    tone: "neutral",
    icon: CircleDashed,
    label: "standby",
    nodeBg: "bg-neutral-900/60",
    nodeBorder: "border-neutral-700/60",
    // 4.69:1 on the card surface. Subordinate to the active states, but still
    // legible — a step that was never reached is information, not decoration.
    textColor: "text-neutral-500",
    lineColor: "bg-neutral-800",
  },
};

function outcomeTone(record: LastRunRecord): Tone {
  if (record.outcome === "EXECUTED" || record.outcome === "SCENARIO_PASSED") return "ok";
  if (record.outcome === "REPLAYED") return "info";
  if (record.outcome === "PENDING_HUMAN_APPROVAL") return "warn";
  return "bad";
}

export function PipelineVisualizer({ lastRun }: { lastRun: LastRunRecord | null }) {
  const motionKit = useMotionKit();
  return (
    <Card
      title="Deterministic Guardrail Pipeline"
      subtitle="Seven sequential gates in engine/guardrailEngine.ts. The first gate that trips halts execution immediately."
      icon={<ChevronRight size={14} className="text-razorpay-400" />}
      actions={
        lastRun ? (
          <div className="flex items-center gap-2">
            <Badge tone={outcomeTone(lastRun)}>{lastRun.outcome}</Badge>
            <span className="tabular text-[11px] text-neutral-400 bg-neutral-800/80 px-2 py-0.5 rounded border border-neutral-700">
              {clockTime(lastRun.at)}
            </span>
          </div>
        ) : (
          <Badge tone="neutral">Engine Ready</Badge>
        )
      }
      className="border-razorpay-500/20 bg-[#11192E]/95 shadow-xl backdrop-blur-md"
    >
      {!lastRun ? (
        <div className="py-3">
          <div className="mb-4 flex items-center justify-between rounded-lg border border-razorpay-500/20 bg-razorpay-950/20 px-3.5 py-2.5">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="h-4 w-4 text-razorpay-400 shrink-0" />
              <p className="text-[12px] text-neutral-300">
                Awaiting proposal execution. The 7 deterministic gates below will trace each step in real time.
              </p>
            </div>
            <span className="text-[11px] font-medium text-razorpay-400 uppercase tracking-wider">
              7 Active Gates
            </span>
          </div>

          <ol className="space-y-0">
            {CANONICAL_STEPS.map((step, index) => (
              <StandbyStepRow
                key={step.step}
                step={step}
                isLast={index === CANONICAL_STEPS.length - 1}
              />
            ))}
          </ol>
        </div>
      ) : (
        <div className="py-1">
          {/* Active run summary pill bar */}
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-neutral-900/60 p-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-white">{lastRun.label}</span>
              {lastRun.orderId ? (
                <span className="tabular rounded bg-emerald-950/60 border border-emerald-700/50 px-2 py-0.5 text-[11px] font-mono text-emerald-300">
                  {lastRun.orderId}
                </span>
              ) : null}
              {lastRun.code ? (
                <span
                  title={errorMessage(lastRun.code)}
                  className="rounded border border-rose-700/50 bg-rose-950/60 px-2 py-0.5 text-[11px] font-medium text-rose-300"
                >
                  {errorLabel(lastRun.code)}
                </span>
              ) : null}
            </div>

            <div className="text-[11px] text-neutral-400">
              Evaluated {lastRun.steps.filter((s) => s.status !== "NOT_REACHED").length} of 7 gates
            </div>
          </div>

          {/* Sequential step track */}
          <ol className="space-y-0">
            {lastRun.steps.map((step, index) => (
              <StepRow
                key={step.step}
                step={step}
                isLast={index === lastRun.steps.length - 1}
                index={index}
              />
            ))}
          </ol>

          {/* Verdict callout */}
          {lastRun.reason ? (
            <motion.div
              {...motionKit.rise(0, 8)}
              className={`mt-4 flex items-start gap-3 rounded-lg border p-3 text-[11.5px] leading-relaxed ${
                lastRun.outcome === "EXECUTED" || lastRun.outcome === "SCENARIO_PASSED"
                  ? "border-emerald-500/30 bg-emerald-950/30 text-emerald-200"
                  : lastRun.outcome === "PENDING_HUMAN_APPROVAL"
                    ? "border-amber-500/30 bg-amber-950/30 text-amber-200"
                    : "border-rose-500/30 bg-rose-950/30 text-rose-200"
              }`}
            >
              <div className="mt-0.5 shrink-0">
                {lastRun.outcome === "EXECUTED" || lastRun.outcome === "SCENARIO_PASSED" ? (
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-rose-400" />
                )}
              </div>
              <div>
                <span className="font-semibold uppercase tracking-wider text-[10px] block mb-0.5">
                  {lastRun.code ? humanizeCode(lastRun.code) : "Pipeline Verdict"}
                </span>
                {displayMoneyText(lastRun.reason)}
              </div>
            </motion.div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function StepRow({
  step,
  isLast,
  index,
}: {
  step: PipelineStep;
  isLast: boolean;
  index: number;
}) {
  const motionKit = useMotionKit();
  const meta = STATUS_META[step.status];
  const Icon = meta.icon;
  const isNotReached = step.status === "NOT_REACHED";

  return (
    <motion.li {...motionKit.slideIn(index, 8)} className="flex gap-3">
      {/* Logistics connector rail */}
      <div className="flex flex-col items-center pt-0.5">
        <motion.span
          {...(step.status === "ESCALATED" ? motionKit.loop([1, 1.15, 1]) : {})}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${meta.nodeBg} ${meta.nodeBorder} ${meta.textColor}`}
        >
          <Icon size={12} strokeWidth={2.8} />
        </motion.span>
        {!isLast ? (
          <span
            className={`w-0.5 flex-1 min-h-[22px] transition-colors ${
              isNotReached ? "bg-neutral-800" : meta.lineColor
            }`}
          />
        ) : null}
      </div>

      {/* Step details.
          A not-reached step is recessed by colour alone. It used to be wrapped
          in `opacity-40`, which multiplied through every child and dropped the
          label under 2:1 against the card — a fine look, an unreadable one. */}
      <div className="flex-1 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`tabular rounded bg-neutral-800/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
              isNotReached ? "text-neutral-500" : "text-neutral-400"
            }`}
          >
            0{step.step}
          </span>
          <span
            className={`text-[12.5px] font-medium ${
              isNotReached ? "text-neutral-400" : "text-neutral-100"
            }`}
          >
            {step.name}
          </span>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
            {step.detail ? (
          <p
            className={`mt-1 text-[11.5px] font-normal leading-relaxed ${
              isNotReached ? "text-neutral-500" : "text-neutral-400"
            }`}
          >
            {displayMoneyText(step.detail)}
          </p>
        ) : null}
      </div>
    </motion.li>
  );
}

function StandbyStepRow({
  step,
  isLast,
}: {
  step: { step: number; name: string; description: string };
  isLast: boolean;
}) {
  return (
    // No blanket opacity here either: the standby track is the first thing on
    // screen before any run, so it has to be readable at rest, not on hover.
    <li className="flex gap-3">
      <div className="flex flex-col items-center pt-0.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-500">
          <CircleDashed size={12} strokeWidth={2} />
        </span>
        {!isLast ? <span className="w-0.5 flex-1 min-h-[22px] bg-neutral-800" /> : null}
      </div>

      <div className="flex-1 pb-3">
        <div className="flex items-center gap-2">
          <span className="tabular font-mono text-[10px] font-semibold text-neutral-400 bg-neutral-800/60 px-1.5 py-0.5 rounded">
            0{step.step}
          </span>
          <span className="text-[12px] font-medium text-neutral-300">{step.name}</span>
          <span className="rounded border border-neutral-700/50 px-1.5 py-0.5 font-display text-[9.5px] uppercase tracking-[0.08em] text-neutral-400">
            standby
          </span>
        </div>
        <p className="mt-0.5 text-[11px] text-neutral-400">{step.description}</p>
      </div>
    </li>
  );
}
