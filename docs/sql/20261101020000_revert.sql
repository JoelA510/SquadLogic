-- Revert for 20261101020000_programs.sql
--
-- Restores `start_demo_session()` to its 20261030010000 body (checked by md5 at the end), drops
-- the four program writers, both triggers and their functions, `divisions.program_id` with its
-- reference and index, `demo_seed.division_programs`, the `programs` table and the
-- `season_settings (id, organization_id)` key. The four audit actions are unregistered only while
-- no audit row uses them (an audit row's action is a foreign key; history is not this revert's
-- to erase); the transcript says which happened.
--
-- **What it destroys.** The programs an admin made and every division's membership of one: after
-- this every division is in no program again, which is what every division was before. The
-- NOTICE counts both. Teams, players and schedules key on the division and are untouched.

BEGIN;

DO $revert$
DECLARE
    v_programs bigint;
    v_divisions bigint;
BEGIN
    SELECT count(*) INTO v_programs FROM public.programs WHERE NOT is_default;
    SELECT count(*) INTO v_divisions FROM public.divisions d
      JOIN public.programs p ON p.id = d.program_id WHERE NOT p.is_default;
    RAISE NOTICE 'this revert DESTROYS % program(s) beyond the default, and the program of % division(s)', v_programs, v_divisions;
END;
$revert$;

