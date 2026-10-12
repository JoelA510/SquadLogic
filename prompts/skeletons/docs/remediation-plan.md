# Remediation plan

<!-- GUIDANCE: Existing-project Phase 2 output. Instantiate next to the audit it answers:
     docs/audits/YYYY-MM-<slug>/remediation-plan.md. Ordering is fixed and non-negotiable:
       1. blockers to production
       2. data integrity / security
       3. testing / CI
       4. completeness gaps vs. what "complete" means for this app
       5. polish
     Group items into milestones that are each independently shippable — each ends with the
     app deployable and all tests green. Milestone 1's exit line below is the enforcement
     floor; it applies to the single-PR form too.

     Size the plan to the project. For a small app where the natural unit of work is one PR,
     use the single-PR form at the bottom instead of five milestones; the item format and the
     ordering still apply. -->

Repo: **[REPO]** · Plan drawn up: [DATE] · Source audit: [`audit.md`](./audit.md)

**Status:** [NOT STARTED / IN PROGRESS / BLOCKED / DONE] as of [DATE] — [ONE LINE: WHAT'S NEXT]

End state: every audit area at "no blocker/high findings", E2E coverage of critical
journeys, staging deploy smoke-tested, docs current — measured against: [COMPLETE_MEANS].

## Rules for this plan

- **Traceability.** Every audit finding ID appears exactly once below: as an item, under
  "Deferred with reason", or as "[FINDING ID] — resolved by [ITEM ID]" when one fix closes two.
- **Severity** uses the audit's definitions. If an item is graded differently from its audit
  finding, the item says so and why.
- **Milestone size.** From Milestone 2 on, a milestone with more than about five items is two
  milestones. Milestone 1 takes every blocker however many there are, but ships them in PRs of
  about five items, so each can be rolled back on its own; a milestone that ships as one
  bundled gate at the end can't be.
- **Do not do** (out of scope for this plan, even if tempting):
  [THINGS THIS PLAN MUST NOT TOUCH — e.g. no framework migration, no schema reset]

## Item format

Every item carries all of these fields. The **test gate** is the load-bearing one. A fix
without a check that would fail if the fix regressed isn't done, it's done *for now*. The gate
has to be shown failing with the fix reverted, not assumed to.

> **[ITEM ID]. [GAP]** (audit finding [FINDING ID], [SEVERITY])
> - **Fix approach:** [FILL IN]
> - **Files touched:** [FILL IN]
> - **Depends on:** [ITEM IDS, OR NONE]
> - **Widens:** [FINDING IDS THIS FIX MAKES MORE FREQUENT OR REACHABLE, EACH MOVED INTO THIS MILESTONE, OR NONE]
> - **Effort:** [S / M / L]
> - **Acceptance criteria:** [WHAT A USER OR REVIEWER CAN OBSERVE WHEN IT'S FIXED]
> - **Test gate:** [THE CHECK THAT FAILS IF THIS REGRESSES — for a finding with a standard ID, the conformance scorecard passing it, and the waiver or baseline entry removed]
> - **Rollback:** [HOW TO UNDO IT IF IT MISBEHAVES IN PRODUCTION]
> - **Diff class:** [MINIMAL DIFF / FLAGGED REFACTOR]
> - **Verification label:** [VERIFICATION LABEL — statically reviewed / executed / fully validated]

<!-- GUIDANCE: Refactors are flagged and agreed before they land in a milestone. The
     verification label is updated as the item progresses. -->

---

## Milestone 1 — Stop the bleeding

<!-- GUIDANCE: Every blocker, plus the enforcement floor in the exit line below. -->

> **1. [GAP]** (audit finding [FINDING ID], blocker)
> - [ALL ITEM FIELDS]

**Milestone exit:** [ ] CI is a required check and blocks merge on the gate (or, where the
repository's plan can't enforce one, that's recorded as a settings item) · [ ] error
reporting receives an induced error · [ ] zero open blockers · [ ] deployed and smoke-tested

---

## Milestone 2 — Data integrity & security

> **[ITEM ID]. [GAP]** (audit finding [FINDING ID], [SEVERITY])
> - [ALL ITEM FIELDS]

**Milestone exit:** [ ] [FILL IN]

---

## Milestone 3 — Testing & CI depth

> **[ITEM ID]. [GAP]** (audit finding [FINDING ID], [SEVERITY])
> - [ALL ITEM FIELDS]

**Milestone exit:** [ ] [FILL IN]

---

## Milestone 4 — Completeness vs. [COMPLETE_MEANS]

> **[ITEM ID]. [GAP]** (audit finding [FINDING ID], [SEVERITY])
> - [ALL ITEM FIELDS]

**Milestone exit:** [ ] [FILL IN]

---

## Milestone 5 — Polish

> **[ITEM ID]. [GAP]** (audit finding [FINDING ID], [SEVERITY])
> - [ALL ITEM FIELDS]

**Milestone exit:** [ ] [FILL IN]

---

## Manual QA script

<!-- GUIDANCE: The checks no automated test covers yet: a flow that needs a real device, a
     visual state, a third-party integration. Numbered steps someone else can follow, with the
     expected result for each. Every entry is a candidate for automation; note which item would
     automate it. -->

1. [STEP] — expect: [RESULT]

## Discovered during execution

<!-- GUIDANCE: New issues found while fixing others go here with a severity. They extend the plan
     explicitly instead of silently expanding an in-flight item's scope. Fix rounds introduce
     defects too: re-check what the last round changed before calling a milestone done. -->

- [DATE] — [ISSUE] ([SEVERITY]) — slotted into milestone [N]

## Deferred with reason

<!-- GUIDANCE: Anything consciously not being fixed, and what would reopen it. -->

- [ITEM] — [REASON]; reopen if [CONDITION]

## When this plan is done

<!-- GUIDANCE: Mark the status line DONE with the date, move lessons worth keeping into the
     project's lessons-learned file (skeleton: docs/lessons-learned.md), and leave this plan in
     its dated folder as the record. Don't
     keep appending to a finished plan. A progress log that grows past a few screens stops
     being read, and that's how a project ends up with a 6,000-line status file. -->

---

## Single-PR form (small projects)

<!-- GUIDANCE: Use this instead of the milestones above when the whole remediation is a handful
     of items that ship as one or two PRs. Delete whichever form you don't use. -->

**PR [N] — [TITLE]** — closes audit findings [FINDING IDS]

> **[ITEM ID]. [GAP]** (audit finding [FINDING ID], [SEVERITY])
> - [ALL ITEM FIELDS]

**Merge gate:** the Milestone 1 floor — [ ] CI is a required check and blocks merge on the
gate (or its absence is recorded) · [ ] error reporting receives an induced error · [ ] zero open blockers · [ ] deployed
and smoke-tested — plus [ ] each item's test gate shown failing with its fix reverted ·
[ ] manual QA script run
