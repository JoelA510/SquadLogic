[← Back to Documentation Index](../README.md)

---

# Team Generation Design

> **Update — snapshot-aware re-runs.** The allocator described here is the **fresh** (from-scratch)
> design, and it is exactly what runs on the first teaming pass / when no prior snapshot is supplied.
> Since the incremental-teaming hardening effort, `generateTeams` _also_ supports **snapshot-aware,
> incremental** re-runs that preserve existing team UUIDs, manual roster moves, and coach assignments
> (reconciling only late registrations / drops / buddy & coach deltas) instead of rebuilding from
> scratch. For that behavior — policies, diagnostics, and persistence invariants — see
> [`incremental-teaming-hardening.md`](incremental-teaming-hardening.md). The sections below remain the
> reference for the underlying fresh allocation.

This document translates the roadmap's team formation phase into actionable plans for the SquadLogic. It assumes the data model described in `docs/architecture/data-modeling.md` and focuses on how to transform cleaned registration data into balanced rosters that honor mutual buddy requests and coach commitments.

## Objectives

- Produce balanced teams per division that respect the roster-size and team-count bounds stored in the database (`max_roster_size`, plus the optional minimum roster, target team size, team-count override and minimum/maximum team counts).
- Keep mutually confirmed buddies together while ignoring one-sided requests.
- Guarantee that each volunteer head coach is paired with their player(s).
- Surface enough metadata so admins can audit fairness and make manual swaps before schedules are generated.

## Inputs

- **Players**: Retrieved from the `players` table, joined with `divisions` to determine roster caps and gameplay formats.
- **Buddy pairs**: Derived from `players.mutual_buddy_code`. Only reciprocal matches are considered valid.
- **Coach volunteers**: From the `coaches` table with `player_id` links and `can_coach_multiple_teams` flag.
- **Configuration**: Season-level overrides from `season_settings` (roster adjustments, division ordering, lock dates), and per-division bounds on `divisions` (`min_roster_size`, `target_team_size`, `team_count_override`, `min_teams`, `max_teams`; migration `20260502001000`), which admins edit on the Team Analysis page through `admin_upsert_division_settings` and which `normalizeDivisionRosterConstraints` in `packages/core/src/teamGeneration.js` reads as `minRosterSize`, `targetTeamSize`, `teamCountOverride`, `minTeams` and `maxTeams`.

## Processing Steps

1. **Division preparation**
   - Query all active divisions for the upcoming season along with `max_roster_size` and the optional bounds above, ordering by youngest divisions first (customizable via `season_settings`).
   - Fetch players per division, grouping by grade or skill tier when present.
   - Build "assignment units" that either represent a single player or a confirmed buddy pair.
2. **Coach anchoring**
   - For each unit containing a coach's child, pre-assign a team shell and attach the coach profile.
   - Support coaches with multiple teams by reading `can_coach_multiple_teams`; create one slot per team request.
3. **Roster balancing algorithm**
   - Determine required team count in `buildTeamsForDivision` (`packages/core/src/teamGeneration.js`), from the division's bounds:
     - Start from `ceil(totalPlayers / targetTeamSize)` (`targetTeamSize` defaults to `maxRosterSize`), or `teamCountOverride` when one is set.
     - Raise it to at least the number of distinct volunteer coaches, `minTeams` when set, and `ceil(totalPlayers / maxRosterSize)` so the roster cap can hold everyone.
     - When `minRosterSize` is set and there are at least that many players, lower it to no more than `floor(totalPlayers / minRosterSize)` so teams are not spread below the minimum, but never below the floors in the previous step.
     - Cap it at `maxTeams` when set. The cap is applied last and wins over the capacity floor: a team that cannot be created because of it leaves its units in the overflow queue with an insufficient-capacity reason.
   - Initialize team objects with metadata: division, coach (if already placed), assistant capacity, and roster limit.
   - Iterate through shuffled assignment units, always placing the next unit into the team with the smallest roster load. Use a tie-breaker that favors teams lacking coaches to keep leadership balanced.
   - If adding a unit would exceed the roster cap, place it in an overflow queue for manual resolution.
