# The constraint registry

Phase 2.1. Constraints as **records** rather than as control flow, so a rule can
be added, scoped, relaxed and audited without a code change.

`docs/ARCHITECTURE.md` §6.7 is the state this replaces:

> Constraints are control flow. There is no table, type, or serialized form for
> "this rule, of this hardness, applies to this scope". The hard/soft split is
> implicit: `hasCoachConflict` is an unconditional `continue`,
> `computeConsistencyScore` is a ranking term. Capacity is hard. Priority is a
> sort key. Nothing in between, and nothing per-instance.

The model answers [GAP-12](MODEL_GAPS.md#gap-12) and is the prerequisite for
[GAP-26](MODEL_GAPS.md#gap-26), waivers with a lifecycle — built on top of this
registry in Phase 2.2 and documented in [Waivers](WAIVERS.md).

Code: `packages/core/src/constraints/` (barrel at `index.js`). In-memory only —
there is no SQL home for constraint records and this phase deliberately does not
create one.

---

## 1. What a constraint record carries

| Field                  | Meaning |
| ---------------------- | ------- |
| `id`                   | Stable identity. |
| `policy`               | The *decision* this record speaks to (`turnover-minimum`). Resolution happens per policy. |
| `type`                 | `hard` (never violate) · `soft` (violate only if infeasible, at a cost) · `preference` (optimise toward; no violation concept). |
| `scope`                | `global`, or narrowed to `date` / `date-range` / `venue` / `surface` / `division` / `team` / `person`. Exactly one dimension per record. |
| `parameters`           | Flat primitives, e.g. `{ minimumGapMinutes: 20 }`. |
| `restrictiveDirection` | `higher` \| `lower` \| `none` — which way "more restrictive" points for this record's numbers. |
| `rationale`            | Free text. Required. |
| `source`               | `setBy`, `setAt` (nullable), `reference` (required), `note`. |
| `effectiveFrom` / `effectiveTo` | Inclusive ISO dates. Either may be null. |
| `enforcement`          | `reason-codes` (governs Phase 1 severities) or `declared-only` (recorded; nothing consumes it yet). |
| `reasonCodes`          | The codes whose severity this record sets. |
| `weight`               | Cost of violating (soft) or pull (preference). Forbidden on `hard`. |
| `waivable`             | Whether a Phase 2.2 waiver may except it. |
| `history`              | Every type change, with who and why. |

**Vocabulary note.** The prompt's *field* is this module's **`surface`**, matching
`facility/types.js`. A `surface`-scoped constraint applies to that surface *and
its descendants*, which is why scope matching takes a surface **lineage** rather
than a bare id.

**Provenance discipline.** `source.reference` is required and non-empty: a
constraint with no cited origin is the code comment that lost incident 9's
waiver, wearing a schema. `source.setAt` is *nullable* for the opposite reason —
several real constraints are recorded in the incident log, which preserves the
order events happened in but not their dates, and a plausible-looking invented
date is worse than an admitted absence. When `setAt` is null the schema requires
a `note` saying why.

---

## 2. Hardness is data, and the Phase 1 severity tables are the seam

Every Phase 1 module puts each reason code's severity in a frozen lookup table
and says in its own docstring that this is the seam a registry will override.
Nothing in `facility/`, `timing/` or `availability/` asks "is adjacency hard
right now?" — they emit a code and look it up.

```text
BASE_REASON_SEVERITY            constraint record          effective severity
(facility + timing +      +     type: hard        →        blocking
 availability + this)           type: soft        →        compromise
                                type: preference  →        info
```

- `constraints/baseSeverity.js` merges the four frozen tables and **throws at
  module load** if two of them give one code different severities.
- `constraints/severity.js` builds the per-context override table and re-severities
  a list of findings, keeping `details.baseSeverity` and `details.severityBy` so
  the change is auditable.
- Findings are **demoted, never deleted**. An `info` overlap finding is still an
  overlap, still visible, and still the thing to look at before publishing.

---

## 3. The precedence rule

Given the records that speak to one policy, and one context:

1. **Drop nothing silently.** Every candidate is judged and the verdict kept.
2. **Effective window.** Outside it → `CONSTRAINT_NOT_YET_EFFECTIVE` /
   `CONSTRAINT_EXPIRED`, reported as *inactive*. Window present but no date in
   the context → `CONSTRAINT_WINDOW_UNJUDGED` at `compromise` — not a pass.
3. **Scope dimension missing from the context** → `CONSTRAINT_SCOPE_UNJUDGED` at
   `compromise`. Falling through to the global answer is how the Orchard Park
   rule would get lost.
4. **Group by type tier.** Hard, soft and preference do not compete: "10 minutes
   is the floor" and "20 minutes is what we aim for" are both true at once.
5. **Narrowest scope wins** within a tier.
6. **A tie is reported, never resolved silently.** Two survivors at the same
   specificity that disagree → the more restrictive is applied *and*
   `CONSTRAINT_PRECEDENCE_AMBIGUOUS` is emitted. Same contract as
   `EQUIPMENT_PRECEDENCE_AMBIGUOUS` and `PERMIT_PRECEDENCE_AMBIGUOUS` in Phase 1.

### Specificity ranks

| Scope | Rank |
| --- | --- |
| `global` | 0 |
| `date-range` | 1 |
| `date`, `division`, `venue` | 2 |
| `surface`, `team`, `person` | 3 |

The tie at rank 2 is deliberate. A date-scoped rule covers every venue on one
day; a venue-scoped rule covers every day at one site. Neither contains the
other, so "which is narrower" has no answer and the disagreement is surfaced
instead of guessed.

Rank 0 losing to everything is what makes the Orchard Park 20-minute turnover
(`venue`, hard) beat the global 10-minute floor (`global`, hard) — GAP-12's
canonical case.

---

## 4. The seeded season-2026 set

Fourteen records in `constraints/adapters/season2026Constraints.js`. Four are
wired to Phase 1 reason codes; ten are `declared-only` because the modules that
would emit their codes are Phase 3 and later.

| Constraint | Type | Scope | Enforcement | Source |
| --- | --- | --- | --- | --- |
| Field overlap / adjacency | hard | global | reason-codes | incident 3 + `facility_geometry.json` |
| Same-ground exclusivity | hard | global | reason-codes | `facility_geometry.json` parent/child |
| Turnover floor (10) | hard | global | declared-only | `game_formats.csv` "Turnover min" |
| Turnover preferred (20) | preference | global | declared-only | `game_formats.csv` "Turnover preferred" |
| Turnover at Orchard Park (20) | **hard** | **venue** | declared-only | `facility_permits.csv` Notes: "traffic constraint: 20-min turnover HARD" |
| Coach travel between venues (60) | soft, waivable | global | declared-only | incident 9 |
| Coach travel within venue (15) | soft, waivable | global | declared-only | build plan Prompt 2.1 |
| Coach maximum gap (180) | preference | global | declared-only | build plan Prompt 2.1 + incident 5 |
| Round-robin completeness | hard | global | declared-only | corpus invariants |
| Home/away balance (4–5 of 9) | hard | global | declared-only | corpus invariants |
| Kickoff variety (≤ 4 of 9) | preference | global | declared-only | build plan Prompt 2.1 |
| Conflict fairness (spread ≤ 1) | hard | global | declared-only | corpus invariants |
| Sunset margin (15) | soft (hard until 2026-11-02; weight 1 is a placeholder) | global | reason-codes | corpus invariants + `sunsets.csv` |
| Permit windows | hard | global | reason-codes | `facility_permits.csv` |

**Seeding changes no Phase 1 severity.** Every override the seeded registry
produces has `changed: false`, and a test asserts it. That is the correct result:
writing down a policy that is already in force should not alter behaviour. The
registry earns its keep the moment somebody wants a *different* policy.

### Adjacency has a history

Incident 3: the rule arrived as a preference ("try to leave a field between
them") and was later hardened to inviolable. Both steps are in the record's
`history`, so "it was always hard" — which every earlier schedule version
contradicts — cannot be quietly asserted later.

Same-ground exclusivity is a **separate** record on purpose: demoting adjacency
must never make two games on the identical patch of grass legal.

---

## 5. "What would change if this went back to being a preference?"

`whatIfConstraintType(registry, id, proposedType, options)` answers the question
without performing the change. Three layers:

1. **`severityDeltas`** — which reason codes change severity. Pure registry
   arithmetic.
2. **`findingDeltas`** — given findings from a real evaluation, how many carry
   each affected code.
3. **`statusDeltas`** — given those findings grouped by subject, which subjects
   change verdict.

It also returns `projectedRegistry`, a real registry ready to re-run a solve
with. The registry it was asked about is untouched.

A projection handed evaluations that mention **none** of the affected codes
reports `CONSTRAINT_PROJECTION_VACUOUS` at `compromise` rather than an empty
delta that reads as a confident "nothing would change" — incident 4.

`retypeConstraint()` performs the change, returning a new registry with the
change appended to the history. It refuses to invent a `weight` when softening.

---

## 6. The placement demonstration harness

`packages/core/src/placement/` — **a demonstration, not a solver.** Read the
module docstring in `replaceGames.js` before extending anything there.

It re-places one bounded slice of the corpus (the 9v9 games on 08/22 at Alder
Park) onto a grid of candidate slots the corpus itself used, earliest legal slot
first, with the Select layer held still. Placement legality is entirely Phase 1
(`checkKickoffAvailability`); the registry enters only through
`applyRegistrySeverity()`.

Two runs over identical data, differing only in one field on one record:

| Registry | Result |
| --- | --- |
| adjacency **hard** | reproduces the published schedule exactly (0 games differ from `combined_schedule.csv`) |
| adjacency **preference** | four named games move into the slots the Select games overlap |

`compareRuns()` reports **which specific games** differ, with before and after
coordinates — not a count. Incident 1 is a count that said "366" long after the
damage was done.

### What it deliberately is not

- It is **not** minimal-diff. The production objective must be minimal diff
  against the published baseline (incident 1); earliest-first is the opposite,
  and is used here only because the published schedule is legal under *both*
  hardnesses, so a minimal-diff placer would demonstrate nothing.
- It does **not** touch `gameScheduling.js`, `autoScheduler.js` or
  `gameMetrics.js`. Those are week-indexed while every Phase 1 module and this
  one are date-indexed. **Wiring the registry into the real solver is Phase 4.**
- It handles one date, one format, one venue. It should not grow.

---

## 7. Meta-assertions

Every result carries counters (`ConstraintMeta`, `PlacementMeta`) and every
vacuous path is a loud failure, per incident 4:

- an empty registry is `blocking` (`REGISTRY_EMPTY`);
- a duplicate id is `blocking`;
- a reason code no module registers is `blocking`;
- a placement run over zero games, surfaces or kickoffs is refused by the schema;
- a run that evaluated zero candidates throws;
- `compareRuns()` refuses two runs over different game sets, and two empty ones;
- a projection over evaluations that match nothing reports `compromise`.
