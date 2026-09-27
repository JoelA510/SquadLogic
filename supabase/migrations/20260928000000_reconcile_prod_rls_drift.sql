-- Reconcile production RLS drift back to the repository's policy set.
--
-- **What production has that no repo file does.** A read-only drift check of
-- production (2026-09-27) found a migration applied from the dashboard,
-- `rls_hardening_stage_1`, that exists in no file here. It created
--
--     "Enforce Org Membership: ALL"  FOR ALL TO authenticated
--         USING (is_org_member(organization_id))
--         WITH CHECK (is_org_member(organization_id))
--
-- on coaches, teams, locations, fields, divisions, game_assignments,
-- import_jobs, imports, team_messages, organization_schemas and
-- schedule_evaluations -- letting ANY org member (coach, parent, player), not
-- only an admin, INSERT, UPDATE and DELETE those tables directly. Every write
-- to them is meant to go through a SECURITY DEFINER admin RPC or a
-- service-role Edge Function (both bypass RLS); see 20260726000000 for the
-- same defect, under a different name, on the repo chain.
--
-- **Why it cannot simply be dropped.** On six of those tables (coaches,
-- teams, game_assignments, imports, import_jobs, schedule_evaluations)
-- production also LACKS the repo's member SELECT policy, so the broad policy
-- is their only read path. So this migration first creates every repo policy
-- on the affected tables that is missing, and only then drops the broad one;
-- it runs in one transaction, so no reader ever sees neither.
--
-- **What it creates.** Each repo policy on the eleven tables plus
-- practice_slots and field_subunits, by name, command, roles and
-- USING/WITH CHECK taken verbatim from the migration that defines it on main
-- (cited per row below), created only if no policy of that name exists. A
-- policy that DOES exist under that name is compared, clause by clause, with
-- a probe built from the same spec; a mismatch aborts the migration rather
-- than leaving a same-named policy with different semantics in place and
-- reporting the table reconciled.
--
-- **The one repo policy it deliberately does NOT copy, and removes instead.**
-- The repo chain still carries "org_member_access" on practice_slots and
-- field_subunits (20260416000000_security_hardening.sql:70): FOR ALL TO
-- authenticated USING (is_org_member(organization_id)) -- the same
-- member-write hole as the dashboard policy, under the name that migration
-- gave it. 20260602010000_consolidated_rls_security_hardening.sql:22-30 states
-- the intended end state for both tables is member SELECT plus admin-RPC
-- writes and excluded them from its sweep on the belief that was already
-- true; it was not. Production does not have it. Copying it into production
-- would re-open member writes on two tables while closing them on eleven, so
-- the repo is moved to production here: the member SELECT policies below give
-- both tables their read path, and "org_member_access" is dropped from them.
-- No user-client write to either table exists (census in the PR).
--
-- **The same hole on scheduler_runs, found by censusing the catalogue rather
-- than a list.** Every non-SELECT policy in `public` on the fully migrated
-- repo chain was enumerated; three a plain member can satisfy on a row that is
-- not their own survived the eleven-table fix:
--   * practice_slots / field_subunits "org_member_access" -- holes (above).
--   * scheduler_runs "org_member_access" (20260416000000_security_hardening.sql:54,70)
--     -- a hole, and the table's ONLY policy, so it is also its only read
--     path. Its writers: persist_game_schedule and persist_team_schedule are
--     SECURITY DEFINER (bypass RLS); persist_practice_schedule
--     (20260924000000_practice_writer_prunes_superseded.sql:84,91) is SECURITY
--     INVOKER, refuses non-admins itself (:214) and INSERTs/UPDATEs
--     scheduler_runs as the calling admin; no Edge Function and no client
--     code writes it (census in the PR). So it gets the member-read /
--     admin-write split its siblings got in
--     20260602010000_consolidated_rls_security_hardening.sql:48-57, under the
--     same names, and "org_member_access" is dropped.
--   * telemetry_log "Insert telemetry for own organization"
--     (20260404100000_phase_2_setup_wizard.sql:69-79) -- an INTENDED member
--     write: the migration states "Only organization members can insert
--     telemetry", and log_telemetry_event (20260404110000_telemetry_rpc.sql:15)
--     grants every member the same write. Allowlisted, with that reason.
-- "Profiles: users update own" (20260331000000_definitive_schema.sql:962) is a
-- self-row write a member cannot use on another row; it is allowlisted only
-- because the text-level check below cannot tell a self-row gate from none.
--
-- **The end state is asserted catalogue-wide before commit.** No non-SELECT
-- policy anywhere in `public` may carry a clause without an admin gate unless
-- `public.rls_member_write_allowlist()` names it with its reason. That check
-- is TEXT-level (an admin token in every clause) because a migration cannot
-- impersonate a member in production; the smoke checks the same set
-- SEMANTICALLY, evaluating every policy as a plain member, which is what
-- catches `is_org_member(x) OR is_org_admin(x)` -- a shape the text check
-- would pass.
--
-- **On the repo chain** every policy below already exists with an identical
-- definition, and "Enforce Org Membership: ALL" never existed, so this
-- creates only the two scheduler_runs policies and drops only
-- "org_member_access" on practice_slots, field_subunits and scheduler_runs.
-- The smoke asserts both, and replays the production drift to prove the rest.
--
-- **Why a function.** The body is kept as
-- `public.reconcile_prod_rls_drift()` so the smoke can re-run the exact code
-- this migration ran against a recreated production-shaped schema. It is
-- SECURITY INVOKER (CREATE/DROP POLICY needs table ownership, which no API
-- role has) and EXECUTE is revoked from PUBLIC, anon and authenticated.
--
-- Revert: docs/sql/20260928000000_revert.sql (it does NOT restore the broad
-- policy or any "org_member_access"; see its header). Smoke: docs/sql/20260928000000_smoke.sql.