4. **Skill or experience balancing** (optional phase)
   - When `players.skill_tier` exists, perform a serpentine draft per tier to distribute skill evenly before filling remaining slots randomly.
5. **Fairness metrics & diagnostics**
   - After allocation, compute per-team roster counts, number of buddy pairs, and presence of volunteer coaches.
   - Log unmatched buddy requests, overflow players, and divisions that exceed configured roster caps.
   - Store diagnostics in a `scheduler_runs` entry (`run_type = 'team'`) for audit history. (Implemented — persisted runs feed the snapshot-aware re-run path; see `incremental-teaming-hardening.md`.)

## Outputs

- **Teams table updates**: Insert or upsert team records with `division_id`, autogenerated `name`, assigned `coach_id`, and notes about buddy pairs. The allocator now supports per-division naming controls: provide `teamNames` to supply explicit names in order or `teamNamePrefix` to generate labeled defaults (e.g., `Lightning 01`, `Lightning 02`) before falling back to `"{division} Team {index}"`.
- **Roster assignments**: Populate a join table `team_players` with each player's `team_id`, assignment timestamp, and source (`auto` vs `manual`).
- **Overflow queue**: The allocator exposes an `overflowByDivision` collection so manual workflows can immediately review units that exceeded roster capacity.
- **Buddy resolution report**: JSON payload summarizing honored and unmet buddy requests for admin review. The allocator now exposes this via `buddyDiagnosticsByDivision`, listing mutual pairs alongside unmatched requests (missing registrations, non-reciprocal entries, and self references) so admins can reconcile data issues quickly.
- **Roster balance summary**: `rosterBalanceByDivision` carries per-team fill (`slotsRemaining`, `fillRate`, `needsPlayersToMin` when a minimum roster is set) and a division summary with `teamsNeedingPlayers`, plus `teamsBelowMinRoster` when `minRosterSize` is set and `teamCountConstraints` (`minTeams`, `maxTeams`) when either bound is set.
- **Coach coverage summary**: Highlight any division lacking enough volunteer coaches to meet team counts. The allocator now
  returns this metadata through `coachCoverageByDivision`, which includes total team counts, volunteer coach coverage, and a
  `needsAdditionalCoaches` flag so the admin workflow can prioritize outreach.
- **Persistence snapshot builder**: The new `prepareTeamPersistenceSnapshot` helper in `src/teamPersistenceSnapshot.js`
  packages the Supabase payloads (team rows plus player rows) alongside admin-facing metadata such as manual override queues,
  pending/applied counts, and run history ordering. The helper also normalizes manual overrides (defaulting status to
  `pending`, enforcing known status values, and filling in team names from the normalized Supabase payloads) while returning
  the prepared counts that the admin dashboard displays. Only overrides explicitly marked as `applied` are folded into the
  Supabase-ready team rows; pending or unspecified statuses remain in the admin queue metadata so the dashboard can surface
  them for review without mutating persistence payloads. This gives the dashboard enough context to display readiness without
  reimplementing normalization logic on the client.
- **Admin shell persistence trigger**: The dashboard now posts override-ready payloads to a configurable
  `VITE_SUPABASE_PERSISTENCE_URL` endpoint when present (via `teamPersistenceClient.js`), retaining the local simulator as a
  fallback. When only a `SUPABASE_URL` (or `VITE_SUPABASE_URL`) is provided, the client now derives the Edge Function base
  (`<supabase-url>/functions/v1`) automatically so deployments that export Supabase URLs to the frontend no longer need a
  separate `VITE_SUPABASE_PERSISTENCE_URL`. The `frontend:build` and `frontend:preview` scripts now pre-populate
  `VITE_SUPABASE_PERSISTENCE_URL` from `SUPABASE_URL`/`VITE_SUPABASE_URL`, ensuring deployed dashboards call the live Edge
  Function without extra environment wiring. Pending manual overrides still block push attempts client-side so the UI avoids
  unnecessary network calls when the Supabase run would be rejected. When a live endpoint is configured, the UI now surfaces
  which host will be called and echoes backend-provided error messages so admins can distinguish client validation failures
  from server-side rejections.
