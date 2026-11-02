# Unknown sunset: flag it, do not refuse it (practice repair)

Status: **plan only, not built. Stopped at the brief's gate: the season-2026 corpus result moves
(measured in section 5).** AGENTS.md rule 14 applies (it touches the solver's practice repair), so
this is the plan, written before the code, for approval.

Everything below was checked against `main` at `93987ac`. Labels follow rule 4: _statically
reviewed_ (read), _executed_ (run), _fully validated_ (run and the outcome checked).

## Owner decision (2026-11-02, verbatim)

> "Flag them, as coaches or orgs may be comfortable with extra conditions determined outside of the
> app - like going to end of dusk on a clear day, but not an overcast day. A warning keeps room for
> that, refusal would break configs that users may otherwise stick with."

Lesson 47 said "keep refusing" an unknown sunset in the repair; decision D4
(`docs/PHASE_8_9_PLAN.md:253`) said "flag, count, banner; never pass; do not refuse yet ... revisit
once the admin UI ships". The admin UI has shipped (the coordinates form), and the owner has now
chosen option 2 of `docs/changes/2026-11-01-followups-f1.md` section 5: the repair accepts the
candidate and flags it, as the Edge pass already does.

## 1. Step 0: every place a sunset or daylight condition refuses, drops or flags a practice

Method (_statically reviewed_, then each claim of absence shown to match something): `grep -rn -i
sunset` and `daylight` over `packages/core/src`, `supabase/functions` (19 files match `sunset`; none
is game-scheduling code: `grep -il sunset` over `gameScheduling.js`, `autoScheduler.js`,
`practiceScheduling.js`, `gameValidation.js` finds nothing, while the same search over the Edge
functions finds the 19), `supabase/migrations` (8 files match `sunset`: `20260930000000`,
`20261002000000`, `20261003000000`, `20261028010000`, `20261105010000`, `20261108020000`,
`20261110010000`, `20261114010000`; all read, none judges a sunset in SQL) and `frontend/src`; every
hit read. The brief names a migration `20261002010000`; there is none (`ls supabase/migrations |
grep 20261002` lists only `20261002000000_practice_exceptions_daylight.sql`).

### A. Unknown sunset (no table row, no coordinates, on unlit or undeclared ground)

| #   | Place                                                                                                                                                                                                    | Condition                                                                                           | Today                                                                                                                                                                                                                                             | This change                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A1  | `packages/core/src/practice/repair.js:514-519` (verdict), `:962-972` (the gate's `continue`), `:1044-1057` (finding), `:1068`, `:1584`, `:1609-1611` (TIME TBD)                                          | a re-home candidate with an unknown sunset on ANY date of its window, even if other dates are known | **REFUSE.** The candidate is dropped from tier 1 and tier 2; the series is TIME TBD `sunset-unknown` when every frozen-free same-venue candidate was refused                                                                                      | **the change**                   |
| A2  | `supabase/functions/_shared/engines/practice-daylight.ts:517-523` (verdict), `:758-772` (kept, listed in `report.unknown`), `:785-793` (a polar date); `auto-scheduler/index.ts:949-956`, `:1067-1072`   | a new placement on a venue with no coordinates                                                      | **FLAG.** Placement kept; `SUNSET_UNKNOWN` with its cause and the occurrence count; a `DAYLIGHT_UNKNOWN` warning finding; the run is `completed_with_warnings`                                                                                    | none                             |
| A3  | `practice-daylight.ts:839-847`                                                                                                                                                                           | a locked row, same condition                                                                        | **FLAG** (reported, never changed)                                                                                                                                                                                                                | none                             |
| A4  | `packages/core/src/practice/daylight.js:254-257`                                                                                                                                                         | the evaluator's own verdict                                                                         | listed in `unknown`, never allowed, never refused (the caller decides)                                                                                                                                                                            | none                             |
| A5  | `packages/core/src/practice/durationPhases.js:636-639`, `:1118-1121`, `:1325-1334`                                                                                                                       | an unknown date in the compression/survival report (unwired: no production consumer)                | the date keeps its current end, is counted, and the survival verdict is `UNKNOWN`: flag-like                                                                                                                                                      | none                             |
| A6  | `frontend/src/utils/practiceRepairPanel.js:122-130`, `PracticeRepairPanel.jsx:646-649`                                                                                                                   | no venue has coordinates, or the season has no time zone                                            | no calendar is passed, so the repair judges **no** sunset at all (`DAYLIGHT_UNCHECKED`, "No sunset was judged because ..."). The A1 refusal is unreachable from the panel until at least one venue has coordinates, then it applies to the others | none                             |
| A7  | `practiceRepairPanel.js:59-61`; `utils/practiceOccurrences.js:84`; `_shared/calendar/icsFeed.ts:155`                                                                                                     | text for a stored `sunset-unknown` TIME TBD                                                         | wording only; stays for rows saved before                                                                                                                                                                                                         | none                             |
| A8  | SQL: `20261002000000:73, 84-93` (CHECKs); enact RPCs `20261004000000`, `20261007000000:78`; writers `20261105010000:1195`, `20261108020000:1484` ("daylight stay the Edge function's (declared)")        | storage of a `sunset-unknown` reason                                                                | the CHECKs admit it; no SQL function judges a sunset                                                                                                                                                                                              | none, **no migration**           |
| A9  | `20261002000000:1106-1121` (copies `20261105010000:1260-1275`, `20261108020000:1549-1564`), `repairAdapter.js:153-156, 871-874`, `practice-persistence/index.ts:103-110`, `practiceRepairPanel.js:70-71` | a `past-sunset` or `sunset-unknown` TIME TBD window that ends before its series (a shape rule)      | **REFUSE** the save (22023 / `DAYLIGHT_MID_RANGE`). Not a sunset judgment; after the change the repair stops producing such windows, the rule stays for stored rows                                                                               | none                             |
| A10 | `auto-scheduler/index.ts:510-531`                                                                                                                                                                        | venue lighting or coordinates cannot be READ (a database read failure)                              | **REFUSE the whole run** (503, `scheduler.auto_refused`). Not a sunset condition; "refused rather than scheduled without a daylight check"                                                                                                        | none (listed because it refuses) |

### B. Known past sunset (not changed; recommendations in section 6)

| #   | Place                                                                                                                                                                                                | Today                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `repair.js:520-524`, `:974-985`, `:1030-1043`, `:1833-1846`                                                                                                                                          | **FLAG** (owner, 2026-10-27): kept, `daylightPastSunset` on the re-home and its recommendation, `PRACTICE_REPAIR_CANDIDATES_PAST_SUNSET`                                                                                                                    |
| B2  | `practice-daylight.ts:794-805`; `index.ts:1058-1066`                                                                                                                                                 | **FLAG**: a new placement past sunset is kept whole and reported in `pastSunset`                                                                                                                                                                            |
| B3  | `practice-daylight.ts:854-868`                                                                                                                                                                       | **FLAG**: a locked row past sunset is reported with a proposed fix, `applied: false`                                                                                                                                                                        |
| B4  | `durationPhases.js:654`, `:730`, `:1438-1449` (unwired; `tests/unwiredLayerImporters.test.js` lists no external production consumer)                                                                 | **REFUSE (TIME TBD)**: a known past-sunset date that neither a shorter practice nor an earlier start can save is "held out" (D8) and the survival report truncates the series from it. A proposal tool; nothing in the app calls it                         |
| B5  | `availability/reasonCodes.js:331` (`PRACTICE_PAST_SUNSET` is `BLOCKING`); `constraints/adapters/season2026Constraints.js:495-513`                                                                    | a **label**, not behaviour: the `practice-daylight` constraint is `HARD`, non-waivable. Its note (`:506`) still says the Edge truncates and that the repair "refuses every re-home candidate that runs past sunset or whose sunset is unknown": stale twice |
| B6  | Games: `availability/kickoff.js:437-462` (unknown = `COMPROMISE`, past = `SUNSET_MARGIN_VIOLATED` `BLOCKING`, `reasonCodes.js:326-327`); `ruleEngine/rules.js:788-823`; `feasibility/verdict.js:251` | **REFUSE** in the feasibility answer and the rule engine, on the 15-minute game margin. The live game scheduler does not call it (D7; no `sunset` in `gameScheduling.js` or in the game Edge functions). Not a practice                                     |

The owner's principle (warn, never refuse for sunset) therefore reaches beyond A1 in exactly two
places that really refuse a known past-sunset practice or game: **B4** and **B6** (and the label
**B5**). None is changed here.

## 2. Behavior after the change

- A re-home candidate whose sunset is unknown on some date is **accepted**: priced and placed like
  any other (declared, not optimised: D11, as for past sunset), never TIME TBD for that reason.
- It carries the same warning the Edge pass produces for an unknown sunset: `SUNSET_UNKNOWN`, its
  cause (`venue-coordinates-missing`), the first unknown date and how many dates are unknown, on the
  re-home and on its recommendation (the shape of `daylightPastSunset`), plus the existing
  `PRACTICE_REPAIR_CANDIDATES_SUNSET_UNKNOWN` finding (a **compromise**, so the result's status is not
  `ok`), now worded "kept and flagged".
- A candidate with BOTH known past-sunset dates and unknown dates carries both flags (today unknown
  wins and it is refused; keeping only the unknown flag would silently drop the known one).
- `PRACTICE_TBD_REASON.SUNSET_UNKNOWN` stays in the enum, the CHECKs and the readers for rows saved
  before; the repair no longer produces it.
- Lit ground, an override-exempt date and a known sunset are untouched. With no calendar nothing is
  judged, as now.

## 3. Design

**No schema, no CHECK, no enum, no migration, no persisted shape.** The flag is an optional key on an
in-memory result object, exactly as `daylightPastSunset` is (not persisted, not in any Zod schema;
`grep daylightPastSunset` finds `repair.js`, the panel's text helper, tests, and an unrelated audit
key of the same name in `auto-scheduler/index.ts:1161`), and the finding
code and its severity already exist. The Edge's representation already exists (`report.unknown`,
`DAYLIGHT_UNKNOWN`).

