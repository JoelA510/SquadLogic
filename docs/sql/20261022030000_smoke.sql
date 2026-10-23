-- Smoke checks for 20261022030000_remove_rsvp_and_team_chat.sql
--
-- Run on the database built to head, so they hold for every later migration:
--   * the dropped objects stay dropped: `upsert_team_event_rsvp`,
--     `create_team_message`, `event_rsvps` and `team_messages`; no `public`
--     function body (its `--` comments aside: `persist_team_schedule` names
--     both tables in one), view definition or policy names one of them (a
--     catalogue scan, shown to fire on a planted function first); and
--     `team_messages` is in no publication;
--   * the audit history stays readable: `team.rsvp_updated` and
--     `team.message_created` keep their `audit_actions` rows;
--   * `admin_delete_team` works without them: an admin deletes a team with a
--     game, a series carrying a live exception and a rostered player; the
--     team, its game and its series are gone, the exception is withdrawn on
--     the record, and `team.deleted` carries no RSVP or chat counter but one
--     for every table the cascade from `teams` empties (read off the
--     catalogue, not the function); a coach is refused 42501;
--   * `reconcile_prod_rls_drift()` runs on the head chain: it creates and
--     drops nothing and verifies its 19 policies, none on a dropped table;
--   * the posture of the two replaced functions is what it was:
--     `admin_delete_team` SECURITY DEFINER with search_path=public, EXECUTE
--     for authenticated and not anon; `reconcile_prod_rls_drift` SECURITY
--     INVOKER with search_path=public, EXECUTE for service_role only.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every value a placeholder; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- The names the scan looks for, as whole words, in code (`--` comments
-- stripped): the two tables and the two functions.
CREATE FUNCTION pg_temp.r2_names_dropped(src text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$
    SELECT regexp_replace(src, '--[^\n]*', '', 'g')
           ~ '\m(event_rsvps|team_messages|upsert_team_event_rsvp|create_team_message)\M'
$f$;

CREATE FUNCTION pg_temp.r2_referrers() RETURNS text
LANGUAGE sql STABLE AS $f$
    SELECT string_agg(o, ', ' ORDER BY o) FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND pg_temp.r2_names_dropped(p.prosrc)
        UNION ALL
        SELECT 'view ' || c.relname
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
           AND pg_temp.r2_names_dropped(pg_get_viewdef(c.oid))
        UNION ALL
        SELECT format('policy %s on %s', policyname, tablename)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND pg_temp.r2_names_dropped(coalesce(qual, '') || ' ' || coalesce(with_check, ''))
    ) s
$f$;

DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(o, ', ') INTO v_left FROM (
        SELECT f AS o FROM unnest(ARRAY[
            'public.upsert_team_event_rsvp(uuid, uuid, uuid, text, date, text)',
            'public.create_team_message(uuid, text)'
        ]) f WHERE to_regprocedure(f) IS NOT NULL
        UNION ALL
        SELECT r FROM unnest(ARRAY['public.event_rsvps', 'public.team_messages']) r
         WHERE to_regclass(r) IS NOT NULL
        UNION ALL
        SELECT 'function ' || p.oid::regprocedure::text FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('upsert_team_event_rsvp', 'create_team_message')
        UNION ALL
        SELECT 'publication ' || pubname FROM pg_publication_tables
         WHERE tablename IN ('event_rsvps', 'team_messages')
    ) s;
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'objects 20261022030000 dropped are back: %', v_left;
    END IF;

    -- The scan must see a function that names a dropped table in code (planted
    -- and undone inside a block) before its silence means anything; and a
    -- comment naming one must not count, or persist_team_schedule's would.
    v_left := NULL;
    BEGIN
        CREATE FUNCTION public.__r2_smoke_probe() RETURNS boolean
        LANGUAGE sql AS 'SELECT true AS event_rsvps';
        CREATE FUNCTION public.__r2_smoke_comment() RETURNS boolean
        LANGUAGE sql AS E'SELECT true -- team_messages\n';
        v_left := pg_temp.r2_referrers();
        RAISE EXCEPTION USING ERRCODE = 'P1022', MESSAGE = 'undo the planted probes';
    EXCEPTION WHEN SQLSTATE 'P1022' THEN NULL;
    END;
    IF v_left IS NULL OR v_left NOT LIKE '%function __r2_smoke_probe()%'
       OR v_left LIKE '%__r2_smoke_comment%' THEN
        RAISE EXCEPTION 'control: the scan did not see a planted function naming event_rsvps, or counted a comment (found: %)',
            coalesce(v_left, 'nothing');
    END IF;
    v_left := pg_temp.r2_referrers();
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'these still name a dropped table or function: %', v_left;
    END IF;
    RAISE NOTICE 'dropped: upsert_team_event_rsvp, create_team_message, event_rsvps and team_messages; no function, view, policy or publication names them (the scan shown to fire on a planted function and not on a comment)';

    SELECT string_agg(a, ', ') INTO v_left FROM unnest(ARRAY[
        'team.rsvp_updated', 'team.message_created'
    ]) a WHERE NOT EXISTS (SELECT 1 FROM public.audit_actions x WHERE x.action = a);
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'audit_actions lost the retired actions audit_log references: %', v_left;
    END IF;
    RAISE NOTICE 'team.rsvp_updated and team.message_created keep their audit_actions rows, so old audit_log rows stay valid';
