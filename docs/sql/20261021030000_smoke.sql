-- Smoke checks for 20261021030000_admin_delete_team_exceptions.sql
--
-- What it proves, run against the migrated database with prelude.sql's
-- `auth.uid()` stub:
--   * an admin deletes a team whose series carries a live and a withdrawn
--     exception: the live one is withdrawn and audited, both are archived onto
--     their run, each series is audited practice.cancelled, every player on
--     the team loses the team id, and team.deleted records the counts;
--   * a coach is refused 42501 and nothing changes;
--   * while that delete is open, a second session's exception insert for the
--     team waits on it (55P03 at a 1s lock timeout); the same session writes an
--     untouched team's exception at once.
--
-- **Since 20261022030000 (plan docs/changes/2026-10-22-admin-focus.md, R2)**
-- the head build this runs on has no RSVPs: `event_rsvps` and
-- `upsert_team_event_rsvp` are dropped, and `admin_delete_team` no longer
-- removes or counts RSVPs or locks the team's games for them. The checks of
-- the opponent's game RSVP and the two RSVP races went with them;
-- docs/sql/20261022030000_smoke.sql checks the delete without them.
--
-- The race needs a second session, so this smoke uses `dblink` (contrib, in
-- the harness's PostgreSQL image) and drops it at the end. Its fixture is
-- therefore COMMITTED (the second session must see it); every name and id is
-- synthetic, under the org "Smoke Org DT", and every email is @example.test.

\set ON_ERROR_STOP on

CREATE TEMP TABLE dt_ids (name text PRIMARY KEY, id uuid NOT NULL);

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach uuid := gen_random_uuid();
    v_org uuid; v_s uuid; v_d uuid; v_t uuid; v_o uuid; v_x uuid; v_loc uuid; v_f uuid;
    v_tue uuid; v_thu uuid; v_run uuid; v_pa uuid; v_pa2 uuid; v_pao uuid;
    v_g uuid; v_g2 uuid; v_p1 uuid; v_p2 uuid; v_p3 uuid; v_p4 uuid;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
        (v_admin, 'dt-admin@example.test', '{"password_length": 16}', now()),
        (v_coach, 'dt-coach@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email, full_name) VALUES
        (v_admin, 'dt-admin@example.test', 'DT Admin'), (v_coach, 'dt-coach@example.test', 'DT Coach')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org DT', 'smoke-org-dt') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_coach, 'coach');
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'DT Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'DT U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'DT Deleted') RETURNING id INTO v_t;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'DT Opponent') RETURNING id INTO v_o;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'DT Other') RETURNING id INTO v_x;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'DT Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active) VALUES (v_org, v_loc, 'DT Pitch', true) RETURNING id INTO v_f;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until)
        VALUES (v_org, v_f, 'tue', '17:00', '18:30', 3, '2026-09-01', '2026-12-31') RETURNING id INTO v_tue;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until)
        VALUES (v_org, v_f, 'thu', '17:00', '18:30', 3, '2026-09-01', '2026-12-31') RETURNING id INTO v_thu;
    INSERT INTO public.scheduler_runs (organization_id, run_type, status, results)
        VALUES (v_org, 'practice', 'completed', '{}'::jsonb) RETURNING id INTO v_run;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range)
        VALUES (v_org, v_t, v_tue, '[2026-09-01,2026-10-01)') RETURNING id INTO v_pa;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range)
        VALUES (v_org, v_t, v_tue, '[2026-10-01,2026-12-01)') RETURNING id INTO v_pa2;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range)
        VALUES (v_org, v_o, v_tue, '[2026-09-01,2026-12-01)') RETURNING id INTO v_pao;
    INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind,
        practice_slot_id, tbd_reason, cause_kind, run_id, withdrawn_at) VALUES
        (v_org, v_s, v_t, v_pa, '[2026-09-08,2026-09-22)', 'relocated', v_thu, NULL, 'retirement', v_run, NULL),
        (v_org, v_s, v_t, v_pa, '[2026-09-22,2026-09-29)', 'time_tbd', NULL, 'contended', 'blackout', v_run, now() - interval '1 day');
    INSERT INTO public.games (organization_id, home_team_id, away_team_id, start_time)
        VALUES (v_org, v_t, v_o, '2026-11-07 15:00+00') RETURNING id INTO v_g;
    INSERT INTO public.games (organization_id, home_team_id, away_team_id, start_time)
        VALUES (v_org, v_o, v_x, '2026-11-14 15:00+00') RETURNING id INTO v_g2;
    INSERT INTO public.players (organization_id, division_id, first_name, last_name) VALUES (v_org, v_d, 'DT', 'One') RETURNING id INTO v_p1;
    INSERT INTO public.players (organization_id, division_id, first_name, last_name, team_id) VALUES (v_org, v_d, 'DT', 'Two', v_t) RETURNING id INTO v_p2;
    INSERT INTO public.players (organization_id, division_id, first_name, last_name) VALUES (v_org, v_d, 'DT', 'Three') RETURNING id INTO v_p3;
    INSERT INTO public.players (organization_id, division_id, first_name, last_name) VALUES (v_org, v_d, 'DT', 'Four') RETURNING id INTO v_p4;
    INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES (v_t, v_p1, v_org), (v_o, v_p3, v_org), (v_o, v_p4, v_org);
    INSERT INTO dt_ids (name, id) VALUES
        ('admin', v_admin), ('coach', v_coach), ('org', v_org), ('season', v_s), ('t', v_t), ('o', v_o), ('x', v_x),
        ('thu', v_thu), ('run', v_run), ('pa', v_pa), ('pa2', v_pa2), ('pao', v_pao), ('g', v_g), ('g2', v_g2),
        ('p1', v_p1), ('p2', v_p2), ('p3', v_p3), ('p4', v_p4);
