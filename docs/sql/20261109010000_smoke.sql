-- Smoke checks for 20261109010000_season_rollover.sql
--
-- What it proves, run against the migrated database with prelude.sql's `auth.uid()` stub:
--   * an admin starts a draft season from the active one: its divisions (a birth-date window moved
--     one year) and programs are copied and no player or coach is; the source is untouched;
--   * a draft takes a custom age cutoff; a player import into it adds a NEW row for a registration id
--     the active season also holds and leaves the active season's row untouched (the case Codex found
--     on #666); once the draft has players its cutoff and a division's window cannot change;
--   * activating the draft completes the old active season (exactly one season is active), a
--     completed season cannot be activated again and is read-only for a signed-in admin
--     (a player patch and a team write are refused);
--   * while a player import into a draft is unfinished its cutoff cannot change (import_pending);
--   * the season lock: while one session holds an activation open, a second session's activation or
--     rollover in the same organization waits (55P03 at a 1s lock timeout) and another
--     organization's is written at once.
--
-- The race needs a second session, so its fixture is COMMITTED (the second session must see it) and
-- removed at the end; it uses `dblink` (contrib, in the harness's PostgreSQL image), dropped at the
-- end. Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_s1 uuid;
    v_prog uuid;
    v_d1 uuid;
    v_new jsonb;
    v_s2 uuid;
    v_job uuid;
    v_fin jsonb;
    v_before jsonb;
    v_state text;
    v_detail text;
    v_refused text;
    v_n integer;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (v_admin, 'sr-admin@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'sr-admin@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Rollover', 'smoke-org-rollover') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin');
    DELETE FROM public.season_settings WHERE organization_id = v_org;
    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_start, season_end, timezone)
        VALUES (v_org, 'Smoke 2026', 'active', 2026, '2026-08-01', '2027-06-30', 'America/Chicago') RETURNING id INTO v_s1;
    INSERT INTO public.programs (organization_id, season_settings_id, name) VALUES (v_org, v_s1, 'Smoke Minis') RETURNING id INTO v_prog;
    INSERT INTO public.divisions (organization_id, season_settings_id, name, program_id, min_age, max_age, birthdate_start, birthdate_end, max_roster_size)
        VALUES (v_org, v_s1, 'Smoke U10', v_prog, 9, 10, '2015-08-01', '2016-07-31', 12) RETURNING id INTO v_d1;
    INSERT INTO public.players (organization_id, division_id, first_name, last_name, external_registration_id, natural_age)
        VALUES (v_org, v_d1, 'Smoke', 'Active', 'SR-1', 10);
    INSERT INTO public.coaches (organization_id, full_name, email) VALUES (v_org, 'Smoke Coach', 'sr-coach@example.test');
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d1, 'Smoke Team');
    SELECT to_jsonb(p) INTO v_before FROM public.players p WHERE p.external_registration_id = 'SR-1';

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

    -- The rollover.
    v_new := public.admin_create_season_from(v_s1, 'Smoke 2027', 2027, '2027-08-01', '2028-06-30');
    v_s2 := (v_new ->> 'id')::uuid;
    IF v_new ->> 'status' <> 'draft' OR (v_new ->> 'divisions_copied')::int <> 1 OR (v_new ->> 'programs_copied')::int <> 1 THEN
        RAISE EXCEPTION 'the rollover did not report a draft with one division and one program: %', v_new;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.divisions d WHERE d.season_settings_id = v_s2 AND d.name = 'Smoke U10'
                      AND d.birthdate_start = '2016-08-01' AND d.birthdate_end = '2017-07-31' AND d.max_roster_size = 12) THEN
        RAISE EXCEPTION 'the copied division lost a column or its window did not move one year';
    END IF;
    IF (SELECT count(*) FROM public.players WHERE season_settings_id = v_s2) + (SELECT count(*) FROM public.coaches WHERE season_settings_id = v_s2) <> 0 THEN
        RAISE EXCEPTION 'the rollover copied a player or a coach';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.programs p WHERE p.season_settings_id = v_s2 AND p.name = 'Smoke Minis' AND p.copied_from_program_id = v_prog)
       OR (SELECT count(*) FROM public.programs p WHERE p.season_settings_id = v_s2 AND p.is_default) <> 1 THEN
        RAISE EXCEPTION 'the programs were not copied with exactly one default';
    END IF;
    RAISE NOTICE 'rollover: a draft with the divisions (window moved a year) and programs, and no people';

    -- A custom cutoff on the empty draft.
    PERFORM public.admin_update_draft_season(v_s2, '{"age_cutoff_mode": "custom", "age_cutoff_month": 9, "age_cutoff_day": 1}'::jsonb);
    IF NOT EXISTS (SELECT 1 FROM public.season_settings s WHERE s.id = v_s2 AND s.age_cutoff_mode = 'custom' AND s.age_cutoff_month = 9 AND s.age_cutoff_day = 1) THEN
        RAISE EXCEPTION 'the custom cutoff was not stored';
    END IF;

    -- An import into the draft.
    v_job := (public.create_import_job(v_org, 'players', 'smoke-draft.csv', v_s2)).id;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
    VALUES (v_org, v_job, 1, '{}'::jsonb,
            '{"first_name": "Smoke", "last_name": "Draft", "external_registration_id": "SR-1", "division": "Smoke U10", "natural_age": "10"}'::jsonb);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    -- Staged rows not yet applied: the rule cannot move under them.
    BEGIN
        PERFORM public.admin_update_draft_season(v_s2, '{"age_cutoff_mode": "birth_year"}'::jsonb);
        v_refused := 'allowed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
        v_refused := v_state || ':' || v_detail;
    END;
    IF v_refused <> '22023:import_pending' THEN
        RAISE EXCEPTION 'a cutoff change with an import pending gave "%"', v_refused;
    END IF;
    v_fin := public.finalize_import_job(v_job);
    IF (v_fin ->> 'inserted_players')::int <> 1 OR (v_fin ->> 'updated_players')::int <> 0 THEN
        RAISE EXCEPTION 'the import into the draft did not insert one new player: %', v_fin;
    END IF;
    IF (SELECT to_jsonb(p) FROM public.players p WHERE p.external_registration_id = 'SR-1' AND p.season_settings_id = v_s1) IS DISTINCT FROM v_before THEN
        RAISE EXCEPTION 'the import into the draft changed the active season''s player';
    END IF;
    IF (SELECT p.last_name FROM public.players p WHERE p.external_registration_id = 'SR-1' AND p.season_settings_id = v_s2) <> 'Draft' THEN
        RAISE EXCEPTION 'the draft has no row of its own for the registration id';
    END IF;
    RAISE NOTICE 'import into a draft: a new row there, the active season''s row untouched';

    -- With players, the rule is fixed.
    BEGIN
        PERFORM public.admin_update_draft_season(v_s2, '{"age_cutoff_mode": "birth_year"}'::jsonb);
        v_refused := 'allowed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
        v_refused := v_state || ':' || v_detail;
    END;
    IF v_refused <> '22023:season_has_players' THEN
        RAISE EXCEPTION 'a cutoff change on a draft with players gave "%"', v_refused;
    END IF;
    BEGIN
        PERFORM public.admin_set_division_birthdate_window((SELECT d.id FROM public.divisions d WHERE d.season_settings_id = v_s2), NULL, NULL);
        v_refused := 'allowed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
        v_refused := v_state || ':' || v_detail;
    END;
    IF v_refused <> '22023:season_has_players' THEN
        RAISE EXCEPTION 'a window change in a season with players gave "%"', v_refused;
    END IF;
    RAISE NOTICE 'with players, the cutoff and a division window are fixed';

    -- Activation.
    PERFORM public.admin_activate_season(v_s2);
    SELECT count(*) INTO v_n FROM public.season_settings WHERE organization_id = v_org AND status = 'active';
    IF v_n <> 1 OR (SELECT status FROM public.season_settings WHERE id = v_s1) <> 'completed'
       OR (SELECT status FROM public.season_settings WHERE id = v_s2) <> 'active' THEN
        RAISE EXCEPTION 'activation did not leave the draft active and the old season completed';
    END IF;
    BEGIN
        PERFORM public.admin_activate_season(v_s1);
        v_refused := 'allowed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
        v_refused := v_state || ':' || v_detail;
    END;
    IF v_refused <> '22023:season_completed' THEN
        RAISE EXCEPTION 'reactivating a completed season gave "%"', v_refused;
    END IF;
    BEGIN
        PERFORM public.admin_update_player((SELECT p.id FROM public.players p WHERE p.external_registration_id = 'SR-1' AND p.season_settings_id = v_s1),
                                           '{"notes": "late"}'::jsonb);
        v_refused := 'allowed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
        v_refused := v_state || ':' || v_detail;
    END;
    IF v_refused <> '22023:season_completed' THEN
        RAISE EXCEPTION 'a player patch in a completed season gave "%"', v_refused;
    END IF;
    -- Its schedule is read-only too: a team of the completed season cannot be written.
    BEGIN
        UPDATE public.teams SET notes = 'late' WHERE division_id = v_d1;
        v_refused := 'allowed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_detail = PG_EXCEPTION_DETAIL;
        v_refused := v_state || ':' || v_detail;
    END;
    IF v_refused <> '22023:season_completed' THEN
        RAISE EXCEPTION 'a team write in a completed season gave "%"', v_refused;
    END IF;
    RAISE NOTICE 'activation: one active season, the old one completed, read-only (people and schedules), never reactivated';