END;
$$;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_coach uuid := gen_random_uuid();
    v_org uuid; v_s uuid; v_d uuid; v_t uuid; v_o uuid; v_loc uuid; v_f uuid;
    v_tue uuid; v_thu uuid; v_pa uuid; v_g uuid; v_p uuid;
    v_meta jsonb;
    v_missing text;
    v_cascades int;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
        (v_admin, 'r2-admin@example.test', '{"password_length": 16}', now()),
        (v_coach, 'r2-coach@example.test', '{"password_length": 16}', now());
    INSERT INTO public.profiles (id, email, full_name) VALUES
        (v_admin, 'r2-admin@example.test', 'R2 Admin'), (v_coach, 'r2-coach@example.test', 'R2 Coach')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org R2', 'smoke-org-r2') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_coach, 'coach');
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'R2 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'R2 U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'R2 Deleted') RETURNING id INTO v_t;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'R2 Opponent') RETURNING id INTO v_o;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'R2 Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active) VALUES (v_org, v_loc, 'R2 Pitch', true) RETURNING id INTO v_f;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until)
        VALUES (v_org, v_f, 'tue', '17:00', '18:30', 3, '2026-09-01', '2026-12-31') RETURNING id INTO v_tue;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, capacity, valid_from, valid_until)
        VALUES (v_org, v_f, 'thu', '17:00', '18:30', 3, '2026-09-01', '2026-12-31') RETURNING id INTO v_thu;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range)
        VALUES (v_org, v_t, v_tue, '[2026-09-01,2026-12-01)') RETURNING id INTO v_pa;
    INSERT INTO public.practice_exceptions (organization_id, season_settings_id, team_id, assignment_id, "window", kind,
        practice_slot_id, cause_kind)
        VALUES (v_org, v_s, v_t, v_pa, '[2026-09-08,2026-09-22)', 'relocated', v_thu, 'retirement');
    INSERT INTO public.games (organization_id, home_team_id, away_team_id, start_time)
        VALUES (v_org, v_t, v_o, '2026-11-07 15:00+00') RETURNING id INTO v_g;
    INSERT INTO public.players (organization_id, division_id, first_name, last_name) VALUES (v_org, v_d, 'R2', 'One') RETURNING id INTO v_p;
    INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES (v_t, v_p, v_org);

    PERFORM set_config('request.jwt.claim.sub', v_coach::text, true);
    BEGIN
        PERFORM public.admin_delete_team(v_t);
        RAISE EXCEPTION 'a coach deleted a team';
    EXCEPTION WHEN insufficient_privilege THEN
        NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = v_t) THEN
        RAISE EXCEPTION 'the refused delete removed the team';
    END IF;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    PERFORM public.admin_delete_team(v_t);

    IF EXISTS (SELECT 1 FROM public.teams WHERE id = v_t)
       OR EXISTS (SELECT 1 FROM public.games WHERE id = v_g)
       OR EXISTS (SELECT 1 FROM public.practice_assignments WHERE id = v_pa)
       OR EXISTS (SELECT 1 FROM public.practice_exceptions WHERE assignment_id = v_pa) THEN
        RAISE EXCEPTION 'the team, its game, its series or its exception survived the delete';
    END IF;
    IF (SELECT count(*) FROM public.audit_log
         WHERE action = 'practice.exception_withdrawn' AND organization_id = v_org
           AND metadata->>'reason' = 'team_deleted') <> 1 THEN
        RAISE EXCEPTION 'the live exception was not withdrawn on the record';
    END IF;

    SELECT metadata INTO v_meta FROM public.audit_log
     WHERE action = 'team.deleted' AND resource_id = v_t;
    IF v_meta IS NULL THEN
        RAISE EXCEPTION 'no team.deleted row';
    END IF;
    IF v_meta ? 'event_rsvps_deleted' OR v_meta ? 'team_messages_deleted' THEN
        RAISE EXCEPTION 'team.deleted still counts a dropped table: %', v_meta;
    END IF;
    IF v_meta->>'games_deleted' IS DISTINCT FROM '1'
       OR v_meta->>'practice_assignments_deleted' IS DISTINCT FROM '1'
       OR v_meta->>'practice_exceptions_deleted' IS DISTINCT FROM '1'
       OR v_meta->>'team_players_deleted' IS DISTINCT FROM '1'
       OR v_meta->'game_ids' IS DISTINCT FROM jsonb_build_array(v_g) THEN
        RAISE EXCEPTION 'team.deleted did not record what the delete took: %', v_meta;
    END IF;

    -- Every table the cascade from teams empties has a counter, enumerated
    -- from the catalogue rather than from the function.
    SELECT count(DISTINCT c.conrelid), string_agg(DISTINCT c.conrelid::regclass::text, ', ')
             FILTER (WHERE NOT v_meta ? (replace(c.conrelid::regclass::text, 'public.', '') || '_deleted'))
      INTO v_cascades, v_missing
      FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confrelid = 'public.teams'::regclass AND c.confdeltype = 'c';
    IF v_cascades < 7 THEN
        RAISE EXCEPTION 'the catalogue walk found only % cascading table(s): it examined nothing', v_cascades;
    END IF;
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'team.deleted has no counter for: %', v_missing;
    END IF;
    RAISE NOTICE 'admin_delete_team: a coach is refused 42501; an admin deletes the team, its game and series, the live exception is withdrawn on the record, and team.deleted counts each of the % cascading tables and no RSVP or chat table', v_cascades;
