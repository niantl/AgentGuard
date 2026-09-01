# AgentGuard — Upgrade Plan v3 (Unconstrained Tier)

Builds on top of the already-tested v2 engine — does not replace the passing 72-test suite, extends it. Scope: the concrete engineering upgrades from the Tier 1–4 shortlist (Postgres row-locking, invariant fuzzing, MCP server packaging, Merkle audit proofs, cross-auth anomaly detection, pluggable secret provider, policy DSL, explainable denials). Tier 5 (positioning/pitch) is explicitly out of this plan — it's not code.

## Design Principles (non-negotiable across every phase)

1. **The engine's decision logic does not move or get duplicated.** Every new surface (MCP server, DSL compiler) is a thin adapter that calls the existing `processTransaction` — never a reimplementation.
2. **No LLM in the enforcement or authoring path.** The DSL compiler is a deterministic parser. Explainable-denial strings are deterministic templates built from the same variables the check already used. If either of these ever calls a model, that's a regression — it reintroduces non-determinism into the exact place it was removed from in v1/v2.
3. **New advisory features never gain enforcement authority.** Cross-authorization anomaly detection logs and flags; it never writes to `policy.state` and never returns a blocking result on its own.
4. **Fail closed, not silently downgraded.** If the KMS secret provider is configured but unreachable, boot fails loudly. Do not fall back to an env-var secret without an explicit, logged, intentional configuration flag.
5. **State lives in one place.** Once Phase 1 lands, idempotency store, rate limiter, reservations, and consumed-tokens set all move to Postgres together — not partially. Leaving half the state in memory after adding a database defeats the phase's purpose.

---

## Phase 1 — Distributed-Safe Persistence (Postgres)

Replaces `state/snapshotStore.ts`. This is the phase that turns "atomic because Node's event loop happens to serialize synchronous blocks" into "atomic because the database enforces it," which is what makes horizontal scaling to multiple instances actually safe.

**Schema** (four tables, minimum):
- `authorization_policies` — one row per policy, including `consumed_amount_in_paisa`, `reserved_amount_in_paisa`, `status`, plus the full policy JSON for constraints.
- `idempotency_records` — `idempotency_key` (unique), `status` (`PENDING` / `AWAITING_APPROVAL` / `COMPLETED` / `FAILED`), `result` (JSON, for cached `COMPLETED` responses).
- `rate_limit_counters` — `authorization_id`, `window_start`, `count`.
- `consumed_approval_tokens` — `token_id` (unique), `consumed_at`.

**The reserve step, done correctly:**
```sql
BEGIN;
SELECT consumed_amount_in_paisa, reserved_amount_in_paisa, max_amount_in_paisa, status
  FROM authorization_policies
  WHERE authorization_id = $1
  FOR UPDATE;                      -- row lock: blocks concurrent transactions on this policy

-- application-level check happens here, inside the still-open transaction:
-- consumed + reserved + quote <= max ?

UPDATE authorization_policies
  SET reserved_amount_in_paisa = reserved_amount_in_paisa + $2
  WHERE authorization_id = $1;

COMMIT;
```
The check and the write must be inside the same transaction, bracketing a single `FOR UPDATE` lock. A second concurrent transaction on the same `authorization_id` blocks at the `SELECT ... FOR UPDATE` until the first commits or rolls back — this is what generalizes the old single-process guarantee to any number of instances.

**Idempotency and rate-limit tables** use `INSERT ... ON CONFLICT` and their own row locks the same way — same principle, smaller blast radius.

**Migration path**: keep `state/snapshotStore.ts`'s interface shape (same method signatures the engine already calls) so `engine/guardrailEngine.ts` needs minimal changes — swap the implementation underneath, not the contract.

---

## Phase 2 — Invariant Fuzzing (property-based testing)

Replaces "we hand-wrote 10 scenarios" with "we tested the invariant against thousands of random interleavings."

- Use `fast-check` (or equivalent) to generate randomized sequences: N proposals, random amounts, random `clientNonce`s, random injected delays/failures at each async boundary, fired with random concurrency.
- After every generated run, assert the single invariant that matters: `consumedAmountInPaisa + reservedAmountInPaisa` never exceeds `maxAmountInPaisa`, and never goes negative.
- Run this against the real Postgres-backed engine from Phase 1, with genuinely separate connections/processes — not just `Promise.all` inside one process. That's the real test of Phase 1's value; an in-process race test alone would still pass even if the DB layer were broken, because Node would still serialize it.

**Optional stretch — formal spec**: a TLA+ module modeling the reserve → approve → commit/release state machine, model-checked for the same invariant. This is a documentation-tier deliverable (a `.tla` file plus a short write-up), not something wired into the runtime. Worth doing for the pitch story, not required for the code to function.

---

## Phase 3 — MCP Server Packaging

Wrap the existing engine as a Model Context Protocol server using `@modelcontextprotocol/sdk`, so any MCP-compatible agent (Claude, or any other MCP client) can add AgentGuard as a policy-enforcement hop without custom integration.

**Tools to expose:**
- `propose_transaction(authorizationId, itemId, merchantId, category, proposedAmountInPaisa, clientNonce, humanApprovalToken?)` → calls `engine.processTransaction` directly, returns its result unmodified.
- `get_policy_status(authorizationId)` → read-only projection of `consumed`/`reserved`/`status`.
- `approve_escalation(authorizationId, idempotencyKey, approverId, decision)` → calls the existing `/agentguard/approve` logic.
- `verify_audit_chain()` → calls `verifyChainIntegrity()`.

Each tool handler is a thin pass-through to existing, already-tested functions — the MCP layer contains no new financial logic. Test by driving the server through a real MCP client call, not just a direct function call, to confirm the transport/schema layer doesn't silently coerce or drop a field (e.g. large `proposedAmountInPaisa` values through JSON serialization).

