-- Rewrite the RLS policies Supabase's performance advisors flag, changing no
-- access. docs/PLAN_RLS_ADVISOR_REWRITE.md (approved 2026-10-18, every
-- recommendation as written).
--
-- **Why.** Two lints were waived as debt to 2027-01-11 in
-- docs/security/supabase-advisor-waivers.json (plan item M3.3), after which the
-- required pgTAP job fails every pull request:
--   * `auth_rls_initplan` (11 policies): a policy calling `auth.uid()` directly
--     evaluates it once per row; `(select auth.uid())` is an InitPlan,
--     evaluated once per statement, with the same value.
--   * `multiple_permissive_policies` (20 tables): a member SELECT policy beside
--     an admin `FOR ALL` policy, both permissive for `authenticated`, so every
--     SELECT evaluates two policies where one decides.
-- Production has almost no rows; this is the advisors' cost, not a measured one.
--
-- **What changes, in one transaction:**
--   1. The eight policies whose names stay (I1, I3-I6, I8, I10, I11) get every
--      `auth.uid()` wrapped as `(select auth.uid())`, through ALTER POLICY,
--      and nothing else.
--   2. "Users can view their organization's import jobs" (I2) is dropped: it
--      admits exactly what "Import Jobs: members access" admits
--      (`organization_id IN (SELECT organization_id FROM organization_members
--      WHERE profile_id = auth.uid())` is is_org_member(organization_id) as a
--      subquery, and false for anon, whose auth.uid() is null). Plan Q2.
--   3. Each admin `FOR ALL` policy on the 19 other tables (M1-M19) is replaced
--      by INSERT, UPDATE and DELETE policies carrying its exact expression, in
--      USING and WITH CHECK as the command takes them (plan Q1). Where the ALL
--      policy had no WITH CHECK (registration_forms, season_settings),
--      Postgres used its USING as the check, so the same expression in both
--      places changes nothing. SELECT is then decided by the member policy
--      alone, which admitted every row the admin policy did: an admin of an
--      organization is always a member of it (is_org_admin and the inline
--      `om.role = 'admin'` test both need the caller's organization_members
--      row for that organization, which is is_org_member's test).
--   4. public.reconcile_prod_rls_drift() (20260928000000) is replaced with the
--      new spec: the three scheduler_runs admin policies instead of
--      scheduler_runs_write_admin, and I2 gone. Otherwise re-running it, the
--      documented repair if production drifts again, would re-create both and
--      two of the findings with them (plan section 2, Q3). The body is
--      otherwise 20260928000000's, unchanged.
--   5. A closing check on the catalogue, of what the two lints test: no policy
--      in `public` calls an auth function outside `(select ...)`, and no table,
--      role and command in `public` has more than one permissive policy. Either
--      aborts the migration.
--
-- **Kept exactly, on purpose** (plan Q5): registration_forms and
-- season_settings writes test `om.role = 'admin'`, narrower than is_org_admin
-- (which admits tenant_admin). They are not moved onto is_org_admin; that would
-- be an access change hidden in a performance fix.
--
-- **The proof** is supabase/tests/rls_policy_matrix.sql, landed before this
-- migration and green against the policies it replaces: seven personas' SELECT,
-- INSERT, UPDATE and DELETE on all 26 tables. It passes unchanged after this
-- migration. Policies on `public`: 82 before, 119 after.
--
-- **Production must match the build.** Every DROP and ALTER names its policy
-- without IF EXISTS, on purpose: production's 82 `public` policies hashed
-- identical to a fresh build's on 2026-10-18 (remediation plan), and if they
-- have drifted since, applying this half-blind would be worse than not
-- applying it. A missing policy raises 42704 and the whole migration rolls
-- back (one transaction), so CI's deploy fails and production is unchanged;
-- the drift is then found by the same digest and fixed by its own migration
-- before this one is retried.
--
-- Revert: docs/sql/20261018030000_revert.sql. Smoke: docs/sql/20261018030000_smoke.sql.

BEGIN;

-- ── 1. Wrap auth.uid() (the names stay) ───────────────────────────────────

-- I1. 20260331000000_definitive_schema.sql:1192
ALTER POLICY "Audit Log: admins view" ON public.audit_log
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = audit_log.organization_id
              AND om.role = 'admin'
        )
    );

