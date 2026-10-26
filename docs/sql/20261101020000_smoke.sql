-- Smoke checks for 20261101020000_programs.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK
-- (the lock probe uses a second `dblink` session that holds a lock and commits nothing).
--
--   1. Posture: every season has exactly one default program and every division is in a
--      program of its own season; the table is read-only to a client; the writers are closed to anon.
--   2. A season made after the migration gets its default program (by the trigger), and a division
--      inserted into it with no program joins that default.
--   3. The four writers, as an admin: create, rename (the default refuses), assign and move a
--      division, NULL removes it to the default, delete moves the divisions to the default, merge
--      moves them to the target; each success leaves one audit row and each refusal none; another
--      season's program is 23503; a completed season, a coach and another organization's admin
--      are refused.
--   4. The season lock: while another session holds the organization's season lock, a program
--      write waits for it (it is the lock Phase E3's rollover and activation take).
--   5. The demo league has its programs: Minis, Micro, Junior and Select span divisions, and U9, U10
--      and U12 stay in the season's default.
--
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

CREATE EXTENSION IF NOT EXISTS dblink;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach uuid := gen_random_uuid();
    v_other uuid := gen_random_uuid();
    v_visitor uuid := gen_random_uuid();
    v_org uuid;
    v_other_org uuid;
    v_active uuid;
    v_draft uuid;
    v_done uuid;
    v_other_season uuid;
    v_div1 uuid;
    v_div2 uuid;
    v_div3 uuid;
    v_done_div uuid;
    v_junior uuid;
    v_micro uuid;
    v_default uuid;
    v_res jsonb;
    v_n integer;
    v_audit_before integer;
    v_state text;
    v_msg text;
    v_wait text;
    v_demo uuid;
    v_list text;
    c_actions constant text[] := ARRAY['program.upserted', 'program.deleted', 'program.merged', 'division.program_changed'];
BEGIN
    -- ---- 1. posture ----------------------------------------------------------
    SELECT count(*) INTO v_n FROM public.season_settings s
     WHERE (SELECT count(*) FROM public.programs p WHERE p.season_settings_id = s.id AND p.is_default) <> 1;
    IF v_n <> 0 THEN RAISE EXCEPTION '% season(s) do not have exactly one default program', v_n; END IF;
    SELECT count(*) INTO v_n FROM public.divisions d
     WHERE NOT EXISTS (SELECT 1 FROM public.programs p WHERE p.id = d.program_id AND p.season_settings_id = d.season_settings_id);
    IF v_n <> 0 THEN RAISE EXCEPTION '% division(s) are in no program of their own season', v_n; END IF;
    IF has_table_privilege('anon', 'public.programs', 'SELECT')
       OR has_table_privilege('authenticated', 'public.programs', 'INSERT')
       OR has_table_privilege('authenticated', 'public.programs', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.programs', 'DELETE') THEN
        RAISE EXCEPTION 'programs is open to a client write or to anon';
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('admin_upsert_program', 'admin_set_division_program', 'admin_delete_program', 'admin_merge_programs')
           AND p.prosecdef AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 4 THEN
        RAISE EXCEPTION 'a program writer is not a definer for authenticated only';
    END IF;
    RAISE NOTICE 'posture: % season(s) each with one default program, % division(s) each in a program of their own season; programs read-only to clients, the four writers closed to anon',
        (SELECT count(*) FROM public.season_settings), (SELECT count(*) FROM public.divisions);

    -- ---- seed ----------------------------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'prog-admin@example.test', '{"password_length": 16}'),
        (v_coach, 'prog-coach@example.test', '{"password_length": 16}'),
        (v_other, 'prog-other@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'prog-admin@example.test'), (v_coach, 'prog-coach@example.test'), (v_other, 'prog-other@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Program Org', 'smoke-program-org') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Program Other', 'smoke-program-other') RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_coach, 'coach'), (v_other_org, v_other, 'admin');

    -- ---- 2. a season made now gets its default; a division joins it ---------------------
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Prog 2026', 'active') RETURNING id INTO v_active;
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Prog 2027', 'draft') RETURNING id INTO v_draft;
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Prog 2025', 'completed') RETURNING id INTO v_done;
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_other_org, 'Prog Other', 'active') RETURNING id INTO v_other_season;
    SELECT count(*) INTO v_n FROM public.programs WHERE organization_id = v_org AND is_default AND name = 'No program';
    IF v_n <> 3 THEN RAISE EXCEPTION 'the three new seasons got % default program(s), expected 3', v_n; END IF;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_active, 'Prog U7B') RETURNING id INTO v_div1;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_active, 'Prog U7G') RETURNING id INTO v_div2;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_active, 'Prog U8B') RETURNING id INTO v_div3;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_done, 'Prog Old U7B') RETURNING id INTO v_done_div;
    SELECT p.id INTO v_default FROM public.programs p WHERE p.season_settings_id = v_active AND p.is_default;
    IF (SELECT count(*) FROM public.divisions WHERE season_settings_id = v_active AND program_id = v_default) <> 3 THEN
        RAISE EXCEPTION 'divisions inserted with no program did not join the season''s default';
    END IF;
    BEGIN
        INSERT INTO public.divisions (organization_id, season_settings_id, name, program_id)
        VALUES (v_org, v_active, 'Prog Cross', (SELECT id FROM public.programs WHERE season_settings_id = v_draft AND is_default));
        RAISE EXCEPTION 'a division was put in another season''s program';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    RAISE NOTICE 'a season made now has its default program, a division inserted with no program joins it, and another season''s program is refused (23503)';

    -- ---- 3. the four writers -----------------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

    v_res := public.admin_upsert_program(v_active, NULL, 'Junior');
    v_junior := (v_res ->> 'id')::uuid;
    v_res := public.admin_upsert_program(v_active, NULL, 'Micro');
    v_micro := (v_res ->> 'id')::uuid;
    v_res := public.admin_upsert_program(v_active, v_micro, 'Minis');
    IF v_res ->> 'name' <> 'Minis' OR (v_res ->> 'changed')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'the rename returned %', v_res;
    END IF;
    PERFORM public.admin_set_division_program(v_div1, v_junior);
    PERFORM public.admin_set_division_program(v_div2, v_junior);
    PERFORM public.admin_set_division_program(v_div3, v_micro);
    PERFORM public.admin_set_division_program(v_div3, v_junior);
    PERFORM public.admin_set_division_program(v_div2, NULL);
    SELECT string_agg(d.name || ':' || p.name, ',' ORDER BY d.name) INTO v_list
      FROM public.divisions d JOIN public.programs p ON p.id = d.program_id WHERE d.season_settings_id = v_active;
    IF v_list IS DISTINCT FROM 'Prog U7B:Junior,Prog U7G:No program,Prog U8B:Junior' THEN
        RAISE EXCEPTION 'after the assignments the divisions are in [%]', v_list;
    END IF;
    RAISE NOTICE 'writers: two programs made, one renamed; divisions assigned, moved and removed (to the default): %', v_list;

    SELECT count(*) INTO v_audit_before FROM public.audit_log WHERE organization_id = v_org AND action = ANY (c_actions);
    -- Refusals: the default, a duplicate name, another season's program, a completed season.
    BEGIN
        PERFORM public.admin_upsert_program(v_active, v_default, 'Renamed default');
        RAISE EXCEPTION 'the default program was renamed';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_upsert_program(v_active, NULL, ' junior ');
        RAISE EXCEPTION 'a duplicate program name was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_set_division_program(v_div1, (SELECT id FROM public.programs WHERE season_settings_id = v_draft AND is_default));
        RAISE EXCEPTION 'a division was moved to another season''s program';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_upsert_program(v_active, (SELECT id FROM public.programs WHERE season_settings_id = v_done AND is_default), 'Through the active season');
        RAISE EXCEPTION 'a completed season''s program was edited through the active season';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_upsert_program(v_done, NULL, 'History');
        RAISE EXCEPTION 'a completed season took a program';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_set_division_program(v_done_div, NULL);
        RAISE EXCEPTION 'a completed season''s division was moved';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_delete_program(v_default);
        RAISE EXCEPTION 'the default program was deleted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_merge_programs(v_default, v_junior);
        RAISE EXCEPTION 'the default program was merged away';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
        PERFORM public.admin_merge_programs(v_junior, v_junior);
        RAISE EXCEPTION 'a program was merged into itself';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    IF (SELECT count(*) FROM public.audit_log WHERE organization_id = v_org AND action = ANY (c_actions)) <> v_audit_before THEN
        RAISE EXCEPTION 'a refused program write left an audit row';
    END IF;
    RAISE NOTICE 'refusals: the default cannot be renamed (22023), deleted or merged away, a duplicate name is 23505, another season''s program 23503, a completed season 22023 and a completed program named through the active season 23503; none left an audit row';

    -- Merge Junior into Minis? Minis is empty: move Junior's divisions into it, then delete the empty rest.
    v_res := public.admin_merge_programs(v_junior, v_micro);
    IF jsonb_array_length(v_res -> 'moved_division_ids') <> 2 THEN RAISE EXCEPTION 'the merge moved %', v_res; END IF;
    IF EXISTS (SELECT 1 FROM public.programs WHERE id = v_junior) THEN RAISE EXCEPTION 'the merged source survived'; END IF;
    IF (SELECT p.name FROM public.divisions d JOIN public.programs p ON p.id = d.program_id WHERE d.id = v_div1) <> 'Minis' THEN
        RAISE EXCEPTION 'the merge did not move the division into the target, which keeps its name';
    END IF;
    v_res := public.admin_delete_program(v_micro);
    IF jsonb_array_length(v_res -> 'moved_division_ids') <> 2 THEN RAISE EXCEPTION 'the delete moved %', v_res; END IF;
    IF (SELECT count(*) FROM public.divisions WHERE season_settings_id = v_active AND program_id = v_default) <> 3 THEN
        RAISE EXCEPTION 'after the delete every division is not back in the default program';
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_log WHERE organization_id = v_org AND action = ANY (c_actions);
    IF v_n <> v_audit_before + 2 THEN
        RAISE EXCEPTION 'the merge and the delete left % audit row(s), expected 2', v_n - v_audit_before;
    END IF;
    RAISE NOTICE 'a merge moved 2 divisions into the target (which kept its name) and a delete moved them back to the default; each left one audit row';

    -- A coach and another organization's admin.
    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_coach, 'role', 'authenticated')::text, true);
    BEGIN
        PERFORM public.admin_upsert_program(v_active, NULL, 'Coach made');
        RAISE EXCEPTION 'a coach made a program';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_other, 'role', 'authenticated')::text, true);
    BEGIN
        PERFORM public.admin_set_division_program(v_div1, NULL);
        RAISE EXCEPTION 'another organization''s admin moved a division';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    RAISE NOTICE 'a coach and another organization''s admin are refused (42501)';

    -- ---- 4. the season lock ------------------------------------------------------
    -- Another organization's lock, which this session has not taken (the writers above hold
    -- Smoke Program Org's until the transaction ends): a second session holds it open, and
    -- that organization's admin's program write waits for it.
    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_other, 'role', 'authenticated')::text, true);
    PERFORM dblink_connect('prog_racer', format('dbname=%s host=%s port=%s user=%s',
        current_database(), split_part(current_setting('unix_socket_directories'), ',', 1),
        current_setting('port'), current_user));
    PERFORM dblink_exec('prog_racer', 'BEGIN');
    PERFORM * FROM dblink('prog_racer', format('SELECT pg_advisory_xact_lock(hashtextextended(%L, 0))', 'season:' || v_other_org))
        AS t(r text);
    SET LOCAL lock_timeout = '500ms';
    BEGIN
        PERFORM public.admin_upsert_program(v_other_season, NULL, 'Waits for the lock');
        v_wait := 'returned';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_wait := v_state;
    END;
    PERFORM dblink_exec('prog_racer', 'ROLLBACK');
    PERFORM dblink_disconnect('prog_racer');
    SET LOCAL lock_timeout = 0;
    IF v_wait IS DISTINCT FROM '55P03' THEN
        RAISE EXCEPTION 'a program write while another session held the organization''s season lock gave % instead of waiting', v_wait;
    END IF;
    PERFORM public.admin_upsert_program(v_other_season, NULL, 'Free again');
    RAISE NOTICE 'the season lock: a program write waited (lock_not_available at 500 ms) while another session held the organization''s lock, and ran once it was released';

    -- ---- 5. the demo league's programs --------------------------------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data, is_anonymous) VALUES (v_visitor, NULL, '{"password_length": 12}', true);
    PERFORM set_config('request.jwt.claim.sub', v_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_visitor, 'is_anonymous', true)::text, true);
    v_demo := (public.start_demo_session() ->> 'organization_id')::uuid;
    SELECT string_agg(x, ' | ' ORDER BY x COLLATE "C") INTO v_list FROM (
        SELECT p.name || ':' || string_agg(d.name, ',' ORDER BY d.name) AS x
          FROM public.programs p JOIN public.divisions d ON d.program_id = p.id
         WHERE p.organization_id = v_demo GROUP BY p.id, p.name) s;
    IF v_list IS DISTINCT FROM 'Junior:U7B,U7G,U8B,U8G | Micro:U5B,U5G,U6B,U6G | Minis:U4 | No program:U10B,U10G,U12B,U12G,U9B,U9G | Select:U14B,U14G,U16B,U16G,U19B,U19G' THEN
        RAISE EXCEPTION 'the demo league''s programs are [%]', v_list;
    END IF;
    RAISE NOTICE 'the demo league has its programs: %', v_list;
END;
$$;

ROLLBACK;
