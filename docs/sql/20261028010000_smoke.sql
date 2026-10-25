-- Smoke checks for 20261028010000_coach_view.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * posture: `update_game_score` and `withdraw_practice_lighting_override`
--     are definers with their SET clauses, callable by `authenticated` and
--     not `anon`; `request_practice_lighting_override` is gone;
--     `division_teams_of` is callable by no client role; the two division
--     reads by `authenticated` only; no result column of the three is named
--     like an email, a phone, a contact or a guardian (the scan shown to fire
--     on a planted probe first);
--   * score entry, an admin function behind the league's setting: with the
--     setting absent, false, or not a boolean, an admin is refused 55000 and
--     nothing is written; with it on, an admin and a staff member score (one
--     audit row each); a current coach of the home team, a member who coaches
--     no team and another organization's admin are refused 42501;
--   * withdrawing a lighting override: its requester (still a coach of the
--     slot) is refused 42501; an admin withdraws it;
--   * the division read: a coach gets every team of each division they
--     coach in, with the current coaches' names (lead first; a lapsed coach
--     not named), whether they coach it, and nothing of another division or
--     of another organization; a member who
--     coaches no team, a lapsed coach and an admin who coaches nothing get
--     none; the preview read gives an admin the coach's set and refuses a
--     coach and another organization's admin (42501); a caller with no uid is
--     refused 42501.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.r6_contact_columns() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(format('%s.%s', p.proname, a.name), ', ' ORDER BY p.proname, a.name)
      FROM pg_proc p
     CROSS JOIN LATERAL unnest(p.proargnames, p.proargmodes) AS a(name, mode)
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname IN ('division_teams_of', 'get_my_division_teams', 'admin_get_division_teams')
            OR p.proname LIKE '\_\_r6\_%')
       AND a.mode = 't'
       AND a.name ~* '(e_?mail|phone|contact|guardian)'
$f$;

