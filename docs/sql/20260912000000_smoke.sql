-- Smoke checks for 20260912000000_retire_refuses_on_contained_estate.sql
--
-- **These ASSERT rather than report.** A smoke made of bare SELECTs exits 0
-- whatever it prints. Invariants RAISE, so `scripts/dbharness/prove.sh` can
-- prove they fail when the defect is planted.
--
-- The one thing this file exists to prove: **a venue retirement refuses on the
-- half of the consequence that is not a booking list.** Section 3 seeds a venue
-- with live pitches and NOTHING booked after the date, and requires a refusal.
-- The pre-migration implementation -- which computed, audited and returned the
-- containment and then committed anyway -- fails there rather than shipping.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The gate is in the function body, read from prosrc
-- ---------------------------------------------------------------------------
--
-- **`prosrc`, not `pg_get_functiondef`.** Part 1 lost a smoke to exactly that
-- choice: a DEFAULT renders inside the SIGNATURE, so a definition split on a
-- body marker put signature text into the first arm and a guard could no longer
-- fail at all.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_retire_location';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'admin_retire_location is missing';
  END IF;
  IF v_src NOT LIKE '%(v_affected_count > 0 OR v_contained_count > 0)%' THEN
    RAISE EXCEPTION 'admin_retire_location does not gate on the contained estate';
  END IF;
  IF v_src NOT LIKE '%contained_estate_after_effective_to%' THEN
    RAISE EXCEPTION 'admin_retire_location cannot produce the containment refusal reason';
  END IF;
  -- **The two reasons stay two.** A body that lost the bookings literal would
  -- report every refusal as a containment one.
  IF v_src NOT LIKE '%bookings_after_effective_to%' THEN
    RAISE EXCEPTION 'admin_retire_location lost the bookings refusal reason';
  END IF;
  -- Exactly one definition: a CREATE OR REPLACE that created an OVERLOAD would
  -- leave the old gate reachable by a caller that binds the other signature.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'admin_retire_location') <> 1 THEN
    RAISE EXCEPTION 'admin_retire_location has an overload';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The depths this migration deliberately did NOT change
-- ---------------------------------------------------------------------------
--
-- **Stated as an assertion rather than as a sentence in the header.** A later
-- change that "made the family consistent" by giving the sub-surface arm a
-- containment gate would give a leaf node a rule about children it cannot have,
-- and would do it quietly. It fails here instead.
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_retire_field_subunit';
  IF v_src IS NULL THEN RAISE EXCEPTION 'admin_retire_field_subunit is missing'; END IF;
  IF v_src LIKE '%contained%' THEN
    RAISE EXCEPTION 'admin_retire_field_subunit gained a containment arm; a sub-surface is the leaf of the estate';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_retire_field';
  IF v_src IS NULL THEN RAISE EXCEPTION 'admin_retire_field is missing'; END IF;
  IF v_src LIKE '%contained%' THEN
    RAISE EXCEPTION 'admin_retire_field gained a containment arm; that question is open and is not answered here';
  END IF;

  -- The producer is still the only one, and this migration added none.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'estate_contained_nodes') <> 1 THEN
    RAISE EXCEPTION 'estate_contained_nodes is not the single producer of the containment set';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. THE BEHAVIOUR, called rather than read
