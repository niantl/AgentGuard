# Claude Code Prompt — AgentGuard Upgrade v3

Paste everything below as the task. Do not assume any other context — this is standalone. The existing codebase has a working, tested engine (72 passing tests: `tests/engine.test.ts`, `tests/attacks.test.ts`) implementing a 6-step guardrail pipeline with reserve-then-commit budget tracking, HMAC-signed human-approval tokens, and a SHA-256 hash-chain audit log. **Do not break any of it.** Every phase below extends that engine; none of them replace its decision logic.

## Non-Negotiable Rules — read before writing any code

1. The engine's decision logic (`processTransaction`) does not move or get duplicated. Every new surface (MCP server, DSL compiler) is a thin adapter that calls the existing function — never a reimplementation of its checks.
2. No LLM anywhere in the enforcement or policy-authoring path. The DSL compiler is a deterministic YAML parser + JSON Schema validator. Denial-explanation strings are deterministic templates filled from variables the check already computed. If you find yourself calling a model to interpret policy text or to generate a reason string, stop — that's wrong.
3. New advisory features never gain enforcement authority. The cross-authorization anomaly detector reads audit events and writes `ANOMALY_DETECTED` log entries; it must never be reachable from any code path that `processTransaction` consults before returning a result.
4. Fail closed. If the KMS secret provider is selected but unreachable at boot, the process must fail to start with a clear error — never silently fall back to an env-var secret.
5. After Phase 1, all mutable state — idempotency records, rate-limit counters, reservations, consumed-approval-tokens — lives in Postgres. Do not leave any of it in an in-memory `Map` once the database layer exists; that split state is worse than either extreme.
6. `requiresHumanApprovalAbovePaisa <= maxAmountInPaisa` must be validated by exactly one shared function, called from both the existing hand-built-policy path and the new DSL path. Do not write a second copy of this check.

Run the full existing test suite after every phase. If a phase breaks an existing test, fix the regression before moving to the next phase — do not accumulate broken phases.

---

## Phase 1 — Postgres-Backed State (replaces `state/snapshotStore.ts`)

Tables:
```sql
CREATE TABLE authorization_policies (
  authorization_id TEXT PRIMARY KEY,
  policy_json JSONB NOT NULL,
  consumed_amount_in_paisa BIGINT NOT NULL DEFAULT 0,
  reserved_amount_in_paisa BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);

CREATE TABLE idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  status TEXT NOT NULL, -- PENDING | AWAITING_APPROVAL | COMPLETED | FAILED
  result JSONB
);

CREATE TABLE rate_limit_counters (
  authorization_id TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0
);

CREATE TABLE consumed_approval_tokens (
  token_id TEXT PRIMARY KEY,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The reserve step (engine Step 4) must be implemented as a single transaction:
```sql
BEGIN;
SELECT consumed_amount_in_paisa, reserved_amount_in_paisa, status
  FROM authorization_policies WHERE authorization_id = $1 FOR UPDATE;
-- app-level check: consumed + reserved + quote <= max, inside this open transaction
UPDATE authorization_policies
  SET reserved_amount_in_paisa = reserved_amount_in_paisa + $2
  WHERE authorization_id = $1;
