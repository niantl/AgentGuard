"use client";

import { useState } from "react";
import {
  FileWarning,
  Link2,
  Loader2,
  ScrollText,
  Search,
  ShieldCheck,
  ShieldX,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { ChainVerificationResult } from "@/logger/hashChainLogger";
import type { AuditLogBlock } from "@/types/agentGuard";
import { Badge, Button, Card, type Tone } from "./ui";
import { clockTime, shortHash } from "../lib/format";

const EVENT_TONE: Array<[RegExp, Tone]> = [
  [/^RAZORPAY_ORDER_CREATED$/, "ok"],
  [/^RESERVATION_COMMITTED$/, "ok"],
  [/^HUMAN_APPROVAL_ACCEPTED$/, "ok"],
  [/^(TRANSACTION_BLOCKED|RAZORPAY_API_ERROR|INVARIANT_VIOLATION_)/, "bad"],
  [/^HUMAN_APPROVAL_DENIED$/, "bad"],
  [/^(ESCALATED_TO_HUMAN|HUMAN_APPROVAL_TOKEN_ISSUED|RESERVATION_EXPIRED_RELEASED)/, "warn"],
  [/^(BUDGET_RESERVED|RESERVATION_RELEASED)$/, "reserved"],
  [/^(IDEMPOTENT_REPLAY|INTENT_PROPOSAL_RECEIVED)$/, "info"],
];

function eventTone(event: string): Tone {
  for (const [pattern, tone] of EVENT_TONE) {
    if (pattern.test(event)) return tone;
  }
  return "neutral";
}

export function AuditLogViewer({
  blocks,
  totalBlocks,
  integrity,
  tampered,
  verifying,
  tampering,
  lastVerifiedAt,
  onVerify,
  onTamper,
}: {
  blocks: AuditLogBlock[];
  totalBlocks: number;
  integrity: ChainVerificationResult;
  tampered: boolean;
  verifying: boolean;
  tampering: boolean;
  lastVerifiedAt: string | null;
  onVerify: () => void;
  onTamper: () => void;
  }) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? blocks.filter(
        (block) =>
          block.event.toLowerCase().includes(needle) ||
          block.authorizationId.toLowerCase().includes(needle) ||
          JSON.stringify(block.details).toLowerCase().includes(needle),
      )
    : blocks;

  return (
    <Card
      title="Cryptographic Hash Chain Ledger"
      subtitle={`${totalBlocks} immutable blocks. Each block binds its payload to the previous block's SHA-256 hash.`}
      icon={<ScrollText size={15} className="text-razorpay-400" />}
      actions={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            tone={tampered ? "primary" : "danger"}
            onClick={onTamper}
            disabled={tampering || verifying}
            title="DEMO: rewrite one historical block's details without recomputing its hash to demonstrate chain verification failure."
          >
            {tampering ? (
              <Loader2 size={11} className="animate-spin" />
            ) : tampered ? (
              "Restore Original Block"
            ) : (
              <span className="flex items-center gap-1.5">
                <FileWarning size={11} /> Simulate Tamper
              </span>
            )}
          </Button>
          <Button
            size="sm"
            tone="primary"
            onClick={onVerify}
            disabled={verifying}
            className="bg-gradient-to-r from-razorpay-600 to-razorpay-500 hover:from-razorpay-500 hover:to-razorpay-400 shadow-md shadow-razorpay-500/20 text-white font-medium"
          >
            {verifying ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> Verifying Chain...
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={12} /> Verify Chain
              </span>
            )}
          </Button>
        </div>
      }
      className="border-razorpay-500/20 bg-[#11192E]/95 shadow-xl backdrop-blur-md"
    >
      {/* Verification Status Banner */}
      <div
        className={`mb-4 flex flex-wrap items-start gap-3 rounded-xl border p-3.5 transition-all ${
          integrity.valid
            ? "border-emerald-500/40 bg-gradient-to-r from-emerald-950/40 to-[#0F172A] text-emerald-200"
            : "border-rose-500/50 bg-gradient-to-r from-rose-950/60 to-[#0F172A] text-rose-200 shadow-[0_0_20px_rgba(255,51,51,0.2)]"
        }`}
      >
        <span className={`p-2 rounded-lg ${integrity.valid ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}`}>
          {integrity.valid ? <ShieldCheck size={18} /> : <ShieldX size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              className={`text-[12.5px] font-bold ${
                integrity.valid ? "text-emerald-300" : "text-rose-300"
              }`}
            >
              {integrity.valid
                ? `Cryptographic Chain Intact (${integrity.blockCount} blocks verified)`
                : `Security Alert: Chain Integrity Broken at ${integrity.brokenAtEntryId ?? `Block #${integrity.brokenAtIndex}`}`}
            </p>
            {lastVerifiedAt ? (
              <span className="tabular text-[10.5px] font-mono text-neutral-400 bg-neutral-900/60 px-2 py-0.5 rounded border border-white/[0.06]">
                Recomputed at {clockTime(lastVerifiedAt)}
              </span>
            ) : null}
          </div>
          {!integrity.valid && integrity.reason ? (
            <p className="mt-1 text-[11.5px] leading-relaxed text-rose-200 bg-rose-950/40 p-2 rounded border border-rose-800/40 font-mono">
              {integrity.reason}
            </p>
          ) : (
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-400">
              Recomputed from genesis forward. Modifying any historical block invalidates all downstream hashes.
            </p>
          )}
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="relative mb-3">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter ledger by event, authorization ID, or payload detail…"
          className="w-full rounded-lg border border-white/[0.08] bg-[#0B0F19]/90 pl-8 pr-3 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-500 focus:border-razorpay-500 transition-colors"
        />
        {filter && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-neutral-400 font-mono">
            {visible.length} matches
          </span>
        )}
      </div>

      {/* High-Density Tabular Ledger */}
      <div className="rounded-lg border border-white/[0.06] bg-[#0B0F19]/60 overflow-hidden">
        <div className="hidden sm:grid grid-cols-12 gap-2 px-3 py-2 bg-neutral-900/80 border-b border-white/[0.06] text-[10.5px] uppercase tracking-wider font-semibold text-neutral-400">
          <span className="col-span-2 font-mono">Entry ID</span>
          <span className="col-span-2 font-mono">Time</span>
          <span className="col-span-3">Event</span>
          <span className="col-span-3">Authorization</span>
          <span className="col-span-2 font-mono text-right">Hash Link</span>
        </div>

        <div className="max-h-[28rem] divide-y divide-white/[0.04] overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-neutral-500">
              {blocks.length === 0 ? "No ledger entries recorded." : "No records match your filter."}
            </p>
          ) : (
            visible.map((block) => (
              <BlockRow
                key={block.entryId}
                block={block}
                broken={
                  !integrity.valid &&
                  integrity.brokenAtEntryId !== null &&
                  block.entryId === integrity.brokenAtEntryId
                }
              />
            ))
          )}
        </div>
      </div>

      {totalBlocks > blocks.length ? (
        <p className="mt-2.5 text-[10.5px] text-neutral-500 text-center">
          Displaying {blocks.length} most recent blocks out of {totalBlocks} total entries.
        </p>
      ) : null}
    </Card>
  );
}