-- ---------------------------------------------------------------------------
--
-- Four venues, because the gate has four answers and asserting three of them
-- would leave the fourth free to be anything:
--
--   A  live pitches, nothing booked  -> REFUSES on containment (the new gate)
--   A  the same call CONFIRMED       -> commits, and copies nothing down
--   B  live pitches AND a booking    -> refuses on BOOKINGS (the old reason
--                                       still wins, so the two stay two)
--   C  holds nothing                 -> commits unconfirmed (the empty case)
--   D  every child already dated     -> commits unconfirmed (count, not list)
DO $$
DECLARE
  v_org uuid; v_user uuid := gen_random_uuid();
  v_a uuid; v_b uuid; v_c uuid; v_d uuid;
  v_pitch uuid; v_bpitch uuid; v_dpitch uuid;
  v_res jsonb; v_n int;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'smoke-20260912@example.test', jsonb_build_object('password_length', 16))
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (name, slug) VALUES ('Smoke 20260912','smoke-20260912')
  RETURNING id INTO v_org;
  INSERT INTO public.profiles (id, email) VALUES (v_user, 'smoke-20260912@example.test')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organization_members (organization_id, profile_id, role)
  VALUES (v_org, v_user, 'admin');
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Venue A')
  RETURNING id INTO v_a;
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_a, 'A Pitch', true) RETURNING id INTO v_pitch;

  INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Venue B')
  RETURNING id INTO v_b;
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_b, 'B Pitch', true) RETURNING id INTO v_bpitch;
  INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index)
  VALUES (v_org, v_bpitch, current_date + 40, 1);

  INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Venue C')
  RETURNING id INTO v_c;

  INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Venue D')
  RETURNING id INTO v_d;
  INSERT INTO public.fields (organization_id, location_id, name, active, effective_to)
  VALUES (v_org, v_d, 'D Pitch', true, current_date + 10) RETURNING id INTO v_dpitch;

  -- **The seed really landed, and it is what each case claims.** A Venue A that
  -- lost its pitch would make the containment refusal untestable and the case
  -- would pass as an ordinary commit; a Venue C that acquired one would make
  -- the empty case a test of something else.
  IF (SELECT count(*) FROM public.fields WHERE location_id = v_a) <> 1 THEN
    RAISE EXCEPTION 'smoke seed: Venue A does not hold exactly one pitch';
  END IF;
  IF (SELECT count(*) FROM public.fields WHERE location_id = v_c) <> 0 THEN
    RAISE EXCEPTION 'smoke seed: Venue C is not empty';
  END IF;
  IF (SELECT count(*) FROM public.fields WHERE location_id = v_d AND effective_to IS NULL) <> 0 THEN
    RAISE EXCEPTION 'smoke seed: Venue D holds an undated pitch';
  END IF;

  -- A: nothing booked, one live pitch. THE case this migration exists for.
  v_res := public.admin_retire_location(v_org, v_a, current_date + 30, false);
  IF (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'a venue holding a live pitch was retired UNCONFIRMED with nothing booked';
  END IF;
  IF v_res->>'reason' <> 'contained_estate_after_effective_to' THEN
    RAISE EXCEPTION 'expected a containment refusal, got reason %', v_res->>'reason';
  END IF;
  IF (v_res->>'affected_count')::int <> 0 THEN
    RAISE EXCEPTION 'the containment refusal claims % bookings', v_res->>'affected_count';
  END IF;
  IF (v_res->>'contained_count')::int <> 1 THEN
    RAISE EXCEPTION 'expected contained_count 1, got %', v_res->>'contained_count';
  END IF;
  IF (SELECT effective_to FROM public.locations WHERE id = v_a) IS NOT NULL THEN
    RAISE EXCEPTION 'the refused retirement wrote the date anyway';
  END IF;

  -- A again, confirmed: it commits, and still copies nothing down.
  v_res := public.admin_retire_location(v_org, v_a, current_date + 30, true);
  IF NOT (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'a confirmed venue retirement was refused';
  END IF;
  IF (SELECT effective_to FROM public.fields WHERE id = v_pitch) IS NOT NULL THEN
    RAISE EXCEPTION 'the confirmed retirement copied its date onto the pitch';
  END IF;

  -- B: a booking AND live containment. The bookings reason still wins, so the
  -- two refusals stay distinguishable in the audit trail.
  v_res := public.admin_retire_location(v_org, v_b, current_date + 30, false);
  IF (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'a booked venue was retired unconfirmed';
  END IF;
  IF v_res->>'reason' <> 'bookings_after_effective_to' THEN
    RAISE EXCEPTION 'a booked venue refused with reason %', v_res->>'reason';
  END IF;

  -- C: holds nothing. admin_delete_field's empty case, adopted.
  v_res := public.admin_retire_location(v_org, v_c, current_date + 30, false);
  IF NOT (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'an EMPTY venue was refused; there is nothing for the operator to confirm';
  END IF;
  IF jsonb_array_length(v_res->'contained') <> 0 THEN
    RAISE EXCEPTION 'the empty venue reported % contained nodes', jsonb_array_length(v_res->'contained');
  END IF;

  -- D: three-in-the-list, zero-in-the-count. The pair that proves the gate
  -- reads the COUNT and not the length of the list.
  v_res := public.admin_retire_location(v_org, v_d, current_date + 30, false);
  IF NOT (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'a venue whose every child already ends by the date was refused';
  END IF;
  IF (v_res->>'contained_count')::int <> 0 THEN
    RAISE EXCEPTION 'expected contained_count 0 for an already-closed estate, got %',
      v_res->>'contained_count';
  END IF;
  IF jsonb_array_length(v_res->'contained') <> 1 THEN
    RAISE EXCEPTION 'the already-closed estate reported % contained nodes; the LIST is not the COUNT',
      jsonb_array_length(v_res->'contained');
  END IF;

  -- **The refusals were AUDITED, and with both reasons.** A guard that refuses
  -- without a trail records no world the operator decided against.
  SELECT count(*) INTO v_n FROM public.audit_log a
   WHERE a.organization_id = v_org
     AND a.metadata->>'operation' = 'admin_retire_location'
     AND a.metadata->>'phase' = 'refused';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected 2 refused audit rows, got %', v_n;
  END IF;
  SELECT count(DISTINCT a.metadata->>'reason') INTO v_n FROM public.audit_log a
   WHERE a.organization_id = v_org
     AND a.metadata->>'operation' = 'admin_retire_location'
     AND a.metadata->>'phase' = 'refused';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'the two refusal reasons collapsed into % distinct value(s)', v_n;
  END IF;

  RAISE NOTICE '20260912000000 smoke: 4 venues, 2 refusals with 2 distinct reasons, 3 commits';
END $$;