`packages/core/src/practice/repair.js` (the unknown branch only):

1. `judgeDaylight` (`:455-541`): `refusal` goes; `unknownFlag` is built from `judged.unknown[0]`
   (`{ code, cause, date, occurrences }`, the cause read from the evaluator's own `SUNSET_UNKNOWN`
   finding for that date); the past-sunset flag stops requiring `unknown === null`.
2. The gate (`:958-986`): no `continue` for unknown; the candidate gains `daylightUnknown`, is listed
   in `daylight.unknownFlagged` (replacing `daylight.refused`, which would be a field that is always
   empty), and `candidatesFlaggedSunsetUnknown` replaces `candidatesRefusedSunsetUnknown` (the
   counters stay mutually exclusive in `:528-539`). Every reader of those names is a test
   (`grep`: `repair.js`, `practiceRepairDaylight.test.js`, `practiceRepairAdapter.test.js`).
3. The finding (`:1044-1057`) is reworded; `sameBeforeDaylight`, `sameDaylightRefused`,
   `refusedHere`, `daylightEmptied`, `daylightRefused` and the `SUNSET_UNKNOWN` branch at `:1584`
   and `:1609-1611` become unreachable and are deleted ("honour it or delete it").
4. `pastSunsetField` gains a twin (`unknownSunsetField`) spread at the same two places (`:1559`,
   `:1917`), and the `REPAIR_REHOMED` message names it as it names a past-sunset one.
