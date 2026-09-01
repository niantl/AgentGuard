"use client";

import { Toaster } from "sonner";

export function NotificationProvider() {
  return (
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
  );
}
