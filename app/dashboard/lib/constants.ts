/**
 * The approver persona the dashboard boots with. Shared so the escalation panel
 * can tell whether the operator has changed it — a field that silently affects
 * which identity signs the next approval should say so when it is no longer the
 * default.
 */
export const DEFAULT_APPROVER_ID = "approver_finance_ops";