COMMIT;
```
The `SELECT` and the `UPDATE` must be in the same transaction, wrapping one `FOR UPDATE` lock — do not split the read and the write across two separate `pg` client calls that could be interleaved by a connection pool. Use a single client checked out from the pool for the duration of the transaction.

Same pattern (single transaction, row lock or unique-constraint-based atomicity) for the idempotency-state transitions and the rate-limit counter increment.

Keep the method signatures the engine already calls against the old snapshot store as close as possible — this should be a swap of the storage implementation, not a rewrite of `guardrailEngine.ts`'s control flow.

Update `docker-compose.yml` (or add one) with a local Postgres service for development, and a `migrations/` folder with the SQL above.

---

## Phase 2 — Invariant Fuzzing

Add `tests/invariant.fuzz.test.ts` using `fast-check`:
- Generate randomized sequences of proposals: random `proposedAmountInPaisa`, random `clientNonce`s, random concurrency groupings, random injected async delays.
- Run each generated sequence against the real Postgres-backed engine — spin up genuinely separate DB client connections per concurrent call, not just parallel `Promise`s sharing one connection, so this actually exercises the row-lock, not Node's event loop.
- After each run, assert: `consumedAmountInPaisa + reservedAmountInPaisa <= maxAmountInPaisa` and neither value is ever negative. Run at least several thousand generated cases (`fc.assert(fc.asyncProperty(..., { numRuns: 2000 }))` or similar).

Optional: write a `spec/agentguard.tla` TLA+ module modeling the reserve → approve → commit/release state machine as a documentation artifact. Not wired into the build or test run — a separate deliverable for the write-up.

---

## Phase 3 — MCP Server (`mcp/server.ts`)

Use `@modelcontextprotocol/sdk`. Register tools:
- `propose_transaction` — params match `IntentProposal`; handler calls `engine.processTransaction(policy, proposal, fetchCartQuote)` directly and returns its result unmodified. No amount comparisons, no `if` statements evaluating financial logic inside this handler.
- `get_policy_status` — read-only, returns `{ consumedAmountInPaisa, reservedAmountInPaisa, status }` for a given `authorizationId`.
- `approve_escalation` — calls the existing `/agentguard/approve` logic.
- `verify_audit_chain` — calls `verifyChainIntegrity()`.

Write `tests/mcp.test.ts` that drives the server through an actual MCP client call (use the SDK's client/test utilities), not a direct import-and-call of the handler function — confirm the transport layer round-trips large `proposedAmountInPaisa` values correctly (watch for JSON number precision issues with large paisa values; use strings or `bigint`-safe serialization if the SDK's JSON layer risks precision loss).

---

## Phase 4 — Merkle Audit Proofs (`logger/merkleAudit.ts`)

- `buildMerkleRoot(blocks: AuditLogBlock[]): string` — leaves are each block's `currentHash`, standard pairwise SHA-256 up the tree (duplicate the last leaf on odd counts, or use a documented alternative — pick one and be consistent).
- `getInclusionProof(entryId: string, blocks: AuditLogBlock[]): { leaf: string; path: Array<{ hash: string; side: "left" | "right" }>; root: string }`
- `verifyInclusionProof(leaf: string, path: Array<{hash: string; side: "left"|"right"}>, root: string): boolean` — must not require access to the full `blocks` array, only the three arguments given. This is the function an external auditor would actually call.

Add `tests/merkle.test.ts`:
- Valid proof for an untampered leaf verifies `true`.
- Tampering with a block's `details` (same test pattern as the existing hash-chain tamper test) and recomputing the root produces a different root; the old proof against the new root returns `false`.
- Confirm `verifyInclusionProof` runs correctly given only `{leaf, path, root}` with no reference to the original `blocks` array in scope, proving the selective-disclosure property actually holds in the API, not just in intent.

---

## Phase 5 — Cross-Authorization Anomaly Detection (`analysis/anomalyDetector.ts`)

- Reads audit log entries across all `authorizationId`s.
- Rule: same `merchantId` appears in `PRICE_SLIPPAGE_BLOCKED` or `ERR_*` events across ≥ 3 distinct `authorizationId`s within a rolling 10-minute window → log `ANOMALY_DETECTED` via the existing `auditLogger.log(...)`.
- This module must not import or call anything from `engine/guardrailEngine.ts`'s decision path, and `processTransaction` must not import or call anything from this module. Enforce this as a structural boundary, not just a convention — put it in a separate module with no shared dependency graph into the engine's checks.
- Add `tests/anomalyDetector.test.ts` asserting: triggering the anomaly rule concurrently with an otherwise-valid, unrelated `processTransaction` call has zero effect on that call's result or timing-relevant state.

---

## Phase 6 — Pluggable Secret Provider (`security/secretProvider.ts`)

```typescript
interface SecretProvider {
  getHmacSecret(): Promise<Buffer>;
}
class EnvSecretProvider implements SecretProvider { /* current behavior: process.env */ }
class KmsSecretProvider implements SecretProvider { /* AWS KMS, explicit config */ }
```
Engine constructor takes a `SecretProvider` (default `EnvSecretProvider`, so existing tests need no changes). Add a boot-time check: if `KmsSecretProvider` is configured and `getHmacSecret()` throws or times out, the process must exit with a clear error — do not catch that error and silently construct an `EnvSecretProvider` instead.

Add `tests/secretProvider.test.ts` covering both the default path (unchanged) and a simulated KMS failure asserting the process/initialization throws rather than degrading silently.

---

## Phase 7 — Policy DSL + Explainable Denials

`policy/dsl.ts`:
- `compilePolicyDsl(yamlSource: string): AuthorizationPolicy`
- Parse YAML, validate against a JSON Schema matching the `AuthorizationPolicy.constraints` shape.
- Call the **existing shared** `requiresHumanApprovalAbovePaisa <= maxAmountInPaisa` validator — locate it in the current policy-creation code and reuse it; do not write a second copy.
- On any schema violation or failed validation, throw — fail closed, no partial policy.
- HMAC-sign the compiled result using the same signing path a hand-constructed policy already goes through.

Add `tests/dsl.test.ts`: valid YAML compiles to the same shape a hand-built object would; each existing policy-validation rejection test case (from the current suite) is re-run through the DSL path with an equivalent YAML input and must reject identically. Confirm via `grep`/static check that nothing in `dsl.ts` imports any model/LLM client.

`engine/denialExplanations.ts`:
- One deterministic template function per existing error code (`ERR_PRICE_SLIPPAGE_EXCEEDS_CAP`, `ERR_CUMULATIVE_CAP_EXCEEDED`, `ERR_AGENT_LOOP_DETECTED`, `ERR_INVALID_APPROVAL_TOKEN`, etc.), built only from the values the check already computed (consumed, reserved, quote, cap, etc. — no new lookups).
- Attach as `details.humanReadableReason` on the relevant audit log entry.
- Add a test asserting the generated string's embedded numbers exactly match the actual values used in that check's decision (parse the numbers back out of the string and compare, don't just eyeball it).

---

## Final Acceptance Checklist — verify all before declaring done

- [ ] All 72 existing tests still pass, unmodified in behavior.
- [ ] `tests/invariant.fuzz.test.ts` passes at ≥ 2000 generated runs, zero invariant violations.
- [ ] The Phase 1 reserve transaction is a single `BEGIN...FOR UPDATE...UPDATE...COMMIT` block — no split read/write across separate transactions.
- [ ] No mutable state remains in an in-memory `Map` after Phase 1 (grep for `new Map()` in `engine/` and `state/` — anything left should be justified in a comment, e.g. a pure in-request cache, or removed).
- [ ] MCP tool handlers contain no financial comparisons or business logic — grep for `>`, `<`, `+=` inside `mcp/server.ts`; there should be none outside of trivial pass-through code.
- [ ] `verifyInclusionProof` works from `{leaf, path, root}` alone, with no reference to the full audit log in its function signature or implementation.
- [ ] Anomaly detector module has no import edge to or from `engine/guardrailEngine.ts`.
- [ ] `KmsSecretProvider` failure halts boot; does not fall back to `EnvSecretProvider` silently.
- [ ] `dsl.ts` has zero imports of any LLM/model client, and calls the same shared validator function as the existing hand-built-policy path.
- [ ] Every denial-explanation string's embedded numbers are asserted equal to the actual decision variables in a test, not just visually checked.
