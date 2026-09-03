"use client";

import { Toaster, toast } from "sonner";

/**
 * Toast durations, by severity.
 *
 * A success toast is a receipt — you already know what you did, so it can go
 * quickly. A failure is the opposite: it is often the first time the operator
 * learns anything went wrong, and it carries a sentence they have to actually
 * read. Sonner applies one default duration to every toast, so severity-aware
 * timing lives here, in the `notify` wrapper, rather than being re-specified at
 * each of the two dozen call sites.
 */
const DURATION = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
} as const;

interface NotifyOptions {
  description?: string;
  id?: string | number;
}

export const notify = {
  success: (title: string, options?: NotifyOptions) =>
    toast.success(title, { duration: DURATION.success, ...options }),
  info: (title: string, options?: NotifyOptions) =>
    toast.info(title, { duration: DURATION.info, ...options }),
  warning: (title: string, options?: NotifyOptions) =>
    toast.warning(title, { duration: DURATION.warning, ...options }),
  error: (title: string, options?: NotifyOptions) =>
    toast.error(title, { duration: DURATION.error, ...options }),
  loading: (title: string) => toast.loading(title),
  dismiss: (id: string | number) => toast.dismiss(id),
};

export function NotificationProvider() {
  return (
    <Toaster
      position="bottom-right"
      theme="dark"
      richColors
      closeButton
      expand
      duration={DURATION.success}
      style={{
        "--font-size": "14px",
        "--padding": "12px",
        "--border-radius": "8px",
      } as React.CSSProperties}
    />
  );
}
