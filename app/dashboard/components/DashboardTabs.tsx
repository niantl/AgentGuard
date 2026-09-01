"use client";

import { motion } from "framer-motion";
import {
  LayoutDashboard,
  ShieldCheck,
  Zap,
  ScrollText,
  Sliders,
} from "lucide-react";

type TabId = "dashboard" | "policies" | "transactions" | "audit" | "settings";

interface TabsProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: "dashboard", label: "Executive Overview", icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: "policies", label: "Mandate Policies", icon: <ShieldCheck className="w-4 h-4" /> },
  { id: "transactions", label: "Simulate & Attack", icon: <Zap className="w-4 h-4" /> },
  { id: "audit", label: "Cryptographic Ledger", icon: <ScrollText className="w-4 h-4" /> },
  { id: "settings", label: "Engine Runtime", icon: <Sliders className="w-4 h-4" /> },
];

export function DashboardTabs({ activeTab, onTabChange }: TabsProps) {
  return (
    <div className="border-b border-white/[0.06] bg-[#0B0F19]/80 backdrop-blur-md sticky top-[57px] z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center gap-1.5 overflow-x-auto py-2.5 no-scrollbar">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                className={`relative px-3.5 py-2 text-xs font-semibold rounded-lg transition-all flex items-center gap-2 shrink-0 ${
                  isActive
                    ? "text-white shadow-sm"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]"
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeTabBadge"
                    className="absolute inset-0 bg-gradient-to-r from-razorpay-600/30 to-razorpay-500/20 border border-razorpay-500/40 rounded-lg shadow-sm shadow-razorpay-500/10"
                    transition={{ type: "spring", stiffness: 400, damping: 35 }}
                  />
                )}
                <span className={`relative z-10 ${isActive ? "text-razorpay-400" : ""}`}>
                  {tab.icon}
                </span>
                <span className="relative z-10">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
