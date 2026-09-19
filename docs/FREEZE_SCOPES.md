# Freeze scopes and the scoped re-solve

Phase 4.1. What is held still when a schedule has to change — and the machinery
that makes "held still" a property of the system rather than a promise every
stage has to remember.

The incident this answers is number 1 in
[`fixtures/season-2026/README.md`](../fixtures/season-2026/README.md), and the
build plan calls it _"the single worst incident in the source project"_:

> **The 366-game reshuffle.** Integrating the 8 external fixtures required
> changes on two dates. Only those dates were frozen; the solver re-optimized
> the rest and produced an equally-valid schedule in which 366 of 679 games had
> silently moved — roughly half a season families already had times for.
> Recovery was only possible by re-importing the published schedule and treating
> it as ground truth.

Note what did _not_ go wrong. Nothing crashed, nothing was illegal, and the
report was clean. **The failure mode is a valid answer to the wrong question**,
and the only thing that would have caught it is a system that refuses to move a
game nobody asked about.

Number 2 is the sequel, and it is why half of this phase is about stages:

> **Repair passes leaked through the freeze.** After freeze support was added,
> the initial assignment honored it but the local-search and pair-repair stages
> quietly swapped four frozen games. Caught only by diffing.

Code: `packages/core/src/freeze/` (the scope model) and
`packages/core/src/resolve/` (the re-solver), barrels at `index.js`. Tests:
`tests/freezeScopes.test.js`. In-memory only — there is no SQL home for a freeze
plan or a resolve run and this phase deliberately does not create one, exactly
as Phases 1-3 did not. This was GAP-29's stored half; **as of 2026-09-19 it is
[GAP-35](MODEL_GAPS.md#gap-35)**, which took the freeze plan, the resolve run,
the `frozen` flag and scenario/promotion persistence when GAP-29 was narrowed to
the published baseline. GAP-35 is open.

---

## 1. A freeze plan is a default plus carve-outs

```js
freezeAllExcept([{ date: '2026-08-22', format: '9v9' }]);
```

| Field                  | Meaning                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `name`                 | Display label.                                                             |
| `defaultDisposition`   | `frozen` or `thawed`. **`frozen` unless somebody says otherwise, loudly.** |
| `rules`                | `freeze` and `thaw` rules, each with a `match`.                            |
| `globalReoptimisation` | Required when, and only when, the default is `thawed`.                     |

A `match` is a **conjunction** over eight dimensions, all composable in one rule:

| Dimension             | Matched against                                                  | Specificity |
| --------------------- | ---------------------------------------------------------------- | ----------- |
| `date`                | the game's date                                                  | 2           |
| `fromDate` / `toDate` | the game's date, inclusive                                       | 1           |
| `divisionLabel`       | the game's division **label**, not a key (GAP-24)                | 2           |
| `venueId`             | the game's venue                                                 | 2           |
| `surfaceId`           | the surface's **lineage**, so freezing Pitch 1 freezes 1A and 1B | 3           |
| `format`              | the game's format                                                | 2           |
| `teamId`              | **either** side of the game                                      | 3           |
| `gameId`              | the game                                                         | 3           |

The build plan names seven; `format` is the eighth because the plan's own worked
example — _"freeze everything except 9v9 on 08/22"_ — cannot be said without it.
"Field" is this codebase's `surface`, for the reason
[`CONSTRAINT_REGISTRY.md`](CONSTRAINT_REGISTRY.md) gives.

**The specificity integers are shared** with `CONSTRAINT_SCOPE_SPECIFICITY` and
`WAIVER_SCOPE_SPECIFICITY`, and `tests/freezeScopes.test.js` asserts the
equality rather than trusting it. A private scale would make "this thaw is
broader than the freeze it carves out of" a coincidence instead of a comparison.

`FreezeMatchSchema` **refuses a match that names nothing.** A match with every
dimension null reaches every game; as a `freeze` that is harmless noise, and as
a `thaw` it is a global re-optimisation smuggled in through the exception
clause. It is refused at construction, the way `RuleExerciseSchema` refuses a
rule that promises nothing about what it examined.

---

## 2. Resolution, and the one deliberate inversion

1. Every rule is tested against the game.
2. A rule naming a dimension the game does not carry is **unjudged**.
3. Of the rules that matched, the **narrowest** wins.
4. A `freeze` and a `thaw` tied at the narrowest rank resolve **frozen** and emit
   `FREEZE_AMBIGUOUS_DISPOSITION` at `blocking`. The plan is contradictory; the
   run holds the game and can never come back clean until somebody narrows one.
5. If nothing matched, the default decides.

**A known limitation of sharing the integers.** The scale is deliberately the
constraint model's, and that scale flattens genuinely different kinds of
narrowness onto one rank: `surface`, `team` and `game` all sit at 3, and `date`,
`division`, `venue` and `format` all sit at 2. So "freeze Pitch 1 **except** this
one game" is a _tie_, not a narrowing, and rule 4 holds the game and calls it
ambiguous. A plan built through `freezeAllExcept()` — the normal path — carries
no explicit `freeze` rules and cannot hit this. A hand-built plan that mixes both
kinds can, and `buildFreezePlan()` says so at **construction** with
`FREEZE_THAW_TIES_FREEZE` at `compromise` rather than letting it surface as a
blocking surprise on every affected game. Resolving the tie properly means either
an intra-model tie-break or an extra rank, and both are changes to a model three
phases share; it is flagged here rather than decided quietly.

**An unjudged freeze holds the game. An unjudged thaw does not free it.**

That is the opposite of [`WAIVERS.md`](WAIVERS.md) §2, where a waiver that cannot
be judged is _not applied_, and the two are right for the same reason. Both
refuse to act on a question they could not answer; the safe direction just
differs. The safe answer to _"I cannot tell whether this exception covers you"_
is **don't excuse it**. The safe answer to _"I cannot tell whether this game is
held"_ is **don't move it**. Incident 1 is 366 games that moved because nothing
said they must not.

---

## 3. Maximum freeze is the shape of the default plan, not a policy

`applyChangeRequest({ schedule, changes, engines })` with **no** `freeze`
argument builds `freezeForChanges(changes)`: one `thaw` per `gameId` the request
names, and a frozen default for the other 671 games of the season. "A change
request touches only what it must" is therefore not something the solver tries
to honour — it is the only plan it was given.

`scopesTouchedBy()` is deliberately the narrowest possible reading. Not the
dates the changes fall on, not the venues they use: every widening there is a
set of games an operator did not ask about and would not expect to move.

`freeze: null` is a **`TypeError`**, not "no freeze".

### The one door to a thawed default

```js
reoptimiseWholeSeason({
  schedule,
  changes,
  engines,
  reason: 'the league restructured the Select layer',
  acknowledged: true,
});
```

Everything about how it is reached is deliberate:

- the **name** says what it does, and a structural test asserts that exactly one
  export in either package can produce a thawed default and that its name
  matches `/reoptimis/i`;
- `reason` must be non-empty;
- `acknowledged` must be the **literal** `true` — `1`, `'yes'` and `{}` are all
  truthy and none of them is somebody saying yes;
- the plan carries `FREEZE_GLOBAL_REOPTIMISATION` at **blocking**, so the run can
  never report a clean status however valid the schedule it produces;
- and the placer is handed **earliest-legal-first** ordering rather than
  nearest-to-where-it-was. Under the hold rule a legal game is never moved, so a
  "global re-optimisation" that kept the hold rule would move nothing and prove
  nothing. This one genuinely re-solves the season the way incident 1's solver
  did, which is what makes the number of games it moves a measurement.

> **Superseded by Phase 4.2 on the last point only.** There is now an objective,
> so `reoptimiseWholeSeason()` uses it — the same one a change request uses, with
> the same default weights — and a global re-optimisation is no longer a synonym
> for a reshuffle: on this corpus it moves 8 games rather than 311. The old
> behaviour is reachable by name, as
> `objectiveWeights: { changedGame: 0, driftMinute: 0, changedSurface: 0 }`, which
> is the objective with change minimisation switched off and stamps
> `RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED` at `compromise`. That is what the
> positive control below now asks for, and it reproduces 4.1's 311/275 exactly.
> See [`MINIMAL_DIFF.md`](MINIMAL_DIFF.md).

---

## 4. The eight stages, and the contract each one signs

`baseline-ingest` · `change-request-apply` · `dislodge` · `initial-assignment` ·
`local-search` · `pair-repair` · `verify` · `freeze-audit`

Every stage carries a **required, filled-in `freezeContract`**:

| Field           | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `mutationKinds` | Which writes it performs. Empty means "this stage writes nothing". |
| `probe`         | `offers-frozen-move` or `writes-nothing`.                          |
| `claim`         | What it promises about frozen games. Required, non-empty.          |

`ResolveStageSchema` refuses a contract whose parts disagree: a stage declaring
mutation kinds must carry `offers-frozen-move` (the other probe would pass
without ever offering it a frozen game), and a stage declaring none must carry
`writes-nothing` (the other demands a rejection counter it can never produce). A
stage cannot exist in a state where its own probe would pass without testing
anything.

### Three interlocking guarantees

**One mutation chokepoint.** `applyMove(state, move, stageId)` is the only
writer. It judges the freeze itself, checks the slot against the inventory,
records the move, and returns a new deep-frozen state. A frozen game throws
`FrozenGameMoveAttempt` **naming the stage** — incident 2's report was "some
stage moved four games", and finding out which took a diff. `mayMove()` is the
polite half every compliant stage calls first; it is what maintains
`movesRejectedByFreeze`.

**A generated adversarial probe per stage.** All eight stages are run against
_one_ shared adversarial state — a game pushed into a clash, another lifted out
of its slot, and then everything frozen — and judged by their own declared
contract. The assertions are fixed: no frozen game moved, **and**
`movesRejectedByFreeze` grew by at least one.

That second half is the whole point. "No frozen game moved" is satisfied just as
happily by a stage that honours the freeze and by a stage that never looked at
the schedule, and the second kind is what a refactor produces. The counter is
the difference between _"it did not move anything it should not have"_ and _"it
was asked, and it said no"_. `tests/freezeScopes.test.js` proves the probe can
fail, against both a stage that swaps without asking and a stage that returns
the state untouched having consulted nothing.

**`freeze-audit` is a runtime stage, not a test.** It runs last in every
pipeline and derives its verdict from **the schedule against the baseline**,
game by game — never from the move ledger, because a stage that wrote around the
gate is exactly the stage that is not in the ledger. It also compares each
stage's placement delta against that stage's slice of the ledger, so a stage
that returned a hand-built state is caught by name.

Its own positive control is in the test file: a deliberately non-compliant stage
injected through `extraStages` (the same idiom as the rule engine's
`extraRules`) that reaches around the writer. An audit that cannot catch that is
not worth having, and the only way to know is to hand it one.

**Where a caller's stage lands: before `verify`, and therefore before the
audit.** `verify` and `freeze-audit` are the pipeline's two closing stages, both
declaring no mutation kinds, and every stage that can write a placement runs
before them — a caller's included. `extraStages` used to be spliced _between_
them, which put the one class of stage nobody in this repository wrote after the
only stage that checks the result: a move a caller's stage applied was never
judged by the standing rule engine. The verification cache made it louder than a
stale number. `runVerification()` keys on the move count, and `runResolve()`
reads the run's own `verification` out of that cache after the pipeline
finishes, so an extra stage that applied even one move pushed the count past the
key `verify` had cached under and `run.verification` came back `null` —
indistinguishable from `verify: false`, with nothing saying a verification had
been asked for and not produced.

---

## 5. A frozen game that cannot be satisfied

`FrozenGameUnsatisfiable`, thrown by default (`onUnsatisfiable: 'throw'`).

Everything in the message is **consumed, not re-derived**. The binding
constraint, the tightness ordering behind it and the slack in minutes come from
Phase 1.3's `checkKickoffAvailability()` / `orderByTightness()`; the rule-level
violations come from Phase 2.3's `runRuleEngine()`. A second answer computed in
the error path would be free to disagree with the first.

The error carries `constraintsConsulted`, `constraintsApplicable`, `rulesRun`
and `rulesExercised`, and the message states both denominators, because _"bound
by occupancy"_ and _"bound by occupancy, and that was the only thing checked"_
are different statements and an operator acting under time pressure must be able
to tell them apart. **It ends with the contract: the game has NOT been moved.**

An unsatisfiable **thawed** game is a different state entirely and is never
conflated with it: `RESOLVE_GAME_TIME_TBD` at `compromise`, the game kept
visible with a reason (incident 10), nothing raised.

---

## 6. What this package deliberately cannot do

- **Generate a season.** No round-robin generator, no matchup generator. A
  structural test forbids the string.
- **Invent a slot.** `inventory.js` derives every candidate date, surface and
  kickoff from the baseline schedule. The one exception is a slot a change
  request names — an externally-published fixture brings its own time and the
  club does not get to invent one for it — admitted per game and stamped
  `RESOLVE_CHANGE_SLOT_OUTSIDE_INVENTORY`.
- **Import `gameScheduling.js`.** That engine is week-indexed and generates
  matchups; this one is date-indexed and re-places rows. Bridging them is GAP-32
  and is not 4.1's work. `scheduleGames()` now **throws** on a `freeze` argument
  and names `resolve/applyChangeRequest()` and `resolve/reoptimiseWholeSeason()`
  in the message: accepting a freeze it could not honour would be incident 1's
  shape exactly, a caller believing a schedule is protected while every game is
  free to move.
- **Repair anything but facility legality.** Occupancy, permits, lighting,
  daylight, size and lining are Phase 1.3's and are repaired. Turnover floors,
  round-robin completeness, home/away balance and coach travel are the rule
  engine's; the `verify` stage reports what a change _introduced_ and repairs
  none of it, because trading one soft constraint against another needs the
  weighted objective **Prompt 4.2** owns by name. (4.2 has landed and the
  statement still holds: the objective's quality terms let the placer *prefer* a
  slot that breaks fewer of them, and nothing re-solves a season to improve one.
  See [`MINIMAL_DIFF.md`](MINIMAL_DIFF.md) §6.)
- **Blame the change request for what the schedule already carried.** Both
  halves of that are derived, not assumed. `baseline-ingest` records the
  blocking codes every game arrives with, so the four `Scrimmage` rows with no
  `game_formats.csv` entry are never dislodged by a run that had nothing to do
  with them; and `runResolve()` computes the baseline rule-engine verdict itself
  when the caller does not supply one, so the published season's 62 accepted
  exceptions are never reported as newly introduced.
- **Lift out more games than a clash needs.** Every party to a clash is _asked_
  — which is what puts "the 9v9 block would have had to move, and it is frozen"
  in the report — but only as many as clear it are dislodged, most-recently-
  written first: the thing that changed is the thing that yields.
- **Touch practices.** `autoScheduler.js` has its own locks and is untouched.
- **Supersede `placement/`.** That harness stays exactly as it was. It proves
  something this package structurally cannot — that flipping a constraint's
  _hardness_ changes where games go — because a minimal-diff re-solver leaves a
  legal schedule where it is under either hardness and reports no difference.
  Two modules, two questions.

**Freeze applies to games.** Commitments are inputs and are held by definition: a
coach's evening obligation, a field reservation, an external club's window. A
change request cannot edit one, so there is no disposition to give them.

---

## 7. The acceptance test

`tests/freezeScopes.test.js`, corpus-derived throughout.

The scenario is **assembled**, and the test says so. The corpus holds one
snapshot — the post-negotiation one, with the 08/22 fixtures at 10:00 and 12:00
— so there is no "before" file to load. `combined_schedule.csv` is the baseline
and the eight rows of `external_fixtures_published.csv` are the incoming change,
which runs history backwards (GAP-34: the corpus has no versioned schedule). The
delta is the same four games on the same date either way, and the question is
what happens to the **other 606**.

Meta-asserted before a solver runs: 679 rows; 69 on 08/22 and 4 on 08/23; the
08/23 delta is **0** and the 08/22 delta is **4**, each of exactly thirty
minutes. Without that the change request could be eight no-ops and "nothing
moved" would be trivially true.

|                                          | result                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Games moved outside the two dates        | **`[]`** — asserted by game, enumerated from the baseline's 679 rows, never from the run's own move list           |
| Games elsewhere in the season            | 606, every one byte-for-byte where families had it                                                                 |
| Games moved                              | the two 10:30 fixtures, both named by the request                                                                  |
| The 12:30 pair                           | displaced to **12:00** — the nearest kickoff the schedule already used, which is what the club actually negotiated |
| Same scenario, `reoptimiseWholeSeason()` with the change terms at zero | **275** games moved outside those dates (311 in total)                                        |
| Same scenario, `reoptimiseWholeSeason()` under the objective's defaults (4.2) | **8** in total, none of them outside those dates                                       |

The positive control is the most important assertion in the file. "Zero moved"
proves the freeze works only if the alternative would have moved something. The
threshold asserted is `> 50`, deliberately loose: 366 belongs to a different
algorithm on a different day and asserting it here would be fake precision, so
what was observed is recorded in the test instead.

Also covered: the composable variant `freezeAllExcept([{ date, format: '9v9' }])`
(under which the external fixtures are themselves frozen, so the change request
raises four `blocking` conflicts — the correct answer, not a failure); the
unsatisfiable frozen game, asserting `slackMinutes === -10` and
`constraintId === 'field-overlap-adjacency'`, which is incident 3's ten minutes
measured rather than described; one probe per stage; and the audit's positive
control.