END;
$$;

GRANT SELECT ON dt_ids TO PUBLIC;

-- ---- refusal, then the delete itself (rolled back) -------------------------
BEGIN;
DO $$
DECLARE
    v_t uuid := (SELECT id FROM dt_ids WHERE name = 't');
    v_org uuid := (SELECT id FROM dt_ids WHERE name = 'org');
    v_g uuid := (SELECT id FROM dt_ids WHERE name = 'g');
    v_run uuid := (SELECT id FROM dt_ids WHERE name = 'run');
    v_meta jsonb;
    v_state text;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', (SELECT id FROM dt_ids WHERE name = 'coach')::text, true);
    BEGIN
        PERFORM public.admin_delete_team(v_t);
        RAISE EXCEPTION 'a coach deleted a team';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = v_t)
       OR (SELECT count(*) FROM public.practice_exceptions WHERE team_id = v_t AND withdrawn_at IS NULL) <> 1 THEN
        RAISE EXCEPTION 'the refused delete changed something';
    END IF;
    RAISE NOTICE 'a coach is refused 42501 and nothing changes';

    PERFORM set_config('request.jwt.claim.sub', (SELECT id FROM dt_ids WHERE name = 'admin')::text, true);
    PERFORM public.admin_delete_team(v_t);

    IF EXISTS (SELECT 1 FROM public.teams WHERE id = v_t)
       OR EXISTS (SELECT 1 FROM public.practice_exceptions WHERE team_id = v_t) THEN
        RAISE EXCEPTION 'the team or its exceptions survived the delete';
    END IF;
    IF (SELECT count(*) FROM public.audit_log
         WHERE action = 'practice.exception_withdrawn' AND organization_id = v_org
           AND metadata->>'reason' = 'team_deleted') <> 1 THEN
        RAISE EXCEPTION 'the live exception was not withdrawn on the record (and only it)';
    END IF;
    RAISE NOTICE 'the live exception is withdrawn and audited; the withdrawn one is not';

    IF (SELECT jsonb_array_length(results->'archived_exceptions') FROM public.scheduler_runs WHERE id = v_run) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'both exceptions were not archived onto their run';
    END IF;
    RAISE NOTICE 'both exceptions are archived onto their run';

    IF (SELECT count(*) FROM public.audit_log
         WHERE action = 'practice.cancelled' AND organization_id = v_org
           AND metadata->>'reason' = 'team_deleted' AND metadata->'before' IS NOT NULL) <> 2 THEN
        RAISE EXCEPTION 'each series was not audited practice.cancelled with its before row';
    END IF;
    RAISE NOTICE 'each of the team''s 2 series is audited practice.cancelled with its before row';

    IF EXISTS (SELECT 1 FROM public.players
                WHERE id IN (SELECT id FROM dt_ids WHERE name IN ('p1', 'p2')) AND team_id IS NOT NULL) THEN
        RAISE EXCEPTION 'a player kept the deleted team''s id';
    END IF;
    RAISE NOTICE 'both players, rostered or assigned through team_id alone, have no team';

    SELECT metadata INTO v_meta FROM public.audit_log
     WHERE action = 'team.deleted' AND resource_id = v_t;
    IF v_meta->>'practice_exceptions_deleted' IS DISTINCT FROM '2'
       OR v_meta->>'practice_assignments_deleted' IS DISTINCT FROM '2'
       OR v_meta->>'games_deleted' IS DISTINCT FROM '1'
       OR v_meta->>'team_players_deleted' IS DISTINCT FROM '1'
       OR jsonb_array_length(v_meta->'player_ids_unassigned') IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'team.deleted did not record what the delete took: %', v_meta;
    END IF;
    RAISE NOTICE 'team.deleted records the counts, the game and the unassigned players';
    IF EXISTS (SELECT 1 FROM public.games WHERE id = v_g) THEN
        RAISE EXCEPTION 'the deleted team''s game survived the delete';
    END IF;
