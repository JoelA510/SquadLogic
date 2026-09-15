-- Smoke checks for 20260909000000_rollback_field_import_booking_guard.sql
--
-- **These ASSERT rather than report.** Every invariant RAISEs, so
-- `scripts/dbharness/prove.sh` can plant the defect each one exists to catch
-- and require this file to go red -- and, for the plants aimed here, require
-- the smokes that run EARLIER to stay green, so the evidence is this file's
-- own rather than borrowed from one of them.
--
-- Sections 1-4 read the catalogue. Sections 5-7 CALL the functions, because
-- reading a function says nothing about what it does: LIVE-1's own smoke
-- passed every structural check while the RPC reported a consequence that was
-- false for every row the scheduler writes.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The third deleter enumerates through the shared producer, and keeps no
--    list of its own
-- ---------------------------------------------------------------------------
--
-- LIVE-3 is `rollback_field_import_job` answering "what is booked on this
-- ground" with two tables while the other two field RPCs shared a six-kind
-- producer. A third hand-written list is what guarantees the next correction
-- lands on two of three, so the absence of one is checked as hard as the
-- presence of the call.
DO $$
DECLARE
  v_def text;
  v_fields_arm text;
  t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rollback_field_import_job';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.rollback_field_import_job is missing';
  END IF;

  IF v_def NOT LIKE '%public.field_bookings(%' THEN
    RAISE EXCEPTION
      'rollback_field_import_job does not enumerate through public.field_bookings; LIVE-3 is back';
  END IF;

  -- **The old union, by the tables it named.** The `fields` arm is cut out by
  -- its own two markers rather than searched for anywhere in the body,
  -- because `practice_slots` and `game_slots` legitimately appear in the arms
  -- ABOVE it -- a whole-body search would either pass for the wrong reason or
  -- fail for one.
  v_fields_arm := (regexp_match(
    v_def,
    $re$ELSIF v_record\.target_table = 'fields' THEN(.*?)ELSIF v_record\.target_table = 'locations' THEN$re$))[1];
  IF v_fields_arm IS NULL THEN
    RAISE EXCEPTION 'could not find the fields arm of rollback_field_import_job''s insert switch';
  END IF;
  -- A positive anchor on the cut itself: an empty or near-empty capture would
  -- satisfy every NOT LIKE below by containing nothing.
  IF length(v_fields_arm) < 200 THEN
    RAISE EXCEPTION 'the fields arm parsed to % characters; the markers have moved', length(v_fields_arm);
  END IF;
  IF v_fields_arm NOT LIKE '%public.field_bookings(%' THEN
    RAISE EXCEPTION 'the fields arm does not call the producer';
  END IF;
  FOREACH t IN ARRAY ARRAY['practice_slots','game_slots','games','game_assignments',
                           'practice_assignments','field_availability_profiles'] LOOP
    IF v_fields_arm LIKE '%public.' || t || '%' THEN
      RAISE EXCEPTION
        'the fields arm reads public.% directly; it has re-inlined a list beside the producer', t;
    END IF;
  END LOOP;

  -- **Both silent arms raise.** With no ELSE, an unhandled `target_table` fell
  -- through to the ledger UPDATE and was stamped as rolled back having done
  -- nothing -- on the insert branch a `{"deleted": true}` for a table nothing
  -- deleted from, on the update branch a `restored_records` increment for a
  -- restore that never happened.
  IF v_def NOT LIKE '%cannot undo an insert into %' THEN
    RAISE EXCEPTION 'the insert switch has no arm for a target_table it does not handle';
  END IF;
  IF v_def NOT LIKE '%cannot restore an update to %' THEN
    RAISE EXCEPTION 'the update switch has no arm for a target_table it does not handle';
  END IF;

  -- A blocked record says which one and why.
  IF v_def NOT LIKE '%''blocked'', v_blocked%' THEN
    RAISE EXCEPTION 'the result does not carry the blocked list';
  END IF;

  RAISE NOTICE 'rollback_field_import_job: one producer, no second list, no silent arm';
END $$;