-- I3. 20260405120000_phase_5_fluid_schemas.sql:164 (no TO clause: PUBLIC)
ALTER POLICY "Schema History: Admins Only" ON public.organization_schema_history
    USING (
        EXISTS (
            SELECT 1 FROM public.organization_members
            WHERE organization_id = public.organization_schema_history.organization_id
            AND profile_id = (select auth.uid())
            AND role = 'admin'
        )
    );

-- I4. 20260331000000_definitive_schema.sql:1031
ALTER POLICY "Profile Players: users view own" ON public.profile_players
    USING (profile_id = (select auth.uid()) OR is_org_member(organization_id));

-- I5. 20260331000000_definitive_schema.sql:962 (no WITH CHECK, as before)
ALTER POLICY "Profiles: users update own" ON public.profiles
    USING ((select auth.uid()) = id);

-- I6. 20260331000000_definitive_schema.sql:958
ALTER POLICY "Profiles: users view own" ON public.profiles
    USING ((select auth.uid()) = id);

-- I8. 20260602010000_consolidated_rls_security_hardening.sql:261
ALTER POLICY "registrations_user_own_or_admin" ON public.registrations
    USING (
        (profile_id = (select auth.uid()) AND public.is_org_member(organization_id))
        OR public.is_org_admin(organization_id)
    )
    WITH CHECK (
        (profile_id = (select auth.uid()) AND public.is_org_member(organization_id))
        OR public.is_org_admin(organization_id)
    );

-- I10. 20260404100000_phase_2_setup_wizard.sql:70
ALTER POLICY "Insert telemetry for own organization" ON public.telemetry_log
    WITH CHECK (
        org_id IN (
            SELECT organization_id
            FROM public.organization_members
            WHERE profile_id = (select auth.uid())
        )
    );

-- I11. 20260404100000_phase_2_setup_wizard.sql:83
ALTER POLICY "View telemetry for own organization" ON public.telemetry_log
    USING (
        org_id IN (
            SELECT organization_id
            FROM public.organization_members
            WHERE profile_id = (select auth.uid())
              AND role IN ('admin', 'tenant_admin')
        )
    );

-- ── 2. The redundant legacy import_jobs SELECT (I2, M20) ──────────────────
-- 20260404120000_phase_4_observability.sql:42
DROP POLICY "Users can view their organization's import jobs" ON public.import_jobs;

-- ── 3. Each admin FOR ALL policy, split by command (M1-M19) ───────────────

-- M1-M14. 20260602010000_consolidated_rls_security_hardening.sql:54 (thirteen
-- tables) and 20260928000000_reconcile_prod_rls_drift.sql:204
-- (scheduler_runs): `<t>_write_admin`, FOR ALL TO authenticated,
-- USING and WITH CHECK public.is_org_admin(organization_id).
DO $split$
DECLARE
    t text;
    -- Stated, not read back from the catalogue this block rewrites.
    c_tables text[] := ARRAY[
        'email_log', 'evaluation_findings', 'evaluation_metrics', 'evaluation_run_events',
        'evaluation_runs', 'export_jobs', 'game_slots', 'games', 'player_buddies', 'players',
        'practice_assignments', 'scheduler_runs', 'staging_players', 'team_players'
    ];
BEGIN
    FOREACH t IN ARRAY c_tables LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', t || '_write_admin', t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated '
            'WITH CHECK (public.is_org_admin(organization_id))',
            t || '_insert_admin', t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
            'USING (public.is_org_admin(organization_id)) '
            'WITH CHECK (public.is_org_admin(organization_id))',
            t || '_update_admin', t);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated '
            'USING (public.is_org_admin(organization_id))',
            t || '_delete_admin', t);
    END LOOP;
END
$split$;

-- M15. 20260929000000_practice_writer_v3_lock_by_default.sql:167
DROP POLICY "Practice exceptions: admins write" ON public.practice_exceptions;
CREATE POLICY "Practice exceptions: admins insert"
    ON public.practice_exceptions FOR INSERT TO authenticated
    WITH CHECK (public.is_org_admin(organization_id));
CREATE POLICY "Practice exceptions: admins update"
    ON public.practice_exceptions FOR UPDATE TO authenticated
    USING (public.is_org_admin(organization_id))
    WITH CHECK (public.is_org_admin(organization_id));
CREATE POLICY "Practice exceptions: admins delete"
    ON public.practice_exceptions FOR DELETE TO authenticated
    USING (public.is_org_admin(organization_id));

