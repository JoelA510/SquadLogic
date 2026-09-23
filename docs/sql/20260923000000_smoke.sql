-- Smoke checks for 20260923000000_team_coach_assignments.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined.
-- `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, so the round trip below runs the REAL RPCs as a
-- real organisation admin, the route 20260920000000_smoke.sql established.
--
-- Four sections:
--   1. the store: RLS on, one org-scoped SELECT policy, no write path
--   2. the writer census, read from the CATALOGUE: set_team_coaches() is the
--      only function whose body writes either team column
--   3. the round trip: assign, swap, add an assistant, unassign, delete a
--      coach -- with the history read back and the drift check clean at
--      every step, and the two refusals (future, backdated) exercised
--   4. the drift check FALSIFIED both ways: a row written without its column,
--      then a column written without its row, each must turn it red

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The store
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_rls boolean;
    v_write text[];
    v_select int;
BEGIN
    IF to_regclass('public.team_coach_assignments') IS NULL THEN
        RAISE EXCEPTION 'public.team_coach_assignments does not exist';
    END IF;
    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'team_coach_assignments';
    IF NOT v_rls THEN
        RAISE EXCEPTION 'team_coach_assignments does not have ROW LEVEL SECURITY enabled';
    END IF;

    SELECT array_agg(polname ORDER BY polname) INTO v_write
      FROM pg_policy
     WHERE polrelid = 'public.team_coach_assignments'::regclass AND polcmd <> 'r';
    IF v_write IS NOT NULL THEN
        RAISE EXCEPTION 'team_coach_assignments carries write policies %; its only writer is set_team_coaches()', v_write;
    END IF;
    -- The positive control for the line above: a relid that resolved to the
    -- wrong table would report "no write policies" having read none at all.
    SELECT count(*) INTO v_select
      FROM pg_policy
     WHERE polrelid = 'public.team_coach_assignments'::regclass
       AND polcmd = 'r'
       AND pg_get_expr(polqual, polrelid) ILIKE '%is_org_member%'
       AND pg_get_expr(polqual, polrelid) ILIKE '%organization_id%';
    IF v_select <> 1 THEN
        RAISE EXCEPTION 'expected exactly one SELECT policy scoped by is_org_member(organization_id), found %', v_select;
    END IF;

    IF has_table_privilege('authenticated', 'public.team_coach_assignments', 'INSERT')
       OR has_table_privilege('authenticated', 'public.team_coach_assignments', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.team_coach_assignments', 'DELETE')
       OR has_table_privilege('service_role', 'public.team_coach_assignments', 'INSERT')
       OR has_table_privilege('service_role', 'public.team_coach_assignments', 'UPDATE')
       OR has_table_privilege('service_role', 'public.team_coach_assignments', 'DELETE')
       OR has_table_privilege('anon', 'public.team_coach_assignments', 'SELECT') THEN
        RAISE EXCEPTION 'a client role holds a write (or anon a read) privilege on team_coach_assignments';
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.team_coach_assignments', 'SELECT') THEN
        RAISE EXCEPTION 'authenticated cannot SELECT team_coach_assignments; the history would have no reader';
    END IF;

    -- The single writer is reachable by nobody but its owner.
    IF has_function_privilege('anon', 'public.set_team_coaches(uuid, uuid, uuid[], date, text)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.set_team_coaches(uuid, uuid, uuid[], date, text)', 'EXECUTE')
       OR has_function_privilege('service_role', 'public.set_team_coaches(uuid, uuid, uuid[], date, text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'a client role can EXECUTE set_team_coaches(); it authorises nobody and must be reached only through the definer RPCs';
    END IF;
    IF has_function_privilege('anon', 'public.team_coach_assignment_drift(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.admin_assign_team_coach(uuid, uuid, uuid, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.admin_delete_coaches(uuid[])', 'EXECUTE')
       OR has_function_privilege('anon', 'public.persist_team_schedule(jsonb, jsonb, jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anon can EXECUTE a function this migration adds or replaces (LESSONS_LEARNED #5)';
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'admin_assign_team_coach') <> 1 THEN
        RAISE EXCEPTION 'expected exactly one admin_assign_team_coach overload; two would make a named-argument call ambiguous';
    END IF;

    RAISE NOTICE 'store: RLS on, 1 org-scoped SELECT policy, 0 write policies, no client write grant; set_team_coaches executable by no client role; no anon EXECUTE on the 4 client-facing functions; 1 admin_assign_team_coach overload';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The writer census, from the catalogue
-- ---------------------------------------------------------------------------
--
-- **Read from pg_proc, not from the migration text**, so a later migration
-- that adds a direct writer turns this red whatever file it lives in. The
-- universe is every function in `public`; the pattern is an UPDATE of teams
-- that assigns either column, or an INSERT into teams that lists either.
-- **Its positive control is set_team_coaches itself**: the pattern must match
-- exactly that one function, so a pattern that has stopped matching anything
-- fails here rather than reporting "no stray writers" over nothing.
DO $$
DECLARE
    v_universe int;
    v_writers text[];
BEGIN
    SELECT count(*) INTO v_universe
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public';
    IF v_universe < 50 THEN
        RAISE EXCEPTION 'the census examined only % public function(s); the universe query is wrong', v_universe;
    END IF;

    SELECT array_agg(p.proname::text ORDER BY p.proname) INTO v_writers
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (
            p.prosrc ~* 'update\s+(only\s+)?(public\.)?teams\M[^;]*\m(coach_id|assistant_coach_ids)\s*='
         OR p.prosrc ~* 'insert\s+into\s+(public\.)?teams\s*\([^)]*\m(coach_id|assistant_coach_ids)\M'
       );
    IF v_writers IS DISTINCT FROM ARRAY['set_team_coaches'] THEN
        RAISE EXCEPTION 'expected set_team_coaches to be the only function writing teams.coach_id / assistant_coach_ids, found %', v_writers;
    END IF;

    RAISE NOTICE 'writer census: % public function(s) examined, exactly 1 writes the coach columns (set_team_coaches)', v_universe;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3 + 4. The round trip, and the drift check falsified
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_org uuid;
    v_season uuid;
    v_div uuid;
    v_a uuid;
    v_b uuid;
    v_c uuid;
    v_t1 uuid;
    v_t2 uuid;
    v_d0 date := current_date - 42;
    v_d1 date := current_date - 21;
    v_res jsonb;
    v_refused boolean;
    v_n int;
    v_ids uuid[];
    v_rogue uuid;

    -- One call, three facts: every team examined, how many in drift.
    v_examined int;
    v_drift int;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES (v_admin, 'tca-admin@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'tca-admin@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug)
      VALUES ('Smoke Org 8.8', 'smoke-org-88') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role)
      VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.season_settings (organization_id, name)
      VALUES (v_org, 'Assignment Season') RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
      VALUES (v_org, v_season, 'Assignment Division') RETURNING id INTO v_div;
    INSERT INTO public.coaches (organization_id, full_name, email, status, can_coach_multiple_teams)
      VALUES (v_org, 'Coach A', 'tca-a@example.test', 'active', true) RETURNING id INTO v_a;
    INSERT INTO public.coaches (organization_id, full_name, email, status, can_coach_multiple_teams)
      VALUES (v_org, 'Coach B', 'tca-b@example.test', 'active', true) RETURNING id INTO v_b;
    INSERT INTO public.coaches (organization_id, full_name, email, status, can_coach_multiple_teams)
      VALUES (v_org, 'Coach C', 'tca-c@example.test', 'active', true) RETURNING id INTO v_c;
    INSERT INTO public.teams (organization_id, division_id, name)
      VALUES (v_org, v_div, 'Assignment T1') RETURNING id INTO v_t1;
    INSERT INTO public.teams (organization_id, division_id, name)
      VALUES (v_org, v_div, 'Assignment T2') RETURNING id INTO v_t2;

    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

    -- A client calling the single writer directly is refused at EXECUTE.
    v_refused := false;
    BEGIN
        SET LOCAL ROLE authenticated;
        PERFORM public.set_team_coaches(v_t1, v_a, NULL, current_date, 'smoke');
    EXCEPTION WHEN insufficient_privilege THEN
        v_refused := true;
    END;
    RESET ROLE;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'an authenticated client called set_team_coaches() directly';
    END IF;

    -- ---- step 1: A leads T1 from d0, C leads T2 from d0 ---------------------
    v_res := public.admin_assign_team_coach(v_org, v_t1, v_a, v_d0);
    IF NOT (v_res->>'changed')::boolean THEN RAISE EXCEPTION 'step 1: assign reported no change: %', v_res; END IF;
    PERFORM public.admin_assign_team_coach(v_org, v_t2, v_c, v_d0);

    SELECT count(*), count(*) FILTER (WHERE NOT in_sync) INTO v_examined, v_drift
      FROM public.team_coach_assignment_drift(v_org);
    IF v_examined <> 2 OR v_drift <> 0 THEN
        RAISE EXCEPTION 'step 1: drift check examined % team(s) (expected 2), % in drift', v_examined, v_drift;
    END IF;
    IF (SELECT coach_id FROM public.teams WHERE id = v_t1) IS DISTINCT FROM v_a THEN
        RAISE EXCEPTION 'step 1: teams.coach_id was not written';
    END IF;

    -- ---- step 2: swap T1 to B from d1 --------------------------------------
    PERFORM public.admin_assign_team_coach(v_org, v_t1, v_b, v_d1);
    IF NOT EXISTS (SELECT 1 FROM public.team_coach_assignments
                    WHERE team_id = v_t1 AND coach_id = v_a AND role = 'lead'
                      AND effective_from = v_d0 AND effective_to = v_d1 - 1
                      AND ended_via = 'admin_assign_team_coach') THEN
        RAISE EXCEPTION 'step 2: A''s lead assignment was not end-dated to the day before the swap';
    END IF;
    SELECT count(*), count(*) FILTER (WHERE NOT in_sync) INTO v_examined, v_drift
      FROM public.team_coach_assignment_drift(v_org);
    IF v_examined <> 2 OR v_drift <> 0 THEN
        RAISE EXCEPTION 'step 2: % team(s) examined, % in drift', v_examined, v_drift;
    END IF;

    -- ---- history: "who coached T1 three weeks earlier?" ---------------------
    SELECT array_agg(coach_id) INTO v_ids FROM public.team_coach_assignments
     WHERE team_id = v_t1 AND role = 'lead'
       AND effective_from <= current_date - 30
       AND (effective_to IS NULL OR effective_to >= current_date - 30);
    IF v_ids IS DISTINCT FROM ARRAY[v_a] THEN
        RAISE EXCEPTION 'history: T1''s lead 30 days ago should be A alone, read %', v_ids;
    END IF;
    SELECT array_agg(coach_id) INTO v_ids FROM public.team_coach_assignments
     WHERE team_id = v_t1 AND role = 'lead'
       AND effective_from <= current_date - 10
       AND (effective_to IS NULL OR effective_to >= current_date - 10);
    IF v_ids IS DISTINCT FROM ARRAY[v_b] THEN
        RAISE EXCEPTION 'history: T1''s lead 10 days ago should be B alone, read %', v_ids;
    END IF;

    -- ---- the two refusals ---------------------------------------------------
    v_refused := false;
    BEGIN
        PERFORM public.admin_assign_team_coach(v_org, v_t1, v_a, v_d0);
    EXCEPTION WHEN invalid_parameter_value THEN
        v_refused := SQLERRM LIKE '%would rewrite it%';
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a change dated before T1''s latest recorded change was accepted'; END IF;
    v_refused := false;
    BEGIN
        PERFORM public.admin_assign_team_coach(v_org, v_t1, v_a, current_date + 1);
    EXCEPTION WHEN invalid_parameter_value THEN
        v_refused := SQLERRM LIKE '%cannot take effect in the future%';
    END;
    IF NOT v_refused THEN RAISE EXCEPTION 'a future-dated change was accepted'; END IF;

    -- ---- step 3: the bulk writer adds C as T1's assistant (today) -----------
    PERFORM public.persist_team_schedule(
        jsonb_build_object('organization_id', v_org, 'run_type', 'team'),
        jsonb_build_array(jsonb_build_object(
            'id', v_t1, 'division_id', v_div, 'name', 'Assignment T1',
            'coach_id', v_b, 'assistant_coach_ids', jsonb_build_array(v_c))),
        '[]'::jsonb);
    IF (SELECT assistant_coach_ids FROM public.teams WHERE id = v_t1) IS DISTINCT FROM ARRAY[v_c] THEN
        RAISE EXCEPTION 'step 3: persist_team_schedule did not write the assistant column';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.team_coach_assignments
                    WHERE team_id = v_t1 AND coach_id = v_c AND role = 'assistant'
                      AND effective_to IS NULL AND started_via = 'persist_team_schedule') THEN
        RAISE EXCEPTION 'step 3: persist_team_schedule did not start C''s assistant assignment';
    END IF;
    -- B was re-sent unchanged: still one open lead row, not a second one.
    IF (SELECT count(*) FROM public.team_coach_assignments
         WHERE team_id = v_t1 AND role = 'lead' AND effective_to IS NULL) <> 1 THEN
        RAISE EXCEPTION 'step 3: re-sending the same lead opened a second lead row';
    END IF;
    SELECT count(*), count(*) FILTER (WHERE NOT in_sync) INTO v_examined, v_drift
      FROM public.team_coach_assignment_drift(v_org);
    IF v_examined <> 2 OR v_drift <> 0 THEN
        RAISE EXCEPTION 'step 3: % team(s) examined, % in drift', v_examined, v_drift;
    END IF;

    -- ---- step 4: unassign T1's lead (today) ---------------------------------
    PERFORM public.admin_assign_team_coach(v_org, v_t1, NULL);
    IF (SELECT coach_id FROM public.teams WHERE id = v_t1) IS NOT NULL THEN
        RAISE EXCEPTION 'step 4: unassignment left teams.coach_id set';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.team_coach_assignments
                    WHERE team_id = v_t1 AND coach_id = v_b AND role = 'lead'
                      AND effective_from = v_d1 AND effective_to = current_date - 1) THEN
        RAISE EXCEPTION 'step 4: B''s lead assignment was not end-dated';
    END IF;

    -- ---- step 5: delete coach C -- lead of T2, assistant of T1 --------------
    PERFORM public.admin_delete_coaches(ARRAY[v_c]);
    IF EXISTS (SELECT 1 FROM public.coaches WHERE id = v_c) THEN
        RAISE EXCEPTION 'step 5: the coach was not deleted';
    END IF;
    IF (SELECT coach_id FROM public.teams WHERE id = v_t2) IS NOT NULL
       OR (SELECT assistant_coach_ids FROM public.teams WHERE id = v_t1) <> '{}'::uuid[] THEN
        RAISE EXCEPTION 'step 5: the deleted coach is still in a team column';
    END IF;
    -- The history outlives the coach: T2's lead row is END-DATED, not gone.
    IF NOT EXISTS (SELECT 1 FROM public.team_coach_assignments
                    WHERE team_id = v_t2 AND coach_id = v_c AND role = 'lead'
                      AND effective_from = v_d0 AND effective_to = current_date - 1
                      AND ended_via = 'admin_delete_coaches') THEN
        RAISE EXCEPTION 'step 5: deleting the coach erased or failed to end T2''s history';
    END IF;
    -- C's assistant row began today and ended today: kept, never in effect.
    IF NOT EXISTS (SELECT 1 FROM public.team_coach_assignments
                    WHERE team_id = v_t1 AND coach_id = v_c AND role = 'assistant'
                      AND effective_to = effective_from - 1) THEN
        RAISE EXCEPTION 'step 5: the same-day assistant row was not kept as never-in-effect';
    END IF;
    SELECT count(*), count(*) FILTER (WHERE NOT in_sync) INTO v_examined, v_drift
      FROM public.team_coach_assignment_drift(v_org);
    IF v_examined <> 2 OR v_drift <> 0 THEN
        RAISE EXCEPTION 'step 5: % team(s) examined, % in drift', v_examined, v_drift;
    END IF;

    SELECT count(*) INTO v_n FROM public.team_coach_assignments WHERE organization_id = v_org;
    IF v_n <> 4 OR EXISTS (SELECT 1 FROM public.team_coach_assignments
                            WHERE organization_id = v_org AND effective_to IS NULL) THEN
        RAISE EXCEPTION 'expected 4 assignment rows, all ended, after the round trip; found % row(s)', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_log
     WHERE organization_id = v_org AND action = 'team.coach_assignments_changed';
    IF v_n <> 7 THEN
        RAISE EXCEPTION 'expected 7 team.coach_assignments_changed audit rows (one per team per changing call), found %', v_n;
    END IF;

    RAISE NOTICE 'round trip: assign x2, swap, persist-assistant, unassign, delete-coach; drift 0 of 2 teams at each of 4 checkpoints; T1''s lead read back as A at -30d and B at -10d; backdated and future changes refused; 4 rows, 0 open, 0 deleted; 7 audit rows';

    -- ---- 4a. FALSIFY: a row written without its column ----------------------
    INSERT INTO public.team_coach_assignments
        (organization_id, team_id, coach_id, role, effective_from, started_via)
    VALUES (v_org, v_t2, v_a, 'lead', current_date, 'smoke-bypass')
    RETURNING id INTO v_rogue;
    SELECT count(*) FILTER (WHERE NOT in_sync) INTO v_drift
      FROM public.team_coach_assignment_drift(v_org) WHERE team_id = v_t2;
    IF v_drift <> 1 THEN
        RAISE EXCEPTION 'falsification 4a: an assignment row with no column update did not register as drift';
    END IF;
    DELETE FROM public.team_coach_assignments WHERE id = v_rogue;
    SELECT count(*) FILTER (WHERE NOT in_sync) INTO v_drift FROM public.team_coach_assignment_drift(v_org);
    IF v_drift <> 0 THEN RAISE EXCEPTION 'falsification 4a: drift did not clear after restoring'; END IF;

    -- ---- 4b. FALSIFY: a column written without its row ----------------------
    UPDATE public.teams SET coach_id = v_a WHERE id = v_t2;
    SELECT count(*) FILTER (WHERE NOT in_sync) INTO v_drift
      FROM public.team_coach_assignment_drift(v_org) WHERE team_id = v_t2;
    IF v_drift <> 1 THEN
        RAISE EXCEPTION 'falsification 4b: a column update with no assignment row did not register as drift';
    END IF;
    UPDATE public.teams SET coach_id = NULL WHERE id = v_t2;
    UPDATE public.teams SET assistant_coach_ids = ARRAY[v_b] WHERE id = v_t2;
    SELECT count(*) FILTER (WHERE NOT in_sync) INTO v_drift
      FROM public.team_coach_assignment_drift(v_org) WHERE team_id = v_t2;
    IF v_drift <> 1 THEN
        RAISE EXCEPTION 'falsification 4b: an assistant column update with no assignment row did not register as drift';
    END IF;
    UPDATE public.teams SET assistant_coach_ids = '{}'::uuid[] WHERE id = v_t2;
    SELECT count(*) FILTER (WHERE NOT in_sync) INTO v_drift FROM public.team_coach_assignment_drift(v_org);
    IF v_drift <> 0 THEN RAISE EXCEPTION 'falsification 4b: drift did not clear after restoring'; END IF;

    RAISE NOTICE 'drift check falsified: a bypassing row (lead) and a bypassing column (lead, then assistants) each turned it red; each restore turned it clean';

    DELETE FROM public.organizations WHERE id = v_org;
    DELETE FROM public.profiles WHERE id = v_admin;
    DELETE FROM auth.users WHERE id = v_admin;
END;
$$;
