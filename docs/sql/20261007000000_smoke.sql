-- Smoke checks for 20261007000000_enact_practice_recommendation_blackout.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined,
-- and `scripts/dbharness/run.sh` requires each witness NOTICE to print.
-- `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, so every enact runs the REAL wrapper and the REAL
-- writer as a real org admin with RLS on: both are SECURITY INVOKER.
--
-- docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md §5, the witnesses assigned to
-- 11d-2 (the SQL arms):
--   B8   only a saved blackout, as saved: no row, each of its 7 stored
--        columns changed, a record claiming another stored row, surface_ids
--        other than its ground, a window outside its dates, and a series on
--        ground it does not close, each refused 22023 with nothing written
--   B9   one exception on S and nothing else: S unlocked, S re-sent changed,
--        a new row, two exceptions, and an exception of another window,
--        cause, slot or kind, each refused 22023 and rolled back; the
--        relocation enacted writes exactly one exception, every pre-enact row
--        (S included) unchanged
--   B10  the audit is atomic: with its audit insert made to fail (a trigger;
--        the action cannot be unregistered once rows use it) the blackout
--        enact fails at its audit row and the exception goes with it
--   B11  a blackout edit racing an enact waits: a second session's
--        admin_update_field_blackout times out (55P03) while the enact's
--        transaction is open, and succeeds once it commits. The retirement
--        arm's Q10 lock is witnessed the same way on `fields`.
-- plus a TIME TBD blackout enact, an idempotent repeat, and the premise of
-- the FOR SHARE helper (an invoker FOR SHARE reads no row).
--
-- B11 needs a second session, so this smoke uses `dblink` (contrib, in the
-- harness's PostgreSQL image) and drops it at the end. Its fixture is
-- therefore COMMITTED (the second session must see it); every name and id is
-- synthetic, under the org "Smoke Org E12".
--
-- Every subject set is enumerated from the fixture this file seeds or from
-- the payloads it SENT, never from what a call wrote back.

\set ON_ERROR_STOP on

-- ---- helpers (session-local) ---------------------------------------------
-- What "nothing written" is measured against: the org's rows, its
-- exceptions and its audit rows, as the owner sees them.
CREATE FUNCTION pg_temp.e12_digest(p_org uuid) RETURNS text LANGUAGE sql AS $$
    SELECT md5(
        COALESCE((SELECT string_agg(pa.id || '|' || pa.team_id || '|' || pa.practice_slot_id || '|'
                                    || pa.effective_date_range::text || '|' || pa.source::text || '|'
                                    || pa.assigned_via, ',' ORDER BY pa.id)
                    FROM public.practice_assignments pa WHERE pa.organization_id = p_org), '')
        || '#' || COALESCE((SELECT string_agg(pe.id || '|' || pe."window"::text || '|' || COALESCE(pe.withdrawn_at::text, ''),
                                              ',' ORDER BY pe.id)
                              FROM public.practice_exceptions pe WHERE pe.organization_id = p_org), '')
        || '/' || (SELECT count(*) FROM public.audit_log al WHERE al.organization_id = p_org)::text);
$$;

-- Every org row re-sent unchanged, but `p_except` (kept by id by `closes`).
CREATE FUNCTION pg_temp.e12_assign(p_org uuid, p_except uuid) RETURNS jsonb LANGUAGE sql AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'team_id', pa.team_id, 'practice_slot_id', pa.practice_slot_id,
               'effective_date_range', pa.effective_date_range::text, 'source', pa.source::text)
               ORDER BY pa.id), '[]'::jsonb)
      FROM public.practice_assignments pa
     WHERE pa.organization_id = p_org
       AND pa.id IS DISTINCT FROM p_except;
$$;

-- The season fingerprint, read as the admin.
CREATE FUNCTION pg_temp.e12_fp(p_season uuid, p_admin uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', p_admin::text, true);
    SET LOCAL ROLE authenticated;
    v := public.practice_schedule_fingerprint(p_season);
    RESET ROLE;
    IF v !~ '^[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'the season fingerprint was not read: %', v;
    END IF;
    RETURN v;
END;
$$;

-- One enact as the admin: {ok, res} or {ok: false, state, msg}. A failure
-- rolls back its own subtransaction, so it writes nothing.
CREATE FUNCTION pg_temp.e12_enact(p_admin uuid, p_run jsonb, p_assign jsonb, p_unlock jsonb,
                                  p_closes jsonb, p_exc jsonb, p_fp text, p_rec jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
    v_res jsonb; v_state text; v_msg text;
BEGIN
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', p_admin::text, true);
    BEGIN
        SET LOCAL ROLE authenticated;
        v_res := public.enact_practice_recommendation(p_run, p_assign, p_unlock, p_closes, p_exc, p_fp, p_rec);
        RESET ROLE;
        RETURN jsonb_build_object('ok', true, 'res', v_res);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    RESET ROLE;
    RETURN jsonb_build_object('ok', false, 'state', v_state, 'msg', v_msg);
END;
$$;

-- A blackout enact record (plan §2.3), as core buildEnactRecord emits it.
CREATE FUNCTION pg_temp.e12_record(p_key uuid, p_season uuid, p_fp text, p_cause jsonb, p_series jsonb,
                                   p_decision jsonb, p_prompt_rows jsonb, p_unlock jsonb, p_writes jsonb)
RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'schema_version', 1,
        'enact_key', p_key, 'run_id', p_key, 'season_settings_id', p_season,
        'cause', p_cause, 'series', p_series, 'decision', p_decision,
        'rejudge', jsonb_build_object('stands', true, 'shown_counts', p_decision->'objective'->'counts'),
        'declined', '[]'::jsonb, 'chains', '[]'::jsonb, 'local', false, 'enacted_before', '[]'::jsonb,
        'prompt', jsonb_build_object('rows', p_prompt_rows, 'published_practices_affected', 1, 'accepted', true),
        'unlock', p_unlock, 'writes', p_writes,
        'base_fingerprint', p_fp, 'result_fingerprint', NULL,
        'fingerprint_covers', 'practice_assignments+practice_exceptions',
        'solver', jsonb_build_object('strategy', 'exact', 'proven_optimal', true,
                                     'daylight_supplied', true, 'closures_supplied', true));
$$;

CREATE TEMP TABLE e12_ids (name text PRIMARY KEY, id uuid NOT NULL);

-- ---- the fixture (as the table owner), COMMITTED for the second session ----
DO $$
DECLARE
    c_admin constant uuid := 'e1200000-0000-4000-8000-0000000000a1';
    v_org uuid; v_loc uuid; v_loc2 uuid; v_f1 uuid; v_f2 uuid; v_f3 uuid; v_s uuid; v_div uuid;
    v_t1 uuid; v_t2 uuid; v_t3 uuid; v_tue1 uuid; v_wed1 uuid; v_thu2 uuid; v_fri3 uuid;
    v_sa uuid; v_oa uuid; v_ra uuid; v_b uuid;
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      (c_admin, 'e12-admin@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES (c_admin, 'e12-admin@example.test') ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org E12', 'smoke-org-e12') RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES (v_org, c_admin, 'admin');
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'E12 Park') RETURNING id INTO v_loc;
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'E12 Common') RETURNING id INTO v_loc2;
    -- F1 and F2 at one park; the blackout closes F1. F3, elsewhere, retires.
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'E12 Pitch 1', true) RETURNING id INTO v_f1;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc, 'E12 Pitch 2', true) RETURNING id INTO v_f2;
    INSERT INTO public.fields (organization_id, location_id, name, active)
      VALUES (v_org, v_loc2, 'E12 Pitch 3', true) RETURNING id INTO v_f3;
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'E12 Fall') RETURNING id INTO v_s;
    INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES (v_org, v_s, 'E12 U12') RETURNING id INTO v_div;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div, 'E12 Team 1') RETURNING id INTO v_t1;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div, 'E12 Team 2') RETURNING id INTO v_t2;
    INSERT INTO public.teams (organization_id, division_id, name) VALUES (v_org, v_div, 'E12 Team 3') RETURNING id INTO v_t3;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_f1, 'tue', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_tue1;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_f1, 'wed', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_wed1;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_f2, 'thu', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_thu2;
    INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_from, valid_until)
      VALUES (v_org, v_f3, 'fri', '18:00', '19:30', '2026-09-01', '2026-11-30') RETURNING id INTO v_fri3;
    -- S (Team 1, Tuesday, F1) and O (Team 2, Wednesday, F1) are displaced by
    -- the blackout; R (Team 3, Friday, F3) by the retirement of F3.
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t1, v_tue1, '[2026-09-01,2026-11-30]', 'auto') RETURNING id INTO v_sa;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t2, v_wed1, '[2026-09-01,2026-11-30]', 'auto') RETURNING id INTO v_oa;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, effective_date_range, source)
      VALUES (v_org, v_t3, v_fri3, '[2026-09-01,2026-11-30]', 'auto') RETURNING id INTO v_ra;
    -- A partial-day blackout of F1, saved: Tue 2026-10-20 to Mon 2026-10-26, 17:30-19:30.
    INSERT INTO public.field_blackouts (organization_id, field_id, blackout_from, blackout_until,
                                        start_minutes, end_minutes, reason)
      VALUES (v_org, v_f1, '2026-10-20', '2026-10-26', 1050, 1170, 'maintenance') RETURNING id INTO v_b;
    -- F3's retirement is committed: its last day is 2026-10-14.
    UPDATE public.fields SET effective_to = '2026-10-14' WHERE id = v_f3;
    INSERT INTO e12_ids (name, id) VALUES
      ('admin', c_admin), ('org', v_org), ('loc', v_loc), ('f1', v_f1), ('f2', v_f2), ('f3', v_f3),
      ('season', v_s), ('t1', v_t1), ('t2', v_t2), ('t3', v_t3), ('tue1', v_tue1), ('wed1', v_wed1),
      ('thu2', v_thu2), ('fri3', v_fri3), ('s', v_sa), ('o', v_oa), ('r', v_ra), ('b', v_b);
END;
$$;

-- ---- B8, B9, B10 and the relocation enact ----------------------------------
DO $$
DECLARE
    c_k0 constant uuid := 'e1200000-0000-4000-8000-00000000e000';
    c_k1 constant uuid := 'e1200000-0000-4000-8000-00000000e001';
    c_ka constant uuid := 'e1200000-0000-4000-8000-00000000e00a';
    v_admin uuid; v_org uuid; v_loc uuid; v_f1 uuid; v_f2 uuid; v_f3 uuid; v_s uuid;
    v_t1 uuid; v_t3 uuid; v_tue1 uuid; v_wed1 uuid; v_thu2 uuid; v_sa uuid; v_ra uuid; v_b uuid;
    v_fp text; v_run jsonb; v_cause jsonb; v_series jsonb; v_decision jsonb; v_rows jsonb;
    v_writes jsonb; v_exc jsonb; v_rec jsonb; v_out jsonb; v_assign jsonb;
    v_digest text; v_n int; v_case record; v_pre jsonb; v_audit jsonb; v_state text;
    v_plain int; v_share int; v_plain_f int; v_share_f int;
BEGIN
    SELECT id INTO v_admin FROM e12_ids WHERE name = 'admin';
    SELECT id INTO v_org FROM e12_ids WHERE name = 'org';
    SELECT id INTO v_loc FROM e12_ids WHERE name = 'loc';
    SELECT id INTO v_f1 FROM e12_ids WHERE name = 'f1';
    SELECT id INTO v_f2 FROM e12_ids WHERE name = 'f2';
    SELECT id INTO v_f3 FROM e12_ids WHERE name = 'f3';
    SELECT id INTO v_s FROM e12_ids WHERE name = 'season';
    SELECT id INTO v_t1 FROM e12_ids WHERE name = 't1';
    SELECT id INTO v_tue1 FROM e12_ids WHERE name = 'tue1';
    SELECT id INTO v_wed1 FROM e12_ids WHERE name = 'wed1';
    SELECT id INTO v_thu2 FROM e12_ids WHERE name = 'thu2';
    SELECT id INTO v_sa FROM e12_ids WHERE name = 's';
    SELECT id INTO v_t3 FROM e12_ids WHERE name = 't3';
    SELECT id INTO v_ra FROM e12_ids WHERE name = 'r';
    SELECT id INTO v_b FROM e12_ids WHERE name = 'b';

    -- ---- the premise of the helper ----------------------------------------
    -- As the admin, the rows are readable, but a FOR SHARE read returns none:
    -- neither table has an UPDATE policy, and PostgreSQL applies UPDATE
    -- policies to the rows a FOR SHARE locks.
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_plain FROM public.field_blackouts fb WHERE fb.id = v_b;
    SELECT count(*) INTO v_plain_f FROM public.fields f WHERE f.id = v_f3;
    -- A refusal (no UPDATE privilege) is the same answer: unusable as the caller.
    BEGIN
        SELECT count(*) INTO v_share FROM (SELECT 1 FROM public.field_blackouts fb WHERE fb.id = v_b FOR SHARE) x;
    EXCEPTION WHEN insufficient_privilege THEN v_share := -1;
    END;
    BEGIN
        SELECT count(*) INTO v_share_f FROM (SELECT 1 FROM public.fields f WHERE f.id = v_f3 FOR SHARE) x;
    EXCEPTION WHEN insufficient_privilege THEN v_share_f := -1;
    END;
    RESET ROLE;
    IF v_plain <> 1 OR v_plain_f <> 1 OR v_share > 0 OR v_share_f > 0 THEN
        RAISE EXCEPTION 'the FOR SHARE premise does not hold: as the admin a plain read saw % blackout(s) and % field(s), FOR SHARE % and % (expected 1, 1, then 0 or refused): revisit enact_lock_cause_row', v_plain, v_plain_f, v_share, v_share_f;
    END IF;
    RAISE NOTICE 'premise: as the admin a plain read sees the blackout and the field (1 of 1 each) and a FOR SHARE read locks neither (% and %; -1 is refused), so the Q10 lock is taken by enact_lock_cause_row', v_share, v_share_f;

    -- ---- the relocation of S, as the panel would send it --------------------
    v_cause := jsonb_build_object('kind', 'blackout', 'id', v_b,
        'loss', jsonb_build_object('from', '2026-10-20', 'until', '2026-10-26', 'surface_ids', jsonb_build_array(v_f1),
                                   'start_minutes', 1050, 'end_minutes', 1170, 'reason', 'maintenance'),
        'stored', jsonb_build_object('field_id', v_f1, 'location_id', NULL, 'blackout_from', '2026-10-20',
                                     'blackout_until', '2026-10-26', 'start_minutes', 1050, 'end_minutes', 1170,
                                     'reason', 'maintenance'));
    v_series := jsonb_build_object('assignment_id', v_sa, 'team_id', v_t1,
        'from', jsonb_build_object('surface_id', v_f1, 'weekday', 'TUE', 'start_minutes', 1080, 'duration_minutes', 90),
        'window', jsonb_build_object('from', '2026-10-20', 'until', '2026-10-26'));
    v_decision := jsonb_build_object('kind', 'relocate',
        'to', jsonb_build_object('surface_id', v_f2, 'weekday', 'THU', 'start_minutes', 1080, 'duration_minutes', 90),
        'tier', 'same-venue', 'origin', NULL, 'tbd_reason', NULL,
        'objective', jsonb_build_object('total', 1, 'counts', jsonb_build_object('changedWeekday', 1)),
        'coach_overlaps', '[]'::jsonb, 'coach_days_worsened', 0);
    v_rows := jsonb_build_array(jsonb_build_object('assignment_id', v_sa, 'assigned_via', 'auto',
        'effect', 'temporarily moved', 'range_after', NULL, 'window', '[2026-10-20,2026-10-26]'));
    v_writes := jsonb_build_object('closes', '[]'::jsonb, 'new_rows', '[]'::jsonb, 'exceptions', 1);
    v_exc := jsonb_build_array(jsonb_build_object('assignment_id', v_sa, 'window', '[2026-10-20,2026-10-26]',
        'kind', 'relocated', 'practice_slot_id', v_thu2, 'cause_kind', 'blackout', 'cause_id', v_b));
    v_run := jsonb_build_object('id', c_k0, 'run_type', 'practice', 'status', 'completed',
                                'season_settings_id', v_s, 'parameters', '{}'::jsonb);
    v_fp := pg_temp.e12_fp(v_s, v_admin);
    v_assign := pg_temp.e12_assign(v_org, NULL);
    v_rec := pg_temp.e12_record(c_k0, v_s, v_fp, v_cause, v_series, v_decision, v_rows, '[]'::jsonb, v_writes);
    v_digest := pg_temp.e12_digest(v_org);

    -- ---- B8. only a saved blackout, as saved --------------------------------
    v_n := 0;
    -- No row of that id.
    v_out := pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb, v_exc, v_fp,
        jsonb_set(v_rec, '{cause,id}', '"e1200000-0000-4000-8000-0000000009ff"'::jsonb));
    IF v_out->>'state' = '22023' AND v_out->>'msg' LIKE '%is not saved%' THEN v_n := v_n + 1; END IF;
    -- Each of the seven stored columns changed, one at a time, then restored.
    FOR v_case IN SELECT * FROM (VALUES
            ('field_id', 'UPDATE public.field_blackouts SET field_id = %L WHERE id = %L'),
            ('scope', 'UPDATE public.field_blackouts SET field_id = NULL, location_id = %L WHERE id = %L'),
            ('blackout_from', 'UPDATE public.field_blackouts SET blackout_from = %L WHERE id = %L'),
            ('blackout_until', 'UPDATE public.field_blackouts SET blackout_until = %L WHERE id = %L'),
            ('minutes', 'UPDATE public.field_blackouts SET start_minutes = NULL, end_minutes = NULL WHERE id = %L'),
            ('end_minutes', 'UPDATE public.field_blackouts SET end_minutes = %L WHERE id = %L'),
            ('reason', 'UPDATE public.field_blackouts SET reason = %L WHERE id = %L')) AS c(col, sql) LOOP
        CASE v_case.col
            WHEN 'field_id' THEN EXECUTE format(v_case.sql, v_f2, v_b);
            WHEN 'scope' THEN EXECUTE format(v_case.sql, v_loc, v_b);
            WHEN 'blackout_from' THEN EXECUTE format(v_case.sql, '2026-10-19', v_b);
            WHEN 'blackout_until' THEN EXECUTE format(v_case.sql, '2026-10-27', v_b);
            WHEN 'minutes' THEN EXECUTE format(v_case.sql, v_b);
            WHEN 'end_minutes' THEN EXECUTE format(v_case.sql, 1140, v_b);
            ELSE EXECUTE format(v_case.sql, 'weather', v_b);
        END CASE;
        v_out := pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb, v_exc, v_fp, v_rec);
        IF v_out->>'state' = '22023' AND v_out->>'msg' LIKE '%blackout % changed%' THEN v_n := v_n + 1; END IF;
        UPDATE public.field_blackouts
           SET field_id = v_f1, location_id = NULL, blackout_from = '2026-10-20', blackout_until = '2026-10-26',
               start_minutes = 1050, end_minutes = 1170, reason = 'maintenance'
         WHERE id = v_b;
    END LOOP;
    -- The row as saved, the record claiming another stored row.
    v_out := pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb, v_exc, v_fp,
        jsonb_set(v_rec, '{cause,stored,reason}', '"weather"'::jsonb));
    IF v_out->>'state' = '22023' AND v_out->>'msg' LIKE '%blackout % changed%' THEN v_n := v_n + 1; END IF;
    -- The row as saved, surface_ids other than its ground.
    v_out := pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb, v_exc, v_fp,
        jsonb_set(v_rec, '{cause,loss,surface_ids}', jsonb_build_array(v_f2)));
    IF v_out->>'state' = '22023' AND v_out->>'msg' LIKE '%loss.surface_ids%' THEN v_n := v_n + 1; END IF;
    -- The record consistent with itself, its window outside the blackout's dates.
    v_out := pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb,
        jsonb_set(v_exc, '{0,window}', '"[2026-11-03,2026-11-09]"'::jsonb), v_fp,
        jsonb_set(v_rec, '{series,window}', jsonb_build_object('from', '2026-11-03', 'until', '2026-11-09')));
    IF v_out->>'state' = '22023' AND v_out->>'msg' LIKE '%is outside blackout%' THEN v_n := v_n + 1; END IF;
    -- A series on ground the blackout does not close: R, on F3.
    v_out := pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb,
        jsonb_set(v_exc, '{0,assignment_id}', to_jsonb(v_ra::text)), v_fp,
        jsonb_set(jsonb_set(v_rec, '{series,assignment_id}', to_jsonb(v_ra::text)),
                  '{series,team_id}', to_jsonb(v_t3::text)));
    IF v_out->>'state' = '22023' AND v_out->>'msg' LIKE '%is outside blackout%' THEN v_n := v_n + 1; END IF;
    IF v_n <> 12 OR pg_temp.e12_digest(v_org) <> v_digest THEN
        RAISE EXCEPTION 'expected an unsaved blackout, each of its 7 stored columns changed, a record claiming another stored row, surface_ids other than its ground, a window outside its dates and a series on other ground each refused 22023, writing nothing; got % of 12 (last: %)', v_n, v_out;
    END IF;
    RAISE NOTICE 'blackout commit gate: an unsaved blackout, each of its 7 stored columns changed, a record claiming another stored row, surface_ids other than its ground, a window outside its dates and a series on other ground were each refused 22023, 12 of 12; 0 rows, 0 exceptions and 0 audit rows changed';

    -- ---- B9. one exception on S, and nothing else ---------------------------
    v_n := 0;
    FOR v_case IN SELECT * FROM (VALUES
            ('unlocked', '%closed, unlocked or replaced a row%'),
            ('s re-sent changed', '%changed other rows: %'),
            ('a new row', '%created 1 row(s)%'),
            ('two exceptions', '%recorded 2 exception(s)%'),
            ('another window', '%not the one its record declares%'),
            ('another cause', '%not the one its record declares%'),
            ('another slot', '%not the one its record declares%'),
            ('another kind', '%not the one its record declares%')) AS c(name, needle) LOOP
        v_out := CASE v_case.name
            WHEN 'unlocked' THEN pg_temp.e12_enact(v_admin, v_run, v_assign,
                jsonb_build_array(jsonb_build_object('assignment_id', v_sa, 'reason', 'enact ' || c_k0 || ': retirement of field ' || v_f1 || ' from 2026-10-20')),
                '[]'::jsonb, v_exc, v_fp,
                jsonb_set(v_rec, '{unlock}', jsonb_build_array(jsonb_build_object('assignment_id', v_sa,
                    'reason', 'enact ' || c_k0 || ': retirement of field ' || v_f1 || ' from 2026-10-20'))))
            WHEN 's re-sent changed' THEN pg_temp.e12_enact(v_admin, v_run,
                (SELECT jsonb_agg(CASE WHEN a.value->>'practice_slot_id' = v_tue1::text
                                       THEN jsonb_set(a.value, '{source}', '"manual"'::jsonb) ELSE a.value END)
                   FROM jsonb_array_elements(v_assign) a),
                '[]'::jsonb, '[]'::jsonb, v_exc, v_fp, v_rec)
            WHEN 'a new row' THEN pg_temp.e12_enact(v_admin, v_run,
                v_assign || jsonb_build_array(jsonb_build_object('team_id', v_t1, 'practice_slot_id', v_thu2,
                    'effective_date_range', '[2026-10-20,2026-10-26]', 'source', 'auto', 'assigned_via', 'recommendation')),
                '[]'::jsonb, '[]'::jsonb, v_exc, v_fp, v_rec)
            WHEN 'two exceptions' THEN pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb,
                v_exc || jsonb_build_array(jsonb_build_object('assignment_id', v_sa, 'window', '[2026-11-03,2026-11-03]',
                    'kind', 'time_tbd', 'tbd_reason', 'contended', 'cause_kind', 'blackout', 'cause_id', v_b)),
                v_fp, jsonb_set(v_rec, '{writes,exceptions}', '2'::jsonb))
            WHEN 'another window' THEN pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb,
                jsonb_set(v_exc, '{0,window}', '"[2026-10-20,2026-10-25]"'::jsonb), v_fp, v_rec)
            WHEN 'another cause' THEN pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb,
                jsonb_set(v_exc, '{0,cause_id}', '"e1200000-0000-4000-8000-0000000009fe"'::jsonb), v_fp, v_rec)
            WHEN 'another slot' THEN pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb,
                jsonb_set(v_exc, '{0,practice_slot_id}', to_jsonb(v_wed1::text)), v_fp, v_rec)
            ELSE pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb,
                jsonb_build_array((v_exc->0) - 'practice_slot_id' || jsonb_build_object('kind', 'time_tbd', 'tbd_reason', 'contended')),
                v_fp, v_rec)
        END;
        IF v_out->>'state' = '22023' AND v_out->>'msg' LIKE v_case.needle THEN
            v_n := v_n + 1;
        ELSE
            RAISE NOTICE 'B9 case % was not refused as expected: %', v_case.name, v_out;
        END IF;
    END LOOP;
    IF v_n <> 8 OR pg_temp.e12_digest(v_org) <> v_digest THEN
        RAISE EXCEPTION 'expected S unlocked, S re-sent changed, a new row, two exceptions and an exception of another window, cause, slot or kind each refused 22023 and rolled back; got % of 8', v_n;
    END IF;
    RAISE NOTICE 'one exception on S: an unlock of S, S re-sent changed, a new row, two exceptions, and one exception of another window, cause, slot or kind were each refused 22023, 8 of 8, and rolled back; 0 rows, 0 exceptions and 0 audit rows changed';

    -- ---- B10. the audit is atomic ---------------------------------------------
    -- The action cannot be unregistered here (20261004000000's smoke has
    -- written rows under it), so the enact's audit insert is made to fail by
    -- a trigger, dropped at once.
    CREATE FUNCTION public.e12_smoke_fail_enact_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
        IF NEW.action = 'practice.recommendation_enacted' THEN
            RAISE EXCEPTION 'e12 smoke: the enact audit insert fails' USING ERRCODE = '23503';
        END IF;
        RETURN NEW;
    END;
    $f$;
    CREATE TRIGGER e12_smoke_fail_enact_audit BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.e12_smoke_fail_enact_audit();
    v_out := pg_temp.e12_enact(v_admin, jsonb_set(v_run, '{id}', to_jsonb(c_ka::text)), v_assign, '[]'::jsonb,
        '[]'::jsonb, v_exc, v_fp,
        jsonb_set(jsonb_set(v_rec, '{enact_key}', to_jsonb(c_ka::text)), '{run_id}', to_jsonb(c_ka::text)));
    DROP TRIGGER e12_smoke_fail_enact_audit ON public.audit_log;
    DROP FUNCTION public.e12_smoke_fail_enact_audit();
    IF v_out->>'ok' <> 'false' OR v_out->>'state' IS DISTINCT FROM '23503'
       OR EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.organization_id = v_org)
       OR pg_temp.e12_digest(v_org) <> v_digest THEN
        RAISE EXCEPTION 'with its audit insert failing the blackout enact did not fail at its audit row with nothing written: %', v_out;
    END IF;
    RAISE NOTICE 'blackout audit atomicity: with its practice.recommendation_enacted insert failing, the blackout enact itself failed 23503 at its audit row, and 0 exceptions were written';

    -- ---- B9. the relocation, enacted ------------------------------------------
    SELECT jsonb_agg(jsonb_build_object('id', pa.id, 'team_id', pa.team_id, 'slot', pa.practice_slot_id,
                                        'range', pa.effective_date_range::text, 'source', pa.source::text,
                                        'via', pa.assigned_via) ORDER BY pa.id)
      INTO v_pre FROM public.practice_assignments pa WHERE pa.organization_id = v_org;
    IF jsonb_array_length(v_pre) <> 3 THEN
        RAISE EXCEPTION 'the pre-enact snapshot holds % rows, not the fixture''s 3', jsonb_array_length(v_pre);
    END IF;
    v_run := jsonb_set(v_run, '{id}', to_jsonb(c_k1::text));
    v_rec := jsonb_set(jsonb_set(v_rec, '{enact_key}', to_jsonb(c_k1::text)), '{run_id}', to_jsonb(c_k1::text));
    v_out := pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb, v_exc, v_fp, v_rec);
    IF v_out->>'ok' <> 'true' OR v_out->'res'->'enact_audited' IS DISTINCT FROM 'true'::jsonb THEN
        RAISE EXCEPTION 'the relocation enact of S was refused: %', v_out;
    END IF;
    v_n := 0;
    FOR v_case IN SELECT e.value AS r FROM jsonb_array_elements(v_pre) e LOOP
        IF NOT EXISTS (SELECT 1 FROM public.practice_assignments pa
                        WHERE pa.id = (v_case.r->>'id')::uuid
                          AND pa.team_id = (v_case.r->>'team_id')::uuid
                          AND pa.practice_slot_id = (v_case.r->>'slot')::uuid
                          AND pa.effective_date_range::text = v_case.r->>'range'
                          AND pa.source::text = v_case.r->>'source'
                          AND pa.assigned_via = v_case.r->>'via') THEN
            RAISE EXCEPTION 'pre-enact row % changed although a blackout enact changes no row', v_case.r;
        END IF;
        v_n := v_n + 1;
    END LOOP;
    IF v_n <> 3
       OR (SELECT count(*) FROM public.practice_assignments pa WHERE pa.organization_id = v_org) <> 3
       OR (SELECT count(*) FROM public.practice_exceptions pe WHERE pe.organization_id = v_org) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe
                       WHERE pe.organization_id = v_org AND pe.assignment_id = v_sa
                         AND pe.cause_kind = 'blackout' AND pe.cause_id = v_b
                         AND pe."window" = '[2026-10-20,2026-10-26]'::daterange
                         AND pe.kind = 'relocated' AND pe.practice_slot_id = v_thu2
                         AND pe.withdrawn_at IS NULL) THEN
        RAISE EXCEPTION 'expected 3 unchanged rows, no new row and exactly 1 relocated exception on S (blackout, [2026-10-20,2026-10-26], Thursday F2); got % checked', v_n;
    END IF;
    RAISE NOTICE 'blackout only S: of 3 pre-enact rows all 3, S included, are unchanged in team, slot, range, source and assigned_via; 0 new rows; exactly 1 exception, on S, relocated to the Thursday slot over [2026-10-20,2026-10-26], cause blackout';

    SELECT al.metadata INTO v_audit FROM public.audit_log al
     WHERE al.organization_id = v_org AND al.action = 'practice.recommendation_enacted'
       AND al.resource_type = 'practice_assignment' AND al.resource_id = v_sa AND al.user_id = v_admin;
    IF (SELECT count(*) FROM public.audit_log al
         WHERE al.organization_id = v_org AND al.action = 'practice.recommendation_enacted') <> 1
       OR v_audit IS NULL
       OR (SELECT count(*) FROM jsonb_object_keys(v_audit)) <> 19
       OR v_audit->'cause'->'stored' IS DISTINCT FROM v_cause->'stored'
       OR v_audit->>'result_fingerprint' IS DISTINCT FROM v_out->'res'->>'fingerprint'
       OR v_audit->'unlock' IS DISTINCT FROM '[]'::jsonb
       OR EXISTS (SELECT 1 FROM public.audit_log al
                   WHERE al.organization_id = v_org AND al.action = 'practice.unlock_accepted') THEN
        RAISE EXCEPTION 'expected 1 practice.recommendation_enacted row on S with cause.stored as read, no unlock and no unlock_accepted row: %', v_audit;
    END IF;
    RAISE NOTICE 'blackout enact audit: 1 practice.recommendation_enacted row on S by the admin, its 19 keys, cause.stored as the gate read it, result_fingerprint equal to the writer''s; 0 practice.unlock_accepted rows';

    -- The double-click: the same key again is idempotent and writes nothing.
    v_digest := pg_temp.e12_digest(v_org);
    v_out := pg_temp.e12_enact(v_admin, v_run, v_assign, '[]'::jsonb, '[]'::jsonb, v_exc, v_fp, v_rec);
    IF v_out->'res'->'idempotent' IS DISTINCT FROM 'true'::jsonb OR pg_temp.e12_digest(v_org) <> v_digest THEN
        RAISE EXCEPTION 'a repeat of blackout enact % was not idempotent: %', c_k1, v_out;
    END IF;
    RAISE NOTICE 'blackout idempotency: the same enact key again returned idempotent: true and wrote nothing';
END;
$$;

-- ---- B11 and the Q10 retirement lock: a second session waits ----------------
CREATE EXTENSION IF NOT EXISTS dblink;

DO $$
DECLARE
    c_k2 constant uuid := 'e1200000-0000-4000-8000-00000000e002';
    c_k3 constant uuid := 'e1200000-0000-4000-8000-00000000e003';
    v_admin uuid; v_org uuid; v_f3 uuid; v_f2 uuid; v_s uuid; v_t2 uuid; v_t3 uuid; v_oa uuid; v_ra uuid; v_b uuid;
    v_fp text; v_out jsonb; v_exc jsonb; v_rec jsonb; v_unlock jsonb; v_closes jsonb;
    v_conn text; v_state text; v_msg text; v_blackout_wait text; v_field_wait text; v_control text;
BEGIN
    SELECT id INTO v_admin FROM e12_ids WHERE name = 'admin';
    SELECT id INTO v_org FROM e12_ids WHERE name = 'org';
    SELECT id INTO v_f2 FROM e12_ids WHERE name = 'f2';
    SELECT id INTO v_f3 FROM e12_ids WHERE name = 'f3';
    SELECT id INTO v_s FROM e12_ids WHERE name = 'season';
    SELECT id INTO v_t2 FROM e12_ids WHERE name = 't2';
    SELECT id INTO v_t3 FROM e12_ids WHERE name = 't3';
    SELECT id INTO v_oa FROM e12_ids WHERE name = 'o';
    SELECT id INTO v_ra FROM e12_ids WHERE name = 'r';
    SELECT id INTO v_b FROM e12_ids WHERE name = 'b';

    -- A TIME TBD blackout enact of O, left open in this transaction.
    v_fp := pg_temp.e12_fp(v_s, v_admin);
    v_exc := jsonb_build_array(jsonb_build_object('assignment_id', v_oa, 'window', '[2026-10-20,2026-10-26]',
        'kind', 'time_tbd', 'tbd_reason', 'contended', 'cause_kind', 'blackout', 'cause_id', v_b));
    v_rec := pg_temp.e12_record(c_k2, v_s, v_fp,
        jsonb_build_object('kind', 'blackout', 'id', v_b,
            'loss', jsonb_build_object('from', '2026-10-20', 'until', '2026-10-26',
                                       'surface_ids', (SELECT jsonb_build_array(id) FROM e12_ids WHERE name = 'f1'),
                                       'start_minutes', 1050, 'end_minutes', 1170, 'reason', 'maintenance'),
            'stored', jsonb_build_object('field_id', (SELECT id FROM e12_ids WHERE name = 'f1'), 'location_id', NULL,
                                         'blackout_from', '2026-10-20', 'blackout_until', '2026-10-26',
                                         'start_minutes', 1050, 'end_minutes', 1170, 'reason', 'maintenance')),
        jsonb_build_object('assignment_id', v_oa, 'team_id', v_t2,
            'from', jsonb_build_object('surface_id', (SELECT id FROM e12_ids WHERE name = 'f1'), 'weekday', 'WED',
                                       'start_minutes', 1080, 'duration_minutes', 90),
            'window', jsonb_build_object('from', '2026-10-20', 'until', '2026-10-26')),
        jsonb_build_object('kind', 'time_tbd', 'to', NULL, 'tier', NULL, 'origin', NULL, 'tbd_reason', 'contended',
            'objective', jsonb_build_object('total', 5, 'counts', jsonb_build_object('timeTbd', 1)),
            'coach_overlaps', '[]'::jsonb, 'coach_days_worsened', 0),
        jsonb_build_array(jsonb_build_object('assignment_id', v_oa, 'assigned_via', 'auto',
            'effect', 'temporarily TIME TBD', 'range_after', NULL, 'window', '[2026-10-20,2026-10-26]')),
        '[]'::jsonb, jsonb_build_object('closes', '[]'::jsonb, 'new_rows', '[]'::jsonb, 'exceptions', 1));
    v_out := pg_temp.e12_enact(v_admin,
        jsonb_build_object('id', c_k2, 'run_type', 'practice', 'status', 'completed', 'season_settings_id', v_s,
                           'parameters', '{}'::jsonb),
        pg_temp.e12_assign(v_org, NULL), '[]'::jsonb, '[]'::jsonb, v_exc, v_fp, v_rec);
    IF v_out->>'ok' <> 'true'
       OR NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe
                       WHERE pe.assignment_id = v_oa AND pe.kind = 'time_tbd' AND pe.tbd_reason = 'contended'
                         AND pe.cause_kind = 'blackout' AND pe.cause_id = v_b
                         AND pe."window" = '[2026-10-20,2026-10-26]'::daterange) THEN
        RAISE EXCEPTION 'the TIME TBD blackout enact of O was refused or wrote another exception: %', v_out;
    END IF;
    RAISE NOTICE 'time_tbd blackout enact: O keeps its row and gains 1 TIME TBD exception over [2026-10-20,2026-10-26], cause blackout';

    -- A retirement enact of R (F3 retired, last day 2026-10-14), left open too:
    -- R closed the day before, one tail TIME TBD exception.
    v_fp := pg_temp.e12_fp(v_s, v_admin);
    v_closes := jsonb_build_array(jsonb_build_object('assignment_id', v_ra, 'last_day', '2026-10-14'));
    v_unlock := jsonb_build_array(jsonb_build_object('assignment_id', v_ra,
        'reason', 'enact ' || c_k3 || ': retirement of field ' || v_f3 || ' from 2026-10-15'));
    v_exc := jsonb_build_array(jsonb_build_object('assignment_id', v_ra, 'window', '[2026-10-15,2026-11-30]',
        'kind', 'time_tbd', 'tbd_reason', 'no-legal-slot-at-venue', 'cause_kind', 'retirement', 'cause_id', v_f3));
    v_rec := pg_temp.e12_record(c_k3, v_s, v_fp,
        jsonb_build_object('kind', 'retirement', 'id', v_f3,
            'loss', jsonb_build_object('from', '2026-10-15', 'until', NULL, 'surface_ids', jsonb_build_array(v_f3),
                                       'start_minutes', NULL, 'end_minutes', NULL, 'reason', 'retirement'),
            'stored_effective_to', '2026-10-14'),
        jsonb_build_object('assignment_id', v_ra, 'team_id', v_t3,
            'from', jsonb_build_object('surface_id', v_f3, 'weekday', 'FRI', 'start_minutes', 1080, 'duration_minutes', 90),
            'window', jsonb_build_object('from', '2026-10-15', 'until', '2026-11-30')),
        jsonb_build_object('kind', 'time_tbd', 'to', NULL, 'tier', NULL, 'origin', NULL,
            'tbd_reason', 'no-legal-slot-at-venue',
            'objective', jsonb_build_object('total', 5, 'counts', jsonb_build_object('timeTbd', 1)),
            'coach_overlaps', '[]'::jsonb, 'coach_days_worsened', 0),
        jsonb_build_array(jsonb_build_object('assignment_id', v_ra, 'assigned_via', 'auto', 'effect', 'closed',
                                             'range_after', '[2026-09-01,2026-10-15)')),
        v_unlock, jsonb_build_object('closes', v_closes, 'new_rows', '[]'::jsonb, 'exceptions', 1));
    v_out := pg_temp.e12_enact(v_admin,
        jsonb_build_object('id', c_k3, 'run_type', 'practice', 'status', 'completed', 'season_settings_id', v_s,
                           'parameters', '{}'::jsonb),
        pg_temp.e12_assign(v_org, v_ra), v_unlock, v_closes, v_exc, v_fp, v_rec);
    IF v_out->>'ok' <> 'true' THEN
        RAISE EXCEPTION 'the retirement enact of R was refused: %', v_out;
    END IF;

    -- The second session: the admin edits the blackout, and an owner write
    -- touches F3, each with a 1s lock timeout, while both enacts are open.
    v_conn := 'e12_racer';
    PERFORM dblink_connect(v_conn, format('dbname=%s host=%s port=%s user=%s',
        current_database(), split_part(current_setting('unix_socket_directories'), ',', 1),
        current_setting('port'), current_user));
    PERFORM dblink_exec(v_conn, format('SET request.jwt.claim.sub = %L', v_admin));
    PERFORM dblink_exec(v_conn, 'SET lock_timeout = ''1s''');
    BEGIN
        -- dblink_exec runs commands only, so the RPC's SELECT goes through dblink().
        PERFORM * FROM dblink(v_conn, format(
            'SELECT public.admin_update_field_blackout(%L, %L, %L, %L, 1050, 1170, %L, NULL)::text',
            v_org, v_b, '2026-10-20', '2026-10-27', 'maintenance')) AS t(result text);
        v_blackout_wait := 'committed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_blackout_wait := v_state || ' ' || v_msg;
    END;
    BEGIN
        PERFORM dblink_exec(v_conn, format('UPDATE public.fields SET name = name WHERE id = %L', v_f3));
        v_field_wait := 'committed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_field_wait := v_state || ' ' || v_msg;
    END;
    -- The control: a row no enact holds is written at once by the same session.
    BEGIN
        PERFORM dblink_exec(v_conn, format('UPDATE public.fields SET name = name WHERE id = %L', v_f2));
        v_control := 'committed';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        v_control := v_state || ' ' || v_msg;
    END;
    PERFORM dblink_disconnect(v_conn);
    IF v_control <> 'committed' THEN
        RAISE EXCEPTION 'the second session could not write an unheld row, so its timeouts prove nothing: %', v_control;
    END IF;
    IF v_blackout_wait NOT LIKE '55P03 %' THEN
        RAISE EXCEPTION 'a blackout edit from a second session did not wait for the open blackout enact (expected 55P03 lock timeout): %', v_blackout_wait;
    END IF;
    RAISE NOTICE 'blackout race: while a blackout enact was open, a second session''s admin_update_field_blackout of its blackout timed out 55P03 on the FOR SHARE lock; the same session wrote an unheld row at once';
    IF v_field_wait NOT LIKE '55P03 %' THEN
        RAISE EXCEPTION 'a write of the retired field from a second session did not wait for the open retirement enact (expected 55P03 lock timeout): %', v_field_wait;
    END IF;
    RAISE NOTICE 'retirement race: while a retirement enact was open, a second session''s write of the retired field timed out 55P03 on the FOR SHARE lock';
END;
$$;

-- Both enacts committed: the same edit from a second session now goes through.
DO $$
DECLARE
    v_admin uuid; v_org uuid; v_b uuid; v_conn text := 'e12_after'; v_until date;
BEGIN
    SELECT id INTO v_admin FROM e12_ids WHERE name = 'admin';
    SELECT id INTO v_org FROM e12_ids WHERE name = 'org';
    SELECT id INTO v_b FROM e12_ids WHERE name = 'b';
    PERFORM dblink_connect(v_conn, format('dbname=%s host=%s port=%s user=%s',
        current_database(), split_part(current_setting('unix_socket_directories'), ',', 1),
        current_setting('port'), current_user));
    PERFORM dblink_exec(v_conn, format('SET request.jwt.claim.sub = %L', v_admin));
    PERFORM dblink_exec(v_conn, 'SET lock_timeout = ''1s''');
    PERFORM * FROM dblink(v_conn, format(
        'SELECT public.admin_update_field_blackout(%L, %L, %L, %L, 1050, 1170, %L, NULL)::text',
        v_org, v_b, '2026-10-20', '2026-10-27', 'maintenance')) AS t(result text);
    PERFORM dblink_disconnect(v_conn);
    SELECT blackout_until INTO v_until FROM public.field_blackouts WHERE id = v_b;
    IF v_until IS DISTINCT FROM '2026-10-27'::date THEN
        RAISE EXCEPTION 'after the enacts committed the second session''s blackout edit did not land: until %', v_until;
    END IF;
    -- Decision 6 (D7): the enacted exceptions stay live; the edit withdraws nothing.
    IF (SELECT count(*) FROM public.practice_exceptions pe
         WHERE pe.organization_id = v_org AND pe.cause_kind = 'blackout' AND pe.withdrawn_at IS NULL) <> 2 THEN
        RAISE EXCEPTION 'the blackout edit after the enacts changed the enacted exceptions';
    END IF;
    RAISE NOTICE 'after both enacts committed the same second-session blackout edit landed at once; the 2 enacted blackout exceptions stay live (D7)';
END;
$$;

DROP EXTENSION dblink;

-- ---------------------------------------------------------------------------
-- The helper's posture: SECURITY DEFINER with search_path=public, executable
-- by authenticated and service_role, not by anon or PUBLIC; the wrapper stays
-- SECURITY INVOKER with the writer's grants.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    c_lock constant text := 'public.enact_lock_cause_row(uuid, text, uuid)';
    c_sig constant text := 'public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb)';
BEGIN
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = c_lock::regprocedure)
       OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = c_lock::regprocedure) IS DISTINCT FROM ARRAY['search_path=public']
       OR has_function_privilege('anon', c_lock, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', c_lock, 'EXECUTE')
       OR NOT has_function_privilege('service_role', c_lock, 'EXECUTE')
       OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = c_sig::regprocedure)
       OR has_function_privilege('anon', c_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'enact_lock_cause_row must be SECURITY DEFINER (search_path=public) for authenticated and service_role only, and the wrapper SECURITY INVOKER without anon';
    END IF;
    RAISE NOTICE 'grants: enact_lock_cause_row is SECURITY DEFINER with search_path=public, executable by authenticated and service_role and not anon; the wrapper stays SECURITY INVOKER';
END;
$$;
