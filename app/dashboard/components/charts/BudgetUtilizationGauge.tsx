"use client";

import { motion } from "framer-motion";
import { ShieldCheck, AlertTriangle, AlertCircle } from "lucide-react";

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

  const formatLakhs = (paisa: number) => {
    const rupees = paisa / 100;
    if (rupees >= 100000) {
      return `₹${(rupees / 100000).toFixed(2)}L`;
    }
    return `₹${rupees.toLocaleString("en-IN")}`;
  };

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
      <div className="relative my-4 flex items-center justify-center">
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
            stroke="#1e293b"
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
            transition={{ duration: 1.2, ease: "easeOut" }}
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
                stroke="#475569"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            );
          })}
        </svg>

        {/* Center Readout Text */}
        <div className="absolute top-[52%] left-1/2 -translate-x-1/2 flex flex-col items-center">
          <span className="tabular font-mono text-3xl font-extrabold text-white tracking-tight">
            {percentage.toFixed(1)}%
          </span>
          <span className="text-[10.5px] uppercase tracking-wider text-neutral-400 font-medium mt-0.5">
            Capacity Utilized
          </span>
        </div>
      </div>

      {/* Footer Metrics Pill Strip */}
      <div className="grid grid-cols-2 gap-3 w-full border-t border-white/[0.06] pt-3">
        <div className="rounded-lg bg-neutral-900/60 p-2.5 border border-white/[0.04] text-center">
          <p className="text-[10px] uppercase tracking-wider text-neutral-400 font-medium">
            Available Headroom
          </p>
          <p className="tabular font-mono text-sm font-semibold text-emerald-400 mt-0.5">
            {formatLakhs(availablePaisa)}
          </p>
        </div>
        <div className="rounded-lg bg-neutral-900/60 p-2.5 border border-white/[0.04] text-center">
          <p className="text-[10px] uppercase tracking-wider text-neutral-400 font-medium">
            In Escrow Review
          </p>
          <p className="tabular font-mono text-sm font-semibold text-amber-400 mt-0.5">
            {formatLakhs(reservedPaisa)}
          </p>
        </div>
      </div>
    </div>
  );
}
