# Development plan

<!-- GUIDANCE: Phase 3 output. Rules that keep this plan honest:
     - Milestone 1 ends with a deployable walking skeleton: auth if needed, one core flow,
       CI enforcing the gate, and a deploy pipeline. Not a demo — deployed.
     - No milestone defers testing, error handling, or accessibility to "later hardening."
       Those three are in every milestone's test gate or they don't happen.
     - "Works" is not an exit criterion. Every criterion is checkable by someone who didn't
       write the code.
     - Every milestone has a rollback/de-scope option, decided now while it's cheap, not
       mid-slip when it's political. -->

Project: **[PROJECT]** · Plan drawn up: [DATE] · Owner: [WHO]

Complete means: [ONE PARAGRAPH, IN USER TERMS — what a user can do when this is done]

<!-- GUIDANCE: This is the yardstick every scope decision below gets measured against. -->

## Status

<!-- GUIDANCE: One row per milestone, updated when it changes, so the plan's state is readable
     without reading the plan. Statuses: not started, in progress, blocked (say on what),
     done, deferred. -->

| Milestone | Status | As of | Notes |
| --- | --- | --- | --- |
| 1 — Walking skeleton | [STATUS] | [DATE] | [FILL IN] |

---

## Milestone 1 — Walking skeleton

**Scope (in):**
- [Auth, if the product needs it — real sign-in, not a stub]
- [ONE core user flow, end to end, against real infrastructure]
- CI running the full gate (typecheck, lint, test, build) on every pull request, and blocking
  merge where the repository's plan allows it (see the exit criteria)
- Deploy pipeline to [TARGET], with error reporting and structured logging wired

**Scope (explicitly out):**
- [Everything else — name the tempting items so nobody sneaks them in]

**Exit criteria:**
- [ ] A new user can [CORE FLOW] on the deployed environment, verified by hand
- [ ] CI is red on a type error, lint error, failing test, or failed build — demonstrated,
      not assumed — and is a required status check, so a red run can't be merged. Where the
      repository's plan can't enforce one (GitHub Free, private repository), the release
      runbook's settings table records that instead, and nothing claims enforcement
- [ ] `docs/release-runbook.md` is filled in from its skeleton (the placeholder check prints
      nothing for it), its "Verify the shipped artifact" steps pass against the deployed
      environment, and its rollback has been rehearsed once
- [ ] An induced error appears in the error reporter with enough context to diagnose
- [ ] `.env.example` and the typed env module cover every variable the deploy needs

**Test gate:** unit tests for [CORE LOGIC]; one E2E covering [CORE FLOW]; at least one
meaningful edge-case test.

**Rollback / de-scope:** [WHAT SHIPS IF THIS SLIPS — e.g. defer auth behind basic access control]

---

## Milestone 2 — [NAME]

**Scope (in):** [FILL IN]
**Scope (explicitly out):** [FILL IN]
**Exit criteria:**
- [ ] [Measurable criterion]
**Test gate:** [FILL IN]
**Rollback / de-scope:** [FILL IN]

---

## Milestone N — [NAME]

<!-- GUIDANCE: Repeat the structure. Keep milestones independently shippable: each one ends with the
     app deployable and all tests green, so a stop after any milestone leaves something
     usable rather than a construction site. -->

---

## Out of scope for this plan

<!-- GUIDANCE: Features considered and consciously excluded, so their absence reads as a decision
     rather than an oversight. Revisit at each milestone boundary. -->

- [FEATURE] — [WHY NOT NOW, AND WHAT WOULD CHANGE THAT]

## Progress log

<!-- GUIDANCE: Newest first, a few lines per session: what changed, the commands run and their
     results (pass / fail / blocked (environment), and what was missing), and what's next.
     Keep it terse. When a milestone closes, fold its lessons into the project's lessons-learned
     file (skeleton: docs/lessons-learned.md) and trim the log. A log that grows past a few screens stops being read. -->

- [DATE] — [WHAT CHANGED] — ran [COMMANDS] — [RESULTS] — next: [NEXT STEP]
