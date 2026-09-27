-- Smoke for 20260928000000_reconcile_prod_rls_drift.sql
--
-- Runs on the harness's head build, where the migration has already applied.
-- Everything happens inside one transaction that is ROLLED BACK, so the
-- production drift it recreates never reaches a later smoke or stage.
--
-- 1. On the repo chain the reconcile is idempotent: re-running it creates
--    nothing, drops nothing, and finds every one of its 19 policies already
--    present AND identical (deparsed clause by clause against a probe built
--    from the spec). The migration's own apply already removed
--    "org_member_access" from practice_slots, field_subunits and
--    scheduler_runs, and gave scheduler_runs its member-read/admin-write
--    split.
-- 2. Production's drift is recreated: "Enforce Org Membership: ALL" on the
--    eleven tables, and the repo read policies production lacks removed --
--    the six tables' member SELECT, the legacy import_jobs SELECT, and (the
--    worst case the drift report allows) both facility member SELECTs.
-- 3. Positive control: under that drift a non-admin member CAN insert into
--    teams and fields. Without this, the refusals below could come from a
--    missing grant rather than from RLS, and prove nothing.
-- 4. The reconcile runs -- the function the migration ran, not a copy -- and
--    the catalogue and a non-admin member's session are checked: the broad
--    policy gone everywhere, every dropped read policy back, no member-gated
--    write policy on any of the 13 tables, member inserts into teams, fields
--    and practice_slots refused by RLS, updates and deletes reaching no row,
--    and reads of teams and practice_slots limited to the member's own org.
-- 5. Catalogue-wide, SEMANTICALLY: every non-SELECT policy in `public` is
--    evaluated as that plain member against a row of their own org that is
--    not their own; only allowlisted policies may come out true. A fresh
--    table with a member-gated ALL policy must be caught by this AND by the
--    reconcile's own (text-level) end-state check.
-- 6. scheduler_runs: a member reads their own org's runs only and cannot
--    write; an admin session can still INSERT and UPDATE (the path the
--    SECURITY INVOKER persist_practice_schedule takes -- 20260924000000's
--    smoke runs that writer itself as an admin on this same build).

BEGIN;

DO $smoke$
DECLARE
    -- The subject sets are STATED here, not read back from the function or
    -- the catalogue a broken reconcile would leave behind.
    c_tables text[] := ARRAY['coaches','teams','locations','fields','divisions','game_assignments',
                             'import_jobs','imports','team_messages','organization_schemas',
                             'schedule_evaluations','practice_slots','field_subunits'];
    c_broad_tables text[] := ARRAY['coaches','teams','locations','fields','divisions','game_assignments',
                                   'import_jobs','imports','team_messages','organization_schemas',
                                   'schedule_evaluations'];
    c_prod_missing text[][] := ARRAY[
        ['coaches', 'Coaches: members access'],
        ['teams', 'Teams: members access'],
        ['game_assignments', 'Game Assignments: members access'],
        ['imports', 'Imports: members access'],
        ['import_jobs', 'Import Jobs: members access'],
        ['schedule_evaluations', 'Schedule Evaluations: members access'],
        ['import_jobs', 'Users can view their organization''s import jobs'],
        ['practice_slots', 'Practice Slots: members select'],
        ['field_subunits', 'Field Subunits: members select']
    ];
    v_member uuid := 'a0a0a0a0-0000-4000-8000-000000000927';
    v_admin uuid := 'a0a0a0a0-0000-4000-8000-000000000928';
    v_run_a uuid;
    v_pol record;
    v_uuid_cols jsonb;
    v_q text; v_c text;
    v_sat boolean;
    v_examined int := 0;
    v_hits text[] := ARRAY[]::text[];
    v_org_a uuid; v_org_b uuid;
    v_season_a uuid; v_season_b uuid; v_div_a uuid; v_div_b uuid;
    v_loc_a uuid; v_loc_b uuid; v_field_a uuid; v_field_b uuid;
    v_team_a uuid;
    v_res jsonb;
    v_n int; v_m int; i int;
    t text;
    v_ok boolean;
    v_err text;
    v_rows int;
    v_seen_own int; v_seen_other int; v_slots_own int; v_slots_other int;
