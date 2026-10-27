-- Smoke checks for 20261028010000_coach_view.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * posture: `update_game_score` and `withdraw_practice_lighting_override`
--     are definers with their SET clauses, callable by `authenticated` and
--     not `anon`; `request_practice_lighting_override` is gone; and the three
--     division reads this migration added (`division_teams_of`,
--     `get_my_division_teams`, `admin_get_division_teams`) stay dropped
--     (20261104010000: no coach signs in);
--   * score entry, an admin function behind the league's setting: with the
--     setting absent, false, or not a boolean, an admin is refused 55000 and
--     nothing is written; with it on, an admin and a staff member score (one
--     audit row each); two signed-in users who are not members (the home and
--     away coaches, before 20261104010000) and another organization's admin
--     are refused 42501; the service role, which skips every caller check, is
--     not refused with it off;
--   * withdrawing a lighting override: the user who requested it (a coach of
--     the slot, before 20261104010000) is refused 42501; an admin withdraws it.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Posture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_left text;
BEGIN
    IF to_regproc('public.request_practice_lighting_override') IS NOT NULL THEN
        RAISE EXCEPTION 'request_practice_lighting_override is back: no coach requests lighting';
    END IF;

    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('update_game_score', 'withdraw_practice_lighting_override')
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
           AND p.proname IN ('update_game_score', 'withdraw_practice_lighting_override')) <> 2 THEN
        RAISE EXCEPTION 'expected exactly the 2 functions the posture check reads';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('division_teams_of', 'get_my_division_teams', 'admin_get_division_teams')) THEN
        RAISE EXCEPTION 'a division read is back (20261104010000 dropped them)';
    END IF;
    RAISE NOTICE 'posture: the score and withdraw writers are pinned definers for authenticated, not anon; no request RPC; the three division reads stay dropped';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Score entry and withdraw.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_staff uuid := gen_random_uuid();
    v_ua uuid := gen_random_uuid();         -- signed in, no membership
    v_ub uuid := gen_random_uuid();         -- signed in, no membership
    v_outsider uuid := gen_random_uuid();
    v_org uuid; v_other uuid;
    v_s uuid; v_d1 uuid;
    v_t1 uuid; v_t2 uuid;
    v_game uuid;
    v_loc uuid; v_field uuid; v_slot uuid; v_req uuid;
    v_refused int;
    v_res jsonb;
    v_got text;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'r6-admin@example.test', '{"password_length": 16}'),
        (v_staff, 'r6-staff@example.test', '{"password_length": 16}'),
        (v_ua, 'r6-a@example.test', '{"password_length": 16}'),
        (v_ub, 'r6-b@example.test', '{"password_length": 16}'),
        (v_outsider, 'r6-outsider@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'r6-admin@example.test'), (v_staff, 'r6-staff@example.test'),
        (v_ua, 'r6-a@example.test'), (v_ub, 'r6-b@example.test'),
        (v_outsider, 'r6-outsider@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('R6 Smoke Org', 'r6-smoke-org') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('R6 Smoke Other', 'r6-smoke-other') RETURNING id INTO v_other;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_staff, 'staff'),
        (v_other, v_outsider, 'admin');
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'R6 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'R6 U10') RETURNING id INTO v_d1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d1, 'R6 Aces') RETURNING id INTO v_t1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d1, 'R6 Bees') RETURNING id INTO v_t2;
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
    FOREACH v_got IN ARRAY ARRAY[v_ua::text, v_ub::text, v_outsider::text] LOOP
        PERFORM set_config('request.jwt.claim.sub', v_got, true);
        SET LOCAL ROLE authenticated;
        BEGIN
            PERFORM public.update_game_score(v_org, v_game, 9::smallint, 9::smallint, '{}'::jsonb);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
        END;
        RESET ROLE;
    END LOOP;
    IF v_refused <> 3 OR (SELECT score_home FROM public.games WHERE id = v_game) IS DISTINCT FROM 3::smallint THEN
        RAISE EXCEPTION 'score entry: % of 3 non-admins (two signed-in non-members, another organization''s admin) refused 42501, or the score moved', v_refused;
    END IF;
    -- The service role (a server-side job) skips the setting, as it skips the
    -- role checks: with the setting off its call is not refused 55000. (It
    -- repeats the stored score, a no-op: a changed score would need an audit
    -- row, and `audit_log.user_id` is NOT NULL while the service role has no
    -- uid, so the service role cannot change a score either way; pre-existing.)
    UPDATE public.organizations SET feature_flags = '{}'::jsonb WHERE id = v_org;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    v_res := public.update_game_score(v_org, v_game, 3::smallint, 1::smallint, '{}'::jsonb);
    PERFORM set_config('request.jwt.claim.role', '', true);
    IF (v_res ->> 'changed')::boolean IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'the service role''s repeat of the stored score was not a no-op: %', v_res;
    END IF;
    RAISE NOTICE 'score entry: off (absent, false, a string) refused an admin 55000, 3 of 3, writing nothing; on, an admin and a staff member scored, 2 audit rows; two signed-in non-members and another organization''s admin refused 42501, 3 of 3; the service role was not refused with it off';

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
    v_refused := 0;
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM public.withdraw_practice_lighting_override(v_req);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := 1;
    END;
    RESET ROLE;
    IF v_refused <> 1 OR (SELECT status FROM public.practice_lighting_overrides WHERE id = v_req) <> 'requested' THEN
        RAISE EXCEPTION 'the requester, a non-member, withdrew their lighting request';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.withdraw_practice_lighting_override(v_req);
    RESET ROLE;
    IF (SELECT status FROM public.practice_lighting_overrides WHERE id = v_req) <> 'withdrawn' THEN
        RAISE EXCEPTION 'an admin could not withdraw the lighting request';
    END IF;
    RAISE NOTICE 'lighting: the requester, a signed-in non-member, was refused 42501; an admin withdrew the request';

END;
$$;

ROLLBACK;