-- M16. 20260421025831_drop_recursive_org_members_policy.sql:67
DROP POLICY "Org Members: admins manage" ON public.organization_members;
CREATE POLICY "Org Members: admins insert"
    ON public.organization_members FOR INSERT TO authenticated
    WITH CHECK (public.is_org_admin(organization_id));
CREATE POLICY "Org Members: admins update"
    ON public.organization_members FOR UPDATE TO authenticated
    USING (public.is_org_admin(organization_id))
    WITH CHECK (public.is_org_admin(organization_id));
CREATE POLICY "Org Members: admins delete"
    ON public.organization_members FOR DELETE TO authenticated
    USING (public.is_org_admin(organization_id));

-- M17. 20260726000100_fix_organizations_write_policy.sql:40
DROP POLICY "Organizations: admins manage" ON public.organizations;
CREATE POLICY "Organizations: admins insert"
    ON public.organizations FOR INSERT TO authenticated
    WITH CHECK (is_org_admin(id));
CREATE POLICY "Organizations: admins update"
    ON public.organizations FOR UPDATE TO authenticated
    USING (is_org_admin(id))
    WITH CHECK (is_org_admin(id));
CREATE POLICY "Organizations: admins delete"
    ON public.organizations FOR DELETE TO authenticated
    USING (is_org_admin(id));

-- M18 (and I7). 20260416000000_security_hardening.sql:102, FOR ALL with no
-- WITH CHECK: its USING was also its check. `om.role = 'admin'`, kept (Q5).
DROP POLICY "registration_forms_admin_manage" ON public.registration_forms;
CREATE POLICY "registration_forms_admin_insert"
    ON public.registration_forms FOR INSERT TO authenticated
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    );
CREATE POLICY "registration_forms_admin_update"
    ON public.registration_forms FOR UPDATE TO authenticated
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    )
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    );
CREATE POLICY "registration_forms_admin_delete"
    ON public.registration_forms FOR DELETE TO authenticated
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = registration_forms.organization_id
              AND om.role = 'admin'
        )
    );

-- M19 (and I9). 20260331000000_definitive_schema.sql:988, FOR ALL with no
-- WITH CHECK, as M18. `om.role = 'admin'`, kept (Q5).
DROP POLICY "Season Settings: admins manage" ON public.season_settings;
CREATE POLICY "Season Settings: admins insert"
    ON public.season_settings FOR INSERT TO authenticated
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    );
CREATE POLICY "Season Settings: admins update"
    ON public.season_settings FOR UPDATE TO authenticated
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    )
    WITH CHECK (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    );
CREATE POLICY "Season Settings: admins delete"
    ON public.season_settings FOR DELETE TO authenticated
    USING (
        is_org_member(organization_id) AND
        EXISTS (
            SELECT 1 FROM public.organization_members om
            WHERE om.profile_id = (select auth.uid())
              AND om.organization_id = season_settings.organization_id
              AND om.role = 'admin'
        )
    );

