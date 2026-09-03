"use client";

import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { relativeFromNow } from "../lib/format";
import { SPRING_SNAP, useMotionKit } from "../lib/motion";

/** Small presentational primitives shared by the dashboard panels, adhering to Razorpay fintech aesthetics. */

/**
 * Shared focus treatment. Every interactive element in the dashboard opts into
 * this instead of relying on the browser default, which was invisible against
 * the navy surfaces. `outline-none` is safe here precisely because a ring
 * replaces it — the global `:focus-visible` outline in globals.css remains the
 * fallback for anything that has not adopted this.
 *
 * One ring, two offset colours: the offset is a gap punched in the ring, so it
 * has to match whatever is actually behind the element or it reads as a stray
 * dark halo. `FOCUS_RING` assumes a card; `FOCUS_RING_PAGE` is for controls
 * sitting directly on the page background, like the tab strip.
 */
const FOCUS_RING_BASE =
  "outline-none focus-visible:ring-2 focus-visible:ring-razorpay-400 focus-visible:ring-offset-2";

export const FOCUS_RING = `${FOCUS_RING_BASE} focus-visible:ring-offset-card`;
export const FOCUS_RING_PAGE = `${FOCUS_RING_BASE} focus-visible:ring-offset-page`;

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
      className={`rounded-xl border border-white/[0.08] bg-[#11192E]/95 shadow-xl backdrop-blur-md transition-colors hover:border-razorpay-500/25 ${className}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          {icon ? <span className="shrink-0 text-razorpay-400">{icon}</span> : null}
          <div>
            <h2 className="font-display text-[14px] font-semibold tracking-[-0.01em] text-white">
              {title}
            </h2>
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-display text-[10px] font-medium uppercase tracking-[0.08em] ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Ring colour per tone — a blue ring on the blue primary button would vanish. */
const RING_BY_TONE = {
  neutral: "focus-visible:ring-razorpay-400",
  primary: "focus-visible:ring-white",
  danger: "focus-visible:ring-rose-300",
  ghost: "focus-visible:ring-razorpay-400",
} as const;

export function Button({
  children,
  onClick,
  disabled,
  tone = "neutral",
  size = "md",
  title,
  ariaLabel,
  ariaExpanded,
  ariaControls,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "neutral" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  title?: string;
  /** Required whenever the visible label alone does not identify the target. */
  ariaLabel?: string;
  ariaExpanded?: boolean;
  ariaControls?: string;
  className?: string;
}) {
  const motionKit = useMotionKit();
  const tones = {
    neutral:
      "border-white/[0.08] bg-neutral-800/80 text-neutral-200 hover:bg-neutral-700 hover:border-neutral-600 hover:text-white",
    primary:
      "border-razorpay-400/40 bg-gradient-to-r from-razorpay-600 to-razorpay-500 text-white shadow-md shadow-razorpay-500/20 hover:from-razorpay-500 hover:to-razorpay-400",
    danger:
      "border-rose-600/50 bg-rose-950/70 text-rose-200 hover:bg-rose-900/70 hover:border-rose-500",
    ghost: "border-transparent bg-transparent text-neutral-400 hover:text-white hover:bg-white/[0.05]",
  } as const;
  const sizes = { sm: "px-2.5 py-1 text-[11px]", md: "px-3 py-1.5 text-[12px]" } as const;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      // Spring press feedback rather than a CSS `active:scale`, so an
      // interrupted press decays instead of snapping.
      whileHover={disabled || motionKit.reduced ? undefined : { y: -1 }}
      whileTap={disabled || motionKit.reduced ? undefined : { scale: 0.97, y: 0 }}
      transition={motionKit.t(SPRING_SNAP)}
      className={`rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS_RING} ${RING_BY_TONE[tone]} ${tones[tone]} ${sizes[size]} ${className}`}
    >
      {children}
    </motion.button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <input
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={`rounded-lg border border-white/[0.08] bg-neutral-900/70 px-2.5 py-1.5 text-[12px] text-neutral-100 transition-colors placeholder:text-neutral-500 hover:border-neutral-600 focus-visible:border-razorpay-500 ${FOCUS_RING} ${className}`}
    />
  );
}

/**
 * A label/value pair from the spec sheet. Deliberately unboxed — an earlier
 * version filled and bordered each pair, which stacked a card inside a card and
 * made dense panels read as a pile of chips rather than one table of facts.
 */
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
            ? "text-neutral-400"
            : "text-neutral-100";
  return (
    <div title={title} className="border-t border-white/[0.07] pt-2">
      <dt className="font-display text-[10px] font-medium uppercase tracking-[0.1em] text-neutral-400">
        {label}
      </dt>
      <dd className={`mt-1 ${mono ? "tabular font-mono" : ""} text-[12px] ${valueTone}`}>{value}</dd>
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
