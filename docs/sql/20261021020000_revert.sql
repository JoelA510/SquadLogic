-- Revert for 20261021020000_restrict_people_reads.sql
--
-- Restores what production had before (read 2026-10-21):
--   * the member-wide SELECT policies on players, team_players, coaches,
--     team_coach_assignments, profile_players, staging_players and
--     staging_import_rows, by their old names and expressions;
--   * teams.calendar_token (NOT NULL, unique, default gen_random_uuid()) and
--     teams.calendar_token_expires_at, filled from team_calendar_tokens, so
--     every subscribed calendar keeps working; then drops the table, its
--     trigger and the trigger function;
--   * rotate_calendar_token, update_game_score and reconcile_prod_rls_drift
--     with their pre-change bodies. rotate_calendar_token is production's
--     own definition (pg_get_functiondef, read 2026-10-21), which differs in
--     text from 20260324000002 (no comments); the other two are
--     20260504010000 and 20261018030000.
--
-- What it loses: `team_calendar_tokens.rotated_at`. Nothing else is kept only
-- in the new table.
--
-- Verified: the harness checks the policies, the columns and both function
-- bodies (md5 of pg_get_functiondef) against the pre-change catalogue.

BEGIN;

DROP POLICY IF EXISTS players_select_admin_or_guardian ON public.players;
CREATE POLICY players_select_member ON public.players
    FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS team_players_select_admin_or_guardian ON public.team_players;
CREATE POLICY team_players_select_member ON public.team_players
    FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS coaches_select_admin_or_self ON public.coaches;
CREATE POLICY "Coaches: members access" ON public.coaches
    FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS team_coach_assignments_select_admin_or_self ON public.team_coach_assignments;
CREATE POLICY "Team coach assignments: members read" ON public.team_coach_assignments
    FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS profile_players_select_own_or_admin ON public.profile_players;
CREATE POLICY "Profile Players: users view own" ON public.profile_players
    FOR SELECT TO authenticated
    USING (profile_id = (SELECT auth.uid()) OR public.is_org_member(organization_id));

DROP POLICY IF EXISTS staging_players_select_admin ON public.staging_players;
CREATE POLICY staging_players_select_member ON public.staging_players
    FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS staging_import_rows_select_admin ON public.staging_import_rows;
CREATE POLICY "Staging Import Rows: members can view" ON public.staging_import_rows
    FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

ALTER TABLE public.teams
    ADD COLUMN calendar_token uuid,
    ADD COLUMN calendar_token_expires_at timestamptz;
UPDATE public.teams t
   SET calendar_token = c.token, calendar_token_expires_at = c.expires_at
  FROM public.team_calendar_tokens c
 WHERE c.team_id = t.id;
UPDATE public.teams SET calendar_token = gen_random_uuid() WHERE calendar_token IS NULL;
UPDATE public.teams SET calendar_token_expires_at = now() + interval '90 days'
 WHERE calendar_token_expires_at IS NULL;
ALTER TABLE public.teams
    ALTER COLUMN calendar_token SET DEFAULT gen_random_uuid(),
    ALTER COLUMN calendar_token SET NOT NULL,
    ALTER COLUMN calendar_token_expires_at SET DEFAULT (now() + interval '90 days'),
    ALTER COLUMN calendar_token_expires_at SET NOT NULL,
    ADD CONSTRAINT teams_calendar_token_key UNIQUE (calendar_token);

DROP TRIGGER IF EXISTS teams_create_calendar_token ON public.teams;
DROP FUNCTION IF EXISTS public.create_team_calendar_token();
DROP TABLE IF EXISTS public.team_calendar_tokens;

