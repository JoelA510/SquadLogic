-- Smoke checks for 20261025010000_remove_contact_surfaces.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * the dropped objects stay dropped: `get_coach_directory(uuid)`,
--     `set_my_contact_card(text, text, boolean)`, `upsert_coach_leads(jsonb)`,
--     `set_import_job_coach_lead_summary(uuid, jsonb, text)`,
--     `enforce_coach_interested_programs_org_scope()`, the table
--     `coach_interested_programs`, the columns `players.contact_info` and
--     `guardian_contacts` and the card columns on `profiles`; no `public`
--     function body (comments and string literals aside), view definition or
--     policy names one of them (a catalogue scan, shown to fire on a planted
--     function first); `profile.contact_card_updated` keeps its
--     `audit_actions` row;
--   * the catalogue of what a coach could be handed: no function
--     `authenticated` may execute returns a column, or rows of a table with a
--     column, named like an email, a phone, a contact or a guardian, but the
--     two admin-only reads (shown to see a planted one first); and a signed-in
--     user who is not a member (a coach, before 20261104010000) is refused both
--     of those;
--   * the reads: the staff read gives an admin name, role and status and no
--     contact column; the roster read has no contact column; the member list
--     gives an admin every member with their email and refuses a non-member 42501;
--   * the player writers: a player is created, patched and bulk-patched
--     without the dropped columns, and a patch naming `guardian_contacts` is
--     refused 22023 (the import finalizer and the purge are executed at head
--     by docs/sql/20261022010000_smoke.sql);
--   * the posture of the replaced and recreated functions.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated, every email `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- The names the scan looks for, as whole words, in code: `--` comments and
-- single-quoted literals are stripped (the purge redacts audit metadata keys
-- named `guardian_contacts`, which is data, not a reference). Declared blind
-- spot: the strip is textual, so a `--` inside a string literal hides the
-- rest of its line from the scan.
CREATE FUNCTION pg_temp.r4_names_dropped(src text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$
    SELECT regexp_replace(regexp_replace(src, '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
           ~ '\m(guardian_contacts|share_contact|contact_phone|contact_email|set_my_contact_card|get_coach_directory|upsert_coach_leads|set_import_job_coach_lead_summary|coach_interested_programs|enforce_coach_interested_programs_org_scope)\M'
$f$;

CREATE FUNCTION pg_temp.r4_referrers() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(o, ', ' ORDER BY o) FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND pg_temp.r4_names_dropped(p.prosrc)
        UNION ALL
        SELECT 'view ' || c.relname
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
           AND pg_temp.r4_names_dropped(pg_get_viewdef(c.oid))
        UNION ALL
        SELECT format('policy %s on %s', policyname, tablename)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND pg_temp.r4_names_dropped(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
    ) s
$f$;

-- Every function a signed-in caller may execute that returns a contact
-- column, by result column name or by the columns of the table it returns.
CREATE FUNCTION pg_temp.r4_contact_reads() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p
      JOIN pg_type rt ON rt.oid = p.prorettype
     WHERE p.pronamespace = 'public'::regnamespace
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND (EXISTS (SELECT 1 FROM unnest(p.proargnames, p.proargmodes) AS a(n, m)
                     WHERE a.m IN ('o', 'b', 't') AND a.n ~* '(mail|phone|contact|guardian)')
            OR EXISTS (SELECT 1 FROM pg_attribute ra
                        WHERE ra.attrelid = rt.typrelid AND rt.typrelid <> 0
                          AND ra.attnum > 0 AND NOT ra.attisdropped
                          AND ra.attname ~* '(mail|phone|contact|guardian)'))
$f$;

DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(o, ', ') INTO v_left FROM (
        SELECT f AS o FROM unnest(ARRAY[
            'public.get_coach_directory(uuid)',
            'public.set_my_contact_card(text, text, boolean)',
            'public.upsert_coach_leads(jsonb)',
            'public.set_import_job_coach_lead_summary(uuid, jsonb, text)',
            'public.enforce_coach_interested_programs_org_scope()'
        ]) f WHERE to_regprocedure(f) IS NOT NULL
        UNION ALL
        SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('get_coach_directory', 'set_my_contact_card', 'upsert_coach_leads',
                             'set_import_job_coach_lead_summary',
                             'enforce_coach_interested_programs_org_scope')
        UNION ALL
        SELECT 'table public.coach_interested_programs'
         WHERE to_regclass('public.coach_interested_programs') IS NOT NULL
        UNION ALL
        SELECT 'column ' || c.relname || '.' || a.attname
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         WHERE c.oid IN ('public.players'::regclass, 'public.profiles'::regclass)
           AND a.attnum > 0 AND NOT a.attisdropped
           AND ((c.relname = 'players' AND a.attname IN ('contact_info', 'guardian_contacts'))
                OR (c.relname = 'profiles' AND a.attname IN ('contact_phone', 'contact_email', 'share_contact')))
    ) s;
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'objects 20261025010000 dropped are back: %', v_left;
    END IF;

    -- The scan must see a function that names a dropped object in code
    -- (planted and undone inside a block) before its silence means anything;
    -- a comment or a string literal naming one must not count.
    v_left := NULL;
    BEGIN
        CREATE FUNCTION public.__r4_smoke_probe() RETURNS boolean
        LANGUAGE sql AS 'SELECT true AS share_contact';
        CREATE FUNCTION public.__r4_smoke_comment() RETURNS text
        LANGUAGE sql AS E'SELECT ''guardian_contacts''::text -- coach_interested_programs\n';
        v_left := pg_temp.r4_referrers();
        RAISE EXCEPTION USING ERRCODE = 'P1025', MESSAGE = 'undo the planted probes';
    EXCEPTION WHEN SQLSTATE 'P1025' THEN NULL;
    END;
    IF v_left IS NULL OR v_left NOT LIKE '%function __r4_smoke_probe()%'
       OR v_left LIKE '%__r4_smoke_comment%' THEN
        RAISE EXCEPTION 'control: the scan did not see a planted function naming share_contact, or counted a comment or a literal (found: %)',
            coalesce(v_left, 'nothing');
    END IF;
    v_left := pg_temp.r4_referrers();
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'these still name a dropped contact or lead object: %', v_left;
    END IF;
    RAISE NOTICE 'contact objects dropped: the directory, the card and its columns, the two player contact columns, the coach leads and their table; no function, view or policy names them (the scan shown to fire on a planted function and not on a comment or literal)';

    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'profile.contact_card_updated') THEN
        RAISE EXCEPTION 'audit_actions lost profile.contact_card_updated, which old audit_log rows reference';
    END IF;
    RAISE NOTICE 'profile.contact_card_updated keeps its audit_actions row';

    -- The catalogue, shown to see a planted read of each shape first.
    v_left := NULL;
    BEGIN
        CREATE FUNCTION public.__r4_smoke_email_read() RETURNS TABLE (coach_email text)
        LANGUAGE sql AS 'SELECT NULL::text';
        CREATE FUNCTION public.__r4_smoke_row_read() RETURNS SETOF public.coaches
        LANGUAGE sql AS 'SELECT * FROM public.coaches WHERE false';
        GRANT EXECUTE ON FUNCTION public.__r4_smoke_email_read() TO authenticated;
        GRANT EXECUTE ON FUNCTION public.__r4_smoke_row_read() TO authenticated;
        v_left := pg_temp.r4_contact_reads();
        RAISE EXCEPTION USING ERRCODE = 'P1025', MESSAGE = 'undo the planted reads';
    EXCEPTION WHEN SQLSTATE 'P1025' THEN NULL;
    END;
    IF v_left IS NULL OR v_left NOT LIKE '%__r4_smoke_email_read()%'
       OR v_left NOT LIKE '%__r4_smoke_row_read()%' THEN
        RAISE EXCEPTION 'control: the catalogue did not see a planted email column and a planted coaches row read (found: %)',
            coalesce(v_left, 'nothing');
    END IF;
    v_left := pg_temp.r4_contact_reads();
    IF v_left IS DISTINCT FROM 'get_organization_members(uuid), get_settings_audit_log(uuid)' THEN
        RAISE EXCEPTION 'the functions a signed-in caller may execute that return a contact column are not exactly the two admin reads: %',
            coalesce(v_left, 'none');
    END IF;
    RAISE NOTICE 'contact catalogue: only get_organization_members and get_settings_audit_log return a contact column to a signed-in caller (the catalogue shown to see a planted column and a planted coaches row read)';
END;
$$;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_cu uuid := gen_random_uuid();      -- signed in, a member of no organization
    v_staff uuid := gen_random_uuid();   -- a staff member
    v_org uuid;
    v_s uuid;
    v_d uuid;
    v_ta uuid;
    v_c uuid;
    v_p uuid;
    v_p2 uuid;
    v_t text;
    v_n integer;
    v_denied integer := 0;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
        (v_admin, 'r4-admin@example.test', '{"password_length": 16}', now()),
        (v_cu, 'r4-nonmember@example.test', '{"password_length": 16}', now()),
        (v_staff, 'r4-staff@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'r4-admin@example.test'), (v_cu, 'r4-nonmember@example.test'), (v_staff, 'r4-staff@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org R4', 'smoke-org-r4')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_staff, 'staff');
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'R4 Fall', 'active') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'R4 U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'R4 A') RETURNING id INTO v_ta;
    INSERT INTO public.coaches (organization_id, full_name, email, status)
        VALUES (v_org, 'Coach A', 'r4-coach@example.test', 'active') RETURNING id INTO v_c;
    INSERT INTO public.team_coach_assignments
        (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
    VALUES (v_org, v_ta, v_c, 'lead', public.team_local_today(v_ta) - 10, NULL, 'smoke', NULL);

    -- ── The admin ──────────────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    SELECT string_agg(s.full_name || ':' || s.role || ':' || coalesce(s.status, '-'), ',')
      INTO v_t FROM public.get_team_staff(v_ta) s;
    IF v_t IS DISTINCT FROM 'Coach A:lead:active' THEN
        RESET ROLE; RAISE EXCEPTION 'the admin''s staff read is not name, role and status: %', coalesce(v_t, 'nothing');
    END IF;
    SELECT string_agg(m.role || ':' || m.email, ',' ORDER BY m.role) INTO v_t
      FROM public.get_organization_members(v_org) m;
    IF v_t IS DISTINCT FROM 'admin:r4-admin@example.test,staff:r4-staff@example.test' THEN
        RESET ROLE; RAISE EXCEPTION 'the admin did not read every member with their email: %', coalesce(v_t, 'nothing');
    END IF;

    -- The player writers, through the admin RPCs.
    SELECT (public.admin_create_player(v_org, '{"first_name": "Pia", "last_name": "One"}')).id INTO v_p;
    SELECT (public.admin_create_player(v_org, '{"first_name": "Rex", "last_name": "Two"}')).id INTO v_p2;
    PERFORM public.admin_update_player(v_p, '{"jersey_number": 7, "preferred_name": "P"}');
    PERFORM public.admin_bulk_update_players(ARRAY[v_p, v_p2], '{"status": "active"}');
    BEGIN
        PERFORM public.admin_update_player(v_p, '{"guardian_contacts": [{"name": "G"}]}');
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM public.admin_bulk_update_players(ARRAY[v_p], '{"guardian_contacts": []}');
    EXCEPTION WHEN SQLSTATE '22023' THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
    IF (SELECT count(*) FROM public.players
         WHERE organization_id = v_org AND status = 'active'
           AND ((id = v_p AND jersey_number = 7 AND preferred_name = 'P') OR id = v_p2)) <> 2 THEN
        RAISE EXCEPTION 'the player writers did not create, patch and bulk-patch both players';
    END IF;
    IF v_denied <> 2 THEN
        RAISE EXCEPTION 'only % of 2 patches naming guardian_contacts were refused 22023', v_denied;
    END IF;
    INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES (v_ta, v_p, v_org), (v_ta, v_p2, v_org);
    RAISE NOTICE 'admin: the staff read is name, role and status; the member list carries both emails; a player is created, patched and bulk-patched, and both patches naming guardian_contacts are refused 22023';

    -- ── A signed-in user who is not a member ────────────────────────────────
    v_denied := 0;
    PERFORM set_config('request.jwt.claim.sub', v_cu::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
        PERFORM * FROM public.get_team_staff(v_ta);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM * FROM public.get_team_roster(v_ta);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM * FROM public.get_organization_members(v_org);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    BEGIN
        PERFORM * FROM public.get_settings_audit_log(v_org);
    EXCEPTION WHEN OTHERS THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
    IF v_denied <> 4 THEN
        RAISE EXCEPTION 'only % of the 4 admin reads (staff, roster, member list, settings audit log) were refused to a non-member', v_denied;
    END IF;
    RAISE NOTICE 'non-member: the staff read, the roster, the member list (42501) and the settings audit log are refused';
END;
$$;

DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(f, ', ') INTO v_left FROM unnest(ARRAY[
        'public.get_team_roster(uuid)', 'public.get_team_staff(uuid)',
        'public.get_organization_members(uuid)', 'public.admin_bulk_update_players(uuid[], jsonb)',
        'public.finalize_import_job(uuid, jsonb)'
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
    IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.minimise_import_people_data()'::regprocedure
                    AND NOT p.prosecdef AND p.proconfig = ARRAY['search_path=public']
                    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.apply_player_patch(uuid, jsonb)'::regprocedure
                       AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC'])
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.finalize_import_job(uuid, jsonb)'::regprocedure
                       AND p.proconfig @> ARRAY['TimeZone=UTC'])
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.sanitize_player_patch(jsonb)'::regprocedure
                       AND p.provolatile = 'i' AND p.proconfig = ARRAY['search_path=public']) THEN
        RAISE EXCEPTION 'posture changed on the purge, the patch helpers or the finalizer''s timezone';
    END IF;
    RAISE NOTICE 'posture: get_team_roster, get_team_staff, get_organization_members, admin_bulk_update_players and finalize_import_job SECURITY DEFINER, search_path=public, EXECUTE for authenticated and not anon; the purge callable by no client role; the patch helpers and the finalizer keep their SET clauses';
END;
$$;

ROLLBACK;
