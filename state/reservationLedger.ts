import type { HashChainLogger } from "@/logger/hashChainLogger";
import type { StateStore } from "@/state/stateStore";
import type { AuthorizationPolicy, ReservationRecord } from "@/types/agentGuard";

/**
 * The only three operations allowed to move money between the two ledger buckets:
 *
 *   reserved  — in-flight exposure, not yet spent
 *   consumed  — committed spend
 *
 * Both the engine and the human-approval endpoint go through these functions, so
 * there is exactly one implementation of "release" and exactly one of "commit".
 * Every path persists the snapshot synchronously before returning.
 *
 * INVARIANT: `reservedAmountInPaisa` is never negative. An attempted underflow is
 * recorded in the audit chain as INVARIANT_VIOLATION_RESERVED_UNDERFLOW and then
 * clamped at zero, so a bookkeeping bug can never manufacture spendable headroom.
 */

export interface LedgerDeps {
  store: StateStore;
  logger: HashChainLogger;
}

function guardUnderflow(
  policy: AuthorizationPolicy,
  reservation: ReservationRecord,
  cause: string,
  deps: LedgerDeps,
): number {
  const before = policy.state.reservedAmountInPaisa;
  const next = before - reservation.amountInPaisa;
  if (next < 0) {
    deps.logger.log(policy.authorizationId, "INVARIANT_VIOLATION_RESERVED_UNDERFLOW", {
      cause,
      reservationId: reservation.reservationId,
      reservedBeforeInPaisa: before,
      attemptedAmountInPaisa: reservation.amountInPaisa,
      note: "Clamped to 0. This indicates a double-release or a lost reservation record.",
    });
  }
  return Math.max(0, next);
}

/** Reserved → released. Used on every failure, denial, and expiry path. */
export async function releaseReservation(
  policy: AuthorizationPolicy,
  reservation: ReservationRecord,
  cause: string,
  deps: LedgerDeps,
): Promise<void> {
  const reservedBefore = policy.state.reservedAmountInPaisa;
  policy.state.reservedAmountInPaisa = guardUnderflow(policy, reservation, cause, deps);
  await deps.store.removeReservation(policy.authorizationId, reservation.reservationId);
  await deps.store.savePolicyState(policy);

  // A decision record (TRANSACTION_BLOCKED, HUMAN_APPROVAL_DENIED, …) explains *why*
  // this happened; this block records that the money actually moved back, so the
  // audit chain can be reconciled paisa-for-paisa without inferring anything.
  deps.logger.log(policy.authorizationId, "RESERVATION_RELEASED", {
    cause,
    reservationId: reservation.reservationId,
    idempotencyKey: reservation.idempotencyKey,
    amountInPaisa: reservation.amountInPaisa,
    reservedBeforeInPaisa: reservedBefore,
    reservedAfterInPaisa: policy.state.reservedAmountInPaisa,
    consumedAmountInPaisa: policy.state.consumedAmountInPaisa,
    wasEscalation: reservation.isEscalation,
  });
}

/** Reserved → consumed. The only path that increases committed spend. */
export async function commitReservation(
  policy: AuthorizationPolicy,
  reservation: ReservationRecord,
  deps: LedgerDeps,
): Promise<void> {
  const reservedBefore = policy.state.reservedAmountInPaisa;
  const consumedBefore = policy.state.consumedAmountInPaisa;
  policy.state.reservedAmountInPaisa = guardUnderflow(policy, reservation, "COMMIT", deps);
  policy.state.consumedAmountInPaisa += reservation.amountInPaisa;
  await deps.store.removeReservation(policy.authorizationId, reservation.reservationId);
  await deps.store.savePolicyState(policy);

  deps.logger.log(policy.authorizationId, "RESERVATION_COMMITTED", {
    reservationId: reservation.reservationId,
    idempotencyKey: reservation.idempotencyKey,
    amountInPaisa: reservation.amountInPaisa,
    reservedBeforeInPaisa: reservedBefore,
    reservedAfterInPaisa: policy.state.reservedAmountInPaisa,
    consumedBeforeInPaisa: consumedBefore,
    consumedAfterInPaisa: policy.state.consumedAmountInPaisa,
    capInPaisa: policy.constraints.maxAmountInPaisa,
  });
}

/**
 * Recompute the lifecycle status after a settlement.
 *
 * REVOKED is terminal. EXPIRED_UNAPPROVED is deliberately *not* recomputed here —
 * the sweep sets it and it stays visible until the next settlement on this
 * authorization, so a missed approval window leaves a trace in the UI.
 */
export function refreshLifecycleStatus(policy: AuthorizationPolicy, deps: LedgerDeps): void {
  if (policy.state.status === "REVOKED") return;

  if (policy.state.consumedAmountInPaisa >= policy.constraints.maxAmountInPaisa) {
    policy.state.status = "EXHAUSTED";
    return;
  }

  const hasOpenEscalation = deps.store
    .listReservations(policy.authorizationId)
    .some((reservation) => reservation.isEscalation && !reservation.approvalTokenConsumed);

  policy.state.status = hasOpenEscalation ? "PENDING_HUMAN_APPROVAL" : "ACTIVE";
}
