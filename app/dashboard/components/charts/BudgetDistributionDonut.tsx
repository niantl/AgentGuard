"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { rupees } from "../../lib/format";

interface BudgetDistributionDonutProps {
  consumedPaisa: number;
  reservedPaisa: number;
  availablePaisa: number;
  totalBudgetPaisa: number;
}

export function BudgetDistributionDonut({
  consumedPaisa,
  reservedPaisa,
  availablePaisa,
  totalBudgetPaisa,
}: BudgetDistributionDonutProps) {
  const safeTotal = Math.max(totalBudgetPaisa, 1);

  const data = [
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

  const formatLakhs = (paisa: number) => {
    const rupees = paisa / 100;
    if (rupees >= 100000) {
      return `₹${(rupees / 100000).toFixed(2)}L`;
    }
    return `₹${rupees.toLocaleString("en-IN")}`;
  };

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const item = payload[0].payload;
      return (
        <div className="rounded-lg border border-white/10 bg-[#0B0F19]/95 p-2.5 shadow-2xl backdrop-blur-md">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="text-xs font-semibold text-white">{item.name}</span>
          </div>
          <p className="tabular font-mono text-xs text-neutral-300">
            {formatLakhs(item.value)} ({item.percentage}%)
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col items-center justify-between rounded-xl border border-white/[0.08] bg-[#11192E]/90 p-5 shadow-xl backdrop-blur-md">
      <div className="w-full flex items-center justify-between border-b border-white/[0.06] pb-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Capital Allocation</h3>
          <p className="text-[11px] text-neutral-400">Committed vs in-flight vs unencumbered</p>
        </div>
        <span className="text-xs font-mono font-semibold text-razorpay-300 bg-razorpay-950/60 border border-razorpay-700/50 px-2.5 py-0.5 rounded-full">
          {formatLakhs(totalBudgetPaisa)} Cap
        </span>
      </div>

      {/* Donut Chart with Center Metric */}
      <div className="relative w-full h-52 flex items-center justify-center my-2">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<CustomTooltip />} />
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={58}
              outerRadius={80}
              paddingAngle={3}
              dataKey="value"
              stroke="none"
              cornerRadius={4}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>

        {/* Center label */}
        <div className="absolute flex flex-col items-center pointer-events-none">
          <span className="text-[10px] uppercase tracking-wider text-neutral-400 font-medium">
            Net Remaining
          </span>
          <span className="tabular font-mono text-lg font-bold text-white tracking-tight">
            {formatLakhs(availablePaisa)}
          </span>
        </div>
      </div>

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
