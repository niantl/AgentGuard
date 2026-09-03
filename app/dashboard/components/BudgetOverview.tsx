"use client";

import { motion } from "motion/react";
import { Shield, CreditCard, Lock, CheckCircle2 } from "lucide-react";
import type { PolicyView } from "@/runtime/agentGuardRuntime";
import { BudgetUtilizationGauge } from "./charts/BudgetUtilizationGauge";
import { BudgetDistributionDonut } from "./charts/BudgetDistributionDonut";
import { rupees } from "../lib/format";
import { useMotionKit } from "../lib/motion";

interface BudgetOverviewProps {
  policies: PolicyView[];
}

export function BudgetOverview({ policies }: BudgetOverviewProps) {
  const motionKit = useMotionKit();
  const totalBudget = policies.reduce((sum, p) => sum + p.maxAmountInPaisa, 0);
  const totalConsumed = policies.reduce((sum, p) => sum + p.consumedAmountInPaisa, 0);
  const totalReserved = policies.reduce((sum, p) => sum + p.reservedAmountInPaisa, 0);
  const totalAvailable = Math.max(totalBudget - totalConsumed - totalReserved, 0);

  const safeBudget = Math.max(totalBudget, 1);
  const percentageConsumed = (totalConsumed / safeBudget) * 100;
  const percentageReserved = (totalReserved / safeBudget) * 100;
  const percentageAvailable = (totalAvailable / safeBudget) * 100;

  return (
    <div className="space-y-6">
      {/* AlignUI Finance & Banking: 4-Card KPI Metric Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Cap */}
        <motion.div
          {...motionKit.rise(0, 12)}
          className="rounded-xl border border-razorpay-500/30 bg-gradient-to-b from-[#16213E] to-[#0F172A] p-5 shadow-xl backdrop-blur-md relative overflow-hidden"
        >
          <div className="absolute top-0 right-0 h-20 w-20 bg-razorpay-500/10 rounded-full blur-2xl pointer-events-none" />
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium uppercase tracking-wider text-razorpay-300">
              Total Mandate Cap
            </span>
            <span className="p-2 rounded-lg bg-razorpay-500/15 text-razorpay-400 border border-razorpay-500/20">
              <Shield size={16} />
            </span>
          </div>
          <h3 className="tabular font-mono text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
            {rupees(totalBudget)}
          </h3>
          <p className="text-[11px] text-neutral-400 mt-2 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-razorpay-400" />
            Across {policies.length} active {policies.length === 1 ? "policy" : "policies"}
          </p>
        </motion.div>

        {/* Consumed Spend */}
        <motion.div
          {...motionKit.rise(1, 12)}
          className="rounded-xl border border-white/[0.08] bg-[#11192E]/90 p-5 shadow-xl backdrop-blur-md hover:border-rose-500/30 transition-all relative"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              Committed Spend
            </span>
            <span className="p-2 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20">
              <CreditCard size={16} />
            </span>
          </div>
          <h3 className="tabular font-mono text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
            {rupees(totalConsumed)}
          </h3>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex-1 h-1.5 bg-neutral-800 rounded-full overflow-hidden mr-2">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(percentageConsumed, 100)}%` }}
                transition={motionKit.t({ duration: 1, ease: "easeOut" })}
                className="h-full bg-rose-500 rounded-full"
              />
            </div>
            <span className="tabular font-mono text-[11px] text-rose-400 font-semibold">
              {percentageConsumed.toFixed(1)}%
            </span>
          </div>
        </motion.div>

        {/* Held in Escrow */}
        <motion.div
          {...motionKit.rise(2, 12)}
          className="rounded-xl border border-white/[0.08] bg-[#11192E]/90 p-5 shadow-xl backdrop-blur-md hover:border-amber-500/30 transition-all relative"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              Held in Escrow
            </span>
            <span className="p-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Lock size={16} />
            </span>
          </div>
          <h3 className="tabular font-mono text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
            {rupees(totalReserved)}
          </h3>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex-1 h-1.5 bg-neutral-800 rounded-full overflow-hidden mr-2">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(percentageReserved, 100)}%` }}
                transition={motionKit.t({ duration: 1, ease: "easeOut" })}
                className="h-full bg-amber-500 rounded-full"
              />
            </div>
            <span className="tabular font-mono text-[11px] text-amber-400 font-semibold">
              {percentageReserved.toFixed(1)}%
            </span>
          </div>
        </motion.div>

        {/* Available Headroom */}
        <motion.div
          {...motionKit.rise(3, 12)}
          className="rounded-xl border border-white/[0.08] bg-[#11192E]/90 p-5 shadow-xl backdrop-blur-md hover:border-emerald-500/30 transition-all relative"
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-400">
              Available Headroom
            </span>
            <span className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <CheckCircle2 size={16} />
            </span>
          </div>
          <h3 className="tabular font-mono text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
            {rupees(totalAvailable)}
          </h3>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex-1 h-1.5 bg-neutral-800 rounded-full overflow-hidden mr-2">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(percentageAvailable, 100)}%` }}
                transition={motionKit.t({ duration: 1, ease: "easeOut" })}
                className="h-full bg-emerald-500 rounded-full"
              />
            </div>
            <span className="tabular font-mono text-[11px] text-emerald-400 font-semibold">
              {percentageAvailable.toFixed(1)}%
            </span>
          </div>
        </motion.div>
      </div>

      {/* Bespoke Data Visualizations: Radial Gauge & Donut Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BudgetUtilizationGauge
          consumedPaisa={totalConsumed}
          reservedPaisa={totalReserved}
          totalBudgetPaisa={totalBudget}
        />
        <BudgetDistributionDonut
          consumedPaisa={totalConsumed}
          reservedPaisa={totalReserved}
          availablePaisa={totalAvailable}
          totalBudgetPaisa={totalBudget}
        />
      </div>
    </div>
  );
}
