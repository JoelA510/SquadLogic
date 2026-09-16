-- Smoke checks for 20260910000000_admin_update_field_blackout.sql
--
-- Assertions RAISE; the reporting SELECT at the foot is evidence, not a gate.
-- See 20260906000000_smoke.sql for why.
--
-- **Half of this file is behavioural, and that is the half that matters.**
-- 20260906000100's smoke could only INSERT into `field_blackouts` directly,
-- because a definer function gated on `is_org_admin` needs a session. It does
-- not: `scripts/dbharness/prelude.sql` stubs `auth.uid()` from
-- `request.jwt.claim.sub`, which is how `scripts/dbharness/scenarios.py` calls
-- these RPCs for real. So this smoke seeds a member, assumes their identity and
-- CALLS the function -- a structural check could not tell an update from a
-- delete-and-re-add, which is the entire subject of the migration.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Shape, hardening and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'admin_update_field_blackout';
  -- **Exactly one.** A second overload is a route round whichever body a caller
  -- means, and `authenticated` would hold EXECUTE on the one nobody reviewed.
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 public.admin_update_field_blackout, found %', v_n; END IF;

  SELECT p.prosecdef, COALESCE(array_to_string(p.proconfig, ','), '') AS cfg,
         pg_get_functiondef(p.oid) AS def
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_update_field_blackout';

  IF NOT r.prosecdef THEN RAISE EXCEPTION 'admin_update_field_blackout is not SECURITY DEFINER'; END IF;
  IF r.cfg NOT LIKE '%search_path=public%' THEN RAISE EXCEPTION 'admin_update_field_blackout does not pin search_path'; END IF;
  IF r.def NOT LIKE '%is_org_admin%' THEN RAISE EXCEPTION 'admin_update_field_blackout does not gate on is_org_admin'; END IF;
  IF r.def NOT LIKE '%42501%' THEN RAISE EXCEPTION 'admin_update_field_blackout does not raise 42501'; END IF;

  -- **The audit divergence, pinned as a divergence.** The siblings write a
  -- before/after PAIR; this one writes a single `update` row carrying both. If
  -- somebody "restores consistency" by splitting it, the migration header stops
  -- being true and this fails rather than the difference going unnoticed.
  IF r.def NOT LIKE '%''phase'', ''update''%' THEN RAISE EXCEPTION 'admin_update_field_blackout does not audit with phase=update'; END IF;
  IF r.def LIKE '%''phase'', ''before''%' OR r.def LIKE '%''phase'', ''after''%' THEN
    RAISE EXCEPTION 'admin_update_field_blackout writes the siblings two-phase pair; its header says one entry carrying both halves';
  END IF;

  -- **Scope is not a parameter.** Accepting one and ignoring it is the field
  -- parsed and never read that CLAUDE.md names; the header says the signature
  -- has none, and this is what keeps that sentence true.
  IF r.def LIKE '%p_location_id%' OR r.def LIKE '%p_field_id%' THEN
    RAISE EXCEPTION 'admin_update_field_blackout takes a scope parameter; scope is deliberately not editable';
  END IF;

  -- The import-owned refusal is its own SQLSTATE, not P0002. Both must be
  -- present: a body raising only 0A000 would answer "frozen" for an unknown id.
  IF r.def NOT LIKE '%0A000%' THEN RAISE EXCEPTION 'admin_update_field_blackout has no 0A000 import-owned refusal'; END IF;
  IF r.def NOT LIKE '%P0002%' THEN RAISE EXCEPTION 'admin_update_field_blackout has no P0002 not-found refusal'; END IF;

  IF has_function_privilege('public',
    'public.admin_update_field_blackout(uuid, uuid, date, date, integer, integer, text, text)', 'EXECUTE')
  THEN RAISE EXCEPTION 'PUBLIC must not execute admin_update_field_blackout'; END IF;
  IF NOT has_function_privilege('authenticated',
    'public.admin_update_field_blackout(uuid, uuid, date, date, integer, integer, text, text)', 'EXECUTE')
  THEN RAISE EXCEPTION 'authenticated must execute admin_update_field_blackout'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The edit, exercised on real rows through the real RPC
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_org uuid; v_other uuid; v_loc uuid; v_field uuid; v_user uuid := gen_random_uuid();
  v_prof uuid; v_window uuid; v_foreign uuid;
  v_created jsonb; v_res jsonb; v_id uuid; v_n int; v_row public.field_blackouts%ROWTYPE;
  v_meta jsonb; v_updates int := 0;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'blackout-edit@example.test', jsonb_build_object('password_length', 16))
  ON CONFLICT DO NOTHING;
  INSERT INTO public.profiles (id, email) VALUES (v_user, 'blackout-edit@example.test')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 8.4gapA','smoke-org-84gapa')
  RETURNING id INTO v_org;
  INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org 8.4gapA other','smoke-org-84gapa-other')
  RETURNING id INTO v_other;
  INSERT INTO public.organization_members (organization_id, profile_id, role)
  VALUES (v_org, v_user, 'admin');
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  INSERT INTO public.locations (organization_id, name) VALUES (v_org,'Smoke Site') RETURNING id INTO v_loc;
  INSERT INTO public.fields (organization_id, location_id, name)
  VALUES (v_org, v_loc,'Smoke Pitch') RETURNING id INTO v_field;

  -- The subject: one timed, field-scoped window, created through its own RPC so
  -- this file never hand-builds a row shape the production path cannot reach.
  v_created := public.admin_create_field_blackout(
    p_organization_id => v_org, p_location_id => NULL, p_field_id => v_field,
    p_blackout_from => DATE '2026-09-01', p_blackout_until => DATE '2026-09-02',
    p_start_minutes => 540, p_end_minutes => 720,
    p_reason => 'maintenance', p_note => 'original note');
  v_id := (v_created->>'id')::uuid;
  IF v_id IS NULL THEN RAISE EXCEPTION 'the smoke subject was not created'; END IF;

  -- ── The edit itself: dates moved, times cleared, reason changed, note gone.
  v_res := public.admin_update_field_blackout(
    p_organization_id => v_org, p_blackout_id => v_id,
    p_blackout_from => DATE '2026-09-10', p_blackout_until => DATE '2026-09-12',
    p_start_minutes => NULL, p_end_minutes => NULL,
    p_reason => 'weather', p_note => NULL);
  v_updates := v_updates + 1;

  -- **The identity survived.** This is the whole migration in one assertion:
  -- the returned id is the id that went in, not a new one.
  IF (v_res->>'id')::uuid IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'the edit returned id % for a window whose id is % -- it replaced the row rather than editing it',
      v_res->>'id', v_id;
  END IF;

  -- **And it is still ONE row.** A delete-and-re-add that reused the id would
  -- pass the assertion above; a count taken from the table cannot be satisfied
  -- by anything the payload claims.
  SELECT count(*) INTO v_n FROM public.field_blackouts WHERE organization_id = v_org;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 blackout for the smoke org after an edit, found %', v_n; END IF;

  SELECT * INTO v_row FROM public.field_blackouts WHERE id = v_id;
  IF v_row.blackout_from <> DATE '2026-09-10' OR v_row.blackout_until <> DATE '2026-09-12' THEN
    RAISE EXCEPTION 'the edit did not move the dates (% -> %)', v_row.blackout_from, v_row.blackout_until;
  END IF;
  -- **NULL means NULL.** A COALESCE-partial update would have left 540/720 here
  -- and the window would still be timed while the operator was told it is now
  -- all day -- the one defect this signature's shape exists to make impossible.
  IF v_row.start_minutes IS NOT NULL OR v_row.end_minutes IS NOT NULL THEN
    RAISE EXCEPTION 'a timed window edited to all day kept its times (%, %) -- NULL was read as "leave unchanged"',
      v_row.start_minutes, v_row.end_minutes;
  END IF;
  IF v_row.note IS NOT NULL THEN
    RAISE EXCEPTION 'a cleared note survived the edit as % -- NULL was read as "leave unchanged"', v_row.note;
  END IF;
  IF v_row.reason <> 'weather' THEN RAISE EXCEPTION 'the edit did not change the reason (%)', v_row.reason; END IF;
  -- Scope is untouched because it cannot be passed; asserted so "there is no
  -- parameter" is a behaviour rather than only a signature.
  IF v_row.field_id IS DISTINCT FROM v_field OR v_row.location_id IS NOT NULL THEN
    RAISE EXCEPTION 'the edit moved the scope (field %, location %)', v_row.field_id, v_row.location_id;
  END IF;

  -- ── ONE audit entry, carrying both halves.
  SELECT count(*) INTO v_n FROM public.audit_log
   WHERE resource_id = v_id AND metadata->>'operation' = 'admin_update_field_blackout';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 audit row for the edit, found % -- the point of the RPC is that an edit is one event', v_n;
  END IF;
  SELECT metadata INTO v_meta FROM public.audit_log
   WHERE resource_id = v_id AND metadata->>'operation' = 'admin_update_field_blackout';
  IF v_meta->>'phase' <> 'update' THEN RAISE EXCEPTION 'the edit audit row has phase %, expected update', v_meta->>'phase'; END IF;
  IF v_meta->'before' IS NULL OR v_meta->'after' IS NULL THEN
    RAISE EXCEPTION 'the edit audit row carries only half the diff: %', v_meta;
  END IF;
  -- The two halves are the two STATES, so they must differ on a column the
  -- edit changed. A row recording before = after is a diff nobody can read.
  IF v_meta->'before'->>'blackout_from' = v_meta->'after'->>'blackout_from' THEN
    RAISE EXCEPTION 'before and after agree on blackout_from; the audit row is not a diff';
  END IF;
  IF (v_meta->'before'->>'id')::uuid IS DISTINCT FROM (v_meta->'after'->>'id')::uuid THEN
    RAISE EXCEPTION 'the audit row pairs two different ids, so it does not record an edit of one window';
  END IF;

  -- ── All day back to timed, so neither direction is the only one exercised.
  v_res := public.admin_update_field_blackout(
    p_organization_id => v_org, p_blackout_id => v_id,
    p_blackout_from => DATE '2026-09-10', p_blackout_until => DATE '2026-09-10',
    p_start_minutes => 1020, p_end_minutes => 1140,
    p_reason => 'event', p_note => 'lights out');
  v_updates := v_updates + 1;
  SELECT * INTO v_row FROM public.field_blackouts WHERE id = v_id;
  IF v_row.start_minutes <> 1020 OR v_row.end_minutes <> 1140 OR v_row.note <> 'lights out' THEN
    RAISE EXCEPTION 'an all-day window edited to a timed one did not take the times (%, %, note %)',
      v_row.start_minutes, v_row.end_minutes, v_row.note;
  END IF;

  -- ── An invalid edit is refused by the table's CHECKs and leaves the row.
  BEGIN
    PERFORM public.admin_update_field_blackout(
      p_organization_id => v_org, p_blackout_id => v_id,
      p_blackout_from => DATE '2026-09-20', p_blackout_until => DATE '2026-09-10',
      p_start_minutes => NULL, p_end_minutes => NULL, p_reason => 'other', p_note => NULL);
    RAISE EXCEPTION 'an edit inverting the date range was ACCEPTED';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT * INTO v_row FROM public.field_blackouts WHERE id = v_id;
  IF v_row.blackout_from <> DATE '2026-09-10' OR v_row.reason <> 'event' THEN
    RAISE EXCEPTION 'a REFUSED edit changed the row (% %, reason %)', v_row.blackout_from, v_row.blackout_until, v_row.reason;
  END IF;

  -- ── An import-owned window is refused BY NAME, and is untouched.
  INSERT INTO public.field_availability_profiles
    (organization_id, season_label, field_id, location, field_name, available_from, available_until)
  VALUES (v_org, 'Smoke Season', v_field, 'Smoke Site', 'Smoke Pitch', '2026-01-01','2026-12-31')
  RETURNING id INTO v_prof;
  INSERT INTO public.field_blackout_windows (organization_id, profile_id, blackout_from, blackout_until, reason)
  VALUES (v_org, v_prof, '2026-10-01','2026-10-07','winter shutdown')
  RETURNING id INTO v_window;
  BEGIN
    PERFORM public.admin_update_field_blackout(
      p_organization_id => v_org, p_blackout_id => v_window,
      p_blackout_from => DATE '2026-11-01', p_blackout_until => DATE '2026-11-02',
      p_start_minutes => NULL, p_end_minutes => NULL, p_reason => 'other', p_note => NULL);
    RAISE EXCEPTION 'an import-owned window was EDITED through admin_update_field_blackout';
  -- **`feature_not_supported`, not the catch-all.** Catching `others` here
  -- would score a P0002 "not found" as a pass, which is precisely the answer
  -- this branch exists to stop being given.
  EXCEPTION WHEN feature_not_supported THEN NULL; END;
  SELECT count(*) INTO v_n FROM public.field_blackout_windows
   WHERE id = v_window AND blackout_from = DATE '2026-10-01';
  IF v_n <> 1 THEN RAISE EXCEPTION 'the refused import-owned window was modified anyway'; END IF;

  -- ── An unknown id is P0002, so "frozen" and "absent" stay different answers.
  BEGIN
    PERFORM public.admin_update_field_blackout(
      p_organization_id => v_org, p_blackout_id => gen_random_uuid(),
      p_blackout_from => DATE '2026-11-01', p_blackout_until => DATE '2026-11-02',
      p_start_minutes => NULL, p_end_minutes => NULL, p_reason => 'other', p_note => NULL);
    RAISE EXCEPTION 'an edit of an id that does not exist was ACCEPTED';
  EXCEPTION WHEN no_data_found THEN NULL; END;

  -- ── Another organisation's window is NOT FOUND, not "frozen" and not edited.
  --    The import-owned branch is org-scoped precisely so a stranger cannot use
  --    it to confirm that an id exists.
  INSERT INTO public.field_availability_profiles
    (organization_id, season_label, field_id, location, field_name, available_from, available_until)
  VALUES (v_other, 'Smoke Season', NULL, 'Other Site', 'Other Pitch', '2026-01-01','2026-12-31')
  RETURNING id INTO v_prof;
  INSERT INTO public.field_blackout_windows (organization_id, profile_id, blackout_from, blackout_until, reason)
  VALUES (v_other, v_prof, '2026-10-01','2026-10-07','winter shutdown')
  RETURNING id INTO v_foreign;
  BEGIN
    PERFORM public.admin_update_field_blackout(
      p_organization_id => v_org, p_blackout_id => v_foreign,
      p_blackout_from => DATE '2026-11-01', p_blackout_until => DATE '2026-11-02',
      p_start_minutes => NULL, p_end_minutes => NULL, p_reason => 'other', p_note => NULL);
    RAISE EXCEPTION 'an edit reached another organisation''s import window';
  EXCEPTION
    WHEN feature_not_supported THEN
      RAISE EXCEPTION 'another organisation''s window was identified as import-owned; the refusal leaks that the id exists';
    WHEN no_data_found THEN NULL;
  END;

  -- ── Meta: this block really ran its edits. A file that seeded nothing and
  --    asserted about nothing is the shape LIVE-2's pgTAP suite had.
  IF v_updates <> 2 THEN RAISE EXCEPTION 'the smoke ran % accepted edits, expected 2', v_updates; END IF;
  SELECT count(*) INTO v_n FROM public.audit_log
   WHERE resource_id = v_id AND metadata->>'operation' = 'admin_update_field_blackout';
  IF v_n <> v_updates THEN
    RAISE EXCEPTION 'expected % audit rows for % accepted edits, found %', v_updates, v_updates, v_n;
  END IF;

  RAISE NOTICE 'edit path exercised: % accepted edits on 1 window (id unchanged, 1 audit row each), 4 refusals (inverted range, import-owned, unknown id, cross-org)', v_updates;
  DELETE FROM public.organizations WHERE id IN (v_org, v_other);
  DELETE FROM auth.users WHERE id = v_user;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Reporting (evidence, not gates)
-- ---------------------------------------------------------------------------
select 'blackout edits recorded as one event each' as report,
       count(*) filter (where metadata->>'operation' = 'admin_update_field_blackout') as edits,
       count(*) filter (where metadata->>'operation' = 'admin_create_field_blackout') as creates,
       count(*) filter (where metadata->>'operation' = 'admin_delete_field_blackout') as deletes
from public.audit_log
where resource_type = 'field_blackout';
