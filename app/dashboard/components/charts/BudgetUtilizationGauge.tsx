"use client";

import { motion } from "motion/react";
import { ShieldCheck, AlertTriangle, AlertCircle } from "lucide-react";
import { ChartSkeleton, useChartReady } from "./ChartSkeleton";
import { useMotionKit } from "../../lib/motion";
import { rupees } from "../../lib/format";

interface BudgetUtilizationGaugeProps {
  consumedPaisa: number;
  reservedPaisa: number;
  totalBudgetPaisa: number;
}

export function BudgetUtilizationGauge({
  consumedPaisa,
  reservedPaisa,
  totalBudgetPaisa,
}: BudgetUtilizationGaugeProps) {
  const motionKit = useMotionKit();
  const ready = useChartReady();
  const safeBudget = Math.max(totalBudgetPaisa, 1);
  const totalCommitted = consumedPaisa + reservedPaisa;
  const percentage = Math.min(Math.max((totalCommitted / safeBudget) * 100, 0), 100);
  const availablePaisa = Math.max(totalBudgetPaisa - totalCommitted, 0);

  // SVG dimensions for semi-circle gauge (180 degrees)
  const size = 260;
  const strokeWidth = 18;
  const radius = (size - strokeWidth) / 2;
  const circumference = Math.PI * radius; // half circle perimeter
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  // Determine Razorpay tone based on utilization
  const isCritical = percentage >= 90;
  const isWarning = percentage >= 70 && percentage < 90;
  
  const statusColor = isCritical
    ? "#FF3333" // Razorpay Ruby
    : isWarning
      ? "#FFB800" // Razorpay Amber
      : "#00B386"; // Razorpay Emerald

  const gradientId = "budget-gauge-gradient";

  return (
    <div className="flex flex-col items-center justify-between rounded-xl border border-white/[0.08] bg-[#11192E]/90 p-5 shadow-xl backdrop-blur-md">
      <div className="w-full flex items-center justify-between border-b border-white/[0.06] pb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Velocity & Budget Gauge</h3>
          <p className="text-[11px] text-neutral-400">Total exposure vs deterministic limit</p>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10.5px] font-medium border"
          style={{
            borderColor: `${statusColor}40`,
            backgroundColor: `${statusColor}15`,
            color: statusColor,
          }}
        >
          {isCritical ? (
            <AlertCircle size={12} />
          ) : isWarning ? (
            <AlertTriangle size={12} />
          ) : (
            <ShieldCheck size={12} />
          )}
          {isCritical ? "Cap Limit Critical" : isWarning ? "Elevated Velocity" : "Policy Compliant"}
        </span>
      </div>

      {/* SVG Semi-Radial Gauge */}
      {!ready ? (
        <div className="my-4 w-full">
          <ChartSkeleton shape="arc" height={size / 2 + 30} label="Loading budget gauge" />
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={motionKit.t({ duration: 0.25 })}
          className="relative my-4 flex items-center justify-center"
        >
          <svg
            width={size}
            height={size / 2 + 30}
            viewBox={`0 0 ${size} ${size / 2 + 30}`}
            className="overflow-visible"
          >
            <defs>
              <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#00B386" />
                <stop offset="70%" stopColor="#FFB800" />
                <stop offset="100%" stopColor="#FF3333" />
              </linearGradient>
            </defs>

            {/* Background track arc */}
            <path
              d={`M ${strokeWidth / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2}`}
              fill="none"
              stroke="#1e2740"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
            />

            {/* Foreground animated value arc */}
            <motion.path
              d={`M ${strokeWidth / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2}`}
              fill="none"
              stroke={`url(#${gradientId})`}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset }}
              transition={motionKit.t({ duration: 1.2, ease: "easeOut" })}
            />

            {/* Notch tick markers */}
            {[0, 25, 50, 75, 100].map((tick) => {
              const angle = Math.PI - (tick / 100) * Math.PI;
              const innerR = radius - 16;
              const outerR = radius - 24;
              const cx = size / 2;
              const cy = size / 2;
              const x1 = cx + innerR * Math.cos(angle);
              const y1 = cy - innerR * Math.sin(angle);
              const x2 = cx + outerR * Math.cos(angle);
              const y2 = cy - outerR * Math.sin(angle);

              return (
                <line
                  key={tick}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="#4d5c78"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              );
            })}

            {/* Animated Needle Indicator */}
            <motion.g
              initial={{ rotate: -90 }}
              animate={{ rotate: -90 + (percentage / 100) * 180 }}
              transition={motionKit.t({ duration: 1.2, ease: "easeOut" })}
              style={{ transformOrigin: "130px 130px" }}
            >
              {/* Needle shaft */}
              <line
                x1="130"
                y1="130"
                x2="130"
                y2="20"
                stroke={statusColor}
                strokeWidth="2.5"
                strokeLinecap="round"
                opacity="0.9"
              />
              {/* Glowing needle tip marker right at the arc */}
              <circle
                cx="130"
                cy="17"
                r="3.5"
                fill={statusColor}
              />
              {/* Center pivot hub */}
              <circle
                cx="130"
                cy="130"
                r="6.5"
                fill="#0B0F19"
                stroke={statusColor}
                strokeWidth="2"
              />
              <circle
                cx="130"
                cy="130"
                r="2.5"
                fill={statusColor}
              />
            </motion.g>
          </svg>

          {/* Center Readout Text */}
          <div className="absolute top-[52%] left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none z-10 bg-[#11192E]/80 backdrop-blur-sm px-3 py-1 rounded-lg border border-white/[0.04]">
            <span className="tabular font-mono text-3xl font-extrabold text-white tracking-tight">
              {percentage.toFixed(1)}%
            </span>
            <span className="mt-0.5 font-display text-[10.5px] font-medium uppercase tracking-[0.1em] text-neutral-400">
              Capacity Utilized
            </span>
          </div>
        </motion.div>
      )}

      {/* Footer Metrics Pill Strip */}
      <div className="grid grid-cols-2 gap-3 w-full border-t border-white/[0.06] pt-3">
        <div className="rounded-lg bg-neutral-900/60 p-2.5 border border-white/[0.04] text-center">
          <p className="text-[10px] uppercase tracking-wider text-neutral-400 font-medium">
            Available Headroom
          </p>
          <p className="tabular font-mono text-sm font-semibold text-emerald-400 mt-0.5">
            {rupees(availablePaisa)}
          </p>
        </div>
        <div className="rounded-lg bg-neutral-900/60 p-2.5 border border-white/[0.04] text-center">
          <p className="text-[10px] uppercase tracking-wider text-neutral-400 font-medium">
            In Escrow Review
          </p>
          <p className="tabular font-mono text-sm font-semibold text-amber-400 mt-0.5">
            {rupees(reservedPaisa)}
          </p>
        </div>
      </div>
    </div>
  );
}
