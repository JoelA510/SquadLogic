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
- **Division reservations** (D2, `docs/changes/2026-10-22-demo-mode.md`; migration `20261029010000`): `practice_slots.division_id`. A reserved slot is used only by its division's teams, and a division with a reserved slot among the run's slots uses only those, matched by division id (a team with none known is refused every reserved slot). The auto-scheduler Edge Function loads each run slot's reservation and each team's `teams.division_id` itself, as the caller through RLS, never from the request body, and refuses the run (503 `SLOT_RESERVATIONS_UNREADABLE`) when it cannot read them (`_shared/engines/practice-reservations.ts`); its hard constraint (`checkHardConstraints`) applies the rule to every new placement, so the seed, the search and the unplaced re-derivation agree. Core `schedulePractices` and the (not live) core optimiser apply the same rule (`reservationRefusal`); `tests/autoSchedulerReservations.test.js` holds the two equal. A locked practice is never judged, so a reservation set after a practice was saved does not move it. A team left with no open slot is unplaced with the search's own reason (core: `no practice slot is open to this division (reservations)`).
- **Coach Availability**: `coaches.can_coach_multiple_teams`, and the rules in force in `coach_practice_preferences` (a rule is for one team: weekdays, start times and venues, each any-of or keep-current, `prefer` or `must`; see "Coach practice preference rules" below) for the coaches `team_coach_assignments` holds current. The auto-scheduler Edge Function loads these itself, as the caller through RLS, and never from the request body (8.6 PR 3b PR 8). The old `coaches.preferred_practice_days` / `preferred_practice_window` columns were never read and were dropped in `20261001000000`.
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
   - A slot a division reservation refuses is never a candidate (D2); it is left out when the unplaced reason is read, so a reserved division whose slots are full reads `no available capacity`.
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
- **New placements only; past sunset is flagged, never blocked.** Each is expanded weekly
  from the season's today (where the page starts a new placement) to the slot's
  `effectiveUntil`. A placement with a date past the limit is **kept whole** (owner decision of
  2026-10-27, every league): it is returned in `daylight.pastSunset` with the first such date,
  the time it ends against the limit, and the count of dates, written as a
  `PRACTICE_PAST_SUNSET` run finding (a warning), shown on the practice page ("runs past
  sunset... kept") and audited on `scheduler.auto_completed` (`daylightPastSunset`). Nothing is
  truncated, withdrawn or made TIME TBD for being past sunset. (Before Phase D PR B the pass
  truncated at the first such date and withdrew a first occurrence past it; `PRACTICE_TBD_REASON.PAST_SUNSET`
  stays in the table for rows saved then.)
- **No coordinates on unlit ground** is flagged `SUNSET_UNKNOWN`
  (`venue-coordinates-missing`), counted in `daylightUnknownOccurrences`, shown on
  the page, and never treated as within daylight. It does not refuse the run.
- **Locked rows are never changed.** A locked row past sunset is reported in
  `daylight.lockedPastSunset` with a proposed fix (`applied: false`).
- **Declared, not optimised (D11).** The search does not steer toward slots that
  survive the season, and a withdrawn placement's capacity is not offered to
  another team.
- **Nothing to persist for it.** A flagged placement is an ordinary assignment; the flag is
  reported, audited and shown, not stored.
- **No longer autumn-shaped.** D8's truncation at the first date past sunset is gone with the
  block: a placement that is dark on some dates and light on others is kept and flagged with its
  first dark date, and the admin decides.
- **The repair agrees.** `practice/repair.js` keeps a re-home candidate past sunset and flags it
  (`daylightPastSunset` on the re-home and its recommendation, `PRACTICE_REPAIR_CANDIDATES_PAST_SUNSET`
  a compromise finding); a candidate whose sunset is **unknown** is still refused (`sunset-unknown`,
  D4: unknown says nothing about being past it, and is never read as legal).

## Practices per division (Phase D PR B)

- **The setting.** `divisions.practices_per_week` (0 to 7, default 1) and `practice_minutes`
  (15 to 240, NULL for any slot length), written by `admin_upsert_division_settings` and edited on
  the Teams page beside the division's other rules. The Edge function reads them from the store as
  the caller (`practice-division-settings.ts`), never from the body; a failed read refuses the run
  (503), it does not run at one a week.
- **Units.** The solver places *practice units*: a team needing N more places `max(N - rows held, 0)`
  units (a unit's id is the team id when it needs one, else `teamId#k`), each on a different
  weekday (a hard rule beside capacity and coaches, `checkHardConstraints`), in a slot of exactly the
  division's length when it sets one. A division at one a week runs byte-identically to before.
- **Weekdays held outside the run.** A saved practice on a slot the run does not carry still holds its
  team's weekday: its dating is read from the organization's slots (`outsideHoldsFor`), and a hold that
  cannot be dated refuses the run (422 `TEAM_HOLDS_UNREADABLE`) for a team that needs several.
- **A division at 0 practices** needs nothing: not in coverage, the run's report (`practices.noPractices`)
  or the readiness counts.
- **What is missing, and why.** Each unplaced unit carries `no-slot-available`, `coach-preference`,
  `no-live-date`, `practice-length` or `not-enough-days`; the response's `practices` block lists, per
  team that wants several, how many it holds, was given and still lacks, and the teams holding more
  rows than their count now (the rows stay; lowering a count never deletes a practice).
- **The writer's gate.** `persist_practice_schedule` refuses a save whose new `auto` rows break
  capacity, a slot reservation, the division's length, the different-weekday rule or the weekly
  count (`practice_new_auto_row_refusals`, P0001, naming each row). The count is per scheduling week (Monday to Sunday), a saved row with no date range holds its slot's whole validity, and `teams_without_practice` leaves out the teams of a 0-a-week division. Manual, repair, recommendation
  and override rows keep their existing checks. Coach overlap, preferences and daylight are the
  server's verify, not the writer.

## Coach practice preference rules (Phase D C1, `20261112010000`)

Plan: `docs/changes/2026-10-26-coach-preference-rules.md` ("Revised 2026-10-27": admins import preferences).
A coach has no sign-in, so an admin imports the league's preference file or adds a rule by hand
(`docs/architecture/gotsport-import-contract.md`, "Practice preference import"). The screens are Phase D C2.

- **A rule is one row for one team** (`coach_practice_preferences`): `weekdays text[]`, `start_minutes int[]`
  and `venue_ids uuid[]` (each optional; the values inside a condition are *any of*), or keep-current per
  dimension (`keep_weekday`, `keep_start`, `keep_venue`: keep whatever the team's live practices hold); an
  optional date window (`effective_from` / `effective_to`); `level` in force (`prefer` or `must`);
  `requested_level` and `must_decision` (`pending`, `accepted`, `kept_prefer`) for a must an import asked
  for; `coach_priority` (`high` / `medium` / `low`, shown, never judged); `source` (`import` or `admin`) and
  the import job. The database refuses an empty set, a duplicate value, a weekday outside SUN..SAT, minutes
  outside 0..1439, a venue of another organization, a rule with no condition, values together with
  keep-current, a coach who is not of the team's season, and a `must` nobody accepted (16 CHECKs and a
  tenancy trigger).
- **Only an admin writes**, through `admin_add_practice_preference`, `admin_edit_practice_preference`,
  `admin_remove_practice_preference`, `admin_decide_must_preference` and `admin_accept_all_musts(job,
  expected_count)` (which refuses when the pending count is not the one the confirmation showed); each
  audits the rule it wrote, with its before and after where it had one (`practice_preference.*`), and a completed season takes no change. An
  imported `must` is a request: in force as a prefer until an admin accepts it. The table has no write policy
  or client write grant.
- **Judged per practice.** A rule applies to a team's practice when the coach is one of the team's current
  coaches, the rule is in its window on the judged day, and for every condition: a **must** removes the
  candidates that miss any of its conditions (all-of across conditions and across rules); a **prefer** costs
  one breach per unmet rule. Keep-current means "any value the team's live practices hold": a team with
  practices on Tuesday and Thursday and a keep-weekday must can move to either, and a rule with nothing to
  keep (a team with no live practice) **does nothing and says so**
  (`COACH_PREFERENCE_NO_REFERENCE`) rather than guessing. Two rules of one level whose sets for a dimension
  share no value can never both hold: the finding `PRACTICE_COACH_PREFERENCE_CONFLICT` names them. A must
  that no slot can meet leaves the practice TIME TBD and the reason names the rule.
- **One judge, two twins, one drift test.** `packages/core/src/practice/coachPreferences.js`
  (`resolveCoachPreferences`, `judgeCoachPreferenceCandidate`) is the model;
  `supabase/functions/_shared/engines/coach-preferences.ts` is its Edge twin, and
  `supabase/functions/_shared/tests/coach-preference-product.ts` runs a 22,053-case product through
  both, held by a committed digest (`tests/coachPreferenceDrift.test.js` and the Deno test). Every reader
  goes through them: the Edge loader (`coach-preference-load.ts`, which reads the rules in force as the
  caller through RLS and the team's held practices), the solver gate, `prepare` / `verify`, the
  solver-input digest (a rule that bites changes it) and the scoring. The repair adapter and
  `previewMustKeep` (accepting a must shows which of the team's current series it would make unsatisfiable)
  compose the same two functions.
- **Tested.** `tests/coachPreferenceRules.test.js` (a `{Tue, Thu}` must at two practices a week gives
  Tuesday and Thursday; a must no slot meets is TIME TBD naming the rule),
  `supabase/tests/practice_preference_rules.sql`, `supabase/tests/practice_preference_import.sql`, and the
  harness's backfill stage (the old scalar rows are planted and the migration applied onto them).

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
