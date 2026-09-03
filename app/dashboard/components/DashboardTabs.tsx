"use client";

import { motion } from "motion/react";
import {
  LayoutDashboard,
  ShieldCheck,
  Zap,
  ScrollText,
  Sliders,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FOCUS_RING_PAGE } from "./ui";

type TabId = "dashboard" | "policies" | "transactions" | "audit" | "settings";

interface TabsProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

const TABS: Array<{ id: TabId; label: string; description: string; icon: React.ReactNode }> = [
  {
    id: "dashboard",
    label: "Executive Overview",
    description: "Budget posture, the decision pipeline, and engine runtime",
    icon: <LayoutDashboard className="w-4 h-4" />,
  },
  {
    id: "policies",
    label: "Mandate Policies",
    description: "Spending mandates and their ledger state",
    icon: <ShieldCheck className="w-4 h-4" />,
  },
  {
    id: "transactions",
    label: "Simulate & Attack",
    description: "Adversarial scenarios, live purchases, and pending approvals",
    icon: <Zap className="w-4 h-4" />,
  },
  {
    id: "audit",
    label: "Cryptographic Ledger",
    description: "Hash-chained audit log and tamper verification",
    icon: <ScrollText className="w-4 h-4" />,
  },
  {
    id: "settings",
    label: "Engine Runtime",
    description: "Gateway mode, identity, and pre-flight diagnostics",
    icon: <Sliders className="w-4 h-4" />,
  },
];

export function DashboardTabs({ activeTab, onTabChange }: TabsProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  /**
   * The strip scrolls horizontally on narrow viewports and its scrollbar is
   * hidden, so the only remaining cue that there is more to see is this: a fade
   * on whichever edge still has content past it.
   */
  const syncOverflow = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const maxScroll = node.scrollWidth - node.clientWidth;
    setOverflow({
      left: node.scrollLeft > 2,
      right: node.scrollLeft < maxScroll - 2,
    });
  }, []);

  useEffect(() => {
    syncOverflow();
    const node = scrollerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(node);
    window.addEventListener("resize", syncOverflow);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncOverflow);
    };
  }, [syncOverflow]);

  /** Roving focus: arrow keys move between tabs and activate as they go. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    if (currentIndex === -1) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;

    if (nextIndex === null) return;
    event.preventDefault();

    const nextTab = TABS[nextIndex];
    if (!nextTab) return;
    onTabChange(nextTab.id);
    const nextNode = tabRefs.current[nextIndex];
    nextNode?.focus();
    nextNode?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  return (
    <div className="relative z-40 border-b border-white/[0.06] bg-[#0B0F19]/80 backdrop-blur-md">
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6">
        <div
          ref={scrollerRef}
          onScroll={syncOverflow}
          onKeyDown={onKeyDown}
          role="tablist"
          aria-label="Dashboard sections"
          aria-orientation="horizontal"
          className="no-scrollbar flex items-center gap-1.5 overflow-x-auto py-2.5"
        >
          {TABS.map((tab, index) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-controls={`panel-${tab.id}`}
                aria-selected={isActive}
                aria-label={`${tab.label} — ${tab.description}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                className={`relative flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${FOCUS_RING_PAGE} ${
                  isActive
                    ? "text-white shadow-sm"
                    : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200"
                }`}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeTabBadge"
                    className="absolute inset-0 rounded-lg border border-razorpay-500/40 bg-gradient-to-r from-razorpay-600/30 to-razorpay-500/20 shadow-sm shadow-razorpay-500/10"
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

        {/* Edge fades — the scroll affordance that replaces the hidden scrollbar. */}
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[#0B0F19] to-transparent transition-opacity duration-200 ${
            overflow.left ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[#0B0F19] to-transparent transition-opacity duration-200 ${
            overflow.right ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
    </div>
  );
}
