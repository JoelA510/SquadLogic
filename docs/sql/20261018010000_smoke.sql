-- Smoke checks for 20261018010000_reconcile_trigger_drift.sql
--
-- **These ASSERT rather than report**, so a defect turns the harness red.
--
-- Section 1 is the witness of docs/operations/schema-drift-2026-10.md section
-- 3.2, inverted, and it runs FIRST so that against production's pre-migration
-- schema (the migration's revert) it is the check that fails, in its own words:
-- with `trigger_manage_field_subunits` present, saving a field with halves off
-- deletes its sub-surfaces, the practice slot on one and the assignment on
-- that slot, and section 1 raises "halves off deleted ...". Section 2 then
-- asserts the catalogue the migration leaves: the section 5 list.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind. Every id is
-- generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Sub-surfaces through the two field RPCs: created with halves, kept
--    without them
-- ---------------------------------------------------------------------------
-- The one audit row a call wrote: rows on the field not in p_seen. All rows in
-- this transaction share created_at (now()), so "latest" cannot be ordered.
CREATE FUNCTION pg_temp.drift_new_audit(p_field uuid, p_seen uuid[]) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
    v_n int;
    v_meta jsonb;
BEGIN
    SELECT count(*), max(metadata::text)::jsonb INTO v_n, v_meta
      FROM public.audit_log
     WHERE resource_id = p_field AND NOT (id = ANY (p_seen));
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'expected one new audit row on field %, found %', p_field, v_n;
    END IF;
    RETURN v_meta;
END;
$$;

DO $witness$
DECLARE
    v_user uuid := gen_random_uuid();
    v_org uuid;
    v_loc uuid;
    v_field uuid;
    v_plain uuid;
    v_season uuid;
    v_division uuid;
    v_team uuid;
    v_sub_a uuid;
    v_sub_b uuid;
    v_slot uuid;
    v_assignment uuid;
    v_b_retired date;
    v_labels text;
    v_n int;
    v_meta jsonb;
    v_res jsonb;
    v_seen uuid[];
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data)
        VALUES (v_user, 'drift-smoke@example.test', jsonb_build_object('password_length', 16));
    INSERT INTO public.profiles (id, email) VALUES (v_user, 'drift-smoke@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Drift Smoke Org', 'drift-smoke-org')
        RETURNING id INTO v_org;
    INSERT INTO public.organization_members (organization_id, profile_id, role)
        VALUES (v_org, v_user, 'admin');
    PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
    INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Drift Smoke Park')
        RETURNING id INTO v_loc;

    -- 1a. A field created with halves through the RPC has A and B, in its
    --     organization (its audit row is checked after the witness, so that
    --     against production's schema the witness is what fails).
    v_res := public.admin_create_field(v_org, v_loc, 'Drift Pitch', 'Grass', '11v11', true, 1, true);
    v_field := (v_res->>'id')::uuid;
    v_meta := pg_temp.drift_new_audit(v_field, '{}');
    v_seen := ARRAY(SELECT id FROM public.audit_log WHERE resource_id = v_field);
    SELECT string_agg(label, ',' ORDER BY label), count(*) FILTER (WHERE organization_id = v_org)
      INTO v_labels, v_n
      FROM public.field_subunits WHERE field_id = v_field;
    IF v_labels IS DISTINCT FROM 'A,B' OR v_n <> 2 THEN
        RAISE EXCEPTION 'a field created with halves has sub-surfaces [%] (% in its organization), expected A,B', v_labels, v_n;
    END IF;
    SELECT id INTO v_sub_a FROM public.field_subunits WHERE field_id = v_field AND label = 'A';
    SELECT id INTO v_sub_b FROM public.field_subunits WHERE field_id = v_field AND label = 'B';

    -- A practice slot on sub-surface A, and an assignment on that slot: what
    -- production's trigger deleted along with the sub-surface.
    INSERT INTO public.season_settings (organization_id, name) VALUES (v_org, 'Drift Season')
        RETURNING id INTO v_season;
    INSERT INTO public.divisions (organization_id, season_settings_id, name)
        VALUES (v_org, v_season, 'Drift Division') RETURNING id INTO v_division;
    INSERT INTO public.teams (organization_id, division_id, name)
        VALUES (v_org, v_division, 'Drift Team') RETURNING id INTO v_team;
    INSERT INTO public.practice_slots (organization_id, field_id, field_subunit_id, day_of_week, start_time, end_time)
        VALUES (v_org, v_field, v_sub_a, 'tue', '17:00', '18:00') RETURNING id INTO v_slot;
    INSERT INTO public.practice_assignments (organization_id, team_id, practice_slot_id, field_id)
        VALUES (v_org, v_team, v_slot, v_field) RETURNING id INTO v_assignment;

    -- 1b. The witness, inverted: halves switched off (and the field renamed,
    --     as the Fields page saves it) deletes nothing.
    PERFORM public.admin_update_field(v_org, v_field, v_loc, 'Drift Pitch Renamed', 'Grass', '11v11', false, 1, true);
    IF (SELECT supports_halves FROM public.fields WHERE id = v_field) IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'admin_update_field did not save supports_halves = false';
    END IF;
    SELECT count(*) INTO v_n FROM public.field_subunits WHERE field_id = v_field;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'halves off deleted the field''s sub-surfaces: % of 2 left', v_n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.practice_slots WHERE id = v_slot AND field_subunit_id = v_sub_a) THEN
        RAISE EXCEPTION 'halves off deleted the practice slot on sub-surface A';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.practice_assignments WHERE id = v_assignment AND practice_slot_id = v_slot) THEN
        RAISE EXCEPTION 'halves off deleted the assignment on sub-surface A''s slot';
    END IF;
    -- The audit rows: the create named A and B, the halves-off update none.
    IF v_meta->'subunits_created' IS DISTINCT FROM '["A", "B"]'::jsonb THEN
        RAISE EXCEPTION 'the create audit row names subunits_created %, expected ["A", "B"]', v_meta->'subunits_created';
    END IF;
    v_meta := pg_temp.drift_new_audit(v_field, v_seen);
    v_seen := ARRAY(SELECT id FROM public.audit_log WHERE resource_id = v_field);
    IF v_meta->'subunits_created' IS DISTINCT FROM '[]'::jsonb THEN
        RAISE EXCEPTION 'the halves-off update audit row names subunits_created %, expected []', v_meta->'subunits_created';
    END IF;

    -- 1c. Halves back on: no duplicate, and a retired sub-surface stays retired.
    v_res := public.admin_retire_field_subunit(v_org, v_sub_b, current_date + 30, true);
    SELECT effective_to INTO v_b_retired FROM public.field_subunits WHERE id = v_sub_b;
    IF v_b_retired IS NULL THEN
        RAISE EXCEPTION 'could not retire sub-surface B for the check below: %', v_res;
    END IF;
    v_seen := ARRAY(SELECT id FROM public.audit_log WHERE resource_id = v_field);
    PERFORM public.admin_update_field(v_org, v_field, v_loc, 'Drift Pitch Renamed', 'Grass', '11v11', true, 1, true);
    v_meta := pg_temp.drift_new_audit(v_field, v_seen);
    v_seen := ARRAY(SELECT id FROM public.audit_log WHERE resource_id = v_field);
    IF v_meta->'subunits_created' IS DISTINCT FROM '[]'::jsonb THEN
        RAISE EXCEPTION 'halves back on, with A and B present, audits subunits_created %, expected []', v_meta->'subunits_created';
    END IF;
    SELECT count(*) INTO v_n FROM public.field_subunits WHERE field_id = v_field;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'halves back on left % sub-surfaces, expected the same 2', v_n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.field_subunits
                    WHERE id = v_sub_a AND field_id = v_field AND label = 'A')
       OR (SELECT effective_to FROM public.field_subunits WHERE id = v_sub_b) IS DISTINCT FROM v_b_retired THEN
        RAISE EXCEPTION 'halves back on replaced a sub-surface or brought retired B back';
    END IF;

    -- 1d. A sub-surface missing while halves are on is created by the next
    --     save (insert-only), and the audit row names only that one.
    DELETE FROM public.practice_slots WHERE id = v_slot;
    DELETE FROM public.field_subunits WHERE id = v_sub_a;
    PERFORM public.admin_update_field(v_org, v_field, v_loc, 'Drift Pitch Renamed', 'Grass', '11v11', true, 1, true);
    v_meta := pg_temp.drift_new_audit(v_field, v_seen);
    v_seen := ARRAY(SELECT id FROM public.audit_log WHERE resource_id = v_field);
    IF v_meta->'subunits_created' IS DISTINCT FROM '["A"]'::jsonb
       OR NOT EXISTS (SELECT 1 FROM public.field_subunits WHERE field_id = v_field AND label = 'A' AND organization_id = v_org) THEN
        RAISE EXCEPTION 'a save with halves on did not recreate the missing A (audit: %)', v_meta->'subunits_created';
    END IF;

    -- 1e. A field created without halves has none.
    v_res := public.admin_create_field(v_org, v_loc, 'Drift Plain Pitch', NULL, NULL, false, 1, true);
    v_plain := (v_res->>'id')::uuid;
    IF EXISTS (SELECT 1 FROM public.field_subunits WHERE field_id = v_plain) THEN
        RAISE EXCEPTION 'a field created without halves has sub-surfaces';
    END IF;

    RAISE NOTICE 'sub-surfaces: created with halves (A and B, audited), kept with their slot and assignment when halves go off, not duplicated or un-retired when they come back';