5. Header comment (`:117-160`), `PRACTICE_TBD_REASON` comments (`:263-281`), `reasonCodes.js`
   (`:238-245`, `:309`), the registry note (`season2026Constraints.js:506`, the unknown clause only).

**The Edge twin: no behaviour change** (A2, A3 already accept and flag). What changes is the proof
that the two agree. No daylight drift product test exists (the three product digests under
`supabase/functions/_shared/tests/` are for coach preferences, lighting overrides and practice
exceptions; none judges a sunset). The plan is one new cross-arm test, `tests/sunsetAgreement.test.js`,
over the full product of lighting (lit, unlit, undeclared) x coordinates (none, present) x end time
(early, late) x override (none, covering the window): the core arm is `repairPracticeLoss` over one
displaced series and one candidate, the Edge arm is `applyDaylightPostPass` over a placement in the
same slot; both must **keep** the practice and put it in the same class (exempt, within daylight,
flagged past, flagged unknown). The Deno mirror (`practice-daylight_test.ts`) keeps holding the Edge
arm in the runtime it deploys to.

**Panel and enact dialog: no change in this PR.** The panel prints every repair finding
(`PracticeRepairPanel.jsx:637-643`), so the reworded compromise finding reaches the admin; a per-row
"Sunset unknown" badge and a sentence in the enact dialog (the twins of `:442-445` and
`PracticeEnactDialog.jsx:126-129`) would be frontend-only and are left as an owner call
(section 6).

