# Evaluation & Refinement Loop Plan

This document operationalizes the roadmap's evaluation loop so the scheduler can self-audit, suggest automatic fixes, and surface
clear tasks for administrators. It assumes the scheduling engines described in `docs/practice-scheduling.md` and
`docs/game-scheduling.md` feed their results into Supabase tables (`practice_assignments`, `games`).

## Objectives
- Automatically verify hard constraints immediately after team, practice, and game generation runs.
- Quantify fairness and quality metrics so admins can judge schedule balance at a glance.
- Provide a structured remediation workflow that attempts safe auto-fixes before requesting manual input.
- Preserve an auditable history of evaluations, inputs, and outcomes for regression analysis.

## Evaluation Pipeline Overview
1. **Snapshot Inputs**
   - Capture identifiers for the run being evaluated (`run_id`, `division_id`, scheduler type) plus the hash of relevant
     configuration (`season_settings`, algorithm parameters) and the data revision timestamp.
   - Store snapshots in `evaluation_runs` with JSONB fields referencing the exact roster and slot assignments examined.
2. **Constraint Verification**
   - Validate team coverage: each active team must have exactly one practice slot and the configured number of games per week.
   - Ensure field capacities are respected by checking overlapping `practice_assignments` and `games` by `field_subunit_id`
     or `field_id` within the same time range.
   - Detect coach conflicts by cross-referencing `coaches` to their teams' assignments and verifying non-overlapping windows.
   - Confirm buddy integrity by asserting that paired players share the same `team_id` in `team_players`.
   - Write failures to `evaluation_findings` with severity (`error`, `warning`) and machine-friendly `finding_code`s.
3. **Fairness Metrics**
   - Compute per-division distributions of early/mid/late time slots for practices and games.
   - Measure field utilization variance so administrators can spot overused facilities.
   - Track rest spacing between games (days between fixtures) and flag teams with back-to-back weeks of early mornings or
     late evenings.
   - Persist metric summaries in `evaluation_metrics` with thresholds defined in configuration for alerting.
4. **Auto-Fix Attempts**
   - For eligible findings (e.g., coach overlap resolvable by swapping compatible slots), invoke a remediation service that
     proposes swaps or reassignments using heuristics already outlined in the scheduling docs.
   - Apply fixes only when they reduce the total severity score and do not introduce new conflicts, recording before/after
     deltas in `evaluation_run_events`.
   - Leave unresolved items tagged `requires_manual_review` with recommended alternate slots or teams.
5. **Reporting & Notifications**
   - Emit Supabase Realtime events so the UI can update evaluation dashboards live.
   - Generate a structured JSON summary consumable by the export agent for inclusion in release notes.
   - Provide a markdown-like report template (rendered in the admin UI) that lists blocking issues, warnings, fairness charts,
     and recommended next actions.

## Tooling & Implementation Tasks
- Define Supabase SQL functions or views that materialize overlapping assignments to simplify evaluation queries.
- Implement a TypeScript evaluation worker (serverless function or background job) that orchestrates the pipeline, calling
  modular checkers for practices, games, and team composition.
- Add Jest tests covering:
  - Detection of overlapping practices/games.
  - Coach conflict identification for multi-team coaches.
  - Fairness metric calculations given synthetic schedules.
  - Auto-fix proposals, ensuring they only produce improvements.
- Integrate logging with correlation IDs (`evaluation_run_id`) and push structured logs to Logflare for production debugging.

## Admin Experience
- Extend the dashboard with an "Evaluation" tab summarizing the latest run per scheduler (team, practice, game).
- Provide filters to inspect findings by severity, division, or team, with quick actions to jump into manual adjustment
  screens.
- Allow admins to acknowledge findings and attach notes; store acknowledgements in `evaluation_findings` so they persist
  across reruns.
- Show trend charts (sparkline of fairness scores) so regressions are visible when rerunning schedules after updates.

## Future Enhancements
- Introduce anomaly detection using historical metric baselines to catch subtle regressions.
- Enable webhook notifications (email or Slack) when evaluation runs contain blocking errors or fairness scores below target.
- Support "what-if" evaluation mode where admins can stage hypothetical changes and preview their impact before committing.
