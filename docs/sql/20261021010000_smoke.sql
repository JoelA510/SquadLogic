-- Smoke checks for 20261021010000_server_side_reads.sql
--
-- What it proves, with prelude.sql's `auth.uid()` stub, on the head build:
--   * get_team_roster: an admin gets the rating; a signed-in user who is not a
--     member is refused (a coach, before 20261104010000, read names only);
--   * get_team_staff: an admin gets exactly the current coach, and a coach whose
--     assignment ended yesterday is no longer listed; a non-member is refused;
--   * the posture: both readers are SECURITY DEFINER with search_path=public,
--     executable by authenticated and not anon; the two internal helpers
--     (org_flag, team_local_today) by neither;
--   * the coach-facing functions this migration added stay dropped
--     (20261104010000): is_current_team_coach, coached_team_ids_of,
--     get_my_coached_team_ids and admin_get_coached_team_ids.
--
-- **Since 20261024010000 (plan docs/changes/2026-10-22-admin-focus.md, R3)**
-- there is no guardian: `link_my_guardian_records`, `is_team_guardian`,
-- `guardian_contacts_view`, `profile_players` and the
-- `guardian_contact_sharing` setting are gone, and `parent` is no role. The
-- guardian link, guardian roster and teammate-sharing cases went with them;
-- docs/sql/20261024010000_smoke.sql checks they stay gone, and
-- docs/sql/20261021010000_revert.sql is still checked on a build up to this
-- migration.
--
-- **Since 20261025010000 (R4)** there are no contact surfaces: guardian
-- contacts, the contact card (`set_my_contact_card` and its `profiles`
-- columns), `get_coach_directory` and the `coach_directory` setting are gone,
-- and neither read returns a contact column. The guardian contact, contact
-- card and directory cases went with them; docs/sql/20261025010000_smoke.sql
-- checks they stay gone, and docs/sql/20261021010000_revert.sql is still
-- checked on a build up to this migration.
--
-- **Since 20261104010000 no coach signs in**: the readers admit an admin only,
-- the current-coach arm and its helpers are dropped, and the persona that was a
-- coach member is a signed-in user with no membership.
--
-- Wrapped in BEGIN ... ROLLBACK. Every id is generated; every email is
-- `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_stranger uuid := gen_random_uuid();  -- signed in, a member of no organization
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
        (v_stranger, 'ssr-stranger@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'ssr-admin@example.test'), (v_stranger, 'ssr-stranger@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org SSR', 'smoke-org-ssr')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name, timezone)
        VALUES (v_org, 'SSR Fall', 'America/Los_Angeles') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org, v_s, 'SSR U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name)
        VALUES (v_org, v_d, 'SSR Team A') RETURNING id INTO v_ta;
    INSERT INTO public.coaches (organization_id, full_name, email, status)
        VALUES (v_org, 'Coach Current', 'ssr-coach@example.test', 'active')
        RETURNING id INTO v_coach;
    INSERT INTO public.coaches (organization_id, full_name, email, status)
        VALUES (v_org, 'Coach Former', 'ssr-old@example.test', 'active')
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
    RAISE NOTICE 'roster: an admin gets the rating';

    -- Staff: the admin gets exactly the current coach
    SELECT count(*) INTO v_n FROM public.get_team_staff(v_ta);
    IF v_n <> 1 OR (SELECT s.coach_id FROM public.get_team_staff(v_ta) s) <> v_coach THEN
        RAISE EXCEPTION 'staff: the admin did not get exactly the current coach (% rows)', v_n;
    END IF;
    RAISE NOTICE 'staff: the admin sees the current coach; the coach whose window ended yesterday is not listed';

    -- Refusals
    PERFORM set_config('request.jwt.claim.sub', v_stranger::text, true);
    BEGIN
        PERFORM * FROM public.get_team_roster(v_ta);
        v_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'a non-member read the roster'; END IF;
    BEGIN
        PERFORM * FROM public.get_team_staff(v_ta);
        v_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'a non-member read the staff'; END IF;
    RAISE NOTICE 'a signed-in non-member is refused the roster and staff';

    -- Posture
    SELECT count(*) INTO v_n
      FROM pg_proc p
     WHERE p.oid IN ('public.get_team_roster(uuid)'::regprocedure, 'public.get_team_staff(uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig = ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'posture: % of 2 callable functions are definer, pinned, authenticated-only', v_n;
    END IF;
    IF has_function_privilege('authenticated', 'public.org_flag(uuid,text,boolean)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.team_local_today(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.org_flag(uuid,text,boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'an internal helper is executable by a client role';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('is_current_team_coach', 'coached_team_ids_of', 'get_my_coached_team_ids',
                                'admin_get_coached_team_ids')) THEN
        RAISE EXCEPTION 'a coach-facing function is back (20261104010000 dropped them)';
    END IF;
    RAISE NOTICE 'posture: 2 of 2 callable functions definer, pinned, authenticated-only; the two internal helpers callable by no client role; the four coach functions stay dropped';
END;
$$;

ROLLBACK;