END;
$$;
ROLLBACK;

-- ---- the races: a second session waits on the open delete ------------------
CREATE EXTENSION IF NOT EXISTS dblink;

BEGIN;
DO $$
DECLARE
    v_admin uuid := (SELECT id FROM dt_ids WHERE name = 'admin');
    v_org uuid := (SELECT id FROM dt_ids WHERE name = 'org');
    v_s uuid := (SELECT id FROM dt_ids WHERE name = 'season');
    v_t uuid := (SELECT id FROM dt_ids WHERE name = 't');
    v_o uuid := (SELECT id FROM dt_ids WHERE name = 'o');
    v_pa uuid := (SELECT id FROM dt_ids WHERE name = 'pa');
    v_pao uuid := (SELECT id FROM dt_ids WHERE name = 'pao');
    v_conn text := 'dt_racer';
    v_state text; v_msg text;
    v_exc_wait text; v_exc_control text;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.admin_delete_team(v_t);

    PERFORM dblink_connect(v_conn, format('dbname=%s host=%s port=%s user=%s',
        current_database(), split_part(current_setting('unix_socket_directories'), ',', 1),
        current_setting('port'), current_user));
    PERFORM dblink_exec(v_conn, format('SET request.jwt.claim.sub = %L', v_admin));
    PERFORM dblink_exec(v_conn, 'SET lock_timeout = ''1s''');

    -- A practice save's exception insert for the deleted team.
    BEGIN
        PERFORM dblink_exec(v_conn, 'BEGIN');
        PERFORM dblink_exec(v_conn, format(
            'INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason)
             VALUES (%L, %L, %L, %L, %L, ''time_tbd'', ''contended'')',
            v_org, v_s, v_t, v_pa, '[2026-11-03,2026-11-10)'));
        v_exc_wait := 'committed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_exc_wait := v_state || ' ' || v_msg;
    END;
    PERFORM dblink_exec(v_conn, 'ROLLBACK');
    -- The control: an untouched team's exception is written at once.
    BEGIN
        PERFORM dblink_exec(v_conn, 'BEGIN');
        PERFORM dblink_exec(v_conn, format(
            'INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason)
             VALUES (%L, %L, %L, %L, %L, ''time_tbd'', ''contended'')',
            v_org, v_s, v_o, v_pao, '[2026-11-03,2026-11-10)'));
        v_exc_control := 'committed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_exc_control := v_state || ' ' || v_msg;
    END;
    PERFORM dblink_exec(v_conn, 'ROLLBACK');

    PERFORM dblink_disconnect(v_conn);

    IF v_exc_wait NOT LIKE '55P03%' OR v_exc_control <> 'committed' THEN
        RAISE EXCEPTION 'exception race: the deleted team''s insert gave "%", the control gave "%"', v_exc_wait, v_exc_control;
    END IF;
    RAISE NOTICE 'exception race: while the delete was open, a second session''s exception insert for the team timed out 55P03; an untouched team''s insert was written at once';
END;
$$;
ROLLBACK;

DROP EXTENSION dblink;
