-- The demo's season, chosen at entry: a fall or a spring league (owner direction 2026-11-01; plan
-- docs/changes/2026-11-01-demo-season-selection.md).
--
-- **Why.** A demo's season was "the coming twelve weeks" from whenever the visitor arrived. The practice
-- grid is static clock times and sunset is not, so for much of the year a demo opened full of sunset
-- flags that said nothing about the product (opened in November, every 18:00 and 19:00 unlit slot of the
-- season is past sunset). The visitor now chooses, at entry, a fall or a spring league: the same league,
-- the same people and the same seeded practices, dated in a window in which no unlit slot of the grid is
-- near sunset (tests/demoSeasons.test.js proves it with the repository's sunset helper).
--
-- **The change.**
--   1. `demo_seed.season_window(p_choice, p_today)`, the rule, in the unexposed `demo_seed` schema. A
--      window is a Monday anchor and a length: spring starts on the Monday on or after 22 March and runs
--      `demo_seed.league.season_weeks` (12) weeks; fall starts on the Monday on or after 2 August and runs
--      6 weeks (an early fall: a 12-week one cannot be free of sunset flags at the grid's 19:00 end). The
--      instance chosen is the earliest whose last day is on or after `p_today`; no choice is the one that
--      ends first (the window the date falls in, or else the next to begin). A choice but 'fall' or
--      'spring' is refused (22023, detail `demo_season_unknown`). `STABLE`: it reads the league row.
--   2. `start_demo_session(p_season text)` is the body of the zero-argument function with the season
--      dated by (1), named `Fall 2027` / `Spring 2027` with the label `Fall` / `Spring`, the season in
--      the `demo.started` audit row, and `season`, `season_start`, `season_end` in what it returns
--      beside the three keys it always returned. A visitor's own live demo is returned as it was started
--      (its own season), whatever they ask for now. Granted as the zero-argument one is.
--   3. `start_demo_session()` stays, as the one-line `start_demo_session(NULL)`: the public shape, the
--      existing smokes and pgTAP, and a browser tab that has not reloaded keep working. The overload has
--      no default, so PostgREST never sees an ambiguous call.
--   4. An end-state check, with the rule's vectors.
--
-- No table, column, policy, expiry or purge is touched. An existing demo is untouched (the function only
-- runs when a visitor starts a new one).
--
-- Reversible: docs/sql/20261114010000_revert.sql restores the zero-argument body (md5 checked) and drops
-- the overload and the helper. Smoke: docs/sql/20261114010000_smoke.sql. pgTAP: supabase/tests/demo_sessions.sql
-- and demo_practice_schedule.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting body is checked.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_md5 text;
BEGIN
    -- Carriage returns stripped, as 20261101010000 and 20261110010000 do: a body stored with CRLF line ends
    -- is the same text.
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_demo_session()');
    IF v_md5 IS DISTINCT FROM 'b0d65c16975551bcc8e839ea2371b0fc' THEN
        RAISE EXCEPTION 'start_demo_session() is not the body this migration replaces (md5 %, expected b0d65c16975551bcc8e839ea2371b0fc)', v_md5;
    END IF;
    IF to_regprocedure('public.start_demo_session(text)') IS NOT NULL
       OR to_regprocedure('demo_seed.season_window(text, date)') IS NOT NULL THEN
        RAISE EXCEPTION 'the demo season functions already exist';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The rule.
-- ---------------------------------------------------------------------------

CREATE FUNCTION demo_seed.season_window(p_choice text, p_today date,
                                        OUT season text, OUT season_start date, OUT season_end date)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
    v_candidates text[];
    v_c      text;
    v_month  integer;
    v_day    integer;
    v_weeks  integer;
    v_year   integer;
    v_first  date;
    v_start  date;
    v_end    date;
BEGIN
    IF p_today IS NULL THEN
        RAISE EXCEPTION 'A demo season is dated from a day' USING ERRCODE = '22004';
    END IF;
    IF p_choice IS NOT NULL AND p_choice NOT IN ('fall', 'spring') THEN
        RAISE EXCEPTION 'Unknown demo season: choose fall or spring'
            USING ERRCODE = '22023', DETAIL = 'demo_season_unknown';
    END IF;

    v_candidates := CASE WHEN p_choice IS NULL THEN ARRAY['fall', 'spring'] ELSE ARRAY[p_choice] END;
    FOREACH v_c IN ARRAY v_candidates LOOP
        IF v_c = 'fall' THEN
            v_month := 8; v_day := 2; v_weeks := 6;
        ELSE
            v_month := 3; v_day := 22;
            SELECT l.season_weeks INTO v_weeks FROM demo_seed.league l;
            IF v_weeks IS NULL THEN
                RAISE EXCEPTION 'The demo league is not available' USING ERRCODE = 'P0001', DETAIL = 'demo_seed_empty';
            END IF;
        END IF;
        -- A window ends in the year it starts: this year's instance, else next year's.
        v_year := extract(year FROM p_today)::integer;
        LOOP
            v_first := make_date(v_year, v_month, v_day);
            v_start := v_first + ((8 - extract(isodow FROM v_first)::integer) % 7);   -- the Monday on or after
            v_end := v_start + v_weeks * 7 - 1;
            EXIT WHEN v_end >= p_today;
            v_year := v_year + 1;
        END LOOP;
        -- No choice: the instance that ends first (fall wins a tie, which two windows cannot make).
        IF season IS NULL OR v_end < season_end THEN
            season := v_c; season_start := v_start; season_end := v_end;
        END IF;
    END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION demo_seed.season_window(text, date) FROM PUBLIC;

COMMENT ON FUNCTION demo_seed.season_window(text, date) IS
    'The demo''s season window: fall (the Monday on or after 2 August, 6 weeks) or spring (the Monday on or after 22 March, season_weeks weeks), the earliest instance not ended on p_today; no choice is the one that ends first. Refuses any other choice (22023, demo_season_unknown).';

-- ---------------------------------------------------------------------------
-- 3. The zero-argument function, kept as the default season. PL/pgSQL, so that it can be defined
--    before the function it calls (a SQL-language body is checked against the catalogue as it is
--    created), which leaves the real body, the choosing function, as this file's last definition of
--    the name (tests/practiceReaderCensus.test.js reads the latest definition of a name).
-- ---------------------------------------------------------------------------

-- It sets no TimeZone (the body it replaces pinned UTC for the dates it computed): it computes nothing,
-- and the function it calls pins its own.
CREATE OR REPLACE FUNCTION public.start_demo_session()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN public.start_demo_session(NULL::text);
END;
$function$;

COMMENT ON FUNCTION public.start_demo_session() IS
    'start_demo_session(NULL): a demo in the window the date falls in, or the next to begin. Kept for callers that do not choose.';

-- ---------------------------------------------------------------------------
-- 4. start_demo_session(p_season), from the zero-argument body (20261110010000).
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.start_demo_session(p_season text)
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
    v_season  uuid;
    v_choice  text;
    v_label   text;
    v_start   date;
    v_end     date;
    v_year    integer;
    v_chosen  jsonb;
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

    -- The choice is a trust boundary: exactly 'fall' or 'spring', or nothing (the default for the date).
    -- Refused before the lock, whatever else is true of the caller.
    IF p_season IS NOT NULL AND p_season NOT IN ('fall', 'spring') THEN
        RAISE EXCEPTION 'Unknown demo season: choose fall or spring'
            USING ERRCODE = '22023', DETAIL = 'demo_season_unknown';
    END IF;

    -- One caller at a time past this point, so the cap and the one-per-visitor rule are judged
    -- against what the callers before this one committed.
    PERFORM pg_advisory_xact_lock(hashtextextended('squadlogic.start_demo_session', 0));

    SELECT o.id, o.demo_expires_at INTO v_org, v_expires
      FROM public.organizations o WHERE o.demo_owner = v_uid;
    IF FOUND THEN
        IF v_expires > now() THEN
            -- Their own live demo, in the season it was started in, whatever was asked for now. That is the
            -- demo's FIRST season by creation: an admin may start a next season in a demo (admin_create_season_from),
            -- and without an order this read returns whichever row the plan reaches first.
            SELECT jsonb_build_object(
                       'season', CASE WHEN s.season_label IN ('Fall', 'Spring') THEN lower(s.season_label) END,
                       'season_start', s.season_start, 'season_end', s.season_end)
              INTO v_chosen
              FROM public.season_settings s WHERE s.organization_id = v_org
             ORDER BY s.created_at, s.id LIMIT 1;
            RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', true)
                   || COALESCE(v_chosen, '{}'::jsonb);
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

    SELECT l.organization_name, l.timezone INTO v_name, v_tz FROM demo_seed.league l;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The demo league is not available' USING ERRCODE = 'P0001', DETAIL = 'demo_seed_empty';
    END IF;

    -- The season is the visitor's choice, dated by demo_seed.season_window(): the instance of the fall or
    -- the spring window that has not ended on the league's date today, or the one that ends first if they
    -- chose nothing. This is the only place a demo's dates are decided (20261114010000).
    SELECT w.season, w.season_start, w.season_end INTO v_choice, v_start, v_end
      FROM demo_seed.season_window(p_season, (now() AT TIME ZONE v_tz)::date) w;
    v_label := initcap(v_choice);
    v_year := extract(year FROM v_start)::integer;

    -- Not yet marked a demo: the fences would refuse the seed. It is marked below, last.
    INSERT INTO public.organizations (name, slug, contact_info, is_onboarded)
    VALUES (v_name, 'demo-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
            jsonb_build_object('timezone', v_tz), true)
    RETURNING id INTO v_org;

    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_label, timezone,
                                        season_start, season_end)
    VALUES (v_org, v_label || ' ' || v_year, 'active', v_year, v_label, v_tz, v_start, v_end)
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
        jsonb_build_object('expires_at', v_expires, 'minutes', c_minutes, 'season', v_choice)
    );

    RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', false,
                              'season', v_choice, 'season_start', v_start, 'season_end', v_end);
