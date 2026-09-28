[← Back to Documentation Index](docs/README.md)
---

> [!NOTE]
> **Implementation Status: COMPLETE**
>
> Practice scheduling is implemented in `packages/core/src/practiceScheduling.js` and `packages/core/src/practiceMetrics.js`. The UI includes lock/unlock toggles in `PracticeSchedulingPage.jsx` and manual overrides via `PracticeOverridePanel.jsx`. Key difference from original design: `javascript-lp-solver` and `OR-Tools` were **not used** — the algorithm uses a deterministic greedy slot allocation with conflict avoidance, which proved sufficient for the scale of youth sports leagues (~20-40 teams, 3-5 fields).

# Practice Scheduling Design

This document elaborates the roadmap's practice scheduling phase into concrete implementation guidance. It assumes the data schema defined in `docs/architecture/data-modeling.md` and that teams have already been generated as described in `docs/architecture/team-generation.md`.

## Objectives

- Assign exactly one weekly practice slot to every active team.
- Respect field capacities, daylight windows, and mutual exclusivity of fields/subfields.
- Avoid coach conflicts, especially for coaches handling multiple teams.
- Surface unmet constraints early so admins can make manual adjustments.

## Inputs

- **Teams**: Records from the `teams` table joined with `divisions`.
- **Practice Slots**: Rows from `practice_slots` joined to `field_subunits` and `fields`, filtered by the current effective date range.
- **Coach Availability**: `coaches.can_coach_multiple_teams`, and the approved rows of `coach_practice_preferences` (weekday, start time and venue, each `must_keep` / `prefer_keep` / `dont_care`) for the coaches `team_coach_assignments` holds current. The auto-scheduler Edge Function loads these itself, as the caller through RLS, and never from the request body (8.6 PR 3b PR 8). The old `coaches.preferred_practice_days` / `preferred_practice_window` columns were never read and were dropped in `20261001000000`.
- **Season Configuration**: Values from `season_settings` describing early/late season durations, fallback days, and scoring weights for preference satisfaction.
- **Manual Overrides**: Optional locks stored in `practice_assignments` with `source = 'manual'` that should not be reassigned automatically.

## Scheduling Workflow

1. **Preprocessing**
   - Expand each `practice_slot` into one or more "effective slots" if daylight transitions split the season. For example, a slot valid until a `late_season_start` date will generate two entries: one for the early weeks and one for the late weeks with adjusted durations.
   - Build a priority queue of teams ordered by conflict risk: multi-team coaches first, then teams with highly constrained coach availability, then the remainder.
   - Determine slot capacities per week by counting capacity across all effective slots within the same field/time combination.
2. **Assignment Loop**
   - Pop the highest-priority team.
   - Score all available slots using a weighted sum:
     - **Coach availability match** (highest weight).
     - **Division preference match** (some divisions might prefer earlier times).
     - **Field fairness** (penalize assigning too many teams from the same division to the same field).
     - The `schedulePractices` helper now accepts a `scoringWeights` object so these multipliers can be tuned per season via `season_settings`
       (e.g., dialing back fairness penalties during rebuilding years or boosting division preferences for limited-field divisions).
   - Select the highest-scoring slot that still has capacity and no coach conflict. If multiple slots tie, choose the earliest start time.
   - Record the assignment in a staging structure and decrement the slot capacity.
   - If no slot meets hard constraints, flag the team as `needs_manual_assignment` with candidate slots ranked by score.
3. **Conflict Resolution**
   - After the initial pass, scan for:
     - Coaches scheduled with overlapping slots across their teams.
     - Fields exceeding capacity (should not happen but double-check).
   - Attempt local swaps between conflicting teams using a best-effort search: try exchanging slots with teams that have similar scores but no conflicts. Limit swap attempts to prevent infinite loops.
4. **Finalization**
   - Persist assignments into `practice_assignments` with `source = 'auto'`.
     Store the slot window as a `daterange` in `effective_date_range`.
   - The `practice_assignments` table is the authoritative source for assignments. `teams.practice_slot_id` should be considered for deprecation or used as a non-authoritative pointer to avoid inconsistency with mid-season slot changes.
   - Store a `scheduler_runs` entry with `run_type = 'practice'` capturing parameters used, conflicts encountered, and manual follow-ups required.

## Daylight (8.9 PR 6)

The live practice scheduler is the `auto-scheduler` Edge Function. After its
search it runs a daylight post-pass (`supabase/functions/_shared/engines/practice-daylight.ts`),
the Edge counterpart of core `practice/daylight.js`:

- **Rule.** An unlit practice occurrence ends at or before `floor(sunset)` less
  `PRACTICE_SUNSET_MARGIN_MINUTES` (0; a Deno twin pinned equal to core's by
  `tests/autoSchedulerDaylight.test.js`). Sunset is the Edge solar twin
  (`_shared/timing/solar.ts`), judged per date on the season's wall clock.
  Lit venues are exempt; undeclared lighting is unlit.
- **Venue and slot data come from the database.** Each run slot's `field_id`,
  `end_time`, `valid_from`/`day_of_week` and `valid_until` are read from
  `practice_slots`, and `lighting_available` and the location's coordinates by
  that field (fields -> locations), as the caller through RLS, paged. A venue,
  end time, coordinates or lighting on the request body are never read; the
  body's first date and `effectiveUntil` are used only where `valid_from` or
  `valid_until` is null (the page's season-start and season-end fallbacks). A failed read, or a run slot or field
  the read does not return, refuses the run with `VENUE_DAYLIGHT_UNREADABLE`
  (the coach-preference loader's contract).
- **New placements only.** Each is expanded weekly from the season's today (where
  the page starts a new placement) to the slot's `effectiveUntil`. At the first
  date past the limit the placement is truncated (`effectiveUntil` = the day
  before, which the page honours in `newPlacementRange`), and the remainder is
  TIME TBD with reason `past-sunset` (core `PRACTICE_TBD_REASON.PAST_SUNSET`,
  pinned) and the date. If the first
  occurrence is already past the limit, the placement is withdrawn and the team
  is unplaced with that reason. Every remainder is returned in `daylight.timeTbd`,
  written as a `DAYLIGHT_TIME_TBD` run finding, and audited on
  `scheduler.auto_completed`.
- **No coordinates on unlit ground** is flagged `SUNSET_UNKNOWN`
  (`venue-coordinates-missing`), counted in `daylightUnknownOccurrences`, shown on
  the page, and never treated as within daylight. It does not refuse the run.
- **Locked rows are never changed.** A locked row past sunset is reported in
  `daylight.lockedPastSunset` with a proposed fix (`applied: false`).
- **Declared, not optimised (D11).** The search does not steer toward slots that
  survive the season, and a withdrawn placement's capacity is not offered to
  another team.
- **Not persisted here.** The TIME TBD remainder is reported, audited and shown.
  This pass does not write a `practice_exceptions` row for it, and
  neither the `tbd_reason` CHECK nor `practice-persistence` admits `past-sunset` yet; that is
  follow-up persistence work.
- **Autumn-shaped (D8).** Truncating at the first date past sunset suits a season
  whose sunsets get earlier. In a spring season an early dark date withdraws the
  whole placement even though later dates would be light; D8 chose this.

## Manual Adjustment Workflow

- Display assigned slots in the admin UI grouped by day/field so conflicts are visible.
- Provide controls to reassign a team to another available slot, automatically updating capacities and logging the change as `source = 'manual'`.
- When a manual adjustment resolves a previously flagged conflict, mark the item as resolved in the related `scheduler_runs` record.
- The current allocator in `src/practiceScheduling.js` now honours an optional `lockedAssignments` array so pre-assigned teams are preserved when the scheduler runs, matching the roadmap recommendation to support manual overrides.

## Quality & Monitoring

- **Unit Tests**: Cover slot scoring, capacity decrementing, conflict detection, and swap attempts using fixture data.
- **Metrics**: Emit counts of teams assigned on first pass vs. manual follow-up, distribution of start times per division, and slot utilization percentages. The `evaluatePracticeSchedule` helper in `src/practiceMetrics.js` now implements these summaries and flags data quality issues so the admin UI can surface early warnings.
- **Alerts**: If more than 5% of teams require manual assignment, raise an admin warning suggesting more slot capacity.
- **Audit Trail**: Persist a JSON diff of assignments compared to the prior run for transparency.
- **Daylight (8.9)**: an unlit or undeclared practice ends at or before `floor(sunset)` (margin 0). Core evaluation enforces it through `practice/daylight.js`. The mid-season repair (`practice/repair.js`, 8.9 PR 7) refuses every re-home candidate, tier 1 and tier 2, that runs past sunset on any date of its series-window (`past-sunset`), or whose sunset is unknown (`sunset-unknown`, never allowed). When no legal candidate is left, the series is TIME TBD with that reason. A partly legal candidate is refused, not truncated: D8's truncation belongs to the Edge post-pass. The gate is enforced in the module but is **not live** until 8.6 3b PRs 9-11 wire the repair.

## Future Enhancements

- Integrate a constraint solver (e.g., `javascript-lp-solver` or OR-Tools via a serverless function) for more complex fairness objectives.
- Allow partial-season rescheduling by limiting effective date ranges to specific weeks when fields become unavailable.
- Sync slot availability with external calendaring tools or municipal feeds when available.
