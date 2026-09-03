"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { rupees } from "../../lib/format";
import { ChartSkeleton, useChartReady } from "./ChartSkeleton";
import { useMotionKit } from "../../lib/motion";

interface BudgetDistributionDonutProps {
  consumedPaisa: number;
  reservedPaisa: number;
  availablePaisa: number;
  totalBudgetPaisa: number;
}

interface AllocationSlice {
  name: string;
  value: number;
  color: string;
  percentage: string;
}

export function BudgetDistributionDonut({
  consumedPaisa,
  reservedPaisa,
  availablePaisa,
  totalBudgetPaisa,
}: BudgetDistributionDonutProps) {
  const motionKit = useMotionKit();
  const ready = useChartReady();
  const [hoveredItem, setHoveredItem] = useState<AllocationSlice | null>(null);
  const safeTotal = Math.max(totalBudgetPaisa, 1);

  const data: AllocationSlice[] = [
    {
      name: "Available Headroom",
      value: availablePaisa,
      color: "#00B386", // Razorpay Emerald
      percentage: ((availablePaisa / safeTotal) * 100).toFixed(1),
    },
    {
      name: "In-Flight Escrow",
      value: reservedPaisa,
      color: "#FFB800", // Razorpay Amber
      percentage: ((reservedPaisa / safeTotal) * 100).toFixed(1),
    },
    {
      name: "Committed Spend",
      value: consumedPaisa,
      color: "#FF3333", // Razorpay Ruby
      percentage: ((consumedPaisa / safeTotal) * 100).toFixed(1),
    },
  ];

  return (
    <div className="flex flex-col items-center justify-between rounded-xl border border-white/[0.08] bg-[#11192E]/90 p-5 shadow-xl backdrop-blur-md">
      <div className="w-full flex items-center justify-between border-b border-white/[0.06] pb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Capital Allocation</h3>
          <p className="text-[11px] text-neutral-400">Committed vs in-flight vs unencumbered</p>
        </div>
        <span className="text-xs font-mono font-semibold text-razorpay-300 bg-razorpay-950/60 border border-razorpay-700/50 px-2.5 py-0.5 rounded-full">
          {rupees(totalBudgetPaisa)} Cap
        </span>
      </div>

      {/* Donut Chart with Center Metric */}
      {!ready ? (
        <div className="my-2 w-full">
          <ChartSkeleton shape="ring" height={208} label="Loading capital allocation chart" />
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={motionKit.t({ duration: 0.25 })}
          className="relative my-2 flex h-60 w-full items-center justify-center"
        >
          {hoveredItem ? (
            <div className="pointer-events-none absolute right-1 top-1 z-10 max-w-[calc(100%-0.5rem)] rounded-lg border border-white/10 bg-[#0B0F19]/95 p-2.5 shadow-2xl backdrop-blur-md">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: hoveredItem.color }}
                />
                <span className="whitespace-nowrap text-xs font-semibold text-white">
                  {hoveredItem.name}
                </span>
              </div>
              <p className="tabular whitespace-nowrap font-mono text-xs text-neutral-300">
                {rupees(hoveredItem.value)} ({hoveredItem.percentage}%)
              </p>
            </div>
          ) : null}

          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="66%"
                innerRadius={58}
                outerRadius={80}
                paddingAngle={data.filter((d) => d.value > 0).length > 1 ? 3 : 0}
                dataKey="value"
                stroke="none"
                cornerRadius={4}
                isAnimationActive={!motionKit.reduced}
                onMouseEnter={(_, index) => setHoveredItem(data[index] ?? null)}
                onMouseLeave={() => setHoveredItem(null)}
              >
                {data.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>

          {/* Center label */}
          <div className="pointer-events-none absolute top-[66%] flex -translate-y-1/2 flex-col items-center">
            <span className="font-display text-[10px] font-medium uppercase tracking-[0.1em] text-neutral-400">
              Net Remaining
            </span>
            <span className="tabular font-mono text-lg font-bold tracking-tight text-white">
              {rupees(availablePaisa)}
            </span>
          </div>
        </motion.div>
      )}

      {/* Legend */}
      <div className="grid grid-cols-3 gap-2 w-full border-t border-white/[0.06] pt-3">
        {data.map((item) => (
          <div key={item.name} className="flex flex-col items-center text-center">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-[10.5px] text-neutral-400 truncate max-w-[80px]">
                {item.name.split(" ")[0]}
              </span>
            </div>
            <span className="tabular font-mono text-xs font-semibold text-white">
              {item.percentage}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
