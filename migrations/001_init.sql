-- AgentGuard v3 — migration 001: core state tables.
--
-- These four tables are the authoritative home for every piece of mutable state the
-- engine owns. Before v3 the same state lived in one JSON snapshot file, and the
-- atomicity of the check-and-reserve step rested on Node's single-threaded event
-- loop refusing to interleave a synchronous block. That argument holds for exactly
-- one process. These tables move the guarantee into the database, where a row lock
-- serialises concurrent writers regardless of how many instances are running.
--
-- Money is stored as BIGINT paisa. There is no floating point anywhere in the
-- ledger: a rupee is 100 paisa and every amount in the system is an integer count
-- of paisa, so no rounding step can ever create or destroy value.

CREATE TABLE IF NOT EXISTS authorization_policies (
  authorization_id TEXT PRIMARY KEY,
  policy_json JSONB NOT NULL,
  consumed_amount_in_paisa BIGINT NOT NULL DEFAULT 0,
  reserved_amount_in_paisa BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- PENDING | AWAITING_APPROVAL | COMPLETED | FAILED
  result JSONB
);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  authorization_id TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consumed_approval_tokens (
  token_id TEXT PRIMARY KEY,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
