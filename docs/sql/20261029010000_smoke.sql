-- Smoke checks for 20261029010000_practice_only_divisions.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * posture: the settings, reservation, finalize and rollback writers are
--     definers pinned to search_path public and TimeZone UTC, callable by
--     `authenticated` and not `anon`; the ten-argument settings writer is
--     gone; the clash rule (`practice_slot_conflicts`) is callable by no
--     client role; `divisions.plays_games` is NOT NULL DEFAULT true and
--     `practice_slots.division_id` references a division of the slot's own
--     organization;
--   * the clash rule, on a planted pitch with two halves: overlap and a start
--     10 minutes after another's end clash, 15 minutes does not, either
--     order; the other half never clashes; the whole field clashes with each
--     half; windows that share no date, or share dates on no day of the
--     slot's weekday, never clash; the slot itself is excluded;
--   * plays_games through the settings writer: a new division plays games
--     unless told; false is stored and audited with its before and after; a
--     save without it keeps it and changes nothing, by name or by id; a save
--     changing only it changes it;
--   * the reservation writer: an admin sets and clears one (one audit row
--     each, before and after), a repeat changes and audits nothing, a
--     division of another organization is refused 22023, a coach and another
--     organization's admin 42501, nothing written;
--   * the fields CSV: a practice row's Division reserves its slot, named in
--     the season the import attaches to (a same-named division of another
--     season of the organization is not it); an unknown name fails the row,
--     writing nothing; a clashing practice row fails before its new ground is
--     written; a game row's division is read as before (organization-wide, an
--     unknown name left blank); a re-import with no Division keeps the
--     reservation; a rollback of a re-import that changed it puts it back.
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
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('admin_upsert_division_settings', 'admin_set_practice_slot_division',
                         'finalize_field_import_job', 'rollback_field_import_job')
       AND NOT (p.prosecdef
                AND 'search_path=public' = ANY (p.proconfig)
                AND 'TimeZone=UTC' = ANY (p.proconfig)
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'not a pinned definer callable by authenticated and not anon: %', v_left;
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('admin_upsert_division_settings', 'admin_set_practice_slot_division',
                             'finalize_field_import_job', 'rollback_field_import_job')) <> 4 THEN
        RAISE EXCEPTION 'expected exactly one of each of the 4 writers the posture check reads (the old settings signature included)';
    END IF;
    IF to_regprocedure('public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean)') IS NULL THEN
        RAISE EXCEPTION 'the settings writer does not take plays_games';
    END IF;
    IF has_function_privilege('authenticated', 'public.practice_slot_conflicts(uuid, uuid, uuid, public.day_of_week, time, time, date, date, uuid, integer)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.practice_slot_conflicts(uuid, uuid, uuid, public.day_of_week, time, time, date, date, uuid, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'practice_slot_conflicts is callable by a client role';
    END IF;
    IF (SELECT format('%s|%s', a.attnotnull, pg_get_expr(d.adbin, d.adrelid))
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = 'public.divisions'::regclass AND a.attname = 'plays_games' AND NOT a.attisdropped)
       IS DISTINCT FROM 't|true' THEN
        RAISE EXCEPTION 'divisions.plays_games is not NOT NULL DEFAULT true';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.practice_slots'::regclass AND c.contype = 'f'
                      AND c.confrelid = 'public.divisions'::regclass
                      AND pg_get_constraintdef(c.oid) LIKE 'FOREIGN KEY (division_id, organization_id) REFERENCES divisions(id, organization_id)%') THEN
        RAISE EXCEPTION 'practice_slots.division_id does not reference a division of the same organization';
    END IF;
    RAISE NOTICE 'posture: the four writers are pinned definers for authenticated, not anon (the settings writer takes plays_games, its ten-argument form gone); the clash rule is no client''s; plays_games NOT NULL DEFAULT true; a reservation references a division of the slot''s organization';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The rule, the writers and the import.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();
    v_org uuid; v_other uuid;
    v_old_season uuid; v_season uuid; v_other_season uuid;
    v_u4 uuid; v_u4_old uuid; v_u10 uuid; v_other_div uuid;
    v_loc uuid; v_field uuid; v_half_a uuid; v_half_b uuid;
    v_slot uuid; v_slot_b uuid;
    v_job uuid; v_job2 uuid;
    v_res jsonb;
    v_refused int;
    v_got text;
    v_n int;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'd2-admin@example.test', '{"password_length": 16}'),
        (v_coach, 'd2-coach@example.test', '{"password_length": 16}'),
        (v_outsider, 'd2-outsider@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'd2-admin@example.test'), (v_coach, 'd2-coach@example.test'),
        (v_outsider, 'd2-outsider@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('D2 Smoke Org', 'd2-smoke-org') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('D2 Smoke Other', 'd2-smoke-other') RETURNING id INTO v_other;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_coach, 'coach'), (v_other, v_outsider, 'admin');
    -- Two seasons: last year's (completed) also has a U4, which a practice
    -- row's Division must not reach.
    INSERT INTO public.season_settings (organization_id, name, status, season_start)
        VALUES (v_org, 'D2 Last Year', 'completed', '2025-08-01') RETURNING id INTO v_old_season;
    INSERT INTO public.season_settings (organization_id, name, status, season_start)
        VALUES (v_org, 'D2 This Year', 'active', '2026-08-01') RETURNING id INTO v_season;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_other, 'D2 Other') RETURNING id INTO v_other_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_old_season, 'U4') RETURNING id INTO v_u4_old;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_old_season, 'U6 Last Year');
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_season, 'U10') RETURNING id INTO v_u10;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_other, v_other_season, 'U10') RETURNING id INTO v_other_div;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'D2 Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, supports_halves) VALUES (v_org, v_loc, 'Pitch 1', true) RETURNING id INTO v_field;
    INSERT INTO public.field_subunits (organization_id, field_id, label) VALUES (v_org, v_field, 'A') RETURNING id INTO v_half_a;
    INSERT INTO public.field_subunits (organization_id, field_id, label) VALUES (v_org, v_field, 'B') RETURNING id INTO v_half_b;
    -- The slot every probe is judged against: half A, Saturdays 09:00-09:30,
    -- 2026-09-05 (a Saturday) to 2026-11-28 (a Saturday).
    INSERT INTO public.practice_slots (organization_id, field_id, field_subunit_id, day_of_week, start_time, end_time, valid_from, valid_until)
        VALUES (v_org, v_field, v_half_a, 'sat', '09:00', '09:30', '2026-09-05', '2026-11-28') RETURNING id INTO v_slot;

    -- ---- The rule ----------------------------------------------------------
    SELECT string_agg(format('%s=%s', x.label, (SELECT count(*) FROM public.practice_slot_conflicts(
               v_org, v_field, x.sub, 'sat', x.s, x.e, x.f, x.u, x.excl))), ',' ORDER BY x.label) INTO v_got
      FROM (VALUES
          ('a overlap', v_half_a, '09:15'::time, '09:45'::time, '2026-09-05'::date, '2026-11-28'::date, NULL::uuid),
          ('b after 10', v_half_a, '09:40', '10:10', '2026-09-05', '2026-11-28', NULL),
          ('c after 15', v_half_a, '09:45', '10:15', '2026-09-05', '2026-11-28', NULL),
          ('d before 10', v_half_a, '08:20', '08:50', '2026-09-05', '2026-11-28', NULL),
          ('e before 15', v_half_a, '08:15', '08:45', '2026-09-05', '2026-11-28', NULL),
          ('f other half', v_half_b, '09:00', '09:30', '2026-09-05', '2026-11-28', NULL),
          ('g whole field', NULL, '09:00', '09:30', '2026-09-05', '2026-11-28', NULL),
          ('h december', v_half_a, '09:00', '09:30', '2026-12-05', '2026-12-19', NULL),
          ('i no saturday', v_half_a, '09:00', '09:30', '2026-11-23', '2026-11-27', NULL),
          ('j last saturday', v_half_a, '09:00', '09:30', '2026-11-28', '2026-12-04', NULL),
          ('k open dates', v_half_a, '09:00', '09:30', NULL, NULL, NULL),
          ('l itself', v_half_a, '09:00', '09:30', '2026-09-05', '2026-11-28', v_slot)
      ) AS x(label, sub, s, e, f, u, excl);
    IF v_got IS DISTINCT FROM 'a overlap=1,b after 10=1,c after 15=0,d before 10=1,e before 15=0,f other half=0,g whole field=1,h december=0,i no saturday=0,j last saturday=1,k open dates=1,l itself=0' THEN
        RAISE EXCEPTION 'the clash rule: %', v_got;
    END IF;
    RAISE NOTICE 'clash rule: overlap and 10 minutes either side clash, 15 does not; the other half never, the whole field always; December, and dates that share no Saturday, never; the last shared Saturday and open dates do; a slot not with itself';

    -- ---- plays_games through the settings writer ---------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    v_res := public.admin_upsert_division_settings(v_org, v_season, NULL, 'U4', 15, NULL, NULL, 4, NULL, NULL, false);
    v_u4 := (v_res ->> 'id')::uuid;
    v_got := public.admin_upsert_division_settings(v_org, v_season, NULL, 'U4', 15, NULL, NULL, 4, NULL, NULL)::text;
    v_res := public.admin_upsert_division_settings(v_org, v_season, NULL, 'U5', 10, NULL, NULL, NULL, NULL, NULL);
    RESET ROLE;
    IF (SELECT plays_games FROM public.divisions WHERE id = v_u4) IS DISTINCT FROM false
       OR (v_got::jsonb ->> 'changed')::boolean IS DISTINCT FROM false
       OR (v_got::jsonb ->> 'plays_games')::boolean IS DISTINCT FROM false
       OR (v_res ->> 'plays_games')::boolean IS DISTINCT FROM true
       OR (SELECT count(*) FROM public.audit_log
            WHERE organization_id = v_org AND action = 'settings.updated' AND resource_id = v_u4
              AND jsonb_typeof(metadata -> 'previous') = 'null' AND metadata -> 'current' ->> 'plays_games' = 'false') <> 1
       OR (SELECT count(*) FROM public.audit_log
            WHERE organization_id = v_org AND action = 'settings.updated' AND resource_id = v_u4) <> 1 THEN
        RAISE EXCEPTION 'the settings writer did not store plays_games false (audited once), keep it on a save without it, or default a new division to playing';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    v_res := public.admin_upsert_division_settings(v_org, v_season, v_u10, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false);
    RESET ROLE;
    IF (SELECT format('%s>%s', metadata -> 'previous' ->> 'plays_games', metadata -> 'current' ->> 'plays_games')
          FROM public.audit_log
         WHERE organization_id = v_org AND action = 'settings.updated' AND resource_id = v_u10) IS DISTINCT FROM 'true>false' THEN
        RAISE EXCEPTION 'turning U10 practice-only was not audited true>false';
    END IF;
    -- A save by id that changes the roster size but not the setting keeps U10
    -- practice-only (it writes the row); one by name that changes nothing but
    -- the setting turns it back.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    v_got := public.admin_upsert_division_settings(v_org, v_season, v_u10, NULL, 12, NULL, NULL, NULL, NULL, NULL)::text;
    v_res := public.admin_upsert_division_settings(v_org, v_season, NULL, 'U10', 12, NULL, NULL, NULL, NULL, NULL, true);
    RESET ROLE;
    IF (v_got::jsonb ->> 'plays_games')::boolean IS DISTINCT FROM false
       OR (v_got::jsonb ->> 'changed')::boolean IS DISTINCT FROM true
       OR (v_got::jsonb ->> 'max_roster_size')::int IS DISTINCT FROM 12
       OR (v_res ->> 'changed')::boolean IS DISTINCT FROM true
       OR (SELECT plays_games FROM public.divisions WHERE id = v_u10) IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'a save by id without plays_games did not keep it (%), or a save by name changing only plays_games did not change it (%)', v_got, v_res;
    END IF;
    RAISE NOTICE 'settings writer: a new division plays unless told; false stored and audited once with its before and after; a save without it keeps it and changes nothing, by name or by id; a save changing only it changes it';

    -- ---- The reservation writer --------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    v_res := public.admin_set_practice_slot_division(v_slot, v_u4);
    v_got := public.admin_set_practice_slot_division(v_slot, v_u4)::text;
    RESET ROLE;
    IF (v_res ->> 'changed')::boolean IS DISTINCT FROM true
       OR (v_got::jsonb ->> 'changed')::boolean IS DISTINCT FROM false
       OR (SELECT division_id FROM public.practice_slots WHERE id = v_slot) IS DISTINCT FROM v_u4
       OR (SELECT count(*) FROM public.audit_log
            WHERE organization_id = v_org AND action = 'practice_slot.division_set' AND resource_id = v_slot
              AND metadata -> 'previous' ->> 'division_id' IS NULL
              AND metadata -> 'current' ->> 'name' = 'U4') <> 1
       OR (SELECT count(*) FROM public.audit_log
            WHERE organization_id = v_org AND action = 'practice_slot.division_set') <> 1 THEN
        RAISE EXCEPTION 'an admin''s reservation was not stored and audited once, or its repeat changed or audited something';
    END IF;

    v_refused := 0;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM public.admin_set_practice_slot_division(v_slot, v_other_div);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_refused := v_refused + 1;
    END;
    RESET ROLE;
    FOREACH v_got IN ARRAY ARRAY[v_coach::text, v_outsider::text] LOOP
        PERFORM set_config('request.jwt.claim.sub', v_got, true);
        SET LOCAL ROLE authenticated;
        BEGIN
            PERFORM public.admin_set_practice_slot_division(v_slot, NULL);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1;
        END;
        RESET ROLE;
    END LOOP;
    IF v_refused <> 3 OR (SELECT division_id FROM public.practice_slots WHERE id = v_slot) IS DISTINCT FROM v_u4 THEN
        RAISE EXCEPTION 'the reservation writer refused % of 3 (another organization''s division 22023, a coach and an outside admin 42501), or the reservation moved', v_refused;
    END IF;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    v_res := public.admin_set_practice_slot_division(v_slot, NULL);
    RESET ROLE;
    IF (SELECT division_id FROM public.practice_slots WHERE id = v_slot) IS NOT NULL
       OR (SELECT count(*) FROM public.audit_log
            WHERE organization_id = v_org AND action = 'practice_slot.division_set' AND resource_id = v_slot
              AND metadata -> 'previous' ->> 'name' = 'U4' AND metadata -> 'current' ->> 'division_id' IS NULL) <> 1 THEN
        RAISE EXCEPTION 'an admin''s clear was not stored and audited with U4 before it';
    END IF;
    RAISE NOTICE 'reservation writer: an admin set and cleared one, audited once each with the before and after; the repeat changed nothing; another organization''s division 22023, a coach and an outside admin 42501, 3 of 3, nothing written';

    -- ---- The fields CSV ----------------------------------------------------
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, total_rows)
        VALUES (v_org, 'fields', 'd2/fields.csv', 'importing', 6) RETURNING id INTO v_job;
    INSERT INTO public.staging_import_rows
        (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    SELECT v_org, v_job, 'fields', r.n, '{}'::jsonb, jsonb_strip_nulls(r.p), '[]'::jsonb
      FROM (VALUES
          -- 1: half B at the stored slot's time, reserved to this season's U4.
          (1, jsonb_build_object('location', 'd2 park', 'name', 'pitch 1', 'subunit', 'b', 'type', 'practice',
               'day', 'Sat', 'start', '09:00', 'end', '09:30', 'valid_from', '2026-09-05',
               'valid_until', '2026-11-28', 'division_name', 'u4')),
          -- 2: a division only last season has.
          (2, jsonb_build_object('location', 'D2 Park', 'name', 'Pitch 1', 'subunit', 'B', 'type', 'practice',
               'day', 'Sat', 'start', '10:00', 'end', '10:30', 'valid_from', '2026-09-05',
               'valid_until', '2026-11-28', 'division_name', 'U6 Last Year')),
          -- 3: a name nobody has, on ground that does not exist yet.
          (3, jsonb_build_object('location', 'D2 Nowhere', 'name', 'Pitch 9', 'type', 'practice',
               'day', 'Sat', 'start', '09:00', 'end', '09:30', 'valid_from', '2026-09-05',
               'valid_until', '2026-11-28', 'division_name', 'U99')),
          -- 4: half A, starting 10 minutes after the stored slot ends.
          (4, jsonb_build_object('location', 'D2 Park', 'name', 'Pitch 1', 'subunit', 'A', 'type', 'practice',
               'day', 'Sat', 'start', '09:40', 'end', '10:10', 'valid_from', '2026-09-05',
               'valid_until', '2026-11-28')),
          -- 5: a new half C at the stored slot's time: no clash.
          (5, jsonb_build_object('location', 'D2 Park', 'name', 'Pitch 1', 'subunit', 'C', 'type', 'practice',
               'day', 'Sat', 'start', '09:00', 'end', '09:30', 'valid_from', '2026-09-05',
               'valid_until', '2026-11-28')),
          -- 6: a game row naming an unknown division: applied, as before.
          (6, jsonb_build_object('location', 'D2 Park', 'name', 'Pitch 2', 'type', 'game',
               'slot_date', '2026-09-12', 'start', '09:00', 'end', '10:00', 'division_name', 'U99'))
      ) AS r(n, p);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    v_res := public.finalize_field_import_job(v_job, '[]'::jsonb);
    RESET ROLE;
    SELECT string_agg(format('%s:%s', source_row_number,
                             COALESCE(validation_errors -> 0 ->> 'reason', CASE WHEN applied_at IS NULL THEN '?' ELSE 'applied' END)),
                      ',' ORDER BY source_row_number) INTO v_got
      FROM public.staging_import_rows WHERE import_job_id = v_job;
    IF v_got IS DISTINCT FROM '1:applied,2:division_unknown,3:division_unknown,4:practice_slot_conflict,5:applied,6:applied' THEN
        RAISE EXCEPTION 'the fields CSV rows: %', v_got;
    END IF;
    SELECT ps.id INTO v_slot_b FROM public.practice_slots ps
     WHERE ps.field_subunit_id = v_half_b AND ps.start_time = '09:00';
    IF (SELECT division_id FROM public.practice_slots WHERE id = v_slot_b) IS DISTINCT FROM v_u4
       OR EXISTS (SELECT 1 FROM public.locations WHERE organization_id = v_org AND name = 'D2 Nowhere')
       OR (SELECT count(*) FROM public.practice_slots WHERE field_subunit_id = v_half_a) <> 1
       OR (SELECT count(*) FROM public.game_slots WHERE organization_id = v_org AND division_id IS NULL) <> 1
       OR (v_res ->> 'invalid_rows')::int <> 3 THEN
        RAISE EXCEPTION 'the import reserved the wrong division, wrote a refused row''s ground or slot, or changed how a game row reads its division';
    END IF;

    -- A re-import of the reserved slot with no Division keeps it; one naming
    -- U10 changes it, and rolling that back puts U4 back.
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, total_rows)
        VALUES (v_org, 'fields', 'd2/fields-2.csv', 'importing', 1) RETURNING id INTO v_job2;
    INSERT INTO public.staging_import_rows
        (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES (v_org, v_job2, 'fields', 1, '{}'::jsonb,
            jsonb_build_object('location', 'D2 Park', 'name', 'Pitch 1', 'subunit', 'B', 'type', 'practice',
               'day', 'Sat', 'start', '09:00', 'end', '09:30', 'valid_from', '2026-09-05',
               'valid_until', '2026-11-21'), '[]'::jsonb);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.finalize_field_import_job(v_job2, '[]'::jsonb);
    RESET ROLE;
    IF (SELECT format('%s|%s', division_id = v_u4, valid_until) FROM public.practice_slots WHERE id = v_slot_b)
       IS DISTINCT FROM 't|2026-11-21' THEN
        RAISE EXCEPTION 'a re-import with no Division (and a shorter window, which clashes with nothing but itself) did not keep the reservation';
    END IF;
    INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, total_rows)
        VALUES (v_org, 'fields', 'd2/fields-3.csv', 'importing', 1) RETURNING id INTO v_job2;
    INSERT INTO public.staging_import_rows
        (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
    VALUES (v_org, v_job2, 'fields', 1, '{}'::jsonb,
            jsonb_build_object('location', 'D2 Park', 'name', 'Pitch 1', 'subunit', 'B', 'type', 'practice',
               'day', 'Sat', 'start', '09:00', 'end', '09:30', 'valid_from', '2026-09-05',
               'valid_until', '2026-11-21', 'division', 'U10'), '[]'::jsonb);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.finalize_field_import_job(v_job2, '[]'::jsonb);
    v_n := CASE WHEN (SELECT division_id FROM public.practice_slots WHERE id = v_slot_b) = v_u10 THEN 1 ELSE 0 END;
    PERFORM public.rollback_field_import_job(v_job2);
    RESET ROLE;
    IF v_n <> 1 OR (SELECT division_id FROM public.practice_slots WHERE id = v_slot_b) IS DISTINCT FROM v_u4 THEN
        RAISE EXCEPTION 'a re-import naming U10 did not move the reservation (%), or its rollback did not put U4 back', v_n;
    END IF;
    RAISE NOTICE 'fields CSV: a practice row''s Division reserved its slot in this season (not last season''s U4 or its U6); an unknown name and last season''s failed their rows, writing no ground; a clash failed its row; a new half applied; a game row''s unknown division stayed blank, as before; a re-import kept the reservation, another moved it, and its rollback put it back';
END;
$$;

ROLLBACK;
