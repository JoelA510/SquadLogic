# PR: Frontend Integration - Real Team Scheduler Data

## Summary
This PR integrates the "Team Formation" dashboard with real data from the backend. Instead of displaying hardcoded sample data (`teamSummarySnapshot`), the application now fetches the latest "completed" scheduler run from the `scheduler_runs` table in Supabase.

To support this, the sample seed data has been enriched to include a realistic, deeply nested JSON payload for the initial scheduler run, ensuring the dashboard looks "alive" immediately after seeding.

## Changes

### Frontend
- **New Hook:** `useTeamSummary` fetches the latest `scheduler_runs` record (type: `team`).
- **New Mapper:** `mapSchedulerRunToSummary` transforms the raw DB JSON (matching `teamGeneration.js` output) into the view-model expected by the dashboard components.
- **Integration:** Updated `App.jsx` to use the hook. Loading states are handled gracefully.

### Database / Seed
- **Enhanced Seed Data:** Updated `docs/sql/sample_seed_data.sql` to include a full "Team Generation" result payload (teams, players, overflow, diagnostics) in the `results` column of the sample run.

## Verification Plan

### Automated
- `npm run frontend:build` (or `npx vite build`): **Verified Pass**
  - Confirms no syntax errors in new hooks/mappers.

### Manual
1.  **Apply Seed:** Run the updated SQL seed against the target Supabase instance.
2.  **Launch App:** `npm run frontend:dev`.
3.  **Verify Dashboard:**
    - The "Team Formation Snapshot" panel should display data matching the seed (4 Teams, U8/U10/U12 divisions).
    - It should **not** show "Loading..." indefinitely.

## Deployment Notes
> [!WARNING]
> deployment of the updated seed data to the production/staging Supabase project was **blocked** due to local network firewall restrictions (ports 5432/6543 blocked).
> **Action Required:** Manual deployment (`npx supabase db push`) is required from a network that permits outbound PostgreSQL traffic.
