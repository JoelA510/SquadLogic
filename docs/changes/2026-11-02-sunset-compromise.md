# Sunset is a compromise, for practice and game (Step 0)

Status: **Step 0 only. Stopped at the brief's gate; nothing is built.** The practice half is a label
change. The game half is not: it changes the verdicts the core answers give and moves the
season-2026 corpus results (section 4). AGENTS.md rule 14 applies (the domain model and the
solver's inputs), so this waits for a decision before any code moves.

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

## 4. Games: every consumer of the labels

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

## 5. The stop conditions, one by one

| Condition from the brief                                            | Result                                                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the relabel changes a verdict, gate or waiver beyond label and text | **Practice: no** (P1-P7; 0 of 7,793 tests red). **Games: yes** (G1-G8: `infeasible` becomes `feasible`, a gate stops gating, a placement becomes legal) |
| a persisted value, CHECK, enum or schema changes                    | **No**, either half (P8, G10)                                                                                                                           |
| `fixtures/season-2026` results move                                 | **Practice: no. Games: yes** (G6, G7 and the five acceptance files above)                                                                               |
| the live game scheduler would start or stop enforcing               | **No** (section 4: it does not call this code)                                                                                                          |

So the brief's gate is tripped by the game half, and the PR is not built.

## 6. What is needed to go on

1. **The game half needs an owner-approved plan (rule 14), and one question answered.** A compromise
   finding bounds nothing in this model: the verdict, the legal-slot search, the capacity count and the
   placement gate all read `blocking` as the bound (G2-G7). So "relabel as a compromise" for games means
   a past-sunset kickoff is a **legal, placeable, countable** slot that carries a warning, and
   `latestClean` (which still binds at sunset: `cleanBindingKinds ['sunset']`, _executed_) is the only
   remaining sunset bound. Is that what is meant? If the owner wants the finding labelled a compromise
   while the answers stay bounded, the registry cannot say it (the type decides both), and that would be
   a separate design. Either way the 26 pinned results are rewritten from the plan, not from the new
   output, and the corpus acceptance tests (reserve capacity, scenario, feasibility 1 and 9) are
   re-derived on purpose.
2. **A weight for each `SOFT` claim** (section 1). Nothing states one; 1 is what the what-if projection
   uses and moves no result.
3. **`waivable`** stays `false` for both (a compromise needs no waiver); say so if not.
4. **Practice alone can go now.** It is label, text and tests: `PRACTICE_PAST_SUNSET` to `COMPROMISE`,
   `practice-daylight` to `SOFT` with a `history` entry (`hard` to `soft`, owner, 2026-11-02), the
   registry note (`season2026Constraints.js:506`) and the comments that say hard or blocking
   (`practice/daylight.js:10-11`, "Decision D1 makes it hard"; `docs/PHASE_8_9_PLAN.md:250`, D1). No test
   pins these labels today (0 red), so the PR would add the tests that make the relabel observable
   (the claim's type and weight, the evaluator's status, the effective severity under the practice
   registry, the seeded registry's `changed: false`) and prove each can fail against a planted defect.
   It needs only item 2.

## 7. Text that would change if the game half is built

`feasibility/reasonCodes.js:227-240` (the docstring explaining why `SUNSET_MARGIN_VIOLATED` is
`blocking`) and the test that pins it (`tests/feasibilityApi.test.js:561-570`); `docs/CONSTRAINT_REGISTRY.md:141`
(the "Sunset margin (15) | hard" row); `docs/RESERVE_CAPACITY.md:285-301` (the 14-18 reproduction);
`waivers/ledger.js:221` and `waivers/reasonCodes.js:173`; the `sunset-margin` record's `rationale` and
`note` (`season2026Constraints.js:428-437`); `docs/PHASE_8_9_PLAN.md` D7; and the corpus invariant
"No unlit game ends within 15 min of sunset" that the record cites (`fixtures/season-2026/README.md:62`),
which would become a warning in the engine and stay a rule on the league's sheet.