-- ---------------------------------------------------------------------------
-- 2. THE SUBUNIT CLOSURE -- why the sibling branch keeps a narrower check
-- ---------------------------------------------------------------------------
--
-- The `field_subunits` arm guards on `practice_slots` alone, and that is not
-- a narrower guard that happens to work: it is a COMPLETE cut of the closure
-- at its only edge. `practice_assignments` is reachable from a subunit ONLY
-- through `practice_slots`, so nothing downstream can be destroyed without a
-- practice slot on the subunit existing, and that is what the arm refuses on.
--
-- **That is an argument about the referential graph, so it is re-derived from
-- the graph rather than believed.** The day a `game_slots.field_subunit_id`
-- or a direct `practice_assignments.field_subunit_id` appears, the argument
-- stops being true and this fails, which is the whole point of writing it
-- down as a check instead of as a paragraph.
DO $$
DECLARE
  v_closure text[];
  v_direct text[];
BEGIN
  WITH RECURSIVE fk AS (
    SELECT src.relname::text AS src, tgt.relname::text AS tgt, con.confdeltype AS del
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'public'
     WHERE con.contype = 'f'
  ), closure AS (
    SELECT fk.src, fk.del FROM fk WHERE fk.tgt = 'field_subunits'
    UNION
    SELECT fk.src, fk.del FROM fk JOIN closure c ON fk.tgt = c.src AND c.del = 'c'
  )
  SELECT array_agg(DISTINCT src ORDER BY src) INTO v_closure FROM closure;

  -- A walk that found nothing agrees with nothing and would pass by being
  -- empty on both sides.
  IF v_closure IS NULL OR array_length(v_closure, 1) IS NULL THEN
    RAISE EXCEPTION 'the cascade closure from field_subunits is empty; the walk is not reading pg_constraint';
  END IF;
  IF v_closure <> ARRAY['practice_assignments','practice_slots'] THEN
    RAISE EXCEPTION
      'the cascade closure from field_subunits changed: it now reaches %. rollback_field_import_job''s single practice_slots check is no longer a complete cut and the arm must adopt an enumerator.',
      v_closure;
  END IF;

  -- The closure being those two is not enough on its own: the argument needs
  -- `practice_slots` to be the ONLY direct edge, otherwise a member could be
  -- reached without one and the single EXISTS would miss it.
  SELECT array_agg(DISTINCT src.relname::text ORDER BY src.relname::text)
    INTO v_direct
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'public'
   WHERE con.contype = 'f' AND tgt.relname = 'field_subunits';
  IF v_direct <> ARRAY['practice_slots'] THEN
    RAISE EXCEPTION
      'field_subunits is referenced directly by %, not by practice_slots alone; the subunit arm''s single check is no longer complete',
      v_direct;
  END IF;

  RAISE NOTICE 'subunit closure: % reached, all of it through practice_slots', v_closure;
END $$;

-- ---------------------------------------------------------------------------
-- 3. THE PROFILE IS CASCADE, AND ITS PARTS ARE ITS OWN
-- ---------------------------------------------------------------------------
--
-- The `availability_profile` arm reports `cascades = true` and the delete RPC
-- turns that into the word `deleted`. That is a claim about a constraint, and
-- 20260907000000's section 5 already reads every arm's literal back out of
-- `pg_constraint` -- this adds the two things that check cannot see.
DO $$
DECLARE
  v_del char;
  v_parts text[];
  v_independent text[];
  v_nullable text[];
