-- The demo league starts with an applied weekly practice schedule (owner approval 2026-10-27).
--
-- **Why.** A demo copies `demo_seed` into a new organization, and the seed had no practices or games,
-- so the demo's team pages and coach home showed none and its exports came out with headers only (the
-- Exports page now says why, #667). A visitor judging the product saw an empty calendar.
--
-- **The change.**
--   1. `demo_seed.practice_schedule` (team, ground, weekday, start): where the league's U4 and U5 to U8
--      teams (68 of its 128) practise each week, on the seeded facility grid. Generated from `fixtures/demo-2026/` by
--      scripts/build-demo-practice-seed.mjs between the two markers below; tests/demoPracticeSeed.test.js
--      regenerates it and holds it to its rules, read from the fixture rather than from the generator:
--        - the four U4 cohorts (practice-only) each meet once a week, in the 30-minute sessions reserved
--          to U4, one cohort at a time, at least 15 minutes apart;
--        - every U5 to U8 team (boys and girls) practises once a week on the open grid, Monday to
--          Thursday, 16:00 to 19:00 in the season's time zone (America/Los_Angeles), younger teams
--          earlier;
--        - U9 and older have no practice: they are the teams a demo visitor runs the auto-scheduler on;
--        - no slot holds more teams than its capacity, no team is in two slots at once, and no coach is
--          in two places at once.
--      Placeholder data only: the fixture's team names and the facility grid; no person is named.
--   2. `start_demo_session()` replaced from its latest body (20261101020000, md5 checked with carriage
--      returns removed, as 20261101010000 does: production stores some bodies with CRLF line ends). After
--      the team run it writes a completed `practice` run and one `practice_assignments` row per seeded
--      row, each live from its weekday's first date in the season (which starts on a Monday) to the
--      season's last day, plus the readiness snapshot the setup checklist and panel read, counted from
--      the rows written. A seeded row that finds no slot refuses the start (`demo_seed_practice_mismatch`)
--      rather than leave a team without its practice. Everything else in the function is as it was.
--   3. An end-state check: the seed is complete and consistent, and the function is the new one.
--
-- **What an admin notices.** In a new demo, the practice page, team pages, coach home and the exports show
-- practices for U4 and U5 to U8. Those 68 teams are locked, as any applied practice is; the 60 teams of
-- U9 and older have none, and the auto-scheduler places exactly them.
--
-- No DDL touches the auth or storage schemas. Every drop names its object, with no CASCADE. An existing
-- demo organization is untouched (the function only runs when a visitor starts a new one).
--
-- Reversible: docs/sql/20261103010000_revert.sql restores the previous demo start (md5 checked) and drops
-- `demo_seed.practice_schedule`. Smoke: docs/sql/20261103010000_smoke.sql. pgTAP:
-- supabase/tests/demo_practice_schedule.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What changes, counted.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    RAISE NOTICE 'live demo organizations (their copies are not changed): %',
        (SELECT count(*) FROM public.organizations WHERE demo_expires_at IS NOT NULL);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The seed table, and the schedule.
-- ---------------------------------------------------------------------------

