-- Smoke checks for 20261003000000_practice_lighting_overrides.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined,
-- and `scripts/dbharness/run.sh` turns six of them into (checked) claims, each
-- proven by a plant in `scripts/dbharness/prove.sh` (plan W30 and W24).
-- `prelude.sql` stubs `auth.uid()` from `request.jwt.claim.sub`, so the round
-- trip runs the REAL RPCs as two real admins and real coaches; the RLS reads
-- run under `SET LOCAL ROLE authenticated`, where the policy applies.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated, every email is `@example.test`, and every name is
-- synthetic; there is no PII and there are no coordinates.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The store, read from the catalogue
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_write text[];
    v_select int;
    v_excl int;
    v_actions int;
    v_definer int;
BEGIN
    IF NOT (SELECT c.relrowsecurity FROM pg_class c
             WHERE c.oid = 'public.practice_lighting_overrides'::regclass) THEN
        RAISE EXCEPTION 'practice_lighting_overrides does not have ROW LEVEL SECURITY enabled';
    END IF;
    SELECT array_agg(polname ORDER BY polname) INTO v_write
      FROM pg_policy
     WHERE polrelid = 'public.practice_lighting_overrides'::regclass AND polcmd <> 'r';
    IF v_write IS NOT NULL THEN
        RAISE EXCEPTION 'practice_lighting_overrides carries write policies %; its only writers are the definer RPCs', v_write;
    END IF;
    SELECT count(*) INTO v_select
      FROM pg_policy
     WHERE polrelid = 'public.practice_lighting_overrides'::regclass AND polcmd = 'r';
    IF v_select <> 1 THEN
        RAISE EXCEPTION 'expected exactly one SELECT policy on practice_lighting_overrides, found %', v_select;
    END IF;
    IF has_table_privilege('authenticated', 'public.practice_lighting_overrides', 'INSERT')
       OR has_table_privilege('authenticated', 'public.practice_lighting_overrides', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.practice_lighting_overrides', 'DELETE')
       OR has_table_privilege('service_role', 'public.practice_lighting_overrides', 'INSERT')
       OR has_table_privilege('anon', 'public.practice_lighting_overrides', 'SELECT') THEN
        RAISE EXCEPTION 'a client role holds a write (or anon a read) privilege on practice_lighting_overrides';
    END IF;

    SELECT count(*) INTO v_excl
      FROM pg_constraint
     WHERE conrelid = 'public.practice_lighting_overrides'::regclass
       AND conname = 'practice_lighting_overrides_no_overlap'
       AND contype = 'x'
       AND pg_get_constraintdef(oid) ILIKE '%status = ''approved''%';
    IF v_excl <> 1 THEN
        RAISE EXCEPTION 'practice_lighting_overrides_no_overlap is not an exclusion constraint partial on status = approved';
    END IF;

    SELECT count(*) INTO v_actions FROM public.audit_actions
     WHERE action IN ('practice_lighting_override.requested', 'practice_lighting_override.approved',
                      'practice_lighting_override.rejected', 'practice_lighting_override.withdrawn',
                      'practice_lighting_override.set');
    IF v_actions <> 5 THEN
        RAISE EXCEPTION 'expected the 5 practice_lighting_override.* audit actions registered, found %', v_actions;
    END IF;

    SELECT count(*) INTO v_definer
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('request_practice_lighting_override',
                         'admin_decide_practice_lighting_override',
                         'withdraw_practice_lighting_override',
                         'admin_set_practice_lighting_override',
                         'caller_coaches_practice_slot')
       AND p.prosecdef
       AND 'search_path=public' = ANY (p.proconfig)
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_definer <> 5 THEN
        RAISE EXCEPTION 'expected 5 definer functions with a pinned search_path, executable by authenticated and not anon; found %', v_definer;
    END IF;

    RAISE NOTICE 'store: RLS on, 1 SELECT policy, 0 write policies, no client write grant; the approved-overlap exclusion constraint present; 5 audit actions; 5 definer functions, search_path pinned, authenticated yes, anon no';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The round trip, as two admins, three coaches and a parent
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin uuid := gen_random_uuid();
    v_admin2 uuid := gen_random_uuid();
    v_ua uuid := gen_random_uuid();
    v_ub uuid := gen_random_uuid();
    v_uc uuid := gen_random_uuid();
    v_parent uuid := gen_random_uuid();
    v_outsider uuid := gen_random_uuid();
    v_org uuid; v_other_org uuid;
    v_loc uuid; v_field uuid; v_s uuid; v_d uuid;
    v_ta uuid; v_tb uuid;
    v_ca uuid; v_cb uuid; v_cc uuid;
    v_slot1 uuid; v_slot2 uuid;
    v_r1 uuid; v_r2 uuid; v_r3 uuid; v_r4 uuid; v_self uuid; v_set1 uuid; v_set2 uuid;
    v_res jsonb;
    v_refused int;
    v_n int;
    v_expected uuid[];
    v_got uuid[];
    v_s1_rows int; v_s2_rows int; v_other int;
    v_audited int;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_admin, 'plo-admin@example.test', '{"password_length": 16}'),
        (v_admin2, 'plo-admin2@example.test', '{"password_length": 16}'),
        (v_ua, 'plo-a@example.test', '{"password_length": 16}'),
        (v_ub, 'plo-b@example.test', '{"password_length": 16}'),
        (v_uc, 'plo-c@example.test', '{"password_length": 16}'),
        (v_parent, 'plo-parent@example.test', '{"password_length": 16}'),
        (v_outsider, 'plo-outsider@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_admin, 'plo-admin@example.test'), (v_admin2, 'plo-admin2@example.test'),
        (v_ua, 'plo-a@example.test'), (v_ub, 'plo-b@example.test'), (v_uc, 'plo-c@example.test'),
        (v_parent, 'plo-parent@example.test'), (v_outsider, 'plo-outsider@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org D14 PRB', 'smoke-org-d14-prb')
        RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org D14 PRB other', 'smoke-org-d14-prb-other')
        RETURNING id INTO v_other_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_admin, 'admin'), (v_org, v_admin2, 'admin'),
        (v_org, v_ua, 'coach'), (v_org, v_ub, 'coach'), (v_org, v_uc, 'coach'),
        (v_org, v_parent, 'parent'), (v_other_org, v_outsider, 'admin');
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_ua, 'Coach A', 'plo-a@example.test', 'active') RETURNING id INTO v_ca;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_ub, 'Coach B', 'plo-b@example.test', 'active') RETURNING id INTO v_cb;
    INSERT INTO public.coaches (organization_id, user_id, full_name, email, status)
        VALUES (v_org, v_uc, 'Coach C', 'plo-c@example.test', 'active') RETURNING id INTO v_cc;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'PLO Park') RETURNING id INTO v_loc;
    INSERT INTO public.fields (organization_id, location_id, name, active)
        VALUES (v_org, v_loc, 'PLO Pitch', true) RETURNING id INTO v_field;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'PLO Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'PLO U10') RETURNING id INTO v_d;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'PLO Team A') RETURNING id INTO v_ta;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_d, 'PLO Team B') RETURNING id INTO v_tb;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
        VALUES (v_org, v_field, 'mon', '17:00', '18:00', '2026-09-01', '2026-11-30') RETURNING id INTO v_slot1;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
        VALUES (v_org, v_field, 'wed', '17:00', '18:00', '2026-09-01', '2026-11-30') RETURNING id INTO v_slot2;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
        VALUES (v_org, v_ta, v_slot1, '[2026-09-01,2026-11-30]', 'auto'),
               (v_org, v_tb, v_slot2, '[2026-09-01,2026-11-30]', 'auto');
    -- Coach A coaches Team A (slot 1) today; Coach B coaches Team B (slot 2);
    -- Coach C coached Team A until yesterday: a lapsed coach of slot 1.
    INSERT INTO public.team_coach_assignments
        (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
    VALUES (v_org, v_ta, v_ca, 'lead', current_date - 30, NULL, 'smoke', NULL),
           (v_org, v_tb, v_cb, 'lead', current_date - 30, NULL, 'smoke', NULL),
           (v_org, v_ta, v_cc, 'assistant', current_date - 30, current_date - 1, 'smoke', 'smoke');

    -- ---- (a) a coach of the slot requests; (b) nobody else but an admin ----
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    v_res := public.request_practice_lighting_override(v_slot1, '2026-10-01', '2026-10-15');
    v_r1 := (v_res->>'id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.practice_lighting_overrides
                    WHERE id = v_r1 AND status = 'requested' AND requested_by = v_ua
                      AND kind = 'portable-lighting' AND "window" = '[2026-10-01,2026-10-16)'::daterange) THEN
        RAISE EXCEPTION '(a) coach A''s request was not stored as a requested [2026-10-01, 2026-10-15] window by them: %', v_res;
    END IF;
    v_refused := 0;
    PERFORM set_config('request.jwt.claim.sub', v_ub::text, true);
    BEGIN PERFORM public.request_practice_lighting_override(v_slot1, '2026-10-01', '2026-10-15');
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    PERFORM set_config('request.jwt.claim.sub', v_uc::text, true);
    BEGIN PERFORM public.request_practice_lighting_override(v_slot1, '2026-10-01', '2026-10-15');
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    PERFORM set_config('request.jwt.claim.sub', v_parent::text, true);
    BEGIN PERFORM public.request_practice_lighting_override(v_slot1, '2026-10-01', '2026-10-15');
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    PERFORM set_config('request.jwt.claim.sub', v_outsider::text, true);
    BEGIN PERFORM public.request_practice_lighting_override(v_slot1, '2026-10-01', '2026-10-15');
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    SELECT count(*) INTO v_n FROM public.practice_lighting_overrides WHERE organization_id = v_org;
    IF v_refused <> 4 OR v_n <> 1 THEN
        RAISE EXCEPTION '(b) % of 4 non-coach requests were refused and % row(s) exist; expected 4 and 1', v_refused, v_n;
    END IF;
    RAISE NOTICE 'lighting overrides: coach A (coaches a team on the slot) requested; a coach of another slot''s team, a lapsed coach, a parent and another organisation''s admin were each refused 42501, 4 of 4, and wrote nothing';

    -- ---- (c) a coach approving is refused, their own request included ------
    -- Coach B did not request the row, so the self-approval refusal cannot be
    -- what stops them: only the admin gate can.
    v_refused := 0;
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    BEGIN PERFORM public.admin_decide_practice_lighting_override(v_r1, 'approve');
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    PERFORM set_config('request.jwt.claim.sub', v_ub::text, true);
    BEGIN PERFORM public.admin_decide_practice_lighting_override(v_r1, 'approve');
    EXCEPTION WHEN insufficient_privilege THEN v_refused := v_refused + 1; END;
    IF v_refused <> 2 OR (SELECT status FROM public.practice_lighting_overrides WHERE id = v_r1) <> 'requested' THEN
        RAISE EXCEPTION '(c) % of 2 coach approvals were refused, or the row is no longer requested', v_refused;
    END IF;
    RAISE NOTICE 'lighting overrides: a coach approving was refused (42501), 2 of 2 (their own request and another coach''s), and the row is still requested';

    -- ---- (d) the admin who requested may not approve; another admin may ----
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_self := (public.request_practice_lighting_override(v_slot2, '2026-10-01', '2026-10-15')->>'id')::uuid;
    v_refused := 0;
    BEGIN PERFORM public.admin_decide_practice_lighting_override(v_self, 'approve');
    EXCEPTION WHEN insufficient_privilege THEN v_refused := 1; END;
    IF v_refused <> 1 OR (SELECT status FROM public.practice_lighting_overrides WHERE id = v_self) <> 'requested' THEN
        RAISE EXCEPTION '(d) the admin who requested lighting override % approved it themself', v_self;
    END IF;
    -- The positive control: the refusal is about the requester, not the row.
    PERFORM set_config('request.jwt.claim.sub', v_admin2::text, true);
    v_res := public.admin_decide_practice_lighting_override(v_self, 'approve');
    IF v_res->>'status' <> 'approved'
       OR NOT EXISTS (SELECT 1 FROM public.practice_lighting_overrides
                       WHERE id = v_self AND status = 'approved' AND decided_by = v_admin2) THEN
        RAISE EXCEPTION '(d) a second admin could not approve the first admin''s request: %', v_res;
    END IF;
    RAISE NOTICE 'lighting overrides: self-approval by the requesting admin was refused (42501) and the row stayed requested; a second admin approved it';

    -- ---- (e) two approved windows on one slot may not overlap ---------------
    PERFORM public.admin_decide_practice_lighting_override(v_r1, 'approve');
    -- Control: an overlapping REQUEST coexists with the approved window.
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    v_r2 := (public.request_practice_lighting_override(v_slot1, '2026-10-10', '2026-10-20')->>'id')::uuid;
    PERFORM set_config('request.jwt.claim.sub', v_admin2::text, true);
    v_refused := 0;
    BEGIN PERFORM public.admin_decide_practice_lighting_override(v_r2, 'approve');
    EXCEPTION WHEN exclusion_violation THEN v_refused := v_refused + 1; END;
    -- Sharing only the approved window's LAST day (inclusive) still overlaps.
    BEGIN PERFORM public.admin_set_practice_lighting_override(v_slot1, '2026-10-15', '2026-10-31');
    EXCEPTION WHEN exclusion_violation THEN v_refused := v_refused + 1; END;
    IF v_refused <> 2 OR (SELECT status FROM public.practice_lighting_overrides WHERE id = v_r2) <> 'requested' THEN
        RAISE EXCEPTION '(e) % of 2 overlapping approvals on slot 1 were refused', v_refused;
    END IF;
    -- Controls: the window from the day after, and the same dates on another
    -- slot (slot 2 already holds them), are accepted.
    v_set1 := (public.admin_set_practice_lighting_override(v_slot1, '2026-10-16', '2026-10-31')->>'id')::uuid;
    SELECT count(*) INTO v_n FROM public.practice_lighting_overrides
     WHERE status = 'approved' AND "window" = '[2026-10-01,2026-10-16)'::daterange
       AND practice_slot_id IN (v_slot1, v_slot2);
    IF v_set1 IS NULL OR v_n <> 2 THEN
        RAISE EXCEPTION '(e) the adjacent window or the same dates on another slot were not both approved (% same-date rows)', v_n;
    END IF;
    RAISE NOTICE 'lighting overrides: an approval over an approved window and an admin set sharing its last day were each refused 23P01, 2 of 2; the adjacent window and the same dates on another slot were accepted';

    -- ---- (f) reject, withdraw ---------------------------------------------
    PERFORM public.admin_decide_practice_lighting_override(v_r2, 'reject');
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    v_r3 := (public.request_practice_lighting_override(v_slot1, '2026-11-02', '2026-11-06')->>'id')::uuid;
    v_r4 := (public.request_practice_lighting_override(v_slot1, '2026-11-09', '2026-11-13')->>'id')::uuid;
    PERFORM public.withdraw_practice_lighting_override(v_r3);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_set2 := (public.admin_set_practice_lighting_override(v_slot2, '2026-11-02', '2026-11-06')->>'id')::uuid;
    PERFORM public.withdraw_practice_lighting_override(v_set2);
    -- Another coach may not withdraw coach A's request.
    PERFORM set_config('request.jwt.claim.sub', v_ub::text, true);
    v_refused := 0;
    BEGIN PERFORM public.withdraw_practice_lighting_override(v_r4);
    EXCEPTION WHEN insufficient_privilege THEN v_refused := 1; END;
    IF v_refused <> 1 THEN
        RAISE EXCEPTION '(f) coach B withdrew coach A''s lighting override request';
    END IF;
    RAISE NOTICE 'lighting overrides: 1 rejection, 2 withdrawals (a requested row by its coach, an approved row by an admin); another coach withdrawing was refused';

    -- ---- (g) W24: a reader of approved overrides gets approved rows only ----
    -- The expected set is the list of calls above, not the table.
    v_expected := ARRAY(SELECT unnest(ARRAY[v_r1, v_self, v_set1]) ORDER BY 1);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_got := ARRAY(SELECT id FROM public.practice_lighting_overrides WHERE status = 'approved' ORDER BY 1);
    SELECT count(*) INTO v_n FROM public.practice_lighting_overrides;
    RESET ROLE;
    IF v_got IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION '(g) the approved-overrides reader returned % where the calls approved exactly %', v_got, v_expected;
    END IF;
    -- Its meta-assertion: every other status is present to be left out.
    IF v_n <> 7
       OR (SELECT array_agg(status ORDER BY id) FROM public.practice_lighting_overrides
            WHERE id IN (v_r2, v_r3, v_r4, v_set2))
          IS DISTINCT FROM
          (SELECT array_agg(s ORDER BY i) FROM (VALUES (v_r2, 'rejected'), (v_r3, 'withdrawn'),
                                                      (v_r4, 'requested'), (v_set2, 'withdrawn')) AS w(i, s)) THEN
        RAISE EXCEPTION '(g) expected 7 rows with r2 rejected, r3 withdrawn, r4 requested and set2 withdrawn; read %', v_n;
    END IF;
    RAISE NOTICE 'lighting overrides: a reader selecting approved overrides through RLS got exactly the 3 approved of 7 rows; 1 requested, 1 rejected and 2 withdrawn left out';

    -- ---- (h) every write produced its audit row ---------------------------
    SELECT count(*) INTO v_audited
      FROM (VALUES (v_r1, 'practice_lighting_override.requested'),
                   (v_self, 'practice_lighting_override.requested'),
                   (v_r2, 'practice_lighting_override.requested'),
                   (v_r3, 'practice_lighting_override.requested'),
                   (v_r4, 'practice_lighting_override.requested'),
                   (v_self, 'practice_lighting_override.approved'),
                   (v_r1, 'practice_lighting_override.approved'),
                   (v_r2, 'practice_lighting_override.rejected'),
                   (v_r3, 'practice_lighting_override.withdrawn'),
                   (v_set2, 'practice_lighting_override.withdrawn'),
                   (v_set1, 'practice_lighting_override.set'),
                   (v_set2, 'practice_lighting_override.set')) AS w(id, action)
     WHERE (SELECT count(*) FROM public.audit_log l
             WHERE l.organization_id = v_org AND l.resource_id = w.id AND l.action = w.action) = 1;
    IF v_audited <> 12 THEN
        RAISE EXCEPTION '(h) only % of the 12 writes left exactly one audit row naming their row', v_audited;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_log
                    WHERE resource_id = v_r1 AND action = 'practice_lighting_override.approved'
                      AND user_id = v_admin2
                      AND metadata->>'practice_slot_id' = v_slot1::text
                      AND metadata->>'from' = '2026-10-01' AND metadata->>'until' = '2026-10-15'
                      AND metadata->>'before_status' = 'requested'
                      AND (metadata->>'requested_by')::uuid = v_ua) THEN
        RAISE EXCEPTION '(h) the approval''s audit row does not carry the slot, the inclusive window, the before-status and the requester';
    END IF;
    RAISE NOTICE 'lighting overrides: every write audited -- 12 of 12 (5 requested, 2 approved, 1 rejected, 2 withdrawn, 2 set), each naming its row';

    -- ---- (i) RLS: a coach reads the rows of their slots; admins read all ---
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', v_ua::text, true);
    SELECT count(*) FILTER (WHERE practice_slot_id = v_slot1), count(*) FILTER (WHERE practice_slot_id <> v_slot1)
      INTO v_s1_rows, v_other FROM public.practice_lighting_overrides;
    IF v_s1_rows <> 5 OR v_other <> 0 THEN
        RESET ROLE;
        RAISE EXCEPTION '(i) coach A read % slot-1 and % other row(s); expected 5 and 0', v_s1_rows, v_other;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_ub::text, true);
    SELECT count(*) FILTER (WHERE practice_slot_id = v_slot2), count(*) FILTER (WHERE practice_slot_id <> v_slot2)
      INTO v_s2_rows, v_other FROM public.practice_lighting_overrides;
    IF v_s2_rows <> 2 OR v_other <> 0 THEN
        RESET ROLE;
        RAISE EXCEPTION '(i) coach B read % slot-2 and % other row(s); expected 2 and 0', v_s2_rows, v_other;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_uc::text, true);
    SELECT count(*) INTO v_n FROM public.practice_lighting_overrides;
    IF v_n <> 0 THEN
        RESET ROLE;
        RAISE EXCEPTION '(i) the lapsed coach C read % row(s)', v_n;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_parent::text, true);
    SELECT count(*) INTO v_n FROM public.practice_lighting_overrides;
    IF v_n <> 0 THEN
        RESET ROLE;
        RAISE EXCEPTION '(i) a parent member read % row(s)', v_n;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_admin2::text, true);
    SELECT count(*) INTO v_n FROM public.practice_lighting_overrides;
    IF v_n <> 7 THEN
        RESET ROLE;
        RAISE EXCEPTION '(i) the second admin read % of the organisation''s 7 row(s)', v_n;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_outsider::text, true);
    SELECT count(*) INTO v_n FROM public.practice_lighting_overrides;
    RESET ROLE;
    IF v_n <> 0 THEN
        RAISE EXCEPTION '(i) an admin of another organisation read % row(s)', v_n;
    END IF;
    RAISE NOTICE 'lighting overrides: coach A read the 5 rows of slot 1 and none of slot 2; coach B the 2 of slot 2 and none of slot 1; a lapsed coach and a parent 0; the admin 7 of 7; another organisation''s admin 0';

    -- ---- (j) malformed windows and kinds are refused ----------------------
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_refused := 0;
    BEGIN PERFORM public.request_practice_lighting_override(v_slot1, '2026-11-20', '2026-11-19');
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    BEGIN PERFORM public.admin_set_practice_lighting_override(v_slot1, '2026-11-20', '2026-11-19');
    EXCEPTION WHEN invalid_parameter_value THEN v_refused := v_refused + 1; END;
    BEGIN
        INSERT INTO public.practice_lighting_overrides (organization_id, practice_slot_id, "window", kind, requested_by)
        VALUES (v_org, v_slot1, '[2026-11-20,2026-11-21)', 'floodlights', v_admin);
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1; END;
    BEGIN
        INSERT INTO public.practice_lighting_overrides (organization_id, practice_slot_id, "window", requested_by)
        VALUES (v_org, v_slot1, '[2026-11-20,)', v_admin);
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1; END;
    BEGIN
        INSERT INTO public.practice_lighting_overrides (organization_id, practice_slot_id, "window", status, requested_by)
        VALUES (v_org, v_slot1, '[2026-11-20,2026-11-21)', 'approved', v_admin);
    EXCEPTION WHEN check_violation THEN v_refused := v_refused + 1; END;
    IF v_refused <> 5 THEN
        RAISE EXCEPTION '(j) only % of 5 malformed writes were refused', v_refused;
    END IF;
    -- The positive control: a one-day window is accepted.
    PERFORM public.request_practice_lighting_override(v_slot1, '2026-11-20', '2026-11-20');
    RAISE NOTICE 'lighting overrides: 5 of 5 malformed writes refused (until before from, twice; an unknown kind; an unbounded window; an approval with no decider); a one-day window accepted';
END;
$$;

ROLLBACK;