BEGIN
  SELECT con.confdeltype INTO v_del
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
   WHERE con.contype = 'f' AND src.relname = 'field_availability_profiles'
     AND tgt.relname = 'fields';
  IF v_del IS NULL THEN
    RAISE EXCEPTION 'field_availability_profiles.field_id has no foreign key to fields';
  END IF;
  -- 'n' is SET NULL, which is what LIVE-3 replaced: a confirmed delete left
  -- the profile describing ground that no longer existed, with its blackout
  -- windows attached and `closes_field_id` NULL in field_closures.
  IF v_del <> 'c' THEN
    RAISE EXCEPTION
      'field_availability_profiles.field_id is ON DELETE %, expected c (CASCADE); a field delete is producing field-less profiles again',
      v_del;
  END IF;

  -- **The four parts, named so a fifth cannot arrive unnoticed.** They are
  -- excluded from the booking list on the grounds that they are the profile's
  -- own parts and are reported through it. A new dependent would be destroyed
  -- by a confirmed delete with nothing in `affected` mentioning it.
  SELECT array_agg(DISTINCT src.relname::text ORDER BY src.relname::text)
    INTO v_parts
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'public'
   WHERE con.contype = 'f' AND tgt.relname = 'field_availability_profiles';
  IF v_parts IS NULL OR array_length(v_parts, 1) IS NULL THEN
    RAISE EXCEPTION 'nothing references field_availability_profiles; this check is looking at nothing';
  END IF;
  IF v_parts <> ARRAY['field_availability_profile_formats',
                      'field_availability_scenario_members',
                      'field_blackout_windows',
                      'field_equipment_requirements'] THEN
    RAISE EXCEPTION
      'the profile''s dependents changed to %. Decide whether the new one is a booking in its own right or another of the profile''s parts, and say so in 20260907000000''s closure lists.',
      v_parts;
  END IF;

  -- **And each of them reaches `fields` ONLY through the profile.** That is
  -- what makes "reported through the profile" true rather than convenient: a
  -- part with its own edge to `fields` would be destroyed on a field whose
  -- profile is somewhere else entirely, and no `availability_profile` row in
  -- `affected` would account for it.
  SELECT array_agg(DISTINCT src.relname::text ORDER BY src.relname::text)
    INTO v_independent
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'public'
   WHERE con.contype = 'f' AND tgt.relname = 'fields' AND src.relname = ANY(v_parts);
  IF v_independent IS NOT NULL THEN
    RAISE EXCEPTION
      '% reference(s) fields directly as well as through the profile; the availability_profile arm no longer accounts for them',
      v_independent;
  END IF;

  -- The arm reports `undated = false` and `unbounded = false` unconditionally,
  -- which is only honest while both date columns are NOT NULL.
  SELECT array_agg(a.attname::text ORDER BY a.attname::text)
    INTO v_nullable
    FROM pg_attribute a
   WHERE a.attrelid = 'public.field_availability_profiles'::regclass
     AND a.attname IN ('available_from','available_until')
     AND NOT a.attnotnull;
  IF v_nullable IS NOT NULL THEN
    RAISE EXCEPTION
      '% became nullable; the availability_profile arm reports undated=false for every row and would now be lying',
      v_nullable;
  END IF;

  RAISE NOTICE 'availability profile: CASCADE, 4 parts, none with an independent path, both dates NOT NULL';
END $$;

-- ---------------------------------------------------------------------------
-- 4. EVERY FUNCTION THAT DELETES A FIELD, derived rather than listed
-- ---------------------------------------------------------------------------
--
-- 20260907000000's section 5b holds the two RPCs that ANSWER an operator to
-- the shared producer. This asks the other question -- who actually removes a
-- field -- and derives the answer from `pg_proc` instead of naming it, because
-- a fix whose sibling set cannot be produced by a command is a fix that is not
-- finished. LIVE-3 existed because the third deleter was not on anybody's list.
DO $$
DECLARE
  r record;
  v_deleters text[];
BEGIN
  SELECT array_agg(DISTINCT p.proname::text ORDER BY p.proname::text)
    INTO v_deleters
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     -- `prokind = 'f'` first: `pg_get_functiondef` RAISES on an aggregate,
     -- and this schema defines one, so the unrestricted walk aborted rather
     -- than returning an answer.
     AND p.prokind = 'f'
     AND p.prosrc ~ 'DELETE FROM public\.fields\M';

  IF v_deleters IS NULL OR array_length(v_deleters, 1) IS NULL THEN
    RAISE EXCEPTION 'no function deletes from public.fields; this check found nothing to check';
  END IF;
  -- Stated as an exact set, so a FOURTH deleter arriving fails here and has to
  -- be argued rather than absorbed by a `FOREACH` that only checks whoever it
  -- happens to find.
  IF v_deleters <> ARRAY['admin_delete_field','rollback_field_import_job'] THEN
    RAISE EXCEPTION
      'the set of functions deleting public.fields is now %. Every one of them must enumerate through public.field_bookings before it deletes.',
      v_deleters;
  END IF;

  FOR r IN
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(v_deleters)
  LOOP
    IF r.def NOT LIKE '%public.field_bookings(%' THEN
      RAISE EXCEPTION '% deletes a field without consulting the shared producer', r.proname;
    END IF;
  END LOOP;

  RAISE NOTICE 'field deleters: %, all of them on the shared producer', v_deleters;