-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.practice_schedule (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_name     text NOT NULL REFERENCES demo_seed.teams (name),
    location_name text NOT NULL,
    field_name    text NOT NULL,
    subunit_label text,
    day_of_week   text NOT NULL CHECK (day_of_week IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
    start_time    time NOT NULL,
    FOREIGN KEY (location_name, field_name) REFERENCES demo_seed.fields (location_name, name)
);
ALTER TABLE demo_seed.practice_schedule ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON demo_seed.practice_schedule FROM PUBLIC, anon, authenticated;

-- BEGIN GENERATED demo_seed practice rows (scripts/build-demo-practice-seed.mjs; do not edit)
INSERT INTO demo_seed.practice_schedule (team_name, location_name, field_name, subunit_label, day_of_week, start_time) VALUES
  ('U05B01', 'Orchard Park', 'Field 1', 'A', 'mon', '16:00'),
  ('U05B02', 'Orchard Park', 'Field 1', 'B', 'tue', '16:00'),
  ('U05B03', 'Orchard Park', 'Field 2', 'A', 'wed', '16:00'),
  ('U05B04', 'Orchard Park', 'Field 2', 'B', 'thu', '16:00'),
  ('U05B05', 'Orchard Park', 'Field 3', 'A', 'mon', '16:00'),
  ('U05B06', 'Orchard Park', 'Field 3', 'B', 'tue', '16:00'),
  ('U05B07', 'Riverside Fields', 'Field A', 'A', 'wed', '16:00'),
  ('U05B08', 'Riverside Fields', 'Field A', 'B', 'thu', '16:00'),
  ('U05G01', 'Riverside Fields', 'Field B', 'A', 'mon', '16:00'),
  ('U05G02', 'Riverside Fields', 'Field B', 'B', 'tue', '16:00'),
  ('U05G03', 'Eastgate Sports Complex', 'Field 1', 'A', 'wed', '16:00'),
  ('U05G04', 'Eastgate Sports Complex', 'Field 1', 'B', 'thu', '16:00'),
  ('U05G05', 'Orchard Park', 'Field 1', 'B', 'mon', '16:00'),
  ('U05G06', 'Orchard Park', 'Field 2', 'A', 'tue', '16:00'),
  ('U05G07', 'Orchard Park', 'Field 2', 'B', 'wed', '16:00'),
  ('U05G08', 'Orchard Park', 'Field 3', 'A', 'thu', '16:00'),
  ('U06B01', 'Orchard Park', 'Field 3', 'B', 'mon', '16:00'),
  ('U06B02', 'Riverside Fields', 'Field A', 'A', 'tue', '16:00'),
  ('U06B03', 'Riverside Fields', 'Field A', 'B', 'wed', '16:00'),
  ('U06B04', 'Riverside Fields', 'Field B', 'A', 'thu', '16:00'),
  ('U06B05', 'Riverside Fields', 'Field B', 'B', 'mon', '16:00'),
  ('U06B06', 'Eastgate Sports Complex', 'Field 1', 'A', 'tue', '16:00'),
  ('U06B07', 'Eastgate Sports Complex', 'Field 1', 'B', 'wed', '16:00'),
  ('U06B08', 'Orchard Park', 'Field 1', 'A', 'thu', '16:00'),
  ('U06G01', 'Orchard Park', 'Field 2', 'A', 'mon', '16:00'),
  ('U06G02', 'Orchard Park', 'Field 2', 'B', 'tue', '16:00'),
  ('U06G03', 'Orchard Park', 'Field 3', 'A', 'wed', '16:00'),
  ('U06G04', 'Orchard Park', 'Field 3', 'B', 'thu', '16:00'),
  ('U06G05', 'Riverside Fields', 'Field A', 'A', 'mon', '16:00'),
  ('U06G06', 'Riverside Fields', 'Field A', 'B', 'tue', '16:00'),
  ('U06G07', 'Riverside Fields', 'Field B', 'A', 'wed', '16:00'),
  ('U06G08', 'Riverside Fields', 'Field B', 'B', 'thu', '16:00'),
  ('U07B01', 'Riverside Fields', 'Field B', 'A', 'mon', '16:45'),
  ('U07B02', 'Riverside Fields', 'Field B', 'B', 'tue', '16:45'),
  ('U07B03', 'Eastgate Sports Complex', 'Field 1', 'A', 'wed', '16:45'),
  ('U07B04', 'Eastgate Sports Complex', 'Field 1', 'B', 'thu', '16:45'),
  ('U07B05', 'Orchard Park', 'Field 1', 'A', 'mon', '16:45'),
  ('U07B06', 'Orchard Park', 'Field 1', 'B', 'tue', '16:45'),
  ('U07B07', 'Orchard Park', 'Field 2', 'A', 'wed', '16:45'),
  ('U07B08', 'Orchard Park', 'Field 2', 'B', 'thu', '16:45'),
  ('U07G01', 'Orchard Park', 'Field 3', 'A', 'mon', '16:45'),
  ('U07G02', 'Orchard Park', 'Field 3', 'B', 'tue', '16:45'),
  ('U07G03', 'Riverside Fields', 'Field A', 'A', 'wed', '16:45'),
  ('U07G04', 'Riverside Fields', 'Field A', 'B', 'thu', '16:45'),
  ('U07G05', 'Riverside Fields', 'Field B', 'B', 'mon', '16:45'),
  ('U07G06', 'Eastgate Sports Complex', 'Field 1', 'A', 'tue', '16:45'),
  ('U07G07', 'Eastgate Sports Complex', 'Field 1', 'B', 'wed', '16:45'),
  ('U07G08', 'Orchard Park', 'Field 1', 'A', 'thu', '16:45'),
  ('U08B01', 'Orchard Park', 'Field 1', 'B', 'mon', '16:45'),
  ('U08B02', 'Orchard Park', 'Field 2', 'A', 'tue', '16:45'),
  ('U08B03', 'Orchard Park', 'Field 2', 'B', 'wed', '16:45'),
  ('U08B04', 'Orchard Park', 'Field 3', 'A', 'thu', '16:45'),
  ('U08B05', 'Orchard Park', 'Field 3', 'B', 'mon', '16:45'),
  ('U08B06', 'Riverside Fields', 'Field A', 'A', 'tue', '16:45'),
  ('U08B07', 'Riverside Fields', 'Field A', 'B', 'wed', '16:45'),
  ('U08B08', 'Riverside Fields', 'Field B', 'A', 'thu', '16:45'),
  ('U08G01', 'Eastgate Sports Complex', 'Field 1', 'A', 'mon', '16:45'),
  ('U08G02', 'Eastgate Sports Complex', 'Field 1', 'B', 'tue', '16:45'),
  ('U08G03', 'Orchard Park', 'Field 1', 'A', 'wed', '16:45'),
  ('U08G04', 'Orchard Park', 'Field 1', 'B', 'thu', '16:45'),
  ('U08G05', 'Orchard Park', 'Field 2', 'A', 'mon', '16:45'),
  ('U08G06', 'Orchard Park', 'Field 2', 'B', 'tue', '16:45'),
  ('U08G07', 'Orchard Park', 'Field 3', 'A', 'wed', '16:45'),
  ('U08G08', 'Orchard Park', 'Field 3', 'B', 'thu', '16:45'),
  ('U4A', 'Orchard Park', 'Tot Lot', NULL, 'sat', '09:00'),
  ('U4B', 'Orchard Park', 'Tot Lot', NULL, 'sat', '09:45'),
  ('U4C', 'Orchard Park', 'Tot Lot', NULL, 'sat', '10:30'),
  ('U4D', 'Orchard Park', 'Tot Lot', NULL, 'sat', '11:15');
-- END GENERATED demo_seed practice rows

-- ---------------------------------------------------------------------------
-- 3. The demo start, with the schedule.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_md5 text;
BEGIN
    -- Production stores some function bodies with CRLF line ends: the hash ignores carriage returns.
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_demo_session()');
    IF v_md5 IS DISTINCT FROM '09adc994497a8c5c16e5233437b26f2f' THEN
        RAISE EXCEPTION 'public.start_demo_session() has a body this migration has not seen (md5 %): not replacing it', v_md5;
    END IF;
END;
$$;

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

    INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy, play_format,
                                  min_age, max_age, max_roster_size, plays_games, season_start, season_end)
    SELECT v_org, v_season, d.name, d.gender_policy, d.play_format, d.min_age, d.max_age,
           d.max_roster_size, d.plays_games, v_start, v_end
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

    -- 20261103010000: the league's applied weekly practice schedule, so a demo's team pages, coach home
    -- and exports show practices from the first minute (`demo_seed.practice_schedule`, generated from
    -- the fixture by scripts/build-demo-practice-seed.mjs). The rows are what a saved auto-schedule
    -- leaves: one `practice_assignments` row per team and weekly slot, live from the slot's first date in
    -- the season to the season's end, under a completed `practice` run (the setup checklist and the
    -- readiness panel read it). Every seeded row must find its slot: a row that did not would be a
    -- team silently without its practice, so the demo does not start instead.
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
    -- publishes; only what the panels read).
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
    'An anonymous visitor''s demo: copies demo_seed into a new organization that expires in 30 minutes, with the league''s programs and its applied weekly practice schedule. Returns {organization_id, expires_at, existing}.';

