# Requirements Analysis & Planning

## Stakeholder Interviews and Scope Definition
- **Primary contact**: League administrator (single scheduler for ~1500 participants).
- **Divisions**: Confirm list of age groups/divisions participating this season and whether any are co-ed.
- **Roster sizing**: Capture per-division roster formulas (e.g., 7v7 → max 12 players) and any overrides for smaller/larger groups.
- **Buddy policy**: Only mutual buddy requests honored; clarify how to surface one-sided requests for review.
- **Practice cadence**: One practice per team each week, held Monday–Thursday evenings.
- **Game cadence**: Saturday games across the season (August–October season window).
- **Coach preferences**: Document availability constraints and whether coaches manage multiple teams.
- **Season adjustments**: Note when practice durations shorten (e.g., daylight change) and any blackout dates.

## Documented Constraints
### Hard Constraints
1. One practice per team per week within available Monday–Thursday slots.
2. Games scheduled on Saturdays only, avoiding field and coach conflicts.
3. Respect field capacities, sub-field splits, and daylight-driven slot durations.
4. Mutual buddy pairs must be placed on the same team; one buddy per player maximum.
5. Honor confirmed coach assignments with their associated players.

### Soft Preferences
1. Balanced team sizes and skill distributions across each division.
2. Even distribution of practice times (early vs. late) per division.
3. Prioritize coach availability preferences when assigning practice slots.
4. Maintain consistent Saturday game times for each team when feasible.

## Success Criteria
- **Scheduling validity**: No overlapping assignments for fields or coaches; all teams receive required practices and games.
- **Fairness metrics**: Track distribution of time slots and field usage to ensure equity.
- **Data outputs**: Ability to generate a master schedule spreadsheet plus per-team exports for TeamSnap import.
- **Operational efficiency**: Season schedule generation should be largely automated with minimal manual fixes.
- **Adjustment workflow**: Capability to rerun or tweak schedules when weather or field availability changes.

## Iteration Plan
1. **Phase 0 – Data readiness**: Import sample registration and field availability data; validate buddy pair identification.
2. **Phase 1 – Team formation**: Implement automated team generation, then expose manual adjustment tools.
3. **Phase 2 – Practice scheduling**: Develop assignment engine respecting constraints and evaluate fairness metrics.
4. **Phase 3 – Game scheduling**: Produce full-season Saturday game schedule with conflict checks.
5. **Phase 4 – Evaluation & exports**: Build reflection loop, reporting dashboards, and export tooling.
6. **Review cadence**: Hold bi-weekly check-ins with the administrator for feedback and acceptance testing.