END $$;

-- ---------------------------------------------------------------------------
-- 5. THE ROLLBACK, CALLED: refused on a booked field, replayable once cleared
-- ---------------------------------------------------------------------------
--
-- **The booking seeded here is one the OLD guard could not see.** A free-
-- standing `practice_assignment` -- a `field_id` and no slot -- is invisible
-- to `EXISTS practice_slots OR EXISTS game_slots`, so before this migration
-- the rollback deleted the field and the assignment lost its venue in silence.
-- Seeding a slot instead would pass against the pre-fix body and prove nothing.
DO $$
DECLARE
  v_org uuid; v_user uuid := gen_random_uuid();
  v_loc uuid; v_booked uuid; v_free uuid;
  v_season uuid; v_div uuid; v_team uuid;
  v_job uuid; v_pa uuid; v_profile uuid;
  v_res jsonb; v_n int; v_blocked jsonb;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'rollback-guard@example.test', jsonb_build_object('password_length', 16))
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (name, slug)
  VALUES ('Rollback Guard Org','rollback-guard-org') RETURNING id INTO v_org;
  INSERT INTO public.profiles (id, email) VALUES (v_user, 'rollback-guard@example.test')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organization_members (organization_id, profile_id, role)
  VALUES (v_org, v_user, 'admin');
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Rollback Park')
  RETURNING id INTO v_loc;
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_loc, 'Imported Booked Pitch', true) RETURNING id INTO v_booked;
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_loc, 'Imported Free Pitch', true) RETURNING id INTO v_free;

  INSERT INTO public.season_settings (organization_id, name)
  VALUES (v_org, 'Rollback Season') RETURNING id INTO v_season;
  INSERT INTO public.divisions (organization_id, season_settings_id, name)
  VALUES (v_org, v_season, 'Rollback Division') RETURNING id INTO v_div;
  INSERT INTO public.teams (organization_id, division_id, name)
  VALUES (v_org, v_div, 'Rollback Team') RETURNING id INTO v_team;

  INSERT INTO public.practice_assignments
    (organization_id, team_id, field_id, effective_date_range)
  VALUES (v_org, v_team, v_booked, daterange(current_date, current_date + 60, '[]'))
  RETURNING id INTO v_pa;

  INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, created_by)
  VALUES (v_org, 'fields', 'imports/rollback-guard/fields.csv', 'completed', v_user)
  RETURNING id INTO v_job;
  INSERT INTO public.import_application_records
    (organization_id, import_job_id, import_type, target_table, target_id, operation, applied_by)
  VALUES
    (v_org, v_job, 'fields', 'fields', v_booked, 'inserted', v_user),
    (v_org, v_job, 'fields', 'fields', v_free,   'inserted', v_user);

  -- 5a. The booked field is refused BY NAME; the free one rolls back.
  v_res := public.rollback_field_import_job(v_job);
  IF (v_res->>'blocked_records')::int <> 1 THEN
    RAISE EXCEPTION 'expected 1 blocked record, got %: %', v_res->>'blocked_records', v_res; END IF;
  IF (v_res->>'deleted_fields')::int <> 1 THEN
    RAISE EXCEPTION 'expected the unbooked field to roll back, got %: %', v_res->>'deleted_fields', v_res; END IF;
  IF v_res->>'status' <> 'completed_with_warnings' THEN
    RAISE EXCEPTION 'a partially blocked rollback reported status %', v_res->>'status'; END IF;

  SELECT x INTO v_blocked FROM jsonb_array_elements(v_res->'blocked') x LIMIT 1;
  IF v_blocked IS NULL THEN
    RAISE EXCEPTION 'blocked_records counted 1 and the blocked list is empty'; END IF;
  IF (v_blocked->>'target_id')::uuid <> v_booked THEN
    RAISE EXCEPTION 'the blocked record names %, not the booked field', v_blocked->>'target_id'; END IF;
  IF v_blocked->>'reason' <> 'bookings_exist' THEN
    RAISE EXCEPTION 'the blocked record gives reason %', v_blocked->>'reason'; END IF;
  IF (v_blocked->>'affected_count')::int <> 1 THEN
    RAISE EXCEPTION 'the blocked record counted % bookings, expected 1', v_blocked->>'affected_count'; END IF;

  -- **The refusal wrote nothing to the ground it refused.** A guard that
  -- reports a refusal and half-applies is worse than no guard. Counted from
  -- the tables themselves, never from the field, which is the row a break
  -- would remove.
  IF NOT EXISTS (SELECT 1 FROM public.fields WHERE id = v_booked) THEN
    RAISE EXCEPTION 'the refused field was deleted anyway'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.practice_assignments WHERE id = v_pa) THEN
    RAISE EXCEPTION 'the booking the refusal was about was destroyed'; END IF;
  SELECT count(*) INTO v_n FROM public.practice_assignments
   WHERE id = v_pa AND field_id = v_booked;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the refused rollback unassigned the booking it refused over'; END IF;
  IF EXISTS (SELECT 1 FROM public.fields WHERE id = v_free) THEN
    RAISE EXCEPTION 'the unbooked field was not rolled back'; END IF;

  -- 5b. **Refusal means DEFERRAL.** The record kept `rolled_back_at IS NULL`,
  -- so clearing the booking and re-running rolls it back. Same disposition
  -- LIVE-2 argued for in finalize_field_availability_import_job, and the
  -- reason the refusal is not simply an exception.
  SELECT count(*) INTO v_n FROM public.import_application_records
   WHERE import_job_id = v_job AND target_id = v_booked AND rolled_back_at IS NULL;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the blocked record was stamped rolled back; the refusal is not replayable'; END IF;

  DELETE FROM public.practice_assignments WHERE id = v_pa;
  v_res := public.rollback_field_import_job(v_job);
  IF (v_res->>'deleted_fields')::int <> 1 OR (v_res->>'blocked_records')::int <> 0 THEN
    RAISE EXCEPTION 'the replay did not roll back the freed field: %', v_res; END IF;
  IF v_res->>'status' <> 'rolled_back' THEN
    RAISE EXCEPTION 'a clean replay reported status %', v_res->>'status'; END IF;
  IF EXISTS (SELECT 1 FROM public.fields WHERE id = v_booked) THEN
    RAISE EXCEPTION 'the replay reported a delete and the field is still there'; END IF;

  -- 5c. **An unhandled target_table raises rather than lying to the ledger.**
  -- `field_availability_profiles` is a legal `target_table` (20260522120000)
  -- that this rollback cannot undo, so it is the reachable case rather than a
  -- hypothetical one.
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_loc, 'Profile Pitch', true) RETURNING id INTO v_free;
  INSERT INTO public.field_availability_profiles
    (organization_id, field_id, season_label, location, field_name, available_from, available_until)
  VALUES (v_org, v_free, '2099', 'Rollback Park', 'Profile Pitch',
          current_date, current_date + 200)
  RETURNING id INTO v_profile;
  INSERT INTO public.import_application_records
    (organization_id, import_job_id, import_type, target_table, target_id, operation, applied_by)
  VALUES (v_org, v_job, 'fields', 'field_availability_profiles', v_profile, 'inserted', v_user);
  BEGIN
    v_res := public.rollback_field_import_job(v_job);
    RAISE EXCEPTION 'an unhandled target_table was accepted and reported as rolled back: %', v_res;
  EXCEPTION WHEN sqlstate '22023' THEN
    NULL;
  END;
  -- And it changed nothing on the way past.
  SELECT count(*) INTO v_n FROM public.import_application_records
   WHERE import_job_id = v_job AND target_id = v_profile AND rolled_back_at IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the refused record was stamped rolled back anyway'; END IF;

  RAISE NOTICE 'rollback guard exercised: 1 refused with a reason, 1 rolled back, 1 replayed, 1 unhandled table raised';
  DELETE FROM public.organizations WHERE id = v_org;
  DELETE FROM auth.users WHERE id = v_user;