-- ---------------------------------------------------------------------------
-- 1. The demo start, as it was.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_demo_session()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    c_minutes constant integer := 30;   -- decision 8
    c_cap     constant integer := 10;   -- decision 2
    v_uid     uuid := auth.uid();
    v_org     uuid;
    v_expires timestamptz;
    v_live    integer;
    v_name    text;
    v_tz      text;
    v_weeks   integer;
    v_season  uuid;
    v_start   date;
    v_end     date;
    v_year    integer;
    v_team    record;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT public.caller_is_anonymous() THEN
        RAISE EXCEPTION 'Only a demo visitor can start a demo'
            USING ERRCODE = '42501', DETAIL = 'demo_requires_anonymous';
    END IF;

    -- One caller at a time past this point, so the cap and the one-per-visitor rule are judged
    -- against what the callers before this one committed.
    PERFORM pg_advisory_xact_lock(hashtextextended('squadlogic.start_demo_session', 0));

    SELECT o.id, o.demo_expires_at INTO v_org, v_expires
      FROM public.organizations o WHERE o.demo_owner = v_uid;
    IF FOUND THEN
        IF v_expires > now() THEN
            RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', true);
        END IF;
        -- The visitor's own demo has ended and is waiting for the purge: it goes now.
        DELETE FROM public.organizations WHERE id = v_org;
    END IF;

    SELECT count(*) INTO v_live FROM public.organizations WHERE demo_expires_at > now();
    IF v_live >= c_cap THEN
        RAISE LOG 'start_demo_session refused: % live demos, the cap is %', v_live, c_cap;
        RAISE EXCEPTION 'The demo is busy right now. Try again in a few minutes.'
            USING ERRCODE = 'P0001', DETAIL = 'demo_capacity';
    END IF;

    SELECT l.organization_name, l.timezone, l.season_weeks INTO v_name, v_tz, v_weeks FROM demo_seed.league l;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The demo league is not available' USING ERRCODE = 'P0001', DETAIL = 'demo_seed_empty';
    END IF;

    -- The season is the coming twelve weeks whenever the demo starts.
    v_start := date_trunc('week', now() AT TIME ZONE v_tz)::date + 7;
    v_end := v_start + v_weeks * 7 - 1;
    v_year := extract(year FROM v_start)::integer;

    -- Not yet marked a demo: the fences would refuse the seed. It is marked below, last.
    INSERT INTO public.organizations (name, slug, contact_info, is_onboarded)
    VALUES (v_name, 'demo-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
            jsonb_build_object('timezone', v_tz), true)
    RETURNING id INTO v_org;

    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_label, timezone,
                                        season_start, season_end)
    VALUES (v_org, v_year || ' Season', 'active', v_year, v_year || ' Season', v_tz, v_start, v_end)
    RETURNING id INTO v_season;

    INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy, play_format,
                                  min_age, max_age, max_roster_size, plays_games, season_start, season_end)
    SELECT v_org, v_season, d.name, d.gender_policy, d.play_format, d.min_age, d.max_age,
           d.max_roster_size, d.plays_games, v_start, v_end
      FROM demo_seed.divisions d;

    INSERT INTO public.teams (organization_id, division_id, name)
    SELECT v_org, dv.id, t.name
      FROM demo_seed.teams t
      JOIN public.divisions dv ON dv.organization_id = v_org AND dv.name = t.division_key;

    -- `coaches.email` is unique across organizations: each copy's addresses carry its own tag.
    INSERT INTO public.coaches (organization_id, full_name, email, status)
    SELECT v_org, c.full_name,
           replace(c.email, '@', '+' || substr(replace(v_org::text, '-', ''), 1, 12) || '@'), c.status
      FROM demo_seed.coaches c;

    INSERT INTO public.players (organization_id, division_id, team_id, first_name, last_name,
                                external_registration_id, gender, status, years_played, willing_to_coach,
                                play_up_requested, buddy_request, natural_age)
    SELECT v_org, t.division_id, t.id, p.first_name, p.last_name, p.external_registration_id,
           p.gender, p.status, p.years_played, p.willing_to_coach, p.play_up_requested,
           p.buddy_request, p.natural_age
      FROM demo_seed.players p
      JOIN public.teams t ON t.organization_id = v_org AND t.name = p.team_name;

    INSERT INTO public.team_players (team_id, player_id, organization_id, role, source)
    SELECT pl.team_id, pl.id, v_org, 'player', 'auto'
      FROM public.players pl
     WHERE pl.organization_id = v_org AND pl.team_id IS NOT NULL;

    INSERT INTO public.locations (organization_id, name, lighting_available, latitude, longitude)
    SELECT v_org, l.name, true, l.latitude, l.longitude FROM demo_seed.locations l;

    INSERT INTO public.fields (organization_id, location_id, name, surface_type, supports_halves)
    SELECT v_org, loc.id, f.name, f.surface_type, f.supports_halves
      FROM demo_seed.fields f
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = f.location_name;

    INSERT INTO public.field_subunits (organization_id, field_id, label)
    SELECT v_org, fl.id, s.label
      FROM demo_seed.field_subunits s
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = s.location_name
      JOIN public.fields fl ON fl.location_id = loc.id AND fl.name = s.field_name;

    INSERT INTO public.practice_slots (organization_id, field_id, field_subunit_id, day_of_week, start_time,
                                       end_time, capacity, division_id)
    SELECT v_org, fl.id, su.id, s.day_of_week::public.day_of_week, s.start_time, s.end_time, s.capacity, dv.id
      FROM demo_seed.practice_slots s
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = s.location_name
      JOIN public.fields fl ON fl.location_id = loc.id AND fl.name = s.field_name
      LEFT JOIN public.field_subunits su ON su.field_id = fl.id AND su.label = s.subunit_label
      LEFT JOIN public.divisions dv ON dv.organization_id = v_org AND dv.name = s.division_key;

    -- Marked last, then the visitor joins: both pass the fences, which now see a demo.
    v_expires := now() + make_interval(mins => c_minutes);
    UPDATE public.organizations SET demo_expires_at = v_expires, demo_owner = v_uid WHERE id = v_org;
    -- A SELECT, not a VALUES list: the role is the creator's (as in initialize_new_tenant), not a role
    -- test, and tests/staff_is_admin.sql reads any parenthesised list naming 'admin' as a role list.
    INSERT INTO public.organization_members (organization_id, profile_id, role)
    SELECT v_org, v_uid, 'admin';

    -- The one writer of a team's coaches (it keeps teams.coach_id, assistant_coach_ids and the assignment
    -- rows together; the catalogue allows no other). It audits as the caller, who is a member by now: one
    -- team.coach_assignments_changed row per team, as an admin's own assignments would leave.
    FOR v_team IN
        SELECT t.id AS team_id,
               (array_agg(c.id) FILTER (WHERE tc.role = 'lead'))[1] AS lead_id,
               COALESCE(array_agg(c.id ORDER BY c.full_name) FILTER (WHERE tc.role = 'assistant'), ARRAY[]::uuid[]) AS assistant_ids
          FROM demo_seed.team_coaches tc
          JOIN public.teams t ON t.organization_id = v_org AND t.name = tc.team_name
          JOIN public.coaches c ON c.organization_id = v_org AND c.full_name = tc.coach_name
         GROUP BY t.id
    LOOP
        PERFORM public.set_team_coaches(v_team.team_id, v_team.lead_id, v_team.assistant_ids, current_date, 'demo_seed');
    END LOOP;

    -- The team run the Teams, Practices and Games pages read their teams from (`scheduler_runs`, the
    -- latest completed `team` run of the season; `mapSchedulerRunToSummary`). A league formed some other
    -- way than by a team run has none, and those pages treat it as a cold start: the auto-scheduler
    -- stays disabled with "no teams". So the seeded league gets the run its teams would have left,
    -- built from the copied rows: each division's teams (their stored coaches) and each team's roster.
    WITH team_rows AS (
        SELECT dv.name AS division_name, dv.max_roster_size, t.id, t.name, t.division_id, t.coach_id,
               t.assistant_coach_ids,
               (SELECT count(*) FROM public.team_players tp WHERE tp.team_id = t.id) AS n_players
          FROM public.teams t
          JOIN public.divisions dv ON dv.id = t.division_id
         WHERE t.organization_id = v_org
    ), by_division AS (
        SELECT division_name,
               jsonb_agg(jsonb_build_object(
                   'id', id, 'name', name, 'division', division_name, 'divisionId', division_id,
                   'coachId', coach_id,
                   'assistantCoachIds', to_jsonb(COALESCE(assistant_coach_ids, ARRAY[]::uuid[]))
               ) ORDER BY name) AS teams,
               sum(n_players)::integer AS players,
               sum(COALESCE(max_roster_size, 0))::integer AS capacity
          FROM team_rows
         GROUP BY division_name
    )
    INSERT INTO public.scheduler_runs (organization_id, season_id, season_settings_id, run_type, status,
                                       parameters, metrics, results, created_by, started_at, completed_at)
    SELECT v_org, v_season, v_season, 'team', 'completed',
           jsonb_build_object('source', 'demo_seed'), '{}'::jsonb,
           jsonb_build_object(
               'teamsByDivision', (SELECT jsonb_object_agg(division_name, teams) FROM by_division),
               'rosterBalanceByDivision', (SELECT jsonb_object_agg(division_name, jsonb_build_object(
                   'summary', jsonb_build_object(
                       'totalPlayers', players, 'totalCapacity', capacity,
                       'averageFillRate', CASE WHEN capacity > 0 THEN round(players::numeric / capacity, 4) ELSE 0 END)))
                   FROM by_division),
               'team_players', COALESCE((SELECT jsonb_agg(jsonb_build_object('team_id', tp.team_id, 'player_id', tp.player_id))
                                           FROM public.team_players tp WHERE tp.organization_id = v_org), '[]'::jsonb)
           ),
           v_uid, now(), now();

    PERFORM public.record_audit_event(
        v_org, 'demo.started', 'organization', v_org,
        jsonb_build_object('expires_at', v_expires, 'minutes', c_minutes)
    );

    RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', false);
