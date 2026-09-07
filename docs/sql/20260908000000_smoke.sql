-- Smoke checks for 20260908000000_field_availability_profile_field_resolution.sql
--
-- **These ASSERT rather than report.** A smoke made of bare SELECTs exits 0
-- whatever it prints -- which is what `docs/sql/20260602000000_smoke.sql`, the
-- smoke on the very function this migration fixes, does: four SELECTs, no
-- RAISE, green for three years against a body with no NOT FOUND guard in it.
-- Every invariant below RAISEs, so `scripts/dbharness/prove.sh` can plant the
-- defect each one exists to catch and require this file to go red.
--
-- Section 6 is the one that matters: it CALLS the function. Sections 1-5 read
-- it, and reading a function says nothing about what it does.
--
-- Figures that are evidence rather than gates are reporting NOTICEs, labelled.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The function, its hardening, and the guard named in its body
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finalize_field_availability_import_job';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one public.finalize_field_availability_import_job, found % -- a second overload is a route round the guard', v_n;
  END IF;

  SELECT p.prosecdef,
         COALESCE(array_to_string(p.proconfig, ','), '') AS cfg,
         p.prosrc AS src
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finalize_field_availability_import_job';

  IF NOT r.prosecdef THEN
    RAISE EXCEPTION 'finalize_field_availability_import_job is not SECURITY DEFINER'; END IF;
  IF r.cfg NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'finalize_field_availability_import_job does not pin search_path'; END IF;
  IF r.src NOT LIKE '%is_org_admin%' THEN
    RAISE EXCEPTION 'finalize_field_availability_import_job does not gate on is_org_admin'; END IF;

  -- The guard names its reason in a form a caller can branch on, rather than
  -- only in prose a caller would have to parse.
  IF r.src NOT LIKE '%field_unresolved%' THEN
    RAISE EXCEPTION 'finalize_field_availability_import_job does not name the field_unresolved refusal; the resolution guard is gone'; END IF;
  IF r.src NOT LIKE '%unresolved_field_rows%' THEN
    RAISE EXCEPTION 'finalize_field_availability_import_job does not report unresolved_field_rows'; END IF;

  -- **20260602000000's guarantee, enforced for the first time.** Its own smoke
  -- is four bare SELECTs and cannot go red, and it is not in run.sh's
  -- NEW_MIGRATIONS either -- so the fix that made finalize able to complete at
  -- all has never been checked by anything that runs. This migration re-issues
  -- the same body, so the invariant is this file's to keep.
  IF position($needle$,NULL,v_now,auth.uid())$needle$ in r.src) <> 0 THEN
    RAISE EXCEPTION 'the applied_payload NULL literal from before 20260602000000 is back; finalizing a job with child rows will abort on the NOT NULL'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname='import_application_records'
       AND a.attname='applied_payload' AND a.attnotnull)
  THEN
    RAISE EXCEPTION 'import_application_records.applied_payload is no longer NOT NULL; 20260602000000 satisfied that constraint rather than relaxing it'; END IF;

  IF has_function_privilege('public','public.finalize_field_availability_import_job(uuid, jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC must not execute finalize_field_availability_import_job'; END IF;
  IF NOT has_function_privilege('authenticated','public.finalize_field_availability_import_job(uuid, jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must execute finalize_field_availability_import_job'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. field_id stays NULLABLE, and stays ON DELETE SET NULL
-- ---------------------------------------------------------------------------
--
-- **Both halves are load-bearing and they pull in opposite directions.** The
-- obvious "fix" for this defect is `SET NOT NULL` on the column, and it is
-- wrong: the FK is ON DELETE SET NULL, so a field delete would then fail or
-- cascade instead of unlinking. Pinning the pair here means the next person to
-- reach for NOT NULL is told why, by a failing check rather than by a comment.
DO $$
DECLARE v_notnull boolean; v_action char; v_seen int;
BEGIN
  SELECT a.attnotnull INTO v_notnull
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='field_availability_profiles' AND a.attname='field_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'field_availability_profiles.field_id does not exist'; END IF;
  IF v_notnull THEN
    RAISE EXCEPTION 'field_availability_profiles.field_id is NOT NULL; the ON DELETE SET NULL on fields cannot then unlink it'; END IF;

  SELECT count(*), min(con.confdeltype) INTO v_seen, v_action
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class rf ON rf.oid = con.confrelid
   WHERE n.nspname='public' AND c.relname='field_availability_profiles'
     AND con.contype='f' AND rf.relname='fields';
  IF v_seen <> 1 THEN
    RAISE EXCEPTION 'expected exactly one field_availability_profiles -> fields foreign key, examined % -- the check found nothing to check', v_seen; END IF;
  IF v_action <> 'n' THEN
    RAISE EXCEPTION 'field_availability_profiles.field_id is not ON DELETE SET NULL (confdeltype=%)', v_action; END IF;
  RAISE NOTICE 'field_id is nullable and ON DELETE SET NULL, so NULL still means "the field was deleted" and nothing else';
END $$;

-- ---------------------------------------------------------------------------
-- 3. THE FUNCTION ITSELF, called rather than read
-- ---------------------------------------------------------------------------
--
-- Three staged rows against a real organisation with real facility rows:
--
--   row 1  exact name match                 -> applied, field_id set
--   row 2  case- and spacing-differing match -> applied, field_id set
--   row 3  names a field that does not exist -> REFUSED, nothing written
--
-- Row 3 is staged AFTER the two that resolve, deliberately: `v_field_id` is a
-- single variable reused by every iteration, so a row that inherits its
-- predecessor's field would attach a closure to the wrong ground. That is a
-- worse defect than the one being fixed and it is invisible unless the order
-- puts a resolvable row first.
--
-- A same-named field in a DIFFERENT organisation is seeded too, so a
-- resolution that forgot its organization_id filter resolves row 3 and fails
-- here rather than in production.
DO $$
DECLARE
  v_org uuid; v_other_org uuid; v_user uuid := gen_random_uuid(); v_other_user uuid := gen_random_uuid();
  v_loc uuid; v_other_loc uuid; v_field_a uuid; v_field_b uuid; v_job uuid := gen_random_uuid();
  v_res jsonb; v_n int; v_profiles int; v_errs jsonb; v_reason text;
  v_row3 uuid := gen_random_uuid(); v_applied timestamptz; v_resolved uuid;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'live2-admin@example.test', jsonb_build_object('password_length', 16)),
         (v_other_user, 'live2-other@example.test', jsonb_build_object('password_length', 16))
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organizations (name, slug) VALUES ('LIVE2 Org','live2-org') RETURNING id INTO v_org;
  INSERT INTO public.organizations (name, slug) VALUES ('LIVE2 Other','live2-other') RETURNING id INTO v_other_org;
  INSERT INTO public.profiles (id, email) VALUES (v_user,'live2-admin@example.test'),
                                                 (v_other_user,'live2-other@example.test')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.organization_members (organization_id, profile_id, role)
  VALUES (v_org, v_user, 'admin'), (v_other_org, v_other_user, 'admin');
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);

  INSERT INTO public.locations (organization_id, name) VALUES (v_org,'Alder Park') RETURNING id INTO v_loc;
  INSERT INTO public.fields (organization_id, location_id, name) VALUES (v_org, v_loc, 'Main') RETURNING id INTO v_field_a;
  INSERT INTO public.fields (organization_id, location_id, name) VALUES (v_org, v_loc, 'Upper') RETURNING id INTO v_field_b;

  -- The cross-org decoy: the exact location/field row 3 asks for, in the org
  -- the caller is NOT an admin of.
  INSERT INTO public.locations (organization_id, name) VALUES (v_other_org,'Alder Park') RETURNING id INTO v_other_loc;
  INSERT INTO public.fields (organization_id, location_id, name) VALUES (v_other_org, v_other_loc, 'Ghost Pitch');

  INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, total_rows)
  VALUES (v_job, v_org, 'field_availability', 'live2/fall2026.csv', 'importing', v_user, 3);

  INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
  VALUES
    (v_org, v_job, 'field_availability', 1, '{}',
     jsonb_build_object('season_label','Fall 2026','location','Alder Park','field_name','Main',
                        'available_from','2026-08-01','available_until','2026-11-30',
                        'primary_format','7v7','blackout_months','Sep'), '[]'::jsonb),
    (v_org, v_job, 'field_availability', 2, '{}',
     jsonb_build_object('season_label','Fall 2026','location','ALDER park','field_name','uPPer',
                        'available_from','2026-08-01','available_until','2026-11-30',
                        'primary_format','9v9'), '[]'::jsonb);
  INSERT INTO public.staging_import_rows (id, organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
  VALUES
    (v_row3, v_org, v_job, 'field_availability', 3, '{}',
     jsonb_build_object('season_label','Fall 2026','location','Alder Park','field_name','Ghost Pitch',
                        'available_from','2026-08-01','available_until','2026-11-30',
                        'primary_format','11v11','blackout_months','Aug'), '[]'::jsonb);

  v_res := public.finalize_field_availability_import_job(v_job, '[]'::jsonb);

  -- 3a. The counts the function reports.
  IF (v_res->>'inserted_profiles')::int <> 2 THEN
    RAISE EXCEPTION 'expected 2 profiles applied, got % -- %', v_res->>'inserted_profiles', v_res; END IF;
  IF (v_res->>'unresolved_field_rows')::int <> 1 THEN
    RAISE EXCEPTION 'expected 1 unresolved row, got % -- %', v_res->>'unresolved_field_rows', v_res; END IF;
  IF (v_res->>'invalid_rows')::int <> 1 THEN
    RAISE EXCEPTION 'expected the unresolved row to count as invalid, got % -- %', v_res->>'invalid_rows', v_res; END IF;
  IF v_res->>'status' <> 'completed_with_warnings' THEN
    RAISE EXCEPTION 'a job with a refused row must finish completed_with_warnings, got %', v_res->>'status'; END IF;
  IF (v_res->>'inserted_blackouts')::int <> 1 THEN
    RAISE EXCEPTION 'expected only the RESOLVED row''s September blackout, got % -- the refused row''s August window was written', v_res->>'inserted_blackouts'; END IF;

  -- 3b. **No field-less profile exists, enumerated from the table.** Not from
  -- the rows this block believes it inserted: deriving the subject set from the
  -- data a break would corrupt is how a dropped row goes unnoticed.
  SELECT count(*) INTO v_n FROM public.field_availability_profiles
   WHERE organization_id = v_org AND field_id IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% field-less profile(s) were created; the guard did not hold', v_n; END IF;

  SELECT count(*) INTO v_profiles FROM public.field_availability_profiles WHERE organization_id = v_org;
  IF v_profiles <> 2 THEN
    RAISE EXCEPTION 'expected 2 profiles in the table, found % -- the check above passes vacuously over an empty table', v_profiles; END IF;

  -- 3c. Each resolved profile points at the field its NAME asks for, and the
  -- case-differing row resolved to the OTHER field rather than to whichever
  -- one the loop happened to be holding.
  SELECT field_id INTO v_resolved FROM public.field_availability_profiles
   WHERE organization_id = v_org AND field_name = 'Main';
  IF v_resolved IS DISTINCT FROM v_field_a THEN
    RAISE EXCEPTION 'the exact-match row resolved to % rather than to the Main pitch %', v_resolved, v_field_a; END IF;
  SELECT field_id INTO v_resolved FROM public.field_availability_profiles
   WHERE organization_id = v_org AND field_name = 'uPPer';
  IF v_resolved IS DISTINCT FROM v_field_b THEN
    RAISE EXCEPTION 'the case-differing row resolved to % rather than to the Upper pitch % -- lower() matching or the loop carry', v_resolved, v_field_b; END IF;

  -- 3d. The refused row wrote NOTHING and stayed REPLAYABLE.
  SELECT count(*) INTO v_n FROM public.field_availability_profiles
   WHERE organization_id = v_org AND field_name = 'Ghost Pitch';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the refused row created % profile(s)', v_n; END IF;
  SELECT applied_at, validation_errors INTO v_applied, v_errs
    FROM public.staging_import_rows WHERE id = v_row3;
  IF v_applied IS NOT NULL THEN
    RAISE EXCEPTION 'the refused row was marked applied; re-running finalize would skip it and the operator''s import is gone'; END IF;

  -- 3e. It was refused WITH A REASON, and the reason names what to fix.
  IF jsonb_array_length(COALESCE(v_errs,'[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'the refused row carries no validation error; it was dropped silently'; END IF;
  SELECT e->>'reason' INTO v_reason
    FROM jsonb_array_elements(v_errs) e WHERE e->>'reason' = 'field_unresolved';
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'the refusal does not carry reason=field_unresolved; a caller cannot branch on it: %', v_errs; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_errs) e
                  WHERE e->>'field_name' = 'Ghost Pitch' AND e->>'location' = 'Alder Park') THEN
    RAISE EXCEPTION 'the refusal does not name the location and field it could not resolve: %', v_errs; END IF;

  -- 3f. The job's warning summary carries the count too, so an operator reading
  -- the job rather than the RPC result still learns of it.
  IF (SELECT (warning_summary->'availability_finalize'->>'unresolved_field_rows')::int
        FROM public.import_jobs WHERE id = v_job) <> 1 THEN
    RAISE EXCEPTION 'import_jobs.warning_summary does not report the unresolved row'; END IF;

  -- 3g. **The closure is attributable.** This is the whole point: a blackout
  -- from a resolved profile answers "is this ground closed" through
  -- public.field_closures, the one reader for that question.
  SELECT count(*) INTO v_n FROM public.field_closures
   WHERE organization_id = v_org AND source = 'field_blackout_windows' AND closes_field_id = v_field_a;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected the September closure to be attributable to the Main pitch through field_closures, found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.field_closures
   WHERE organization_id = v_org AND source = 'field_blackout_windows' AND closes_field_id IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% import closure(s) have no field to attribute them to', v_n; END IF;

  -- 3h. **REPLAY.** Create the field the refused row asked for and re-run the
  -- same job: the refused row applies, and the two already-applied rows are
  -- not duplicated. "Refused" has to mean "deferred", or this fix discards an
  -- operator's import instead of the previous one hiding it.
  INSERT INTO public.fields (organization_id, location_id, name) VALUES (v_org, v_loc, 'Ghost Pitch');
  v_res := public.finalize_field_availability_import_job(v_job, '[]'::jsonb);
  IF (v_res->>'inserted_profiles')::int <> 1 THEN
    RAISE EXCEPTION 'the replay applied % profile(s); the refused row was not replayable', v_res->>'inserted_profiles'; END IF;
  IF (v_res->>'unresolved_field_rows')::int <> 0 THEN
    RAISE EXCEPTION 'the replay still reports % unresolved', v_res->>'unresolved_field_rows'; END IF;
  SELECT count(*) INTO v_n FROM public.field_availability_profiles WHERE organization_id = v_org;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'after the replay expected 3 profiles, found % -- the applied rows were re-applied', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.field_availability_profiles
   WHERE organization_id = v_org AND field_id IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the replay created % field-less profile(s)', v_n; END IF;

  RAISE NOTICE 'resolution guard exercised: 3 staged rows, 2 resolved (1 exact, 1 case-differing), 1 refused with reason=field_unresolved and replayed to a profile once its field existed';

  DELETE FROM public.organizations WHERE id IN (v_org, v_other_org);
  DELETE FROM auth.users WHERE id IN (v_user, v_other_user);
END $$;

-- ---------------------------------------------------------------------------
-- 3b. The reader's comment states the obstacle that REMAINS
-- ---------------------------------------------------------------------------
--
-- Not pedantry about prose: the sentence this migration rewrote used to say the
-- union collapses once the import resolves reliably, which after this change
-- reads as permission to collapse it. The delete path still orphans profiles,
-- so the comment has to say so and this is what stops it drifting back.
DO $$
DECLARE v_c text;
BEGIN
  SELECT obj_description('public.field_closures'::regclass, 'pg_class') INTO v_c;
  IF v_c IS NULL THEN RAISE EXCEPTION 'field_closures has no comment at all'; END IF;
  IF v_c NOT LIKE '%STILL BLOCKED%' THEN
    RAISE EXCEPTION 'field_closures no longer records that collapsing the union is blocked'; END IF;
  IF v_c NOT LIKE '%ON DELETE SET NULL%' THEN
    RAISE EXCEPTION 'field_closures does not name the delete path as the producer that remains'; END IF;
  RAISE NOTICE 'field_closures records that the import half is closed and the delete half is not';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Reporting, not a gate: what this database holds
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_p bigint; v_w bigint;
BEGIN
  SELECT count(*) INTO v_p FROM public.field_availability_profiles WHERE field_id IS NULL;
  SELECT count(*) INTO v_w FROM public.field_blackout_windows w
    JOIN public.field_availability_profiles p ON p.id = w.profile_id WHERE p.field_id IS NULL;
  RAISE NOTICE 'reporting: % field-less availability profile(s) remain in this database, carrying % blackout window(s)', v_p, v_w;
END $$;
