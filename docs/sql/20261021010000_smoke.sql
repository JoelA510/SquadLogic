-- Smoke checks for 20261021010000_server_side_reads.sql
--
-- What it proves, with prelude.sql's `auth.uid()` stub, on the head build:
--   * get_team_roster: an admin gets the rating; the current coach gets
--     names only (since 20261024010000: no rating); a member with no tie to
--     the team and a former coach are refused;
--   * get_team_staff admits the current coach and refuses the unrelated
--     member; a coach whose assignment ended yesterday is no longer current;
--   * the posture: every reader is SECURITY DEFINER with search_path=public,
--     executable by authenticated and not anon; the three internal helpers
--     (org_flag, team_local_today, coached_team_ids_of) by neither;
--   * admin_get_coached_team_ids answers an admin's preview of a coach, and
--     refuses a non-admin.
--
-- **Since 20261024010000 (plan docs/changes/2026-10-22-admin-focus.md, R3)**
-- there is no guardian: `link_my_guardian_records`, `is_team_guardian`,
-- `guardian_contacts_view`, `profile_players` and the
-- `guardian_contact_sharing` setting are gone, and `parent` is no role. The
-- guardian link, guardian roster and teammate-sharing cases went with them;
-- docs/sql/20261024010000_smoke.sql checks they stay gone, and
-- docs/sql/20261021010000_revert.sql is still checked on a build up to this
-- migration. The member with no tie to the team is a coach who coaches none.
--
-- **Since 20261025010000 (R4)** there are no contact surfaces: guardian
-- contacts, the contact card (`set_my_contact_card` and its `profiles`
-- columns), `get_coach_directory` and the `coach_directory` setting are gone,
-- and neither read returns a contact column. The guardian contact, contact
-- card and directory cases went with them; docs/sql/20261025010000_smoke.sql
-- checks they stay gone, and docs/sql/20261021010000_revert.sql is still
-- checked on a build up to this migration.
--
-- Wrapped in BEGIN ... ROLLBACK. Every id is generated; every email is
-- `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach_u uuid := gen_random_uuid();   -- current lead coach of team A
    v_old_u uuid := gen_random_uuid();     -- coach of team A until yesterday
    v_stranger uuid := gen_random_uuid();  -- member with no tie to team A (coaches no team)
    v_org uuid;
    v_s uuid;
    v_d uuid;
    v_ta uuid;
    v_coach uuid;
    v_old uuid;
    v_p1 uuid;
    v_p2 uuid;
    v_n integer;
    v_denied boolean;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
        (v_admin, 'ssr-admin@example.test', '{"password_length": 16}', now()),
        (v_coach_u, 'ssr-coach@example.test', '{"password_length": 16}', now()),
        (v_old_u, 'ssr-old@example.test', '{"password_length": 16}', now()),
        (v_stranger, 'ssr-stranger@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'ssr-admin@example.test'), (v_coach_u, 'ssr-coach@example.test'),
        (v_old_u, 'ssr-old@example.test'), (v_stranger, 'ssr-stranger@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org SSR', 'smoke-org-ssr')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_coach_u, 'coach'), (v_org, v_old_u, 'coach'),
        (v_org, v_stranger, 'coach');
    INSERT INTO public.season_settings (organization_id, name, timezone)
        VALUES (v_org, 'SSR Fall', 'America/Los_Angeles') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org, v_s, 'SSR U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name)
        VALUES (v_org, v_d, 'SSR Team A') RETURNING id INTO v_ta;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_coach_u, 'Coach Current', 'ssr-coach@example.test', 'active')
        RETURNING id INTO v_coach;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_old_u, 'Coach Former', 'ssr-old@example.test', 'active')
        RETURNING id INTO v_old;
    INSERT INTO public.team_coach_assignments
        (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
    VALUES (v_org, v_ta, v_coach, 'lead', public.team_local_today(v_ta) - 30, NULL, 'smoke', NULL),
           (v_org, v_ta, v_old, 'assistant', public.team_local_today(v_ta) - 30,
            public.team_local_today(v_ta) - 1, 'smoke', 'smoke');
    INSERT INTO public.players (organization_id, first_name, last_name, rating)
        VALUES (v_org, 'Pat', 'One', 3)
        RETURNING id INTO v_p1;
    INSERT INTO public.players (organization_id, first_name, last_name, rating)
        VALUES (v_org, 'Sam', 'Two', 4)
        RETURNING id INTO v_p2;
    INSERT INTO public.team_players (team_id, player_id, organization_id)
        VALUES (v_ta, v_p1, v_org), (v_ta, v_p2, v_org);

    -- Roster: admin and coach
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SELECT count(*) INTO v_n FROM public.get_team_roster(v_ta) r WHERE r.rating IS NOT NULL;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'an admin did not get the rating: % of 2', v_n;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_coach_u::text, true);
    SELECT count(*) INTO v_n FROM public.get_team_roster(v_ta) r
     WHERE r.rating IS NULL AND r.first_name IS NOT NULL;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'the current coach did not get names only (no rating): % of 2', v_n;
    END IF;
    RAISE NOTICE 'roster: an admin gets the rating; the current coach gets names only';

    -- Staff
    PERFORM set_config('request.jwt.claim.sub', v_coach_u::text, true);
    SELECT count(*) INTO v_n FROM public.get_team_staff(v_ta);
    IF v_n <> 1 OR (SELECT s.coach_id FROM public.get_team_staff(v_ta) s) <> v_coach THEN
        RAISE EXCEPTION 'staff: the current coach did not get exactly the current coach (% rows)', v_n;
    END IF;
    RAISE NOTICE 'staff: the current coach sees the current coach; the coach whose window ended yesterday is not listed';

    -- Refusals
    PERFORM set_config('request.jwt.claim.sub', v_stranger::text, true);
    BEGIN
        PERFORM * FROM public.get_team_roster(v_ta);
        v_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'an unrelated member read the roster'; END IF;
    BEGIN
        PERFORM * FROM public.get_team_staff(v_ta);
        v_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'an unrelated member read the staff'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_old_u::text, true);
    BEGIN
        PERFORM * FROM public.get_team_roster(v_ta);
        v_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'a coach whose assignment ended read the roster'; END IF;
    RAISE NOTICE 'an unrelated member and a former coach are refused the roster and staff';

    -- Role preview
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SELECT count(*) INTO v_n FROM public.admin_get_coached_team_ids(v_org, v_coach_u) t WHERE t = v_ta;
    IF v_n <> 1 THEN RAISE EXCEPTION 'an admin preview did not see the coach''s team'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_coach_u::text, true);
    BEGIN
        PERFORM * FROM public.admin_get_coached_team_ids(v_org, v_coach_u);
        v_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'a non-admin read another member''s coached teams'; END IF;
    RAISE NOTICE 'role preview: an admin reads a coach''s current teams; the coach is refused the admin read';

    -- Posture
    SELECT count(*) INTO v_n
      FROM pg_proc p
     WHERE p.oid IN ('public.get_team_roster(uuid)'::regprocedure, 'public.get_team_staff(uuid)'::regprocedure,
                     'public.get_my_coached_team_ids(uuid)'::regprocedure,
                     'public.is_current_team_coach(uuid)'::regprocedure,
                     'public.admin_get_coached_team_ids(uuid,uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig = ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 5 THEN
        RAISE EXCEPTION 'posture: % of 5 callable functions are definer, pinned, authenticated-only', v_n;
    END IF;
    IF has_function_privilege('authenticated', 'public.org_flag(uuid,text,boolean)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.team_local_today(uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.coached_team_ids_of(uuid,uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.org_flag(uuid,text,boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'an internal helper is executable by a client role';
    END IF;
    RAISE NOTICE 'posture: 5 of 5 callable functions definer, pinned, authenticated-only; the three internal helpers callable by no client role';
END;
$$;

ROLLBACK;
