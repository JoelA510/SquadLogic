-- Revert for 20261018030000_rls_advisor_rewrite.sql
--
-- Puts back, exactly, the policies the rewrite replaced, so the two advisor
-- lints it fixed (`auth_rls_initplan`, `multiple_permissive_policies`) report
-- their 31 findings again. No access changes either way: the forward migration
-- changed none (supabase/tests/rls_policy_matrix.sql, green on both sides).
--
--   * The eight wrapped policies that kept their names get their unwrapped
--     expressions back, each the text of the migration cited beside it.
--   * The split INSERT, UPDATE and DELETE policies on the 19 tables are
--     dropped and each table's admin FOR ALL policy is re-created from its
--     source migration's text.
--   * "Users can view their organization's import jobs" is re-created
--     (20260404120000_phase_4_observability.sql:42, no TO clause: PUBLIC).
--   * public.reconcile_prod_rls_drift() is restored to
--     20260928000000_reconcile_prod_rls_drift.sql's text (copied verbatim),
--     whose spec names scheduler_runs_write_admin and the legacy import_jobs
--     policy again.
--
-- Earlier reverts that name these policies (20260726000100's, 20260928000000's)
-- apply only directly after their own migrations; after this one, apply this
-- revert first.
--
-- If this is applied, restore the two waivers in
-- docs/security/supabase-advisor-waivers.json with a new expiry in the same
-- change, or the required pgTAP job's advisors step fails on 31 unwaived
-- findings. CI is the only writer: apply this through a forward migration.
--
-- Verified: the closing block fails unless every original policy is back with
-- its command, no split policy is left, the eight policies call auth.uid()
-- directly again, and the reconcile spec names scheduler_runs_write_admin.

BEGIN;

-- ── 1. The unwrapped expressions ──────────────────────────────────────────

-- I1. 20260331000000_definitive_schema.sql:1192
ALTER POLICY "Audit Log: admins view" ON public.audit_log
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = auth.uid()
              AND om.organization_id = audit_log.organization_id
              AND om.role = 'admin'
        )
    );

-- I3. 20260405120000_phase_5_fluid_schemas.sql:164
ALTER POLICY "Schema History: Admins Only" ON public.organization_schema_history
    USING (
        EXISTS (
            SELECT 1 FROM public.organization_members
            WHERE organization_id = public.organization_schema_history.organization_id
            AND profile_id = auth.uid()
            AND role = 'admin'
        )
    );

-- I4. 20260331000000_definitive_schema.sql:1031
ALTER POLICY "Profile Players: users view own" ON public.profile_players
    USING (profile_id = auth.uid() OR is_org_member(organization_id));

-- I5. 20260331000000_definitive_schema.sql:962
ALTER POLICY "Profiles: users update own" ON public.profiles
    USING (auth.uid() = id);

-- I6. 20260331000000_definitive_schema.sql:958
ALTER POLICY "Profiles: users view own" ON public.profiles
    USING (auth.uid() = id);

-- I8. 20260602010000_consolidated_rls_security_hardening.sql:261
ALTER POLICY "registrations_user_own_or_admin" ON public.registrations
    USING (
        (profile_id = auth.uid() AND public.is_org_member(organization_id))
        OR public.is_org_admin(organization_id)
    )
    WITH CHECK (
        (profile_id = auth.uid() AND public.is_org_member(organization_id))
        OR public.is_org_admin(organization_id)
    );

-- I10. 20260404100000_phase_2_setup_wizard.sql:70
ALTER POLICY "Insert telemetry for own organization" ON public.telemetry_log
    WITH CHECK (
        org_id IN (
            SELECT organization_id
            FROM public.organization_members
            WHERE profile_id = auth.uid()
        )
    );

-- I11. 20260404100000_phase_2_setup_wizard.sql:83
ALTER POLICY "View telemetry for own organization" ON public.telemetry_log
    USING (
        org_id IN (
            SELECT organization_id
            FROM public.organization_members
            WHERE profile_id = auth.uid()
              AND role IN ('admin', 'tenant_admin')
        )
    );

-- ── 2. The legacy import_jobs SELECT ──────────────────────────────────────
-- 20260404120000_phase_4_observability.sql:42
CREATE POLICY "Users can view their organization's import jobs"
    ON public.import_jobs FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM public.organization_members
            WHERE profile_id = auth.uid()
        )
    );

