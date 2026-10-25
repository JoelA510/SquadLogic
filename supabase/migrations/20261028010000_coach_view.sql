-- The coach view (plan docs/changes/2026-10-22-admin-focus.md, R6; owner
-- decisions 2026-10-22, decision 4).
--
-- **Why.** SquadLogic is an admin tool; a coach sees their own schedule, the
-- teams and coaches in their divisions (names only), and keeps their practice
-- preferences. Scheduling is an admin's: a coach no longer holds
-- `MANAGE_SCHEDULE` in the app (`frontend/src/constants/permissions.js`), and
-- this migration takes away the server-side writes that matched it. Score
-- entry and standings are admin functions the league turns on in its
-- settings (off by default); lighting is admin-only, with no coach requests.
--
-- **Every write a coach could make to schedule rows** (read off a build at
-- 20261026010000: every `public` function `authenticated` may EXECUTE that
-- admits a non-admin, and every write policy, of which none admits one):
--   * `update_game_score` (a current coach of either team): replaced, below;
--   * `request_practice_lighting_override` (a coach of a team on the slot):
--     dropped, below;
--   * `withdraw_practice_lighting_override` (the requester while they coach
--     the slot): replaced, admins only, below;
--   * `request_coach_practice_preference` (the coach for their own record):
--     KEPT, decision 4 ("coach practice preferences stay");
--   * `rotate_calendar_token` (a current coach of the team) writes the team's
--     calendar feed token, not a schedule row: KEPT, the coach's calendar.
-- Every direct table write on `games`, `game_slots`, `practice_assignments`,
-- `practice_exceptions` and `scheduler_runs` already requires `is_org_admin`;
-- `game_assignments`, `practice_slots`, `practice_lighting_overrides` and the
-- field tables have no write policy at all. `persist_practice_schedule`,
-- `persist_game_schedule` and `enact_practice_recommendation` already refuse
-- a non-admin.
--
-- **The change.**
--   1. What changes for whom, counted in a NOTICE.
--   2. `update_game_score(uuid, uuid, smallint, smallint, jsonb)` replaced
--      from its latest body (20261021020000; 20261021040000 pinned its
--      TimeZone with ALTER FUNCTION) with the coach arm removed: an admin or
--      staff member (`is_org_admin`) only, 42501 for anyone else; and only
--      while `org_flag(org, 'score_entry', false)` is true, 55000 otherwise.
--      The service role skips both, as it skipped every caller check before.
--      `updated_at = timezone('utc', now())` becomes `now()` (the UTC idiom
--      guard, tests/utcNowIdiom.test.js; the column is a timestamptz). The
--      SET clauses are restated (CREATE OR REPLACE resets those set by ALTER
--      FUNCTION); CREATE OR REPLACE keeps the grants; the comment is restated.
--   3. `request_practice_lighting_override(uuid, date, date)` dropped: its
--      only caller was the coach's request view. An admin sets a window
--      directly (`admin_set_practice_lighting_override`) and still decides a
--      row requested before this migration. The table's comment, which
--      named it as a writer, is restated.
--   4. `withdraw_practice_lighting_override(uuid)` replaced from its only
--      body (20261003000000) with the requester arm removed: an admin only.
--   5. New reads, the coach's divisions: `division_teams_of(uuid, uuid)`
--      (internal; no client role may execute it), `get_my_division_teams(uuid)`
--      (the caller) and `admin_get_division_teams(uuid, uuid)` (an admin's
--      role preview, as `admin_get_coached_team_ids` is). Each team in a
--      division where the user currently coaches a team (`coached_team_ids_of`):
--      division id and name, team id and name, the names of its current
--      coaches (a live `team_coach_assignments` row on `team_local_today`,
--      lead first), and whether the user coaches it. No contact column, and
--      nothing outside those divisions.
--   6. An end-state check: the request RPC is gone, the two replaced bodies
--      name no coach arm (comments and string literals stripped: no coach
--      helper, no coach or assignment table, no test of the member's role,
--      no requester test), and no
--      result column of the new reads is named like an email, a phone, a
--      contact or a guardian (R4's catalogue rule, 20261025010000).
--
-- Every drop names its object, with no CASCADE.
--
-- **Kept.** The `practice_lighting_override.requested` audit action (old
-- audit rows reference it); the lighting read policy (admins and the slot's
-- coaches read); `caller_coaches_practice_slot`, which that policy calls.
-- `org_flag(uuid, text, boolean)` is the reader of `score_entry`. The
-- `standings` setting is read by the app only: standings are computed from
-- `games`, which every member reads, so hiding the page is presentation,
-- not authorization (declared).
--
-- Reversible: docs/sql/20261028010000_revert.sql restores every object as it
-- stood after 20261026010000. Smoke checks: docs/sql/20261028010000_smoke.sql.
-- pgTAP: supabase/tests/coach_view.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What changes, counted.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_coaches bigint;
    v_requested bigint;
    v_score_on bigint;
    v_scored bigint;
BEGIN
    SELECT count(*) INTO v_coaches FROM public.organization_members WHERE role = 'coach';
    SELECT count(*) INTO v_requested FROM public.practice_lighting_overrides WHERE status = 'requested';
    SELECT count(*) INTO v_score_on FROM public.organizations
     WHERE jsonb_typeof(feature_flags -> 'score_entry') = 'boolean'
       AND (feature_flags ->> 'score_entry')::boolean;
    SELECT count(*) INTO v_scored FROM public.games WHERE score_home IS NOT NULL OR score_away IS NOT NULL;
    RAISE NOTICE '% coach member(s) lose score entry and lighting requests; % lighting request(s) are left for an admin to decide; % organization(s) have score entry on, so every other organization''s admins enter no score until they turn it on (% game(s) hold a score, kept)',
        v_coaches, v_requested, v_score_on, v_scored;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. update_game_score: admins only, while score entry is on.
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
SET timezone = 'UTC'
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

    -- 20261028010000: score entry is an admin function (admins and staff,
    -- is_org_admin), and only while the league has turned it on: the
    -- `score_entry` setting, off unless set (owner decision 4; plan
    -- docs/changes/2026-10-22-admin-focus.md, R6). A coach scores nothing.
    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin enters scores'
            USING ERRCODE = '42501';
    END IF;

    -- The service role (a server-side job; no client holds it) skips the
    -- setting as it skips the role checks above.
    IF v_effective_role <> 'service_role'
       AND NOT public.org_flag(p_organization_id, 'score_entry', false) THEN
        RAISE EXCEPTION 'Score entry is off for organization %: an admin turns it on in Settings', p_organization_id
            USING ERRCODE = '55000';
    END IF;

    v_changed :=
        v_game.score_home IS DISTINCT FROM p_score_home
        OR v_game.score_away IS DISTINCT FROM p_score_away;

    IF v_changed THEN
        UPDATE public.games
           SET score_home = p_score_home,
               score_away = p_score_away,
               updated_at = now()
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
  'Org-scoped game score mutation: admins/staff only, while the organization''s score_entry setting is on (55000 when off); atomic audit logging. 20261021020000; admin-only behind the setting 20261028010000.';

-- ---------------------------------------------------------------------------
-- 3. No coach lighting requests.
-- ---------------------------------------------------------------------------

DROP FUNCTION public.request_practice_lighting_override(uuid, date, date);

COMMENT ON TABLE public.practice_lighting_overrides IS 'Portable-lighting windows on a practice slot (8.9 D14): an approved row exempts the slot''s dates in its window from the sunset judgement. Only org admins set, decide and withdraw (no coach requests since 20261028010000; a row requested before then stays for an admin to decide). Written only by admin_decide_practice_lighting_override, withdraw_practice_lighting_override and admin_set_practice_lighting_override. No free text.';

-- ---------------------------------------------------------------------------
-- 4. withdraw: an admin of the organisation only.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.withdraw_practice_lighting_override(
    p_override_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$

DECLARE
    v_uid uuid := auth.uid();
    v_row public.practice_lighting_overrides%ROWTYPE;
BEGIN
    IF p_override_id IS NULL THEN
        RAISE EXCEPTION 'p_override_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_row
      FROM public.practice_lighting_overrides
     WHERE id = p_override_id
       FOR UPDATE;

    -- 20261028010000: an organization admin only. Lighting is admin-only,
    -- with no coach requests (owner decision 4), so a coach who requested a
    -- row before then no longer ends it; an admin does.
    IF NOT FOUND OR v_uid IS NULL OR NOT public.is_org_admin(v_row.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin withdraws a lighting override'
            USING ERRCODE = '42501';
    END IF;
    IF v_row.status NOT IN ('requested', 'approved') THEN
        RAISE EXCEPTION 'lighting override % is already %; only a requested or approved row is withdrawn',
            p_override_id, v_row.status
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.practice_lighting_overrides
       SET status = 'withdrawn', withdrawn_by = v_uid, withdrawn_at = clock_timestamp()
     WHERE id = p_override_id;

    PERFORM public.record_audit_event(
        v_row.organization_id,
        'practice_lighting_override.withdrawn',
        'practice_lighting_override',
        p_override_id,
        jsonb_build_object(
            'practice_slot_id', v_row.practice_slot_id,
            'from', lower(v_row."window"), 'until', upper(v_row."window") - 1,
            'kind', v_row.kind, 'before_status', v_row.status, 'status', 'withdrawn',
            'requested_by', v_row.requested_by, 'by_requester', v_uid = v_row.requested_by
        )
    );

    RETURN jsonb_build_object(
        'id', p_override_id, 'status', 'withdrawn', 'before_status', v_row.status,
        'practice_slot_id', v_row.practice_slot_id
    );
END;
$$;

COMMENT ON FUNCTION public.withdraw_practice_lighting_override(uuid) IS
  'An org admin: withdraw a requested or approved lighting override. Audited as practice_lighting_override.withdrawn. 20261003000000; admins only 20261028010000.';

-- ---------------------------------------------------------------------------
-- 5. The coach's divisions: team names and coach names, no contacts.
-- ---------------------------------------------------------------------------

-- Internal: each team in a division where p_user_id currently coaches a team.
CREATE FUNCTION public.division_teams_of(p_organization_id uuid, p_user_id uuid)
RETURNS TABLE (
    division_id uuid,
    division_name text,
    team_id uuid,
    team_name text,
    coach_names text[],
    is_mine boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH mine AS MATERIALIZED (
        SELECT t.id, t.division_id
          FROM public.teams t
         WHERE t.organization_id = p_organization_id
           AND t.id IN (SELECT public.coached_team_ids_of(p_organization_id, p_user_id))
    ), peers AS MATERIALIZED (
        -- Today is worked out once per team, in its season's zone.
        SELECT t.id, t.name, t.division_id, public.team_local_today(t.id) AS today
          FROM public.teams t
         WHERE t.organization_id = p_organization_id
           AND t.division_id IN (SELECT m.division_id FROM mine m WHERE m.division_id IS NOT NULL)
    )
    SELECT p.division_id,
           d.name,
           p.id,
           p.name,
           COALESCE((SELECT array_agg(c.full_name ORDER BY (a.role = 'lead') DESC, c.full_name, c.id)
                       FROM public.team_coach_assignments a
                       JOIN public.coaches c ON c.id = a.coach_id
                      WHERE a.team_id = p.id
                        AND a.organization_id = p_organization_id
                        AND a.effective_from <= p.today
                        AND (a.effective_to IS NULL OR a.effective_to >= p.today)
                        AND c.full_name IS NOT NULL), '{}'::text[]),
           p.id IN (SELECT m.id FROM mine m)
      FROM peers p
      JOIN public.divisions d ON d.id = p.division_id AND d.organization_id = p_organization_id
     ORDER BY d.name, p.name, p.id;
$$;

CREATE FUNCTION public.get_my_division_teams(p_organization_id uuid)
RETURNS TABLE (
    division_id uuid,
    division_name text,
    team_id uuid,
    team_name text,
    coach_names text[],
    is_mine boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'get_my_division_teams requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT * FROM public.division_teams_of(p_organization_id, auth.uid()) t
                  ORDER BY t.division_name, t.team_name, t.team_id;
END;
$$;

-- An admin's role preview shows a coach's home as that coach sees it, while
-- the session (auth.uid()) stays the admin's.
CREATE FUNCTION public.admin_get_division_teams(p_organization_id uuid, p_user_id uuid)
RETURNS TABLE (
    division_id uuid,
    division_name text,
    team_id uuid,
    team_name text,
    coach_names text[],
    is_mine boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'admin_get_division_teams requires an organization admin' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT * FROM public.division_teams_of(p_organization_id, p_user_id) t
                  ORDER BY t.division_name, t.team_name, t.team_id;
END;
$$;

REVOKE ALL ON FUNCTION public.division_teams_of(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_division_teams(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_get_division_teams(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_division_teams(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_division_teams(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.division_teams_of(uuid, uuid) IS
    'Internal: each team in a division where the user currently coaches a team, with its current coaches'' names; no contacts. 20261028010000.';
COMMENT ON FUNCTION public.get_my_division_teams(uuid) IS
    'The teams in the caller''s divisions (where they currently coach a team): division, team, current coaches'' names, and whether the caller coaches it. No contact details. 20261028010000.';
COMMENT ON FUNCTION public.admin_get_division_teams(uuid, uuid) IS
    'An org admin''s role preview of get_my_division_teams for another member. 20261028010000.';

-- ---------------------------------------------------------------------------
-- 6. End-state check.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_left text;
BEGIN
    IF to_regprocedure('public.request_practice_lighting_override(uuid, date, date)') IS NOT NULL THEN
        RAISE EXCEPTION 'the coach lighting request is still callable';
    END IF;

    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_left
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.oid IN ('public.update_game_score(uuid, uuid, smallint, smallint, jsonb)'::regprocedure,
                     'public.withdraw_practice_lighting_override(uuid)'::regprocedure)
       AND regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
           ~ '(\m(is_current_team_coach|is_current_org_coach|caller_coaches_practice_slot|coached_team_ids_of|team_coach_assignments|coaches)\M|\mv_member_role\s*(=|<>|!=|\mIN\M)|\mrequested_by\s*=)';
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'these still admit a coach: %', v_left;
    END IF;

    SELECT string_agg(format('%s.%s', p.proname, a.name), ', ' ORDER BY p.proname, a.name) INTO v_left
      FROM pg_proc p
     CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) AS a(name, mode)
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('division_teams_of', 'get_my_division_teams', 'admin_get_division_teams')
       AND a.mode = 't'
       AND a.name ~* '(e_?mail|phone|contact|guardian)';
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'a division read returns a contact column: %', v_left;
    END IF;

    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('get_my_division_teams', 'admin_get_division_teams')
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
           AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) <> 2
       OR has_function_privilege('authenticated', 'public.division_teams_of(uuid, uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the division reads are not granted as declared';
    END IF;
END;
$$;

COMMIT;
