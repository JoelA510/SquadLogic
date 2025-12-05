# P4: Frontend Practice Schedule Integration

## Description
Integrates the "Practice Scheduling" workflow with real data from the database, replacing the hardcoded `practiceReadinessSample.js` with dynamic data fetched via Supabase.

## Changes
- **Seed Data**: Added a rich `practice` run payload to `docs/sql/sample_seed_data.sql` (and `supabase/seed.sql`) to simulate a completed scheduler run.
- **Frontend Hook**: Created `usePracticeSummary.js` to fetch the latest practice run.
- **Mapper**: Created `practiceSummaryMapper.js` to transform the raw JSONB payload into the format expected by the UI.
- **UI Integration**: Updated `App.jsx` to pass dynamic data to `PracticeReadinessPanel` and `PracticePersistencePanel`.

## Verification
- **Automated**: `npx vite build` passes.
- **Manual**: Verified via seed data application that the dashboard loads practice metrics correctly (locally).

## Checklist
- [x] Database migrations/seed updated
- [x] Frontend hooks implemented
- [x] Components wired up
- [x] Build verified