END
$witness$;

-- ---------------------------------------------------------------------------
-- 2. The catalogue the migration leaves (drift doc section 5)
-- ---------------------------------------------------------------------------
DO $catalog$
DECLARE
    v_left text;
    v_n int;
BEGIN
    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname IN ('set_updated_at', 'ensure_assistant_coach_ids_valid',
                          'ensure_game_team_consistency', 'handle_field_subunits',
                          'set_created_by_to_auth_uid')
            OR p.proname LIKE 'propagate\_org\_id\_from\_%');
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'functions the migration drops are still present: %', v_left;
    END IF;

    SELECT string_agg(c.relname || '.' || t.tgname, ', ') INTO v_left
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND (t.tgname LIKE 'set\_org\_id\_%'
            OR t.tgname IN ('set_scheduler_runs_created_by', 'trigger_manage_field_subunits'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'triggers the migration drops are still present: %', v_left;
    END IF;

    SELECT count(*), string_agg(p.oid::regprocedure::text, ', ') INTO v_n, v_left
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'persist_evaluation_run';
    IF v_n <> 1 OR to_regprocedure('public.persist_evaluation_run(jsonb, jsonb, jsonb)') IS NULL THEN
        RAISE EXCEPTION 'expected exactly persist_evaluation_run(jsonb, jsonb, jsonb), found %', v_left;
    END IF;

    RAISE NOTICE 'catalogue: no orphan, no fill-a-null or sub-surface trigger, one persist_evaluation_run';
END
$catalog$;

ROLLBACK;
