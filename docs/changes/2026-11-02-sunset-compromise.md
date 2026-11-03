# Sunset is a compromise, for practice and game (Step 0)

Status: **practice built (#694); the game half built in the following change (section 10).** Step 0
found that the practice half is a label change and the game half is not: it changes the verdicts the
core answers give and moves the season-2026 corpus results (section 4). The coordinator's decisions of
2026-11-02 follow in section 5. AGENTS.md rule 14 applies (the domain model); the practice half was
agreed, and the owner then approved the game half (section 5, item 5).

Everything below was checked against `main` at `228980a` (#691). Labels follow rule 4: _statically
reviewed_ (read), _executed_ (run), _fully validated_ (run and the outcome checked).

## Owner decision (2026-11-02, verbatim)

> "Relabel the past-sunset constraint as a compromise for both practice and game."

The principle behind it: a sunset condition warns, it never refuses, because coaches and
organisations may accept conditions outside the app (for example finishing at dusk on a clear day);
refusal would break configs users would otherwise keep. #691 already moved the practice repair to
"flag, do not refuse" (lesson 84); this asks for the labels to say what the behaviour already is.

## 1. What "relabel" is made of

Two labels per condition, and they act as a pair (_statically reviewed_):

- **The code's base severity**, `AVAILABILITY_REASON_SEVERITY` (`availability/reasonCodes.js:327`
  `SUNSET_MARGIN_VIOLATED`, `:331` `PRACTICE_PAST_SUNSET`): `BLOCKING`. Any one blocking finding
  makes a check `rejected` (`facility/reasonCodes.js:281`). The compromise class is
  `AVAILABILITY_SEVERITY.COMPROMISE`, as `SUNSET_UNKNOWN` (`:326`) and
  `PRACTICE_REPAIR_CANDIDATES_SUNSET_UNKNOWN` already are.
- **The claiming constraint's type**: `sunset-margin` (`constraints/adapters/season2026Constraints.js:421-443`)
  and `practice-daylight` (`:491-516`) are `HARD`, `weight: null`, `waivable: false`. Under a registry the
  type decides the severity of every code it claims (`CONSTRAINT_TYPE_SEVERITY`,
  `constraints/reasonCodes.js:81-85`; `effectiveSeverityTable`, `constraints/severity.js`), overriding the
  base: `HARD` is blocking, `SOFT` is compromise. Changing only the base severity is therefore overridden
  back to `blocking` by every registry-aware reader and shows as a `changed: true` override
  (`docs/CONSTRAINT_REGISTRY.md` section 4: "Every override the seeded registry produces has
  `changed: false`, and a test asserts it."). The compromise class for a claim is `SOFT`.
- **A `SOFT` constraint must state a weight** (`constraints/schemas.js:180-186`), and `retypeConstraint`
  "refuses to invent a `weight` when softening" (`docs/CONSTRAINT_REGISTRY.md:181`). Nobody has stated
  one for either claim. The weight changes no result today (`constraints/whatIf.js:50-53`: severities come
  from the type, not the weight). A type change is also recorded in the record's `history` (`from`, `to`,
  `by`, `note` required, `ConstraintTypeChangeSchema`).

## 2. Method

1. Searches over `packages/core/src`, `frontend/src`, `supabase/functions`, `supabase/migrations`,
   `supabase/tests`, `docs/sql`, `fixtures`, `scripts` and `tests` for the ids (`PRACTICE_PAST_SUNSET`,
   `SUNSET_MARGIN_VIOLATED`, `practice-daylight`, `sunset-margin`) and for every branch on a `blocking`
   severity in core. Each absence below was searched with a control that matches something.
2. A scratch edit of the working tree (never committed, reverted with `git checkout`) made each pair
   the compromise class: **P** the practice pair (`PRACTICE_PAST_SUNSET` to `COMPROMISE`,
   `practice-daylight` to `SOFT`, weight 1), **G** the game pair (`SUNSET_MARGIN_VIOLATED` to `COMPROMISE`,
   `sunset-margin` to `SOFT`, weight 1).
3. A behaviour probe (a throwaway script, not in this PR) asked the same questions of the untouched tree,
   of P and of G (section 4); then the full suite (`vitest run`, default timeouts) ran on each.

_Executed_: untouched `228980a`: 488 files, 7,793 tests, all pass (653 s, on a machine shared with other
runs). With **P**: 7,793 of 7,793 pass. With **G**: 26 fail, in 7 files.

## 3. Practice: every consumer of the labels

| #   | Place                                                                                                                                                                                                                    | What `HARD` / `BLOCKING` does today                                                                                                                                                                                                  | After P                                                                      | Class                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------- |
| P1  | `practice/daylight.js:312` `status: deriveAvailabilityStatus(findings)`                                                                                                                                                  | `rejected` when any occurrence is past sunset. Its one production caller, `repair.js:496`, reads `flagged`, `unknown`, `meta` and the `SUNSET_SOURCES_DISAGREE` count, never `status`; no test goes red when it changes (_executed_) | `compromised` (_executed_ on a rig: rejected to compromised)                 | label, no reader                 |
| P2  | `practice/repair.js:520-524, 974-985, 1030-1043`                                                                                                                                                                         | past sunset is a flag since 2026-10-27; the repair judges by `flagged`, not by severity                                                                                                                                              | none                                                                         | none                             |
| P3  | `practice/durationPhases.js:656, 732, 1132, 1435`                                                                                                                                                                        | uses the code as a TIME TBD _reason_ for a held-out date (B4 of `2026-11-02-unknown-sunset-flag.md`); reads no severity; unwired                                                                                                     | none                                                                         | none (B4 stays an owner item)    |
| P4  | the claim `SEASON_2026_PRACTICE_DAYLIGHT_CONSTRAINT`; `buildSeason2026PracticeConstraintRegistry` is called only from `tests/practiceDaylight.test.js` and `tests/practiceDurationPhases.test.js` (no production caller) | `hard`, no weight, `waivable: false`; registry stats `hardCount 10`, `softCount 2`                                                                                                                                                   | `soft`, weight needed; stats 9 and 3 (_executed_); nothing asserts the stats | label, one decision (the weight) |
| P5  | waivers (`waivers/apply.js`, `ledger.js:221, 271`)                                                                                                                                                                       | act on rule-engine findings; the rule engine does not evaluate practices (the claim's own note, `season2026Constraints.js:479-485`)                                                                                                  | none                                                                         | none                             |
| P6  | Edge twin `_shared/engines/practice-daylight.ts`; `auto-scheduler/index.ts:1059-1074`                                                                                                                                    | the file holds no `severity` or `blocking` word (searched; control: the file holds `PRACTICE_PAST_SUNSET` 5 times); the persisted run finding `PRACTICE_PAST_SUNSET` is already `severity: 'warning'`                                | none                                                                         | none, no Deno change             |
| P7  | frontend `PracticeRepairPanel.jsx:445`, `PracticeEnactDialog.jsx:128`, `utils/practiceRepairPanel.js`                                                                                                                    | the badge class is `badge warning`, hard-coded; the files import nothing from `availability/` or `constraints/` (searched)                                                                                                           | none                                                                         | none, no UI string moves         |
| P8  | persisted values: `supabase/migrations`, `supabase/tests`, `docs/sql`, `fixtures`                                                                                                                                        | no hit for `PRACTICE_PAST_SUNSET`, `practice-daylight` (control: the same search over `supabase/functions` hits the Edge files). `past-sunset` and `sunset-unknown` in SQL are `tbd_reason` values, not severities                   | none                                                                         | none, no schema, CHECK or enum   |

## 4. Games: every consumer of the labels (approved by the owner, next PR; not changed by this PR)

The live game scheduler does not call any of this (_executed_: `grep -il sunset` over
`gameScheduling.js`, `autoScheduler.js`, `practiceScheduling.js`, `gameValidation.js`, `gameMetrics.js`,
`practiceMetrics.js`, `gamePersistence*.js` finds nothing; control: the same search over `repair.js` and
`kickoff.js` finds both; the only Edge function entry points naming sunset are `auto-scheduler` and
`practice-persistence`, both practice). Nothing in `frontend/src`, `supabase/functions` or `scripts` imports `feasibility/`,
`ruleEngine/`, `resolve/`, `reserve/`, `attribution/` or `constraints/`; the only imports from these
directories are `availability/calendar.js`'s weekday helper (`scripts/generate-scoring-parity.mjs:38`) and
`scenario/inputs.js`'s `canonicalJson` (two frontend files), neither of which reads a severity (control: the
same roots import `practice/` in 3 frontend files). So these are core answers that tests, and later the
planner, read; the live scheduler neither starts nor stops enforcing anything. That is also why the move
below does not touch persistence: it is every verdict the core gives, not a stored value.

| #   | Place                                                                                                                                              | What `HARD` / `BLOCKING` does today                                                                                                   | After G (_executed_ unless noted)                                                                                                                                                                                                                                                                                       | Class                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| G1  | `availability/kickoff.js:437-462`, `checkKickoffAvailability` status                                                                               | a kickoff past the 15-minute margin is `rejected`                                                                                     | `compromised`                                                                                                                                                                                                                                                                                                           | **verdict**             |
| G2  | `kickoff.js:932` `latestLegalKickoff`                                                                                                              | skips any candidate with a blocking finding: sunset bounds the latest legal kickoff                                                   | sunset no longer bounds it (_statically reviewed_)                                                                                                                                                                                                                                                                      | **verdict**             |
| G3  | `ruleEngine/rules.js:788-823` `sunsetMarginRule`, `engine.js` re-severity, `report.js` buckets                                                     | a past-sunset game is a blocking violation. The published corpus has none (no `SUNSET` code in its report)                            | one game pushed past the 11/14 limit: blocking 5 to 4, compromise 58 to 59. The corpus report does not move                                                                                                                                                                                                             | **verdict (pass/fail)** |
| G4  | `feasibility/verdict.js:314, 371`; `queries.js` `canGameMove` `:482`, `canTeamPlay` `:885`, `feasibleKickoffBounds` `:1386`; `moveRequest.js:1254` | `blocked` is "has a blocking finding": the move is `infeasible`                                                                       | `canGameMove` for that move: **`infeasible` to `feasible`, tight**, with the margin still -184 min (a feasible answer that is 184 min past its bound). `feasibleKickoffBounds` 11/14 Pitch 2: hard-binding kinds `['sunset']` to `[]`, plus new findings `FEASIBILITY_BOUND_UNSTATED` and `FEASIBILITY_RULE_UNENFORCED` | **verdict**             |
| G5  | `resolve/legality.js:111-152`, `resolve/objective.js:469, 527, 574`                                                                                | a placement with a blocking finding is illegal and costs a blocking term                                                              | legal, costs a compromise term (_statically reviewed_)                                                                                                                                                                                                                                                                  | **gate**                |
| G6  | `reserve/capacity.js:259`                                                                                                                          | a blocking candidate ends the slot run: sunset caps 11/07 and 11/14                                                                   | season-2026 reserve capacity **14-18 slots a week, 163 in all, becomes 17-20, 189**                                                                                                                                                                                                                                     | **corpus result**       |
| G7  | `scenario/run.js:149, 1036`, `scenario/relocation.js:442`                                                                                          | unaccepted blocking findings refuse promotion (`SCENARIO_PROMOTION_REFUSED`); a blocking candidate is not offered for relocation      | not refused, offered (corpus: the "no venue X" report places fixtures it could not)                                                                                                                                                                                                                                     | **gate, corpus result** |
| G8  | `attribution/explain.js`, `minimal.js`, `claims.js`, `attribution/reasonCodes.js:155`                                                              | "it stands at X rather than Y because Y breaks `SUNSET_MARGIN_VIOLATED`"; sunset is one of a certified minimal blocking set           | sunset leaves the blocking set                                                                                                                                                                                                                                                                                          | **verdict**             |
| G9  | `waivers/ledger.js:221, 271`, `waivers/reasonCodes.js:173`                                                                                         | `waivable: false`: a waiver for it is refused (`WAIVER_CONSTRAINT_NOT_WAIVABLE`); the comment says "not a rule anybody may sign away" | `waivable` unchanged and moot (a compromise needs no waiver); the comment goes stale                                                                                                                                                                                                                                    | text                    |
| G10 | persisted values, UI                                                                                                                               | none (searches as P8; nothing in `frontend/src` shows game sunset)                                                                    | none                                                                                                                                                                                                                                                                                                                    | none                    |

The 26 red tests (_executed_, with G): `attribution` (3: the minimal blocking set), `facilityAvailability`
(2: "the latest unlit kickoff is bound by sunset", the replay that injects a breach), `facilityPracticeLayer`
(1: relocation counts 14 to 16), `feasibilityApi` (7: acceptance 1, 2, 9, the restore controls;
acceptance 9 is "can this team play at 6pm in November?" answering no, now yes), `reasonCodeReachability`
(2: `RESERVE_CAPACITY_AT_REQUIREMENT` is no longer emitted on the corpus), `reserveCapacity` (6: "14-18
slots per week", "sunset trims the two November dates to the bare minimum"), `scenarioBranching` (5:
incident 10's unplaceable fixtures). Five of the seven files are corpus acceptance tests: the season-2026
results move.

## 5. Decisions (coordinator, 2026-11-02)

1. **Games: held in this PR.** A past-sunset kickoff becoming a legal, placeable, countable slot, and 26
   acceptance results flipping, is a domain decision for the owner (answered in item 5). G1 to G10 stay in
   this document; the game pair (`SUNSET_MARGIN_VIOLATED`, the `sunset-margin` claim) is untouched here and
   every game test still pins `blocking` and `hard`.
2. **Practice: proceed as its own PR.** The weight of the `SOFT` claim is **1**, the what-if default
   (`constraints/whatIf.js:50-53`), which moves no result today. It is a placeholder that nobody has
   stated: it is recorded as one in the claim's note and in its `history` entry, and no test pins the
   number.
3. **`waivable` stays `false` on both claims.** A compromise needs no waiver; the flag is moot, not
   changed.
4. **Scope of this PR:** `PRACTICE_PAST_SUNSET` `BLOCKING` to `COMPROMISE`; `practice-daylight` `HARD` to
   `SOFT` with a `history` entry (`hard` to `soft`, owner, 2026-11-02); the claim's note and rationale
   (the real behaviour, including the unknown-sunset clause); the comments that say hard; and new
   plant-proved tests, since none existed.
5. **Games: approved by the owner (status: built in the following change, section 10).** Owner, 2026-11-02, verbatim:
   "Yes to legal-with-a-warning for kickoffs after sunset, because some orgs have portable lighting or other workarounds." So `SUNSET_MARGIN_VIOLATED` and the `sunset-margin` claim become
   `COMPROMISE` and `SOFT` (weight 1, a stated placeholder, `waivable: false`); a past-sunset kickoff is legal,
   placeable and countable and carries a warning; `latestClean` stays the only remaining sunset bound; and the
   answers in G1 to G8 change as tabled. It is a second PR on a fresh branch from `main` once this one has merged
   (both edit `season2026Constraints.js` and `availability/reasonCodes.js`, so they are not stacked); its 26 pinned
   results are rewritten from this plan, not from the new output.

## 6. What was built (practice), and how the Step 0 statements fit together

Step 0 said that no test pinned these labels, and that `tests/practiceDurationPhases.test.js:1283-1290`
pins text of the registry note. Both are true, and they are about different things (_executed_): with the
severity and the type both changed, 0 of 7,793 tests went red, so **no test pinned the severity or the
type**. Three tests pin words of the claim's **note**, not its labels: `practiceDurationPhases.test.js:1283-1290`
(`declared, not optimised (D11)` and `never applied`), `practiceRepairDaylight.test.js:386-396` (#691: the repair
"likewise keeps every re-home candidate and flags it, past sunset (owner, 2026-10-27) or with an unknown
sunset (owner, 2026-11-02)", "an unknown sunset is never read as legal and never refused", and no
mention of the old refusals) and `practiceDaylight.test.js:244` (`practiceScheduling.js or
autoScheduler.js`). The scratch edit of Step 0 did not touch the note, so they stayed green; the rewritten
note keeps every one of those phrases and all three pins pass on it (_executed_). The note's only
changed sentence is the one that said "the HARD type above is the operator ruling ... the claim is
enforced as a flag"; it now says the claim was HARD (the operator ruling, kept in `history`), is SOFT since
the owner's decision, that the weight is a placeholder, and that the game claim waits.

**Changed:**

- `availability/reasonCodes.js`: `PRACTICE_PAST_SUNSET` is `COMPROMISE`, with the reason beside it.
- `constraints/adapters/season2026Constraints.js`: the `practice-daylight` claim is `SOFT`, weight 1,
  `waivable: false`, with one `history` entry; note and rationale rewritten.
- `practice/daylight.js`: the header no longer says the rule "makes it hard"; it says what the severity is
  and that nothing else changed.
- Registry stats of the practice registry: hard/soft 10/2 to 9/3. No test or doc stated them; test K4 now
  states them as a count over the input list of constraints.
- `docs/PHASE_8_9_PLAN.md` (a dated D1 note, the D1 row left as written), `docs/architecture/practice-scheduling.md`,
  lesson 85, the CHANGELOG.

**Not changed:** the game pair; any persisted value, CHECK, enum or schema; the Edge twin (it has no
severity and its persisted finding is already a `warning`); the frontend (the badge is hard-coded
`badge warning`); `waivable`; `durationPhases.js` (B4 stays an owner item); every number the evaluator,
the repair or the Edge pass computes.

**Tests (`tests/practiceDaylight.test.js`, block K).** K1: the minute past a table sunset is flagged, its
finding is a `compromise` and the check `compromised` (control: the practice that ends at sunset alone has no
finding and is `allowed`). K2: under the practice registry the code is a compromise and the registry
overrides no severity, so a one-sided change shows up as an override. K3: the claim is `soft`, states a
weight and is not waivable. K4: the practice registry is the game registry plus one soft claim, counted over
`SEASON_2026_CONSTRAINTS`, not read from the claim. K5: the retype is on record. Every expected value is
written from the owner's decision as words, or counted over the input list; none is read from the severity
table or the claim record under test. Default 5 s timeout.

**Plants** (three, each red then reverted, _executed_): K-P1 `PRACTICE_PAST_SUNSET` back to `BLOCKING`
(K1 and K2 red); K-P2 the claim back to `hard` with no weight (K2, K3 and K4 red); K-P3 the claim's
`history` emptied (K5 red).

## 7. The questions that were open

1. **Games: answered (section 5, item 5).** A compromise finding bounds nothing in this model: the verdict,
   the legal-slot search, the capacity count and the placement gate all read `blocking` as the bound
   (G2-G7). So "relabel as a compromise" for games means a past-sunset kickoff is a **legal, placeable,
   countable** slot that carries a warning, and `latestClean` (which still binds at sunset:
   `cleanBindingKinds ['sunset']`, _executed_) is the only remaining sunset bound. That is what the owner
   approved, with the reason that some organisations have portable lighting or other workarounds. The 26
   pinned results are rewritten from the plan, not from the new output, and the corpus acceptance tests
   (reserve capacity, scenario, feasibility 1 and 9) are re-derived on purpose, in the game PR.
2. **The weight.** 1 is a placeholder (section 5). If the owner wants a real cost for a past-sunset
   practice, it is one number on the claim and moves no result until something reads it.
3. **B4** (`durationPhases.js`: an unwired tool that holds a known past-sunset date out as TIME TBD) is
   unchanged and still an owner item.

## 8. Text that changes in the game PR (approved, next)

`feasibility/reasonCodes.js:227-240` (the docstring explaining why `SUNSET_MARGIN_VIOLATED` is
`blocking`) and the test that pins it (`tests/feasibilityApi.test.js:561-570`); `docs/CONSTRAINT_REGISTRY.md:141`
(the "Sunset margin (15) | hard" row); `docs/RESERVE_CAPACITY.md:285-301` (the 14-18 reproduction);
`waivers/ledger.js:221` and `waivers/reasonCodes.js:173`; the `sunset-margin` record's `rationale` and
`note` (`season2026Constraints.js:428-437`); `docs/PHASE_8_9_PLAN.md` D7; and the corpus invariant
"No unlit game ends within 15 min of sunset" that the record cites (`fixtures/season-2026/README.md:62`),
which would become a warning in the engine and stay a rule on the league's sheet.

## 9. Gates run for the practice PR (_executed_ unless noted)

Typecheck; `eslint . --max-warnings=0`; `check:unused` (knip); `check:advisors`; the full `test:coverage` at
the default timeout (488 files, 7,798 tests: the 7,793 of Step 0 plus K1 to K5; thresholds met); the frontend
build with CI's stand-in variables and `check:bundle`; the full mock E2E (214 scenarios, `--workers=1
--trace off`); `git diff --check`; Prettier on every file touched that was clean on `main`. The season-2026
fixture tests are in the suite and pass unchanged: no existing test was edited. **Not run, and why:** the Deno
mirror tests and `deno check` (nothing under `supabase/functions` changed), pgTAP and the real-backend E2E (no
SQL, no Edge or schema change). The game half's gates are its own PR's.

## 10. The game half (built in the following change)

Owner, 2026-11-02, verbatim: "Yes to legal-with-a-warning for kickoffs after sunset, because some orgs have portable lighting or other workarounds." So `SUNSET_MARGIN_VIOLATED` is a compromise, the `sunset-margin` claim is `soft` (weight 1, a placeholder
nobody has stated; `waivable: false`; the retype on its `history`), and a kickoff past the daylight limit is legal,
placeable and counted, carries the warning, and is stopped only by the clean bound.

**Changed:** `availability/reasonCodes.js` (the severity); `constraints/adapters/season2026Constraints.js` (the claim: type,
weight, history, rationale, note); `availability/kickoff.js` (below); the comments that called sunset a bound
(`feasibility/reasonCodes.js`, `waivers/reasonCodes.js`, `waivers/ledger.js`); `docs/CONSTRAINT_REGISTRY.md`,
`docs/RESERVE_CAPACITY.md`, `docs/MODEL_GAPS.md`, `docs/PHASE_8_9_PLAN.md` (D1 and D7 notes). **Not changed:** the live game
scheduler (it reads no sunset), any persisted value, CHECK, enum or schema, the Edge functions, the frontend, `waivable`.

### 10.1 Two corrections to the Step 0 table (G2 and G4)

- **G2 was marked "statically reviewed" and was wrong.** `latestLegalKickoff()` took the daylight limit into its search
  ceiling, and `orderByTightness()` into the binding constraint, without asking the severity table. Relabelling the code
  alone left the answer "latest hard kickoff 14:56, bound by nothing" (_executed_: `hardBinding []` and a new
  `FEASIBILITY_BOUND_UNSTATED`), and the reserve capacity attributed every day's cap to sunset (`cappedByKinds
['sunset']`) while the permit was what stopped it. `kickoff.js` now reads `sunsetBlocks()` (the same table the finding's
  severity comes from) in both places: the daylight limit still appears, ordered and reported, but bounds the legal search
  and binds only while breaking it blocks. That is why the pinned results were 49, not the 26 the relabel alone moved.
- **G4's "new `FEASIBILITY_RULE_UNENFORCED`" was a misreading, traced.** `ruleCoverage()` lists a constraint as unenforced when no
  rule claims it, whatever its type; `sunset-margin` has a rule, so the retype cannot add or remove it (_executed_: the
  unenforced ids are `coach-maximum-gap` and `kickoff-variety` before and after, and the same two non-verdict-bearing unknowns
  ride on the same past-sunset move before and after). I had only the "after" findings when I wrote it. Documented, no fix
  needed. What is new on that move is `FEASIBILITY_TIGHT` (info).

### 10.2 The pinned results, before and after (_executed_)

All derived from the plan, not read back from the new output (section 10.3). Files and tests that moved: 49 tests in 7 files.

| Result (season-2026 corpus)                               | Before                                                 | After                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Latest legal kickoff, unlit Alder Pitch 2, 10/24 (11v11)  | 16:24 (sunset less margin less 90)                     | 18:30 (permit close less 90); 16:24 is the last kickoff without a warning                             |
| Bounds at Alder P2 on 11/14: hard / clean / tight band    | 14:56 sunset / 14:56 / 0                               | 18:30 permit / 14:56 sunset / 214 min                                                                 |
| `canGameMove` to 18:00 past sunset                        | infeasible, margin -184                                | feasible, tight; margin -184 is the sunset limit, a compromise bound, broken                          |
| "Can this 9v9 team play at 6pm in November?"              | no (8 of 8 cells infeasible)                           | yes, 8 of 8 feasible, margin 55 = permit room, sunset a compromise claim                              |
| Reserve capacity per week                                 | 14-18 slots (163), 11/07 and 11/14 at the bare minimum | 17-20 slots (189); the permit caps every date, none at the bare minimum                               |
| Dates short of the requirement once conditions are judged | 5                                                      | 1 (09/19)                                                                                             |
| Minimal blocking set of an over-booked slot               | 3 constraints                                          | 2 (same-ground, permit); sunset is a warning on it                                                    |
| "No venue Brookside" withdrawal (72 games)                | 60 relocated, 12 TIME TBD                              | 72 relocated; the 12 carry the sunset warning (10/03, 10/17, 10/24, 10/31)                            |
| Bounds cells with a hard bound and nothing clean          | 772                                                    | 772 reproduced exactly in a sunset-hard world, plus the cells where a game never fits inside daylight |

### 10.3 How the expectations were derived

- **`tests/helpers/reserveOracle.js`** states how many slots a day holds from the permit rows and the format's timing alone
  (blackout, open, close, lights-off), sharing only the permit and lighting resolvers. The capacity report must agree on every
  date and surface, including the conditional verdicts (counted from the games on the overlapping ground). It agreed first time.
- **The world as it was**, reproduced from the data: the same questions asked with the sunset margin retyped `hard`, through
  `whatIfConstraintType()` in `feasibilityApi` and a `RETYPE` scenario override in `scenarioBranching`. That reproduces the
  reviewed 772 and the 12 shelved games exactly, so the decision's whole effect is the difference between the two worlds. The
  hard answer is never earlier than before, the clean answer never moves, and every newly never-clean cell is unlit ground.
- **A published-season replay that only counted blockers would have gone blind**: `finds no permit breach and no daylight
breach` now also asserts there is no `SUNSET_MARGIN_VIOLATED` at any severity, with a negative control (the same replay on
  sunsets two hours earlier finds warnings and no blocker).
- Expected values are written as arithmetic over the raw rows (permit close less occupancy, sunset less margin less
  occupancy), never as the number the new code printed.

### 10.4 Plants (three, each red then reverted, _executed_), and what they do not reach

L-P1 `SUNSET_MARGIN_VIOLATED` back to `BLOCKING` (42 tests red); L-P2 the claim back to `hard` with no weight (25 red);
L-P3 `sunsetBlocks()` always true (28 red). Every test changed or added for the decision is red under at least one, **except**
these, which are inputs moved to keep a premise rather than relabel-detectors, each guarded by its own meta-assertion:
`counts the grid's unknowns once` (a grid the permit closes on, because the 6pm grid is now feasible with nothing to roll up),
`holds at every severity a blocker can carry` (a caller-bounded cell supplies the info-only row the corpus no longer has),
`the two 15-minute margins: main's 15:05 ...` and the `finds no permit breach` replay line (assertions about quantities the
decision leaves unmoved; the replay's control is red under L-P1), and `reports how many candidates...`, `keeps every fixture...`
and `carries the fixture accounting's verdict...` (the incident-10 accounting, moved onto the sunset-hard branch; the plain
withdrawal strands none, asserted in `keeps every fixture`, which is red under all three).

### 10.5 For the owner

- `canGameMove` now answers `feasible` with a negative margin for a kickoff past the daylight limit. By the sign convention the
  margin is the compromise bound broken by that many minutes; the verdict is `feasible` and `tight`. Say if a past-sunset move
  should read differently.
- Three existing tests carry explicit per-test timeouts for whole-corpus scans (120 s and 300 s in `feasibilityApi`) and
  `scenarioBranching` raises its file timeout to 30 s; they were not mine and are unchanged. The changed whole-corpus rule now
  runs two scans (about twice as long).
