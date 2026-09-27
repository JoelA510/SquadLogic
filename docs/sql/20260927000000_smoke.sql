-- Smoke checks for 20260927000000_coach_practice_preferences.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined,
-- and `scripts/dbharness/run.sh` turns five of them into (checked) claims,
-- each proven by a plant in `scripts/dbharness/prove.sh`. `prelude.sql` stubs
-- `auth.uid()` from `request.jwt.claim.sub`, so the round trip runs the REAL
-- RPCs as a real admin and two real coaches; the RLS reads run under
-- `SET LOCAL ROLE authenticated`, where the policy applies.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The store, read from the catalogue
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_write text[];
    v_select int;
    v_unique int;
    v_actions int;
    v_definer int;
BEGIN
    IF NOT (SELECT c.relrowsecurity FROM pg_class c
             WHERE c.oid = 'public.coach_practice_preferences'::regclass) THEN
        RAISE EXCEPTION 'coach_practice_preferences does not have ROW LEVEL SECURITY enabled';
    END IF;
    SELECT array_agg(polname ORDER BY polname) INTO v_write
      FROM pg_policy
     WHERE polrelid = 'public.coach_practice_preferences'::regclass AND polcmd <> 'r';
    IF v_write IS NOT NULL THEN
        RAISE EXCEPTION 'coach_practice_preferences carries write policies %; its only writers are the definer RPCs', v_write;
    END IF;
    SELECT count(*) INTO v_select
      FROM pg_policy
     WHERE polrelid = 'public.coach_practice_preferences'::regclass AND polcmd = 'r';
    IF v_select <> 1 THEN
        RAISE EXCEPTION 'expected exactly one SELECT policy on coach_practice_preferences, found %', v_select;
    END IF;
    IF has_table_privilege('authenticated', 'public.coach_practice_preferences', 'INSERT')
       OR has_table_privilege('authenticated', 'public.coach_practice_preferences', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.coach_practice_preferences', 'DELETE')
       OR has_table_privilege('service_role', 'public.coach_practice_preferences', 'INSERT')
       OR has_table_privilege('anon', 'public.coach_practice_preferences', 'SELECT') THEN
        RAISE EXCEPTION 'a client role holds a write (or anon a read) privilege on coach_practice_preferences';
    END IF;

    SELECT count(*) INTO v_unique
      FROM pg_index i
     WHERE i.indexrelid = 'public.coach_practice_preferences_one_approved'::regclass
       AND i.indisunique
       AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%status = ''approved''%';
    IF v_unique <> 1 THEN
        RAISE EXCEPTION 'coach_practice_preferences_one_approved is not a UNIQUE index partial on status = approved';
    END IF;

    SELECT count(*) INTO v_actions FROM public.audit_actions
     WHERE action IN ('coach_preference.requested', 'coach_preference.approved',
                      'coach_preference.rejected', 'coach_preference.changed');
    IF v_actions <> 4 THEN
        RAISE EXCEPTION 'expected the 4 coach_preference.* audit actions registered, found %', v_actions;
    END IF;

    SELECT count(*) INTO v_definer
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('request_coach_practice_preference',
                         'admin_decide_coach_practice_preference',
                         'admin_set_coach_practice_preference')
       AND p.prosecdef
       AND 'search_path=public' = ANY (p.proconfig)
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_definer <> 3 THEN
        RAISE EXCEPTION 'expected 3 definer RPCs with a pinned search_path, executable by authenticated and not anon; found %', v_definer;
    END IF;

    RAISE NOTICE 'store: RLS on, 1 SELECT policy, 0 write policies, no client write grant; one-approved index unique and partial; 4 audit actions; 3 definer RPCs, search_path pinned, authenticated yes, anon no';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The round trip, as an admin and two coaches
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_ua uuid := gen_random_uuid();
    v_ub uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();
    v_org uuid;
    v_other_org uuid;
    v_a uuid;
    v_b uuid;
    v_loc uuid;
    v_foreign_loc uuid;
    v_r1 uuid; v_r2 uuid; v_r3 uuid; v_rb uuid; v_s1 uuid; v_s2 uuid; v_stale uuid;
    v_res jsonb;
    v_refused boolean;
    v_n int;
    v_own int;
    v_theirs int;
    v_total int;
    v_audited int;
    v_bad int := 0;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'cpp-admin@example.test', '{"password_length": 16}'),
        (v_ua, 'cpp-a@example.test', '{"password_length": 16}'),
        (v_ub, 'cpp-b@example.test', '{"password_length": 16}'),
        (v_outsider, 'cpp-outsider@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'cpp-admin@example.test'), (v_ua, 'cpp-a@example.test'),
        (v_ub, 'cpp-b@example.test'), (v_outsider, 'cpp-outsider@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 8.6 PR1', 'smoke-org-86-pr1')
        RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 8.6 PR1 other', 'smoke-org-86-pr1-other')
        RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_ua, 'coach'), (v_org, v_ub, 'coach'),
        (v_other_org, v_outsider, 'admin');
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_ua, 'Coach A', 'cpp-a@example.test', 'active') RETURNING id INTO v_a;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_ub, 'Coach B', 'cpp-b@example.test', 'active') RETURNING id INTO v_b;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Preference Park')
        RETURNING id INTO v_loc;
    INSERT INTO public.locations (organization_id, name) VALUES (v_other_org, 'Elsewhere Park')
        RETURNING id INTO v_foreign_loc;

    -- ---- (a) a coach requests for themself; (b) never for another coach ----
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    v_res := public.request_coach_practice_preference(v_a, 'weekday', 'must_keep', '"TUE"');
    v_r1 := (v_res->>'id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.coach_practice_preferences
                    WHERE id = v_r1 AND status = 'requested' AND requested_by = v_ua
                      AND value = '"TUE"'::jsonb) THEN
        RAISE EXCEPTION '(a) coach A''s own request was not stored as requested by them: %', v_res;
    END IF;
    v_refused := false;
    BEGIN
        PERFORM public.request_coach_practice_preference(v_b, 'weekday', 'prefer_keep', '"WED"');
    EXCEPTION WHEN insufficient_privilege THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION '(b) coach A requested a practice preference for coach B';
    END IF;
    RAISE NOTICE 'coach preferences: coach A requested for themself; coach A requesting for coach B was refused (42501)';

    -- ---- (c) a coach approving is refused, their own request included ------
    v_refused := false;
    BEGIN
        PERFORM public.admin_decide_coach_practice_preference(v_r1, 'approve');
    EXCEPTION WHEN insufficient_privilege THEN
        v_refused := true;
    END;
    IF NOT v_refused OR (SELECT status FROM public.coach_practice_preferences WHERE id = v_r1) <> 'requested' THEN
        RAISE EXCEPTION '(c) a coach approved their own practice preference request';
    END IF;
    RAISE NOTICE 'coach preferences: a coach approving their own request was refused (42501) and the row is still requested';

    -- ---- (d) the admin approves; a later approval supersedes it -----------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_res := public.admin_decide_coach_practice_preference(v_r1, 'approve');
    IF v_res->>'status' <> 'approved' OR v_res->>'superseded_id' IS NOT NULL THEN
        RAISE EXCEPTION '(d) the first approval came back %', v_res;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    v_r2 := (public.request_coach_practice_preference(v_a, 'weekday', 'prefer_keep', '"THU"')->>'id')::uuid;
    v_r3 := (public.request_coach_practice_preference(v_a, 'start_time', 'prefer_keep', '1020')->>'id')::uuid;
    PERFORM set_config('request.jwt.claim.sub', v_ub::text, true);
    v_rb := (public.request_coach_practice_preference(v_b, 'weekday', 'dont_care')->>'id')::uuid;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    -- Approved with the level CHANGED (the approved-option step).
    v_res := public.admin_decide_coach_practice_preference(v_r2, 'approve', 'must_keep');
    IF (v_res->>'superseded_id')::uuid IS DISTINCT FROM v_r1 OR v_res->>'level' <> 'must_keep' THEN
        RAISE EXCEPTION '(d) the second approval did not supersede the first, or dropped the changed level: %', v_res;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.coach_practice_preferences
                    WHERE id = v_r1 AND status = 'superseded' AND effective_to = current_date - 1)
       OR NOT EXISTS (SELECT 1 FROM public.coach_practice_preferences
                       WHERE id = v_r2 AND status = 'approved' AND level = 'must_keep'
                         AND value = '"THU"'::jsonb AND decided_by = v_admin) THEN
        RAISE EXCEPTION '(d) after the second approval the rows are not (superseded, approved as changed)';
    END IF;
    PERFORM public.admin_decide_coach_practice_preference(v_r3, 'reject');
    v_s1 := (public.admin_set_coach_practice_preference(v_b, 'venue', 'must_keep', to_jsonb(v_loc::text))->>'id')::uuid;
    v_res := public.admin_set_coach_practice_preference(v_b, 'venue', 'prefer_keep', to_jsonb(v_loc::text));
    v_s2 := (v_res->>'id')::uuid;
    IF (v_res->>'superseded_id')::uuid IS DISTINCT FROM v_s1
       OR (SELECT status FROM public.coach_practice_preferences WHERE id = v_s1) <> 'superseded'
       OR (SELECT status FROM public.coach_practice_preferences WHERE id = v_r3) <> 'rejected' THEN
        RAISE EXCEPTION '(d) the admin set did not supersede its predecessor, or the rejection was not recorded';
    END IF;
    -- A request older than the decision in force is refused on approval. The
    -- probe runs in a sub-block that is rolled back, so no count below moves.
    v_refused := false;
    BEGIN
        PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
        v_stale := (public.request_coach_practice_preference(v_a, 'weekday', 'prefer_keep', '"FRI"')->>'id')::uuid;
        PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
        PERFORM public.admin_set_coach_practice_preference(v_a, 'weekday', 'must_keep', '"SAT"');
        BEGIN
            PERFORM public.admin_decide_coach_practice_preference(v_stale, 'approve');
        EXCEPTION WHEN invalid_parameter_value THEN
            v_refused := true;
        END;
        RAISE EXCEPTION 'smoke: roll back the stale-request probe';
    EXCEPTION WHEN raise_exception THEN
        NULL;
    END;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    IF NOT v_refused THEN
        RAISE EXCEPTION '(d) a request older than the decision in force was approved over it';
    END IF;
    RAISE NOTICE 'coach preferences: the admin approved; a later approval (level changed) superseded the earlier approved row, closed yesterday; 1 rejection and 2 admin sets recorded; approving a request older than the decision in force was refused';

    -- ---- (e) a second approved row for (coach, dimension) is refused -------
    -- The positive control first: exactly one approved row exists to collide with.
    SELECT count(*) INTO v_n FROM public.coach_practice_preferences
     WHERE coach_id = v_a AND dimension = 'weekday' AND status = 'approved';
    IF v_n <> 1 THEN
        RAISE EXCEPTION '(e) expected exactly 1 approved weekday row for coach A before the collision, found %', v_n;
    END IF;
    v_refused := false;
    BEGIN
        INSERT INTO public.coach_practice_preferences
            (organization_id, coach_id, dimension, level, status, decided_by, decided_at, effective_from)
        VALUES (v_org, v_a, 'weekday', 'prefer_keep', 'approved', v_admin, now(), current_date);
    EXCEPTION WHEN unique_violation THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION '(e) a second approved weekday row for coach A was accepted';
    END IF;
    RAISE NOTICE 'coach preferences: a second approved row for one (coach, dimension) was refused by the one-approved index (23505)';

    -- ---- (f) every write produced its audit row ---------------------------
    -- The subject set is the list of calls made above, not the audit log.
    SELECT count(*) INTO v_audited
      FROM (VALUES (v_r1, 'coach_preference.requested'), (v_r2, 'coach_preference.requested'),
                   (v_r3, 'coach_preference.requested'), (v_rb, 'coach_preference.requested'),
                   (v_r1, 'coach_preference.approved'), (v_r2, 'coach_preference.approved'),
                   (v_r3, 'coach_preference.rejected'),
                   (v_s1, 'coach_preference.changed'), (v_s2, 'coach_preference.changed')) AS w(id, action)
     WHERE (SELECT count(*) FROM public.audit_log l
             WHERE l.organization_id = v_org AND l.resource_id = w.id AND l.action = w.action) = 1;
    IF v_audited <> 9 THEN
        RAISE EXCEPTION '(f) only % of the 9 writes left exactly one audit row naming their row', v_audited;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_log
                    WHERE resource_id = v_r2 AND action = 'coach_preference.approved'
                      AND (metadata->>'superseded_id')::uuid = v_r1 AND user_id = v_admin) THEN
        RAISE EXCEPTION '(f) the second approval''s audit row does not name the row it superseded';
    END IF;
    RAISE NOTICE 'coach preferences: every write audited -- 9 of 9 (4 requested, 2 approved, 1 rejected, 2 changed), each naming its row';

    -- ---- (g) RLS: a coach reads their own rows; the admin reads all -------
    SELECT count(*) INTO v_total FROM public.coach_practice_preferences WHERE organization_id = v_org;
    IF v_total <> 6 THEN
        RAISE EXCEPTION '(g) expected 6 rows in the organisation as the owner, found %', v_total;
    END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_ub::text, true);
    SELECT count(*) FILTER (WHERE coach_id = v_b), count(*) FILTER (WHERE coach_id <> v_b)
      INTO v_own, v_theirs FROM public.coach_practice_preferences;
    IF v_own <> 3 OR v_theirs <> 0 THEN
        RAISE EXCEPTION '(g) coach B read % own and % other row(s); expected 3 and 0', v_own, v_theirs;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    SELECT count(*) FILTER (WHERE coach_id = v_a), count(*) FILTER (WHERE coach_id <> v_a)
      INTO v_own, v_theirs FROM public.coach_practice_preferences;
    IF v_own <> 3 OR v_theirs <> 0 THEN
        RAISE EXCEPTION '(g) coach A read % own and % other row(s); expected 3 and 0', v_own, v_theirs;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SELECT count(*) INTO v_n FROM public.coach_practice_preferences;
    IF v_n <> v_total THEN
        RAISE EXCEPTION '(g) the admin read % of the organisation''s % row(s)', v_n, v_total;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_outsider::text, true);
    SELECT count(*) INTO v_n FROM public.coach_practice_preferences;
    IF v_n <> 0 THEN
        RAISE EXCEPTION '(g) an admin of another organisation read % row(s)', v_n;
    END IF;
    RESET ROLE;
    RAISE NOTICE 'coach preferences: coach B read its 3 rows and none of coach A''s; coach A read its 3 and none of coach B''s; the admin read 6 of 6; another organisation''s admin read 0';

    -- ---- (h) free text and out-of-range values are refused ----------------
    -- As the admin, so no refusal below is an access refusal.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    BEGIN PERFORM public.request_coach_practice_preference(v_a, 'note', 'prefer_keep', '"call after 6"');
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.request_coach_practice_preference(v_a, 'weekday', 'prefer_keep', '"Tuesdays after school"');
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.request_coach_practice_preference(v_a, 'start_time', 'prefer_keep', '{"note": "late"}');
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.request_coach_practice_preference(v_a, 'start_time', 'prefer_keep', '1440');
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.request_coach_practice_preference(v_a, 'start_time', 'prefer_keep', '-1');
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.request_coach_practice_preference(v_a, 'start_time', 'prefer_keep', '540.5');
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.request_coach_practice_preference(v_a, 'weekday', 'maybe', '"TUE"');
    EXCEPTION WHEN check_violation THEN v_bad := v_bad + 1; END;
    BEGIN PERFORM public.request_coach_practice_preference(v_a, 'venue', 'must_keep', to_jsonb(v_foreign_loc::text));
    EXCEPTION WHEN foreign_key_violation THEN v_bad := v_bad + 1; END;
    IF v_bad <> 8 THEN
        RAISE EXCEPTION '(h) only % of 8 malformed writes were refused', v_bad;
    END IF;
    -- The positive control: the boundaries are accepted, so the refusals above
    -- are not a CHECK that refuses everything.
    PERFORM public.request_coach_practice_preference(v_a, 'start_time', 'prefer_keep', '0');
    PERFORM public.request_coach_practice_preference(v_a, 'start_time', 'prefer_keep', '1439');
    PERFORM public.request_coach_practice_preference(v_a, 'venue', 'prefer_keep', to_jsonb(v_loc::text));
    RAISE NOTICE 'coach preferences: 8 of 8 malformed writes refused (a free-text dimension, free-text weekday, an object value, minutes 1440, -1 and 540.5, an unknown level, another organisation''s location); minutes 0 and 1439 and an own location accepted';
END;
$$;

ROLLBACK;
