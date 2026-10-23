-- Smoke test for migration 20260421005642_add_free_tier_indexes.sql
--
-- Verifies all 15 expected indexes exist with the right column order.
-- Run post-apply against staging or prod.

select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'idx_scheduler_runs_org_type_status_created',
    'idx_scheduler_runs_org_status',
    'idx_event_rsvps_org_team',
    'idx_divisions_organization_id',
    'idx_teams_organization_id',
    'idx_players_organization_id',
    'idx_coaches_organization_id',
    'idx_locations_organization_id',
    'idx_fields_organization_id',
    'idx_field_subunits_organization_id',
    'idx_practice_slots_organization_id',
    'idx_team_players_org_team',
    'idx_import_jobs_org_status',
    'idx_games_org_home_team',
    'idx_games_org_away_team'
  )
order by tablename, indexname;

-- Expected: 15 rows. If fewer, the migration didn't apply to every table; check
-- for a prior migration that dropped one of the target tables (e.g., a table
-- rename that broke the IF NOT EXISTS CREATE INDEX).
-- Since 20261022030000 (R2) dropped event_rsvps, idx_event_rsvps_org_team went
-- with it: on a database past that migration, expect 14.

-- Query-plan spot check (optional; requires sample data):
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT * FROM public.scheduler_runs
--   WHERE organization_id = '<uuid>' AND run_type = 'team' AND status = 'completed'
--   ORDER BY created_at DESC LIMIT 10;
--
-- Expected: `Index Scan using idx_scheduler_runs_org_type_status_created`.
-- If `Seq Scan on scheduler_runs`, the planner rejected the composite index
-- (row count too low to matter, OR statistics stale — run ANALYZE first).
