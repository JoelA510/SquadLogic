# Practice Scheduling Design

This document elaborates the roadmap's practice scheduling phase into concrete implementation guidance. It assumes the data schema defined in `docs/data-modeling.md` and that teams have already been generated as described in `docs/team-generation.md`.

## Objectives
- Assign exactly one weekly practice slot to every active team.
- Respect field capacities, daylight windows, and mutual exclusivity of fields/subfields.
- Avoid coach conflicts, especially for coaches handling multiple teams.
- Surface unmet constraints early so admins can make manual adjustments.

## Inputs
- **Teams**: Records from the `teams` table joined with `divisions`.
- **Practice Slots**: Rows from `practice_slots` joined to `field_subunits` and `fields`, filtered by the current effective date range.
- **Coach Availability**: Time preferences from the `coaches` table (`preferred_practice_days`, `preferred_practice_window`, `can_coach_multiple_teams`).
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
   - Select the highest-scoring slot that still has capacity and no coach conflict. If multiple slots tie, choose the earliest start time.
   - Record the assignment in a staging structure and decrement the slot capacity.
   - If no slot meets hard constraints, flag the team as `needs_manual_assignment` with candidate slots ranked by score.
3. **Conflict Resolution**
   - After the initial pass, scan for:
     - Coaches scheduled with overlapping slots across their teams.
     - Fields exceeding capacity (should not happen but double-check).
   - Attempt local swaps between conflicting teams using a best-effort search: try exchanging slots with teams that have similar scores but no conflicts. Limit swap attempts to prevent infinite loops.
4. **Finalization**
   - Persist assignments into `practice_assignments` with `source = 'auto'` and `effective_date_range` derived from the slot.
   - The `practice_assignments` table is the authoritative source for assignments. `teams.practice_slot_id` should be considered for deprecation or used as a non-authoritative pointer to avoid inconsistency with mid-season slot changes.
   - Store a `practice_scheduler_runs` entry capturing parameters used, conflicts encountered, and manual follow-ups required.

## Manual Adjustment Workflow
- Display assigned slots in the admin UI grouped by day/field so conflicts are visible.
- Provide controls to reassign a team to another available slot, automatically updating capacities and logging the change as `source = 'manual'`.
- When a manual adjustment resolves a previously flagged conflict, mark the item as resolved in `practice_scheduler_runs`.

## Quality & Monitoring
- **Unit Tests**: Cover slot scoring, capacity decrementing, conflict detection, and swap attempts using fixture data.
- **Metrics**: Emit counts of teams assigned on first pass vs. manual follow-up, distribution of start times per division, and slot utilization percentages.
- **Alerts**: If more than 5% of teams require manual assignment, raise an admin warning suggesting more slot capacity.
- **Audit Trail**: Persist a JSON diff of assignments compared to the prior run for transparency.

## Future Enhancements
- Integrate a constraint solver (e.g., `javascript-lp-solver` or OR-Tools via a serverless function) for more complex fairness objectives.
- Allow partial-season rescheduling by limiting effective date ranges to specific weeks when fields become unavailable.
- Sync slot availability with external calendaring tools or municipal feeds when available.