END;
$$;

ROLLBACK;

-- ---- the season lock: a second session waits on an open activation -----------
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TEMP TABLE sr_ids (name text PRIMARY KEY, id uuid NOT NULL);

-- The committed fixture: two organizations, each with an active season and a draft.
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid; v_other uuid; v_a uuid; v_d uuid; v_oa uuid; v_od uuid;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES (v_admin, 'sr-race@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'sr-race@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Race One', 'smoke-org-race-one') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Race Two', 'smoke-org-race-two') RETURNING id INTO v_other;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, v_admin, 'admin'), (v_other, v_admin, 'admin');
    DELETE FROM public.season_settings WHERE organization_id IN (v_org, v_other);
    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_start, season_end, timezone)
        VALUES (v_org, 'Race A', 'active', 2026, '2026-08-01', '2027-06-30', 'America/Chicago') RETURNING id INTO v_a;
    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_start, season_end, timezone)
        VALUES (v_org, 'Race D', 'draft', 2027, '2027-08-01', '2028-06-30', 'America/Chicago') RETURNING id INTO v_d;
    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_start, season_end, timezone)
        VALUES (v_other, 'Other A', 'active', 2026, '2026-08-01', '2027-06-30', 'America/Chicago') RETURNING id INTO v_oa;
    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_start, season_end, timezone)
        VALUES (v_other, 'Other D', 'draft', 2027, '2027-08-01', '2028-06-30', 'America/Chicago') RETURNING id INTO v_od;
    INSERT INTO sr_ids VALUES ('admin', v_admin), ('org', v_org), ('other', v_other), ('a', v_a), ('d', v_d), ('oa', v_oa), ('od', v_od);
