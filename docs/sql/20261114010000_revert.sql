-- Revert for 20261114010000_demo_season_choice.sql
--
-- Restores `start_demo_session()` to its 20261110010000 body (checked by md5 at the end, carriage
-- returns removed) and its comment, then drops `start_demo_session(text)` and
-- `demo_seed.season_window(text, date)`. The restored function dates a demo as it did before: the twelve
-- weeks that begin on the Monday after the current week.
--
-- **What it cannot undo.** A demo started while the migration was in place keeps its season (`Fall 2027`,
-- the chosen window's dates) until it expires and is purged (a demo lives 30 minutes); nothing else is
-- touched. The NOTICE counts the live demos that were started with a chosen season.
--
-- **Revert the frontend with it.** The app deployed with the season choice calls
-- `start_demo_session(p_season)`, which this drops; until the previous app is deployed, "Start the demo"
-- fails and says the demo could not be started.

BEGIN;

DO $revert$
BEGIN
    RAISE NOTICE 'this revert leaves % live demo organization(s) started with a chosen season to expire in the season they were started with',
        (SELECT count(*) FROM public.organizations o
          WHERE o.demo_expires_at > now()
            AND EXISTS (SELECT 1 FROM public.season_settings s
                         WHERE s.organization_id = o.id AND s.season_label IN ('Fall', 'Spring')));
END;
$revert$;

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
    v_practice_run uuid;
    v_expected     integer;
    v_rows         integer;
    v_teams        integer;
    v_assigned     integer;
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

    -- 20261110010000: each division says how many practices a week its teams get and how long each is
    -- (`practices_per_week`, `practice_minutes`, 20261105010000), from the seed.
    INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy, play_format,
                                  min_age, max_age, max_roster_size, plays_games, season_start, season_end,
                                  practices_per_week, practice_minutes)
    SELECT v_org, v_season, d.name, d.gender_policy, d.play_format, d.min_age, d.max_age,
           d.max_roster_size, d.plays_games, v_start, v_end,
           d.practices_per_week, d.practice_minutes
      FROM demo_seed.divisions d;

    -- 20261101020000: the league's programs, which span divisions (Minis is U4, Micro U5-U6,
    -- Junior U7-U8, Select U14-U19; U9, U10 and U12 stay in the season's default program). The
    -- season's default program exists already (a trigger on season_settings made it).
    INSERT INTO public.programs (organization_id, season_settings_id, name)
    SELECT v_org, v_season, p.program_name
      FROM (SELECT DISTINCT dp.program_name FROM demo_seed.division_programs dp) p;
    UPDATE public.divisions dv
       SET program_id = pr.id
      FROM demo_seed.division_programs dp
      JOIN public.programs pr ON pr.season_settings_id = v_season AND pr.name = dp.program_name
     WHERE dv.season_settings_id = v_season AND dv.name = dp.division_key;

    INSERT INTO public.teams (organization_id, division_id, name)
    SELECT v_org, dv.id, t.name
      FROM demo_seed.teams t
      JOIN public.divisions dv ON dv.organization_id = v_org AND dv.name = t.division_key;

    -- `coaches.email` is unique across organizations: each copy's addresses carry its own tag.
    INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email, status)
    SELECT v_org, v_season, c.full_name,
           replace(c.email, '@', '+' || substr(replace(v_org::text, '-', ''), 1, 12) || '@'), c.status
      FROM demo_seed.coaches c;

    INSERT INTO public.players (organization_id, season_settings_id, division_id, team_id, first_name,
                                last_name, external_registration_id, gender, status, years_played,
                                willing_to_coach, play_up_requested, buddy_request, natural_age)
    SELECT v_org, v_season, t.division_id, t.id, p.first_name, p.last_name, p.external_registration_id,
           p.gender, p.status, p.years_played, p.willing_to_coach, p.play_up_requested,
           p.buddy_request, p.natural_age
      FROM demo_seed.players p
      JOIN public.teams t ON t.organization_id = v_org AND t.name = p.team_name;

    INSERT INTO public.team_players (team_id, player_id, organization_id, role, source)
    SELECT pl.team_id, pl.id, v_org, 'player', 'auto'
      FROM public.players pl
     WHERE pl.organization_id = v_org AND pl.team_id IS NOT NULL;

    -- 20261110010000: lighting is the seed's, not every ground's: one lit ground, whose late and long
    -- practices the daylight pass lets run past sunset; on the rest a practice past sunset is flagged.
    INSERT INTO public.locations (organization_id, name, lighting_available, latitude, longitude)
    SELECT v_org, l.name, l.lighting_available, l.latitude, l.longitude FROM demo_seed.locations l;

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

    -- 20261110010000: the league's applied weekly practice schedule, so a demo's team pages, coach home
    -- and exports show practices from the first minute (`demo_seed.practice_schedule`, generated from
    -- the fixture by the real solver, scripts/build-demo-practice-seed.mjs): U4's Saturday sessions and
    -- U5 to U8's two practices a week. The rows are what a saved auto-schedule leaves: one
    -- `practice_assignments` row per team and weekly slot, live from the slot's first date in the
    -- season to the season's end, under a completed `practice` run (the setup checklist and the
    -- readiness panel read it). Every seeded row must find its slot: a row that did not would be a
    -- team silently without a practice, so the demo does not start instead. U9 and older have none:
    -- they are the teams the visitor's own auto-scheduler run places.
    SELECT count(*) INTO v_expected FROM demo_seed.practice_schedule;
    INSERT INTO public.scheduler_runs (organization_id, season_id, season_settings_id, run_type, status,
                                       parameters, metrics, results, created_by, started_at, completed_at)
    VALUES (v_org, v_season, v_season, 'practice', 'completed',
            jsonb_build_object('source', 'demo_seed'), '{}'::jsonb, '{}'::jsonb, v_uid, now(), now())
    RETURNING id INTO v_practice_run;

    INSERT INTO public.practice_assignments (organization_id, run_id, team_id, slot_id, practice_slot_id,
                                             day_of_week, start_time, end_time, field_id,
                                             effective_date_range, source, assigned_via)
    SELECT v_org, v_practice_run, t.id, ps.id, ps.id, ps.day_of_week::text, ps.start_time::text,
           ps.end_time::text, ps.field_id,
           -- The season starts on a Monday (v_start): the slot's first date is that weekday's first
           -- occurrence, and the range runs to the season's last day, inclusive.
           daterange(v_start + (array_position(ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
                                               s.day_of_week) - 1), v_end, '[]'),
           'auto', 'auto'
      FROM demo_seed.practice_schedule s
      JOIN public.teams t ON t.organization_id = v_org AND t.name = s.team_name
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = s.location_name
      JOIN public.fields fl ON fl.location_id = loc.id AND fl.name = s.field_name
      LEFT JOIN public.field_subunits su ON su.field_id = fl.id AND su.label = s.subunit_label
      JOIN public.practice_slots ps ON ps.organization_id = v_org AND ps.field_id = fl.id
                                   AND ps.field_subunit_id IS NOT DISTINCT FROM su.id
                                   AND ps.day_of_week = s.day_of_week::public.day_of_week
                                   AND ps.start_time = s.start_time;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'The demo league''s practice schedule did not match its slots (% of % rows)', v_rows, v_expected
            USING ERRCODE = 'P0001', DETAIL = 'demo_seed_practice_mismatch';
    END IF;

    -- The run's readiness snapshot, counted from the rows just written (the shape `practiceMetrics`
    -- publishes; only what the panels read). Teams are counted once however many practices they hold.
    SELECT count(*) INTO v_teams FROM public.teams WHERE organization_id = v_org;
    SELECT count(DISTINCT team_id) INTO v_assigned FROM public.practice_assignments WHERE run_id = v_practice_run;
    UPDATE public.scheduler_runs
       SET results = jsonb_build_object(
               'summary', jsonb_build_object(
                   'totalTeams', v_teams, 'assignedTeams', v_assigned, 'unassignedTeams', v_teams - v_assigned,
                   'assignmentsRead', v_rows, 'assignmentsCounted', v_rows,
                   'assignmentRate', CASE WHEN v_teams > 0 THEN round(v_assigned::numeric / v_teams, 4) ELSE 0 END,
                   'manualFollowUpRate', CASE WHEN v_teams > 0 THEN round((v_teams - v_assigned)::numeric / v_teams, 4) ELSE 0 END),
               'unassignedByReason', CASE WHEN v_teams > v_assigned
                   THEN jsonb_build_array(jsonb_build_object('reason', 'not scheduled yet', 'count', v_teams - v_assigned))
                   ELSE '[]'::jsonb END,
               'dataQualityWarnings', '[]'::jsonb)
     WHERE id = v_practice_run;

    PERFORM public.record_audit_event(
        v_org, 'demo.started', 'organization', v_org,
        jsonb_build_object('expires_at', v_expires, 'minutes', c_minutes)
    );

    RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', false);
