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

- Persist assignments in the `games` table with references to `game_slot_id`, week index, and conflict flags.
- Record unscheduled matchups and the reason code (`no-slot`, `coach-conflict`, `no-compatible-field`) in a `scheduling_exceptions` table for administrative follow-up.
- Emit per-week and per-team summaries for the Evaluation agent to analyze fairness metrics.

## Administrative Workflow

1. **Preview & Adjustments**: Front end surfaces a calendar/table view for each Saturday with conflict indicators. Admin can drag-and-drop fixtures to alternative slots, which triggers an update to Supabase via serverless functions.
2. **Byes & Double-Headers**: UI clearly labels teams on bye weeks and allows optional double-header approvals before committing them.
3. **Locking Mechanism**: After league approval, mark specific games as locked to prevent automated reshuffling during later reruns unless explicitly unlocked. *(Built as **Published**, 2026-11-06, database side: a per-game flag on `game_assignments` that a trigger on every writer holds in place for a signed-in caller (a Published game cannot be moved, re-fielded, re-timed, re-teamed or deleted, and a team or slot delete that would cascade onto one is refused); `persist_game_schedule` refuses a save that leaves a Published game out (`game_published_omitted`, 409 `GAME_PUBLISHED` from the Edge function), and the save and the switch take one advisory lock per organization first so a publish cannot slip past a save that omits the game; turning it off is the audited "Allow changes" act (`admin_set_games_published`: any organization admin, a reason from `field-change`, `coach-request`, `conflict-fix`, `published-in-error`, `other`, an optional note of at most 200 characters, up to 2,400 games a call; `game.published_set` per call, `game.publish_overridden` per game; read with `get_schedule_audit_log`); turning it on needs nothing. The save keys games by the matchup tuple (home, away, slot, week) and writes no id, so a game moved to another slot or week is a new row and the Published original counts as omitted. **Regeneration** (PR 2, 2026-11-06): the Games page passes the saved Published games to `scheduleGames` as `pinned` and the generator hands them back unchanged as `carried`; each takes its slot's capacity, stands in for one matchup of its pair (its own week first, else the pair's earliest left), and keeps its teams and coaches busy at its time, so nothing new lands on it or clashes with it; games that are not Published are re-solved as before, and a matchup that no longer fits stays TIME TBD with a reason. A carried game keeps its row and its id only because it comes back with the same tuple; nothing in the generator can move one. **The Games page** (PR 3, 2026-11-06): each saved game's card and list row carry a Published switch with its state in words ("Published", "Changes allowed", "Not published"; a staged game that is not saved yet says "Apply the schedule first"), a Published game has no grip and no "Move to" and a drop or a "Move to" that reaches the page is refused with a sentence, and a bulk bar publishes or allows changes for all games, one division, one date or one venue, resolved from the saved set (never the filtered list), with the count shown before the call and a call of at most 2,400 games. "Allow changes" opens a dialog (a reason from the closed list, an optional note with the helper text "Optional. Do not enter player names or other personal information." and a counter of 200, and one tick) and nothing else turns the flag off. The note is a soft control: an audit row has no per-row delete path and is pruned only by `prune_old_audit_logs` (180 days by default, set per organization), so a note persists up to that window. The Exports panel's upload gains "Mark these games Published" (on by default; the call carries exactly the ids in the files). **Identity, as the screen says it:** a game moved to another slot or week is a new record that starts not Published and has no history, the Published original's history stays with the old record, and the games must be published again; a move in place (the same home, away, slot and week) keeps its row. Nothing keeps a game's Published state across a move (an identity layer is a separate, pending decision).)*

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
