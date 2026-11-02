# Unknown sunset: flag it, do not refuse it (practice repair)

Status: **built.** The first pass of this document was the plan, which stopped at the brief's gate
because the season-2026 corpus result moves (section 5). The coordinator approved the movement on
2026-11-02 ("it is the direct consequence of the owner's decision ... shown-otherwise"), so this is the
plan as approved and as built. AGENTS.md rule 14 applies (it touches the solver's practice repair).

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

### B. Known past sunset (not changed; recommendations in section 6, "For the owner")

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

## 3. Design, as built

**No schema, no CHECK, no enum, no migration, no persisted shape.** The flag is an optional key on an
in-memory result object, exactly as `daylightPastSunset` is (not persisted, not in any Zod schema;
`grep daylightPastSunset` finds `repair.js`, the panel's text helper, tests, and an unrelated audit
key of the same name in `auto-scheduler/index.ts:1161`), and the finding code and its severity
already exist. The Edge's representation already exists (`report.unknown`, `DAYLIGHT_UNKNOWN`).

`packages/core/src/practice/repair.js` (the unknown branch only):

1. `judgeDaylight`: `refusal` is gone. `unknownFlag` is built from the evaluator's first unknown
   occurrence (`reason`, `code: 'SUNSET_UNKNOWN'`, the evaluator's own `cause`, the first unknown
   date, the counts); the past-sunset `flag` no longer requires `unknown === null`, so a candidate
   with both kinds of date carries both.
2. The gate has no `continue` for unknown. The candidate entry gains `daylightUnknown`; each flagged
   candidate is listed in `daylight.unknownFlagged` (replacing `daylight.refused`, which would be a
   field that is always empty) and `candidatesFlaggedSunsetUnknown` replaces
   `candidatesRefusedSunsetUnknown`. The counters still partition `candidatesJudged`: a candidate with
   both flags is counted once, as unknown, and is listed in both lists. Every reader of the old names
   was a test (`grep`: `repair.js`, `practiceRepairDaylight.test.js`, `practiceRepairAdapter.test.js`).
3. The finding `PRACTICE_REPAIR_CANDIDATES_SUNSET_UNKNOWN` (still a **compromise**, so the result's
   status is not `ok`) now says "kept and flagged"; its details are `flagged` and `sameVenue`.
   `sameBeforeDaylight`, `sameDaylightRefused`, `refusedHere`, `daylightEmptied`, `daylightRefused`
   and the `SUNSET_UNKNOWN` TIME TBD branch are deleted ("honour it or delete it").
4. `sunsetUnknownField` is the twin of `pastSunsetField`, spread on the re-home and on its
   recommendation (`daylightSunsetUnknown: { code, cause, date, occurrences }`, the Edge's names), and
   the `REPAIR_REHOMED` message names it as it names a past-sunset one.
5. Comments: the header, `PRACTICE_TBD_REASON` (both daylight reasons "no longer produced by the
   repair", kept for rows saved before), `reasonCodes.js`, and the registry note
   (`season2026Constraints.js:506`, below).

**Pricing (D11): an unknown-sunset candidate is priced exactly like a known-legal one.** The flag is
for the admin; it is not a cost. Tested: with a known venue and an unknown one offering the same
Tuesday 15:00, the two cost the same and the order is the shapes' (`dark/...` before `dusk/...`);
declining the flagged one re-offers the unflagged one.

**The Edge twin: no behaviour change** (A2, A3 already accept and flag). What is new is proof that
the two agree. No daylight drift product test existed (the three product digests under
`supabase/functions/_shared/tests/` are for coach preferences, lighting overrides and practice
exceptions; none judges a sunset). `tests/sunsetAgreement.test.js` runs both arms over the full
product of lighting (lit, unlit, undeclared) x coordinates (none, present) x end time (early, late) x
portable-lighting override (none, whole window, before DST) = 36 cases: the core arm is
`repairPracticeLoss` over one displaced series and one candidate, the Edge arm is
`applyDaylightPostPass` over a placement in the same slot. Neither may refuse a case, both must give
it the class an oracle (the rule and the solar function, written from neither arm) gives it, and an
unknown sunset must be the same flag in both: code, cause, first date, number of dates. The Deno
mirror gains a test of the Edge arm's unknown verdict in its own runtime
(`practice-daylight_test.ts`), run under both host zones by `scripts/deno-mirror-tests.sh`.

**UI parity (frontend only, small).** The past-sunset flag has a row badge
(`PracticeRepairPanel.jsx`, `practice-repair-past-sunset`) and an enact-dialog sentence
(`PracticeEnactDialog.jsx`, `practice-enact-past-sunset`), so the unknown flag has both
(`practice-repair-sunset-unknown`, `practice-enact-sunset-unknown`, wording from
`sunsetUnknownText` in `practiceRepairPanel.js`, causes from `daylightReport.js`'s table). A flag
nobody sees is a hollow guarantee. Tests: the helper's exact wording, the row in a mixed estate (one
venue with coordinates, one without) and the controls (all venues with coordinates; none, where the
repair judges no sunset at all), the dialog alone and beside the past-sunset note, and one E2E
scenario (`practice_repair_panel.feature`) in which the panel with the flag on screen is scanned with
axe (WCAG 2.0 to 2.2 A and AA, serious and critical) in both themes. `axe-core` is not a direct
dependency here, so the scan is the repo's own Playwright one (`@axe-core/playwright`), not a jsdom one.

**The registry note** (`season2026Constraints.js:506`) now describes what happens: the Edge pass and
the repair keep and flag, past sunset (2026-10-27) and unknown (2026-11-02), never refuse; an unknown
sunset is never read as legal; a flag is not a price. It also says the `HARD` type is the operator's
2026-09-27 ruling and that no path blocks on it since 2026-10-27. **The `HARD` type, the `BLOCKING`
severity of `PRACTICE_PAST_SUNSET` and every behaviour are unchanged** (B5, for the owner).

**Mock client and demo: they do not read the A1 branch.** The repair runs in the browser from the
core package, so the mock path gets the new behaviour with no change; `mockPracticeEnact.js` mirrors
the enact write, not the sunset judgment; every demo venue has coordinates
(`20261110010000:99-103`), so the demo never reaches an unknown sunset. The Edge function is stubbed
in the Playwright steps (`tests/e2e/steps/auto_scheduler.ts`), unchanged.

## 4. Tests and plants

All at the default 5 s Vitest timeout.

1. `practiceRepairDaylight.test.js`, "D4": a candidate on unlit ground with no coordinates and no
   table is placed with the flag and is not TIME TBD; the same placement as a repair that judged no
   sunset; past and unknown on one candidate carry both flags; a venue mixing a past-sunset shape with
   an unknown one keeps both candidates; a lit venue, a known-sunset venue and an unknown one in one
   run (only the unknown one is flagged, the counts come from the input); an unknown and a known venue
   offering the same slot are priced alike (D11) and a decline re-offers the unflagged one; two series
   contending for the one slot at an unknown venue (the loser is TIME TBD `contended`, not for
   daylight); no calendar, no flag.
2. The corpus as it ships (`season-2026: every corpus loss, gated`): the pinned refusal is rewritten
   from the plan and the graph. For each of the 29 surfaces: none dropped, every placement and TIME
   TBD reason equals the repair's with no calendar, none TIME TBD for daylight, each placement's flags
   derived date by date from the table, and the counters partition `candidatesJudged`.
3. `practiceRepairAdapter.test.js`: "never geocodes" now expects a flag and no `sunset-unknown` row;
   the payload-enum test takes a daylight-judged plan in place of the one that needed the refusal.
4. `tests/sunsetAgreement.test.js` (above), registered as a consumer in
   `tests/unwiredLayerImporters.test.js`'s census, and the Deno mirror test. `practiceEnact.test.js`:
   a recommendation carrying the flag is enacted exactly as one without it (same rows, same closes,
   same exceptions).
5. `practiceRepairPanel.test.jsx` and the E2E scenario (above).
6. `reasonCodeReachability.test.js`: the description of the TIME TBD reasons is updated; the finding
   `PRACTICE_REPAIR_CANDIDATES_SUNSET_UNKNOWN` is still emitted, so the audit stays green (it goes red
   when the emission is removed: plant P2).

**Plants** (three, each red then reverted, _executed_): P1 the gate refuses an unknown candidate again
(14 tests red across the daylight, adapter, panel and agreement files); P2 `judgeDaylight` returns no
unknown flag (14 red, including the reachability audit); P3 the Edge pass drops an unknown-sunset
placement (8 red, including the agreement test's "neither arm refuses").

## 5. What the change does to the season-2026 corpus (approved 2026-11-02)

The fixture's data files do not change; what the repair makes of them does. This is the corpus swept
as `practiceRepairDaylight.test.js` sweeps it "as it ships" (the shipped weekend-only sunset table, no
venue has coordinates, so a weekday date on unlit ground has no sunset): a retirement from 2026-09-28
on each of the 29 surfaces the baseline stands on (_executed_, before on `93987ac`, after on this
branch).

| Result of the 29 repairs                         | Before (refused) | After (flagged)  |
| ------------------------------------------------ | ---------------- | ---------------- |
| Series re-homed (tier 1)                         | 0                | 36               |
| Series TIME TBD                                  | 187              | 151              |
| of those, `sunset-unknown`                       | 97               | 0                |
| of those, `no-legal-slot-at-venue` / `contended` | 90 / 0           | 90 / 61          |
| Recommendations placed (tier 1 and tier 2)       | 0 of 187         | 102 of 187       |
| Candidates refused for an unknown sunset         | 992              | 0 (flagged: 992) |

With no coordinates anywhere, the old repair placed nothing on this corpus; that is what "refusal
would break configs that users may otherwise stick with" describes. Nothing else in
`fixtures/season-2026` moves: the 60 test files that load the fixtures or run the repair all pass, and
the only assertions rewritten are the ones that pinned the refusal or the stale registry note: four
in `practiceRepairDaylight.test.js` (the three D4 refusals and the corpus "as it ships"), one there
for the registry note, and two in `practiceRepairAdapter.test.js`. The two reachability audits stay
green with the finding still emitted; only a description string in that file was updated.

## 6. For the owner

- **B4** `durationPhases.js:654, 730` holds a known past-sunset date out as TIME TBD when neither a
  shorter practice nor an earlier start saves it. Unwired (no production consumer), so nothing in the
  app does this today. Recommendation: apply the principle there (keep the date, flag it) when it is
  wired.
- **B5** the `practice-daylight` constraint is `HARD` and non-waivable and `PRACTICE_PAST_SUNSET` is
  `BLOCKING`, though no path has blocked on it since 2026-10-27. The registry note now says so; the
  labels are unchanged. Recommendation: relabel to a compromise (soft) in a small PR of its own. `HARD`
  is the operator's 2026-09-27 wording, so the owner should say.
- **B6** games: `SUNSET_MARGIN_VIOLATED` is `BLOCKING` in the feasibility answer and the rule engine on
  the 15-minute margin the league's own sheet states; the live game scheduler does not enforce it
  (D7). Recommendation: decide games separately; the practice principle does not obviously carry over.
- A known inconsistency left alone: the core evaluator spells a polar-latitude cause
  `sunset-not-computable` and the Edge pass `sunset-undefined`. The panel text maps both; the
  agreement test compares the coordinates-missing cause, the only one this product reaches.

## 7. Records

Lesson 84 supersedes lesson 47 (47 is left as written); a dated note under D4 in
`docs/PHASE_8_9_PLAN.md` (and a "superseded" tag on its repair row); a "superseded 2026-11-02" tag on
the "unknown sunset is still refused" line in `docs/changes/2026-10-27-phase-d-scheduling.md`; the
repair and daylight lines in `docs/architecture/practice-scheduling.md`; and section 5 of
`docs/changes/2026-11-01-followups-f1.md` marked decided.