---

## Phase 4 — Merkle Audit Proofs

Supplements (does not replace) the existing linear hash chain. The hash chain proves *global* integrity — nothing in the whole log was altered. The Merkle tree adds *selective disclosure* — you can hand an auditor proof that one specific transaction is in the ledger and untampered, without exposing every other agent's spend history.

- Leaves = `currentHash` of each audit block, in append order.
- `buildMerkleRoot(blocks)` — standard pairwise-hash-up-the-tree construction.
- `getInclusionProof(entryId)` — returns the sibling-hash path from that leaf to the root.
- `verifyInclusionProof(leafHash, proof, root)` — a standalone verifier function that needs only the leaf, the proof path, and the known root — not the full log. This is the function you'd actually hand to a third-party auditor.

Known simplification, state it in the code comments: recompute the tree on demand rather than maintaining an incremental Merkle log (à la Certificate Transparency, RFC 6962). Fine at hackathon/demo data volumes; a real production version would maintain it incrementally.

**Test**: tamper a block *not* included in a given proof's leaf set, confirm that proof still verifies against the (now-stale) root correctly reported as invalid only when the root itself is recomputed — i.e., prove that inclusion proofs for untouched leaves remain independently checkable, and that root-level tamper detection still catches the modification globally via the existing hash-chain check.

---

## Phase 5 — Cross-Authorization Anomaly Detection (advisory only)

Operates across all `authorizationId`s, something no single policy can see on its own.

- Rule (starting point, extend later): the same `merchantId` appears in blocked or escalated events across ≥ N distinct `authorizationId`s within a rolling window — flag `ANOMALY_DETECTED`, log it to the audit chain like any other event, surface it as a banner in the dashboard.
- **Hard constraint**: this module only reads audit events and writes `ANOMALY_DETECTED` log entries. It must never call anything that mutates `policy.state`, and it must never be in a code path that `processTransaction` checks before returning a result. It is a side-channel signal for a human to look at, not an enforcement input — write a test that asserts triggering the anomaly rule has zero effect on a concurrently-running, otherwise-valid transaction.

---

## Phase 6 — Pluggable Secret Provider

```typescript
interface SecretProvider {
  getHmacSecret(): Promise<Buffer>;
}
class EnvSecretProvider implements SecretProvider { /* reads process.env, current behavior */ }
class KmsSecretProvider implements SecretProvider { /* AWS KMS, behind explicit config */ }
```
Engine takes a `SecretProvider` at construction instead of reading `process.env` directly. Default remains `EnvSecretProvider` (no behavior change without explicit opt-in). If `KmsSecretProvider` is selected but KMS is unreachable at boot, the process must fail to start — no silent fallback to env var. Log the failure clearly.

---

## Phase 7 — Policy DSL + Explainable Denials

**DSL** — structured YAML, not free-text/NLP, and not compiled by a model:
```yaml
authorizationId: procurement-bot-001
userId: user_123
purpose: "Office supplies procurement"
budget:
  maxAmountInPaisa: 500000
  currency: INR
  expiresAt: 2026-12-31T23:59:59Z
categories: [office_supplies, software_licenses]
merchants: [amazon_business, staples_api]
escalation:
  requiresHumanApprovalAbovePaisa: 300000
```
`compilePolicyDsl(yamlSource) -> AuthorizationPolicy`:
- Validate against a JSON Schema; reject on any violation, fail closed.
- Re-run the existing `requiresHumanApprovalAbovePaisa <= maxAmountInPaisa` validator (call the same function Phase-0/v2 already has — do not write a second copy of this check, that's how the two copies drift and one gets bypassed).
- HMAC-sign the compiled result the same way a hand-constructed policy is signed today.

**Explainable denials**: for each existing error code, add a deterministic template, e.g.
```
ERR_CUMULATIVE_CAP_EXCEEDED →
"Blocked: consumed ₹{consumed} + reserved ₹{reserved} + this request ₹{quote} = ₹{total}, exceeds cap ₹{max}."
```
Built only from values the check already computed, attached as `details.humanReadableReason` on the audit block. Never a separately-generated narrative — it must be mechanically impossible for this string to say something different from what the code actually enforced.

---

## Test Requirements Summary

- Phase 1: multi-connection (not just multi-`Promise`) concurrent reserve test against real Postgres — this is the one that actually proves the phase worked.
- Phase 2: fuzz suite run for at least several thousand generated interleavings with zero invariant violations.
- Phase 3: an actual MCP client round-trip, not a direct function call.
- Phase 4: inclusion-proof verification test, independent of full-log access.
- Phase 5: anomaly detection has zero effect on any `processTransaction` result — assert this explicitly.
- Phase 6: KMS-misconfigured boot fails loudly, does not silently downgrade.
- Phase 7: DSL-authored policy is rejected exactly when the equivalent hand-built object would be (run the same rejection test cases through both paths); DSL is never fed to a model.

## Acceptance Checklist

- [ ] All existing v2 tests (72) still pass unmodified.
- [ ] Reserve step is provably atomic across separate DB connections, not just within one Node process.
- [ ] No state remains split between memory and Postgres after Phase 1.
- [ ] MCP tool handlers contain zero business logic — grep for any `if`/`await fetch`/amount comparison inside the MCP layer itself; there should be none.
- [ ] Anomaly detection code path is provably unreachable from any `processTransaction` return value.
- [ ] DSL compiler has no LLM/model call anywhere in its call graph.
- [ ] `requiresHumanApprovalAbovePaisa <= maxAmountInPaisa` is validated by one shared function, called from both the hand-built-policy path and the DSL path.
