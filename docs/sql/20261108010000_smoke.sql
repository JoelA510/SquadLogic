-- Smoke checks for 20261108010000_season_enrollment.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   * the import matches in the destination season only: the same registration id imported into
--     the next season is a NEW player, the first season's row is untouched, and a division named
--     by id from the first season matches nothing; a coach email is a new coach in the next season;
--   * a completed season and an organization with no season take no import (22023);
--   * the triggers: a player takes its division's season, never changes season, and refuses a
--     division, a buddy pair, a roster row, a coach assignment and a coach's child link of another
--     season (23514);
--   * admin_create_player takes a season, defaulting to the active one;
--   * view_org_metrics counts per season.
--
-- Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_org_none uuid;
    v_s1 uuid;
    v_s2 uuid;
    v_d1 uuid;
    v_d2 uuid;
    v_t2 uuid;
    v_job1 uuid := gen_random_uuid();
    v_job2 uuid := gen_random_uuid();
    v_job3 uuid := gen_random_uuid();
    v_job_none uuid := gen_random_uuid();
    v_cjob uuid := gen_random_uuid();
    v_result jsonb;
    v_p1 uuid;
    v_p2 uuid;
    v_c1 uuid;
    v_c2 uuid;
    v_before jsonb;
    v_n integer;
    v_denied integer := 0;
    v_completed_refused boolean := false;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'se-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'se-admin@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Seasons', 'smoke-org-seasons')
        RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org No Season', 'smoke-org-no-season')
        RETURNING id INTO v_org_none;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org_none, v_admin, 'admin');
    -- An organization starts with no season row of its own here (the smokes insert organizations directly).
    DELETE FROM public.season_settings WHERE organization_id = v_org_none;
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org, 'Smoke Spring', 'active', 2026) RETURNING id INTO v_s1;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org, v_s1, 'U8') RETURNING id INTO v_d1;

    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id) VALUES
        (v_job1, v_org, 'registration', 'smoke/se-1.csv', 'processing', v_admin, v_s1),
        (v_job_none, v_org_none, 'registration', 'smoke/se-none.csv', 'processing', v_admin, NULL);
    INSERT INTO public.staging_players
        (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_job1, 1, '{}'::jsonb, '{"first_name": "One", "last_name": "Spring", "external_registration_id": "SE-1", "division": "U8", "buddy_request": "SE-2"}'),
        (v_org, v_job1, 2, '{}'::jsonb, '{"first_name": "Two", "last_name": "Spring", "external_registration_id": "SE-2", "division": "U8", "buddy_request": "SE-1"}'),
        (v_org_none, v_job_none, 1, '{}'::jsonb, '{"first_name": "Nobody", "last_name": "Season", "external_registration_id": "SE-N"}');

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    v_result := public.finalize_import_job(v_job1);
    IF (v_result->>'inserted_players')::int <> 2 THEN
        RAISE EXCEPTION 'season 1''s import did not insert 2 players: %', v_result;
    END IF;
    v_result := public.materialize_import_buddy_pairs(v_job1);
    IF (v_result->>'inserted_relationships')::int <> 2 THEN
        RAISE EXCEPTION 'season 1''s buddy pair was not made: %', v_result;
    END IF;
    IF (SELECT count(*) FROM public.players WHERE organization_id = v_org AND season_settings_id = v_s1) <> 2 THEN
        RAISE EXCEPTION 'the imported players did not take season 1';
    END IF;
    SELECT id INTO v_p1 FROM public.players WHERE organization_id = v_org AND external_registration_id = 'SE-1';
    SELECT to_jsonb(p) INTO v_before FROM public.players p WHERE p.id = v_p1;
    INSERT INTO public.coaches (organization_id, full_name, email) VALUES (v_org, 'Spring Coach', 'se-coach@example.test')
        RETURNING id INTO v_c1;
    IF (SELECT season_settings_id FROM public.coaches WHERE id = v_c1) IS DISTINCT FROM v_s1 THEN
        RAISE EXCEPTION 'a coach inserted with no season did not take the active one';
    END IF;
    RAISE NOTICE 'season 1: 2 players imported with a buddy pair, a coach on the active season';

    -- The rollover.
    UPDATE public.season_settings SET status = 'completed' WHERE id = v_s1;
    INSERT INTO public.season_settings (organization_id, name, status, season_year)
        VALUES (v_org, 'Smoke Fall', 'active', 2026) RETURNING id INTO v_s2;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org, v_s2, 'U8') RETURNING id INTO v_d2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d2, 'Smoke Fall Team')
        RETURNING id INTO v_t2;

    INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id) VALUES
        (v_job2, v_org, 'registration', 'smoke/se-2.csv', 'processing', v_admin, v_s2),
        (v_job3, v_org, 'registration', 'smoke/se-3.csv', 'processing', v_admin, v_s1),
        (v_cjob, v_org, 'registration', 'smoke/se-c.csv', 'processing', v_admin, v_s2);
    INSERT INTO public.staging_players
        (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
        (v_org, v_job2, 1, '{}'::jsonb, '{"first_name": "One", "last_name": "Fall", "external_registration_id": "SE-1", "division": "U8", "buddy_request": "SE-3"}'),
        (v_org, v_job2, 2, '{}'::jsonb, '{"first_name": "Three", "last_name": "Fall", "external_registration_id": "SE-3", "division": "U8", "buddy_request": "SE-1"}'),
        (v_org, v_job3, 1, '{}'::jsonb, '{"first_name": "Late", "last_name": "Spring", "external_registration_id": "SE-L"}');
    INSERT INTO public.staging_import_rows
        (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors) VALUES
        (v_org, v_cjob, 'coaches', 1, '{}'::jsonb, '{"full_name": "Fall Coach", "email": "se-coach@example.test"}', '[]'::jsonb);

    v_result := public.finalize_import_job(v_job2);
    IF (v_result->>'inserted_players')::int <> 2 OR (v_result->>'updated_players')::int <> 0 THEN
        RAISE EXCEPTION 'season 2''s import did not create both players as new: %', v_result;
    END IF;
    IF (SELECT to_jsonb(p) FROM public.players p WHERE p.id = v_p1) IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION 'the season-2 import changed season 1''s player';
    END IF;
    SELECT id INTO v_p2 FROM public.players
     WHERE organization_id = v_org AND external_registration_id = 'SE-1' AND season_settings_id = v_s2;
    IF v_p2 IS NULL OR v_p2 = v_p1 OR (SELECT division_id FROM public.players WHERE id = v_p2) IS DISTINCT FROM v_d2 THEN
        RAISE EXCEPTION 'the same registration id is not a new player in season 2, in season 2''s division';
    END IF;
    v_result := public.materialize_import_buddy_pairs(v_job2);
    IF EXISTS (SELECT 1 FROM public.player_buddies pb
                 JOIN public.players a ON a.id = pb.player_id JOIN public.players b ON b.id = pb.buddy_player_id
                WHERE a.season_settings_id <> b.season_settings_id)
       OR (SELECT count(*) FROM public.player_buddies pb WHERE pb.player_id = v_p1) <> 1 THEN
        RAISE EXCEPTION 'a buddy pair reached across seasons';
    END IF;
    v_result := public.finalize_coach_import_job(v_cjob);
    IF (v_result->>'inserted_coaches')::int <> 1 OR (v_result->>'updated_coaches')::int <> 0 THEN
        RAISE EXCEPTION 'the same email was not a new coach in season 2: %', v_result;
    END IF;
    SELECT id INTO v_c2 FROM public.coaches WHERE organization_id = v_org AND email = 'se-coach@example.test' AND season_settings_id = v_s2;
    IF v_c2 IS NULL OR v_c2 = v_c1 OR (SELECT full_name FROM public.coaches WHERE id = v_c1) <> 'Spring Coach' THEN
        RAISE EXCEPTION 'season 1''s coach was read or written by the season-2 import';
    END IF;
    RAISE NOTICE 'season 2: the same registration id and email are new rows, season 1''s player and coach are untouched, no buddy pair spans seasons';

    BEGIN
        PERFORM public.finalize_import_job(v_job3);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM public.finalize_import_job(v_job_none);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    IF v_denied <> 2 THEN
        RAISE EXCEPTION 'only % of 2 imports (a completed season, an organization with no season) were refused 22023', v_denied;
    END IF;
    RAISE NOTICE 'a completed season and an organization with no season take no import (22023), 2 of 2';

    -- The triggers.
    v_denied := 0;
    BEGIN
        INSERT INTO public.players (organization_id, season_settings_id, division_id, first_name, last_name)
        VALUES (v_org, v_s1, v_d2, 'Wrong', 'Division');
    EXCEPTION WHEN SQLSTATE '23514' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        UPDATE public.players SET season_settings_id = v_s2 WHERE id = v_p1;
    EXCEPTION WHEN SQLSTATE '23514' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        INSERT INTO public.player_buddies (player_id, buddy_player_id, organization_id, source_import_job)
        VALUES (v_p1, v_p2, v_org, v_job2);
    EXCEPTION WHEN SQLSTATE '23514' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES (v_t2, v_p1, v_org);
    EXCEPTION WHEN SQLSTATE '23514' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        UPDATE public.teams SET coach_id = v_c1 WHERE id = v_t2;
    EXCEPTION WHEN SQLSTATE '23514' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        INSERT INTO public.coach_team_requests (organization_id, coach_id, player_id, slot) VALUES (v_org, v_c2, v_p1, 9);
    EXCEPTION WHEN SQLSTATE '23514' THEN v_denied := v_denied + 1;
    END;
    IF v_denied <> 6 THEN
        RAISE EXCEPTION 'only % of 6 cross-season writes were refused 23514', v_denied;
    END IF;
    UPDATE public.teams SET coach_id = v_c2 WHERE id = v_t2;
    INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES (v_t2, v_p2, v_org);
    RAISE NOTICE 'cross-season writes: a division, a season change, a buddy pair, a roster row, a team coach and a coach''s child were each refused 23514, 6 of 6; the same-season writes were accepted';

    -- admin_create_player and the view.
    SET LOCAL ROLE authenticated;
    IF (public.admin_create_player(v_org, '{"first_name": "Hand", "last_name": "Added"}')).season_settings_id IS DISTINCT FROM v_s2 THEN
        RAISE EXCEPTION 'admin_create_player did not default to the active season';
    END IF;
    BEGIN
        PERFORM public.admin_create_player(v_org, '{}', v_s1);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_completed_refused := true;
    END;
    SELECT count(*) INTO v_n FROM public.view_org_metrics WHERE organization_id = v_org;
    RESET ROLE;
    IF NOT v_completed_refused THEN
        RAISE EXCEPTION 'a completed season took a new player';
    END IF;
    IF v_n <> 2 OR (SELECT total_players FROM public.view_org_metrics WHERE organization_id = v_org AND season_settings_id = v_s1) <> 2
       OR (SELECT total_players FROM public.view_org_metrics WHERE organization_id = v_org AND season_settings_id = v_s2) <> 3 THEN
        RAISE EXCEPTION 'view_org_metrics does not count per season (% rows)', v_n;
    END IF;
    RAISE NOTICE 'admin_create_player defaults to the active season and refuses a completed one; view_org_metrics has one row per season with 2 and 3 players';
END;
$$;

ROLLBACK;