BEGIN
    -- ---- 0. the tables this is about all exist ------------------------------
    SELECT count(*) INTO v_n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY (c_tables);
    IF v_n <> 13 THEN
        RAISE EXCEPTION 'expected the 13 tables of 20260928000000, found %', v_n;
    END IF;

    -- ---- 1. no-op on the repo chain -----------------------------------------
    v_res := public.reconcile_prod_rls_drift();
    IF jsonb_array_length(v_res->'created') <> 0 OR jsonb_array_length(v_res->'dropped') <> 0
       OR jsonb_array_length(v_res->'verified') <> 19 THEN
        RAISE EXCEPTION 'on the repo chain the reconcile must create 0, drop 0 and verify 19 identical policies; got %', v_res;
    END IF;
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename IN ('practice_slots', 'field_subunits', 'scheduler_runs')
       AND policyname = 'org_member_access';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'org_member_access survived the migration on % table(s)', v_n;
    END IF;
    RAISE NOTICE 'repo chain: the reconcile is a no-op (created 0, dropped 0, verified 19 identical to their definitions)';

    -- A same-named policy with different semantics must abort, not verify.
    -- (The block's exception rolls the swap back.)
    v_err := NULL;
    BEGIN
        DROP POLICY "Teams: members access" ON public.teams;
        CREATE POLICY "Teams: members access" ON public.teams FOR ALL TO authenticated
            USING (is_org_member(organization_id));
        PERFORM public.reconcile_prod_rls_drift();
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE '%already has "Teams: members access" but it differs from the repo definition%' THEN
        RAISE EXCEPTION 'a same-named FOR ALL "Teams: members access" was not refused (error: %)', COALESCE(v_err, 'none');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'teams'
                    AND policyname = 'Teams: members access' AND cmd = 'SELECT') THEN
        RAISE EXCEPTION 'the mismatch probe did not roll back';
    END IF;
    RAISE NOTICE 'a same-named policy with different semantics aborts the reconcile instead of being verified';

    -- The broad policy on a table the drift report did not name aborts.
    v_err := NULL;
    BEGIN
        CREATE POLICY "Enforce Org Membership: ALL" ON public.season_settings FOR ALL TO authenticated
            USING (is_org_member(organization_id)) WITH CHECK (is_org_member(organization_id));
        PERFORM public.reconcile_prod_rls_drift();
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE '%is on public.season_settings, which the drift report did not name%' THEN
        RAISE EXCEPTION 'the broad policy on an unnamed table was not refused (error: %)', COALESCE(v_err, 'none');
    END IF;

    -- A member-write policy under a name the reconcile does not know aborts.
    v_err := NULL;
    BEGIN
        CREATE POLICY "Strict org access on teams" ON public.teams FOR ALL TO authenticated
            USING (is_org_member(organization_id));
        PERFORM public.reconcile_prod_rls_drift();
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE '%public.teams still has write policy "Strict org access on teams" that is not admin-gated%' THEN
        RAISE EXCEPTION 'an unknown member-write policy on teams was not refused (error: %)', COALESCE(v_err, 'none');
    END IF;
    -- A member-gated ALL policy on a table nobody listed must abort the
    -- reconcile's catalogue-wide end-state check.
    v_err := NULL;
    BEGIN
        CREATE TABLE public.__rls_drift_probe (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
        ALTER TABLE public.__rls_drift_probe ENABLE ROW LEVEL SECURITY;
        CREATE POLICY "probe member write" ON public.__rls_drift_probe FOR ALL TO authenticated
            USING (is_org_member(organization_id));
        PERFORM public.reconcile_prod_rls_drift();
    EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    IF v_err IS NULL OR v_err NOT LIKE '%public.__rls_drift_probe still has write policy "probe member write" that is not admin-gated%' THEN
        RAISE EXCEPTION 'a member-gated ALL policy on an unlisted table was not refused (error: %)', COALESCE(v_err, 'none');
    END IF;
    RAISE NOTICE 'an unnamed-table broad policy, an unknown member-write policy and a member-writable table nobody listed each abort the reconcile';

    -- ---- seed: two orgs, one non-admin member of org A ----------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES (v_member, 'rls-drift-coach@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES (v_member, 'rls-drift-coach@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('RLS Drift Org A', 'rls-drift-org-a') RETURNING id INTO v_org_a;
    INSERT INTO public.organizations (name, slug) VALUES ('RLS Drift Org B', 'rls-drift-org-b') RETURNING id INTO v_org_b;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org_a, v_member, 'coach');
    INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES (v_admin, 'rls-drift-admin@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'rls-drift-admin@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org_a, v_admin, 'admin');
    INSERT INTO public.scheduler_runs (organization_id, run_type, status) VALUES (v_org_a, 'practice', 'completed') RETURNING id INTO v_run_a;
    INSERT INTO public.scheduler_runs (organization_id, run_type, status) VALUES (v_org_b, 'practice', 'completed');
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org_a, 'Drift Season A') RETURNING id INTO v_season_a;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org_b, 'Drift Season B') RETURNING id INTO v_season_b;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org_a, v_season_a, 'Drift Div A') RETURNING id INTO v_div_a;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org_b, v_season_b, 'Drift Div B') RETURNING id INTO v_div_b;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org_a, v_div_a, 'Drift Team A') RETURNING id INTO v_team_a;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org_b, v_div_b, 'Drift Team B');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org_a, 'Drift Park A') RETURNING id INTO v_loc_a;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org_b, 'Drift Park B') RETURNING id INTO v_loc_b;
    INSERT INTO public.fields (organization_id, location_id, name) VALUES (v_org_a, v_loc_a, 'Drift Field A') RETURNING id INTO v_field_a;
    INSERT INTO public.fields (organization_id, location_id, name) VALUES (v_org_b, v_loc_b, 'Drift Field B') RETURNING id INTO v_field_b;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time)
      VALUES (v_org_a, v_field_a, 'mon', '17:00', '18:00');
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time)
      VALUES (v_org_b, v_field_b, 'mon', '17:00', '18:00');

    PERFORM set_config('request.jwt.claim.sub', v_member::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_member, 'role', 'authenticated')::text, true);

    -- ---- 2. recreate production's drift -------------------------------------
    FOREACH t IN ARRAY c_broad_tables LOOP
        EXECUTE format(
            'CREATE POLICY "Enforce Org Membership: ALL" ON public.%I FOR ALL TO authenticated '
            'USING (is_org_member(organization_id)) WITH CHECK (is_org_member(organization_id))', t);
    END LOOP;
    -- Meta-assertion: the drift is really there, or everything below is
    -- vacuous. The read policies are counted before AND after the drops, so a
    -- list that named nothing real cannot read as "all removed".
    v_m := 0;
    FOR i IN 1 .. array_length(c_prod_missing, 1) LOOP
        IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                    AND tablename = c_prod_missing[i][1] AND policyname = c_prod_missing[i][2]) THEN
            v_m := v_m + 1;
        END IF;
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', c_prod_missing[i][2], c_prod_missing[i][1]);
        IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                    AND tablename = c_prod_missing[i][1] AND policyname = c_prod_missing[i][2]) THEN
            RAISE EXCEPTION 'the drift replay could not drop % on public.%', c_prod_missing[i][2], c_prod_missing[i][1];
        END IF;
    END LOOP;
    SELECT count(*) INTO v_n FROM pg_policies WHERE policyname = 'Enforce Org Membership: ALL';
    IF v_n <> 11 OR v_m <> 9 THEN
        RAISE EXCEPTION 'the drift replay did not take: % broad policies (want 11), % of 9 read policies were there to drop', v_n, v_m;
    END IF;

    -- ---- 3. positive control: under the drift a member CAN write ------------
    -- Each write is undone by raising inside its own block, so the control
    -- leaves no row behind.
    FOREACH t IN ARRAY ARRAY['teams', 'fields'] LOOP
        v_ok := false;
        BEGIN
            SET LOCAL ROLE authenticated;
            IF t = 'teams' THEN
                INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org_a, v_div_a, 'Drift Control Team');
            ELSE
                INSERT INTO public.fields (organization_id, location_id, name) VALUES (v_org_a, v_loc_a, 'Drift Control Field');
            END IF;
            v_ok := true;
            RAISE EXCEPTION USING ERRCODE = 'P0927', MESSAGE = 'undo control write';
        EXCEPTION WHEN SQLSTATE 'P0927' THEN NULL;
        END;
        RESET ROLE;
        IF NOT v_ok THEN
            RAISE EXCEPTION 'control: under the production drift a member could not insert into % -- the refusals below would prove nothing', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'production drift replayed: 11 broad ALL policies, 9 read policies removed; a non-admin member could insert into teams and fields';

    -- ---- 4. the reconcile, the function the migration ran -------------------
    v_res := public.reconcile_prod_rls_drift();
    IF jsonb_array_length(v_res->'created') <> 9 OR jsonb_array_length(v_res->'dropped') <> 11
       OR jsonb_array_length(v_res->'verified') <> 10 THEN
        RAISE EXCEPTION 'over the production drift the reconcile must create 9, drop 11 and verify 10; got %', v_res;
    END IF;

    SELECT count(*) INTO v_n FROM pg_policies WHERE policyname = 'Enforce Org Membership: ALL';
    IF v_n <> 0 THEN
        RAISE EXCEPTION '"Enforce Org Membership: ALL" survived the reconcile on % table(s)', v_n;
    END IF;

    FOR i IN 1 .. array_length(c_prod_missing, 1) LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                        AND tablename = c_prod_missing[i][1] AND policyname = c_prod_missing[i][2]
                        AND cmd = 'SELECT') THEN
            RAISE EXCEPTION 'the reconcile did not restore % on public.%', c_prod_missing[i][2], c_prod_missing[i][1];
        END IF;
    END LOOP;

    -- ---- catalogue-wide, semantically: every non-SELECT policy in public ----
    -- Each policy's clauses are evaluated as the plain member (auth.uid() is
    -- set above) against a row of the policy's own table whose every uuid
    -- column is org A's id: in the member's org, and not their own row. The
    -- universe is pg_policies itself, not a list.
    FOR v_pol IN
        SELECT tablename, policyname, cmd, qual, with_check
          FROM pg_policies WHERE schemaname = 'public' AND cmd <> 'SELECT'
         ORDER BY tablename, policyname
    LOOP
        SELECT COALESCE(jsonb_object_agg(attname, v_org_a), '{}'::jsonb) INTO v_uuid_cols
          FROM pg_attribute
         WHERE attrelid = format('public.%I', v_pol.tablename)::regclass
           AND attnum > 0 AND NOT attisdropped AND atttypid = 'uuid'::regtype;
        v_q := CASE WHEN v_pol.cmd IN ('ALL', 'UPDATE', 'DELETE') THEN v_pol.qual END;
        v_c := CASE WHEN v_pol.cmd IN ('ALL', 'INSERT', 'UPDATE')
                    THEN COALESCE(v_pol.with_check, CASE WHEN v_pol.cmd <> 'INSERT' THEN v_pol.qual END) END;
        EXECUTE format('SELECT COALESCE((%s), false) OR COALESCE((%s), false) FROM jsonb_populate_record(NULL::public.%I, $1) AS %I',
                       COALESCE(v_q, 'false'), COALESCE(v_c, 'false'), v_pol.tablename, v_pol.tablename)
           INTO v_sat USING v_uuid_cols;
        v_examined := v_examined + 1;
        IF v_sat THEN
            v_hits := v_hits || (v_pol.tablename || ': ' || v_pol.policyname);
            IF NOT EXISTS (SELECT 1 FROM public.rls_member_write_allowlist() a
                            WHERE a.tablename = v_pol.tablename AND a.policyname = v_pol.policyname) THEN
                RAISE EXCEPTION 'a plain member can satisfy write policy "%" on public.% and it is not allowlisted', v_pol.policyname, v_pol.tablename;
            END IF;
        END IF;
    END LOOP;
    -- The evaluator must be able to say yes: the allowlisted telemetry insert
    -- IS member-satisfiable, so an evaluator that always said false fails here.
    IF v_examined < 20 OR v_hits <> ARRAY['telemetry_log: Insert telemetry for own organization'] THEN
        RAISE EXCEPTION 'the semantic census examined % write policies and found member-satisfiable %; want >= 20 and exactly the telemetry insert', v_examined, v_hits;
    END IF;
    -- Every allowlist entry must name a real policy, or it outlives its gap.
    SELECT count(*) INTO v_n FROM public.rls_member_write_allowlist() a
     WHERE NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public'
                        AND p.tablename = a.tablename AND p.policyname = a.policyname AND p.cmd <> 'SELECT');
    IF v_n <> 0 THEN
        RAISE EXCEPTION '% allowlist entry(ies) name no write policy', v_n;
    END IF;
    -- Negative control, on the same evaluator: a fresh member-writable table.
    v_sat := NULL;
    BEGIN
        CREATE TABLE public.__rls_drift_probe (id uuid PRIMARY KEY, organization_id uuid NOT NULL);
        CREATE POLICY "probe member write" ON public.__rls_drift_probe FOR ALL TO authenticated
            USING (is_org_member(organization_id));
        EXECUTE format('SELECT COALESCE((%s), false) FROM jsonb_populate_record(NULL::public.__rls_drift_probe, $1) AS __rls_drift_probe',
                       (SELECT qual FROM pg_policies WHERE tablename = '__rls_drift_probe'))
           INTO v_sat USING jsonb_build_object('id', v_org_a, 'organization_id', v_org_a);
        RAISE EXCEPTION USING ERRCODE = 'P0928', MESSAGE = 'undo probe table';
    EXCEPTION WHEN SQLSTATE 'P0928' THEN NULL;
    END;
    IF v_sat IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'negative control: the semantic census did not flag a member-gated ALL policy';
    END IF;
    RAISE NOTICE 'semantic census: % write policies in public evaluated as a plain member; member-satisfiable exactly %, allowlisted; a planted member-writable table is flagged', v_examined, v_hits;

    -- ---- 5. a non-admin member's session ------------------------------------
    FOREACH t IN ARRAY ARRAY['teams', 'fields', 'practice_slots'] LOOP
        v_err := NULL;
        BEGIN
            SET LOCAL ROLE authenticated;
            IF t = 'teams' THEN
                INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org_a, v_div_a, 'Drift Member Team');
            ELSIF t = 'fields' THEN
                INSERT INTO public.fields (organization_id, location_id, name) VALUES (v_org_a, v_loc_a, 'Drift Member Field');
            ELSE
                INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time)
                  VALUES (v_org_a, v_field_a, 'tue', '17:00', '18:00');
            END IF;
        EXCEPTION WHEN insufficient_privilege THEN
            GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        END;
        RESET ROLE;
        IF v_err IS NULL OR v_err NOT LIKE 'new row violates row-level security policy%' THEN
            RAISE EXCEPTION 'a non-admin member''s insert into % was not refused by RLS (error: %)', t, COALESCE(v_err, 'none -- it succeeded');
        END IF;
    END LOOP;

    SET LOCAL ROLE authenticated;
    UPDATE public.teams SET name = 'Drift Renamed' WHERE id = v_team_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    DELETE FROM public.teams WHERE id = v_team_a;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    SELECT count(*) FILTER (WHERE organization_id = v_org_a), count(*) FILTER (WHERE organization_id <> v_org_a)
      INTO v_seen_own, v_seen_other FROM public.teams;
    SELECT count(*) FILTER (WHERE organization_id = v_org_a), count(*) FILTER (WHERE organization_id <> v_org_a)
      INTO v_slots_own, v_slots_other FROM public.practice_slots;
    RESET ROLE;
    IF v_rows <> 0 OR v_n <> 0 THEN
        RAISE EXCEPTION 'a non-admin member updated % and deleted % team row(s)', v_rows, v_n;
    END IF;
    IF v_seen_own <> 1 OR v_seen_other <> 0 THEN
        RAISE EXCEPTION 'a member read % team(s) in their org (want 1) and % elsewhere (want 0)', v_seen_own, v_seen_other;
    END IF;
    IF v_slots_own <> 1 OR v_slots_other <> 0 THEN
        RAISE EXCEPTION 'a member read % practice slot(s) in their org (want 1) and % elsewhere (want 0)', v_slots_own, v_slots_other;
    END IF;
    -- The other org's rows exist; the zero above is RLS, not an empty table.
    SELECT count(*) INTO v_n FROM public.teams WHERE organization_id = v_org_b;
    SELECT count(*) INTO v_m FROM public.practice_slots WHERE organization_id = v_org_b;
    IF v_n <> 1 OR v_m <> 1 THEN
        RAISE EXCEPTION 'org B should hold 1 team and 1 practice slot, holds % and %', v_n, v_m;
    END IF;

    -- ---- 6. scheduler_runs ---------------------------------------------------
    v_err := NULL;
    BEGIN
        SET LOCAL ROLE authenticated;
        INSERT INTO public.scheduler_runs (organization_id, run_type, status) VALUES (v_org_a, 'practice', 'queued');
    EXCEPTION WHEN insufficient_privilege THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    END;
    RESET ROLE;
    IF v_err IS NULL OR v_err NOT LIKE 'new row violates row-level security policy%' THEN
        RAISE EXCEPTION 'a non-admin member''s insert into scheduler_runs was not refused by RLS (error: %)', COALESCE(v_err, 'none -- it succeeded');
    END IF;
    SET LOCAL ROLE authenticated;
    UPDATE public.scheduler_runs SET status = 'failed' WHERE id = v_run_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    SELECT count(*) FILTER (WHERE organization_id = v_org_a), count(*) FILTER (WHERE organization_id <> v_org_a)
      INTO v_seen_own, v_seen_other FROM public.scheduler_runs;
    RESET ROLE;
    IF v_rows <> 0 OR v_seen_own <> 1 OR v_seen_other <> 0 THEN
        RAISE EXCEPTION 'scheduler_runs as a member: updated % (want 0), read % own (want 1) and % other (want 0)', v_rows, v_seen_own, v_seen_other;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.scheduler_runs (organization_id, run_type, status) VALUES (v_org_a, 'practice', 'running');
    UPDATE public.scheduler_runs SET status = 'completed_with_warnings' WHERE id = v_run_a;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', v_member::text, true);
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'an admin updated % scheduler_runs row(s) (want 1)', v_rows;
    END IF;
    RAISE NOTICE 'scheduler_runs: a member reads 1 own-org run and 0 of org B, and cannot insert or update; an admin session inserts and updates';

    RAISE NOTICE 'reconciled over the production drift: broad ALL policy gone from all 11 tables, 9 read policies restored, no unallowlisted member write policy in public';
    RAISE NOTICE 'non-admin member after reconcile: inserts into teams, fields and practice_slots refused by RLS; update and delete reached 0 rows';
    RAISE NOTICE 'non-admin member after reconcile: reads 1 of 1 own-org team and 1 of 1 own-org practice slot, and 0 of org B''s';
END;
$smoke$;

ROLLBACK;
