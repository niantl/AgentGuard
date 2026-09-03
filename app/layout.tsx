import type { Metadata } from "next";
import { NotificationProvider } from "./dashboard/components/NotificationProvider";
import { fontVariables } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentGuard — deterministic payment guardrails for AI agents",
  description:
    "A policy-enforcement layer between AI buying agents and Razorpay. The agent proposes; " +
    "AgentGuard validates and executes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      // `dark` is static, not toggleable: the third-party chart primitives gate
      // some of their tokens on the class, and this product has no light mode.
      className={`dark ${fontVariables}`}
      suppressHydrationWarning
    >
      <body
        className="min-h-screen bg-surface-dark font-sans text-sm leading-relaxed text-neutral-200 antialiased"
        suppressHydrationWarning
      >
        {children}
        <NotificationProvider />
      </body>
    </html>
  );
}
