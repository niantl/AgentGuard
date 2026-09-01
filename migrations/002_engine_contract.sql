-- AgentGuard v3 — migration 002: the columns and table the engine's existing
-- contracts need on top of the four core tables.
--
-- Migration 001 is the minimum schema. It is kept verbatim and separate so the core
-- shape stays easy to read; everything the running code additionally requires is
-- added here, explicitly, with the reason recorded next to it.

-- ---------------------------------------------------------------------------
-- authorization_policies
-- ---------------------------------------------------------------------------

-- The list of Razorpay order ids this authorization has actually executed. Part of
-- `AuthorizationPolicy.state`, so it has to be durable alongside the two money
-- buckets rather than reconstructed from the audit log.
ALTER TABLE authorization_policies
  ADD COLUMN IF NOT EXISTS executed_transaction_ids TEXT[] NOT NULL DEFAULT '{}';

-- The per-authorization cap, projected out of the signed policy JSON as a stored
-- generated column.
--
-- Generated, not written by the application, on purpose: the cap that the reserve
-- transaction compares against is then *mechanically* the same number that the
-- policy's HMAC signature covers. There is no code path that can set a permissive
-- cap column while leaving a stricter cap in the signed JSON, because the column is
-- not settable at all.
ALTER TABLE authorization_policies
  ADD COLUMN IF NOT EXISTS max_amount_in_paisa BIGINT
  GENERATED ALWAYS AS ((policy_json #>> '{constraints,maxAmountInPaisa}')::BIGINT) STORED;

-- The ledger invariant, enforced by the database itself.
--
-- This is the same property `tests/invariant.fuzz.test.ts` asserts against thousands
-- of random interleavings. Stating it as a CHECK means a bookkeeping bug cannot
-- merely be *detected* after the fact — the transaction that would breach the cap
-- fails to commit. Application-level checking still happens inside the reserve
-- transaction so that a breach produces a proper ERR_CUMULATIVE_CAP_EXCEEDED result
-- rather than an opaque database error; this constraint is the backstop underneath
-- it, for the case where the application logic itself is wrong.
DO $$
BEGIN
  ALTER TABLE authorization_policies
    ADD CONSTRAINT authorization_policies_ledger_within_cap
    CHECK (
      consumed_amount_in_paisa >= 0
      AND reserved_amount_in_paisa >= 0
      AND consumed_amount_in_paisa + reserved_amount_in_paisa
          <= (policy_json #>> '{constraints,maxAmountInPaisa}')::BIGINT
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- idempotency_records
-- ---------------------------------------------------------------------------

-- Which authorization the key belongs to. The engine refuses to resume an escalation
-- whose key was issued under a different authorization, so this cannot be inferred.
ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS authorization_id TEXT NOT NULL DEFAULT '';

-- The merchant quote locked in at escalation time. Reused verbatim on resubmission:
-- this column is what stops a merchant from raising the price after a human has
-- approved the cheaper figure.
ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS quote JSONB;

ALTER TABLE idempotency_records
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idempotency_records_authorization_status_idx
  ON idempotency_records (authorization_id, status);

-- ---------------------------------------------------------------------------
-- reservations
-- ---------------------------------------------------------------------------

-- A fifth table, required by the "all mutable state lives in Postgres" rule.
-- Reservations are mutable state — they are created in the reserve step, mutated
-- when an approval token is consumed against them, and deleted on commit, release,
-- or expiry sweep. Leaving them in memory while the two money buckets they account
-- for live in the database would be exactly the split state the rule forbids.
--
-- `reserved_amount_in_paisa` on authorization_policies is the sum of this table's
-- `amount_in_paisa` for that authorization. The two are only ever written together,
-- inside one transaction, so they cannot drift.
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_in_paisa BIGINT NOT NULL CHECK (amount_in_paisa >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  is_escalation BOOLEAN NOT NULL DEFAULT FALSE,
  approval_token_consumed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS reservations_authorization_idx
  ON reservations (authorization_id);

-- One held reservation per idempotency key per authorization. A retry that races an
-- in-flight proposal cannot end up holding budget twice for the same purchase; the
-- second insert fails the unique constraint instead of silently double-reserving.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_authorization_key_uniq
  ON reservations (authorization_id, idempotency_key);
