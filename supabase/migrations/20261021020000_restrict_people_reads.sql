-- Who reads what, part two: the restriction (owner decisions 2026-10-20;
-- plan docs/changes/2026-10-20-phase-a-privacy.md, A3 and "A3 as built").
--
-- Part one (20261021010000) added the server-side reads and moved every
-- non-admin page onto them. This migration narrows the tables so those reads
-- are the only non-admin path:
--
-- **1. People tables.** SELECT, for a member who is not an admin or staff:
--   * players, team_players: only their own children (`profile_players`),
--     and only while they are a member of the child's organization (a link
--     outlives a removed membership);
--   * coaches: only their own row (`coaches.user_id`, linked by
--     link_my_coach_record); team_coach_assignments: only their own rows;
--     both, again, only while they are a member;
--   * profile_players: only their own links (it read every member's before);
--   * staging_players, staging_import_rows: nothing (raw import payloads were
--     readable by every member, found while building A1).
--   Admins and staff (is_org_admin) read everything in their organization,
--   as before. The write policies are unchanged. A policy reads the caller as
--   `(SELECT auth.uid())`, once per statement (20261018030000).
--
-- **2. Calendar token.** `teams.calendar_token` was readable by every member
-- through `teams`, so any member could subscribe to any team's feed. The token
-- and its expiry move to `team_calendar_tokens`, readable by admins and staff,
-- the team's current coaches and its guardians; every existing token and
-- expiry is copied, so no subscribed calendar breaks. A new team gets a token
-- from a trigger, as the column default gave it one. `rotate_calendar_token`
-- admits admins, staff and a current coach (it admitted any member), and keeps
-- its return shape and audit row. The calendar feed reads the new table.
--
-- `reconcile_prod_rls_drift()` names the coaches read policy in its spec; its
-- coaches row now names the new policy, so running it cannot bring the
-- member-wide read back.
--
-- **3. Scores.** `update_game_score` admitted any member with the coach role,
-- for any game. It now admits admins and staff for any game, and anyone else
-- only for a game of a team they currently coach. The body is the latest
-- definition (20260504010000) with only that check changed.
--
-- **4. End state.** The migration refuses to commit if any other SELECT or
-- ALL policy remains on a restricted table.
--
-- Revert: docs/sql/20261021020000_revert.sql. Smoke: docs/sql/20261021020000_smoke.sql.
-- pgTAP: supabase/tests/rls_policy_matrix.sql (rewritten), supabase/tests/restricted_reads.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. People tables
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS players_select_member ON public.players;
CREATE POLICY players_select_admin_or_guardian ON public.players
    FOR SELECT TO authenticated
    USING (
        public.is_org_admin(organization_id)
        OR (public.is_org_member(organization_id)
            AND id IN (SELECT pp.player_id FROM public.profile_players pp
                   WHERE pp.profile_id = (SELECT auth.uid())))
    );

DROP POLICY IF EXISTS team_players_select_member ON public.team_players;
CREATE POLICY team_players_select_admin_or_guardian ON public.team_players
    FOR SELECT TO authenticated
    USING (
        public.is_org_admin(organization_id)
        OR (public.is_org_member(organization_id)
            AND player_id IN (SELECT pp.player_id FROM public.profile_players pp
                          WHERE pp.profile_id = (SELECT auth.uid())))
    );

DROP POLICY IF EXISTS "Coaches: members access" ON public.coaches;
CREATE POLICY coaches_select_admin_or_self ON public.coaches
    FOR SELECT TO authenticated
    USING (
        public.is_org_admin(organization_id)
        OR (public.is_org_member(organization_id) AND user_id = (SELECT auth.uid()))
    );

-- The membership check below is also implied: the subquery reads `coaches`
-- under that table's own policy, which already requires it. It is stated so the
-- rule does not depend on the other policy; no smoke can tell the two apart.
DROP POLICY IF EXISTS "Team coach assignments: members read" ON public.team_coach_assignments;
CREATE POLICY team_coach_assignments_select_admin_or_self ON public.team_coach_assignments
    FOR SELECT TO authenticated
    USING (
        public.is_org_admin(organization_id)
        OR (public.is_org_member(organization_id)
            AND coach_id IN (SELECT c.id FROM public.coaches c
                              WHERE c.user_id = (SELECT auth.uid())))
    );

DROP POLICY IF EXISTS "Profile Players: users view own" ON public.profile_players;
CREATE POLICY profile_players_select_own_or_admin ON public.profile_players
    FOR SELECT TO authenticated
    USING (
        profile_id = (SELECT auth.uid())
        OR public.is_org_admin(organization_id)
    );

DROP POLICY IF EXISTS staging_players_select_member ON public.staging_players;
CREATE POLICY staging_players_select_admin ON public.staging_players
    FOR SELECT TO authenticated
    USING (public.is_org_admin(organization_id));

DROP POLICY IF EXISTS "Staging Import Rows: members can view" ON public.staging_import_rows;
CREATE POLICY staging_import_rows_select_admin ON public.staging_import_rows
    FOR SELECT TO authenticated
    USING (public.is_org_admin(organization_id));

-- ---------------------------------------------------------------------------
-- 2. Calendar token
-- ---------------------------------------------------------------------------

CREATE TABLE public.team_calendar_tokens (
    team_id     uuid PRIMARY KEY REFERENCES public.teams(id) ON DELETE CASCADE,
    token       uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    expires_at  timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
    rotated_at  timestamptz
);
COMMENT ON TABLE public.team_calendar_tokens IS
    'A team''s calendar feed credential, moved out of teams so only admins/staff, the team''s current coaches and its guardians read it. Written by the teams insert trigger and rotate_calendar_token only. 20261021020000.';

-- Production has calendar_token_expires_at (20260324000002, read 2026-10-21);
-- a fresh build from the migration files does not (that file has CRLF line
-- endings, and the column is absent after it). Added here when missing, so
-- the copy below reads the same column in both.
ALTER TABLE public.teams
    ADD COLUMN IF NOT EXISTS calendar_token_expires_at timestamptz NOT NULL
        DEFAULT (now() + interval '90 days');

INSERT INTO public.team_calendar_tokens (team_id, token, expires_at)
SELECT t.id, t.calendar_token, t.calendar_token_expires_at
  FROM public.teams t;

ALTER TABLE public.team_calendar_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_calendar_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.team_calendar_tokens TO authenticated;

CREATE POLICY team_calendar_tokens_select ON public.team_calendar_tokens
    FOR SELECT TO authenticated
    USING (
        public.is_org_admin((SELECT t.organization_id FROM public.teams t WHERE t.id = team_id))
        OR public.is_current_team_coach(team_id)
        OR public.is_team_guardian(team_id)
    );

CREATE OR REPLACE FUNCTION public.create_team_calendar_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.team_calendar_tokens (team_id) VALUES (NEW.id)
    ON CONFLICT (team_id) DO NOTHING;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.create_team_calendar_token() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER teams_create_calendar_token
    AFTER INSERT ON public.teams
    FOR EACH ROW EXECUTE FUNCTION public.create_team_calendar_token();

ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_calendar_token_key;
ALTER TABLE public.teams DROP COLUMN calendar_token, DROP COLUMN calendar_token_expires_at;

CREATE OR REPLACE FUNCTION public.rotate_calendar_token(p_team_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_token uuid := gen_random_uuid();
    v_org_id uuid;
    v_expires timestamptz := now() + interval '90 days';
BEGIN
    SELECT organization_id INTO v_org_id FROM public.teams WHERE id = p_team_id;

    -- An unknown team and a refused caller answer alike.
    IF v_org_id IS NULL
       OR NOT (public.is_org_admin(v_org_id) OR public.is_current_team_coach(p_team_id)) THEN
        RETURN json_build_object('status', 'error', 'message', 'Access denied');
    END IF;

    INSERT INTO public.team_calendar_tokens (team_id, token, expires_at, rotated_at)
    VALUES (p_team_id, v_new_token, v_expires, now())
    ON CONFLICT (team_id) DO UPDATE
       SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, rotated_at = EXCLUDED.rotated_at;

    PERFORM public.record_audit_event(
        v_org_id,
        'calendar.token_rotated',
        'team',
        p_team_id,
        jsonb_build_object('new_expires_at', v_expires::text)
    );

    RETURN json_build_object(
        'status', 'success',
        'calendar_token', v_new_token,
        'expires_at', v_expires::text
    );
END;
$$;
REVOKE ALL ON FUNCTION public.rotate_calendar_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_calendar_token(uuid) TO authenticated;
COMMENT ON FUNCTION public.rotate_calendar_token(uuid) IS
    'Rotates a team''s calendar feed token; admins/staff and the team''s current coaches only. Audited. 20261021020000.';

-- ---------------------------------------------------------------------------
-- 2b. reconcile_prod_rls_drift(): its spec named "Coaches: members access",
-- so running it would have re-created the member-wide read. The coaches row
-- now names the policy above; the rest is 20261018030000's text.
-- ---------------------------------------------------------------------------

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
            -- CHANGED (20261021020000): coaches are read by admins and staff,
            -- and a coach reads their own row; the member-wide policy is gone
            -- and must not come back from here.
            ('coaches', 'coaches_select_admin_or_self', 'SELECT', 'authenticated',
             'public.is_org_admin(organization_id) OR (public.is_org_member(organization_id) AND user_id = (SELECT auth.uid()))', NULL),
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

-- ---------------------------------------------------------------------------
-- 3. Scores
-- ---------------------------------------------------------------------------

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

        IF v_member_role IS NULL THEN
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

    -- 20261021020000: an admin or staff member scores any game; anyone else
    -- only a game of a team they currently coach (Phase A3, item 2).
    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_admin(p_organization_id)
       AND NOT public.is_current_team_coach(v_game.home_team_id)
       AND NOT public.is_current_team_coach(v_game.away_team_id) THEN
        RAISE EXCEPTION 'Access denied: only a current coach of either team can score this game'
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

COMMENT ON FUNCTION public.update_game_score(uuid, uuid, smallint, smallint, jsonb) IS
  'Org-scoped game score mutation: admins/staff for any game, a current coach of either team for that game; atomic audit logging. 20261021020000.';

-- ---------------------------------------------------------------------------
-- 4. Enforced, not declared: the policies above are each table's only read.
--    Postgres ORs permissive policies, so any other SELECT or ALL policy left
--    on these tables (production has carried dashboard-only ones before;
--    20261018030000) would keep the read member-wide. Production had none on
--    2026-10-21; this refuses the migration rather than assume so.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_extra text;
BEGIN
    SELECT string_agg(format('%s: "%s" (%s)', tablename, policyname, cmd), '; '
                      ORDER BY tablename, policyname)
      INTO v_extra
      FROM pg_policies
     WHERE schemaname = 'public'
       AND permissive = 'PERMISSIVE'
       AND cmd IN ('SELECT', 'ALL')
       AND tablename IN ('players', 'team_players', 'coaches', 'team_coach_assignments',
                         'profile_players', 'staging_players', 'staging_import_rows',
                         'team_calendar_tokens')
       AND (tablename, policyname) NOT IN (VALUES
            ('players'::name, 'players_select_admin_or_guardian'::name),
            ('team_players', 'team_players_select_admin_or_guardian'),
            ('coaches', 'coaches_select_admin_or_self'),
            ('team_coach_assignments', 'team_coach_assignments_select_admin_or_self'),
            ('profile_players', 'profile_players_select_own_or_admin'),
            ('staging_players', 'staging_players_select_admin'),
            ('staging_import_rows', 'staging_import_rows_select_admin'),
            ('team_calendar_tokens', 'team_calendar_tokens_select'));
    IF v_extra IS NOT NULL THEN
        RAISE EXCEPTION '20261021020000: another read policy is still on a restricted table, so the read stays wider than intended: %', v_extra;
    END IF;
END;
$$;

COMMIT;
