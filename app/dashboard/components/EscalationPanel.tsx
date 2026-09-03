"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Loader2, PenLine, Timer, UserCheck, ShieldAlert } from "lucide-react";
import type { PendingEscalationView } from "@/runtime/agentGuardRuntime";
import { Badge, Button, Card, EmptyState, FOCUS_RING } from "./ui";
import { rupees, shortHash } from "../lib/format";
import { DEFAULT_APPROVER_ID } from "../lib/constants";
import { useMotionKit } from "../lib/motion";

const APPROVER_INPUT_ID = "active-approver-id";

/**
 * Human-in-the-loop control.
 *
 * A pending escalation is holding budget in `reserved`, not `consumed` — nothing has
 * been charged. If nobody answers within 300 seconds the reservation is released on the
 * next proposal's step-0 sweep and the authorization is marked EXPIRED_UNAPPROVED.
 */
export function EscalationPanel({
  escalations,
  busyKey,
  approverId,
  onApproverIdChange,
  onDecide,
}: {
  escalations: PendingEscalationView[];
  busyKey: string | null;
  approverId: string;
  onApproverIdChange: (value: string) => void;
  onDecide: (
    escalation: PendingEscalationView,
    decision: "approve" | "deny",
  ) => void;
}) {
  const isModified = approverId.trim() !== DEFAULT_APPROVER_ID;

  return (
    <Card
      title="Human Approval Queue (Escalation Gate)"
      subtitle="Step 5 Gatekeeper: In-flight budget is reserved in escrow, not charged, pending human authorization."
      icon={<UserCheck size={16} className="text-amber-400" />}
      actions={
        escalations.length > 0 ? (
          <Badge tone="warn">
            <span className="pulse-dot mr-1 h-1.5 w-1.5 rounded-full bg-amber-400" />
            {escalations.length} {escalations.length === 1 ? "Escalation" : "Escalations"} Pending
          </Badge>
        ) : (
          <Badge tone="ok">Queue Idle</Badge>
        )
      }
      className="border-amber-500/20 bg-[#11192E]/95 shadow-xl backdrop-blur-md"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-[#0B0F19]/80 px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={APPROVER_INPUT_ID}
            className="font-display text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-400"
          >
            Active Approver ID
          </label>
          <input
            id={APPROVER_INPUT_ID}
            name="approverId"
            type="text"
            value={approverId}
            aria-label="Active Approver ID"
            aria-describedby={`${APPROVER_INPUT_ID}-hint`}
            onChange={(event) => onApproverIdChange(event.target.value)}
            className={`tabular w-48 rounded-md border bg-neutral-900 px-2.5 py-1 font-mono text-xs text-white transition-colors sm:w-64 ${FOCUS_RING} ${
              isModified
                ? "border-razorpay-500/70 shadow-[0_0_0_3px_rgba(0,102,255,0.12)]"
                : "border-white/[0.08] hover:border-neutral-600"
            }`}
            placeholder="approver identity"
          />
          {/* The field silently determines which identity signs the next HMAC
              token, so it says out loud when it is no longer the default. */}
          {isModified ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-razorpay-500/40 bg-razorpay-950/60 px-2 py-0.5 font-display text-[10px] font-medium uppercase tracking-[0.08em] text-razorpay-300">
              <PenLine size={9} />
              Modified
            </span>
          ) : null}
        </div>
        <span id={`${APPROVER_INPUT_ID}-hint`} className="text-[11px] text-neutral-400">
          {isModified
            ? "Approvals below will be signed as this identity."
            : "HMAC signed with server secret upon approval"}
        </span>
      </div>

      {escalations.length === 0 ? (
        <EmptyState>
          <div className="flex flex-col items-center justify-center py-2">
            <UserCheck size={28} className="mb-2 text-neutral-400" />
            <p className="font-medium text-neutral-300">No transactions currently awaiting human approval.</p>
            <p className="mt-1 text-[11.5px] text-neutral-400">
              Propose an item exceeding the approval threshold (e.g. ₹7,632.00 monitor) to trigger this gate.
            </p>
          </div>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {escalations.map((escalation) => (
            <EscalationRow
              key={escalation.idempotencyKey}
              escalation={escalation}
              busy={busyKey === escalation.idempotencyKey}
              disabled={busyKey !== null || approverId.trim().length === 0}
              onDecide={(decision) => onDecide(escalation, decision)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function useCountdown(expiresAt: string | null, seedSeconds: number | null): number | null {
  const [seconds, setSeconds] = useState(seedSeconds);

  useEffect(() => {
    if (expiresAt === null) {
      setSeconds(null);
      return;
    }
    const deadline = new Date(expiresAt).getTime();
    const tick = () => setSeconds(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return seconds;
}

function EscalationRow({
  escalation,
  busy,
  disabled,
  onDecide,
}: {
  escalation: PendingEscalationView;
  busy: boolean;
  disabled: boolean;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const motionKit = useMotionKit();
  const seconds = useCountdown(escalation.reservationExpiresAt, escalation.secondsRemaining);
  const urgent = seconds !== null && seconds <= 60 && seconds > 0;

  const amount = rupees(escalation.quotedAmountInPaisa);
  const subject = escalation.itemId ? `item ${escalation.itemId}` : "this proposal";
  const target = `${amount} for ${subject} on mandate ${escalation.authorizationId}`;

  const timerLabel =
    seconds === null
      ? "No expiry"
      : seconds === 0
        ? "Expired — sweep pending"
        : `${seconds}s TTL Remaining`;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-950/20 via-[#11192E] to-[#0F172A] p-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className="tabular font-mono text-xl font-extrabold text-amber-300">{amount}</span>
            {escalation.itemId ? (
              <span className="tabular rounded border border-white/[0.06] bg-neutral-900/80 px-2 py-0.5 font-mono text-xs text-neutral-300">
                Item: {escalation.itemId}
              </span>
            ) : null}
            {/* Under a minute the badge changes tone AND breathes, so urgency
                survives being glanced at from across a room. The pulse comes
                from the shared motion kit, which drops it under
                prefers-reduced-motion rather than looping regardless. */}
            <motion.span
              role="timer"
              aria-label={`Time remaining before this reservation is released: ${timerLabel}`}
              className="inline-flex"
              {...(urgent ? motionKit.loop([1, 1.05, 1], 1.4) : {})}
            >
              <Badge tone={urgent || seconds === 0 ? "bad" : "warn"}>
                <Timer size={10} />
                {timerLabel}
              </Badge>
            </motion.span>
          </div>
          <p className="mt-1 text-xs font-medium text-neutral-300">{escalation.purpose}</p>
          <p className="tabular mt-0.5 font-mono text-[11px] text-neutral-400">
            Idempotency Key: {shortHash(escalation.idempotencyKey, 16)} · Mandate: {escalation.authorizationId}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            tone="danger"
            onClick={() => onDecide("deny")}
            disabled={disabled}
            ariaLabel={`Deny and release ${target}`}
            title="Release the reservation and reject this proposal."
            className="px-3 py-1.5 text-xs font-semibold"
          >
            Deny & Release
          </Button>
          <Button
            size="sm"
            tone="primary"
            onClick={() => onDecide("approve")}
            disabled={disabled || !escalation.canResubmit}
            ariaLabel={`Approve and settle ${target}`}
            title={
              escalation.canResubmit
                ? "Issue single-use HMAC token bound to this proposal and settle with Razorpay."
                : "The original proposal is no longer in memory. Re-propose."
            }
            className="px-3 py-1.5 text-xs font-semibold"
          >
            {busy ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> Settling...
              </span>
            ) : (
              "Approve & Settle"
            )}
          </Button>
        </div>
      </div>

      {!escalation.canResubmit ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-800/40 bg-amber-950/40 p-2 text-xs text-amber-300">
          <ShieldAlert size={14} className="shrink-0" />
          <span>The reservation survived a restart, but proposal body did not. Deny to release or re-propose.</span>
        </div>
      ) : null}
    </div>
  );
}