- **Server-side request processor**: `processTeamPersistenceRequest` (see `src/teamPersistenceApi.js`) centralizes auth checks,
  snapshot validation, and transactional upserts so Edge Functions or Node handlers can reuse the same path as the dashboard.
  This keeps server responses consistent with the client simulator while ensuring `scheduler_runs` and roster tables stay in
  sync.
- **Supabase Edge Function**: `supabase/functions/team-persistence/index.ts` wraps the HTTP handler for deployment, using
  `TEAM_PERSISTENCE_ALLOWED_ROLES` (fallback: `admin`, `scheduler`) to align backend role checks with the dashboard’s
  expectations.

## Manual Adjustment Workflow

1. Present team rosters in the admin UI with sortable columns (player name, buddy code, skill tier).
2. Allow drag-and-drop or action buttons to swap players across teams, updating `team_players` and logging adjustments.
3. Provide quick filters for overflow units so admins can resolve outstanding assignments before locking rosters.
4. Once approved, mark the run as `finalized`. A subsequent re-run is **snapshot-aware** (see [`incremental-teaming-hardening.md`](incremental-teaming-hardening.md)): it preserves approved rosters, manual moves, and team IDs rather than reshuffling them — a full fresh rebuild requires an explicit reset (an `auto` team-count policy or discarding the snapshot).

## Quality Checks

- **Data validation**: Ensure each player appears on exactly one team (or flagged as overflow). Enforce database constraints to prevent duplicates.
- **Coach-child linkage**: Verify that every `coaches.player_id` has a corresponding roster entry on the coach's team.
- **Buddy integrity**: Confirm that buddy pairs share the same `team_id`; emit warnings when roster caps prevent pairing.
- **Audit trail**: Record the algorithm version and input snapshot so future reruns can be compared for consistency.

## Integration Points

- Expose a serverless function (e.g., `/api/team-generation/run`) that triggers the workflow and writes results to Supabase.
- Use Supabase Realtime or polling to update the UI with progress states (`queued`, `running`, `completed`, `needs_manual_action`).
- Re-runs are snapshot-aware: they preserve manual adjustments and existing team IDs and report a structured change diff (`changeDiagnosticsByDivision`) instead of overwriting silently. Gating a re-run behind an admin confirmation is still good practice for published rosters.

## Acceptance Criteria & Test Harness Outline

- **Happy path**: For each division, all players (including buddy pairs) are assigned without exceeding roster caps when enough capacity exists.
- **Coach coverage**: Every coach volunteer with `can_coach_multiple_teams = false` is assigned to exactly one roster that includes their player.
- **Buddy enforcement**: Mutual buddy requests always share a `team_id`; single-sided or invalid codes are reported but do not block assignment.
- **Overflow handling**: When roster caps are insufficient, affected players are surfaced in an overflow report with division context.
- **Diagnostics**: Algorithm emits a structured summary (team counts, buddy stats, overflow list) persisted to `scheduler_runs`.

### Test harness plan

- Use Vitest with a fixture loader that seeds in-memory objects mirroring the schema (players, coaches, divisions, configuration).
- Provide scenario fixtures: balanced division, buddy-heavy division, coach overlap division, and capacity-deficit division.
- Assert both database mutations (mocked repositories) and diagnostic payload content for each scenario.
- Integrate snapshot tests for the overflow report and buddy resolution report to detect regressions in admin-facing outputs.

## Next Steps

Shipped: unit tests for buddy pairing, roster balancing and overflow detection (`tests/teamGeneration.test.js`, `tests/buddyLinking.test.js`, `tests/assignmentUnits.test.js`), the roster review and manual adjustment UI (`frontend/src/components/teaming/RosterManager.jsx`, `frontend/src/pages/TeamBuilderPage.jsx`), and the Row Level Security policies that limit roster edits to admins (`docs/security/rls-policies.md`).

Still open from the test harness plan above: those tests build inline objects rather than using a
schema-shaped fixture loader, they do not assert repository mutations, and there are no snapshot
tests (`toMatchSnapshot` / `toMatchInlineSnapshot`) for the overflow or buddy reports.
