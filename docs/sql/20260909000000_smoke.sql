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
  v_lockless text;
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

  -- **The LOCK statements are removed before the arm is searched for a
  -- re-inlined list, and only those.** `PERFORM 1 FROM public.game_slots ...
  -- FOR UPDATE` legitimately names two booking tables: it is the sibling's
  -- lock (section 1b asserts all three are present), not an enumeration. A
  -- pattern that stripped anything looser would hide the defect this check
  -- exists for, so it is anchored to that exact statement shape -- `PERFORM 1
  -- FROM public.<table>` through the next semicolon, with `FOR UPDATE` in it.
  v_lockless := regexp_replace(
    v_fields_arm,
    'PERFORM 1 FROM public\.[a-z_]+[^;]+FOR UPDATE;', '', 'g');
  -- The strip must not have eaten the arm: a pattern that matched too much
  -- would satisfy every NOT LIKE below by leaving nothing.
  IF v_lockless NOT LIKE '%public.field_bookings(%' OR length(v_lockless) < 200 THEN
    RAISE EXCEPTION 'stripping the locks left % characters and no producer call; the pattern matched too much', length(v_lockless);
  END IF;

  FOREACH t IN ARRAY ARRAY['practice_slots','game_slots','games','game_assignments',
                           'practice_assignments'] LOOP
    IF v_lockless LIKE '%public.' || t || '%' THEN
      RAISE EXCEPTION
        'the fields arm reads public.% outside its locks; it has re-inlined a list beside the producer', t;
    END IF;
  END LOOP;
  -- `field_availability_profiles` is named apart from the loop above because
  -- the arm legitimately mentions it through
  -- `field_availability_scenario_ids_on_field`, which is a different question
  -- from "what is booked here" -- so the ban is on reading the TABLE, not on
  -- naming the helper.
  IF v_lockless ~ 'FROM public\.field_availability_profiles' THEN
    RAISE EXCEPTION
      'the fields arm reads public.field_availability_profiles directly; the producer is what enumerates it';
  END IF;

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

  -- A blocked record says which one and why, the trail gets a bounded
  -- rendering of them, and the CALLER gets all of them. All three, because the
  -- first two are satisfied by a function that digests the list and never
  -- returns it.
  IF v_def NOT LIKE '%''blocked'', public.field_bookings_digest(v_blocked)%' THEN
    RAISE EXCEPTION 'the audit row does not carry a bounded rendering of the blocked list';
  END IF;
  IF v_def NOT LIKE '%RETURN v_result || jsonb_build_object(''blocked'', v_blocked)%' THEN
    RAISE EXCEPTION 'the caller does not get the whole blocked list';
  END IF;
  IF v_def NOT LIKE '%''reason'', ''bookings_exist''%' THEN
    RAISE EXCEPTION 'a refused field does not name its reason';
  END IF;

  RAISE NOTICE 'rollback_field_import_job: one producer, no second list, no silent arm';
END $$;