-- ---------------------------------------------------------------------------
-- 4. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_n integer;
    v_def text;
BEGIN
    -- U4 and U5 to U8 practise exactly once; U9 and older have no practice (the visitor's to schedule).
    SELECT count(*) INTO v_n FROM demo_seed.teams t
     WHERE (SELECT count(*) FROM demo_seed.practice_schedule s WHERE s.team_name = t.name)
           <> CASE WHEN regexp_replace(t.division_key, '[^0-9]', '', 'g')::int <= 8 THEN 1 ELSE 0 END;
    IF v_n <> 0 THEN RAISE EXCEPTION '% seeded team(s) have the wrong number of practices (U4 to U8 once, U9 and older none)', v_n; END IF;
    IF (SELECT count(DISTINCT team_name) FROM demo_seed.practice_schedule) <> 68 THEN
        RAISE EXCEPTION 'the schedule does not cover 68 teams';
    END IF;

    -- Every row finds its seeded slot, U4 only in the sessions reserved to it and nobody else there,
    -- and no slot holds more teams than its capacity.
    SELECT count(*) INTO v_n FROM demo_seed.practice_schedule s
     WHERE NOT EXISTS (
         SELECT 1 FROM demo_seed.practice_slots ps
          WHERE ps.location_name = s.location_name AND ps.field_name = s.field_name
            AND ps.subunit_label IS NOT DISTINCT FROM s.subunit_label
            AND ps.day_of_week = s.day_of_week AND ps.start_time = s.start_time);
    IF v_n <> 0 THEN RAISE EXCEPTION '% schedule row(s) name no seeded slot', v_n; END IF;
    SELECT count(*) INTO v_n FROM demo_seed.practice_schedule s
      JOIN demo_seed.teams t ON t.name = s.team_name
      JOIN demo_seed.practice_slots ps ON ps.location_name = s.location_name AND ps.field_name = s.field_name
           AND ps.subunit_label IS NOT DISTINCT FROM s.subunit_label
           AND ps.day_of_week = s.day_of_week AND ps.start_time = s.start_time
     WHERE ps.division_key IS DISTINCT FROM CASE WHEN t.division_key = 'U4' THEN 'U4' ELSE NULL END;
    IF v_n <> 0 THEN RAISE EXCEPTION '% row(s) put a team in a slot reserved to another division, or U4 in an open one', v_n; END IF;
    SELECT count(*) INTO v_n FROM (
        SELECT 1 FROM demo_seed.practice_schedule s
          JOIN demo_seed.practice_slots ps ON ps.location_name = s.location_name AND ps.field_name = s.field_name
               AND ps.subunit_label IS NOT DISTINCT FROM s.subunit_label
               AND ps.day_of_week = s.day_of_week AND ps.start_time = s.start_time
         GROUP BY ps.id, ps.capacity HAVING count(*) > ps.capacity) over_full;
    IF v_n <> 0 THEN RAISE EXCEPTION '% slot(s) hold more teams than their capacity', v_n; END IF;

    -- The demo start is the new one, and keeps what it had.
    SELECT prosrc INTO v_def FROM pg_proc WHERE oid = 'public.start_demo_session()'::regprocedure;
    IF v_def !~ 'demo_seed\.practice_schedule' OR v_def !~ 'demo_seed_practice_mismatch'
       OR v_def !~ 'demo_seed\.division_programs' OR v_def !~ 'demo_seed_empty' OR v_def !~ 'demo_capacity' THEN
        RAISE EXCEPTION 'start_demo_session is not the demo start with its practice schedule';
    END IF;
END;
$check$;

COMMIT;
