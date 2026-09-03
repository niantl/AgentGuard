"use client";

import { Shield, Radio } from "lucide-react";

interface DashboardHeaderProps {
  status: "SIMULATED" | "CONNECTED";
  lastSyncTime?: string;
}

export function DashboardHeader({ status, lastSyncTime }: DashboardHeaderProps) {
  const isConnected = status === "CONNECTED";

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-[#0B0F19]/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          {/* Logo & Brand Section */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="shrink-0 bg-gradient-to-tr from-razorpay-600 to-razorpay-500 p-2 rounded-xl shadow-lg shadow-razorpay-500/25 border border-razorpay-400/30">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-bold text-white tracking-tight shrink-0">AgentGuard</h1>
                <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 bg-razorpay-500/15 text-razorpay-300 border border-razorpay-500/30 rounded-full font-mono shrink-0">
                  Razorpay Edition
                </span>
              </div>
              <p className="text-[11px] text-neutral-400 mt-1">
                Deterministic Policy Firewall for AI Buying Agents
              </p>
            </div>
          </div>

          {/* Right Status Indicators */}
          <div className="flex items-center gap-3 sm:gap-5 shrink-0">
            {/* Gateway Status Pill */}
            <div
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap ${
                isConnected
                  ? "border-emerald-500/40 bg-emerald-950/50 text-emerald-300 shadow-[0_0_10px_rgba(0,179,134,0.15)]"
                  : "border-amber-500/40 bg-amber-950/50 text-amber-300 shadow-[0_0_10px_rgba(255,184,0,0.15)]"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full shrink-0 ${
                  isConnected ? "bg-emerald-400" : "bg-amber-400"
                } pulse-dot`}
              />
              <span className="font-semibold tracking-wide">
                {isConnected ? "Razorpay Gateway Live" : "Sandbox Simulation"}
              </span>
            </div>

            {/* Sync Timestamp */}
            {lastSyncTime && (
              <div className="hidden md:flex items-center gap-1.5 text-xs text-neutral-400 whitespace-nowrap">
                <Radio size={12} className="text-razorpay-400 shrink-0" />
                <span className="tabular font-mono text-[11px]">Sync: {lastSyncTime}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
