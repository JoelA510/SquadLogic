[← Back to Documentation Index](../README.md)

---

# Migration Ledger Normalisation (one-time, 2026-09-28)

> **Status: EXECUTED on production 2026-09-28** (project `mmwupqsjkikqzvmdvuzm`,
> run once by the supervisor through the Supabase MCP `execute_sql` tool, after
> review and after the local verification below). Verified read-only on
> 2026-09-28 at about 04:32 UTC:
>
> - `supabase_migrations.schema_migrations`: **117 rows, 117 distinct
>   versions**, min `20240405180000`, max `20260924000000`;
> - `supabase_migrations.schema_migrations_backup_20260928`: the original
>   **141 rows**;
> - application data unchanged (`coaches` 130, `organizations` 1).
>
> Still pending in production, to be applied by the first `deploy-migrations`
> run: `20260927000000` (#453) and `20260928000000` (#454).
>
> **Do not run the SQL below again.** It is kept as the record of what ran; its
> precondition (`141 rows`) now aborts it.
>
> Companion: [`ci-cd.md` § Database migrations](./ci-cd.md#database-migrations-deploy-migrations).

## Why this exists

CI now applies migrations to production with `supabase db push`
(`deploy-migrations` job). The Supabase CLI decides what is pending by comparing
the **filename timestamp** of each file in `supabase/migrations/` with the
`version` column of `supabase_migrations.schema_migrations` on the remote.

Production's ledger was written by the Supabase MCP connector
(`apply_migration`), which keys each row on the **time it was applied**
(e.g. `20260927155035`), not on the file's timestamp. So, before this
normalisation, the ledger had 141 rows and not one of their versions matched a
repo file. Measured on the local replica of that shape (CLI 2.118.0):

- `supabase migration list` shows every repo file as local-only and every
  ledger row as remote-only;
- `supabase db push --dry-run` refuses with
  `Remote migration versions not found in local migrations directory` and
  suggests `supabase migration repair --status reverted <all 141 versions>`.

**Following that suggestion is the catastrophe.** Marking the 141 rows reverted
leaves an empty ledger, and the next push replays all 118 repo files against a
live schema -- including `20251208000001_seed_data`, which must never run in
production. The normalisation below does the opposite: it records the repo's
own versions as applied, which is what is true in substance.

## What is true in production (the premise)

Every repo file up to and including `20260924000000` is applied in production
in substance. Eight of them were never applied as-is but are superseded or
equivalent, and must be recorded as applied so the CLI never runs them:

| File                                                   | Why it must not run                         |
| ------------------------------------------------------ | ------------------------------------------- |
| `20240405180000_password_hardening`                    | superseded                                  |
| `20251208000001_seed_data`                             | **seed data; must never run in production** |
| `20251214000001_refactor_schema`                       | superseded                                  |
| `20260331000000_definitive_schema`                     | applied as 14 split rows                    |
| `20260406180000_phase_7_analytics_persistence`         | equivalent applied                          |
| `20260409000000_audit_log_retention_180`               | equivalent applied                          |
| `20260421001209_lock_search_path_on_definer_functions` | equivalent applied                          |
| `20260421002500_lock_search_path_remaining_definers`   | equivalent applied                          |

Genuinely pending (and deliberately **not** in the insert list, so CI applies
them): `20260927000000_coach_practice_preferences` (#453) and
`20260928000000_reconcile_prod_rls_drift` (#454).

## What it changes

Only `supabase_migrations.schema_migrations`. No application schema, no data.

1. Preconditions (abort on any mismatch): exactly 141 ledger rows; no backup
   table yet; no ledger row already names a genuinely pending migration (if
   someone applied `coach_practice_preferences` or `reconcile_prod_rls_drift`
   through MCP in the meantime, the list below is stale -- stop and re-plan).
2. Back up the ledger to `supabase_migrations.schema_migrations_backup_20260928`.
3. Delete the apply-time rows (all 141; none of them is keyed on a repo version).
4. Insert one row per repo file `<= 20260924000000` (117 rows), with the column
   shape the CLI writes: `version` = the filename timestamp, `name` = the rest of
   the stem (the CLI's `^([0-9]+)_(.*)\.sql$`), `statements` = `NULL`.
5. Postconditions: 117 rows, highest version `20260924000000`, backup holds 141.

**Why `statements` is `NULL`.** The CLI inserts
`(version, name, statements)`; `migration repair --status applied` fills
`statements` from the local file. `migration list` and `db push` read only
`version`, so `NULL` is sufficient for the job, and it avoids pasting ~1.5 MB of
SQL through `execute_sql`. The statements that were **actually** applied are
preserved, row for row, in the backup table -- which is the more honest record.
Only `supabase migration fetch` / `db pull` would read `statements`; this repo
uses neither against production.

The whole block is one transaction: a failed assertion rolls everything back,
including the backup table. (If the connector rejects explicit `BEGIN`/`COMMIT`,
drop those two lines: PostgreSQL runs a multi-statement simple query as one
implicit transaction.)

## The SQL

<!-- ledger-normalisation-sql:begin -->

```sql
BEGIN;

-- 1. Preconditions.
DO $pre$
DECLARE
  n int;
  pending text;
BEGIN
  SELECT count(*) INTO n FROM supabase_migrations.schema_migrations;
  IF n <> 141 THEN
    RAISE EXCEPTION 'ledger has % rows, expected 141 -- wrong project, or already normalised', n;
  END IF;
  IF to_regclass('supabase_migrations.schema_migrations_backup_20260928') IS NOT NULL THEN
    RAISE EXCEPTION 'backup table already exists -- normalisation has already run';
  END IF;
  SELECT string_agg(version || ' ' || coalesce(name, '<null>'), ', ') INTO pending
    FROM supabase_migrations.schema_migrations
   WHERE name ~ '(coach_practice_preferences|reconcile_prod_rls_drift)$';
  IF pending IS NOT NULL THEN
    RAISE EXCEPTION 'a genuinely pending migration is already in the ledger: % -- re-plan', pending;
  END IF;
END
$pre$;

-- 2. Backup (keeps every column, including the statements actually applied).
CREATE TABLE supabase_migrations.schema_migrations_backup_20260928 AS
  SELECT * FROM supabase_migrations.schema_migrations;

-- 3. Delete the apply-time rows.
DELETE FROM supabase_migrations.schema_migrations;

-- 4. One row per repo file <= 20260924000000, keyed as the CLI keys them.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT version, name, NULL::text[]
  FROM (VALUES
    ('20240405180000', 'password_hardening'),
    ('20251208000000', 'consolidated_schema'),
    ('20251208000001', 'seed_data'),
    ('20251214000001', 'refactor_schema'),
    ('20251214000002', 'timezone_settings'),
    ('20251214000003', 'organizations_schema'),
    ('20251214000004', 'core_auth'),
    ('20251215000000', 'strict_rls_multi_tenancy'),
    ('20251216000000', 'facility_multi_tenancy'),
    ('20251217000000', 'communication_schema'),
    ('20251218000000', 'calendar_sync'),
    ('20251219000000', 'registration_schema'),
    ('20251220000000', 'reporting_views'),
    ('20260309000000', 'rls_remediation'),
    ('20260310000002', 'unified_rls_schema'),
    ('20260310000003', 'registrations_rpc'),
    ('20260324000000', 'phase1_rls_unification'),
    ('20260324000001', 'fix_registration_policies'),
    ('20260324000002', 'calendar_token_expiry'),
    ('20260324000003', 'phase3_registration_rpc_hardening'),
    ('20260324000004', 'audit_log'),
    ('20260331000000', 'definitive_schema'),
    ('20260402150700', 'phase_1_1_feature_flags'),
    ('20260403000000', 'settings_audit_rpc'),
    ('20260404100000', 'phase_2_setup_wizard'),
    ('20260404110000', 'telemetry_rpc'),
    ('20260404120000', 'phase_4_observability'),
    ('20260405120000', 'phase_5_fluid_schemas'),
    ('20260406180000', 'phase_7_analytics_persistence'),
    ('20260407000000', 'persist_evaluation_run_overload'),
    ('20260408000000', 'realtime_audit_log'),
    ('20260408100000', 'retention_180_days'),
    ('20260409000000', 'audit_log_retention_180'),
    ('20260409100000', 'maintenance_mode_flag'),
    ('20260416000000', 'security_hardening'),
    ('20260416000001', 'initialize_new_tenant'),
    ('20260416000002', 'data_retention_cron'),
    ('20260421000833', 'fix_import_efficiency_metrics_invoker'),
    ('20260421001043', 'scope_raw_imports_bucket'),
    ('20260421001209', 'lock_search_path_on_definer_functions'),
    ('20260421002500', 'lock_search_path_remaining_definers'),
    ('20260421005642', 'add_free_tier_indexes'),
    ('20260421022121', 'auto_create_profile_on_signup'),
    ('20260421025831', 'drop_recursive_org_members_policy'),
    ('20260421034626', 'invite_code_system'),
    ('20260421051109', 'add_registration_forms_division'),
    ('20260421060000', 'coach_leads'),
    ('20260423065246', 'enable_pgtap'),
    ('20260430120000', 'recreate_import_efficiency_metrics_from_payload'),
    ('20260502000000', 'import_finalize_pipeline'),
    ('20260502001000', 'division_roster_constraints'),
    ('20260503000000', 'secure_coach_lead_scoping'),
    ('20260503010000', 'repair_practice_persistence_rpc'),
    ('20260503020000', 'link_practice_assignments_to_runs'),
    ('20260503030000', 'repair_game_persistence_rpc'),
    ('20260503040000', 'repair_team_persistence_rpc'),
    ('20260503050000', 'coach_admin_mutations'),
    ('20260503060000', 'coach_import_apply_rollback'),
    ('20260503070000', 'field_import_apply_rollback'),
    ('20260503080000', 'player_import_buddy_materialization'),
    ('20260503090000', 'import_deferred_apply_status'),
    ('20260503100000', 'import_stale_job_cleanup'),
    ('20260503110000', 'team_portal_medical_status_rpc'),
    ('20260504000000', 'admin_compliance_medical_status_rpc'),
    ('20260504010000', 'update_game_score_rpc'),
    ('20260504020000', 'admin_upsert_division_settings_rpc'),
    ('20260504030000', 'admin_create_registration_form_rpc'),
    ('20260504040000', 'revoke_org_invite_rpc'),
    ('20260504050000', 'admin_upsert_organization_schema_rpc'),
    ('20260504060000', 'admin_facility_mutation_rpcs'),
    ('20260504070000', 'team_portal_communication_rpcs'),
    ('20260504080000', 'import_job_lifecycle_rpcs'),
    ('20260504090000', 'drop_legacy_evaluation_run_overload'),
    ('20260504100000', 'drop_current_user_role_helper'),
    ('20260522120000', 'field_availability_phase1'),
    ('20260522130000', 'field_availability_phase1_hardening'),
    ('20260522153000', 'field_availability_finalize_hardening'),
    ('20260530000000', 'age_cutoff_division_bands_canonical_fields'),
    ('20260530000100', 'upsert_division_for_import_rpc'),
    ('20260602000000', 'field_availability_finalize_applied_payload_fix'),
    ('20260602010000', 'consolidated_rls_security_hardening'),
    ('20260603000000', 'field_availability_scenario_selection_rpc'),
    ('20260603120000', 'revoke_anon_execute_on_definer_functions'),
    ('20260603190000', 'import_division_from_age_group'),
    ('20260610000000', 'teaming_rerun_followups'),
    ('20260611000000', 'player_roster_fields'),
    ('20260611000100', 'player_admin_mutation_rpcs'),
    ('20260611000200', 'import_gotsport_expanded_mapping'),
    ('20260611000300', 'redesign_audit_actions'),
    ('20260611000400', 'players_team_id_sync'),
    ('20260612000000', 'min_uuid_aggregate'),
    ('20260612000001', 'min_uuid_aggregate_hardening'),
    ('20260613000000', 'coach_delete_rpc'),
    ('20260613000001', 'form_mutation_rpcs'),
    ('20260613000002', 'member_mutation_rpcs'),
    ('20260613000003', 'schedule_team_delete_rpcs'),
    ('20260613000004', 'team_update_rpc'),
    ('20260613000005', 'crud_review_fixes'),
    ('20260613000006', 'audit_actions_lookup'),
    ('20260614000000', 'advisor_hardening_followups'),
    ('20260726000000', 'drop_stale_broad_write_policies'),
    ('20260726000100', 'fix_organizations_write_policy'),
    ('20260726000200', 'record_audit_event_authz'),
    ('20260726000300', 'finalize_import_reimport_coalesce'),
    ('20260906000000', 'field_effective_dating'),
    ('20260906000100', 'field_blackouts'),
    ('20260907000000', 'field_delete_booking_guard'),
    ('20260908000000', 'field_availability_profile_field_resolution'),
    ('20260909000000', 'rollback_field_import_booking_guard'),
    ('20260910000000', 'admin_update_field_blackout'),
    ('20260911000000', 'venue_subunit_effective_dating'),
    ('20260912000000', 'retire_refuses_on_contained_estate'),
    ('20260913000000', 'season_timezone_writer'),
    ('20260917000000', 'season_timezone_actor_context'),
    ('20260920000000', 'publication_baselines'),
    ('20260923000000', 'team_coach_assignments'),
    ('20260924000000', 'practice_writer_prunes_superseded')
  ) AS repo(version, name);

-- 5. Postconditions.
DO $post$
DECLARE
  n int;
  hi text;
  b int;
BEGIN
  SELECT count(*), max(version) INTO n, hi FROM supabase_migrations.schema_migrations;
  SELECT count(*) INTO b FROM supabase_migrations.schema_migrations_backup_20260928;
  IF n <> 117 OR hi <> '20260924000000' OR b <> 141 THEN
    RAISE EXCEPTION 'postcondition failed: rows=% max=% backup=%', n, hi, b;
  END IF;
END
$post$;

COMMIT;
```

<!-- ledger-normalisation-sql:end -->

`tests/migrationLedgerNormalisation.test.js` checks that the insert list above is
exactly the repo files `<= 20260924000000`, so the list cannot drift from the
directory unnoticed.

## Local verification (2026-09-28, before any production run)

Private PostgreSQL 16 cluster, harness `prelude.sql`, then the repo chain applied
up to and including `20260924000000` (117 files). A synthetic, production-shaped
ledger was built alongside it: the same columns as production
(`version`, `statements`, `name`, `created_by`, `idempotency_key`, `rollback`)
and 141 apply-time rows (`20251102160713` … `20260503045733`), with the 8 files
above absent and `definitive_schema` as 14 split rows. The SQL block above was
extracted from this file and run as written. The CLI used was `supabase@2.118.0`
with `--db-url`.

- **Before:** `db push --dry-run` → exit 1, `Remote migration versions not found
in local migrations directory` (suggesting `repair --status reverted` of all
  141).
- **Normalisation:** `DO` / `SELECT 141` / `DELETE 141` / `INSERT 0 117` / `DO` /
  `COMMIT`. The ledger then had 117 rows (`20240405180000` … `20260924000000`),
  and the backup had 141.
- **After:** `db push --dry-run` printed
  ```
  DRY RUN: migrations will *not* be pushed to the database.
  Would push these migrations:
   • 20260927000000_coach_practice_preferences.sql
  ```
  `migration list` showed Local = Remote for every row up to `20260924000000`,
  with `20260927000000` local-only.
- **Re-run:** the same SQL aborted with `ledger has 117 rows, expected 141`.
- **End to end:** the migration guard passed ("1 pending, all above
  20260924000000"). A real `db push --yes` then applied only `20260927000000`,
  and the CLI recorded it as `name = 'coach_practice_preferences'`, the same
  name format this SQL writes. `migration list` plus the guard's `--verify`
  reported 118 applied and none pending.

## Verification after the production run

Done read-only on 2026-09-28 (counts in the status block above). The CLI-side
check is left to the first `deploy-migrations` run, whose "Migration list
(before)" and "Dry run" steps must show:

- `supabase migration list` -- every row up to `20260924000000` has Local and
  Remote equal; only `20260927000000` and `20260928000000` are local-only;
  nothing is remote-only.
- `supabase db push --dry-run` -- lists exactly those two files.

## Rollback (ledger only)

Restore the apply-time ledger from the backup in **one transaction**: delete
the normalised rows and insert the backup's rows back. The guards abort (and
roll back) if the backup is not the 141-row original, or if the live ledger is
no longer the normalised 117 rows (that is, CI has deployed since).

```sql
BEGIN;

DO $rb$
DECLARE
  b int;
  n int;
  hi text;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations_backup_20260928') IS NULL THEN
    RAISE EXCEPTION 'backup table is gone -- nothing to restore from';
  END IF;
  SELECT count(*) INTO b FROM supabase_migrations.schema_migrations_backup_20260928;
  IF b <> 141 THEN
    RAISE EXCEPTION 'backup has % rows, expected 141 -- stop', b;
  END IF;
  -- Only the untouched normalised ledger may be rolled back. Once CI has
  -- applied anything, the ledger holds rows the backup lacks, and a restore
  -- would un-record migrations whose schema changes are already live.
  SELECT count(*), max(version) INTO n, hi FROM supabase_migrations.schema_migrations;
  IF n <> 117 OR hi <> '20260924000000' THEN
    RAISE EXCEPTION 'ledger has % rows, max %; expected the normalised 117 / 20260924000000 -- CI has deployed since, do not roll back', n, hi;
  END IF;
END
$rb$;

DELETE FROM supabase_migrations.schema_migrations;
INSERT INTO supabase_migrations.schema_migrations
  SELECT * FROM supabase_migrations.schema_migrations_backup_20260928;

COMMIT;
```

Rolling back restores the apply-time ledger, which puts CI straight back into
the refusal described above: the `deploy-migrations` guard would then fail every
run. It is only sensible **before** the first CI deploy. After that deploy, the
ledger also holds the CLI's rows for `20260927000000` and `20260928000000`,
which the backup does not; a restore would erase them.

**When to drop the backup table.** After the first successful `deploy-migrations`
run on `main` (its "Verify nothing pending" step green, `migration list`
showing Local = Remote for every file). From then on the normalised ledger is
the proven state and rollback is no longer a path. Then run:

```sql
DROP TABLE supabase_migrations.schema_migrations_backup_20260928;
```

If the statements that were actually applied are wanted as a record, export
the backup table before dropping it.

## From now on

Do **not** apply repo migrations through MCP `apply_migration`: it writes an
apply-time version and re-creates exactly this mismatch (the next push would try
to run the file again). CI is the only writer. If an emergency hand-apply is
unavoidable, record it with the file's own version, e.g.
`supabase migration repair --status applied <filename timestamp>`.