function BlockRow({ block, broken }: { block: AuditLogBlock; broken: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`transition-colors text-[11.5px] ${
        broken ? "bg-rose-950/40 border-l-2 border-rose-500" : "hover:bg-neutral-800/40"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <div className="grid grid-cols-12 gap-2 w-full items-center">
          <span className="col-span-2 tabular font-mono text-[10.5px] text-neutral-400 truncate">
            {block.entryId}
          </span>
          <span className="col-span-2 tabular font-mono text-[10.5px] text-neutral-400">
            {clockTime(block.timestamp)}
          </span>
          <span className="col-span-3 truncate">
            <Badge tone={broken ? "bad" : eventTone(block.event)}>{block.event}</Badge>
          </span>
          <span className="col-span-3 tabular font-mono text-[10.5px] text-neutral-400 truncate">
            {block.authorizationId}
          </span>
          <div className="col-span-2 flex items-center justify-end gap-1.5 text-[10px] font-mono text-neutral-400">
            <Link2 size={10} className="text-razorpay-400 shrink-0" />
            <span className="truncate">{shortHash(block.currentHash, 8)}</span>
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </div>
        </div>
      </button>

      {open ? (
        <div className="border-t border-white/[0.06] bg-[#070A12] px-4 py-3">
          {broken ? (
            <div className="mb-2.5 rounded border border-rose-600/50 bg-rose-950/60 p-2 text-xs text-rose-300 flex items-center gap-2">
              <ShieldX size={14} className="shrink-0" />
              <span>Tamper detected: The stored SHA-256 hash does not match the recomputed content digest.</span>
            </div>
          ) : null}

          <p className="text-[10px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
            Canonical Block Payload (JSON)
          </p>
          <pre className="max-h-56 overflow-auto rounded-lg bg-[#0B0F19] border border-white/[0.06] p-2.5 font-mono text-[10.5px] leading-relaxed text-neutral-300">
            {JSON.stringify(block.details, null, 2)}
          </pre>

          <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px] font-mono text-neutral-400 bg-neutral-900/60 p-2 rounded border border-white/[0.04]">
            <div className="truncate">
              <span className="text-neutral-400 uppercase font-semibold mr-1">Prev:</span>
              <span className="text-neutral-300">{block.previousHash}</span>
            </div>
            <div className="truncate">
              <span className="text-neutral-400 uppercase font-semibold mr-1">Curr:</span>
              <span className="text-razorpay-300">{block.currentHash}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