CREATE OR REPLACE FUNCTION public.rotate_calendar_token(p_team_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_new_token uuid;
  v_org_id uuid;
begin
  select organization_id into v_org_id
  from teams where id = p_team_id;

  if v_org_id is null then
    return json_build_object('status', 'error', 'message', 'Team not found');
  end if;

  if not is_org_member(v_org_id) then
    return json_build_object('status', 'error', 'message', 'Access denied');
  end if;

  v_new_token := gen_random_uuid();

  update teams
  set calendar_token = v_new_token,
      calendar_token_expires_at = now() + interval '90 days',
      updated_at = now()
  where id = p_team_id;

  perform record_audit_event(
    v_org_id,
    'calendar.token_rotated',
    'team',
    p_team_id,
    json_build_object('new_expires_at', (now() + interval '90 days')::text)::jsonb
  );

  return json_build_object(
    'status', 'success',
    'calendar_token', v_new_token,
    'expires_at', (now() + interval '90 days')::text
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_game_score(
    p_organization_id uuid,
    p_game_id uuid,
    p_score_home smallint,
    p_score_away smallint,
    p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_game record;
    v_effective_role text := COALESCE(auth.role(), current_role, '');
    v_member_role text;
    v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
    v_changed boolean;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_game_id IS NULL THEN
        RAISE EXCEPTION 'p_game_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_score_home IS NOT NULL AND p_score_home < 0 THEN
        RAISE EXCEPTION 'p_score_home must be non-negative'
            USING ERRCODE = '23514';
    END IF;

    IF p_score_away IS NOT NULL AND p_score_away < 0 THEN
        RAISE EXCEPTION 'p_score_away must be non-negative'
            USING ERRCODE = '23514';
    END IF;

    IF jsonb_typeof(v_metadata) <> 'object' THEN
        RAISE EXCEPTION 'p_metadata must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF v_effective_role <> 'service_role' THEN
        IF auth.uid() IS NULL THEN
            RAISE EXCEPTION 'authenticated user is required'
                USING ERRCODE = '42501';
        END IF;

        SELECT om.role
          INTO v_member_role
          FROM public.organization_members om
         WHERE om.organization_id = p_organization_id
           AND om.profile_id = auth.uid();

        IF v_member_role IS NULL OR v_member_role NOT IN ('admin', 'tenant_admin', 'staff', 'coach') THEN
            RAISE EXCEPTION 'Access denied: caller cannot update scores for organization %', p_organization_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT g.id,
           g.organization_id,
           g.home_team_id,
           g.away_team_id,
           g.score_home,
           g.score_away,
           ht.organization_id AS home_team_org_id,
           at.organization_id AS away_team_org_id
      INTO v_game
      FROM public.games g
      JOIN public.teams ht
        ON ht.id = g.home_team_id
      JOIN public.teams at
        ON at.id = g.away_team_id
     WHERE g.id = p_game_id
       AND g.organization_id = p_organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Game not found in organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_game.home_team_org_id <> p_organization_id
       OR v_game.away_team_org_id <> p_organization_id THEN
        RAISE EXCEPTION 'Game teams must belong to the requested organization'
            USING ERRCODE = '42501';
    END IF;

    v_changed :=
        v_game.score_home IS DISTINCT FROM p_score_home
        OR v_game.score_away IS DISTINCT FROM p_score_away;

    IF v_changed THEN
        UPDATE public.games
           SET score_home = p_score_home,
               score_away = p_score_away,
               updated_at = timezone('utc', now())
         WHERE id = p_game_id
           AND organization_id = p_organization_id;

        PERFORM public.record_audit_event(
            p_organization_id,
            'competition.score_updated',
            'game',
            p_game_id,
            jsonb_build_object(
                'game_id', p_game_id,
                'home_team_id', v_game.home_team_id,
                'away_team_id', v_game.away_team_id,
                'previous_score_home', v_game.score_home,
                'previous_score_away', v_game.score_away,
                'score_home', p_score_home,
                'score_away', p_score_away
            ) || v_metadata
        );
    END IF;

    RETURN jsonb_build_object(
        'game_id', p_game_id,
        'organization_id', p_organization_id,
        'score_home', p_score_home,
        'score_away', p_score_away,
        'previous_score_home', v_game.score_home,
        'previous_score_away', v_game.score_away,
        'changed', v_changed
    );
END;
$$;

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

COMMENT ON FUNCTION public.update_game_score(uuid, uuid, smallint, smallint, jsonb) IS
  'Org-scoped game score mutation for schedule managers with atomic audit logging.';
COMMENT ON FUNCTION public.rotate_calendar_token(uuid) IS NULL;

COMMIT;