-- ---------------------------------------------------------------------------
-- 1. Posture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_left text;
BEGIN
    -- The scan must see a planted defect before its silence means anything.
    v_left := NULL;
    BEGIN
        CREATE FUNCTION public.__r6_probe() RETURNS TABLE (team_name text, coach_email text)
        LANGUAGE sql AS 'SELECT NULL::text, NULL::text';
        v_left := pg_temp.r6_contact_columns();
        RAISE EXCEPTION USING ERRCODE = 'P1028', MESSAGE = 'undo the planted probe';
    EXCEPTION WHEN SQLSTATE 'P1028' THEN NULL;
    END;
    IF v_left IS DISTINCT FROM '__r6_probe.coach_email' THEN
        RAISE EXCEPTION 'control: the contact-column scan did not see the planted probe (found: %)', v_left;
    END IF;
    v_left := pg_temp.r6_contact_columns();
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'a division read returns a contact column: %', v_left;
    END IF;

    IF to_regproc('public.request_practice_lighting_override') IS NOT NULL THEN
        RAISE EXCEPTION 'request_practice_lighting_override is back: no coach requests lighting';
    END IF;

    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('update_game_score', 'withdraw_practice_lighting_override',
                         'get_my_division_teams', 'admin_get_division_teams')
       AND NOT (p.prosecdef
                AND 'search_path=public' = ANY (p.proconfig)
                AND (p.proname <> 'update_game_score' OR 'TimeZone=UTC' = ANY (p.proconfig))
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'not a pinned definer callable by authenticated and not anon: %', v_left;
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('update_game_score', 'withdraw_practice_lighting_override',
                             'get_my_division_teams', 'admin_get_division_teams')) <> 4 THEN
        RAISE EXCEPTION 'expected exactly the 4 functions the posture check reads';
    END IF;
    IF has_function_privilege('authenticated', 'public.division_teams_of(uuid, uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.division_teams_of(uuid, uuid)', 'EXECUTE')
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.division_teams_of(uuid, uuid)'::regprocedure) THEN
        RAISE EXCEPTION 'division_teams_of is callable by a client role, or not a definer';
    END IF;
    RAISE NOTICE 'posture: the score and withdraw writers and the two division reads are pinned definers for authenticated, not anon; the internal read is no client''s; no request RPC; no contact column (the scan fired on a probe first)';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Score entry, withdraw, and the division read.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_staff uuid := gen_random_uuid();
    v_ua uuid := gen_random_uuid();
    v_ub uuid := gen_random_uuid();
    v_uc uuid := gen_random_uuid();
    v_ul uuid := gen_random_uuid();
    v_member uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();
    v_org uuid; v_other uuid;
    v_s uuid; v_s2 uuid; v_d1 uuid; v_d2 uuid; v_od uuid;
    v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_tx uuid;
    v_ca uuid; v_cb uuid; v_cc uuid; v_cl uuid;
    v_game uuid;
    v_loc uuid; v_field uuid; v_slot uuid; v_req uuid;
    v_refused int;
    v_res jsonb;
    v_got text;
    v_n int;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'r6-admin@example.test', '{"password_length": 16}'),
        (v_staff, 'r6-staff@example.test', '{"password_length": 16}'),
        (v_ua, 'r6-a@example.test', '{"password_length": 16}'),
        (v_ub, 'r6-b@example.test', '{"password_length": 16}'),
        (v_uc, 'r6-c@example.test', '{"password_length": 16}'),
        (v_ul, 'r6-lapsed@example.test', '{"password_length": 16}'),
        (v_member, 'r6-member@example.test', '{"password_length": 16}'),
        (v_outsider, 'r6-outsider@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'r6-admin@example.test'), (v_staff, 'r6-staff@example.test'),
        (v_ua, 'r6-a@example.test'), (v_ub, 'r6-b@example.test'), (v_uc, 'r6-c@example.test'),
        (v_ul, 'r6-lapsed@example.test'), (v_member, 'r6-member@example.test'),
        (v_outsider, 'r6-outsider@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('R6 Smoke Org', 'r6-smoke-org') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('R6 Smoke Other', 'r6-smoke-other') RETURNING id INTO v_other;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_staff, 'staff'),
        (v_org, v_ua, 'coach'), (v_org, v_ub, 'coach'), (v_org, v_uc, 'coach'),
        (v_org, v_ul, 'coach'), (v_org, v_member, 'coach'),
        (v_other, v_outsider, 'admin'), (v_other, v_ua, 'coach');
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status) VALUES
        (v_org, v_ua, 'Ada Lead', 'r6-a@example.test', 'active') RETURNING id INTO v_ca;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status) VALUES
        (v_org, v_ub, 'Bo Peer', 'r6-b@example.test', 'active') RETURNING id INTO v_cb;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status) VALUES
        (v_org, v_uc, 'Cy Other', 'r6-c@example.test', 'active') RETURNING id INTO v_cc;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status) VALUES
        (v_org, v_ul, 'Lu Lapsed', 'r6-lapsed@example.test', 'active') RETURNING id INTO v_cl;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'R6 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'R6 U10') RETURNING id INTO v_d1;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'R6 U12') RETURNING id INTO v_d2;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_other, 'R6 Other Fall') RETURNING id INTO v_s2;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_other, v_s2, 'R6 Other U10') RETURNING id INTO v_od;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d1, 'R6 Aces') RETURNING id INTO v_t1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d1, 'R6 Bees') RETURNING id INTO v_t2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d2, 'R6 Cats') RETURNING id INTO v_t3;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d1, 'R6 Dogs') RETURNING id INTO v_t4;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_other, v_od, 'R6 Elsewhere') RETURNING id INTO v_tx;
    -- Ada leads Aces (U10); Bo leads Bees (U10) and is
    -- Ada's assistant; Cy leads Cats (U12); Lu coached Dogs (U10) until
    -- yesterday. Ada is also a coach-role member of the other organization,
    -- where her coach record (one per sign-in) coaches nothing.
    INSERT INTO public.team_coach_assignments
        (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
    VALUES (v_org, v_t1, v_ca, 'lead', current_date - 30, NULL, 'smoke', NULL),
           (v_org, v_t1, v_cb, 'assistant', current_date - 30, NULL, 'smoke', NULL),
           (v_org, v_t2, v_cb, 'lead', current_date - 30, NULL, 'smoke', NULL),
           (v_org, v_t3, v_cc, 'lead', current_date - 30, NULL, 'smoke', NULL),
           (v_org, v_t4, v_cl, 'lead', current_date - 30, current_date - 1, 'smoke', 'smoke');
    INSERT INTO public.games (organization_id, home_team_id, away_team_id) VALUES (v_org, v_t1, v_t2)
        RETURNING id INTO v_game;

    -- ---- Score entry: off unless the league turns it on -------------------
    v_refused := 0;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    FOR v_res IN SELECT x FROM (VALUES (NULL::jsonb), ('{"score_entry": false}'::jsonb),
                                        ('{"score_entry": "true"}'::jsonb)) AS f(x) LOOP
        UPDATE public.organizations SET feature_flags = COALESCE(v_res, '{}'::jsonb) WHERE id = v_org;
        SET LOCAL ROLE authenticated;
        BEGIN
            PERFORM public.update_game_score(v_org, v_game, 1::smallint, 0::smallint, '{}'::jsonb);
        EXCEPTION WHEN SQLSTATE '55000' THEN v_refused := v_refused + 1;
        END;
        RESET ROLE;
    END LOOP;
    IF v_refused <> 3
       OR (SELECT score_home FROM public.games WHERE id = v_game) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.audit_log WHERE resource_id = v_game) THEN
        RAISE EXCEPTION 'score entry with the setting absent, false or not a boolean: % of 3 refused 55000, or a score or audit row was written', v_refused;
    END IF;

    UPDATE public.organizations SET feature_flags = '{"score_entry": true}'::jsonb WHERE id = v_org;
    SET LOCAL ROLE authenticated;
    PERFORM public.update_game_score(v_org, v_game, 2::smallint, 1::smallint, '{}'::jsonb);
    PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
    PERFORM public.update_game_score(v_org, v_game, 3::smallint, 1::smallint, '{}'::jsonb);
    RESET ROLE;
    IF (SELECT score_home FROM public.games WHERE id = v_game) IS DISTINCT FROM 3::smallint
       OR (SELECT count(*) FROM public.audit_log
            WHERE resource_id = v_game AND action = 'competition.score_updated') <> 2 THEN
        RAISE EXCEPTION 'with score entry on, an admin and a staff member did not each score once, audited';
    END IF;

    v_refused := 0;
    FOREACH v_got IN ARRAY ARRAY[v_ua::text, v_ub::text, v_member::text, v_outsider::text] LOOP
        PERFORM set_config('request.jwt.claim.sub', v_got, true);
        SET LOCAL ROLE authenticated;
        BEGIN
            PERFORM public.update_game_score(v_org, v_game, 9::smallint, 9::smallint, '{}'::jsonb);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
        END;
        RESET ROLE;
    END LOOP;
    IF v_refused <> 4 OR (SELECT score_home FROM public.games WHERE id = v_game) IS DISTINCT FROM 3::smallint THEN
        RAISE EXCEPTION 'score entry: % of 4 non-admins (the home and away coaches, a member who coaches no team, another organization''s admin) refused 42501, or the score moved', v_refused;
    END IF;
    RAISE NOTICE 'score entry: off (absent, false, a string) refused an admin 55000, 3 of 3, writing nothing; on, an admin and a staff member scored, 2 audit rows; both teams'' coaches, a member who coaches no team and another organization''s admin refused 42501, 4 of 4';

    -- ---- Withdraw: an admin only -------------------------------------------
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'R6 Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
        VALUES (v_org, v_loc, 'R6 Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
        VALUES (v_org, v_field, 'mon', '17:00', '18:00', current_date - 30, current_date + 60) RETURNING id INTO v_slot;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
        VALUES (v_org, v_t1, v_slot, daterange(current_date - 30, current_date + 60, '[]'), 'auto');
    INSERT INTO public.practice_lighting_overrides (organization_id, practice_slot_id, "window", status, requested_by)
        VALUES (v_org, v_slot, daterange(current_date + 7, current_date + 14, '[]'), 'requested', v_ua)
        RETURNING id INTO v_req;
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    IF NOT public.caller_coaches_practice_slot(v_slot) THEN
        RAISE EXCEPTION 'control: Ada does not coach the slot, so the withdraw refusal below would test nothing';
    END IF;
    v_refused := 0;
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM public.withdraw_practice_lighting_override(v_req);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := 1;
    END;
    RESET ROLE;
    IF v_refused <> 1 OR (SELECT status FROM public.practice_lighting_overrides WHERE id = v_req) <> 'requested' THEN
        RAISE EXCEPTION 'the requester, still a coach of the slot, withdrew their lighting request';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.withdraw_practice_lighting_override(v_req);
    RESET ROLE;
    IF (SELECT status FROM public.practice_lighting_overrides WHERE id = v_req) <> 'withdrawn' THEN
        RAISE EXCEPTION 'an admin could not withdraw the lighting request';
    END IF;
    RAISE NOTICE 'lighting: the requester, still a coach of the slot, was refused 42501; an admin withdrew the request';

    -- ---- The division read --------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    SET LOCAL ROLE authenticated;
    SELECT string_agg(format('%s/%s/%s/%s', division_name, team_name, array_to_string(coach_names, '+'), is_mine),
                      ' ' ORDER BY division_name, team_name)
      INTO v_got FROM public.get_my_division_teams(v_org);
    RESET ROLE;
    IF v_got IS DISTINCT FROM 'R6 U10/R6 Aces/Ada Lead+Bo Peer/t R6 U10/R6 Bees/Bo Peer/f R6 U10/R6 Dogs//f' THEN
        RAISE EXCEPTION 'Ada''s division read is not her division''s three teams, their current coaches lead first, hers marked: %', v_got;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_uc::text, true);
    SET LOCAL ROLE authenticated;
    SELECT string_agg(team_name, ',' ORDER BY team_name) INTO v_got FROM public.get_my_division_teams(v_org);
    RESET ROLE;
    IF v_got IS DISTINCT FROM 'R6 Cats' THEN
        RAISE EXCEPTION 'Cy''s division read is not exactly his division''s team: %', v_got;
    END IF;
    -- In the other organization Ada coaches no team, so she reads nothing
    -- there, its team included.
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    SET LOCAL ROLE authenticated;
    SELECT string_agg(team_name, ',' ORDER BY team_name) INTO v_got FROM public.get_my_division_teams(v_other);
    RESET ROLE;
    IF v_got IS NOT NULL THEN
        RAISE EXCEPTION 'Ada read the other organization''s teams, where she coaches none: %', v_got;
    END IF;
    v_n := 0;
    FOREACH v_got IN ARRAY ARRAY[v_member::text, v_ul::text, v_admin::text] LOOP
        PERFORM set_config('request.jwt.claim.sub', v_got, true);
        SET LOCAL ROLE authenticated;
        v_n := v_n + (SELECT count(*) FROM public.get_my_division_teams(v_org));
        RESET ROLE;
    END LOOP;
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'a member who coaches no team, a lapsed coach or an admin who coaches nothing read % division row(s)', v_n;
    END IF;

    -- The preview read: an admin sees Ada's set; a coach and another
    -- organization's admin are refused.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    SELECT string_agg(team_name, ',' ORDER BY team_name) INTO v_got FROM public.admin_get_division_teams(v_org, v_ua);
    RESET ROLE;
    IF v_got IS DISTINCT FROM 'R6 Aces,R6 Bees,R6 Dogs' THEN
        RAISE EXCEPTION 'the admin''s preview of Ada is not her division read: %', v_got;
    END IF;
    v_refused := 0;
    FOREACH v_got IN ARRAY ARRAY[v_ub::text, v_outsider::text] LOOP
        PERFORM set_config('request.jwt.claim.sub', v_got, true);
        SET LOCAL ROLE authenticated;
        BEGIN
            PERFORM count(*) FROM public.admin_get_division_teams(v_org, v_ua);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
        END;
        RESET ROLE;
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM count(*) FROM public.get_my_division_teams(v_org);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
    END;
    RESET ROLE;
    IF v_refused <> 3 THEN
        RAISE EXCEPTION 'the preview read refused % of a coach and another organization''s admin, and the caller with no uid, of 3', v_refused;
    END IF;
    RAISE NOTICE 'division read: Ada got her division''s 3 teams (current coaches lead first, a lapsed one unnamed, hers marked) and none of U12 or the other organization''s (none there either); Cy his 1; a non-coach, a lapsed coach and an admin 0; the preview gave the admin Ada''s 3 and refused a coach, an outside admin and no uid, 3 of 3';
END;
$$;

ROLLBACK;
