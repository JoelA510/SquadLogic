-- Smoke checks for 20261024010000_remove_guardian_view_and_roles.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * the dropped objects stay dropped: `profile_players`,
--     `link_my_guardian_records()`, `is_team_guardian(uuid)` and
--     `guardian_contacts_view(uuid, jsonb, boolean)`; no `public` function
--     body (its `--` comments aside), view definition or policy names one of
--     them or the `guardian_contact_sharing` setting (a catalogue scan, shown
--     to fire on a planted function first); `guardian.linked` keeps its
--     `audit_actions` row;
--   * the people tables: an admin reads every player and roster row directly;
--     a signed-in user who is not a member reads none; each table has exactly
--     one read policy, the admin one;
--   * the roster read: an admin gets every column (since 20261025010000 the
--     read has no guardian contact column at all, and
--     docs/sql/20261025010000_smoke.sql checks no read returns one); a
--     non-member is refused 42501;
--   * the staff read and the calendar token admit an admin only;
--   * the roles: `parent`, `player` and (since 20261104010000) `coach` are
--     refused as a member's role and an invite's (23514, the CHECKs) and by
--     `create_org_invite` and `admin_change_member_role` (22023); a staff
--     invite is minted;
--
-- **Since 20261104010000 no coach signs in**: the current-coach arm of the
-- reads, the coach persona and the coach invite went; the persona that was a
-- coach member is a signed-in user with no membership, and the one member left
-- is staff.
--   * the posture of the replaced functions: SECURITY DEFINER with
--     search_path=public, EXECUTE for authenticated and not anon.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- The names the scan looks for, as whole words, in code (`--` comments
-- stripped). Declared blind spot: the strip is textual, so a `--` inside a
-- string literal hides the rest of its line from the scan.
CREATE FUNCTION pg_temp.r3_names_dropped(src text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$
    SELECT regexp_replace(src, '--[^\n]*', '', 'g')
           ~ '\m(profile_players|link_my_guardian_records|is_team_guardian|guardian_contacts_view|guardian_contact_sharing)\M'
$f$;

CREATE FUNCTION pg_temp.r3_referrers() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(o, ', ' ORDER BY o) FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND pg_temp.r3_names_dropped(p.prosrc)
        UNION ALL
        SELECT 'view ' || c.relname
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
           AND pg_temp.r3_names_dropped(pg_get_viewdef(c.oid))
        UNION ALL
        SELECT format('policy %s on %s', policyname, tablename)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND pg_temp.r3_names_dropped(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
    ) s
$f$;

DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(o, ', ') INTO v_left FROM (
        SELECT f AS o FROM unnest(ARRAY[
            'public.link_my_guardian_records()',
            'public.is_team_guardian(uuid)',
            'public.guardian_contacts_view(uuid, jsonb, boolean)'
        ]) f WHERE to_regprocedure(f) IS NOT NULL
        UNION ALL
        SELECT 'table public.profile_players' WHERE to_regclass('public.profile_players') IS NOT NULL
        UNION ALL
        SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('link_my_guardian_records', 'is_team_guardian', 'guardian_contacts_view')
    ) s;
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'objects 20261024010000 dropped are back: %', v_left;
    END IF;

    -- The scan must see a function that names a dropped object in code
    -- (planted and undone inside a block) before its silence means anything;
    -- a comment naming one must not count.
    v_left := NULL;
    BEGIN
        CREATE FUNCTION public.__r3_smoke_probe() RETURNS boolean
        LANGUAGE sql AS 'SELECT true AS is_team_guardian';
        CREATE FUNCTION public.__r3_smoke_comment() RETURNS boolean
        LANGUAGE sql AS E'SELECT true -- profile_players\n';
        v_left := pg_temp.r3_referrers();
        RAISE EXCEPTION USING ERRCODE = 'P1024', MESSAGE = 'undo the planted probes';
    EXCEPTION WHEN SQLSTATE 'P1024' THEN NULL;
    END;
    IF v_left IS NULL OR v_left NOT LIKE '%function __r3_smoke_probe()%'
       OR v_left LIKE '%__r3_smoke_comment%' THEN
        RAISE EXCEPTION 'control: the scan did not see a planted function naming is_team_guardian, or counted a comment (found: %)',
            coalesce(v_left, 'nothing');
    END IF;
    v_left := pg_temp.r3_referrers();
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'these still name a dropped guardian object: %', v_left;
    END IF;
    RAISE NOTICE 'guardian objects dropped: profile_players, link_my_guardian_records, is_team_guardian and guardian_contacts_view; no function, view or policy names them or guardian_contact_sharing (the scan shown to fire on a planted function and not on a comment)';

    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'guardian.linked') THEN
        RAISE EXCEPTION 'audit_actions lost guardian.linked, which old audit_log rows reference';
    END IF;
    RAISE NOTICE 'guardian.linked keeps its audit_actions row';

    SELECT string_agg(tablename || '.' || policyname || ' ' || coalesce(qual, ''), '; ' ORDER BY tablename) INTO v_left
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename IN ('players', 'team_players') AND cmd IN ('SELECT', 'ALL');
    IF v_left IS DISTINCT FROM 'players.players_select_admin is_org_admin(organization_id); team_players.team_players_select_admin is_org_admin(organization_id)' THEN
        RAISE EXCEPTION 'the people tables'' read policies are not exactly the admin ones: %', coalesce(v_left, 'none');
    END IF;
    RAISE NOTICE 'read policies: players and team_players each have one, players_select_admin and team_players_select_admin (is_org_admin)';
