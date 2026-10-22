# Phase D: home/away balance (research item 4)

Status: **draft for owner approval** (AGENTS.md rule 14: the solver's round robin). Research item 4
(`2026-10-20-research-defects.md` section 4), roadmap Phase D. No migration, schema or Edge
Function change; three PRs. Code read at `origin/main` 6a22d29.

## Today (verified)

- **Orientation.** `generateRoundRobinWeeks` sorts each pair (`gameScheduling.js:58-59`), so the
  smaller id is home in every meeting, then sorts the week's matchups by home id (`:62-67`). In a
  single round robin the smallest id hosts all n-1 games: home-count spread is n-1 for every n
  (_executed_, table below).
- **One meeting per pair.** The generator takes only `teamIds` (`:16`); no double round robin exists
  (`buildRoundRobinByDivision`, `GameSchedulingPage.jsx:369-385`, calls it once per division).
- **Byes.** Odd n appends `__BYE__` (`:33-35`); index 0 (smallest id) is fixed, the rest rotate
  one index per week (`:77-80`), the bye with them.
- **Home means nothing to placement.** No column or core field names a home venue or field (grep
  for home_field, home_venue, homeLocation: none). Slot choice is symmetric in the sides
  (`:495-690`: both teams' consistency, both coach lists); flipping sides moves no game (_executed_).
- **No warning.** `evaluateGameSchedule` (`gameMetrics.js:89`) counts `homeGames`/`awayGames` per
  team (`:452-464`) and warns on nothing about them. The rule engine's `homeAwayBalanceRule`
  (`ruleEngine/rules.js:1376-1540`) judges the season-2026 corpus against its policy (4 or 5 of
  9), but nothing in the app calls the rule engine on a generated schedule, and the season fixture
  never calls the generator (_statically reviewed_: no `generateRoundRobinWeeks` under `fixtures/`).
- **The page regenerates everything.** `handleAutoGenerate` (`GameSchedulingPage.jsx:804-822`)
  calls `buildRoundRobinByDivision(schedulerTeams)`, which regenerates every division (`:381`);
  saved games (`game.assignments`, mapped into `localAssignments` at `:691-703`) are not consulted.
- **Persistence.** Each save is a new `scheduler_runs` row (no id in `runMetadata`,
  `:927-950`). `persist_game_schedule` (`20261018070000_audit_in_save_transaction.sql:708`) upserts
  on the **ordered** key `(home_team_id, away_team_id, game_slot_id, week_index)` (`:1223`; index
  `20260503030000_repair_game_persistence_rpc.sql:120-125`) and deletes nothing. The page reads
  one run (`useGameAssignments.js:29-31`, `.eq('run_id', runId)`). So a flipped pair saves as a new
  row and the old one is orphaned in the previous run: the operator sees the flip.
- **Elsewhere.** Scores, standings and the calendar feed read `public.games` (`teamFeed.ts:154`,
  `ScoresPage.jsx:56`), which nothing writes from `game_assignments`. `auto-scheduler` is
  practice-only; Edge `scoring-engine.ts` tags roles (`:691`), checks no balance.

## Change

1. **Orientation by rotation index ("index parity").** Keep today's rotation and pairings. In each
   week, for the pair at rotation indices i and N-1-i (N = teams, plus one for a bye):
   - i >= 1: the team at the **odd** index hosts (so the top team hosts when i is odd);
   - i = 0 (the fixed team), even n: the fixed team hosts in even weeks (0-based);
   - i = 0, odd n: the fixed team hosts unless its opponent's bye falls at an odd index, in which
     case the opponent hosts. The generator finds each team's bye index in a first pass.
2. **Placement order unchanged.** Matchups within a week stay sorted by the alphabetised pair (the
   order `:62-67` gives today), not by the new home id, so `scheduleGames` sees them in the same
   order and places every pair in the same week and slot.
3. **Saved games keep their sides.** `generateRoundRobinWeeks({ teamIds, keepSides })`: each
   `keepSides` entry `{ homeTeamId, awayTeamId }` fixes that pair's sides; the rule orients the
   rest. Malformed entries, a team not in `teamIds`, or two entries for one pair throw TypeError.
   (Not named `freeze`: `scheduleGames` refuses that word on purpose, `gameScheduling.js:101`, `:125`.)
4. **Warning.** `evaluateGameSchedule` emits `home-away-imbalance` for each rostered team whose
   placed games give |home - away| > 1, i.e. hosting outside floor(g/2)..ceil(g/2) of g games, the
   season constraint's 4-5 of 9. Details: teamId, division, homeGames, awayGames, totalGames and the
   team's unscheduled matchups (a dropped game can make a balanced orientation read 2 apart).
   Severity `warning` in `GameConflictBanner.jsx:9`, label "Home/Away" at `:29`.

## The proof

Each non-fixed element (team or bye) visits every index 1..N-1 once in N-1 weeks (`:77-80`). An
index p in 1..N-2 hosts iff p is odd (N-1 is odd, so the partner of odd i is even). Even n: a team
hosts (N-2)/2 times at those indices plus once more if it meets the fixed team in an odd week, so
every count is N/2-1 or N/2: spread <= 1. Odd n: a team hosts (N-2)/2, loses one if its bye falls
at an odd index, and gains one from the fixed team exactly then: every team (n-1)/2, the fixed team
too by the total n(n-1)/2.

_Executed_ (throwaway simulations, not committed; D3's tests reproduce them. The copied rotation
matches the repo generator's pairs in every week, n=2..16, and the index-parity rows were re-run
independently in review). Home-count spread (max-min); "run" = longest same-side streak:

| n                          | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | 10  | 11  | 12  | 13  | 14  | 15  | 16  |
| -------------------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| today (min id home)        | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | 10  | 11  | 12  | 13  | 14  | 15  |
| loose "alternate by round" | 1   | 0   | 2   | 2   | 2   | 3   | 2   | 3   | 2   | 3   | 2   | 3   | 2   | 3   | 2   |
| circulant on sorted index  | 1   | 0   | 1   | 0   | 1   | 0   | 1   | 0   | 1   | 0   | 1   | 0   | 1   | 0   | 1   |
| circulant, longest run     | 1   | 1   | 2   | 2   | 2   | 3   | 3   | 4   | 4   | 5   | 5   | 6   | 6   | 7   | 7   |
| **index parity (chosen)**  | 1   | 0   | 1   | 0   | 1   | 0   | 1   | 0   | 1   | 0   | 1   | 0   | 1   | 0   | 1   |
| index parity, longest run  | 1   | 1   | 2   | 2   | 2   | 2   | 2   | 2   | 2   | 2   | 2   | 2   | 2   | 2   | 2   |

Index parity: every odd n is exactly (n-1)/2; 200 random-UUID trials per n: worst spread 1, no
odd miss, longest run 2. The loose rule reproduces the review's 2-3; circulant balances but leaves
runs of 7; greedy "fewer homes first" fails odd n (spread 2 at n=5, 9, 13). A mirrored double
round robin (unsupported today) gives spread 0, runs 3-4 (_executed_).

Placement (_executed_, throwaway simulation, n=2..16, shared and division slots, priorities, coaches
shared within the division): with the alphabetised order kept, 0 of 15 runs place any pair in a
different week or slot (344 placed games change sides); re-sorted by the new home id, 10 of 15
differ. On the season-2026 games extract (542 games, 131 teams), |home - away| > 1 flags 0 teams
(hosting is 4 or 5 of 9), so the warning is silent on ground truth.

## Tests (file, assertion, and whether it fails today)

- `tests/gameMetrics.test.js` (D1): hand-built assignments where A hosts B, C and D: exactly one
  `home-away-imbalance`, for A, with homeGames 3, awayGames 0; a 2-1 team and a team with no games
  raise none; an unknown side raises none. _Fails today_ (no such type).
- `tests/gameMetrics.test.js` (D1): the season-2026 games extract gives 131 load rows and 0
  imbalance warnings; made home in all nine of its games, one planted team is flagged.
- `tests/countUnits.test.js:258-272` (D1): the warning-type list gains `home-away-imbalance`, the
  fixture is made to raise it, and `GAME_METRICS_COUNT_UNITS` (`gameMetrics.js:56`) gains the new
  details paths, so the "no unmatched pattern" check (`:274`) covers them.
- `tests/scoringEngineDrift.test.js` (D1): "declared, not compared: home-away-imbalance is
  core-only" beside `:790`; `tests/GameConflictBanner.test.jsx`: label at warning severity.
- `tests/gameScheduling.test.js` (D2): `keepSides: [{ homeTeamId: 'team-2', awayTeamId: 'team-1' }]`
  makes team-2 host that pair; bad entries throw. _Fails today_: the argument is ignored.
- `tests/gameSchedulingKeepSides.test.jsx` (D2, new, on `gameApplyTimeoutReread.test.jsx`'s
  pattern): a saved run holding team-2 at home to team-1; Generate stages "team-2 vs team-1".
  _Fails today_ (it stages team-1 at home).
- `tests/gameScheduling.test.js` (D3): for n=2..16, with ordered ids and a shuffled UUID set, home
  counts initialised from `teamIds`: every team plays n-1; even n spread <= 1; odd n every team
  (n-1)/2; longest run <= 2. _Fails today_ (spread n-1). Shown failing against the loose rule.
- `tests/gameScheduling.test.js` (D3): for n=2..16, `scheduleGames` places the new round robin
  and the same weeks re-oriented smallest-id-home in identical (week, slot, field, pair) sets.
  Shown failing with matchups re-sorted by home id.
- `tests/gameScheduling.test.js` (D3): keepSides beats the rule for its pair only; a generated
  4-team schedule raises no imbalance through `evaluateGameSchedule` (today's does).

**Existing tests that pin today's orientation: none fail** (_executed_: the rule planted in a
scratch copy, full unit suite 6110 passed; 2 failures read `.git`, which the copy lacks, and pass
on the checkout; `gridOverridePrompt.test.jsx`, which never generates games, failed once under
load and passes alone). The one pin is e2e: "the game {string} vs
{string} is staged for review" (`tests/e2e/steps/scheduling_and_overrides.ts:569-577`, used by
`Pillar1_Engine.feature:69-75`) asserts "Team A vs Team B" in a 2-team division; n=2 keeps the
smaller id at home under the new rule, so it stands (_statically reviewed_; e2e not run). The
uniqueness keys in `gameScheduling.test.js:63-101` stay valid (one meeting per pair).

## Freeze design

- The page builds `keepSides` per division from `game.assignments`, the latest saved run: every
  saved row whose two teams are both in that division's `teamIds`. Staged, discarded or unsaved
  review rows are not frozen. Rows for a pair that disagree (only reachable through manual edits)
  freeze the earliest-week row's sides; a test covers it.
- A frozen pair keeps its sides even when the rule would flip it; it is not rebalanced. A division
  saved under today's rule therefore stays unbalanced after D3, and the new warning says so on the
  next generate. Repairing it is a deliberate re-orientation (owner decision 1), never a side effect.
- Placement order is unchanged (Change 2), so regenerating a schedule saved straight from a
  generate, with nothing else changed, yields its rows exactly: the save updates, orphans nothing.

## Risks

- **New teams re-orient unsaved pairs** (the rule reads sorted ids). Saved ones are frozen; a mixed
  division can end unbalanced, and warns.
- **D1 warns before the fix** for every n >= 3: the defect made visible. No e2e counts warnings.
- **Orphaned rows** (found, not introduced): a regenerate that moves a pair's slot already leaves
  the old row in the old run (the RPC never deletes). Out of scope. Production runs: not read.

## Unchanged behavior

Pairings and byes per week (_executed_); each pair's week, slot and field; unscheduled reasons; n=2
sides; the rule engine and season fixture; Edge Functions; schema, RPC, RLS; `public.games`. Only
the order of `unscheduled` (`:217`) and of games sharing a slot (`:197`) can change (home id ties).

## PR split

- **D1, the warning** (metrics, banner, count units, drift declaration). Independent.
- **D2, keepSides** (option, page wiring). No-op unless a saved side differs. Before D3.
- **D3, the rule** (index parity, order kept, proof and placement tests, the "alphabetised pair"
  comment at `gameScheduling.js:114`, a LESSONS_LEARNED entry). Runs the season fixture suite.

## Owner decisions (none blocking)

1. **Rebalance saved schedules?** Recommend no: saved sides are frozen; a named "rebalance home and
   away" action can be planned later if asked for, as a deliberate global re-orientation.
2. **Threshold and severity.** Recommend |home - away| > 1, advisory (`warning`), matching the
   season constraint's 4-5 of 9.
3. **Double round robins.** Unsupported; recommend a mirrored second leg when added (spread 0).

## Investigation notes

- Simulations (_executed_): throwaway scripts importing the checkout read-only; the planted suite
  ran in a scratch copy of the repository (`node_modules` linked). Neither is committed.
- The loose rule fails because a team keeps one side while on one half of the circle. Rejected:
  moving the bye to index 0 (exact, but it changes which week each pair meets) and a greedy balancer.