END;
$$;

BEGIN;
DO $$
DECLARE
    v_admin uuid := (SELECT id FROM sr_ids WHERE name = 'admin');
    v_a uuid := (SELECT id FROM sr_ids WHERE name = 'a');
    v_d uuid := (SELECT id FROM sr_ids WHERE name = 'd');
    v_od uuid := (SELECT id FROM sr_ids WHERE name = 'od');
    v_conn text := 'sr_racer';
    v_state text; v_msg text;
    v_activate text; v_rollover text; v_control text;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.admin_activate_season(v_d);     -- held open: the organization's lock is taken

    PERFORM dblink_connect(v_conn, format('dbname=%s host=%s port=%s user=%s',
        current_database(), split_part(current_setting('unix_socket_directories'), ',', 1),
        current_setting('port'), current_user));
    PERFORM dblink_exec(v_conn, format('SET request.jwt.claim.sub = %L', v_admin));
    PERFORM dblink_exec(v_conn, 'SET lock_timeout = ''1s''');

    BEGIN
        PERFORM dblink_exec(v_conn, 'BEGIN');
        PERFORM 1 FROM dblink(v_conn, format('SELECT public.admin_activate_season(%L)::text', v_d)) AS t(r text);
        v_activate := 'ran';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_activate := v_state;
    END;
    PERFORM dblink_exec(v_conn, 'ROLLBACK');
    BEGIN
        PERFORM dblink_exec(v_conn, 'BEGIN');
        PERFORM 1 FROM dblink(v_conn, format('SELECT public.admin_create_season_from(%L, ''Race Next'', 2028)::text', v_a)) AS t(r text);
        v_rollover := 'ran';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_rollover := v_state;
    END;
    PERFORM dblink_exec(v_conn, 'ROLLBACK');
    -- The control: the other organization's activation is not held up.
    BEGIN
        PERFORM dblink_exec(v_conn, 'BEGIN');
        PERFORM 1 FROM dblink(v_conn, format('SELECT public.admin_activate_season(%L)::text', v_od)) AS t(r text);
        v_control := 'ran';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_control := v_state || ' ' || v_msg;
    END;
    PERFORM dblink_exec(v_conn, 'ROLLBACK');
    PERFORM dblink_disconnect(v_conn);

    IF v_activate <> '55P03' OR v_rollover <> '55P03' OR v_control <> 'ran' THEN
        RAISE EXCEPTION 'season lock: a second activation gave "%", a rollover gave "%", the other organization gave "%"', v_activate, v_rollover, v_control;
    END IF;
    RAISE NOTICE 'season lock: while an activation was open, a second activation and a rollover in the organization timed out 55P03; another organization''s ran at once';
END;
$$;
ROLLBACK;

-- The committed fixture goes (deleting an organization cascades to its seasons and rows).
DELETE FROM public.organizations WHERE id IN (SELECT id FROM sr_ids WHERE name IN ('org', 'other'));
DELETE FROM public.profiles WHERE id = (SELECT id FROM sr_ids WHERE name = 'admin');
DELETE FROM auth.users WHERE id = (SELECT id FROM sr_ids WHERE name = 'admin');

DROP EXTENSION dblink;