END;
$function$;

COMMENT ON FUNCTION public.start_demo_session() IS
    'An anonymous visitor''s demo: copies demo_seed into a new organization that expires in 30 minutes. Returns {organization_id, expires_at, existing}.';

DROP TABLE demo_seed.division_programs;

-- ---------------------------------------------------------------------------
-- 2. The writers.
-- ---------------------------------------------------------------------------

DROP FUNCTION public.admin_upsert_program(uuid, uuid, text);
DROP FUNCTION public.admin_set_division_program(uuid, uuid);
DROP FUNCTION public.admin_delete_program(uuid);
DROP FUNCTION public.admin_merge_programs(uuid, uuid);

-- ---------------------------------------------------------------------------
-- 3. The columns, triggers and table.
-- ---------------------------------------------------------------------------

DROP TRIGGER divisions_default_program ON public.divisions;
DROP FUNCTION public.divisions_default_program();
DROP INDEX public.idx_divisions_program_id;
ALTER TABLE public.divisions DROP CONSTRAINT divisions_program_season_fkey;
ALTER TABLE public.divisions DROP COLUMN program_id;

DROP TRIGGER season_settings_default_program ON public.season_settings;
DROP FUNCTION public.season_settings_default_program();
DROP TABLE public.programs;
ALTER TABLE public.season_settings DROP CONSTRAINT season_settings_id_organization_id_key;

-- ---------------------------------------------------------------------------
-- 4. The audit actions, while no audit row uses them.
-- ---------------------------------------------------------------------------

DO $revert$
DECLARE
    v_rows bigint;
BEGIN
    SELECT count(*) INTO v_rows FROM public.audit_log
     WHERE action IN ('program.upserted', 'program.deleted', 'program.merged', 'division.program_changed');
    IF v_rows = 0 THEN
        DELETE FROM public.audit_actions
         WHERE action IN ('program.upserted', 'program.deleted', 'program.merged', 'division.program_changed');
        RAISE NOTICE 'the four program audit actions are unregistered; no audit row used them';
    ELSE
        RAISE NOTICE 'the four program audit actions stay registered: % audit row(s) use them', v_rows;
    END IF;
END;
$revert$;

-- ---------------------------------------------------------------------------
-- 5. Verified, or the revert does not commit.
-- ---------------------------------------------------------------------------

DO $revert$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = 'public.start_demo_session()'::regprocedure;
    IF v_md5 IS DISTINCT FROM '5b8a6002c3150e41f1b47ad1704b9ef9' THEN
        RAISE EXCEPTION 'start_demo_session was not restored to its 20261030010000 body (md5 %)', v_md5;
    END IF;
    IF to_regclass('public.programs') IS NOT NULL OR to_regclass('demo_seed.division_programs') IS NOT NULL THEN
        RAISE EXCEPTION 'a program table survived its own revert';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'divisions' AND column_name = 'program_id') THEN
        RAISE EXCEPTION 'divisions.program_id survived its own revert';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                AND proname IN ('admin_upsert_program', 'admin_set_division_program', 'admin_delete_program',
                                'admin_merge_programs', 'season_settings_default_program', 'divisions_default_program')) THEN
        RAISE EXCEPTION 'a program function survived its own revert';
    END IF;
    RAISE NOTICE 'revert verified: the demo start is back as at 20261030010000, and the programs, their writers, triggers and column are gone';
END;
$revert$;

COMMIT;