END;
$function$;

COMMENT ON FUNCTION public.start_demo_session() IS
    'An anonymous visitor''s demo: copies demo_seed into a new organization that expires in 30 minutes, with the league''s programs, its divisions'' practices, one lit ground and its applied weekly practice schedule for U4 and U5 to U8. Returns {organization_id, expires_at, existing}.';

DROP FUNCTION public.start_demo_session(text);
DROP FUNCTION demo_seed.season_window(text, date);

DO $revert$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = 'public.start_demo_session()'::regprocedure;
    IF v_md5 IS DISTINCT FROM 'b0d65c16975551bcc8e839ea2371b0fc' THEN
        RAISE EXCEPTION 'start_demo_session was not restored to its 20261110010000 body (md5 %)', v_md5;
    END IF;
    IF to_regprocedure('public.start_demo_session(text)') IS NOT NULL
       OR to_regprocedure('demo_seed.season_window(text, date)') IS NOT NULL THEN
        RAISE EXCEPTION 'a function this migration added survived its revert';
    END IF;
    IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'start_demo_session') <> 1 THEN
        RAISE EXCEPTION 'start_demo_session has more than one signature after its revert';
    END IF;
    IF has_function_privilege('anon', 'public.start_demo_session()', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.start_demo_session()', 'EXECUTE') THEN
        RAISE EXCEPTION 'the restored demo start is not granted to signed-in callers only';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.start_demo_session()'::regprocedure) ~ 'season_window' THEN
        RAISE EXCEPTION 'the restored demo start still names the season rule';
    END IF;
    RAISE NOTICE 'revert verified: the demo start is back as at 20261110010000 (the coming twelve weeks), the season choice and its rule are gone';
END;
$revert$;

COMMIT;
