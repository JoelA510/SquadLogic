-- Smoke checks for 20261116010000_edit_keeps_must_pending.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined, and
-- `scripts/dbharness/run.sh` turns two of them into (checked) claims, each proven by a plant in
-- `scripts/dbharness/prove.sh`. `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub`, so this runs
-- the REAL `admin_edit_practice_preference` as a real admin, over one rule in each state a rule can be in:
-- a requested must still pending (two of them), an accepted must, a must kept as prefer and a rule nobody
-- asked a must of. The decided rows carry a stamp two days old, so an edit that re-stamps them moves it and
-- one that must not stamp a pending rule leaves NULL there.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages. Every id is generated and every
-- email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();   -- an admin of another organization
    v_stranger uuid := gen_random_uuid();   -- signed in, no membership
    v_org uuid;
    v_other_org uuid;
    v_season uuid;
    v_division uuid;
    v_t1 uuid;
    v_c1 uuid;
    v_pending uuid;      -- a requested must, still pending
    v_pending2 uuid;     -- another, to be saved at must
    v_accepted uuid;     -- an accepted must
    v_kept uuid;         -- a must kept as prefer
    v_plain uuid;        -- a rule nobody asked a must of
    v_old timestamptz := now() - interval '2 days';
    v_row public.coach_practice_preferences%ROWTYPE;
    v_res jsonb;
    v_n int;
    v_refused int := 0;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'pending-admin@example.test', '{"password_length": 16}'),
        (v_outsider, 'pending-outsider@example.test', '{"password_length": 16}'),
        (v_stranger, 'pending-stranger@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'pending-admin@example.test'), (v_outsider, 'pending-outsider@example.test'),
        (v_stranger, 'pending-stranger@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Pending', 'smoke-org-pending') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Pending other', 'smoke-org-pending-other') RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_other_org, v_outsider, 'admin');
    INSERT INTO public.season_settings (organization_id, name, status) VALUES (v_org, 'Pending Season', 'active')
        RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_season, 'Pending U10')
        RETURNING id INTO v_division;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_division, 'Pending Team 1') RETURNING id INTO v_t1;
    INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email, status)
        VALUES (v_org, v_season, 'Pending Coach 1', 'pending-c1@example.test', 'active') RETURNING id INTO v_c1;
    INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, started_via)
        VALUES (v_org, v_t1, v_c1, 'lead', current_date - 30, 'smoke');

    -- The five states, as the owner (an import writes the pending ones; an earlier decision wrote the others).
    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source)
        VALUES (v_org, v_c1, v_t1, ARRAY['WED'], 'prefer', 'must', 'pending', 'in_force', 'import') RETURNING id INTO v_pending;
    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source)
        VALUES (v_org, v_c1, v_t1, ARRAY['FRI'], 'prefer', 'must', 'pending', 'in_force', 'import') RETURNING id INTO v_pending2;
    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source, decided_by, decided_at)
        VALUES (v_org, v_c1, v_t1, ARRAY['MON'], 'must', 'must', 'accepted', 'in_force', 'import', v_stranger, v_old) RETURNING id INTO v_accepted;
    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source, decided_by, decided_at)
        VALUES (v_org, v_c1, v_t1, ARRAY['TUE'], 'prefer', 'must', 'kept_prefer', 'in_force', 'import', v_stranger, v_old) RETURNING id INTO v_kept;
    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source)
        VALUES (v_org, v_c1, v_t1, ARRAY['SAT'], 'prefer', 'prefer', NULL, 'in_force', 'admin') RETURNING id INTO v_plain;

    -- ---- (a) a pending must saved at prefer stays pending; nobody is stamped as deciding it ----
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_res := public.admin_edit_practice_preference(v_pending, 'prefer', ARRAY['THU'], NULL, NULL, false, false, false, 'high',
                                                    current_date, current_date + 30);
    IF v_res ->> 'must_decision' <> 'pending' OR v_res ->> 'level' <> 'prefer' OR v_res ->> 'requested_level' <> 'must'
       OR v_res ->> 'decided_by' IS NOT NULL OR v_res ->> 'decided_at' IS NOT NULL THEN
        RAISE EXCEPTION '(a) a pending must saved at prefer was decided: %', v_res;
    END IF;
    -- Again, with the level left out: the default is prefer, so it is the same save.
    v_res := public.admin_edit_practice_preference(v_pending, p_weekdays => ARRAY['SUN']);
    SELECT * INTO v_row FROM public.coach_practice_preferences WHERE id = v_pending;
    IF v_row.must_decision IS DISTINCT FROM 'pending' OR v_row.level <> 'prefer' OR v_row.requested_level <> 'must'
       OR v_row.decided_by IS NOT NULL OR v_row.decided_at IS NOT NULL OR v_row.status <> 'in_force' THEN
        RAISE EXCEPTION '(a) a pending must saved with the level omitted was decided: %', to_jsonb(v_row);
    END IF;
    -- The edits themselves took: the second replaced the whole rule (days, no priority, no window).
    IF v_row.weekdays IS DISTINCT FROM ARRAY['SUN']::text[] OR v_row.coach_priority IS NOT NULL
       OR v_row.effective_from IS NOT NULL OR v_row.effective_to IS NOT NULL OR v_row.updated_by IS DISTINCT FROM v_admin THEN
        RAISE EXCEPTION '(a) the edit did not replace the rule: %', to_jsonb(v_row);
    END IF;
    -- Two audit rows, each saying pending before and after.
    SELECT count(*) INTO v_n FROM public.audit_log a
     WHERE a.organization_id = v_org AND a.action = 'practice_preference.edited' AND a.resource_id = v_pending
       AND a.metadata -> 'before' ->> 'must_decision' = 'pending' AND a.metadata -> 'after' ->> 'must_decision' = 'pending'
       AND a.metadata -> 'after' ->> 'decided_by' IS NULL;
    IF v_n <> 2 THEN
        RAISE EXCEPTION '(a) expected 2 edit audit rows saying pending before and after, found %', v_n;
    END IF;
    -- The admin who edited it can still decide it, on its own: Keep as prefer is its own act.
    v_res := public.admin_decide_must_preference(v_pending, 'keep_prefer');
    IF v_res ->> 'must_decision' <> 'kept_prefer' OR v_res ->> 'decided_by' <> v_admin::text OR v_res ->> 'decided_at' IS NULL THEN
        RAISE EXCEPTION '(a) Keep as prefer did not decide the edited rule: %', v_res;
    END IF;
    RAISE NOTICE 'pending stays pending: a requested must saved at prefer, and again with the level left out, kept must_decision pending, level prefer, requested_level must and no decided_by or decided_at while its days, priority and window were replaced; 2 of 2 edit audit rows say pending before and after; Keep as prefer then decided it';

    -- ---- (b) a save that changes the level, or a rule already decided, decides as it always did -------
    v_res := public.admin_edit_practice_preference(v_pending2, 'must', ARRAY['FRI']);
    IF v_res ->> 'must_decision' <> 'accepted' OR v_res ->> 'level' <> 'must' OR v_res ->> 'requested_level' <> 'must'
       OR v_res ->> 'decided_by' <> v_admin::text OR v_res ->> 'decided_at' IS NULL THEN
        RAISE EXCEPTION '(b) a pending must saved at must was not accepted and stamped: %', v_res;
    END IF;
    v_res := public.admin_edit_practice_preference(v_accepted, 'prefer', ARRAY['MON']);
    IF v_res ->> 'must_decision' <> 'kept_prefer' OR v_res ->> 'level' <> 'prefer' OR v_res ->> 'decided_by' <> v_admin::text
       OR (v_res ->> 'decided_at')::timestamptz <= v_old THEN
        RAISE EXCEPTION '(b) an accepted must saved at prefer was not kept as prefer and stamped: %', v_res;
    END IF;
    v_res := public.admin_edit_practice_preference(v_kept, 'prefer', ARRAY['TUE']);
    IF v_res ->> 'must_decision' <> 'kept_prefer' OR v_res ->> 'level' <> 'prefer' OR v_res ->> 'requested_level' <> 'must' THEN
        RAISE EXCEPTION '(b) a rule kept as prefer and saved at prefer changed its decision: %', v_res;
    END IF;
    v_res := public.admin_edit_practice_preference(v_plain, 'prefer', ARRAY['SAT']);
    IF v_res ->> 'must_decision' IS NOT NULL OR v_res ->> 'requested_level' <> 'prefer' OR v_res ->> 'level' <> 'prefer'
       OR v_res ->> 'decided_by' IS NOT NULL OR v_res ->> 'decided_at' IS NOT NULL THEN
        RAISE EXCEPTION '(b) a rule nobody asked a must of grew a decision: %', v_res;
    END IF;
    v_res := public.admin_edit_practice_preference(v_plain, 'must', ARRAY['SAT']);
    IF v_res ->> 'must_decision' <> 'accepted' OR v_res ->> 'level' <> 'must' OR v_res ->> 'requested_level' <> 'must' THEN
        RAISE EXCEPTION '(b) an admin could not make a plain rule a must by saving it at must: %', v_res;
    END IF;
    RAISE NOTICE 'explicit decisions: a pending must saved at must was accepted and stamped by the admin; an accepted must saved at prefer was kept as prefer and re-stamped; a rule kept as prefer saved at prefer stayed kept; a rule nobody asked a must of has no decision at prefer and is accepted at must';

    -- ---- (c) the replaced body still refuses everyone who is not this organization's admin ----
    FOR v_n IN 1..2 LOOP
        PERFORM set_config('request.jwt.claim.sub', (ARRAY[v_stranger, v_outsider])[v_n]::text, true);
        BEGIN PERFORM public.admin_edit_practice_preference(v_pending2, 'prefer', ARRAY['SUN']);
        EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    END LOOP;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.admin_edit_practice_preference(v_pending2, 'prefer', ARRAY['SUN']);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    IF v_refused <> 3 OR (SELECT weekdays FROM public.coach_practice_preferences WHERE id = v_pending2) <> ARRAY['FRI']::text[] THEN
        RAISE EXCEPTION '(c) only % of 3 non-admin edits were refused, or one changed the rule', v_refused;
    END IF;
    RAISE NOTICE 'refusals: a signed-in non-member, another organization''s admin and a caller with no user were each refused 42501, 3 of 3, and the rule is unchanged';
END;
$$;

ROLLBACK;