BEGIN;

-- Every non-SELECT policy in `public` a plain member may satisfy, each with the
-- reason it is intended. Anything else member-satisfiable is a hole.
CREATE OR REPLACE FUNCTION public.rls_member_write_allowlist()
RETURNS TABLE (tablename text, policyname text, reason text)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
    VALUES
        ('telemetry_log', 'Insert telemetry for own organization',
         'intended member write: 20260404100000_phase_2_setup_wizard.sql:69 "Only organization members can insert telemetry"; log_telemetry_event (20260404110000_telemetry_rpc.sql:15) grants every member the same write'),
        ('profiles', 'Profiles: users update own',
         'self-row write (auth.uid() = id, 20260331000000_definitive_schema.sql:962): no member can reach another row; listed only because the text-level check cannot see a self-row gate')
$fn$;

REVOKE ALL ON FUNCTION public.rls_member_write_allowlist() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_member_write_allowlist() FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reconcile_prod_rls_drift()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
    v_spec record;
    v_pol record;
    v_ddl text;
    v_have record;
    v_probe record;
    v_created text[] := ARRAY[]::text[];
    v_verified text[] := ARRAY[]::text[];
    v_dropped text[] := ARRAY[]::text[];
    -- Stated, not read back from the catalogue this function rewrites.
    c_broad_tables text[] := ARRAY['coaches','teams','locations','fields','divisions','game_assignments',
                                   'import_jobs','imports','team_messages','organization_schemas',
                                   'schedule_evaluations'];
    c_member_write_tables text[] := ARRAY['practice_slots','field_subunits','scheduler_runs'];
