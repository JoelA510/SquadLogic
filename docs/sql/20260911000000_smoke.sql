-- Smoke checks for 20260911000000_venue_subunit_effective_dating.sql
--
-- **These ASSERT rather than report.** A smoke made of bare SELECTs exits 0
-- whatever it prints. Invariants RAISE, so `scripts/dbharness/prove.sh` can
-- prove they fail when the defect is planted. Figures that are evidence rather
-- than gates stay as reporting NOTICEs and are labelled as such.
--
-- The one thing this file exists to prove, above everything else: **a venue
-- retirement asks a VENUE-SCOPED question**. Section 6 seeds bookings on TWO
-- pitches at one site and requires the refusal to name both, so the
-- field-scoped implementation -- the obvious wrong one, and the one this
-- family has written by hand three times -- fails here rather than shipping.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Structure: the columns, and the two things deliberately absent
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations','field_subunits'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t
        AND column_name = 'effective_to' AND data_type = 'date'
    ) THEN RAISE EXCEPTION '%.effective_to missing or not a date', t; END IF;

    -- `effective_from` was never shipped, here or on `fields`: nothing writes
    -- or reads one, and a column with an index and no writer reads as
    -- load-bearing while being decoration.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'effective_from'
    ) THEN RAISE EXCEPTION '%.effective_from exists; it has no writer and no reader', t; END IF;

    -- **No `active`, and therefore no trigger.** 20260906000000 keeps
    -- `fields.active` only because the shipped scheduler filtered on it, and
    -- spends eighty lines bounding the hazard of two columns saying one thing.
    -- Giving these tables one would be manufacturing that hazard on purpose.
    -- The absence is a decision (20260911000000 section 3), so it is asserted
    -- rather than left to be noticed.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'active'
    ) THEN
      RAISE EXCEPTION
        '%.active exists; effective_to is then a second opinion and needs the trigger 20260906000000 had to write for fields', t;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t
        AND tg.tgname LIKE '%retirement%'
    ) THEN
      RAISE EXCEPTION '% carries a retirement trigger but has no second column for one to reconcile', t;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='idx_locations_effective_to')
  THEN RAISE EXCEPTION 'idx_locations_effective_to missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND indexname='idx_field_subunits_effective_to')
  THEN RAISE EXCEPTION 'idx_field_subunits_effective_to missing'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. The producer is SCOPED, and there is still only one of it
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_args text; v_n int; r record;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='field_bookings';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one public.field_bookings, found % -- an overload is two answers', v_n;
  END IF;

  -- `oidvectortypes`, not `pg_get_function_identity_arguments`: the latter
  -- includes parameter NAMES, so it compares a signature against a spelling
  -- and fails on a rename that changes nothing a caller can see.
  SELECT oidvectortypes(p.proargtypes) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='field_bookings';
  IF v_args <> 'uuid, uuid, date, text' THEN
    RAISE EXCEPTION 'field_bookings has signature (%), expected (uuid, uuid, date, text)', v_args;
  END IF;

  -- **The five RPCs that ask the question all ask it here.** Two of them are
  -- new in this migration; three predate it. A sixth reading of "what is
  -- booked on this ground" is the defect class this whole family exists
  -- around, so an RPC that grows its own union fails the run.
  v_n := 0;
  FOR r IN
    SELECT p.proname, p.prosrc AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('admin_retire_field','admin_delete_field',
                         'rollback_field_import_job','admin_retire_location',
                         'admin_retire_field_subunit')
  LOOP
    v_n := v_n + 1;
    IF r.src NOT LIKE '%public.field_bookings(%' THEN
      RAISE EXCEPTION '% does not enumerate through the shared producer', r.proname;
    END IF;
    IF r.src LIKE '%UNION ALL%' THEN
      RAISE EXCEPTION '% has a union of its own; there are two answers again', r.proname;
    END IF;
  END LOOP;
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'expected 5 callers of the producer, examined % -- the loop found nothing to check', v_n;
  END IF;

  -- **The three pre-existing callers pass NO scope**, which is what makes
  -- leaving their 619 lines untouched safe. If one of them ever starts naming
  -- a scope it must be read rather than assumed, so this fails and says so.
  FOR r IN
    SELECT p.proname, p.prosrc AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('admin_retire_field','admin_delete_field','rollback_field_import_job')
  LOOP
    IF r.src LIKE '%field_bookings(%''location''%' OR r.src LIKE '%field_bookings(%''subunit''%' THEN
      RAISE EXCEPTION '% now names a scope; its call site needs reading, not a default', r.proname;
    END IF;
  END LOOP;

  -- And the two new ones DO name theirs, by name, in the call.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='admin_retire_location'
                    AND p.prosrc LIKE '%''location'')%')
  THEN RAISE EXCEPTION 'admin_retire_location does not pass the location scope explicitly'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='admin_retire_field_subunit'
                    AND p.prosrc LIKE '%''subunit'')%')
  THEN RAISE EXCEPTION 'admin_retire_field_subunit does not pass the subunit scope explicitly'; END IF;

  RAISE NOTICE 'one scoped producer, 5 callers, 3 of them scope-free by default and 2 naming their scope';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Hardening and grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; v_n int := 0; v_grantees text;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef,
           COALESCE(array_to_string(p.proconfig, ','), '') AS cfg,
           p.prosrc AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('admin_retire_location','admin_unretire_location',
                         'admin_retire_field_subunit','admin_unretire_field_subunit')
  LOOP
    v_n := v_n + 1;
    IF NOT r.prosecdef THEN RAISE EXCEPTION '% is not SECURITY DEFINER', r.proname; END IF;
    IF r.cfg NOT LIKE '%search_path=public%' THEN
      RAISE EXCEPTION '% does not pin search_path', r.proname; END IF;
    IF r.src NOT LIKE '%is_org_admin%' THEN
      RAISE EXCEPTION '% does not gate on is_org_admin', r.proname; END IF;
    IF r.src NOT LIKE '%42501%' THEN RAISE EXCEPTION '% does not raise 42501', r.proname; END IF;
    IF r.src NOT LIKE '%''phase'', ''before''%' THEN
      RAISE EXCEPTION '% does not audit before', r.proname; END IF;
    IF r.src NOT LIKE '%''phase'', ''after''%' THEN
      RAISE EXCEPTION '% does not audit after', r.proname; END IF;
    IF r.src NOT LIKE '%FOR UPDATE%' THEN
      RAISE EXCEPTION '% does not lock the row it decides about', r.proname; END IF;
  END LOOP;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'expected 4 lifecycle RPCs, examined %', v_n; END IF;

  -- Both retire arms refuse a NULL confirmation. A bare `NOT p_confirm` let
  -- `p_confirm => NULL` retire booked ground unconfirmed; that was one of the
  -- two live defects folded into LIVE-1, and it is pinned here for its twins.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='admin_retire_location'
                    AND p.prosrc LIKE '%NOT COALESCE(p_confirm, false)%')
  THEN RAISE EXCEPTION 'admin_retire_location treats a NULL confirmation as yes'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='admin_retire_field_subunit'
                    AND p.prosrc LIKE '%NOT COALESCE(p_confirm, false)%')
  THEN RAISE EXCEPTION 'admin_retire_field_subunit treats a NULL confirmation as yes'; END IF;

  -- **The retire arms carry NO disposition**, matching 20260906000000. A
  -- retirement writes a date and destroys nothing, so "what would happen to
  -- this row" has no answer to give, and inventing one puts a claim the
  -- database never made in front of the person deciding.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public'
                AND p.proname IN ('admin_retire_location','admin_retire_field_subunit')
                AND p.prosrc LIKE '%disposition%')
  THEN RAISE EXCEPTION 'a retire arm reports a disposition; a retirement destroys nothing'; END IF;

  -- **No `contained` key on the sub-surface arm.** A sub-surface is the leaf
  -- of the estate. An empty key would be a promise with no producer, and the
  -- difference between "nothing below" and "nobody looked" is the whole point.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public'
                AND p.proname IN ('admin_retire_field_subunit','admin_unretire_field_subunit')
                AND p.prosrc LIKE '%contained%')
  THEN RAISE EXCEPTION 'a sub-surface arm reports a containment set; it contains nothing'; END IF;

  -- The two new internals grant EXECUTE to nobody, like their siblings.
  v_n := 0;
  FOR r IN
    SELECT p.proname, p.proacl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname IN ('estate_scope_covers','estate_contained_nodes')
  LOOP
    v_n := v_n + 1;
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
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected both new internals, examined %', v_n; END IF;

  -- The four operator-facing RPCs must be callable by `authenticated` and not
  -- by PUBLIC.
  IF has_function_privilege('public','public.admin_retire_location(uuid, uuid, date, boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'PUBLIC must not execute admin_retire_location'; END IF;
  IF NOT has_function_privilege('authenticated','public.admin_retire_location(uuid, uuid, date, boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'authenticated must execute admin_retire_location'; END IF;
  IF has_function_privilege('public','public.admin_retire_field_subunit(uuid, uuid, date, boolean)','EXECUTE')
  THEN RAISE EXCEPTION 'PUBLIC must not execute admin_retire_field_subunit'; END IF;
  IF NOT has_function_privilege('authenticated','public.admin_unretire_field_subunit(uuid, uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'authenticated must execute admin_unretire_field_subunit'; END IF;

  RAISE NOTICE 'four lifecycle RPCs hardened, two internals ungranted, both retire arms disposition-free';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Why four arms are EMPTY at subunit scope -- read from the schema
-- ---------------------------------------------------------------------------
--
-- At `subunit` scope the game_slot, game, game_assignment and
-- availability_profile arms match nothing. **That is a claim about the
-- schema**, not an oversight, and asserting it from `information_schema` is
-- what makes it one: if `game_slots` ever gains a `field_subunit_id`, its arm
-- has to be revisited and this fails until somebody does.
DO $$
DECLARE t text; v_n int := 0; v_named text[];
BEGIN
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO v_named
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.column_name = 'field_subunit_id';

  IF v_named IS NULL THEN
    RAISE EXCEPTION 'no table names a sub-surface at all; the subunit scope can never match anything';
  END IF;
  IF v_named <> ARRAY['practice_slots'] THEN
    RAISE EXCEPTION
      'field_subunit_id now appears on %, not just practice_slots. The subunit arm of public.field_bookings reaches only practice_slots, so every new one is a booking the guard cannot see.',
      v_named;
  END IF;

  FOREACH t IN ARRAY ARRAY['game_slots','games','game_assignments','field_availability_profiles'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name=t AND column_name='field_subunit_id')
    THEN RAISE EXCEPTION '% can name a sub-surface now; its arm passes NULL and would miss it', t; END IF;
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 4 THEN RAISE EXCEPTION 'checked % arms, expected 4', v_n; END IF;

  -- And the cascade that makes the subunit arm's `cascades` true.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname='public'
   WHERE con.contype='f' AND src.relname='practice_slots'
     AND tgt.relname='field_subunits' AND con.confdeltype='c'
  ) THEN
    RAISE EXCEPTION 'practice_slots does not CASCADE from field_subunits; the arm claims a destruction that does not happen';
  END IF;

  RAISE NOTICE 'subunit scope: 1 table names a sub-surface, 4 arms structurally empty, cascade confirmed';
END $$;

-- ---------------------------------------------------------------------------
-- 5. An unknown scope is REFUSED, not answered with an empty set
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_org uuid := gen_random_uuid(); v_caught int := 0;
BEGIN
  BEGIN
    PERFORM * FROM public.field_bookings(v_org, v_org, NULL, 'venue');
    RAISE EXCEPTION 'a typo scope returned a result set instead of refusing';
  EXCEPTION WHEN invalid_parameter_value THEN v_caught := v_caught + 1;
  END;
  BEGIN
    PERFORM * FROM public.field_bookings(v_org, v_org, NULL, NULL);
    RAISE EXCEPTION 'a NULL scope returned a result set instead of refusing';
  EXCEPTION WHEN invalid_parameter_value THEN v_caught := v_caught + 1;
  END;
  BEGIN
    PERFORM * FROM public.field_bookings(v_org, NULL, NULL, 'field');
    RAISE EXCEPTION 'a NULL scope id returned a result set instead of refusing';
  EXCEPTION WHEN invalid_parameter_value THEN v_caught := v_caught + 1;
  END;
  IF v_caught <> 3 THEN RAISE EXCEPTION 'expected 3 refusals, got %', v_caught; END IF;
  RAISE NOTICE 'the producer refuses an unknown scope, a NULL scope and a NULL scope id (3 of 3)';
END $$;

-- ---------------------------------------------------------------------------
-- 6. THE RPCs, called rather than read
-- ---------------------------------------------------------------------------
--
-- Sections 1-5 read the functions. Reading says nothing about what they do.
--
-- The estate: ONE venue with TWO pitches, each carrying a booking, and a
-- sub-surface on the first pitch carrying a third. A SECOND venue with its own
-- booked pitch is the control -- nothing this file does may touch it, and a
-- location filter that leaked would show up as its booking in a refusal.
DO $$
DECLARE
  v_org uuid; v_user uuid := gen_random_uuid();
  v_venue uuid; v_other_venue uuid;
  v_pitch_a uuid; v_pitch_b uuid; v_other_pitch uuid;
  v_sub uuid;
  v_season uuid; v_div uuid; v_team uuid;
  v_gs_a uuid; v_ps_b uuid; v_ps_sub uuid; v_gs_other uuid;
  v_res jsonb; v_n int; v_fields int; v_audit int; v_kinds text[];
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'estate-guard@example.test', jsonb_build_object('password_length', 16))
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (name, slug) VALUES ('Estate Guard Org','estate-guard-org')
  RETURNING id INTO v_org;
  INSERT INTO public.profiles (id, email) VALUES (v_user, 'estate-guard@example.test')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organization_members (organization_id, profile_id, role)
  VALUES (v_org, v_user, 'admin');
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Estate Park')
  RETURNING id INTO v_venue;
  INSERT INTO public.locations (organization_id, name) VALUES (v_org, 'Control Park')
  RETURNING id INTO v_other_venue;

  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_venue, 'Estate Pitch A', true) RETURNING id INTO v_pitch_a;
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_venue, 'Estate Pitch B', true) RETURNING id INTO v_pitch_b;
  INSERT INTO public.fields (organization_id, location_id, name, active)
  VALUES (v_org, v_other_venue, 'Control Pitch', true) RETURNING id INTO v_other_pitch;

  INSERT INTO public.field_subunits (organization_id, field_id, label)
  VALUES (v_org, v_pitch_a, 'Estate Pitch A North') RETURNING id INTO v_sub;

  INSERT INTO public.season_settings (organization_id, name)
  VALUES (v_org, 'Estate Season') RETURNING id INTO v_season;
  INSERT INTO public.divisions (organization_id, season_settings_id, name)
  VALUES (v_org, v_season, 'Estate Division') RETURNING id INTO v_div;
  INSERT INTO public.teams (organization_id, division_id, name)
  VALUES (v_org, v_div, 'Estate Team') RETURNING id INTO v_team;

  -- One booking per pitch, on DIFFERENT pitches of the same venue. This is the
  -- pair that a field-scoped venue guard cannot both see.
  INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index)
  VALUES (v_org, v_pitch_a, current_date + 40, 1) RETURNING id INTO v_gs_a;
  INSERT INTO public.practice_slots (organization_id, field_id, day_of_week, start_time, end_time, valid_until)
  VALUES (v_org, v_pitch_b, 'tue', '18:00', '19:30', current_date + 50) RETURNING id INTO v_ps_b;
  -- A slot NAMING the sub-surface. Note it also carries pitch A's field_id,
  -- which is NOT NULL -- so it is in scope for the venue, for pitch A and for
  -- the sub-surface, and the game slot above is in scope for the first two
  -- only. That asymmetry is what section 6d measures.
  INSERT INTO public.practice_slots
    (organization_id, field_id, field_subunit_id, day_of_week, start_time, end_time, valid_until)
  VALUES (v_org, v_pitch_a, v_sub, 'wed', '17:00', '18:30', current_date + 60)
  RETURNING id INTO v_ps_sub;
  -- The control venue's booking. Nothing below may ever report it.
  INSERT INTO public.game_slots (organization_id, field_id, slot_date, week_index)
  VALUES (v_org, v_other_pitch, current_date + 40, 1) RETURNING id INTO v_gs_other;

  -- 6a. An UNCONFIRMED venue retirement is REFUSED and names BOTH pitches.
  v_res := public.admin_retire_location(v_org, v_venue, current_date + 10, false);
  IF (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'admin_retire_location retired booked ground without confirmation: %', v_res; END IF;
  IF v_res->>'reason' <> 'bookings_after_effective_to' THEN
    RAISE EXCEPTION 'refusal did not name bookings_after_effective_to: %', v_res; END IF;
  -- game slot on A, practice slot on B, practice slot on the sub-surface of A.
  IF (v_res->>'affected_count')::int <> 3 THEN
    RAISE EXCEPTION 'expected 3 affected bookings across the venue, got %: %',
      v_res->>'affected_count', v_res; END IF;

  -- **THE assertion this file exists for.** The affected list must span more
  -- than one pitch. A field-scoped implementation -- the one this codebase has
  -- hand-written three times -- returns rows from a single field_id and fails
  -- right here.
  SELECT count(DISTINCT x->>'field_id') INTO v_fields
    FROM jsonb_array_elements(v_res->'affected') x;
  IF v_fields < 2 THEN
    RAISE EXCEPTION
      'the venue refusal names % pitch(es); a venue-scoped question must reach every field at the site, not one',
      v_fields; END IF;

  -- The control venue's booking must not be in it.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'affected') x
              WHERE x->>'id' = v_gs_other::text) THEN
    RAISE EXCEPTION 'the venue refusal reached another venue''s booking; the location filter leaks'; END IF;

  -- No disposition on a retire arm.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'affected') x
              WHERE x ? 'disposition') THEN
    RAISE EXCEPTION 'a retirement reported a disposition; it destroys nothing'; END IF;

  -- Containment is reported with the refusal: 2 fields + 1 sub-surface.
  IF jsonb_array_length(v_res->'contained') <> 3 THEN
    RAISE EXCEPTION 'expected 3 contained nodes (2 fields, 1 sub-surface), got %: %',
      jsonb_array_length(v_res->'contained'), v_res->'contained'; END IF;
  IF (v_res->>'contained_count')::int <> 3 THEN
    RAISE EXCEPTION 'expected contained_count 3 (none already retired), got %', v_res->>'contained_count'; END IF;

  -- And it wrote NOTHING.
  IF (SELECT effective_to FROM public.locations WHERE id = v_venue) IS NOT NULL THEN
    RAISE EXCEPTION 'the refusal wrote the date anyway'; END IF;

  SELECT count(*) INTO v_audit FROM public.audit_log
   WHERE organization_id = v_org AND resource_id = v_venue
     AND metadata->>'operation' = 'admin_retire_location'
     AND metadata->>'phase' = 'refused';
  IF v_audit <> 1 THEN RAISE EXCEPTION 'expected 1 refused audit row, got %', v_audit; END IF;

  -- 6b. The boundary is INCLUSIVE, and it is measured on both sides.
  --     The last booking at this venue is the sub-surface practice at +60.
  v_res := public.admin_retire_location(v_org, v_venue, current_date + 60, false);
  IF NOT (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'a retirement ON the last booked day must proceed: %', v_res; END IF;
  IF (v_res->>'affected_count')::int <> 0 THEN
    RAISE EXCEPTION 'a retirement on the boundary stranded %', v_res->>'affected_count'; END IF;
  PERFORM public.admin_unretire_location(v_org, v_venue);

  v_res := public.admin_retire_location(v_org, v_venue, current_date + 59, false);
  IF (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'a retirement the day before the last booking must refuse: %', v_res; END IF;
  IF (v_res->>'affected_count')::int <> 1 THEN
    RAISE EXCEPTION 'expected exactly the +60 practice stranded, got %', v_res->>'affected_count'; END IF;

  -- 6c. CONFIRMED: the venue's own row is written and NO CHILD IS TOUCHED.
  v_res := public.admin_retire_location(v_org, v_venue, current_date + 10, true);
  IF NOT (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'a confirmed retirement did not proceed: %', v_res; END IF;
  IF (SELECT effective_to FROM public.locations WHERE id = v_venue) <> current_date + 10 THEN
    RAISE EXCEPTION 'the venue date was not written'; END IF;

  -- **Containment, not copy-down.** This is the decision of 20260911000000
  -- section 2 made falsifiable: an implementation that pushed the date onto
  -- the children would pass every other assertion in this file and fail here.
  SELECT count(*) INTO v_n FROM public.fields
   WHERE location_id = v_venue AND effective_to IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the venue retirement wrote a date onto % field(s); containment is resolved on read, never copied', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.field_subunits su
   JOIN public.fields f ON f.id = su.field_id
   WHERE f.location_id = v_venue AND su.effective_to IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the venue retirement wrote a date onto % sub-surface(s)', v_n; END IF;
  -- Nor did it deactivate anything. `fields.active` means "deactivated on its
  -- own account", and a venue retirement is not that decision.
  SELECT count(*) INTO v_n FROM public.fields
   WHERE location_id = v_venue AND active IS DISTINCT FROM true;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the venue retirement deactivated % field(s)', v_n; END IF;
  -- And the control venue is untouched, both its date and its pitch.
  IF (SELECT effective_to FROM public.locations WHERE id = v_other_venue) IS NOT NULL THEN
    RAISE EXCEPTION 'the control venue was retired too'; END IF;

  -- 6d. The SUB-SURFACE scope is NARROWER than its pitch.
  --     The game slot on pitch A at +40 is NOT a booking on the half.
  v_res := public.admin_retire_field_subunit(v_org, v_sub, current_date + 10, false);
  IF (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'the sub-surface retired over a booking without confirmation: %', v_res; END IF;
  IF (v_res->>'affected_count')::int <> 1 THEN
    RAISE EXCEPTION 'expected exactly the slot naming the sub-surface, got %: %',
      v_res->>'affected_count', v_res; END IF;
  IF (v_res->'affected'->0->>'id') <> v_ps_sub::text THEN
    RAISE EXCEPTION 'the sub-surface refusal named % rather than the slot that names it',
      v_res->'affected'->0->>'id'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'affected') x
              WHERE x->>'id' = v_gs_a::text) THEN
    RAISE EXCEPTION
      'the sub-surface refusal reported a game on the FULL pitch; a half is not the whole and this refuses retirements that strand nothing'; END IF;
  IF v_res ? 'contained' THEN
    RAISE EXCEPTION 'the sub-surface arm reported a containment set; it is the leaf of the estate'; END IF;

  v_res := public.admin_retire_field_subunit(v_org, v_sub, current_date + 60, false);
  IF NOT (v_res->>'retired')::boolean THEN
    RAISE EXCEPTION 'a sub-surface retirement on the boundary must proceed: %', v_res; END IF;
  IF (SELECT effective_to FROM public.field_subunits WHERE id = v_sub) <> current_date + 60 THEN
    RAISE EXCEPTION 'the sub-surface date was not written'; END IF;
  -- Its parent pitch is untouched: retiring downward writes nothing upward.
  IF (SELECT effective_to FROM public.fields WHERE id = v_pitch_a) IS NOT NULL THEN
    RAISE EXCEPTION 'retiring a sub-surface retired its parent pitch'; END IF;

  -- 6e. `already_retired`: the sub-surface now has its own EARLIER date, so a
  --     venue retirement after it does not claim credit for closing it.
  PERFORM public.admin_unretire_location(v_org, v_venue);
  v_res := public.admin_retire_location(v_org, v_venue, current_date + 90, true);
  SELECT count(*) INTO v_n FROM jsonb_array_elements(v_res->'contained') x
   WHERE (x->>'already_retired')::boolean;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected the sub-surface to be reported already_retired, got % such node(s): %',
      v_n, v_res->'contained'; END IF;
  IF (v_res->>'contained_count')::int <> 2 THEN
    RAISE EXCEPTION 'contained_count must exclude the already-retired node; got %',
      v_res->>'contained_count'; END IF;

  -- 6f. Unretire is the exact inverse: the date goes, the children that had
  --     their own dates keep them.
  v_res := public.admin_unretire_location(v_org, v_venue);
  IF (SELECT effective_to FROM public.locations WHERE id = v_venue) IS NOT NULL THEN
    RAISE EXCEPTION 'unretire did not clear the venue date'; END IF;
  IF (SELECT effective_to FROM public.field_subunits WHERE id = v_sub) IS NULL THEN
    RAISE EXCEPTION 'unretiring the venue cleared a sub-surface date it never wrote'; END IF;
  PERFORM public.admin_unretire_field_subunit(v_org, v_sub);
  IF (SELECT effective_to FROM public.field_subunits WHERE id = v_sub) IS NOT NULL THEN
    RAISE EXCEPTION 'unretire did not clear the sub-surface date'; END IF;

  -- 6g. A stranger's venue is NOT FOUND rather than forbidden-by-another-name,
  --     and the same for an unknown id.
  BEGIN
    PERFORM public.admin_retire_location(v_org, v_other_pitch, current_date + 10, false);
    RAISE EXCEPTION 'a field id was accepted as a venue id';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM public.admin_retire_field_subunit(v_org, v_pitch_a, current_date + 10, false);
    RAISE EXCEPTION 'a field id was accepted as a sub-surface id';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;

  -- Meta: every kind the venue refusal reported, and the audit vocabulary.
  SELECT array_agg(DISTINCT x->>'kind' ORDER BY x->>'kind') INTO v_kinds
    FROM jsonb_array_elements(
           public.admin_retire_location(v_org, v_venue, current_date, false)->'affected') x;
  IF v_kinds IS NULL OR array_length(v_kinds, 1) < 2 THEN
    RAISE EXCEPTION 'the venue guard reported % kind(s); a venue holds more than one', v_kinds; END IF;

  SELECT count(*) INTO v_audit FROM public.audit_log
   WHERE organization_id = v_org
     AND metadata->>'operation' IN ('admin_retire_location','admin_unretire_location',
                                    'admin_retire_field_subunit','admin_unretire_field_subunit');
  IF v_audit < 1 THEN RAISE EXCEPTION 'the lifecycle RPCs wrote no audit rows at all'; END IF;

  RAISE NOTICE
    'estate guard exercised: venue refusal spanned % pitch(es) over % kind(s), 3 contained nodes reported, sub-surface refusal narrowed to 1 of 2 bookings on its pitch, % audit rows',
    v_fields, array_length(v_kinds, 1), v_audit;
END $$;