-- ── 3. The admin FOR ALL policies ─────────────────────────────────────────

-- M1-M14. 20260602010000_consolidated_rls_security_hardening.sql:54 and
-- 20260928000000_reconcile_prod_rls_drift.sql:204 (scheduler_runs).
DO $unsplit$
DECLARE
    t text;
    c_tables text[] := ARRAY[
        'email_log', 'evaluation_findings', 'evaluation_metrics', 'evaluation_run_events',
        'evaluation_runs', 'export_jobs', 'game_slots', 'games', 'player_buddies', 'players',
        'practice_assignments', 'scheduler_runs', 'staging_players', 'team_players'
    ];
BEGIN
    FOREACH t IN ARRAY c_tables LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', t || '_insert_admin', t);
        EXECUTE format('DROP POLICY %I ON public.%I', t || '_update_admin', t);
        EXECUTE format('DROP POLICY %I ON public.%I', t || '_delete_admin', t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
            'USING (public.is_org_admin(organization_id)) '
            'WITH CHECK (public.is_org_admin(organization_id))',
            t || '_write_admin', t);
    END LOOP;
END
$unsplit$;

-- M15. 20260929000000_practice_writer_v3_lock_by_default.sql:167
DROP POLICY "Practice exceptions: admins insert" ON public.practice_exceptions;
DROP POLICY "Practice exceptions: admins update" ON public.practice_exceptions;
DROP POLICY "Practice exceptions: admins delete" ON public.practice_exceptions;
CREATE POLICY "Practice exceptions: admins write"
    ON public.practice_exceptions FOR ALL TO authenticated
    USING (public.is_org_admin(organization_id))
    WITH CHECK (public.is_org_admin(organization_id));

-- M16. 20260421025831_drop_recursive_org_members_policy.sql:67
DROP POLICY "Org Members: admins insert" ON public.organization_members;
DROP POLICY "Org Members: admins update" ON public.organization_members;
DROP POLICY "Org Members: admins delete" ON public.organization_members;
CREATE POLICY "Org Members: admins manage"
  ON public.organization_members FOR ALL
  TO authenticated
  USING (public.is_org_admin(organization_id))
  WITH CHECK (public.is_org_admin(organization_id));

-- M17. 20260726000100_fix_organizations_write_policy.sql:40
DROP POLICY "Organizations: admins insert" ON public.organizations;
DROP POLICY "Organizations: admins update" ON public.organizations;
DROP POLICY "Organizations: admins delete" ON public.organizations;
CREATE POLICY "Organizations: admins manage"
  ON public.organizations FOR ALL TO authenticated
  USING (is_org_admin(id))
  WITH CHECK (is_org_admin(id));

-- M18. 20260416000000_security_hardening.sql:102
DROP POLICY "registration_forms_admin_insert" ON public.registration_forms;
DROP POLICY "registration_forms_admin_update" ON public.registration_forms;
DROP POLICY "registration_forms_admin_delete" ON public.registration_forms;
CREATE POLICY "registration_forms_admin_manage" ON public.registration_forms
    FOR ALL TO authenticated
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = auth.uid()
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    );

-- M19. 20260331000000_definitive_schema.sql:988
DROP POLICY "Season Settings: admins insert" ON public.season_settings;
DROP POLICY "Season Settings: admins update" ON public.season_settings;
DROP POLICY "Season Settings: admins delete" ON public.season_settings;
CREATE POLICY "Season Settings: admins manage"
    ON public.season_settings FOR ALL TO authenticated
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = auth.uid()
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    );

-- ── 4. reconcile_prod_rls_drift(), as 20260928000000 wrote it ─────────────
-- Copied verbatim from 20260928000000_reconcile_prod_rls_drift.sql:118-311.
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

-- ── 5. Verified ───────────────────────────────────────────────────────────
DO $revert$
DECLARE
    v_missing text;
    v_left text;
    v_wrapped text;
