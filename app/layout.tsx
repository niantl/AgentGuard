import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentGuard — deterministic payment guardrails for AI agents",
  description:
    "A policy-enforcement layer between AI buying agents and Razorpay. The agent proposes; " +
    "AgentGuard validates and executes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className="min-h-screen bg-neutral-900 font-sans text-sm leading-relaxed text-neutral-200 antialiased"
        suppressHydrationWarning
      >
        {children}
        <Toaster
          position="top-right"
          theme="dark"
          richColors
          closeButton
          expand
          style={{
            "--font-size": "14px",
            "--padding": "12px",
            "--border-radius": "8px",
          } as React.CSSProperties}
        />
      </body>
    </html>
  );
}