BEGIN
    -- 1. Every repo policy on the affected tables, created if missing.
    --    Columns: table, policy, command, roles, USING, WITH CHECK -- each
    --    clause copied verbatim from the source line cited.
    FOR v_spec IN
        SELECT * FROM (VALUES
            -- 20260331000000_definitive_schema.sql:1026
            ('coaches', 'Coaches: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1036
            ('teams', 'Teams: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1061
            ('game_assignments', 'Game Assignments: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1132
            ('imports', 'Imports: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1137
            ('import_jobs', 'Import Jobs: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260404120000_phase_4_observability.sql:42 (no TO clause: PUBLIC)
            ('import_jobs', 'Users can view their organization''s import jobs', 'SELECT', 'public',
             'organization_id IN (
            SELECT organization_id FROM public.organization_members
            WHERE profile_id = auth.uid()
        )', NULL),
            -- 20260331000000_definitive_schema.sql:1167
            ('schedule_evaluations', 'Schedule Evaluations: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260504070000_team_portal_communication_rpcs.sql:53
            ('team_messages', 'Team Messages: members access', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260502001000_division_roster_constraints.sql:103
            ('divisions', 'Divisions: org members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260502001000_division_roster_constraints.sql:107
            ('divisions', 'Divisions: org admins insert', 'INSERT', 'authenticated',
             NULL, 'public.is_org_admin(organization_id)'),
            -- 20260502001000_division_roster_constraints.sql:111
            ('divisions', 'Divisions: org admins update', 'UPDATE', 'authenticated',
             'public.is_org_admin(organization_id)', 'public.is_org_admin(organization_id)'),
            -- 20260502001000_division_roster_constraints.sql:116
            ('divisions', 'Divisions: org admins delete', 'DELETE', 'authenticated',
             'public.is_org_admin(organization_id)', NULL),
            -- 20260504050000_admin_upsert_organization_schema_rpc.sql:13
            ('organization_schemas', 'Schema Access: Org Members Select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:19
            ('locations', 'Locations: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:24
            ('fields', 'Fields: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:29
            ('field_subunits', 'Field Subunits: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:34
            ('practice_slots', 'Practice Slots: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- NEW (the repo has no member SELECT on scheduler_runs): the
            -- sibling split of 20260602010000_consolidated_rls_security_hardening.sql:48-57,
            -- same names and clauses. The admin write keeps the SECURITY
            -- INVOKER persist_practice_schedule working for admins.
            ('scheduler_runs', 'scheduler_runs_select_member', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            ('scheduler_runs', 'scheduler_runs_write_admin', 'ALL', 'authenticated',
             'public.is_org_admin(organization_id)', 'public.is_org_admin(organization_id)')
        ) AS s(tbl, pol, cmd, roles, using_expr, check_expr)
    LOOP
        v_ddl := format('ON public.%I FOR %s TO %s', v_spec.tbl, v_spec.cmd, v_spec.roles)
              -- `||`, not format(): format('%s', NULL) is '' and would emit `USING ()`.
              || COALESCE(' USING (' || v_spec.using_expr || ')', '')
              || COALESCE(' WITH CHECK (' || v_spec.check_expr || ')', '');

        SELECT permissive, cmd, roles, qual, with_check INTO v_have
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_spec.tbl AND policyname = v_spec.pol;

        IF NOT FOUND THEN
            EXECUTE format('CREATE POLICY %I ', v_spec.pol) || v_ddl;
            v_created := v_created || (v_spec.tbl || ': ' || v_spec.pol);
            CONTINUE;
        END IF;

        -- Same name already there: it must mean the same thing. Build the
        -- spec under a probe name, let Postgres deparse both, compare, drop.
        EXECUTE format('CREATE POLICY %I ', '__reconcile_prod_rls_drift_probe') || v_ddl;
        SELECT permissive, cmd, roles, qual, with_check INTO v_probe
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_spec.tbl
           AND policyname = '__reconcile_prod_rls_drift_probe';
        EXECUTE format('DROP POLICY %I ON public.%I', '__reconcile_prod_rls_drift_probe', v_spec.tbl);
        IF v_have IS DISTINCT FROM v_probe THEN
            RAISE EXCEPTION
                'reconcile_prod_rls_drift: public.% already has "%" but it differs from the repo definition (have: %, repo: %); refusing to call it reconciled',
                v_spec.tbl, v_spec.pol, v_have, v_probe;
        END IF;
        v_verified := v_verified || (v_spec.tbl || ': ' || v_spec.pol);
    END LOOP;

    -- 2. The dashboard-only broad member-write policy, wherever it exists.
    --    Found on a table the drift report did not name, it may be that
    --    table's only read path and nothing above replaces it -- so refuse
    --    rather than silently cut members off there.
    FOR v_pol IN
        SELECT schemaname, tablename
          FROM pg_policies
         WHERE policyname = 'Enforce Org Membership: ALL'
           AND NOT (schemaname = 'public' AND tablename = ANY (c_broad_tables))
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: "Enforce Org Membership: ALL" is on %.%, which the drift report did not name and this migration restores no read policy for; refusing to drop it blind',
            v_pol.schemaname, v_pol.tablename;
    END LOOP;
    FOR v_pol IN
        SELECT schemaname, tablename, policyname
          FROM pg_policies
         WHERE policyname = 'Enforce Org Membership: ALL'
         ORDER BY schemaname, tablename
    LOOP
        EXECUTE format('DROP POLICY %I ON %I.%I', v_pol.policyname, v_pol.schemaname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 3. The repo's own member-write hole, under its older name (header).
    FOR v_pol IN
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = ANY (c_member_write_tables)
           AND policyname = 'org_member_access'
         ORDER BY tablename
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_pol.policyname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 4. Enforced, not declared: the end state is checked before commit,
    --    across EVERY table in `public` rather than a list. A write policy
    --    with any clause lacking an admin gate aborts here unless the
    --    allowlist names it -- so a member-write policy nobody reported fails
    --    loudly instead of surviving under a "reconciled" notice. Text-level;
    --    see the header for what the smoke adds.
    FOR v_pol IN
        SELECT p.tablename, p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.cmd <> 'SELECT'
           AND ((p.qual IS NOT NULL AND p.qual !~ '(is_org_admin\(|''admin''::text)')
             OR (p.with_check IS NOT NULL AND p.with_check !~ '(is_org_admin\(|''admin''::text)'))
           AND NOT EXISTS (SELECT 1 FROM public.rls_member_write_allowlist() a
                            WHERE a.tablename = p.tablename AND a.policyname = p.policyname)
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: public.% still has write policy "%" that is not admin-gated; refusing to call it reconciled',
            v_pol.tablename, v_pol.policyname;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Enforce Org Membership: ALL') THEN
        RAISE EXCEPTION 'reconcile_prod_rls_drift: "Enforce Org Membership: ALL" survived its own drop';
    END IF;

    RETURN jsonb_build_object(
        'created', to_jsonb(v_created),
        'verified', to_jsonb(v_verified),
        'dropped', to_jsonb(v_dropped)
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public.reconcile_prod_rls_drift() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_prod_rls_drift() FROM anon, authenticated;

COMMENT ON FUNCTION public.reconcile_prod_rls_drift() IS
    'Idempotent: creates the repo''s member/admin policies on the tables of migration 20260928000000 where missing (aborting on a same-named mismatch), drops "Enforce Org Membership: ALL" and "org_member_access" on practice_slots/field_subunits/scheduler_runs, then refuses any non-allowlisted non-admin write policy in public. Owner-only.';

DO $$
DECLARE
    v_result jsonb := public.reconcile_prod_rls_drift();
BEGIN
    RAISE NOTICE 'reconcile_prod_rls_drift: created %, verified %, dropped %',
        jsonb_array_length(v_result->'created'),
        jsonb_array_length(v_result->'verified'),
        jsonb_array_length(v_result->'dropped');
    RAISE NOTICE 'reconcile_prod_rls_drift detail: %', v_result;
END;
$$;

COMMIT;
