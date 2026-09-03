"use client";

import { useEffect, useState } from "react";

/**
 * Charts are a client-only artifact here.
 *
 * The donut's `ResponsiveContainer` measures its box in a layout effect, so it
 * renders nothing at all until after mount and then pops in at full size. The
 * gauge draws its arc from zero through a motion transition, so the server
 * markup is a complete-looking arc that immediately rewinds. Either way the
 * first paint lies about the state of the budget.
 *
 * Both charts therefore hold a placeholder of the same footprint until the
 * client has taken over, and swap once. `animate-pulse` is a CSS animation, so
 * the global `prefers-reduced-motion` block in globals.css already flattens it
 * — no separate gate needed here.
 */
export function useChartReady(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // One frame after mount, so the container has been measured before the
    // real chart is asked to lay itself out.
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return ready;
}

export function ChartSkeleton({
  shape,
  height,
  label,
}: {
  shape: "arc" | "ring";
  height: number;
  label: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex w-full animate-pulse items-center justify-center"
      style={{ height }}
    >
      {shape === "arc" ? <ArcPlaceholder /> : <RingPlaceholder />}
    </div>
  );
}

function ArcPlaceholder() {
  const size = 260;
  const strokeWidth = 18;
  const radius = (size - strokeWidth) / 2;

  return (
    <div className="relative flex items-center justify-center">
      <svg width={size} height={size / 2 + 30} viewBox={`0 0 ${size} ${size / 2 + 30}`}>
        <path
          d={`M ${strokeWidth / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2}`}
          fill="none"
          stroke="#1e2740"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute top-[52%] left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5">
        <span className="block h-7 w-24 rounded bg-neutral-800" />
        <span className="block h-2.5 w-28 rounded bg-neutral-800/70" />
      </div>
    </div>
  );
}

function RingPlaceholder() {
  return (
    <div className="relative flex items-center justify-center">
      <span className="block h-40 w-40 rounded-full border-[22px] border-neutral-800" />
      <div className="absolute flex flex-col items-center gap-1.5">
        <span className="block h-2.5 w-20 rounded bg-neutral-800/70" />
        <span className="block h-5 w-16 rounded bg-neutral-800" />
      </div>
    </div>
  );
}
