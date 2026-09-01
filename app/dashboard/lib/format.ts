/** Presentation helpers. All money in AgentGuard is integer paisa; only the UI divides. */

const RUPEE_FORMAT = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function rupees(paisa: number): string {
  return `₹${RUPEE_FORMAT.format(paisa / 100)}`;
}

/** Paisa alongside rupees, for places where the exact integer matters. */
export function rupeesWithPaisa(paisa: number): string {
  return `${rupees(paisa)} (${paisa.toLocaleString("en-IN")} p)`;
}

export function percentOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

export function shortHash(hash: string, chars = 10): string {
  return hash.length <= chars ? hash : `${hash.slice(0, chars)}…`;
}

export function clockTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleTimeString("en-GB", { hour12: false });
}

export function dateTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString("en-GB", { hour12: false });
}

export function relativeFromNow(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const deltaSeconds = Math.round((parsed - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const unit = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : `${Math.round(abs / 3600)}h`;
  return deltaSeconds >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** Human label for a status or error code: ERR_CUMULATIVE_CAP_EXCEEDED → Cumulative cap exceeded. */
export function humanizeCode(code: string): string {
  const stripped = code.replace(/^ERR_/, "").replace(/_/g, " ").toLowerCase();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}