END $$;

-- ---------------------------------------------------------------------------
-- 6. THE DELETE, CALLED: the profile is reported, and destroyed with its parts
-- ---------------------------------------------------------------------------
--
-- LIVE-2 measured the pre-fix state precisely -- `field_id NULL`, the blackout
-- window still attached, `affected_count: 0` -- so all three are asserted here
-- rather than only the headline one.
DO $$
DECLARE
  v_org uuid; v_user uuid := gen_random_uuid();
  v_loc uuid; v_field uuid; v_other uuid;
  v_profile uuid; v_window uuid; v_stale uuid;
  v_res jsonb; v_n int; v_row jsonb;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'profile-guard@example.test', jsonb_build_object('password_length', 16))
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (name, slug)
  VALUES ('Profile Guard Org','profile-guard-org') RETURNING id INTO v_org;
  INSERT INTO public.profiles (id, email) VALUES (v_user, 'profile-guard@example.test')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organization_members (organization_id, profile_id, role)
  VALUES (v_org, v_user, 'admin');
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Profile Park')
  RETURNING id INTO v_loc;
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_loc, 'Profiled Pitch', true) RETURNING id INTO v_field;
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_loc, 'Neighbouring Pitch', true) RETURNING id INTO v_other;

  INSERT INTO public.field_availability_profiles
    (organization_id, field_id, season_label, location, field_name, available_from, available_until)
  VALUES (v_org, v_field, '2099', 'Profile Park', 'Profiled Pitch',
          current_date, current_date + 200)
  RETURNING id INTO v_profile;
  INSERT INTO public.field_blackout_windows
    (organization_id, profile_id, blackout_from, blackout_until, reason)
  VALUES (v_org, v_profile, current_date + 10, current_date + 20, 'resurfacing')
  RETURNING id INTO v_window;
  -- **A profile on the NEIGHBOURING pitch, which must survive.** Without it a
  -- delete that emptied the whole table would satisfy every count below.
  INSERT INTO public.field_availability_profiles
    (organization_id, field_id, season_label, location, field_name, available_from, available_until)
  VALUES (v_org, v_other, '2099', 'Profile Park', 'Neighbouring Pitch',
          current_date, current_date + 200)
  RETURNING id INTO v_stale;

  -- 6a. The profile alone makes the delete refuse. Before LIVE-3 this returned
  --     `affected_count: 0` and deleted the field.
  v_res := public.admin_delete_field(v_org, v_field, false);
  IF (v_res->>'deleted')::boolean THEN
    RAISE EXCEPTION 'a field carrying an availability profile deleted without confirmation: %', v_res; END IF;
  IF (v_res->>'affected_count')::int <> 1 THEN
    RAISE EXCEPTION 'expected the profile to be the one affected row, got %: %',
      v_res->>'affected_count', v_res; END IF;
  SELECT x INTO v_row FROM jsonb_array_elements(v_res->'affected') x
   WHERE x->>'kind' = 'availability_profile';
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'the refusal did not name the availability profile: %', v_res; END IF;
  IF (v_row->>'id')::uuid <> v_profile THEN
    RAISE EXCEPTION 'the refusal named profile %, not the one on this ground', v_row->>'id'; END IF;
  IF v_row->>'disposition' <> 'deleted' THEN
    RAISE EXCEPTION 'the profile is reported as "%", but the FK cascades', v_row->>'disposition'; END IF;
  IF (v_row->>'on_date')::date <> current_date + 200 THEN
    RAISE EXCEPTION 'the profile reports on_date %, expected its available_until', v_row->>'on_date'; END IF;
  IF (v_row->>'undated')::boolean OR (v_row->>'unbounded')::boolean THEN
    RAISE EXCEPTION 'the profile reports undated/unbounded, but both its dates are NOT NULL'; END IF;

  -- 6b. A RETIREMENT judges it on the same inclusive boundary as every other
  --     arm: on the last usable day it is not stranded, a day earlier it is.
  v_res := public.admin_retire_field(v_org, v_field, (current_date + 200)::date, false);
  IF NOT (v_res ? 'retired') THEN
    RAISE EXCEPTION 'admin_retire_field returned no verdict: %', v_res; END IF;
  IF (v_res->>'affected_count')::int <> 0 THEN
    RAISE EXCEPTION 'a profile ending ON the retirement date was reported stranded: %', v_res; END IF;
  v_res := public.admin_retire_field(v_org, v_field, (current_date + 199)::date, false);
  IF (v_res->>'affected_count')::int <> 1 THEN
    RAISE EXCEPTION 'a profile outliving the retirement by a day was not reported: %', v_res; END IF;

  -- 6c. CONFIRMED: the profile and its window go, the neighbour's stays.
  v_res := public.admin_delete_field(v_org, v_field, true);
  IF NOT (v_res->>'deleted')::boolean THEN
    RAISE EXCEPTION 'a confirmed delete did not delete: %', v_res; END IF;
  IF EXISTS (SELECT 1 FROM public.field_availability_profiles WHERE id = v_profile) THEN
    RAISE EXCEPTION 'the profile survived the field; admin_delete_field is still a producer of field-less profiles'; END IF;
  IF EXISTS (SELECT 1 FROM public.field_blackout_windows WHERE id = v_window) THEN
    RAISE EXCEPTION 'the blackout window outlived the profile it hangs off'; END IF;
  SELECT count(*) INTO v_n FROM public.field_availability_profiles
   WHERE organization_id = v_org AND field_id IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% field-less profile(s) were produced by the delete', v_n; END IF;
  -- The positive anchor: the neighbour's profile is untouched, so the zeroes
  -- above are a targeted destruction and not an emptied table.
  IF NOT EXISTS (SELECT 1 FROM public.field_availability_profiles WHERE id = v_stale) THEN
    RAISE EXCEPTION 'the delete took a profile on a different pitch'; END IF;

  RAISE NOTICE 'profile guard exercised: refused on 1 profile, retirement boundary inclusive, confirmed delete took the profile and its window and left the neighbour';
  DELETE FROM public.organizations WHERE id = v_org;
  DELETE FROM auth.users WHERE id = v_user;