END;
$function$;

REVOKE ALL ON FUNCTION public.start_demo_session(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_demo_session(text) TO authenticated;

COMMENT ON FUNCTION public.start_demo_session(text) IS
    'An anonymous visitor''s demo in the season they chose (fall or spring; none is the window the date falls in or the next to begin): copies demo_seed into a new organization that expires in 30 minutes, with the league''s programs, its divisions'' practices, one lit ground and its applied weekly practice schedule for U4 and U5 to U8. Returns {organization_id, expires_at, existing, season, season_start, season_end}.';

-- ---------------------------------------------------------------------------
-- 5. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_def text;
    v_n integer;
BEGIN
    -- The rule, on dates of its own: a date in each window, between them, the day after a window, an anchor
    -- that falls on a Sunday, and a choice made in the autumn. (tests/demoSeasons.test.js holds the full
    -- table, in JavaScript and in pgTAP, against this function.)
    SELECT count(*) INTO v_n FROM (VALUES
        ('spring', DATE '2026-11-01', 'spring', DATE '2027-03-22', DATE '2027-06-13'),
        ('fall',   DATE '2026-11-01', 'fall',   DATE '2027-08-02', DATE '2027-09-12'),
        (NULL,     DATE '2026-11-01', 'spring', DATE '2027-03-22', DATE '2027-06-13'),
        (NULL,     DATE '2027-06-14', 'fall',   DATE '2027-08-02', DATE '2027-09-12'),
        (NULL,     DATE '2027-09-12', 'fall',   DATE '2027-08-02', DATE '2027-09-12'),
        (NULL,     DATE '2027-09-13', 'spring', DATE '2028-03-27', DATE '2028-06-18'),
        ('fall',   DATE '2026-08-02', 'fall',   DATE '2026-08-03', DATE '2026-09-13'),
        ('spring', DATE '2026-03-22', 'spring', DATE '2026-03-23', DATE '2026-06-14')
    ) v(choice, today, season, season_start, season_end)
    CROSS JOIN LATERAL demo_seed.season_window(v.choice, v.today) w
    WHERE (w.season, w.season_start, w.season_end) IS NOT DISTINCT FROM (v.season, v.season_start, v.season_end);
    IF v_n <> 8 THEN
        RAISE EXCEPTION 'demo_seed.season_window gives the wrong window for % of 8 checked dates', 8 - v_n;
    END IF;

    SELECT prosrc INTO v_def FROM pg_proc WHERE oid = to_regprocedure('public.start_demo_session(text)');
    IF v_def !~ 'demo_seed\.season_window' OR v_def !~ 'demo_season_unknown'
       OR v_def !~ 'demo_seed\.practice_schedule' OR v_def !~ 'demo_seed_practice_mismatch'
       OR v_def !~ 'd\.practices_per_week' OR v_def !~ 'l\.lighting_available'
       OR v_def !~ 'demo_seed\.division_programs' OR v_def !~ 'demo_seed_empty' OR v_def !~ 'demo_capacity'
       OR v_def !~ 'season_settings_id' THEN
        RAISE EXCEPTION 'start_demo_session(text) is not the demo start with its season choice';
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_demo_session(text)')) THEN
        RAISE EXCEPTION 'start_demo_session(text) is not a definer';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.start_demo_session()')) !~ 'start_demo_session\(NULL' THEN
        RAISE EXCEPTION 'start_demo_session() does not delegate to the season choice';
    END IF;
    IF has_function_privilege('anon', 'public.start_demo_session(text)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.start_demo_session(text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.start_demo_session()', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.start_demo_session()', 'EXECUTE') THEN
        RAISE EXCEPTION 'the demo start is not granted to signed-in callers only';
    END IF;
    IF has_function_privilege('authenticated', 'demo_seed.season_window(text, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'demo_seed.season_window(text, date)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the season rule is executable by a client role';
    END IF;
END;
$check$;

COMMIT;