**Mock client and demo: they do not read the A1 branch.** The repair runs in the browser from the
core package, so the mock path gets the new behaviour with no change; `mockPracticeEnact.js` mirrors
the enact write, not the sunset judgment; every demo venue has coordinates
(`20261110010000:99-103`), so the demo never reaches an unknown sunset. The Edge function is stubbed
in the Playwright steps (`tests/e2e/steps/auto_scheduler.ts`), unchanged.

## 4. Tests and plants

Written during, each at the default 5 s timeout:

1. Core: an unlit venue of unknown sunset, one candidate: placed with the flag, **not** TIME TBD, not
   `sunset-unknown`, finding present and `compromise`, counters (replaces the "refuses" test at
   `practiceRepairDaylight.test.js:~385`).
2. A lit venue and a known-sunset venue in the same run are unaffected (flags absent, same
   placements as without the calendar).
3. Unknown and known venues compete for the same slot: two series, one slot; neither is refused for
   daylight, the loser is `contended` (not sunset), the winner carries exactly its own flag.
4. Mixed dates (the existing "past on some dates and unknown on others" case, now accepted with both
   flags); the cross-venue recommendation carries the flag; a decline re-offers the next candidate.
5. The corpus as it ships (no coordinates): nothing is refused or TIME TBD for sunset, every placed
   recommendation on unlit ground is flagged unknown, and the counts are derived from the plan and the
   graph, not from the result (rewrites the test pinned to the old behaviour, section 5).
6. `tests/sunsetAgreement.test.js` (section 3), with a meta-assertion that every class is non-empty.
7. Adapter: the `practiceRepairAdapter` cases that expect a `sunset-unknown` TIME TBD are re-aimed.

Plants (at most 3, each red then reverted): P1 the gate re-adds `continue` for an unknown candidate
(tests 1, 3, 5 go red); P2 `judgeDaylight` returns no unknown flag (tests 1, 4, 6 go red); P3 the
Edge pass drops an unknown placement (test 6 goes red, the Edge arm of the agreement).

Also run: the season fixture suite (the 60 test files that load `fixtures/season-2026` or run the
repair), unchanged apart from the rewritten items above; `deno check` and the Deno mirror tests
(Edge files are comment-only here).

## 5. Why this was not built: the gate in the brief

| Stop condition                                                             | Result                                                                                                                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The flag has no existing representation (schema, CHECK, enum, migration)   | **Not triggered** (section 3): optional in-memory key, existing finding code and severity, no migration.                                                                    |
| `fixtures/season-2026` results move                                        | **TRIGGERED** (below).                                                                                                                                                      |
| More than the unknown branch of repair, its Edge twin and their tests/docs | **Not triggered** as designed: `repair.js`, comments in `reasonCodes.js` and the registry note, one new test, docs. The Edge needs no code change; the panel is left alone. |

**What moves** (_executed_, on `93987ac`, a throwaway edit to `repair.js` that removed the unknown
refusal, reverted; `git status` clean afterwards). The season-2026 practice corpus swept as
`practiceRepairDaylight.test.js` sweeps it "as it ships" (the shipped weekend-only sunset table, no
venue has coordinates, so a weekday date on unlit ground has no sunset), a retirement from
2026-09-28 on each of the 29 surfaces the baseline stands on:

| Result of the 29 repairs                         | Today (refuse) | With the flag |
| ------------------------------------------------ | -------------- | ------------- |
| Series re-homed (tier 1)                         | 0              | 36            |
| Series TIME TBD                                  | 187            | 151           |
| of those, `sunset-unknown`                       | 97             | 0             |
| of those, `no-legal-slot-at-venue` / `contended` | 90 / 0         | 90 / 61       |
| Recommendations placed (tier 1 and tier 2)       | 0 of 187       | 102 of 187    |
| Candidates refused for an unknown sunset         | 992            | 0             |

The fixture's data files do not change; what the repair makes of them does, and substantially: with
no coordinates anywhere, today's repair places nothing on the shipped corpus. That is the owner's
intent ("refusal would break configs that users may otherwise stick with"), but it is also what the
brief calls a fixture result moving, so I stopped.

The same throwaway edit, run over the 60 test files that load the season fixtures or run the repair
(_executed_): 2,699 pass, **8 assertions in 3 files fail**, and all are pinned to the old behaviour:

- `tests/practiceRepairDaylight.test.js`: "refuses a candidate on unlit ground with no coordinates",
  "a candidate past sunset on some dates and unknown on others is still refused", "a venue mixing a
  past-sunset shape with an unknown one", and "the corpus as it ships ... refuses unknowns" (asserts
  `unknownRefused > 0` and `unknownTbd > 0`).
- `tests/practiceRepairAdapter.test.js`: "never geocodes: ... is sunset-unknown" and "names each
  exception row exactly once, within the DB enums" (its payload fixture needs a `sunset-unknown` TIME
  TBD from the repair).
- `tests/reasonCodeReachability.test.js`: two audits that fail only because the throwaway edit
  removed the finding's emission; the real change keeps it reachable.

Every other fixture-driven test (the game schedule, rosters, facility, permits, the draft
repair/enact/recommendation suites, the Edge daylight suites) is unchanged by it.

## 6. What I need, and the owner's list

To build: a go on the movement in section 5 (rewrite the "as it ships" corpus test to the new
behaviour: nothing refused or TIME TBD for sunset, the 102 placed recommendations flagged), and answers to:

1. **Priced the same?** An unknown-sunset candidate and a known-legal one at the same cost are tied by
   the usual order. Recommendation: leave it (D11, as past sunset); the flag is for the admin.
2. **Row badge and enact sentence for the unknown flag** (frontend-only, twins of the past-sunset
   ones). Recommendation: yes, as a follow-up PR; this one stays in core.
3. **Known past-sunset refusals found (not changed):**
   - **B4** `durationPhases` holds a date out as TIME TBD when nothing saves it. Unwired. Recommend
     leaving it until it is wired, then applying the principle there (keep the date, flag it).
   - **B5** the `practice-daylight` constraint is `HARD`/non-waivable and `PRACTICE_PAST_SUNSET` is
     `BLOCKING` though behaviour has been a flag since 2026-10-27. Recommend a small docs/label PR
     (compromise severity, a rewritten note); `HARD` is the operator's 2026-09-27 wording, so the owner
     should say.
   - **B6** games: `SUNSET_MARGIN_VIOLATED` is `BLOCKING` in the feasibility answer and the rule
     engine on the 15-minute margin the league's own sheet states; the live game scheduler does not
     enforce it. Recommend a separate decision; the practice principle does not obviously carry over.

## 7. After approval: records

A new lesson (number 83 or 84, after whichever open PR lands its 83 first) superseding lesson 47,
without rewriting it; a dated note under D4 in `docs/PHASE_8_9_PLAN.md` and under the "unknown
sunset is still refused" lines in `docs/changes/2026-10-27-phase-d-scheduling.md:457`,
`docs/architecture/practice-scheduling.md:103-105` and `docs/PHASE_8_9_PLAN.md:164`; section 5 of
`docs/changes/2026-11-01-followups-f1.md` marked decided.
