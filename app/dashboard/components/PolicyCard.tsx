"use client";

import { ShieldCheck, AlertTriangle, KeyRound } from "lucide-react";
import type { PolicyView } from "@/runtime/agentGuardRuntime";
import { Badge, Card, Field, Relative, type Tone } from "./ui";
import { dateTime, percentOf, rupees } from "../lib/format";

const STATUS_TONE: Record<string, Tone> = {
  ACTIVE: "ok",
  PENDING_HUMAN_APPROVAL: "warn",
  EXPIRED_UNAPPROVED: "warn",
  EXHAUSTED: "bad",
  REVOKED: "bad",
};

export function PolicyCard({ policy }: { policy: PolicyView | null }) {
  if (!policy) {
    return (
      <Card title="Authorization Mandate Policy" icon={<ShieldCheck size={16} className="text-razorpay-400" />}>
        <p className="text-xs text-neutral-400">No authorization registered.</p>
      </Card>
    );
  }

  const { maxAmountInPaisa, consumedAmountInPaisa, reservedAmountInPaisa } = policy;
  const consumedPct = percentOf(consumedAmountInPaisa, maxAmountInPaisa);
  const reservedPct = percentOf(reservedAmountInPaisa, maxAmountInPaisa);
  const thresholdPct = percentOf(policy.requiresHumanApprovalAbovePaisa, maxAmountInPaisa);
  const overCommitted = consumedAmountInPaisa + reservedAmountInPaisa > maxAmountInPaisa;

  return (
    <Card
      title="Authorization Mandate Policy"
      subtitle={policy.purpose}
      icon={<ShieldCheck size={16} className="text-razorpay-400" />}
      actions={
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONE[policy.status] ?? "neutral"}>{policy.status}</Badge>
          <Badge
            tone={policy.signatureValid ? "ok" : "bad"}
            title={
              policy.signatureValid
                ? "The signed constraints recompute — the cap the engine reads is the cap the user granted."
                : "SIGNATURE MISMATCH — the constraints have been altered since issuance."
            }
          >
            <KeyRound size={10} />
            {policy.signatureValid ? "HMAC Valid" : "Tampered"}
          </Badge>
        </div>
      }
      className="border-razorpay-500/20 bg-[#11192E]/95 shadow-xl backdrop-blur-md"
    >
      {/* Ledger bar: committed vs reserved */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-[10.5px] uppercase tracking-wider font-semibold text-neutral-400">
            Mandate Budget Ledger
          </span>
          <span className="tabular font-mono text-xs font-semibold text-neutral-300">
            {rupees(consumedAmountInPaisa + reservedAmountInPaisa)}
            <span className="text-neutral-500"> / </span>
            {rupees(maxAmountInPaisa)}
          </span>
        </div>

        <div className="relative h-4 w-full overflow-hidden rounded-full border border-white/[0.08] bg-neutral-900">
          {/* Committed spend */}
          <div
            className="absolute inset-y-0 left-0 bg-emerald-500 rounded-l-full"
            style={{ width: `${consumedPct}%` }}
            title={`Committed: ${rupees(consumedAmountInPaisa)}`}
          />
          {/* In-flight reservation */}
          <div
            className="absolute inset-y-0 border-l border-amber-300/40 bg-amber-500/50"
            style={{
              left: `${consumedPct}%`,
              width: `${reservedPct}%`,
              backgroundImage:
                "repeating-linear-gradient(135deg, rgba(255,255,255,0.22) 0 3px, transparent 3px 7px)",
            }}
            title={`Reserved (in escrow): ${rupees(reservedAmountInPaisa)}`}
          />
          {/* Human approval threshold */}
          {thresholdPct < 100 ? (
            <div
              className="absolute inset-y-0 w-0.5 bg-amber-400"
              style={{ left: `${thresholdPct}%` }}
              title={`Human approval required above ${rupees(policy.requiresHumanApprovalAbovePaisa)}`}
            />
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-neutral-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2.5 rounded-sm bg-emerald-500" />
            Committed: {rupees(consumedAmountInPaisa)}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2.5 rounded-sm bg-amber-500/60"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(135deg, rgba(255,255,255,0.3) 0 2px, transparent 2px 5px)",
              }}
            />
            Escrow: {rupees(reservedAmountInPaisa)}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-0.5 bg-amber-400" />
            Approval threshold: {rupees(policy.requiresHumanApprovalAbovePaisa)}
          </span>
        </div>

        {overCommitted ? (
          <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-rose-800 bg-rose-950/60 px-2.5 py-1.5 text-xs text-rose-300 font-medium">
            <AlertTriangle size={13} />
            INVARIANT BREACH: committed + reserved exceeds the cap.
          </p>
        ) : null}
      </div>

      {/* Financial Numbers */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-white/[0.06] pt-3 sm:grid-cols-4">
        <Field label="Cap (Max Limit)" value={rupees(maxAmountInPaisa)} />
        <Field label="Committed" value={rupees(consumedAmountInPaisa)} tone="ok" />
        <Field
          label="In Escrow"
          value={rupees(reservedAmountInPaisa)}
          tone={reservedAmountInPaisa > 0 ? "warn" : "muted"}
          title="Held against the cap while a quote is executed or human decides."
        />
        <Field
          label="Remaining Headroom"
          value={rupees(policy.remainingHeadroomInPaisa)}
          tone={policy.remainingHeadroomInPaisa === 0 ? "bad" : undefined}
        />
      </dl>

      {/* Mandate Meta */}
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-white/[0.06] pt-3 sm:grid-cols-4">
        <Field label="Authorization ID" value={policy.authorizationId} />
        <Field label="Principal User" value={policy.userId} />
        <Field
          label="Expires"
          value={
            <>
              {dateTime(policy.expiresAt)}{" "}
              <span className="text-neutral-400">
                (<Relative iso={policy.expiresAt} />)
              </span>
            </>
          }
        />
        <Field
          label="Orders Settled"
          value={policy.executedTransactionIds.length}
          title={policy.executedTransactionIds.join("\n") || "none yet"}
        />
        <div className="col-span-2 rounded-lg bg-neutral-900/50 p-2.5 border border-white/[0.04]">
          <dt className="text-[10px] uppercase tracking-wider font-semibold text-neutral-400">
            Allowed Categories
          </dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {policy.allowedCategories.map((category) => (
              <Badge key={category} tone="info">
                {category}
              </Badge>
            ))}
          </dd>
        </div>
        <div className="col-span-2 rounded-lg bg-neutral-900/50 p-2.5 border border-white/[0.04]">
          <dt className="text-[10px] uppercase tracking-wider font-semibold text-neutral-400">
            Allowed Merchants
          </dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {policy.allowedMerchants.map((merchant) => (
              <Badge key={merchant} tone="info">
                {merchant}
              </Badge>
            ))}
          </dd>
        </div>
      </dl>

      <p className="mt-3 border-t border-white/[0.06] pt-2.5 text-[10.5px] leading-relaxed text-neutral-400">
        Constraints are HMAC-signed at issuance with server secret. Nonce{" "}
        <span className="tabular font-mono text-neutral-300">{policy.nonce}</span>, signature{" "}
        <span className="tabular font-mono text-neutral-300">{policy.signaturePreview}</span>.
      </p>
    </Card>
  );
}
