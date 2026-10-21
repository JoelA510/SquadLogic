-- Smoke checks for 20261021010000_server_side_reads.sql
--
-- What it proves, with prelude.sql's `auth.uid()` stub:
--   * link_my_guardian_records links a verified member to the players whose
--     imported guardian email or alternate email matches, case-insensitively,
--     audits each link once, and a second call links nothing; an unverified
--     email links nothing;
--   * get_team_roster: the current coach gets every guardian contact; a
--     guardian gets their own child's contacts in full and a teammate's primary
--     contact only, and nothing of it with guardian_contact_sharing off; a
--     member with no tie to the team is refused; rating is admin-only;
--   * a saved contact card replaces the imported email and phone, and an
--     unshared card leaves neither; each save is audited without the values;
--   * get_team_staff admits the guardian and refuses the unrelated member; a
--     coach whose assignment ended yesterday is no longer current;
--   * get_coach_directory admits a current coach and refuses them once
--     coach_directory is off;
--   * the posture: every reader is SECURITY DEFINER with search_path=public,
--     executable by authenticated and not anon; the three internal helpers
--     (org_flag, guardian_contacts_view, team_local_today) by neither.
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
    v_g1 uuid := gen_random_uuid();        -- guardian of player 1 (matched by alternate email)
    v_stranger uuid := gen_random_uuid();  -- member with no tie to team A
    v_unv uuid := gen_random_uuid();       -- unverified; email matches player 2's guardian
    v_org uuid;
    v_s uuid;
    v_d uuid;
    v_ta uuid;
    v_coach uuid;
    v_old uuid;
    v_p1 uuid;
    v_p2 uuid;
    v_r jsonb;
    v_n integer;
    v_contacts jsonb;
    v_denied boolean;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
        (v_admin, 'ssr-admin@example.test', '{"password_length": 16}', now()),
        (v_coach_u, 'ssr-coach@example.test', '{"password_length": 16}', now()),
        (v_old_u, 'ssr-old@example.test', '{"password_length": 16}', now()),
        (v_g1, 'SSR-G1@Example.test', '{"password_length": 16}', now()),
        (v_stranger, 'ssr-stranger@example.test', '{"password_length": 16}', now()),
        (v_unv, 'g2@example.test', '{"password_length": 16}', NULL);
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'ssr-admin@example.test'), (v_coach_u, 'ssr-coach@example.test'),
        (v_old_u, 'ssr-old@example.test'), (v_g1, 'ssr-g1@example.test'),
        (v_stranger, 'ssr-stranger@example.test'), (v_unv, 'g2@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org SSR', 'smoke-org-ssr')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_coach_u, 'coach'), (v_org, v_old_u, 'coach'),
        (v_org, v_g1, 'parent'), (v_org, v_stranger, 'parent'), (v_org, v_unv, 'parent');
    INSERT INTO public.season_settings (organization_id, name, timezone)
        VALUES (v_org, 'SSR Fall', 'America/Los_Angeles') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org, v_s, 'SSR U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name)
        VALUES (v_org, v_d, 'SSR Team A') RETURNING id INTO v_ta;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, phone, status)
        VALUES (v_org, v_coach_u, 'Coach Current', 'ssr-coach@example.test', '555-0100', 'active')
        RETURNING id INTO v_coach;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_old_u, 'Coach Former', 'ssr-old@example.test', 'active')
        RETURNING id INTO v_old;
    INSERT INTO public.team_coach_assignments
        (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
    VALUES (v_org, v_ta, v_coach, 'lead', public.team_local_today(v_ta) - 30, NULL, 'smoke', NULL),
           (v_org, v_ta, v_old, 'assistant', public.team_local_today(v_ta) - 30,
            public.team_local_today(v_ta) - 1, 'smoke', 'smoke');
    INSERT INTO public.players (organization_id, first_name, last_name, rating, guardian_contacts)
        VALUES (v_org, 'Pat', 'One', 3, jsonb_build_array(
            jsonb_build_object('name', 'Guardian One', 'email', 'g1-primary@example.test',
                               'alternate_email', 'ssr-g1@example.test', 'phone', '555-0111'),
            jsonb_build_object('name', 'Guardian One B', 'email', 'g1-second@example.test')))
        RETURNING id INTO v_p1;
    INSERT INTO public.players (organization_id, first_name, last_name, rating, guardian_contacts)
        VALUES (v_org, 'Sam', 'Two', 4, jsonb_build_array(
            jsonb_build_object('name', 'Guardian Two', 'email', 'g2@example.test',
                               'alternate_email', 'g2-alt@example.test', 'phone', '555-0222'),
            jsonb_build_object('name', 'Guardian Two B', 'email', 'g2-second@example.test')))
        RETURNING id INTO v_p2;
    INSERT INTO public.team_players (team_id, player_id, organization_id)
        VALUES (v_ta, v_p1, v_org), (v_ta, v_p2, v_org);

    -- Guardian link
    PERFORM set_config('request.jwt.claim.sub', v_g1::text, true);
    v_r := public.link_my_guardian_records();
    IF v_r->>'status' <> 'linked' OR (v_r->>'linked')::int <> 1
       OR NOT EXISTS (SELECT 1 FROM public.profile_players WHERE profile_id = v_g1 AND player_id = v_p1) THEN
        RAISE EXCEPTION 'the guardian was not linked to their child by alternate email: %', v_r;
    END IF;
    v_r := public.link_my_guardian_records();
    IF v_r->>'status' <> 'already_linked' OR (v_r->>'linked')::int <> 0 THEN
        RAISE EXCEPTION 'a second call was not already_linked: %', v_r;
    END IF;
    IF (SELECT count(*) FROM public.audit_log WHERE action = 'guardian.linked' AND resource_id = v_p1) <> 1 THEN
        RAISE EXCEPTION 'the guardian link was not audited exactly once';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_unv::text, true);
    v_r := public.link_my_guardian_records();
    IF v_r->>'status' <> 'email_not_verified'
       OR EXISTS (SELECT 1 FROM public.profile_players WHERE profile_id = v_unv) THEN
        RAISE EXCEPTION 'an unverified email linked a guardian: %', v_r;
    END IF;
    RAISE NOTICE 'a verified guardian was linked by alternate email, once, audited once; a second call changed nothing; an unverified email linked nothing';

    -- Roster: coach
    PERFORM set_config('request.jwt.claim.sub', v_coach_u::text, true);
    SELECT count(*) INTO v_n FROM public.get_team_roster(v_ta) r
     WHERE jsonb_array_length(r.guardian_contacts) = 2 AND r.rating IS NULL;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'the current coach did not get every guardian contact (and no rating): % of 2', v_n;
    END IF;

    -- Roster: guardian
    PERFORM set_config('request.jwt.claim.sub', v_g1::text, true);
    SELECT r.guardian_contacts INTO v_contacts FROM public.get_team_roster(v_ta) r WHERE r.player_id = v_p2;
    IF jsonb_array_length(v_contacts) <> 1 OR v_contacts->0->>'email' <> 'g2@example.test'
       OR v_contacts->0 ? 'alternate_email' THEN
        RAISE EXCEPTION 'a guardian did not get exactly a teammate''s primary contact: %', v_contacts;
    END IF;
    SELECT r.guardian_contacts INTO v_contacts FROM public.get_team_roster(v_ta) r
     WHERE r.player_id = v_p1 AND r.is_my_child;
    IF jsonb_array_length(v_contacts) <> 2 THEN
        RAISE EXCEPTION 'a guardian did not get their own child''s contacts in full: %', v_contacts;
    END IF;
    UPDATE public.organizations SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"guardian_contact_sharing": false}'
     WHERE id = v_org;
    SELECT r.guardian_contacts INTO v_contacts FROM public.get_team_roster(v_ta) r WHERE r.player_id = v_p2;
    IF v_contacts <> '[]'::jsonb THEN
        RAISE EXCEPTION 'a teammate''s contact was shared with the league setting off: %', v_contacts;
    END IF;
    UPDATE public.organizations SET feature_flags = feature_flags - 'guardian_contact_sharing' WHERE id = v_org;
    RAISE NOTICE 'roster: coach gets all contacts; guardian gets own child in full, a teammate''s primary only, none with sharing off';

    -- Contact card
    PERFORM public.set_my_contact_card('+1 555 0199', 'card-g1@example.test', true);
    PERFORM set_config('request.jwt.claim.sub', v_coach_u::text, true);
    SELECT r.guardian_contacts INTO v_contacts FROM public.get_team_roster(v_ta) r WHERE r.player_id = v_p1;
    IF v_contacts->0->>'email' <> 'card-g1@example.test' OR v_contacts->0->>'phone' <> '+1 555 0199' THEN
        RAISE EXCEPTION 'a shared card did not replace the imported details: %', v_contacts;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_g1::text, true);
    PERFORM public.set_my_contact_card('+1 555 0199', 'card-g1@example.test', false);
    PERFORM set_config('request.jwt.claim.sub', v_coach_u::text, true);
    SELECT r.guardian_contacts INTO v_contacts FROM public.get_team_roster(v_ta) r WHERE r.player_id = v_p1;
    IF v_contacts->0 ? 'email' OR v_contacts->0 ? 'phone' OR v_contacts->0->>'name' <> 'Guardian One' THEN
        RAISE EXCEPTION 'an unshared card still showed contact details: %', v_contacts;
    END IF;
    IF (SELECT count(*) FROM public.audit_log
         WHERE action = 'profile.contact_card_updated' AND resource_id = v_g1
           AND organization_id = v_org AND metadata ? 'share_contact'
           AND NOT metadata ? 'contact_phone' AND NOT (metadata::text LIKE '%0199%')) <> 2 THEN
        RAISE EXCEPTION 'each card save was not audited once, without the phone number';
    END IF;
    RAISE NOTICE 'a shared card replaces the imported email and phone; an unshared card shows neither; each save audited once, without the values';

    -- Staff
    PERFORM set_config('request.jwt.claim.sub', v_g1::text, true);
    SELECT count(*) INTO v_n FROM public.get_team_staff(v_ta);
    IF v_n <> 1 OR (SELECT s.coach_id FROM public.get_team_staff(v_ta) s) <> v_coach THEN
        RAISE EXCEPTION 'staff: the guardian did not get exactly the current coach (% rows)', v_n;
    END IF;
    RAISE NOTICE 'staff: the guardian sees the current coach; the coach whose window ended yesterday is not listed';

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

    -- Directory
    PERFORM set_config('request.jwt.claim.sub', v_coach_u::text, true);
    SELECT count(*) INTO v_n FROM public.get_coach_directory(v_org);
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'the directory did not list exactly the one current coach: %', v_n;
    END IF;
    UPDATE public.organizations SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || '{"coach_directory": false}' WHERE id = v_org;
    BEGIN
        PERFORM * FROM public.get_coach_directory(v_org);
        v_denied := false;
    EXCEPTION WHEN insufficient_privilege THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN RAISE EXCEPTION 'a coach read the directory with the league setting off'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SELECT count(*) INTO v_n FROM public.get_coach_directory(v_org);
    IF v_n <> 1 THEN RAISE EXCEPTION 'the admin was refused the directory with the setting off'; END IF;
    RAISE NOTICE 'directory: a current coach reads it while on, not while off; an admin reads it either way';

    -- Posture
    SELECT count(*) INTO v_n
      FROM pg_proc p
     WHERE p.oid IN ('public.get_team_roster(uuid)'::regprocedure, 'public.get_team_staff(uuid)'::regprocedure,
                     'public.get_coach_directory(uuid)'::regprocedure,
                     'public.get_my_coached_team_ids(uuid)'::regprocedure,
                     'public.link_my_guardian_records()'::regprocedure,
                     'public.set_my_contact_card(text,text,boolean)'::regprocedure,
                     'public.is_current_team_coach(uuid)'::regprocedure,
                     'public.is_team_guardian(uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig = ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 8 THEN
        RAISE EXCEPTION 'posture: % of 8 callable functions are definer, pinned, authenticated-only', v_n;
    END IF;
    IF has_function_privilege('authenticated', 'public.guardian_contacts_view(uuid,jsonb,boolean)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.org_flag(uuid,text,boolean)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.team_local_today(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.guardian_contacts_view(uuid,jsonb,boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'an internal helper is executable by a client role';
    END IF;
    RAISE NOTICE 'posture: 8 of 8 callable functions definer, pinned, authenticated-only; the three internal helpers callable by no client role';
END;
$$;

ROLLBACK;