END;
$$;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_ou uuid := gen_random_uuid();      -- signed in, a member of no organization
    v_m uuid := gen_random_uuid();       -- a staff member
    v_org uuid;
    v_s uuid;
    v_d uuid;
    v_ta uuid;
    v_tb uuid;
    v_c uuid;
    v_o uuid;
    v_p1 uuid;
    v_p2 uuid;
    v_n integer;
    v_t text;
    v_denied integer := 0;
    v_role text;
    v_code text;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
        (v_admin, 'r3-admin@example.test', '{"password_length": 16}', now()),
        (v_ou, 'r3-other@example.test', '{"password_length": 16}', now()),
        (v_m, 'r3-member@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'r3-admin@example.test'),
        (v_ou, 'r3-other@example.test'), (v_m, 'r3-member@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org R3', 'smoke-org-r3')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_m, 'staff');
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'R3 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'R3 U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'R3 A') RETURNING id INTO v_ta;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'R3 B') RETURNING id INTO v_tb;
    INSERT INTO public.coaches (organization_id, full_name, email, status)
        VALUES (v_org, 'Coach A', 'r3-coach@example.test', 'active') RETURNING id INTO v_c;
    INSERT INTO public.coaches (organization_id, full_name, email, status)
        VALUES (v_org, 'Coach B', 'r3-other@example.test', 'active') RETURNING id INTO v_o;
    INSERT INTO public.team_coach_assignments
        (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
    VALUES (v_org, v_ta, v_c, 'lead', public.team_local_today(v_ta) - 10, NULL, 'smoke', NULL),
           (v_org, v_tb, v_o, 'lead', public.team_local_today(v_tb) - 10, NULL, 'smoke', NULL);
    INSERT INTO public.players (organization_id, first_name, last_name, jersey_number, gender, years_played,
                                rating, willing_to_coach)
        VALUES (v_org, 'Pia', 'One', 7, 'F', 2, 3, true)
        RETURNING id INTO v_p1;
    INSERT INTO public.players (organization_id, first_name, last_name, jersey_number, gender, years_played,
                                rating, willing_to_coach)
        VALUES (v_org, 'Rex', 'Two', 9, 'M', 1, 4, false)
        RETURNING id INTO v_p2;
    INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES (v_ta, v_p1, v_org), (v_ta, v_p2, v_org);

    -- ── The admin ──────────────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    IF (SELECT count(*) FROM public.players WHERE organization_id = v_org) <> 2
       OR (SELECT count(*) FROM public.team_players WHERE organization_id = v_org) <> 2 THEN
        RESET ROLE; RAISE EXCEPTION 'an admin did not read both players and both roster rows';
    END IF;
    SELECT string_agg(r.first_name || ':' || r.jersey_number || ':' || r.gender || ':' || r.years_played || ':'
                      || r.rating || ':' || r.willing_to_coach,
                      ',' ORDER BY r.first_name)
      INTO v_t FROM public.get_team_roster(v_ta) r;
    IF v_t IS DISTINCT FROM 'Pia:7:F:2:3:true,Rex:9:M:1:4:false' THEN
        RESET ROLE; RAISE EXCEPTION 'an admin''s roster read is not every column: %', coalesce(v_t, 'nothing');
    END IF;
    IF (SELECT count(*) FROM public.get_team_staff(v_ta)) <> 1 THEN
        RESET ROLE; RAISE EXCEPTION 'an admin did not read the team''s staff';
    END IF;
    RESET ROLE;
    RAISE NOTICE 'admin: 2 of 2 players and roster rows read directly; the roster read returns every column';

    -- ── A signed-in user who is not a member ───────────────────────────────
    PERFORM set_config('request.jwt.claim.sub', v_ou::text, true);
    SET LOCAL ROLE authenticated;
    IF (SELECT count(*) FROM public.players WHERE organization_id = v_org)
       + (SELECT count(*) FROM public.team_players WHERE organization_id = v_org) <> 0
       OR EXISTS (SELECT 1 FROM public.team_calendar_tokens WHERE team_id = v_ta) THEN
        RESET ROLE; RAISE EXCEPTION 'a non-member read a player, roster row or token';
    END IF;
    BEGIN
        PERFORM * FROM public.get_team_roster(v_ta);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM * FROM public.get_team_staff(v_ta);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
    IF v_denied <> 2 THEN
        RAISE EXCEPTION 'only % of 2 roster and staff reads were refused to a non-member', v_denied;
    END IF;
    RAISE NOTICE 'refused: a signed-in non-member, roster and staff 2 of 2 42501; reads no player, roster row or the token';

    -- ── The roles ──────────────────────────────────────────────────────────
    v_denied := 0;
    FOREACH v_role IN ARRAY ARRAY['parent', 'player', 'coach'] LOOP
        BEGIN
            UPDATE public.organization_members SET role = v_role WHERE organization_id = v_org AND profile_id = v_m;
        EXCEPTION WHEN check_violation THEN v_denied := v_denied + 1;
        END;
        BEGIN
            INSERT INTO public.organization_invites (code, organization_id, role, created_by)
            VALUES ('R3SMOKE' || upper(v_role), v_org, v_role, v_admin);
        EXCEPTION WHEN check_violation THEN v_denied := v_denied + 1;
        END;
    END LOOP;
    IF v_denied <> 6 THEN
        RAISE EXCEPTION 'only % of 6 parent, player and coach member and invite writes were refused by the CHECKs', v_denied;
    END IF;

    v_denied := 0;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    FOREACH v_role IN ARRAY ARRAY['parent', 'player', 'coach'] LOOP
        BEGIN
            PERFORM public.create_org_invite(v_org, v_role);
        EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
        END;
        BEGIN
            PERFORM public.admin_change_member_role(v_org, v_m, v_role);
        EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
        END;
    END LOOP;
    SELECT i.code INTO v_code FROM public.create_org_invite(v_org, 'staff') i;
    RESET ROLE;
    IF v_denied <> 6 THEN
        RAISE EXCEPTION 'only % of 6 parent, player and coach invites and role changes were refused 22023', v_denied;
    END IF;
    IF v_code IS NULL OR NOT EXISTS (SELECT 1 FROM public.organization_invites
                                      WHERE code = v_code AND organization_id = v_org AND role = 'staff') THEN
        RAISE EXCEPTION 'a staff invite was not minted';
    END IF;
    IF (SELECT role FROM public.organization_members WHERE organization_id = v_org AND profile_id = v_m) <> 'staff' THEN
        RAISE EXCEPTION 'a refused role change still changed the member''s role';
    END IF;
    RAISE NOTICE 'roles: parent, player and coach refused by both CHECKs 6 of 6 (23514) and by create_org_invite and admin_change_member_role 6 of 6 (22023); a staff invite is minted';
END;
$$;

DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(f, ', ') INTO v_left FROM unnest(ARRAY[
        'public.get_team_roster(uuid)', 'public.get_team_staff(uuid)',
        'public.create_org_invite(uuid, text, interval)', 'public.admin_change_member_role(uuid, uuid, text)'
    ]) f
     WHERE NOT EXISTS (
         SELECT 1 FROM pg_proc p
          WHERE p.oid = to_regprocedure(f) AND p.prosecdef
            AND p.proconfig @> ARRAY['search_path=public']
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'posture changed (want SECURITY DEFINER, search_path=public, authenticated not anon): %', v_left;
    END IF;
    RAISE NOTICE 'posture: get_team_roster, get_team_staff, create_org_invite and admin_change_member_role SECURITY DEFINER, search_path=public, EXECUTE for authenticated and not anon';
END;
$$;

ROLLBACK;
