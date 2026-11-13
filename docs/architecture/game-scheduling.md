[← Back to Documentation Index](docs/README.md)
---

> [!NOTE]
> **Implementation Status: COMPLETE**
>
> Game scheduling is implemented in `packages/core/src/gameScheduling.js` (778 lines) and `packages/core/src/gameMetrics.js` (444 lines). The interactive Game Schedule Grid with drag-and-drop is in `frontend/src/components/scheduling/`. Key difference from original design: the `scheduling_exceptions` table referenced below was not created — exception handling is managed through the manual override system (`assignment_source: 'manual'`) and the `GameConflictBanner` UI. **The locking mechanism below was never built as written** (corrected 2026-11-06): `locked` is rewritten to `manual` in the save and only draws a badge, and nothing refused a change to any game until the Published switch (migration `20261119010000`, plan `docs/changes/2026-11-03-schedule-expansion.md`).

# Game Scheduling Plan

## Objectives & Scope

- Generate a full-season slate of Saturday games for each division while respecting field, time, and coach availability constraints.
- Support odd team counts via byes or double-headers and surface conflicts for manual resolution when automation cannot satisfy constraints.
- Produce schedule artifacts consumable by downstream evaluation and export tooling.

## Inputs & Prerequisites

1. **Teams & Divisions**: Finalized rosters from the team generation workflow with division metadata and coach assignments. **A practice-only division** (`divisions.plays_games = false`, D2, migration `20261029010000`) plays no games: the page reads each division's current setting with its grid data (the persisted team run carries none), matching a team by its division id when the read knows it, else by name among the season's divisions, and core `buildDivisionRoundRobins` builds such a division no round robin and returns it in `practiceOnlyDivisions`, which the page lists under **Practice only** rather than as unscheduled. A failed read stops generation; a read before the migration (42703) schedules every division, as before.
2. **Game Slots Catalog**: Structured records from `game_slots` including field, date, time, duration, and optional division restrictions.
3. **Coach & Family Conflict Context**: Coach multi-team flags plus guardian/household relationships that span multiple teams so siblings or parent-coach combinations are never scheduled in overlapping slots.
4. **Season Calendar Rules**: Season start/end dates, blackout Saturdays, and special event weekends stored in configuration tables.
5. **Round-Robin Generator**: Utility capable of emitting per-week matchups for round-robin and handling odd-team divisions.

## Scheduling Algorithm Blueprint

1. **Round-Robin Construction**
   - For each division, generate a base round-robin matrix using the Berger table method (even teams) or circle method (odd teams with byes).
   - Normalize matchups so team IDs are consistently ordered (home vs. away) for deterministic exports.
   - Store generated pairings in a transient structure with week indices.
2. **Slot Allocation Workflow**
   - For each week, pull available slots filtered by division or field size compatibility.
   - Sort slots by start time, then field priority (dedicated fields first, shared fields last).
   - Assign games greedily by iterating through matchups and selecting the earliest feasible slot that does not conflict with existing assignments for either team or their coaches.
   - Reduce slot capacity after assignment; mark over-subscribed weeks for manual intervention.
3. **Coach Conflict Avoidance**
   - Maintain a mapping of coach IDs to already scheduled game times.
   - When evaluating slots, skip those that overlap with another team coached by the same person; if unavoidable, tag the fixture with a conflict flag for later adjustment.
4. **Consistency Preferences**
   - Track each team's historical slot start time.
   - When multiple slots qualify, prefer the option closest to the team's prior-week time to maintain routine.
5. **Fallback Handling**
   - If a matchup cannot be placed, queue it into a "needs scheduling" list.
   - Provide tooling to suggest alternative Sundays/evenings or double-header opportunities by scanning remaining unassigned slots league-wide.

## Data Persistence & Output