-- 1b. THE FIELDS ARM HOLDS THE SIBLING'S THREE LOCKS, AND NO OTHER ARM HOLDS ONE
-- ---------------------------------------------------------------------------
--
-- `admin_delete_field` locks the `fields` row and then that field's
-- `game_slots` and `practice_slots` rows before it counts anything
-- (20260907000000:493, :518, :521). The rollback's fields arm locked nothing,
-- so a booking inserted between its count and its DELETE was destroyed by the
-- cascade having been counted as nothing -- one arm of a pair adopting a
-- documented contract and the other not.
--
-- **Both halves are asserted, and the second is the load-bearing one.** The
-- other four arms are deliberately unlocked: closing their races means taking
-- a SLOT or SUBUNIT lock before the loop reaches the `fields` record, which is
-- the opposite order to `admin_delete_field`'s and is a deadlock cycle rather
-- than a fix. So a lock appearing in any other arm fails here and the next
-- person is made to answer the ordering question.
--
-- **Structural only, and that is stated rather than implied.** A lock is
-- observable only from a second session and this harness runs one, so the race
-- is not reproduced. `admin_delete_field`'s identical lock has the same limit.
DO $$
DECLARE
  v_def text;
  v_fields_arm text;
  v_others text;
  t text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rollback_field_import_job';

  v_fields_arm := (regexp_match(
    v_def,
    $re$ELSIF v_record\.target_table = 'fields' THEN(.*?)ELSIF v_record\.target_table = 'locations' THEN$re$))[1];
  IF v_fields_arm IS NULL OR length(v_fields_arm) < 200 THEN
    RAISE EXCEPTION 'could not cut the fields arm; the markers have moved';
  END IF;

  -- The three, each named by the table it locks, so two of three fails.
  FOREACH t IN ARRAY ARRAY['fields','game_slots','practice_slots'] LOOP
    IF v_fields_arm !~ ('PERFORM 1 FROM public\.' || t || '[^;]+FOR UPDATE') THEN
      RAISE EXCEPTION
        'the fields arm counts bookings without locking public.%; a row inserted between the count and the DELETE is destroyed uncounted', t;
    END IF;
  END LOOP;

  -- **And nowhere else.** Everything outside the fields arm, with the arm cut
  -- out, must hold no row lock at all -- the `import_jobs` SELECT is a
  -- `FOR UPDATE` on its own line and is matched by neither pattern below.
  v_others := replace(v_def, v_fields_arm, '');
  IF v_others ~ 'PERFORM 1 FROM public\.[a-z_]+[^;]+FOR UPDATE' THEN
    RAISE EXCEPTION
      'an arm other than the fields arm now takes a row lock. Adding one means acquiring a slot or subunit BEFORE the field, which is the opposite order to admin_delete_field and a deadlock cycle. Decide the acquisition order across both functions before adding it.';
  END IF;

  RAISE NOTICE 'fields arm: 3 locks in the sibling order; no other arm locks anything';
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

-- 2b. THE LOCATION ARM, by the same argument and the same derivation
-- ---------------------------------------------------------------------------
--
-- `locations` is referenced directly by exactly two tables. `fields` is what
-- the arm refuses on, and everything else a location delete could reach hangs
-- under a field -- so refusing while any field remains cuts the closure at its
-- only other edge. `field_blackouts` is the other edge and is EXCLUDED, on
-- 20260907000000's reasoning for excluding it from the booking family: a
-- closure is not a booking, and removing a site cannot strand the statement
-- that the site was already shut.
--
-- **That edge did not exist when the arm was written.** 20260906000100 added
-- it, and nothing noticed -- which is the whole reason this is a derivation
-- rather than a sentence. A third table referencing `locations` fails here
-- instead of being destroyed in silence.
DO $$
DECLARE v_direct text[];
BEGIN
  SELECT array_agg(DISTINCT src.relname::text ORDER BY src.relname::text)
    INTO v_direct
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'public'
   WHERE con.contype = 'f' AND tgt.relname = 'locations';
  IF v_direct IS NULL OR array_length(v_direct, 1) IS NULL THEN
    RAISE EXCEPTION 'nothing references locations; this check is looking at nothing';
  END IF;
  IF v_direct <> ARRAY['field_blackouts','fields'] THEN
    RAISE EXCEPTION
      'locations is now referenced by %. The rollback''s locations arm refuses only while a FIELD remains, so decide whether the new referent is something a rollback may destroy.',
      v_direct;
  END IF;
  RAISE NOTICE 'locations referents: %, one refused on and one excluded with a reason', v_direct;
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

-- 3b. THE TWO NEW HELPERS ARE ACTUALLY INTERNAL
-- ---------------------------------------------------------------------------
--
-- **`REVOKE ... FROM PUBLIC` is not what makes a function internal here.**
-- 20260614000000 sets `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS
-- TO authenticated, service_role`, so a function created by a migration
-- arrives with `authenticated=X/postgres` on its ACL and a revoke from PUBLIC
-- leaves it there. 20260907000000's section 5c was written after its own
-- COMMENT claimed "no EXECUTE grant" while the catalogue said otherwise; these
-- two helpers arrive under the same default privilege and make the same claim,
-- so they get the same check rather than the same assumption.
--
-- The universe is the two helpers BY NAME, not "whatever has an ACL": a helper
-- that vanished would otherwise pass by having no row to examine.
DO $$
DECLARE
  r record;
  v_seen int := 0;
  v_grantees text;
