-- Revert for 20261110010000_demo_practices.sql
--
-- Restores `start_demo_session()` to its 20261108010000 body (checked by md5 at the end, carriage
-- returns removed), puts the demo's previous facility rows back (the 45-minute Monday-to-Thursday
-- grid, 196 slots on 7 grounds and 12 halves, every venue lit as the old function set them), and drops `demo_seed.practice_schedule`
-- and the columns this migration added to `demo_seed.divisions` and `demo_seed.locations`.
--
-- **What it cannot undo.** A demo started while the migration was in place keeps its practices, its
-- division settings and its lighting until it expires and is purged (a demo lives 30 minutes); nothing
-- else is touched. The NOTICE counts the live demos and the seeded rows it drops.

BEGIN;

DO $revert$
BEGIN
    RAISE NOTICE 'this revert drops % seeded practice row(s); % live demo organization(s) keep the schedule they were started with',
        (SELECT count(*) FROM demo_seed.practice_schedule),
        (SELECT count(*) FROM public.organizations WHERE demo_expires_at > now());
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
    'An anonymous visitor''s demo: copies demo_seed into a new organization that expires in 30 minutes, with the league''s programs. Returns {organization_id, expires_at, existing}.';

DROP TABLE demo_seed.practice_schedule;

DELETE FROM demo_seed.practice_slots;
DELETE FROM demo_seed.field_subunits;
DELETE FROM demo_seed.fields;
DELETE FROM demo_seed.locations;

ALTER TABLE demo_seed.locations DROP COLUMN lighting_available;
ALTER TABLE demo_seed.divisions DROP COLUMN practices_per_week;
ALTER TABLE demo_seed.divisions DROP COLUMN practice_minutes;

-- The rows 20261030010000 seeded, as it generated them (a copy of its region from `INSERT INTO demo_seed.locations`).
INSERT INTO demo_seed.locations (name, latitude, longitude) VALUES
  ('Eastgate Sports Complex', 37.3000, -121.6500),
  ('Orchard Park', 37.3100, -121.6600),
  ('Riverside Fields', 37.2900, -121.6400);

INSERT INTO demo_seed.fields (location_name, name, surface_type, supports_halves) VALUES
  ('Eastgate Sports Complex', 'Field 1', 'Turf', true),
  ('Orchard Park', 'Field 1', 'Grass', true),
  ('Orchard Park', 'Field 2', 'Grass', true),
  ('Orchard Park', 'Field 3', 'Grass', true),
  ('Orchard Park', 'Tot Lot', 'Grass', false),
  ('Riverside Fields', 'Field A', 'Grass', true),
  ('Riverside Fields', 'Field B', 'Grass', true);

INSERT INTO demo_seed.field_subunits (location_name, field_name, label) VALUES
  ('Eastgate Sports Complex', 'Field 1', 'A'),
  ('Eastgate Sports Complex', 'Field 1', 'B'),
  ('Orchard Park', 'Field 1', 'A'),
  ('Orchard Park', 'Field 1', 'B'),
  ('Orchard Park', 'Field 2', 'A'),
  ('Orchard Park', 'Field 2', 'B'),
  ('Orchard Park', 'Field 3', 'A'),
  ('Orchard Park', 'Field 3', 'B'),
  ('Riverside Fields', 'Field A', 'A'),
  ('Riverside Fields', 'Field A', 'B'),
  ('Riverside Fields', 'Field B', 'A'),
  ('Riverside Fields', 'Field B', 'B');

INSERT INTO demo_seed.practice_slots (location_name, field_name, subunit_label, day_of_week, start_time, end_time, capacity, division_key) VALUES
  ('Orchard Park', 'Field 1', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Tot Lot', NULL, 'sat', '09:00', '09:30', 1, 'U4'),
  ('Orchard Park', 'Tot Lot', NULL, 'sat', '09:45', '10:15', 1, 'U4'),
  ('Orchard Park', 'Tot Lot', NULL, 'sat', '10:30', '11:00', 1, 'U4'),
  ('Orchard Park', 'Tot Lot', NULL, 'sat', '11:15', '11:45', 1, 'U4');

DO $revert$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = 'public.start_demo_session()'::regprocedure;
    IF v_md5 IS DISTINCT FROM '19ff62ceb791a167b426aadf999b7efe' THEN
        RAISE EXCEPTION 'start_demo_session was not restored to its 20261108010000 body (md5 %)', v_md5;
    END IF;
    IF to_regclass('demo_seed.practice_schedule') IS NOT NULL THEN
        RAISE EXCEPTION 'demo_seed.practice_schedule survived its own revert';
    END IF;
    IF (SELECT count(*) FROM demo_seed.practice_slots) <> 196 OR (SELECT count(*) FROM demo_seed.locations) <> 3
       OR (SELECT count(*) FROM demo_seed.fields) <> 7 OR (SELECT count(*) FROM demo_seed.field_subunits) <> 12 THEN
        RAISE EXCEPTION 'the previous facility rows were not restored (196 slots, 3 venues, 7 grounds, 12 halves)';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'demo_seed'
                  AND ((table_name = 'divisions' AND column_name IN ('practices_per_week', 'practice_minutes'))
                       OR (table_name = 'locations' AND column_name = 'lighting_available'))) THEN
        RAISE EXCEPTION 'a column this migration added survived its revert';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.start_demo_session()'::regprocedure) ~ 'practice_schedule' THEN
        RAISE EXCEPTION 'the restored demo start still names the practice schedule';
    END IF;
    RAISE NOTICE 'revert verified: the demo start is back as at 20261108010000, the previous grid is restored and the seeded practice schedule is gone';
END;
$revert$;

COMMIT;
