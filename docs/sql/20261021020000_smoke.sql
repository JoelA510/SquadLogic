-- Smoke checks for 20261021020000_restrict_people_reads.sql
--
-- What it proves, each read run as `authenticated` with prelude.sql's
-- `auth.uid()` stub, each rule in both directions:
--   * players / team_players: a guardian reads their own child and not a
--     teammate, and nothing once removed from the organization; a coach who is
--     no guardian reads neither; an admin reads both;
--   * coaches / team_coach_assignments: a coach reads their own row and
--     assignment, not another coach's; a parent reads none; an admin reads all;
--   * profile_players: a member reads their own link, not another's;
--   * staging_players: a member reads nothing, an admin reads the row;
--   * team_calendar_tokens: every team's token was copied; a new team gets
--     one; the team's coach and guardian read it, an unrelated member does not;
--     teams.calendar_token is gone;
--   * rotate_calendar_token: an unrelated member is refused and the token is
--     unchanged; the current coach rotates it;
--   * update_game_score: the coach of the home team scores; a coach of
--     neither team is refused (42501); an admin scores;
--   * reconcile_prod_rls_drift's spec names the new coaches policy.
--
-- Wrapped in BEGIN ... ROLLBACK. Every id is generated; every email is
-- `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_cu uuid := gen_random_uuid();      -- coach of team A (home)
    v_ou uuid := gen_random_uuid();      -- coach of team B
    v_g uuid := gen_random_uuid();       -- guardian of p1 (team A)
    v_m uuid := gen_random_uuid();       -- parent with no tie
    v_org uuid;
    v_s uuid;
    v_d uuid;
    v_ta uuid;
    v_tb uuid;
    v_tc uuid;
    v_c uuid;
    v_o uuid;
    v_p1 uuid;
    v_p2 uuid;
    v_game uuid;
    v_job uuid := gen_random_uuid();
    v_n integer;
    v_tok uuid;
    v_r json;
    v_denied boolean;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
        (v_admin, 'rpr-admin@example.test', '{"password_length": 16}', now()),
        (v_cu, 'rpr-coach@example.test', '{"password_length": 16}', now()),
        (v_ou, 'rpr-other@example.test', '{"password_length": 16}', now()),
        (v_g, 'rpr-guardian@example.test', '{"password_length": 16}', now()),
        (v_m, 'rpr-member@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'rpr-admin@example.test'), (v_cu, 'rpr-coach@example.test'),
        (v_ou, 'rpr-other@example.test'), (v_g, 'rpr-guardian@example.test'),
        (v_m, 'rpr-member@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org RPR', 'smoke-org-rpr')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_cu, 'coach'), (v_org, v_ou, 'coach'),
        (v_org, v_g, 'parent'), (v_org, v_m, 'parent');
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'RPR Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'RPR U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'RPR A') RETURNING id INTO v_ta;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'RPR B') RETURNING id INTO v_tb;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'RPR C') RETURNING id INTO v_tc;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_cu, 'Coach A', 'rpr-coach@example.test', 'active') RETURNING id INTO v_c;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_ou, 'Coach B', 'rpr-other@example.test', 'active') RETURNING id INTO v_o;
    INSERT INTO public.team_coach_assignments
        (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
    VALUES (v_org, v_ta, v_c, 'lead', public.team_local_today(v_ta) - 10, NULL, 'smoke', NULL),
           (v_org, v_tb, v_o, 'lead', public.team_local_today(v_tb) - 10, NULL, 'smoke', NULL);
    INSERT INTO public.players (organization_id, first_name, last_name) VALUES (v_org, 'Pia', 'One') RETURNING id INTO v_p1;
    INSERT INTO public.players (organization_id, first_name, last_name) VALUES (v_org, 'Rex', 'Two') RETURNING id INTO v_p2;
    INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES (v_ta, v_p1, v_org), (v_ta, v_p2, v_org);
    INSERT INTO public.profile_players (profile_id, player_id, organization_id) VALUES (v_g, v_p1, v_org);
    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
        (v_job, v_org, 'registration', 'smoke/rpr.csv', 'processing', v_admin);
    INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
        VALUES (v_org, v_job, 1, '{}'::jsonb, '{}'::jsonb);
    INSERT INTO public.games (organization_id, home_team_id, away_team_id) VALUES (v_org, v_ta, v_tc) RETURNING id INTO v_game;

    -- Calendar tokens: the new teams got theirs from the trigger, and the
    -- column on teams is gone.
    IF (SELECT count(*) FROM public.team_calendar_tokens WHERE team_id IN (v_ta, v_tb, v_tc)) <> 3 THEN
        RAISE EXCEPTION 'a new team did not get a calendar token';
    END IF;
    IF (SELECT count(*) FROM public.teams) <> (SELECT count(*) FROM public.team_calendar_tokens) THEN
        RAISE EXCEPTION 'not every team has a calendar token';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'teams' AND column_name LIKE 'calendar_token%') THEN
        RAISE EXCEPTION 'teams still carries a calendar token column';
    END IF;
    RAISE NOTICE 'calendar tokens: one per team, a new team gets one, none left on teams';

    -- Guardian
    PERFORM set_config('request.jwt.claim.sub', v_g::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.players WHERE id IN (v_p1, v_p2);
    IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM public.players WHERE id = v_p1) THEN
        RESET ROLE; RAISE EXCEPTION 'a guardian read % players (want only their own child)', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.team_players WHERE team_id = v_ta;
    IF v_n <> 1 THEN RESET ROLE; RAISE EXCEPTION 'a guardian read % roster rows (want 1)', v_n; END IF;
    IF EXISTS (SELECT 1 FROM public.coaches WHERE organization_id = v_org)
       OR EXISTS (SELECT 1 FROM public.team_coach_assignments WHERE organization_id = v_org) THEN
        RESET ROLE; RAISE EXCEPTION 'a guardian read coach rows';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.team_calendar_tokens WHERE team_id = v_ta)
       OR EXISTS (SELECT 1 FROM public.team_calendar_tokens WHERE team_id = v_tb) THEN
        RESET ROLE; RAISE EXCEPTION 'a guardian did not read exactly their team''s calendar token';
    END IF;
    RESET ROLE;
    RAISE NOTICE 'guardian: own child and its roster row, their team''s token; no teammate, no coach rows';

    -- Coach of team A
    PERFORM set_config('request.jwt.claim.sub', v_cu::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.players WHERE organization_id = v_org;
    IF v_n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'a coach who is no guardian read % player rows', v_n; END IF;
    IF (SELECT count(*) FROM public.coaches WHERE organization_id = v_org) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.coaches WHERE id = v_c)
       OR (SELECT count(*) FROM public.team_coach_assignments WHERE organization_id = v_org) <> 1 THEN
        RESET ROLE; RAISE EXCEPTION 'a coach did not read exactly their own coach row and assignment';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.team_calendar_tokens WHERE team_id = v_ta) THEN
        RESET ROLE; RAISE EXCEPTION 'the current coach could not read their team''s token';
    END IF;
    RESET ROLE;
    RAISE NOTICE 'coach: own coach row and assignment, their team''s token; no player rows';

    -- Unrelated parent
    PERFORM set_config('request.jwt.claim.sub', v_m::text, true);
    SET LOCAL ROLE authenticated;
    IF EXISTS (SELECT 1 FROM public.players WHERE organization_id = v_org)
       OR EXISTS (SELECT 1 FROM public.profile_players WHERE organization_id = v_org)
       OR EXISTS (SELECT 1 FROM public.staging_players WHERE organization_id = v_org)
       OR EXISTS (SELECT 1 FROM public.team_calendar_tokens WHERE team_id IN (v_ta, v_tb, v_tc)) THEN
        RESET ROLE; RAISE EXCEPTION 'an unrelated member read players, links, staging rows or a token';
    END IF;
    RESET ROLE;
    SELECT token INTO v_tok FROM public.team_calendar_tokens WHERE team_id = v_ta;
    SET LOCAL ROLE authenticated;
    v_r := public.rotate_calendar_token(v_ta);
    RESET ROLE;
    IF v_r->>'status' <> 'error' OR (SELECT token FROM public.team_calendar_tokens WHERE team_id = v_ta) <> v_tok THEN
        RAISE EXCEPTION 'an unrelated member rotated a team''s token: %', v_r;
    END IF;
    RAISE NOTICE 'unrelated member: no players, links, staging rows or tokens; rotate refused, token unchanged';

    -- Rotate as the coach
    PERFORM set_config('request.jwt.claim.sub', v_cu::text, true);
    SET LOCAL ROLE authenticated;
    v_r := public.rotate_calendar_token(v_ta);
    RESET ROLE;
    IF v_r->>'status' <> 'success' OR (SELECT token FROM public.team_calendar_tokens WHERE team_id = v_ta) = v_tok
       OR (v_r->>'calendar_token')::uuid <> (SELECT token FROM public.team_calendar_tokens WHERE team_id = v_ta) THEN
        RAISE EXCEPTION 'the current coach could not rotate the token: %', v_r;
    END IF;
    RAISE NOTICE 'the current coach rotates the team''s token';

    -- Scores
    PERFORM set_config('request.jwt.claim.sub', v_cu::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.update_game_score(v_org, v_game, 2::smallint, 1::smallint, '{}'::jsonb);
    RESET ROLE;
    IF (SELECT score_home FROM public.games WHERE id = v_game) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'the home team''s coach could not score the game';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_ou::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM public.update_game_score(v_org, v_game, 9::smallint, 9::smallint, '{}'::jsonb);
        v_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    RESET ROLE;
    IF NOT v_denied OR (SELECT score_home FROM public.games WHERE id = v_game) <> 2 THEN
        RAISE EXCEPTION 'a coach of neither team scored the game';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.update_game_score(v_org, v_game, 3::smallint, 1::smallint, '{}'::jsonb);
    IF (SELECT count(*) FROM public.players WHERE organization_id = v_org) <> 2
       OR (SELECT count(*) FROM public.coaches WHERE organization_id = v_org) <> 2
       OR (SELECT count(*) FROM public.staging_players WHERE organization_id = v_org) <> 1 THEN
        RESET ROLE; RAISE EXCEPTION 'an admin no longer reads every player, coach and staging row';
    END IF;
    RESET ROLE;
    IF (SELECT score_home FROM public.games WHERE id = v_game) <> 3 THEN
        RAISE EXCEPTION 'an admin could not score the game';
    END IF;
    RAISE NOTICE 'scores: the home coach and an admin score, a coach of neither team is refused; an admin reads every row';

    IF pg_get_functiondef('public.reconcile_prod_rls_drift()'::regprocedure) NOT LIKE '%coaches_select_admin_or_self%'
       OR pg_get_functiondef('public.reconcile_prod_rls_drift()'::regprocedure) LIKE '%Coaches: members access%' THEN
        RAISE EXCEPTION 'reconcile_prod_rls_drift would still re-create the member-wide coaches read';
    END IF;
    RAISE NOTICE 'reconcile_prod_rls_drift names the new coaches policy';

    -- A link outlives a removed membership; the read does not.
    DELETE FROM public.organization_members WHERE organization_id = v_org AND profile_id = v_g;
    PERFORM set_config('request.jwt.claim.sub', v_g::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.players WHERE id = v_p1;
    SELECT v_n + count(*) INTO v_n FROM public.team_players WHERE player_id = v_p1;
    RESET ROLE;
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'a guardian removed from the organization still read their child (% rows)', v_n;
    END IF;
    RAISE NOTICE 'a guardian removed from the organization reads neither their child nor its roster row';
END;
$$;

ROLLBACK;