BEGIN
  FOR r IN
    SELECT p.proname, p.proacl
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('field_availability_scenario_ids_on_field',
                         'prune_empty_field_availability_scenarios')
  LOOP
    v_seen := v_seen + 1;
    -- A NULL acl means "the default", which for a function is EXECUTE to
    -- PUBLIC -- the most open state of all, and the one an `IS NOT NULL` guard
    -- would skip. It is a failure, not an exemption.
    IF r.proacl IS NULL THEN
      RAISE EXCEPTION 'public.% has a DEFAULT acl, which grants EXECUTE to PUBLIC', r.proname;
    END IF;
    SELECT string_agg(a.grantee::regrole::text, ', ' ORDER BY a.grantee::regrole::text)
      INTO v_grantees
      FROM aclexplode(r.proacl) a
     WHERE a.privilege_type = 'EXECUTE'
       AND a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = current_user);
    IF v_grantees IS NOT NULL THEN
      RAISE EXCEPTION 'public.% is internal but grants EXECUTE to %', r.proname, v_grantees;
    END IF;
  END LOOP;
  IF v_seen <> 2 THEN
    RAISE EXCEPTION
      'expected both scenario helpers, examined % -- the check found nothing to check', v_seen;
  END IF;
  RAISE NOTICE 'both scenario helpers grant EXECUTE to nobody but their owner';
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
  v_confirmable int := 0;
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
    SELECT p.proname,
           pg_get_functiondef(p.oid) AS def,
           -- **The SIGNATURE, not the body text.** The first version of this
           -- read `def LIKE '%p_confirm%'` and matched a COMMENT inside the
           -- rollback explaining why it needs no prune -- a check a sentence
           -- could flip, in the file whose subject is checks that cannot be
           -- flipped by prose. A parameter name is a fact about the function.
           'p_confirm' = ANY(COALESCE(p.proargnames, ARRAY[]::text[])) AS confirmable
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY(v_deleters)
  LOOP
    IF r.def NOT LIKE '%public.field_bookings(%' THEN
      RAISE EXCEPTION '% deletes a field without consulting the shared producer', r.proname;
    END IF;
    -- **Which deleters must PRUNE is derived, not listed.** The profile FK
    -- cascades, so a delete that proceeds while profiles are attached can
    -- leave a scenario holding nothing -- and a scenario with no members is
    -- still listed by `get_field_availability_scenarios` and still activatable
    -- by `admin_select_field_availability_scenario`.
    --
    -- A deleter can only be in that position if it can OVERRIDE the refusal:
    -- without a `p_confirm` PARAMETER it reaches its DELETE only when the
    -- producer returned nothing, and `availability_profile` is one of the six
    -- kinds the producer returns. So the test is the presence of that
    -- parameter, and a deleter that grows one without growing a prune fails
    -- here.
    -- BOTH halves are demanded of the ones that need it: the capture (it reads
    -- rows the delete destroys) and the prune.
    IF r.confirmable THEN
      v_confirmable := v_confirmable + 1;
      IF r.def NOT LIKE '%public.field_availability_scenario_ids_on_field(%' THEN
        RAISE EXCEPTION
          '% can delete a field over a refusal and does not first read which scenarios its profiles belong to; the cascade removes the rows that answer it', r.proname;
      END IF;
      IF r.def NOT LIKE '%public.prune_empty_field_availability_scenarios(%' THEN
        RAISE EXCEPTION
          '% can delete a field over a refusal and can leave a scenario with no members standing', r.proname;
      END IF;
    END IF;
  END LOOP;

  -- The meta-assertion: a run where NO deleter had an override would satisfy
  -- the branch above by never entering it.
  IF v_confirmable <> 1 THEN
    RAISE EXCEPTION
      'expected exactly one field deleter with a confirmation override, found % -- the prune requirement above was applied to that many', v_confirmable;
  END IF;

  RAISE NOTICE 'field deleters: %, all on the shared producer; % with a confirmation override, and it prunes', v_deleters, v_confirmable;
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
  v_job uuid; v_job2 uuid; v_pa uuid; v_profile uuid; v_slot uuid;
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

  -- A second job, for 5d below. Its records must not be picked up by the
  -- calls in 5a-5c, which is why it is a job of its own rather than more rows
  -- on the first.
  INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, created_by)
  VALUES (v_org, 'fields', 'imports/rollback-guard/slots.csv', 'completed', v_user)
  RETURNING id INTO v_job2;

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
  IF (v_blocked->>'id')::uuid <> v_booked THEN
    RAISE EXCEPTION 'the blocked record names %, not the booked field', v_blocked->>'id'; END IF;
  IF v_blocked->>'kind' <> 'fields' THEN
    RAISE EXCEPTION 'the blocked record names kind %, not fields', v_blocked->>'kind'; END IF;
  IF v_blocked->>'reason' <> 'bookings_exist' THEN
    RAISE EXCEPTION 'the blocked record gives reason %', v_blocked->>'reason'; END IF;
  IF (v_blocked->>'affected_count')::int <> 1 THEN
    RAISE EXCEPTION 'the blocked record counted % bookings, expected 1', v_blocked->>'affected_count'; END IF;

  -- **The trail is BOUNDED and the caller's list is not.** The returned
  -- payload above carries every refusal; `warning_summary.field_rollback` and
  -- the audit row carry `field_bookings_digest` of it -- total, omitted,
  -- per-kind counts and a capped sample -- so a rollback refused on a busy
  -- season cannot write an unbounded array on every attempt. Read HERE, before
  -- the replay below overwrites it with a clean run's summary: reading it at
  -- the foot of the block reported a digest of zero and would have passed for
  -- a function that wrote no digest at all.
  SELECT warning_summary->'field_rollback'->'blocked' INTO v_blocked
    FROM public.import_jobs WHERE id = v_job;
  IF v_blocked IS NULL OR jsonb_typeof(v_blocked) <> 'object' THEN
    RAISE EXCEPTION 'warning_summary.field_rollback.blocked is not a digest object: %', v_blocked; END IF;
  IF (v_blocked->>'total')::int <> 1 THEN
    RAISE EXCEPTION 'the digest totals %, expected the one refusal', v_blocked->>'total'; END IF;
  IF v_blocked->'by_kind'->>'fields' <> '1' THEN
    RAISE EXCEPTION 'the digest does not count the refusal by kind: %', v_blocked->'by_kind'; END IF;
  -- Re-read the refusal entry from the RETURNED payload, which the digest
  -- replaced in `v_blocked` above.
  SELECT x INTO v_blocked FROM jsonb_array_elements(v_res->'blocked') x LIMIT 1;

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
  -- The arm is DEFENSIVE: `finalize_field_import_job` only ever writes the
  -- five tables the switch handles, so nothing the apply path produces reaches
  -- it. The record below is constructed directly, which is the only way to
  -- exercise a defensive arm and is said out loud rather than dressed up as a
  -- reachable case. `field_availability_profiles` is used because it is a
  -- legal value of the column (20260522120000) that this rollback genuinely
  -- cannot undo.
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

  -- 5d. **The game_slots arm, on the column it did not read.**
  -- `game_assignments` reaches a slot through `game_slot_id` AND `slot_id`,
  -- both ON DELETE CASCADE, and this arm consulted only the first while its
  -- practice sibling read both. An assignment carrying `slot_id` alone was
  -- destroyed by the rollback with nothing refusing. The row is seeded with
  -- `game_slot_id` NULL so it is invisible to the pre-fix predicate and
  -- visible to the fixed one.
  INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index)
  VALUES (v_org, v_free, current_date + 14, 1) RETURNING id INTO v_slot;
  INSERT INTO public.game_assignments
    (organization_id, field_id, slot_id, "start", week_index)
  VALUES (v_org, NULL, v_slot, (current_date + 14) + time '18:00', 1);
  INSERT INTO public.import_application_records
    (organization_id, import_job_id, import_type, target_table, target_id, operation, applied_by)
  VALUES (v_org, v_job2, 'fields', 'game_slots', v_slot, 'inserted', v_user);

  v_res := public.rollback_field_import_job(v_job2);
  IF (v_res->>'blocked_records')::int <> 1 THEN
    RAISE EXCEPTION 'a game slot held by a slot_id-only assignment was not refused: %', v_res; END IF;
  SELECT x INTO v_blocked FROM jsonb_array_elements(v_res->'blocked') x LIMIT 1;
  IF v_blocked->>'reason' <> 'game_slot_in_use' THEN
    RAISE EXCEPTION 'the game slot refusal gave reason %', v_blocked->>'reason'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.game_slots WHERE id = v_slot) THEN
    RAISE EXCEPTION 'the refused game slot was deleted anyway'; END IF;

  RAISE NOTICE 'rollback guard exercised: 1 refused with a reason, 1 rolled back, 1 replayed, 1 unhandled table raised, 1 game slot held by a slot_id-only assignment';
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
  v_lonely uuid; v_shared uuid; v_unrelated uuid;
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

  -- **Two scenarios, and only one of them may go.** `v_lonely` has this
  -- field's profile as its ONLY member, so the cascade empties it.
  -- `v_shared` has both this field's profile and the neighbour's, so it keeps
  -- a member and must survive -- without it a prune that deleted every named
  -- scenario, or every empty one in the organisation, would pass.
  INSERT INTO public.field_availability_scenarios
    (organization_id, season_label, name, exclusivity_group)
  VALUES (v_org, '2099', 'Lonely Scenario', 'grp-lonely') RETURNING id INTO v_lonely;
  INSERT INTO public.field_availability_scenarios
    (organization_id, season_label, name, exclusivity_group)
  VALUES (v_org, '2099', 'Shared Scenario', 'grp-shared') RETURNING id INTO v_shared;
  -- A third that is ALREADY empty and has nothing to do with this field. The
  -- narrow contract leaves it; an org-wide sweep would take it.
  INSERT INTO public.field_availability_scenarios
    (organization_id, season_label, name, exclusivity_group)
  VALUES (v_org, '2099', 'Unrelated Empty Scenario', 'grp-unrelated')
  RETURNING id INTO v_unrelated;
  -- **A profile on the NEIGHBOURING pitch, which must survive.** Without it a
  -- delete that emptied the whole table would satisfy every count below.
  INSERT INTO public.field_availability_profiles
    (organization_id, field_id, season_label, location, field_name, available_from, available_until)
  VALUES (v_org, v_other, '2099', 'Profile Park', 'Neighbouring Pitch',
          current_date, current_date + 200)
  RETURNING id INTO v_stale;

  INSERT INTO public.field_availability_scenario_members
    (organization_id, scenario_id, profile_id)
  VALUES (v_org, v_lonely, v_profile),
         (v_org, v_shared, v_profile),
         (v_org, v_shared, v_stale);

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

  -- 6d. **The scenario the cascade emptied is gone; the other two are not.**
  -- A scenario with no members is still listed by
  -- `get_field_availability_scenarios` and still activatable by
  -- `admin_select_field_availability_scenario`, so leaving one behind leaves
  -- an active scenario that can yield an empty availability set.
  IF EXISTS (SELECT 1 FROM public.field_availability_scenarios WHERE id = v_lonely) THEN
    RAISE EXCEPTION 'the scenario whose only member the cascade removed is still there'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.field_availability_scenarios WHERE id = v_shared) THEN
    RAISE EXCEPTION 'a scenario that still has a member was pruned'; END IF;
  -- The narrow contract, held to: an already-empty scenario this field's
  -- profiles never belonged to is NOT the delete's business.
  IF NOT EXISTS (SELECT 1 FROM public.field_availability_scenarios WHERE id = v_unrelated) THEN
    RAISE EXCEPTION 'the prune swept an empty scenario unrelated to this field'; END IF;
  IF (v_res->>'deleted_availability_scenarios')::int <> 1 THEN
    RAISE EXCEPTION 'the delete reported % pruned scenarios, expected 1',
      v_res->>'deleted_availability_scenarios'; END IF;

  RAISE NOTICE 'profile guard exercised: refused on 1 profile, retirement boundary inclusive, confirmed delete took the profile and its window, left the neighbour, pruned 1 emptied scenario and left 2 standing';
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
