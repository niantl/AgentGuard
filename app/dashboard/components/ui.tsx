"use client";

import { useEffect, useState, type ReactNode } from "react";
import { relativeFromNow } from "../lib/format";

/** Small presentational primitives shared by the dashboard panels, adhering to Razorpay fintech aesthetics. */

export function Card({
  title,
  subtitle,
  icon,
  actions,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-white/[0.08] bg-[#11192E]/95 shadow-xl backdrop-blur-md transition-all hover:border-razorpay-500/25 ${className}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          {icon ? <span className="text-razorpay-400 shrink-0">{icon}</span> : null}
          <div>
            <h2 className="text-[13.5px] font-semibold tracking-wide text-white">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[11px] text-neutral-400">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "reserved";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-neutral-700/70 bg-neutral-800/80 text-neutral-300",
  ok: "border-emerald-500/40 bg-emerald-950/60 text-emerald-300 shadow-[0_0_8px_rgba(0,179,134,0.15)]",
  warn: "border-amber-500/40 bg-amber-950/60 text-amber-300 shadow-[0_0_8px_rgba(255,184,0,0.15)]",
  bad: "border-rose-500/40 bg-rose-950/60 text-rose-300 shadow-[0_0_8px_rgba(255,51,51,0.15)]",
  info: "border-razorpay-500/40 bg-razorpay-950/60 text-razorpay-300",
  reserved: "border-violet-500/40 bg-violet-950/60 text-violet-300",
};

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = "neutral",
  size = "md",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "neutral" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  title?: string;
  className?: string;
}) {
  const tones = {
    neutral:
      "border-white/[0.08] bg-neutral-800/80 text-neutral-200 hover:bg-neutral-700 hover:border-neutral-600 hover:text-white active:scale-[0.98]",
    primary:
      "border-razorpay-400/40 bg-gradient-to-r from-razorpay-600 to-razorpay-500 text-white shadow-md shadow-razorpay-500/20 hover:from-razorpay-500 hover:to-razorpay-400 active:scale-[0.98]",
    danger:
      "border-rose-600/50 bg-rose-950/70 text-rose-200 hover:bg-rose-900/70 hover:border-rose-500 active:scale-[0.98]",
    ghost: "border-transparent bg-transparent text-neutral-400 hover:text-white hover:bg-white/[0.05]",
  } as const;
  const sizes = { sm: "px-2.5 py-1 text-[11px]", md: "px-3 py-1.5 text-[12px]" } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg border font-medium transition-all disabled:cursor-not-allowed disabled:opacity-45 ${tones[tone]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  value,
  tone,
  mono = true,
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: "ok" | "warn" | "bad" | "muted";
  mono?: boolean;
  title?: string;
}) {
  const valueTone =
    tone === "ok"
      ? "text-emerald-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-300"
          : tone === "muted"
            ? "text-neutral-500"
            : "text-neutral-200";
  return (
    <div title={title} className="rounded-lg bg-neutral-900/50 p-2.5 border border-white/[0.04]">
      <dt className="text-[10px] uppercase tracking-wider text-neutral-400 font-semibold">{label}</dt>
      <dd className={`mt-0.5 ${mono ? "tabular font-mono" : ""} text-[12px] ${valueTone}`}>{value}</dd>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/[0.08] bg-neutral-900/40 px-4 py-8 text-center text-[12px] text-neutral-400">
      {children}
    </div>
  );
}

/**
 * Relative time formatter rendered only after mount to prevent SSR hydration mismatch.
 */
export function Relative({ iso, prefix = "" }: { iso: string; prefix?: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const update = () => setLabel(relativeFromNow(iso));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [iso]);

  if (label === null) return null;
  return (
    <>
      {prefix}
      {label}
    </>
  );
}