- Persist assignments in `game_assignments` (one row per saved game, kept by its id across saves; a season's schedule is its current game run, `current_game_runs`), with references to `game_slot_id` and the week index; a game's score is a row of `game_scores`. The legacy `games` table is read by nothing since F11-3.
- Record unscheduled matchups and the reason code (`no-slot`, `coach-conflict`, `no-compatible-field`) in a `scheduling_exceptions` table for administrative follow-up.
- Emit per-week and per-team summaries for the Evaluation agent to analyze fairness metrics.

## Administrative Workflow

1. **Preview & Adjustments**: Front end surfaces a calendar/table view for each Saturday with conflict indicators. Admin can drag-and-drop fixtures to alternative slots, which triggers an update to Supabase via serverless functions.
2. **Byes & Double-Headers**: UI clearly labels teams on bye weeks and allows optional double-header approvals before committing them.
3. **Locking Mechanism**: After league approval, mark specific games as locked to prevent automated reshuffling during later reruns unless explicitly unlocked. *(Built as **Published**, 2026-11-06, database side: a per-game flag on `game_assignments` that a trigger on every writer holds in place for a signed-in caller (a Published game cannot be moved, re-fielded, re-timed, re-teamed or deleted, and a team or slot delete that would cascade onto one is refused); `persist_game_schedule` refuses a save that leaves a Published game out (`game_published_omitted`, 409 `GAME_PUBLISHED` from the Edge function), and the save and the switch take one advisory lock per organization first so a publish cannot slip past a save that omits the game; turning it off is the audited "Allow changes" act (`admin_set_games_published`: any organization admin, a reason from `field-change`, `coach-request`, `conflict-fix`, `published-in-error`, `other`, an optional note of at most 200 characters, up to 2,400 games a call; `game.published_set` per call, `game.publish_overridden` per game; read with `get_schedule_audit_log`); turning it on needs nothing. A game's identity is its row's id (see Identity, below): since 2026-11-07 a save updates a game in place when it is named by its id, so a game moved to another slot or week keeps its Published state and its history, and the omission check counts a game present if its id OR its matchup tuple is in the save. **Regeneration** (PR 2, 2026-11-06): the Games page passes the saved Published games to `scheduleGames` as `pinned` and the generator hands them back unchanged as `carried`; each takes its slot's capacity, stands in for one matchup of its pair (its own week first, else the pair's earliest left), and keeps its teams and coaches busy at its time, so nothing new lands on it or clashes with it; games that are not Published are re-solved as before, and a matchup that no longer fits stays TIME TBD with a reason. A carried game keeps its row and its id only because it comes back with the same tuple; nothing in the generator can move one. **The Games page** (PR 3, 2026-11-06): each saved game's card and list row carry a Published switch with its state in words ("Published", "Changes allowed", "Not published"; a staged game that is not saved yet says "Apply the schedule first"), a Published game has no grip and no "Move to" and a drop or a "Move to" that reaches the page is refused with a sentence, and a bulk bar publishes or allows changes for all games, one division, one date or one venue, resolved from the saved set (never the filtered list), with the count shown before the call and a call of at most 2,400 games. "Allow changes" opens a dialog (a reason from the closed list, an optional note with the helper text "Optional. Do not enter player names or other personal information." and a counter of 200, and one tick) and nothing else turns the flag off. The note is a soft control: an audit row has no per-row delete path and is pruned only by `prune_old_audit_logs` (180 days by default, set per organization), so a note persists up to that window. The Exports panel's upload gains "Mark these games Published" (on by default; the call carries exactly the ids in the files, which are first checked against the saved schedule read fresh, so files made before another tab applied a change are refused and must be generated again; off, with the reason said, for a completed season, whose export still finishes). Turning Published on from the Games page is checked the same way, a call whose answer was lost is treated as an unknown outcome and the saved flags are read again, and focus is put back after a change that removes the row it was on. **Identity, as the screen says it** (since F11-1, 2026-11-07): a game moved to another slot or week is the same game. It keeps its id, its Published state and its history (a Published game still cannot be moved until changes are allowed for it, and after that it is not Published until it is published again). The one thing left behind is a game the new schedule no longer holds (its pair does not meet again, or it could not be placed): its history stays with the old record, and the page says so after Apply.)*

## Identity (2026-11-07, F11-1)

A game is its `game_assignments.id`; `docs/changes/2026-11-06-games-table-source-of-truth.md` has the reasoning and the owner's answers. Migration `20261120010000_game_identity.sql`:

- **A save updates a game in place when an assignment names it by `id`** (`persist_game_schedule`): slot, field, teams, week, start, end, source, run and season, so a move, a flip or a regeneration keeps the id, the Published flag, `published_at` and the per-game history. An assignment without an `id` is upserted on the matchup tuple (home, away, slot, week), exactly as before, and nothing is ever deleted by a save. The ids are checked in a fixed order and a refusal writes nothing: a uuid (`game_identity_invalid`), named once (`game_identity_repeated`), a game of this organization (`game_not_found`, the same words for another organization's id), a game of this save's season when the save names one (`game_identity_season`: a game stored in another season is refused, one with no stored season is not), no clash (`game_identity_conflict`, both ids in the DETAIL, when an in-place update would end where another game is), then the triggers (`season_completed`, `game_published`). Two games that swap places in one save work: the unique index is not deferrable, so the games whose place another is taking step out of it first.
- **The page proposes the ids.** After `scheduleGames` the Games page runs `carryGameIds(saved, generated)` (`packages/core/src/gameIdentity.js`): a regenerated game takes the id of the saved game of the same unordered pair, the very same place (slot and week) first, then the same week, then the nearest week, one saved game to one regenerated game (the place comes first because the save moves a game in place: a game that took the id of a saved game elsewhere would move it onto a place another saved game holds, and the whole Apply would be refused); a Published game the generator carried is the saved game itself. A game with no counterpart (a new pair, an extra meeting) has no id and is a new row; a saved game with no counterpart stays in its old run with its history, and the page says so. The server trusts none of it.
- **One held predicate.** `game_held_ids(uuid[])` and `game_is_held(uuid)` say whether a game is held where it is: Published, or scored since `20261122010000` (a row of `game_scores`; F11-2). `game_hold_code(uuid)` gives the words of a refusal (`game_published`, or `game_scored` for a held game that is not Published) and never decides whether a game is held; the import's apply skips a held game as `skipped-published` or `skipped-scored`, and its rollback refuses once a game it wrote has a score. A scored game is carried by a regeneration like a Published one (the page's pin set asks `isHeld`, which reads the `scored` flag `useGameAssignments` sets from `game_scores`), and `admin_delete_team` takes the scores of a team's games that are not Published with it (`game_scores_deleted` in the audit row). The guard trigger (now fired for every row), `admin_cancel_game_assignment`, `admin_delete_team` and the omission check ask it; `isHeld` in core and `mockGameIdentity.js` are its twins (the test oracle `tests/helpers/gameIdentityRefusal.js` holds the mock to the save's identity checks). They are internal: no client role may execute them.
- **The season is on the game.** `game_assignments.season_settings_id` is set by the save from the run's season (NULL for a game saved before, and for a save that names none), and the save reads it back: it refuses a named game stored in another season. The Published guard, the omission check and the completed-season trigger still find a game's season through its home team's division until F11-3 moves them to the column (the two can disagree for a game whose home team was moved to a division of another season after it was saved). Together with the four-column unique index on `(id, organization_id, home_team_id, away_team_id)` it is what the score table and the Game ID of the schedule import will build on.

## Adding one game by hand (2026-11-13, PR 8)

The Games page's **Add a game** dialog (`AddGameDialog.jsx`; the rules in `frontend/src/utils/gameAddByHand.js`) takes a
division, a home and an away team (an outside club allowed) and either an **open slot** (a slot on its own field with no
game, the cells "Move to" offers) or **a new time** (a field, a date, a start and an end; its week is the date's week
from the season's start, as the import counts it). It stages one `manual` game with no id into the review; **Apply**
saves it through `persist_game_schedule` like a move, so the grid, the conflict banner and `game.saved` are unchanged.
A new time is found or made by `ensure_game_slot` first (audited `game.slot_created` only when it makes one), then the
save names it; if the save then fails, the slot stays, unused, and the error names it. No migration and no change to
either function. The rules: a slot that holds a Published or scored game is **refused** (when staged, and again on Apply
against the slot the database returns); a team already playing, or a field already in use, at that time is a
**double booking, flagged and not blocked** (owner, 2026-11-09: warnings, not blockers), shown in the dialog and the
banner and recorded in the saved run's warnings; an outside club is never double-booked; the game **starts not
Published** (the save never writes the flag). A time that overlaps a Published game in a different slot on the same
field is a double booking, flagged: only the very slot is refused. The same pair in the slot and week it already holds
is refused too (the save's unique key). Tests: `tests/gameAddByHand.test.jsx`; E2E: four
scenarios in `tests/e2e/features/published_games.feature`.

## Testing Strategy

- **Unit Tests**: Cover round-robin generation for even/odd team counts, slot compatibility checks, and conflict detection utilities.
- **Integration Tests**: Simulate full division scheduling using seeded data (including multi-team coaches) and assert that assignments avoid overlaps and respect slot capacities.
- **Regression Safeguards**: When bugs are discovered, capture the fixture set in JSON fixtures and add targeted tests ensuring the scheduler resolves them correctly.

## Metrics & Evaluation Hooks

- Capture per-division fairness metrics such as distribution of early/mid/late slots, frequency of back-to-back games, and home/away game balance.
- Feed metrics into the evaluator loop so repeated conflicts can trigger alternative assignment heuristics.
- Log scheduling duration and iteration counts to identify performance bottlenecks as divisions scale.

## Future Enhancements

- Introduce optional constraint-solver integration (e.g., linear programming) for divisions with tight slot availability.
- Support cross-division tournaments by allowing ad-hoc slot pools outside the standard Saturday cadence.
- Explore automatic rescheduling workflows that react to weather cancellations by shifting impacted games forward in the calendar.
