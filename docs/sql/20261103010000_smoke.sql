-- Smoke checks for 20261103010000_demo_practice_schedule.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   1. A started demo has an applied weekly practice schedule for U4 and U5 to U8: those 68 teams
--      have exactly one `practice_assignments` row each, and the 60 teams of U9 and older have none
--      (the auto-scheduler's to place), under a completed `practice` run whose readiness snapshot is
--      counted from those rows.
--   2. U4's four cohorts meet in the sessions reserved to U4, 30 minutes each, one at a time, at
--      least 15 minutes apart; no other team is in a reserved slot.
--   3. The schedule is a legal one: every row is a real slot of the demo's own grid, no slot holds
--      more teams than its capacity, no coach is in two
--      overlapping practices, the weekdays are Monday to Thursday (U4: Saturday) and the times fall
--      in the 16:00 to 19:00 evening window.
--   4. Every row is live from its weekday's first date in the season to the season's last day.
--   5. A seeded row that finds no slot refuses the start (`demo_seed_practice_mismatch`) rather
--      than leave a team without its practice, and the refusal leaves no demo behind.
--
-- Every id is generated and every name is the fixture's placeholder; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_visitor uuid := gen_random_uuid();
    v_other uuid := gen_random_uuid();
    v_demo uuid;
    v_run uuid;
    v_n bigint;
    v_season_start date;
    v_season_end date;
    v_state text;
    v_detail text;
    v_before bigint;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data, is_anonymous)
    VALUES (v_visitor, NULL, '{"password_length": 12}', true),
           (v_other, NULL, '{"password_length": 12}', true);
    PERFORM set_config('request.jwt.claim.sub', v_visitor::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_visitor, 'is_anonymous', true)::text, true);
    v_demo := (public.start_demo_session() ->> 'organization_id')::uuid;
    SELECT season_start, season_end INTO v_season_start, v_season_end
      FROM public.season_settings WHERE organization_id = v_demo;

    -- ---- 1. U4 and U5 to U8 practise, once; U9 and older have no practice -----------
    SELECT count(*) INTO v_n FROM public.teams WHERE organization_id = v_demo;
    IF v_n <> 128 THEN RAISE EXCEPTION 'the demo has % teams, not 128', v_n; END IF;
    SELECT count(*) INTO v_n FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
     WHERE t.organization_id = v_demo
       AND (SELECT count(*) FROM public.practice_assignments pa WHERE pa.team_id = t.id)
           <> CASE WHEN regexp_replace(d.name, '[^0-9]', '', 'g')::int <= 8 THEN 1 ELSE 0 END;
    IF v_n <> 0 THEN RAISE EXCEPTION '% team(s) have the wrong number of practices (U4 to U8 once, U9 and older none)', v_n; END IF;
    SELECT count(DISTINCT team_id) INTO v_n FROM public.practice_assignments WHERE organization_id = v_demo AND slot_id = practice_slot_id;
    IF v_n <> 68 THEN RAISE EXCEPTION 'only % of 68 teams have a slot', v_n; END IF;
    SELECT count(*) INTO v_n FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
     WHERE t.organization_id = v_demo AND d.name = 'U4';
    IF v_n <> 4 THEN RAISE EXCEPTION 'the demo has % U4 cohorts, not 4', v_n; END IF;

    SELECT id INTO v_run FROM public.scheduler_runs
     WHERE organization_id = v_demo AND run_type = 'practice' AND status = 'completed';
    IF v_run IS NULL THEN RAISE EXCEPTION 'the demo has no completed practice run'; END IF;
    SELECT count(*) INTO v_n FROM public.practice_assignments
     WHERE organization_id = v_demo AND run_id IS DISTINCT FROM v_run;
    IF v_n <> 0 THEN RAISE EXCEPTION '% assignment(s) are not under the practice run', v_n; END IF;
    -- The snapshot is counted from the rows: read each figure from the run, compare with the rows.
    IF (SELECT (results -> 'summary' ->> 'assignmentsRead')::bigint FROM public.scheduler_runs WHERE id = v_run)
           IS DISTINCT FROM (SELECT count(*) FROM public.practice_assignments WHERE organization_id = v_demo)
       OR (SELECT (results -> 'summary' ->> 'assignedTeams')::bigint FROM public.scheduler_runs WHERE id = v_run)
           IS DISTINCT FROM (SELECT count(DISTINCT team_id) FROM public.practice_assignments WHERE organization_id = v_demo)
       OR (SELECT (results -> 'summary' ->> 'totalTeams')::bigint FROM public.scheduler_runs WHERE id = v_run) <> 128
       OR (SELECT (results -> 'summary' ->> 'unassignedTeams')::bigint FROM public.scheduler_runs WHERE id = v_run) <> 60
       OR (SELECT (results -> 'unassignedByReason' -> 0 ->> 'count')::bigint FROM public.scheduler_runs WHERE id = v_run) <> 60 THEN
        RAISE EXCEPTION 'the practice run''s snapshot does not match the rows';
    END IF;
    RAISE NOTICE 'the demo has an applied practice schedule: 68 of 128 teams, % rows, one completed practice run',
        (SELECT count(*) FROM public.practice_assignments WHERE organization_id = v_demo);

    -- ---- 2. U4: reserved sessions, 30 minutes, 15 apart -------------------------------
    CREATE TEMP TABLE smoke_u4 ON COMMIT DROP AS
    SELECT ps.start_time, ps.end_time, ps.day_of_week::text AS day, ps.division_id, d.name AS division
      FROM public.practice_assignments pa
      JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.organization_id = v_demo AND d.name = 'U4';
    SELECT count(*) INTO v_n FROM smoke_u4;
    IF v_n <> 4 THEN RAISE EXCEPTION 'U4 has % sessions, not 4', v_n; END IF;
    SELECT count(DISTINCT start_time) INTO v_n FROM smoke_u4;
    IF v_n <> 4 THEN RAISE EXCEPTION 'two U4 cohorts share a session'; END IF;
    SELECT count(*) INTO v_n FROM smoke_u4 WHERE end_time - start_time <> interval '30 minutes' OR day <> 'sat';
    IF v_n <> 0 THEN RAISE EXCEPTION '% U4 session(s) are not 30 minutes on a Saturday', v_n; END IF;
    SELECT count(*) INTO v_n FROM smoke_u4 a JOIN smoke_u4 b ON a.start_time < b.start_time
     WHERE b.start_time < a.end_time + interval '15 minutes';
    IF v_n <> 0 THEN RAISE EXCEPTION '% pair(s) of U4 sessions are less than 15 minutes apart or overlap', v_n; END IF;
    SELECT count(*) INTO v_n FROM public.practice_assignments pa
      JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
      JOIN public.teams t ON t.id = pa.team_id JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.organization_id = v_demo AND ((d.name = 'U4') <> (ps.division_id IS NOT NULL));
    IF v_n <> 0 THEN RAISE EXCEPTION '% row(s) put U4 in an open slot or another division in a reserved one', v_n; END IF;
    RAISE NOTICE 'U4: 4 cohorts, one 30-minute Saturday session each, one at a time, at least 15 minutes apart, all in the sessions reserved to U4';

    -- ---- 3. a legal schedule --------------------------------------------------------
    SELECT count(*) INTO v_n FROM (
        SELECT 1 FROM public.practice_assignments pa JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
         WHERE pa.organization_id = v_demo GROUP BY ps.id, ps.capacity HAVING count(*) > ps.capacity) over_full;
    IF v_n <> 0 THEN RAISE EXCEPTION '% slot(s) hold more teams than their capacity', v_n; END IF;
    -- Every pair of practices one coach has (across every team they coach), and which overlap. In this
    -- league a coach has one team with one practice, so no pair exists; the meta-assertion is that the
    -- coaches' practices ARE examined (each coach of a scheduled team is joined to it), and the pair
    -- check below is the guard for a fixture that gives a coach two.
    SELECT count(*) INTO v_n FROM public.team_coach_assignments ca
      JOIN public.practice_assignments a ON a.team_id = ca.team_id WHERE ca.organization_id = v_demo;
    IF v_n = 0 THEN RAISE EXCEPTION 'no coach is joined to a practice, so the coach check examined nothing'; END IF;
    SELECT count(*) INTO v_n FROM public.team_coach_assignments ca
      JOIN public.practice_assignments a ON a.team_id = ca.team_id
      JOIN public.practice_slots sa ON sa.id = a.practice_slot_id
      JOIN public.team_coach_assignments cb ON cb.coach_id = ca.coach_id
      JOIN public.practice_assignments b ON b.team_id = cb.team_id AND b.id > a.id
      JOIN public.practice_slots sb ON sb.id = b.practice_slot_id
     WHERE ca.organization_id = v_demo
       AND sa.day_of_week = sb.day_of_week AND sa.start_time < sb.end_time AND sb.start_time < sa.end_time;
    IF v_n <> 0 THEN RAISE EXCEPTION '% overlapping practice(s) put a coach in two places', v_n; END IF;
    SELECT count(*) INTO v_n FROM public.practice_assignments a JOIN public.practice_slots ps ON ps.id = a.practice_slot_id
     WHERE a.organization_id = v_demo AND ps.division_id IS NULL
       AND (ps.day_of_week NOT IN ('mon', 'tue', 'wed', 'thu') OR ps.start_time < time '16:00' OR ps.end_time > time '19:00');
    IF v_n <> 0 THEN RAISE EXCEPTION '% open-slot practice(s) fall outside Monday to Thursday, 16:00 to 19:00', v_n; END IF;
    SELECT count(*) INTO v_n FROM public.practice_assignments a
      JOIN public.practice_slots ps ON ps.id = a.practice_slot_id
     WHERE a.organization_id = v_demo
       AND (a.day_of_week <> ps.day_of_week::text OR a.start_time <> ps.start_time::text
            OR a.end_time <> ps.end_time::text OR a.field_id <> ps.field_id OR a.slot_id <> ps.id
            OR a.source <> 'auto' OR a.assigned_via <> 'auto');
    IF v_n <> 0 THEN RAISE EXCEPTION '% row(s) do not carry their slot''s weekday, times and field', v_n; END IF;
    RAISE NOTICE 'the schedule is legal: capacity held, no coach double-booked, Monday to Thursday 16:00 to 19:00 outside U4';

    -- ---- 4. live from the weekday's first date to the season's end ------------------
    SELECT count(*) INTO v_n FROM public.practice_assignments a
      JOIN public.practice_slots ps ON ps.id = a.practice_slot_id
     WHERE a.organization_id = v_demo
       AND (a.effective_date_range IS NULL
            OR lower(a.effective_date_range) <> v_season_start + (array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun'], ps.day_of_week::text) - 1)
            OR upper(a.effective_date_range) <> v_season_end + 1
            OR extract(isodow FROM lower(a.effective_date_range)) <> array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun'], ps.day_of_week::text));
    IF v_n <> 0 THEN RAISE EXCEPTION '% row(s) are not live from their weekday''s first date to the season''s end', v_n; END IF;
    RAISE NOTICE 'every row runs from its weekday''s first date in the season (% to %) to the last day', v_season_start, v_season_end;

    -- ---- 5. a seeded row with no slot refuses the start -----------------------------
    SELECT count(*) INTO v_before FROM public.organizations WHERE demo_owner IS NOT NULL;
    UPDATE demo_seed.practice_schedule SET start_time = time '03:00'
     WHERE id = (SELECT min(id) FROM demo_seed.practice_schedule);
    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_other, 'is_anonymous', true)::text, true);
    BEGIN
        PERFORM public.start_demo_session();
        -- Not P0001, which the handler below would swallow as the refusal it is looking for.
        RAISE EXCEPTION 'a demo started with a practice row that finds no slot' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
        IF v_detail IS DISTINCT FROM 'demo_seed_practice_mismatch' THEN
            RAISE EXCEPTION 'the start was refused for the wrong reason: %', v_detail;
        END IF;
    END;
    SELECT count(*) INTO v_n FROM public.organizations WHERE demo_owner = v_other;
    IF v_n <> 0 OR (SELECT count(*) FROM public.organizations WHERE demo_owner IS NOT NULL) <> v_before THEN
        RAISE EXCEPTION 'the refused start left a demo organization behind';
    END IF;
    RAISE NOTICE 'a seeded practice row that finds no slot refuses the start (demo_seed_practice_mismatch) and leaves no demo behind';
END;
$$;

ROLLBACK;
