# Scheduling build plan — status

Running record of the scheduling-engine build plan (`SquadLogic_ClaudeCode_Prompts_2.md`),
which converts a real anonymized season into a regression corpus and builds the
domain model, constraints, solver behaviour and query layers around it.

**Kept in the repo deliberately.** Session scratchpads were lost four times to
container rollbacks over the course of this work; the repo is the only durable
record, and every figure below is measured at a named commit rather than
remembered.

**The plan is complete.** Prompts 0.1 through 7.3 are delivered and merged.

## 1. Delivered

**Twenty-one PRs merged (#334-#354);** the table's rows exceed that because
setup, 0.1 and 0.2 share #334. Test suite **848 → 2066**: 848 at `cd31924`, the
merge before #334, and 2165 at `06a1b97`, after the whole-build review of §2a.
The season fixture
was green at every merge, and the shipping app never regressed — the bundle's
first-paint total held at 217.96 KB gz with the same entry hash from the first
PR to the last, because nothing built here is wired into it yet (see §3).

| Prompt | What landed | PR |
|---|---|---|
| setup | Working conventions in `CLAUDE.md` §3 | #334 |
| 0.1 | `docs/ARCHITECTURE.md` — the map, with a "Known gaps" section that drove everything after | #334 |
| 0.2 | `packages/core/src/fixtures/` — read-only corpus loader; `docs/MODEL_GAPS.md` (34 gaps) | #334 |
| 1.1 | `facility/` — venues, sub-pitches, spatial overlap, size vs lining, date-scoped equipment | #335 |
| 1.2 | `timing/` — play time vs occupancy vs block, halftime ranges, warm-up as occupancy | #336 |
| 1.3 | `availability/` — permits with per-date exceptions, lighting, sunset, the binding-constraint answer | #337 |
| M1 | 6 defects from the Phase 1 review | #338 |
| 2.1 | `constraints/` — records with hardness, scope, provenance, effective windows, the what-if query; `placement/` demonstration harness | #339 |
| 2.2 | `waivers/` — records, disposition, dormancy, the narrow coach-travel evaluator | #340 |
| 2.3 | `ruleEngine/` — exercise expectations, identifier-shape checks, the validation report; the venue-complex model | #341 |
| M2 | 11 defects from the Phase 2 review | #342 |
| 3.1 | `people/` — personal timelines, sealed sources, derived must-attend, identity review queue | #343 |
| M3 | 9 defects from the Phase 3 review | #344 |
| — | Review conventions into `CLAUDE.md`; gaps ledger refreshed with verified statuses | #345 |
| 4.1 | `freeze/` + `resolve/` — freeze scopes, eight-stage pipeline, scoped re-solve | #346 |
| 4.2 | Change minimisation as an objective, change budget, dry run by default | #347 |
| 4.3 | `attribution/` — the binding constraint behind every decision | #348 |
| 5.1 | `reserve/` — unnamed fixtures, reservations, unplaced games, capacity | #349 |
| 6.1 | `scenario/` — branch a season without duplicating it; overrides, ancestry, shared record sets, digest-keyed memo | #351 |
| 6.2 | `publication/` — snapshots, four-bucket parity, change notices, sync registry; reason-code reachability audit | #350 |
| 7.1 | `feasibility/` — three read-only queries, a binding constraint and a margin on every answer, three-valued verdicts | #352 |
| 7.2 | `fairness/` — four league-only metrics over teams, divisions and age groups; outlier flagging; unwired solver objectives | #353 |
| 7.3 | `externalImport/` — external-name mapping, four resolution classes, pre-commit impact analysis, avoid-windows round trip | #354 |

## 2. How it was built, and what that cost

Nothing is in flight. This section records the process, because it is the part
that would be expensive to rediscover.

**Every prompt was reviewed before its PR opened, and the review was worth more
than the per-step verification.** Findings per prompt, in rounds:

| prompt | rounds |
|---|---|
| 6.1 scenario branching | 11 → 6 → 4 → 2 → 4 → 1 → 0 |
| 7.1 feasibility API | 8 → 3 → 3 → 2 → 2 → 1 → 5 → 0 |
| 7.2 fairness metrics | 9 → 6 → 2 → 3 → 2 → 3 → 4 |
| 7.3 external import | 9 → 5 → 4 → 4 → 2 |

Roughly a hundred and forty defects across the run. **Not one was a broken
feature.** Every one was a hollow guarantee: a check that could not fail, a
count that could not be exceeded, a message asserting a cause it had not
observed, an answer that published no evidence for the verdict it sealed. The
suites were green throughout.

**Three shapes recurred often enough to name.**

*A check that cannot fail.* 6.1 shipped three before the pattern was written
into `CLAUDE.md` §3; 7.2 shipped three more where the *new* test pinned the
defect it was written to catch — an accounting rule that codified a double
count, a filter assertion comparing two expressions equal by construction, a
message assertion pinning an ambiguous rendering. The remedy that worked was
mutation: construct the wrong implementation and prove the assertion rejects it.
Eleven mutations in one 7.2 round; five in one 7.3 round.

*Unknown folded into zero or into "fine".* Four separate recurrences. A
`bookingsOverlapInTime()` of `null` read as "no clash"; a `tight: false` where
no clean kickoff existed at all (772 of 1,872 combinations); an objective
scoring `0` — the optimum of a minimisation — for a season it could not read; a
`typical` verdict from `Math.abs(47.2) > undefined`.

*A guarantee enforced where callers happen to reach it, rather than in the thing
that produces it.* The memo that could serve one derivation as the answer to
another survived three fixes because each extended an allowlist; it ended when
the digested surface was derived from the data by reflection. The same shape
closed 7.1's severity derivation, 7.2's evidence construction and 7.3's claim
sentences.

**What ended the loops, every time, was replacing the thing that generated the
findings rather than answering them.** A reflection test that walks the live
object; a frozen table with one producer; a header that parses its own sentence
back out of the file and checks it. Two rounds ended instead by *withdrawing* a
fix: 7.1's team-clash claim closed a gap unreachable on this corpus and opened
four defects on paths that run, so it was reverted and the gap documented.

**Supervision earned its keep by being checkable, not by being right.** Corpus
figures were derived independently before each prompt and handed to the agents
as claims to verify. Four were wrong: 141 participants (140 — a twelfth
placeholder label), "19 visiting clubs" (18, and 13 are the club's own Select
teams whose league layer is unassigned), and twice a confusion of the format's
*block* with its *occupancy* — once on 7.1's kickoff bounds, once on 7.3's
impact case. Each was caught by the agent checking rather than building on it.
The 7.3 correction was the most valuable single finding of the run: the
published external times would put four 11v11 games ten minutes into the 13:50
9v9 games on the overlapping sub-pitches, which is *why* the club negotiated the
earlier slots — the corpus carries the reason for its own discrepancy.

The round-by-round detail this section used to carry — every finding, its
reproduction and its fix — is not lost: it is in the commit messages and the PR
bodies for #334 to #354, which is where it belongs now that the plan is done.
It lived here while the work was in flight because the scratchpad kept being
wiped and this file was the only thing that survived.

### 2a. The whole-build review

The eleven per-prompt reviews each saw one module's diff. A single review across
the finished work — all 20 modules, ~109k lines — was run afterwards, and found
**fifteen defects in three rounds (5, 5, 5), every one at a seam between two
modules**. Merged as #356.

The two worth remembering:

- **A branch built its waiver ledger and never installed it** on the engines its
  re-solve reads, so waived violations were priced as blocking in the objective
  and the report, feeding the branch's status and its promotion gate. This
  corpus's incident 9, in new code. No per-prompt review could have found it:
  the 6.1 acceptance branch has no waivable violation at all, so the case had to
  be found by probing every venue withdrawal for one that does.
- **One game on an unknown surface made both clash rules throw**, so every real
  clash in the 679-row season went unreported and the occupancy counts fell to
  zero — which `verify` and the scenario diff read as an improvement. A blindness
  that presents as a better schedule is the worst shape this project produced.

**The loop terminated on its own evidence.** Round 2 found that three of its five
findings were round 1's classes in a different module pair, so round 2 closed the
classes package-wide instead of patching sites. Round 3 then found mostly those
same shapes recurring plus items already on the open list — the search exhausting
itself rather than the code continuing to yield.

Three structural guards came out of it, each with a positive control, and each
deriving its population from source rather than from a list someone maintains:

- every facility-importing module must be classified as reporting, reporting
  elsewhere, deliberately throwing, or graph-derived — a new importer fails until
  classified;
- every severity-table call must read the seam's findings or name itself with a
  reason (this one caught a misclassification inside the sweep that produced it);
- **a field produced under one file and read under none fails.** That guard exists
  because a fix approved in round 2 turned out to be inert — fields added beside a
  result that no production caller read. A field nobody reads is the appearance of
  a middle path, not one, and it is the same hollow-guarantee shape the per-prompt
  reviews found ~150 times.

No acceptance figure moved in any round, measured through the acceptance path
each time rather than argued.

## 3. Remaining

Nothing. 7.3 was the last prompt in the build plan.

Follow-ups raised during the build and deliberately not absorbed:

From the whole-build review (#356), stated rather than left to be rediscovered:

- **11 declared reason codes are unreachable**, each named with a reason in
  `UNREACHABLE` in `tests/reasonCodeReachability.test.js` — 8 with no production
  path, 3 reachable only through an exported helper the pipeline never calls that
  way. The audit header is a checked claim and reads 18 vocabularies / 396 codes /
  385 producible / 11 holes.
- **Four call sites still drop the severity-seam report**, each named with a
  reason. `placement/replaceGames.js` now judges the team scope but is still
  excused from carrying the report — one half of a pair that was matched in
  `checkPlacement()`.
- **`resolve/stages.js` reads neither half of the registry trace.** The stated
  bound of the round-3 fix: the solver's hot path cannot afford a status-moving
  remark. A team-scoped record left unjudged during a re-solve is invisible unless
  someone later asks `explainGame()` about that game.
- **`attribution/minimal.js` does not surface the trace** at either
  `checkPlacement()` call; `legalWith()` sits inside a relaxation search, and
  `minimalBlockingSet()`'s single call could afford it and does not.
- **The three capacity codes answering the proposer's own invented requirement
  are readable only on `capacities`** and nothing reads them, so "was there room?"
  at branch level means walking that list. Correctly not blocking the plan — but
  the same shape as the inert-field defect, one level down.
- **`conflictFairnessRule`'s undecidable pairs do not reach `violations`,** so a
  scenario diff cannot see one being introduced. Stable at 1 on this corpus. The
  fix is a subject and costs +100 quality per side.
- **`reserve/conditions.js` answers `null` — "unconditional" — for ground the
  graph does not hold.** Unreachable through the pipeline, which is asserted, but
  a direct caller would read it as an all-clear.
- **`proposeRelocations()` keeps every capacity report now, but the `underRegistry()`
  seam is triplicated** across attribution, feasibility and resolve. Docstrings
  agree with the code; the shared-seam refactor is proposed, not built.
- **~44 markdown files fail `prettier --check` at baseline**, including
  `docs/FREEZE_SCOPES.md`. Pre-existing and untouched.

- **A standing warm-up rule.** `timing/` proved the published season has 8 warm-up
  conflicts on its busiest date, but `SEASON_2026_WARMUP_POLICY` ships empty and
  no standing rule books a warm-up, so a season run does not check it. Wiring one
  moves the accepted-exceptions baseline and needs its own PR.
- **`coach-maximum-gap` is still `RULE_CONSTRAINT_UNENFORCED`** even though
  `evaluatePersonDays()` can now answer it.
- **Division is still a label, not a key** (GAP-24). `grep divisionId` over all
  new packages returns nothing. 7.2 groups by the label and states the
  consequence rather than fixing it: a report is computed over exactly one
  `scopeId` and a fixture list spanning two is refused with a blocking
  `FAIRNESS_SCOPE_MIXED`, because two clubs using `U10B` would otherwise form one
  comparison population whose arithmetic would be impeccable and whose meaning
  would be nothing. Within a scope the residue is still live, though the corpus
  no longer shows it: `16GSelect02` carries both `16GS` and `U16G`, but both
  labels sit on scrimmages and it holds no league fixture, so under a
  league-only metric it has no league label at all and is reported
  `FAIRNESS_GROUP_UNLABELLED` rather than `FAIRNESS_GROUP_AMBIGUOUS`. The
  ambiguity branch is kept live by a constructed driver, since a team that
  plays a league season under two spellings is the case it exists for.
- **Promote two widened publication codes to first-class** —
  `NOTICE_PARITY_VACUOUS` / `NOTICE_LABEL_AMBIGUOUS`, currently distinguished only
  by `details.reason`.
- **Nothing is persisted.** Every module built here is in-memory, and GAP-29's
  stored half stays open. **The GAP-30 precondition is gone as of 2026-09-19**:
  `z.coerce.date()` is no longer in `SlotSchema`/`AssignmentSchema` — it was
  replaced across #396, #398 and #400 by `InstantSchema`, which refuses a
  zoneless timestamp outright, and the refusal plus the zone-independence of the
  parsed instant were verified by execution rather than by reading. So
  publication snapshots can now be persisted safely; nothing has been. 7.3's
  `externalImport/mapping.js` is the first module to build the **seam** a store
  would use — `serialiseExternalMappingRegistry()` /
  `readExternalMappingRegistry()`, byte-identical round trip asserted — so
  wiring one store is now a bounded piece of work rather than a design question.
  Nothing wires it, and every registry says so. **Read `fieldAdmin` before
  assuming that seam is the design**: it is the one package here that actually
  got persistence, and it bypassed its own `serialiseFieldRegistry()` /
  `readFieldRegistry()` pair entirely in favour of a table plus three admin RPCs
  with RLS and audit rows ([`MODEL_GAPS.md`](MODEL_GAPS.md#gap-29)). The same
  document splits GAP-29's six unpersisted artifacts, so this bullet's "GAP-29's
  stored half" now means the published baseline; freeze plans, resolve runs and
  scenarios are [GAP-35](MODEL_GAPS.md#gap-35).
- **The impact analysis consults two layers, and names the five it does not.**
  `EXTERNAL_IMPACT_LAYERS_NOT_CONSULTED` — permits and blackouts, sunset and
  lighting, coach travel and personal timelines, the constraint registry and rule
  engine, warm-up occupancy — is published on every result at `info`. None of
  them changes an answer on this corpus (the moves are 30 minutes inside a
  7:00-to-20:00 permit, ten hours before sunset, and no coach is committed
  elsewhere on those two dates), which is a fact about the corpus rather than a
  property of the module.
- **Nothing is wired into the shipping app.** The week-indexed `gameScheduling.js`
  is untouched by design; it now *refuses* a freeze argument rather than ignoring
  one, so the gap is loud rather than silent.

## 4. Working conventions that proved their worth

Recorded because they were learned the hard way and are cheap to keep.

- **`/code-review` on every PR, before it opens.** Moved from per-milestone after
  Phase 3. Across the run it found **~60 defects that the per-step verification
  did not** — and none were broken features. Every one was a *hollow guarantee*
  that passed its own tests.
- **Three "a check that cannot fail" defects reached `main`** before the pattern
  was written into `CLAUDE.md` §3, and more were caught in fresh code afterwards.
  A meta-assertion needs its failing case constructed and proven, not just written.
- **Unknown is not zero.** Folding an unmeasurable overlap into "no clash" has
  recurred four separate times; JavaScript's falsy semantics make it free unless
  actively prevented.
- **Derive figures from the corpus at test time.** Hardcoded copies of derived
  numbers drift, and a suspiciously good result is worth investigating — 6.1's
  grid anchor produced a *better-looking* outcome that was an artifact.
- **The corpus caught our own reproductions of its own incidents**, twice: the
  loader dropping unknown-footprint scrimmages (incident 5) and an uncoached team
  losing its fixtures (incident 10).

---

## 5. The wiring decision — put to the operator at the 8.4/8.5 gate, 2026-09-16

`docs/PHASE_8_PLAN.md` gates everything from 8.5 on a choice between the two
schedulers that do not meet. It was put to the operator at that gate, with the
plan's figures re-verified against the repository rather than quoted from the
plan, because the plan predates 8.0-8.4.

> **Two later corrections apply to this section and it is not rewritten to
> absorb them**: §6 (2026-09-17) on the "zero frontend imports" figure, and §7
> (2026-09-19) on the GAP-30 premise and the `snapshot.js` bullet. Read all three
> before quoting any figure here.

**What was verified at the time of asking:**

- The games engine is still imported by **zero** `frontend/` modules.
- It still persists nothing. `publication/snapshot.js:181` continues to emit
  `SNAPSHOT_IN_MEMORY_ONLY`, naming both GAP-29 (persistence) and GAP-30
  (timezone-lossy schemas) in its own message.
- **GAP-30 is open.** `SlotSchema` and `AssignmentSchema` in
  `packages/core/src/schemas/index.js` still normalise through `z.coerce.date()`
  — lines 33-34 and 52-53. The plan is explicit that this must close before any
  snapshot persists, or the parity checker causes the very divergence it exists
  to detect.

**The operator's decision: neither branch yet — close GAP-29 and GAP-30 first,
then decide.**

This is itself a decision and is recorded as one. The reasoning it reflects: as
things stand the engine branch is not genuinely available, only theoretical.
Choosing it today would commit 8.5-8.10 to a surface that cannot persist and
whose parity checker cannot be trusted. Closing the two gaps first makes the
choice real in both directions, and makes the parity checker trustworthy under
either answer.

**Consequences for the plan:**

1. A GAP-29/GAP-30 task lands before 8.5. Its size is **not yet scoped**; that is
   the first thing to establish, and the operator was told so when the question
   was put.
2. The wiring question is **re-put to the operator once those gaps close.** It is
   not settled, and no later task may treat it as settled.
3. 8.5-8.10 do not start until it is answered. 8.0-8.4 were worth doing under
   either answer, which is why they went first.

**Also decided at the same gate:** the two parts of 8.4's capability 3 that need
migrations — no `admin_update_field_blackout` (so editing a blackout is
remove-and-re-add, with a new id and **four** audit rows — _amended on the
8.4-gap-A branch: this entry said two. The delete RPC writes a before/after
pair and the create RPC writes another, so it is four. Corrected here rather
than silently, and `20260910000000`'s header and revert both say four_) and
effective dating on
`fields` only (so `locations` and `field_subunits` cannot be retired) — land in a
**follow-up PR before 8.5**, rather than being folded into 8.8 or left as
recorded gaps. Both of 8.4's stated acceptance criteria were met without them;
this closes 8.4 against its own prose as well.

---

## 6. CORRECTION to §5 — "zero frontend imports" was a hollow check

**Recorded 2026-09-17, against §5's own verification, by the supervisor who wrote it.**

§5 states, as a fact verified at the gate: *"The games engine is still imported by
**zero** `frontend/` modules."* **That verification was hollow and the figure is
wrong.** The check run was a grep for `@squadlogic/core/games`, `@/games` and
`core/src/games` — **paths that do not exist in this repository.** It returned
zero because the pattern was wrong, not because the imports were absent, and the
zero was reported as evidence.

That is the exact shape CLAUDE.md §3 names first — *a check that matches zero
records is a loud failure, never a silent pass* — committed into the document the
operator's gate decision rests on.

**Measured: `frontend/src` carries 32 imports of `@squadlogic/core`.**

What the corrected picture is, since the distinction still matters:

- **The solver core remains at zero.** No `frontend/` module imports
  `publication/`, `reserve/`, `scenario/`, `resolve/`, `freeze/`,
  `externalImport/`, `feasibility/`, `fairness/`, `ruleEngine/`, `constraints/`,
  `waivers/`, `timing/`, `availability/`, `placement/` or `attribution/`. The
  spirit of the plan's claim holds **for the thing the gate is about.**
- **The engine/app boundary is no longer hermetic**, and **Phase 8's own work is
  what breached it**: `people/coachList.js` (8.2, #368, 2026-09-05),
  `facility/index.js` (8.4 gap B, #391, 2026-09-16 — the same day the gate
  figures were "re-verified"), and seven imports of `fieldAdmin/` across 8.4's
  PRs.

**Why this matters to the decision and not merely to the record.** The operator
chose "close GAP-29/30 first, then decide" partly on the premise that the engine
is unreachable from the app. It is *partially* reachable, it became more so
during the very phase that asked the question, and the direction of travel is a
fact the decision should weigh. The gate is **not** reopened by this correction —
the solver core is still unwired and still unpersisted — but §5's premise list is
amended rather than left standing.

**Two further figures in §5 and in `PHASE_8_PLAN.md`'s table are stale**, measured
the same day: the suite is **3,033 tests across 193 files** (the table's 2,165 was
the 0.1-7.3 engine's own count at `06a1b97`), and the engine measures **172 files
/ 64,118 lines** against the table's 161 / 58,199.

**The rule this earns, recorded because the supervisor has now made this error in
the same phase that collected it four times from agents:** a grep that returns
zero proves nothing until the pattern is shown to match something. Before
reporting a zero as evidence, run the pattern against a case it *must* hit.

---

## 7. CORRECTION to §5 — "GAP-30 is open" was true when written and is now false

**Recorded 2026-09-19, against §5's gate record, by the GAP-29 stage-0 scoping
pass.**

§5 is a dated record of _what was verified at the time of asking_, 2026-09-16.
It is not rewritten here, because it was accurate on its own date and the
operator's decision rests on what was in front of them. This section is appended
beside it, following the pattern §6 established for exactly this situation.

§5 states, as a premise of the gate: _"**GAP-30 is open.** `SlotSchema` and
`AssignmentSchema` in `packages/core/src/schemas/index.js` still normalise
through `z.coerce.date()` — lines 33-34 and 52-53."_ **True on 2026-09-16.
False from 2026-09-19.**

**§5's second bullet is stale in the same way, and by the same event.** It
records that `publication/snapshot.js:181` _"continues to emit
`SNAPSHOT_IN_MEMORY_ONLY`, naming both GAP-29 (persistence) and GAP-30
(timezone-lossy schemas) in its own message."_ The finding is still emitted, but
it is now at `:184`, and its message names **GAP-29 only** — the module's own
header says in as many words that GAP-30 is no longer one of the reasons. The
substance of the bullet survives: the engine still persists nothing.

**GAP-30 closed across #396, #398 and #400.** Three legs, each verified against
the repository rather than quoted from a PR description:

1. **The schemas.** `z.coerce.date()` appears nowhere in
   `packages/core/src/schemas/index.js`. `SlotSchema.start/end` and
   `AssignmentSchema.start/end` are `InstantSchema`, a union of `Date`, epoch
   number and string, refined by `isZonelessTimestamp` so that a timestamp
   carrying no zone is **refused** rather than given the host's offset.
2. **The zone has a home and a writer.** `season_settings.timezone`, with
   `admin_set_season_timezone()` added by
   `20260913000000_season_timezone_writer.sql` (validated against
   `pg_timezone_names`; a fourth `p_actor_context` argument added by
   `20260917000000`), plus the onboarding RPC writing the zone it already
   receives.
3. **`calendar-feed` composes through the season clock.** It reads the zone with
   `readSeasonTimezone()` (`_shared/timing/seasonSettings.ts`) and builds
   instants through `_shared/timing/seasonClock.ts` by way of
   `_shared/calendar/icsFeed.ts`. It **refuses rather than defaulting** when a
   season has no zone; the hardcoded `'America/New_York'` fallback is gone.

**Executed, not statically reviewed.** Both schemas were driven with four inputs
under two host zones. Refused in both zones: the naive
`'2026-11-07T16:44:00'` and the bare `'2026-11-07'`, each with _"timestamp must
carry a timezone; compose a wall time with timing/seasonClock.js first"_.
Accepted in both zones, to the identical instant `2026-11-08T00:44:00.000Z`
(epoch `1794098640000`): `'2026-11-07T16:44:00-08:00'` and
`'2026-11-08T00:44:00Z'`. The host-zone dependence the gate premise names is
therefore removed rather than relocated. The full output is in the pull request
that recorded this correction.

**What this does and does not do to the gate.** §5's decision was _"neither
branch yet — close GAP-29 and GAP-30 first, then decide"_. **One of the two
conditions is now met.** The gate is **not** reopened by this correction and no
later task may treat it as settled: GAP-29 is still open, the solver core still
persists nothing, and `publication/snapshot.js` still emits
`SNAPSHOT_IN_MEMORY_ONLY`. What changes is the reason: that snapshot is now
unpersisted because nobody has built the store, **not** because a
timezone-lossy schema made persisting it unsafe. The wiring question is still to
be re-put to the operator once GAP-29 closes.

**GAP-29 has also been narrowed, which changes what "close GAP-29" means.** Six
unpersisted artifacts had accumulated behind one id. Per the operator's ruling of
2026-09-19, GAP-29 keeps the published baseline — the publication snapshot and a
durable version for it — and freeze-plan, resolve-run and scenario/promotion
persistence, with the `frozen` flag, split out as
[GAP-35](MODEL_GAPS.md#gap-35). The gate condition is GAP-29 as now scoped.

**The rule this earns**, alongside §6's: **a dated verification decays, and the
document should say when.** §5's GAP-30 premise was correct, carefully executed,
and wrong three days later; nothing in the document would have told a reader
that. A verification recorded as a premise for a decision is worth a re-check
before it is quoted, and quoting §5's figures after this date without re-running
them is the same error §6 names in a different disguise.