END $$;

-- ---------------------------------------------------------------------------
-- 7. NEITHER COMMENT STILL NAMES A CLOSED PRODUCER AS BLOCKING
-- ---------------------------------------------------------------------------
--
-- `field_closures` and `field_blackout_windows` both carried a sentence naming
-- the condition for collapsing the two blackout tables. This migration
-- satisfies the last of those conditions, so an unrewritten comment would be
-- telling the next reader to go ahead. LIVE-2's round 1 found exactly that:
-- the view's comment corrected and the table's not, in the PR about it.
DO $$
DECLARE
  v_view text;
  v_table text;
BEGIN
  SELECT obj_description('public.field_closures'::regclass, 'pg_class') INTO v_view;
  SELECT obj_description('public.field_blackout_windows'::regclass, 'pg_class') INTO v_table;
  IF v_view IS NULL OR v_table IS NULL THEN
    RAISE EXCEPTION 'one of the two comments is missing; this check has nothing to read';
  END IF;

  -- **The stale sentence, by the claim it makes.** Both used to say the
  -- obstacle was that something still CREATES field-less profiles. Both
  -- producers are closed, so any comment still saying so is out of date --
  -- and a prefix or exact-string match would not have caught the view's
  -- rewording, which is how this class went unnoticed once already.
  IF v_view LIKE '%excluded from admin_delete_field%' THEN
    RAISE EXCEPTION 'field_closures'' comment still says the profile is excluded from the delete guard';
  END IF;
  IF v_table LIKE '%deleting a field still orphans%' THEN
    RAISE EXCEPTION 'field_blackout_windows'' comment still says a delete orphans profiles';
  END IF;
  -- Both must still say the collapse is BLOCKED, for the reasons that remain.
  -- Removing the warning entirely is the other way to fail this.
  IF v_view NOT LIKE '%STILL BLOCKED%' OR v_table NOT LIKE '%STILL BLOCKED%' THEN
    RAISE EXCEPTION 'a comment stopped saying the collapse is blocked; it still is';
  END IF;
  IF v_table NOT LIKE '%FROZEN as of 20260906000100%' THEN
    RAISE EXCEPTION '20260906000100''s smoke requires this comment to open with its freeze sentence';
  END IF;
  RAISE NOTICE 'both collapse-blocker comments name what actually remains';
END $$;