END;
$$;

DO $$
DECLARE
    v_res jsonb;
BEGIN
    v_res := public.reconcile_prod_rls_drift();
    IF jsonb_array_length(v_res->'created') <> 0 OR jsonb_array_length(v_res->'dropped') <> 0
       OR jsonb_array_length(v_res->'verified') <> 19 THEN
        RAISE EXCEPTION 'on the head chain the reconcile must create 0, drop 0 and verify 19; got %', v_res;
    END IF;
    IF v_res::text ~ '\m(team_messages|event_rsvps)\M' THEN
        RAISE EXCEPTION 'the reconcile still names a dropped table: %', v_res;
    END IF;
    RAISE NOTICE 'reconcile_prod_rls_drift runs on the head chain: created 0, dropped 0, verified 19, none on a dropped table';
END;
$$;

DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
      FROM pg_proc p
     WHERE p.oid = 'public.admin_delete_team(uuid)'::regprocedure
       AND NOT (p.prosecdef
                AND 'search_path=public' = ANY (coalesce(p.proconfig, ARRAY[]::text[]))
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'admin_delete_team lost its posture: %', v_bad;
    END IF;
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
      FROM pg_proc p
     WHERE p.oid = 'public.reconcile_prod_rls_drift()'::regprocedure
       AND NOT (NOT p.prosecdef
                AND 'search_path=public' = ANY (coalesce(p.proconfig, ARRAY[]::text[]))
                AND has_function_privilege('service_role', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'reconcile_prod_rls_drift lost its posture: %', v_bad;
    END IF;
    RAISE NOTICE 'posture: admin_delete_team SECURITY DEFINER, search_path=public, authenticated not anon; reconcile_prod_rls_drift SECURITY INVOKER, search_path=public, service_role only';
END;
$$;

ROLLBACK;
