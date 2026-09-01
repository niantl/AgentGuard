"use client";

import { useEffect, useState } from "react";
import { Loader2, Timer, UserCheck, ShieldAlert } from "lucide-react";
import type { PendingEscalationView } from "@/runtime/agentGuardRuntime";
import { Badge, Button, Card, EmptyState } from "./ui";
import { rupees, shortHash } from "../lib/format";

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
  return (
    <Card
      title="Human Approval Queue (Escalation Gate)"
      subtitle="Step 5 Gatekeeper: In-flight budget is reserved in escrow, not charged, pending human authorization."
      icon={<UserCheck size={16} className="text-amber-400" />}
      actions={
        escalations.length > 0 ? (
          <Badge tone="warn">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 pulse-dot mr-1" />
            {escalations.length} {escalations.length === 1 ? "Escalation" : "Escalations"} Pending
          </Badge>
        ) : (
          <Badge tone="ok">Queue Idle</Badge>
        )
      }
      className="border-amber-500/20 bg-[#11192E]/95 shadow-xl backdrop-blur-md"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-[#0B0F19]/80 px-3.5 py-2.5">
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          <span className="uppercase tracking-wider font-semibold text-[10px] text-neutral-400">
            Active Approver ID:
          </span>
          <input
            value={approverId}
            onChange={(event) => onApproverIdChange(event.target.value)}
            className="tabular font-mono rounded-md border border-white/[0.08] bg-neutral-900 px-2.5 py-1 text-xs text-white outline-none focus:border-razorpay-500 transition-colors w-48 sm:w-64"
            placeholder="approver identity"
          />
        </label>
        <span className="text-[11px] text-neutral-400">
          HMAC signed with server secret upon approval
        </span>
      </div>

      {escalations.length === 0 ? (
        <EmptyState>
          <div className="flex flex-col items-center justify-center py-2">
            <UserCheck size={28} className="text-neutral-400 mb-2" />
            <p className="font-medium text-neutral-300">No transactions currently awaiting human approval.</p>
            <p className="text-[11.5px] text-neutral-400 mt-1">
              Propose an item exceeding the approval threshold (e.g. ₹7,632 monitor) to trigger this gate.
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
  const seconds = useCountdown(escalation.reservationExpiresAt, escalation.secondsRemaining);
  const urgent = seconds !== null && seconds <= 60;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-950/20 via-[#11192E] to-[#0F172A] p-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2.5">
            <span className="tabular font-mono text-xl font-extrabold text-amber-300">
              {rupees(escalation.quotedAmountInPaisa)}
            </span>
            {escalation.itemId ? (
              <span className="tabular font-mono text-xs text-neutral-300 bg-neutral-900/80 px-2 py-0.5 rounded border border-white/[0.06]">
                Item: {escalation.itemId}
              </span>
            ) : null}
            <Badge tone={urgent ? "bad" : "warn"}>
              <Timer size={10} />
              {seconds === null
                ? "No expiry"
                : seconds === 0
                  ? "Expired — sweep pending"
                  : `${seconds}s TTL Remaining`}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-neutral-300 font-medium">{escalation.purpose}</p>
          <p className="tabular mt-0.5 text-[11px] font-mono text-neutral-400">
            Idempotency Key: {shortHash(escalation.idempotencyKey, 16)} · Mandate: {escalation.authorizationId}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            tone="danger"
            onClick={() => onDecide("deny")}
            disabled={disabled}
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
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-950/40 p-2 text-xs text-amber-300 border border-amber-800/40">
          <ShieldAlert size={14} className="shrink-0" />
          <span>The reservation survived a restart, but proposal body did not. Deny to release or re-propose.</span>
        </div>
      ) : null}
    </div>
  );
}