BEGIN
    -- Every original policy, with its command. Stated, not read back.
    SELECT string_agg(format('%s: "%s" (%s)', e.tbl, e.pol, e.cmd), ', ')
      INTO v_missing
      FROM (VALUES
        ('email_log', 'email_log_write_admin', 'ALL'),
        ('evaluation_findings', 'evaluation_findings_write_admin', 'ALL'),
        ('evaluation_metrics', 'evaluation_metrics_write_admin', 'ALL'),
        ('evaluation_run_events', 'evaluation_run_events_write_admin', 'ALL'),
        ('evaluation_runs', 'evaluation_runs_write_admin', 'ALL'),
        ('export_jobs', 'export_jobs_write_admin', 'ALL'),
        ('game_slots', 'game_slots_write_admin', 'ALL'),
        ('games', 'games_write_admin', 'ALL'),
        ('player_buddies', 'player_buddies_write_admin', 'ALL'),
        ('players', 'players_write_admin', 'ALL'),
        ('practice_assignments', 'practice_assignments_write_admin', 'ALL'),
        ('scheduler_runs', 'scheduler_runs_write_admin', 'ALL'),
        ('staging_players', 'staging_players_write_admin', 'ALL'),
        ('team_players', 'team_players_write_admin', 'ALL'),
        ('practice_exceptions', 'Practice exceptions: admins write', 'ALL'),
        ('organization_members', 'Org Members: admins manage', 'ALL'),
        ('organizations', 'Organizations: admins manage', 'ALL'),
        ('registration_forms', 'registration_forms_admin_manage', 'ALL'),
        ('season_settings', 'Season Settings: admins manage', 'ALL'),
        ('import_jobs', 'Users can view their organization''s import jobs', 'SELECT')
      ) AS e(tbl, pol, cmd)
     WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                        WHERE p.schemaname = 'public' AND p.tablename = e.tbl
                          AND p.policyname = e.pol AND p.cmd = e.cmd);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'revert failed: not restored: %', v_missing;
    END IF;

    SELECT string_agg(format('%s: "%s"', tablename, policyname), ', ')
      INTO v_left
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (policyname ~ '_(insert|update|delete)_admin$'
            OR policyname ~ '^(Practice exceptions|Org Members|Organizations|Season Settings): admins (insert|update|delete)$')
       AND tablename IN ('email_log', 'evaluation_findings', 'evaluation_metrics', 'evaluation_run_events',
                         'evaluation_runs', 'export_jobs', 'game_slots', 'games', 'player_buddies', 'players',
                         'practice_assignments', 'scheduler_runs', 'staging_players', 'team_players',
                         'practice_exceptions', 'organization_members', 'organizations',
                         'registration_forms', 'season_settings');
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'revert failed: split policies survived: %', v_left;
    END IF;

    -- The eight policies that kept their names call auth.uid() directly again.
    SELECT string_agg(format('%s: "%s"', tablename, policyname), ', ')
      INTO v_wrapped
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (tablename, policyname) IN (
             ('audit_log', 'Audit Log: admins view'),
             ('organization_schema_history', 'Schema History: Admins Only'),
             ('profile_players', 'Profile Players: users view own'),
             ('profiles', 'Profiles: users update own'),
             ('profiles', 'Profiles: users view own'),
             ('registrations', 'registrations_user_own_or_admin'),
             ('telemetry_log', 'Insert telemetry for own organization'),
             ('telemetry_log', 'View telemetry for own organization'))
       AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%( SELECT auth.uid() AS uid)%';
    IF v_wrapped IS NOT NULL THEN
        RAISE EXCEPTION 'revert failed: still wrapped: %', v_wrapped;
    END IF;

    -- The body, by hash: md5 of the text between 20260928000000's $fn$
    -- quotes. (A search for a policy name would also match 20261018030000's
    -- body, which names scheduler_runs_write_admin to drop it.)
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.reconcile_prod_rls_drift()'::regprocedure)
       IS DISTINCT FROM 'c383b32caaa42f719e42b6593f7b766a' THEN
        RAISE EXCEPTION 'revert failed: reconcile_prod_rls_drift() is not 20260928000000''s body';
    END IF;

    RAISE NOTICE 'revert verified: the 20 original policies are back, no split policy is left, the wrapped policies are unwrapped, reconcile_prod_rls_drift() is 20260928000000''s; % policies on public',
        (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
END;
$revert$;

COMMIT;
