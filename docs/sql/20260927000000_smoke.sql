-- Smoke for 20260927000000_reconcile_prod_rls_drift.sql
--
-- Runs on the harness's head build, where the migration has already applied.
-- Everything happens inside one transaction that is ROLLED BACK, so the
-- production drift it recreates never reaches a later smoke or stage.
--
-- 1. On the repo chain the reconcile is a no-op: re-running it creates
--    nothing, drops nothing, and finds every one of its 17 repo policies
--    already present AND identical (deparsed clause by clause against a probe
--    built from the spec). The migration's own apply already removed
--    "org_member_access" from practice_slots and field_subunits.
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
        RAISE EXCEPTION 'expected the 13 tables of 20260927000000, found %', v_n;
    END IF;

    -- ---- 1. no-op on the repo chain -----------------------------------------
    v_res := public.reconcile_prod_rls_drift();
    IF jsonb_array_length(v_res->'created') <> 0 OR jsonb_array_length(v_res->'dropped') <> 0
       OR jsonb_array_length(v_res->'verified') <> 17 THEN
        RAISE EXCEPTION 'on the repo chain the reconcile must create 0, drop 0 and verify 17 identical policies; got %', v_res;
    END IF;
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename IN ('practice_slots', 'field_subunits')
       AND policyname = 'org_member_access';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'org_member_access survived the migration on % facility table(s)', v_n;
    END IF;
    RAISE NOTICE 'repo chain: the reconcile is a no-op (created 0, dropped 0, verified 17 identical to their repo definitions)';

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
    RAISE NOTICE 'an unnamed-table broad policy and an unknown member-write policy each abort the reconcile';

    -- ---- seed: two orgs, one non-admin member of org A ----------------------
    INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES (v_member, 'rls-drift-coach@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES (v_member, 'rls-drift-coach@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('RLS Drift Org A', 'rls-drift-org-a') RETURNING id INTO v_org_a;
    INSERT INTO public.organizations (name, slug) VALUES ('RLS Drift Org B', 'rls-drift-org-b') RETURNING id INTO v_org_b;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org_a, v_member, 'coach');
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
       OR jsonb_array_length(v_res->'verified') <> 8 THEN
        RAISE EXCEPTION 'over the production drift the reconcile must create 9, drop 11 and verify 8; got %', v_res;
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

    -- No write path for a plain member on any of the 13 tables: every
    -- non-SELECT policy there must be admin-gated in each clause it has.
    SELECT count(*), count(*) FILTER (WHERE
             (qual IS NOT NULL AND qual !~ 'is_org_admin\(')
          OR (with_check IS NOT NULL AND with_check !~ 'is_org_admin\('))
      INTO v_n, v_m
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = ANY (c_tables) AND cmd <> 'SELECT';
    IF v_m <> 0 THEN
        RAISE EXCEPTION '% write policy(ies) on the 13 tables are not admin-gated', v_m;
    END IF;
    IF v_n = 0 THEN
        RAISE EXCEPTION 'the admin-gate check examined no write policy (divisions carries three); it is not looking';
    END IF;

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

    RAISE NOTICE 'reconciled over the production drift: broad ALL policy gone from all 11 tables, 9 read policies restored, % write policy(ies) on the 13 tables all admin-gated', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY (c_tables) AND cmd <> 'SELECT');
    RAISE NOTICE 'non-admin member after reconcile: inserts into teams, fields and practice_slots refused by RLS; update and delete reached 0 rows';
    RAISE NOTICE 'non-admin member after reconcile: reads 1 of 1 own-org team and 1 of 1 own-org practice slot, and 0 of org B''s';
END;
$smoke$;

ROLLBACK;
