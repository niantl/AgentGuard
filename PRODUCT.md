# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: **a technical evaluator watching a live, timed walkthrough** — a Razorpay AI Buildathon judge
being shown, in a few minutes, that an AI agent cannot move money outside a signed mandate. They are
reading a shared screen at projector distance, following a narrated sequence of attacks and outcomes.

Secondary, and treated as a credibility requirement rather than a separate audience: **a finance-ops
approver** who would actually hold this queue — the person named in `approverId` who approves or denies
an escalation while budget sits in escrow, and who would read the audit ledger after the fact.

Confirmed emphasis: demo-first legibility, operator-credible density. Headline figures and pipeline
state must read at distance; the audit ledger and policy tables must stay genuinely dense so the
surface survives close inspection as a real operational tool.

## Product Purpose

AgentGuard is deterministic policy-enforcement middleware that sits between an AI buying agent and the
Razorpay payment gateway. The agent proposes purchase intents; it never holds authority to execute
money movement. AgentGuard is the sole authority that validates, reserves, and executes.

Success is a negative result made visible: every hostile or malformed proposal is refused by a
mechanism the viewer can name, and every refusal is explainable from computed values rather than
narrative text.

## Positioning

The enforcement path contains **no LLM**. Seven gates evaluate in strict sequence and the first failure
halts execution; the same code the dashboard exercises is the code the test suite exercises. The claim a
neighboring product cannot truthfully copy is the combination of a two-bucket
(`consumed` / `reserved`) ledger enforced atomically under PostgreSQL `SELECT … FOR UPDATE` plus SQL
`CHECK` constraints, a TLA+ specification of the reserve → approve → commit/release state machine, and
an append-only SHA-256 hash chain with Merkle selective-disclosure proofs.

The product's argument is structural, not probabilistic: price slippage, agent reasoning loops, retry
double-charges, TOCTOU budget races, catalog prompt injection, and replayed approval tokens are each
defeated by a specific mechanism, not by a better system prompt.

## Operating Context

The dashboard is the human surface over a running engine. Five surfaces, in the order a walkthrough
uses them:

- **Executive Overview** — mandate budget posture: total cap, committed spend, escrow, headroom.
- **Mandate Policies** — the signed authorization constraints, with the HMAC signature state visible.
- **Simulate & Attack** — seven adversarial scenarios and a set of ordinary live proposals, run against
  the live engine on click.
- **Cryptographic Ledger** — the hash chain, with a deliberate tamper toggle and a re-verify action.
- **Engine Runtime** — gateway mode, snapshot writes, rate-limit window, pre-flight diagnostics.

Two moments carry the demo: the seven-step pipeline resolving gate by gate, and the human-approval
escalation where budget is held in escrow under a 300-second TTL while a person decides.

## Capabilities and Constraints

- All money is **integer paisa** in the engine; only the presentation layer divides by 100. Currency is
  Indian rupees, formatted `en-IN` (lakh grouping).
- Pipeline step states are exactly: `PASSED`, `FAILED`, `ESCALATED`, `SKIPPED`, `NOT_REACHED`.
- Reservation TTL is 300 seconds. Rate limit is 5 proposals per authorization per 10-minute window.
- The gateway runs in `SIMULATED` mode unless Razorpay test keys are configured; the UI must state which.
- State is Postgres-backed with a synchronous JSON snapshot fallback for zero-config local runs.
- The dashboard is read-mostly over server state: every mutating route returns a fresh `DashboardState`.
- **Hard constraint:** the engine, state, security, policy, logger, analysis, MCP, payments, and runtime
  layers are complete and verified. Presentation work derives from existing `DashboardState` fields
  only; it never adds backend fields.
- Backend truth is fixed at 10 test suites / 144 tests passing, plus ≥2000 fast-check fuzz runs.

## Brand Commitments

Razorpay-adjacent identity: primary brand blue `#0066FF`, with emerald / amber / ruby reserved for
semantic state (passed / escalated / blocked). Surfaces are navy, not neutral gray. The product name is
AgentGuard, labelled "Razorpay Edition".

Confirmed visual constraint from the brief: no Inter/Arial/system-default typefaces, no pure black or
untinted gray, no gray text on colored backgrounds, no cards nested inside cards, no bounce or elastic
easing.

## Evidence on Hand

Real, in-repo, and safe to reference:

- `tests/` — 10 suites, 144 passing tests (engine, attacks, pgStore, mcp, merkle, anomalyDetector,
  secretProvider, dsl, denialExplanations, invariant.fuzz).
- `spec/agentguard.tla` — TLA+ specification of the budget safety invariant.
- `agentguard-audit.json` — a real recorded hash chain.
- `mocks/attackSuite.ts` — the seven adversarial scenarios the dashboard runs live.

Absences future work must not fabricate: there are no customers, no testimonials, no production
transaction volumes, no pricing, and no uptime or benchmark figures. The Razorpay integration is
Test-mode Orders API or a simulator — never represent it as live production payments.

## Product Principles

1. **The refusal is the feature.** Design should make a block legible and attributable to a named gate,
   not bury it as an error state.
2. **Determinism is visible.** Sequence, ordering, and halting behavior should be apparent in the
   layout, because "the first gate that trips halts execution" is the core claim.
3. **Reserved is not charged.** The distinction between `consumed` and `reserved` is the product's
   safety argument and must never collapse visually into one number.
4. **Exact figures, always.** Currency is integer-derived and must align in columns; never round a
   ledger value to make a layout work.
5. **Claim only what the repo proves.** Every number shown traces to engine state or a real test run.

## Accessibility & Inclusion

- Target **WCAG 2.1 AA** contrast for all text, including subordinate pipeline states, against the navy
  surfaces (`#0B0F19` page, `#11192E` card).
- Every interactive element needs a visible, non-default focus indicator — the surface is keyboard-driven
  during approval flows.
- Motion must degrade to no-motion under `prefers-reduced-motion`; animation carries meaning here
  (state transitions), so the meaning must survive without it.

## Workflow

`buildPath` is not recorded: no image-generation tool exists in this session's tool surface, so
**code-first** is the only available path and nothing was stored.