-- ── 4. reconcile_prod_rls_drift(), on the new spec ────────────────────────
-- 20260928000000_reconcile_prod_rls_drift.sql's function, with its changes
-- marked CHANGED below: the legacy import_jobs SELECT is no longer a repo
-- policy, scheduler_runs' admin write is three policies, and both replaced
-- policies are dropped where they are still present (step 3b). Everything
-- else, including the end-state check, is that migration's text.
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
            -- CHANGED (20261018030000): "Users can view their organization's
            -- import jobs" (20260404120000_phase_4_observability.sql:42) is no
            -- longer a repo policy; it repeated the member SELECT above.
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
            -- NEW in 20260928000000 (the repo had no member SELECT on
            -- scheduler_runs): the sibling split of
            -- 20260602010000_consolidated_rls_security_hardening.sql:48-57,
            -- same names and clauses. The admin write keeps the SECURITY
            -- INVOKER persist_practice_schedule working for admins.
            ('scheduler_runs', 'scheduler_runs_select_member', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- CHANGED (20261018030000): scheduler_runs_write_admin (FOR ALL)
            -- is split by command, with the same expression.
            ('scheduler_runs', 'scheduler_runs_insert_admin', 'INSERT', 'authenticated',
             NULL, 'public.is_org_admin(organization_id)'),
            ('scheduler_runs', 'scheduler_runs_update_admin', 'UPDATE', 'authenticated',
             'public.is_org_admin(organization_id)', 'public.is_org_admin(organization_id)'),
            ('scheduler_runs', 'scheduler_runs_delete_admin', 'DELETE', 'authenticated',
             'public.is_org_admin(organization_id)', NULL)
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

    -- 3b. CHANGED (20261018030000): the repo policies this spec replaced, where
    --     they are still present -- scheduler_runs_write_admin (now split by
    --     command, created above if missing) and the legacy import_jobs
    --     SELECT (it repeats "Import Jobs: members access", ensured above).
    --     Left beside their replacements they are the advisors' findings
    --     again, under a "reconciled" notice.
    FOR v_pol IN
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND ((tablename = 'scheduler_runs' AND policyname = 'scheduler_runs_write_admin')
             OR (tablename = 'import_jobs' AND policyname = 'Users can view their organization''s import jobs'))
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
    --    see 20260928000000_reconcile_prod_rls_drift.sql's header for what
    --    its smoke adds.
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
    'Idempotent: creates the repo''s member/admin policies on the tables of migration 20260928000000 where missing (aborting on a same-named mismatch), drops "Enforce Org Membership: ALL" and "org_member_access" on practice_slots/field_subunits/scheduler_runs, then refuses any non-allowlisted non-admin write policy in public. Spec as of 20261018030000 (scheduler_runs admin write split by command; the legacy import_jobs SELECT gone; both dropped where still present). Owner-only.';

-- ── 5. What the advisors check, checked on the catalogue before commit ────
DO $assert$
DECLARE
    v_bad text;
BEGIN
    -- auth_rls_initplan: an auth function or current_setting() called
    -- directly, per row. A call that opens its own SELECT is the InitPlan
    -- form: Postgres deparses `(select auth.uid())` as
    -- `( SELECT auth.uid() AS uid)` and `(select auth.jwt() ->> 'role')` as
    -- `( SELECT (auth.jwt() ->> 'role'::text))`. Those calls are removed
    -- first; any call left is evaluated per row, including one in the WHERE
    -- of a correlated subquery, which is what the advisor flagged on I1.
    SELECT string_agg(format('%s: "%s"', tablename, policyname), ', ' ORDER BY tablename, policyname)
      INTO v_bad
      FROM pg_policies
     WHERE schemaname = 'public'
       AND regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                          'SELECT \(*(auth\.(uid|jwt|role|email)\(\)|current_setting\()', 'SELECT ', 'g')
           ~ '(auth\.(uid|jwt|role|email)\(\)|current_setting\()';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'rls advisor rewrite: policies still call an auth function per row: %', v_bad;
    END IF;

    -- multiple_permissive_policies: more than one permissive policy for one
    -- table, role and command. FOR ALL counts for every command, and a policy
    -- for PUBLIC counts for every role RLS applies to, less the Supabase admin
    -- roles, which the advisor leaves out too.
    SELECT string_agg(format('%s %s %s (%s)', tbl, rol, act, n), ', ' ORDER BY tbl, rol, act)
      INTO v_bad
      FROM (
        SELECT c.relname AS tbl, r.rolname AS rol, a.act, count(*) AS n
          FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
          JOIN pg_namespace ns ON ns.oid = c.relnamespace
          JOIN pg_roles r ON (p.polroles = ARRAY[0::oid] OR r.oid = ANY (p.polroles))
                         AND NOT r.rolsuper AND NOT r.rolbypassrls
                         AND r.rolname !~ '^pg_' AND r.rolname !~ '^supabase.*admin$'
          CROSS JOIN (VALUES ('r', 'SELECT'), ('a', 'INSERT'), ('w', 'UPDATE'), ('d', 'DELETE')) AS a(cmd, act)
         WHERE ns.nspname = 'public' AND p.polpermissive AND p.polcmd IN (a.cmd, '*')
         GROUP BY 1, 2, 3
        HAVING count(*) > 1
      ) dup;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'rls advisor rewrite: more than one permissive policy for: %', v_bad;
    END IF;

    RAISE NOTICE 'rls advisor rewrite: no public policy calls an auth function per row; no public table, role and command has two permissive policies; % policies on public',
        (SELECT count(*) FROM pg_policies WHERE schemaname = 'public');
END
$assert$;

COMMIT;
