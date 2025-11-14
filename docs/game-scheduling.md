# Game Scheduling Plan

## Objectives & Scope
- Generate a full-season slate of Saturday games for each division while respecting field, time, and coach availability constraints.
- Support odd team counts via byes or double-headers and surface conflicts for manual resolution when automation cannot satisfy constraints.
- Produce schedule artifacts consumable by downstream evaluation and export tooling.

## Inputs & Prerequisites
1. **Teams & Divisions**: Finalized rosters from the team generation workflow with division metadata and coach assignments.
2. **Game Slots Catalog**: Structured records from `game_slots` including field, date, time, duration, and optional division restrictions.
3. **Coach & Buddy Context**: Coach multi-team flags and any player/coach conflicts already captured in Supabase to prevent overlaps.
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
- Record unscheduled matchups and the reason code (`no-slot`, `coach-conflict`, `field-mismatch`) in a `scheduling_exceptions` table for administrative follow-up.
- Emit per-week and per-team summaries for the Evaluation agent to analyze fairness metrics.

## Administrative Workflow
1. **Preview & Adjustments**: Front end surfaces a calendar/table view for each Saturday with conflict indicators. Admin can drag-and-drop fixtures to alternative slots, which triggers an update to Supabase via serverless functions.
2. **Byes & Double-Headers**: UI clearly labels teams on bye weeks and allows optional double-header approvals before committing them.
3. **Locking Mechanism**: After league approval, mark specific games as locked to prevent automated reshuffling during later reruns unless explicitly unlocked.

## Testing Strategy
- **Unit Tests**: Cover round-robin generation for even/odd team counts, slot compatibility checks, and conflict detection utilities.
- **Integration Tests**: Simulate full division scheduling using seeded data (including multi-team coaches) and assert that assignments avoid overlaps and respect slot capacities.
- **Regression Safeguards**: When bugs are discovered, capture the fixture set in JSON fixtures and add targeted tests ensuring the scheduler resolves them correctly.

## Metrics & Evaluation Hooks
- Capture per-division fairness metrics such as distribution of early/mid/late slots and frequency of back-to-back games.
- Feed metrics into the evaluator loop so repeated conflicts can trigger alternative assignment heuristics.
- Log scheduling duration and iteration counts to identify performance bottlenecks as divisions scale.

## Future Enhancements
- Introduce optional constraint-solver integration (e.g., linear programming) for divisions with tight slot availability.
- Support cross-division tournaments by allowing ad-hoc slot pools outside the standard Saturday cadence.
- Explore automatic rescheduling workflows that react to weather cancellations by shifting impacted games forward in the calendar.
