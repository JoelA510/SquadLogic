-- LIVE-2: an availability import row that resolves to no field is REFUSED and
-- reported, instead of silently creating a field-less profile.
--
-- ## The defect
--
-- `finalize_field_availability_import_job` resolved each staged row to a field
-- by a case-insensitive `location`/`field_name` match with `LIMIT 1` and NO
-- `NOT FOUND` guard, then inserted the profile with whatever `v_field_id` held.
-- `field_availability_profiles.field_id` is nullable, so a row matching no
-- field produced a profile with `field_id IS NULL` -- and every
-- `field_blackout_windows` row hung off that profile became a closure that no
-- field-scoped query can attribute to ground. `public.field_closures`, the one
-- reader for "is this ground closed on this date", reports such a row with
-- `closes_field_id IS NULL`: visible in a list of everything, invisible to the
-- question the view exists to answer. The import reported `status: completed`
-- and a count of profiles inserted, so nothing told the operator.
--
-- ## What an unresolvable row does now, and why this and not something else
--
-- It is REFUSED as a row, reported with a reason that names the location and
-- field it could not find, and LEFT REPLAYABLE.
--
--   * **The contract already existed in this function.** Rows with a bad date
--     range or a bad `format_quantity` are already refused this way: append to
--     `validation_errors` on the staging row, increment `invalid_rows`, skip
--     the row, and finish the job as `completed_with_warnings`. Inventing a
--     third disposition for a fourth kind of bad row is how two paths that do
--     the same job come to disagree.
--   * **Nothing is discarded.** A refused row keeps `applied_at IS NULL` and
--     its `normalized_payload`, so once the operator creates the field (or
--     fixes the spelling) re-running finalize applies it. Creating the profile
--     anyway is the option that cannot be undone: there is no repair that turns
--     a field-less profile into a resolved one without guessing.
--   * **`field_id IS NULL` keeps exactly one meaning.** The column is
--     `ON DELETE SET NULL`, so NULL already means "the field this resolved to
--     was deleted". Letting the import produce NULL as well makes one column
--     mean two things across two producers -- the defect `field_closures` was
--     redesigned to remove when `location_id` meant scope on one arm and the
--     field's site on the other.
--   * **Marking the profile "unresolved" instead** was considered and rejected:
--     it adds a column and a UI surface that does not exist, and it leaves the
--     closure just as unattributable, only tidier.
--
-- ## Rows already in that state
--
-- **No automatic repair ships here, deliberately.** A pre-existing
-- `field_id IS NULL` profile is either one the import never resolved (which a
-- re-match would fix if the field exists now) or one whose field was deleted
-- (which a re-match must NOT reattach to a same-named replacement). Nothing in
-- the schema distinguishes them -- that is the two-meanings problem above,
-- already in the data -- so a blanket backfill would silently reattach
-- closures to ground they were never about, and a blanket delete would discard
-- an operator's import. Both are worse than the state they repair.
--
-- What ships instead is a count at apply time (below), so whoever applies this
-- to a database learns how many rows are in that state and how many closures
-- hang off them, rather than finding out later. To list them:
--
--   SELECT p.id, p.organization_id, p.season_label, p.location, p.field_name,
--          count(w.id) AS blackout_windows
--     FROM public.field_availability_profiles p
--     LEFT JOIN public.field_blackout_windows w ON w.profile_id = p.id
--    WHERE p.field_id IS NULL
--    GROUP BY p.id ORDER BY blackout_windows DESC;
--
-- ## One deliberate difference from the sibling finalizer, and why
--
-- `finalize_field_import_job` selects its staged rows with
-- `AND COALESCE(jsonb_array_length(validation_errors), 0) = 0`, so a row it
-- once refused is never attempted again. **This function deliberately does
-- NOT carry that clause, and adopting it would silently destroy the
-- replayability this migration is built on**: the only rows that ever hold a
-- non-empty `validation_errors` are ones a previous finalize refused (the
-- import-validation edge function stages every row with `validation_errors:
-- []` and drops the rest), so that filter makes a refusal permanent. Here a
-- refusal is a DEFERRAL -- the operator creates the missing field and the row
-- applies. The two functions want different things from the same column, and
-- the difference is stated because "adopt the sibling's contract" is the right
-- instinct almost everywhere else in this codebase.
--
-- `docs/sql/20260908000000_smoke.sql` asserts the clause is absent, so
-- harmonising the two by hand fails loudly instead of quietly.
--
-- ## What this does NOT fix
--
-- It closes the IMPORT as a producer of field-less profiles. It does not close
-- the other one: `fields.id` is referenced `ON DELETE SET NULL`, and
-- `field_availability_profiles` is deliberately excluded from the booking guard
-- in `admin_delete_field`, so deleting a field still orphans any profile that
-- pointed at it. Collapsing `field_blackout_windows` into a scope-bearing table
-- therefore remains blocked -- by a smaller and bounded obstacle than before,
-- but blocked. See the PR body for 8.4 PR 2.
--
-- Behaviour is otherwise identical to 20260602000000: the same normalisation,
-- the same ledger rows, the same `applied_payload` handling.
BEGIN;

CREATE OR REPLACE FUNCTION public.finalize_field_availability_import_job(
  p_import_job_id uuid,
  p_validation_errors jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.import_jobs%ROWTYPE;
  v_row public.staging_import_rows%ROWTYPE;
  v_now timestamptz := timezone('utc', now());
  v_payload jsonb;
  v_profile_id uuid;
  v_field_id uuid;
  v_inserted_profiles integer := 0; v_inserted_blackouts integer := 0; v_inserted_requirements integer := 0; v_inserted_formats integer := 0; v_inserted_scenarios integer := 0; v_inserted_members integer := 0; v_invalid_rows integer := 0;
  v_unresolved_rows integer := 0;
  v_location text; v_field_name text; v_avail_from date; v_avail_until date;
  v_primary_format text; v_secondary_format text; v_format_qty integer;
  v_record_status text; v_approval_status text; v_goal_equipment text; v_goal_status text; v_requirement_status text; v_blackout_months text; v_scenario_name text; v_scenario_id uuid;
  v_member_inserted boolean := false; v_member_row_count integer := 0;
  v_row_errors jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_validation_errors, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'p_validation_errors must be a jsonb array' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_job.job_type <> 'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;

  FOR v_row IN SELECT * FROM public.staging_import_rows WHERE import_job_id=p_import_job_id AND organization_id=v_job.organization_id AND import_type='field_availability' AND applied_at IS NULL AND normalized_payload IS NOT NULL ORDER BY source_row_number NULLS LAST, id
  LOOP
    v_payload := v_row.normalized_payload; v_row_errors := '[]'::jsonb;
    v_location := public.import_payload_text(v_payload, 'location'); v_field_name := public.import_payload_text(v_payload, 'field_name', 'name');
    v_avail_from := public.import_text_to_date(public.import_payload_text(v_payload, 'available_from')); v_avail_until := public.import_text_to_date(public.import_payload_text(v_payload, 'available_until'));
    v_format_qty := public.import_text_to_positive_int(public.import_payload_text(v_payload, 'format_quantity'), 1);
    IF v_location IS NULL OR v_field_name IS NULL OR v_avail_from IS NULL OR v_avail_until IS NULL OR v_avail_until < v_avail_from THEN
      v_row_errors := v_row_errors || jsonb_build_object('message','Invalid required location/field/date range','source_row_number',v_row.source_row_number);
    END IF;
    IF v_format_qty IS NULL THEN v_row_errors := v_row_errors || jsonb_build_object('message','Invalid format_quantity','source_row_number',v_row.source_row_number); END IF;
    IF public.import_payload_text(v_payload, 'teams_per_hour') IS NOT NULL AND public.import_text_to_positive_int(public.import_payload_text(v_payload, 'teams_per_hour'), NULL) IS NULL THEN
      v_row_errors := v_row_errors || jsonb_build_object('message','Invalid teams_per_hour','source_row_number',v_row.source_row_number);
    END IF;
    IF public.import_payload_text(v_payload, 'aggregate_teams_per_hour') IS NOT NULL AND public.import_text_to_positive_int(public.import_payload_text(v_payload, 'aggregate_teams_per_hour'), NULL) IS NULL THEN
      v_row_errors := v_row_errors || jsonb_build_object('message','Invalid aggregate_teams_per_hour','source_row_number',v_row.source_row_number);
    END IF;

    -- **Resolve the field BEFORE anything is written, and refuse the row if it
    -- does not resolve.** This ran after the refusal gate below and its result
    -- went straight into the INSERT unchecked; see the header.
    --
    -- **The reset is defence in depth and NOTHING CURRENTLY REACHES IT --
    -- said plainly rather than implied, because a line that reads as
    -- load-bearing and is not is how a guarantee gets believed.** `v_field_id`
    -- is one variable reused by every iteration. PL/pgSQL assigns NULL to a
    -- `SELECT INTO` target when no row matches, so any row that runs the SELECT
    -- cannot inherit its predecessor's field; and the only path that SKIPS the
    -- SELECT -- a row with no location or no field_name -- has already recorded
    -- a validation error above and is refused before the INSERT. So no plant
    -- can make this line matter today, and none is claimed for it. It is kept
    -- because the skip exists: a later edit that stops refusing such a row
    -- would otherwise attach a closure to the previous row's ground, which is
    -- worse than the defect being fixed here.
    v_field_id := NULL;
    IF v_location IS NOT NULL AND v_field_name IS NOT NULL THEN
      SELECT f.id INTO v_field_id FROM public.fields f JOIN public.locations l ON l.id=f.location_id WHERE f.organization_id=v_job.organization_id AND lower(l.name)=lower(v_location) AND lower(f.name)=lower(v_field_name) ORDER BY f.created_at, f.id LIMIT 1;
      IF v_field_id IS NULL THEN
        v_unresolved_rows := v_unresolved_rows + 1;
        -- The reason travels as structured keys as well as prose, so a caller
        -- can branch on `reason` rather than parse a sentence.
        v_row_errors := v_row_errors || jsonb_build_object(
          'message', format('No field named %L at location %L in this organization -- import or create the field first, or correct the spelling, then re-run the import.', v_field_name, v_location),
          'reason','field_unresolved','location',v_location,'field_name',v_field_name,
          'source_row_number',v_row.source_row_number);
      END IF;
    END IF;

    IF jsonb_array_length(v_row_errors) > 0 THEN
      v_invalid_rows := v_invalid_rows + 1;
      UPDATE public.staging_import_rows SET validation_errors = v_row_errors WHERE id = v_row.id;
      CONTINUE;
    END IF;

    v_record_status := public.import_normalize_field_availability_record_status(public.import_payload_text(v_payload, 'record_status'));
    v_approval_status := public.import_normalize_field_availability_approval_status(public.import_payload_text(v_payload, 'approval_status'), v_record_status);

    INSERT INTO public.field_availability_profiles (organization_id,season_label,season_settings_id,field_id,location,field_name,surface_type,record_status,approval_status,available_from,available_until,availability_rule,teams_per_hour,aggregate_teams_per_hour,capacity_basis,lighted,restroom_potty,goal_status,use_context,day_constraints,move_to_location,current_app_import_status,notes)
    VALUES (v_job.organization_id,COALESCE(public.import_payload_text(v_payload,'season_label'),'Unspecified Season'),NULL,v_field_id,v_location,v_field_name,public.import_payload_text(v_payload,'surface_type'),v_record_status,v_approval_status,v_avail_from,v_avail_until,public.import_payload_text(v_payload,'availability_rule'),public.import_text_to_positive_int(public.import_payload_text(v_payload,'teams_per_hour'),NULL),public.import_text_to_positive_int(public.import_payload_text(v_payload,'aggregate_teams_per_hour'),NULL),public.import_normalize_capacity_basis(public.import_payload_text(v_payload,'capacity_basis')),CASE WHEN public.import_payload_text(v_payload,'lighted') IS NULL THEN NULL ELSE public.import_text_to_bool(public.import_payload_text(v_payload,'lighted')) END,CASE WHEN public.import_payload_text(v_payload,'restroom_potty') IS NULL THEN NULL ELSE public.import_text_to_bool(public.import_payload_text(v_payload,'restroom_potty')) END,public.import_payload_text(v_payload,'goal_status'),public.import_payload_text(v_payload,'use_context'),public.import_payload_text(v_payload,'day_constraints'),public.import_payload_text(v_payload,'move_to_location'),public.import_payload_text(v_payload,'current_app_import_status'),public.import_payload_text(v_payload,'notes')) RETURNING id INTO v_profile_id;
    v_inserted_profiles := v_inserted_profiles + 1;

    v_primary_format := public.import_normalize_format_code(public.import_payload_text(v_payload,'primary_format')); v_secondary_format := public.import_normalize_format_code(public.import_payload_text(v_payload,'secondary_format'));
    IF v_primary_format IS NOT NULL THEN INSERT INTO public.field_availability_profile_formats (organization_id, profile_id, format_code, format_quantity, format_order) VALUES (v_job.organization_id, v_profile_id, v_primary_format, COALESCE(v_format_qty,1), 1); v_inserted_formats := v_inserted_formats + 1; END IF;
    IF v_secondary_format IS NOT NULL THEN INSERT INTO public.field_availability_profile_formats (organization_id, profile_id, format_code, format_quantity, format_order) VALUES (v_job.organization_id, v_profile_id, v_secondary_format, COALESCE(v_format_qty,1), 2); v_inserted_formats := v_inserted_formats + 1; END IF;

    v_goal_equipment := public.import_payload_text(v_payload,'goal_equipment'); v_goal_status := public.import_payload_text(v_payload,'goal_status'); v_requirement_status := public.import_normalize_requirement_status(v_goal_status);
    IF v_goal_equipment IS NOT NULL OR v_goal_status IS NOT NULL THEN INSERT INTO public.field_equipment_requirements (organization_id, profile_id, goal_equipment, requirement_status, notes) VALUES (v_job.organization_id, v_profile_id, v_goal_equipment, v_requirement_status, NULL); v_inserted_requirements := v_inserted_requirements + 1; END IF;

    v_blackout_months := lower(COALESCE(public.import_payload_text(v_payload, 'blackout_months'), ''));
    IF position('aug' in v_blackout_months) > 0 THEN INSERT INTO public.field_blackout_windows (organization_id, profile_id, blackout_from, blackout_until, reason) VALUES (v_job.organization_id,v_profile_id,'2026-08-01','2026-08-31','blackout_months'); v_inserted_blackouts := v_inserted_blackouts + 1; END IF;
    IF position('sep' in v_blackout_months) > 0 THEN INSERT INTO public.field_blackout_windows (organization_id, profile_id, blackout_from, blackout_until, reason) VALUES (v_job.organization_id,v_profile_id,'2026-09-01','2026-09-30','blackout_months'); v_inserted_blackouts := v_inserted_blackouts + 1; END IF;
    IF position('oct' in v_blackout_months) > 0 THEN INSERT INTO public.field_blackout_windows (organization_id, profile_id, blackout_from, blackout_until, reason) VALUES (v_job.organization_id,v_profile_id,'2026-10-01','2026-10-31','blackout_months'); v_inserted_blackouts := v_inserted_blackouts + 1; END IF;
    IF position('nov' in v_blackout_months) > 0 THEN INSERT INTO public.field_blackout_windows (organization_id, profile_id, blackout_from, blackout_until, reason) VALUES (v_job.organization_id,v_profile_id,'2026-11-01','2026-11-30','blackout_months'); v_inserted_blackouts := v_inserted_blackouts + 1; END IF;

    v_scenario_name := public.import_payload_text(v_payload, 'scenario_name');
    v_member_inserted := false;
    IF v_scenario_name IS NOT NULL THEN
      INSERT INTO public.field_availability_scenarios (organization_id, season_label, name, exclusivity_group)
      VALUES (v_job.organization_id, COALESCE(public.import_payload_text(v_payload,'season_label'),'Unspecified Season'), v_scenario_name, public.import_payload_text(v_payload, 'scenario_group'))
      ON CONFLICT (organization_id, season_label, name) DO UPDATE SET exclusivity_group = EXCLUDED.exclusivity_group RETURNING id INTO v_scenario_id;
      INSERT INTO public.field_availability_scenario_members (organization_id, scenario_id, profile_id, membership_status) VALUES (v_job.organization_id,v_scenario_id,v_profile_id,'included') ON CONFLICT (scenario_id, profile_id) DO NOTHING;
      GET DIAGNOSTICS v_member_row_count = ROW_COUNT;
      v_member_inserted := v_member_row_count > 0;
      v_inserted_scenarios := v_inserted_scenarios + 1;
      IF v_member_inserted THEN v_inserted_members := v_inserted_members + 1; END IF;
    END IF;

    INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
    VALUES
      (v_job.organization_id,p_import_job_id,'field_availability','field_availability_profiles',v_profile_id,'inserted',NULL,to_jsonb((SELECT p FROM public.field_availability_profiles p WHERE p.id=v_profile_id)),v_now,auth.uid()),
      (v_job.organization_id,p_import_job_id,'field_availability','field_availability_profile_formats',v_profile_id,'inserted',NULL,'{}'::jsonb,v_now,auth.uid()),
      (v_job.organization_id,p_import_job_id,'field_availability','field_blackout_windows',v_profile_id,'inserted',NULL,'{}'::jsonb,v_now,auth.uid()),
      (v_job.organization_id,p_import_job_id,'field_availability','field_equipment_requirements',v_profile_id,'inserted',NULL,'{}'::jsonb,v_now,auth.uid())
    ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

    IF v_member_inserted THEN
      INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
      VALUES (v_job.organization_id,p_import_job_id,'field_availability','field_availability_scenario_members',v_profile_id,'inserted',NULL,'{}'::jsonb,v_now,auth.uid())
      ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;
    END IF;

    -- **Clear the refusal when the row is applied.** A row refused in an
    -- earlier run keeps its `field_unresolved` entry, and without this a row
    -- that has now succeeded reads as applied AND refused -- so anything
    -- asking "which rows did this import refuse" names one that did not.
    UPDATE public.staging_import_rows SET applied_at=v_now, applied_by=auth.uid(), validation_errors='[]'::jsonb WHERE id=v_row.id;
  END LOOP;

  UPDATE public.import_jobs SET status = CASE WHEN v_invalid_rows > 0 OR jsonb_array_length(COALESCE(p_validation_errors,'[]'::jsonb)) > 0 THEN 'completed_with_warnings' ELSE 'completed' END,
    processed_rows = COALESCE(processed_rows,0) + v_inserted_profiles, progress_percent = 100, completed_at = v_now,
    error_summary = jsonb_build_object('rowErrors', COALESCE(p_validation_errors,'[]'::jsonb)),
    -- **Merged, not replaced.** This assignment overwrote the whole column, and
    -- `mark_import_job_ready_to_apply` puts `deferred_apply` there with
    -- `jsonb_set` -- so finalizing a DEFERRED availability job destroyed the
    -- key `ImportPanel` and `ImportContext` read to know a job was ever staged.
    -- Every sibling finalizer merges (`20260503060000:433`,
    -- `20260503070000:882`, `20260503090000:142`); this one now does too, which
    -- also settles a disagreement this PR would otherwise have created, since
    -- the mock arm merges.
    warning_summary = jsonb_set(
      COALESCE(warning_summary, '{}'::jsonb),
      '{availability_finalize}',
      jsonb_build_object('invalid_rows', v_invalid_rows, 'unresolved_field_rows', v_unresolved_rows),
      true
    )
  WHERE id = p_import_job_id;

  RETURN jsonb_build_object('status', CASE WHEN v_invalid_rows > 0 OR jsonb_array_length(COALESCE(p_validation_errors,'[]'::jsonb)) > 0 THEN 'completed_with_warnings' ELSE 'completed' END,'inserted_profiles', v_inserted_profiles,'inserted_formats', v_inserted_formats,'inserted_blackouts', v_inserted_blackouts,'inserted_requirements', v_inserted_requirements,'inserted_scenarios', v_inserted_scenarios,'inserted_scenario_members', v_inserted_members,'invalid_rows', v_invalid_rows,'unresolved_field_rows', v_unresolved_rows);
END;
$$;

COMMENT ON FUNCTION public.finalize_field_availability_import_job(uuid, jsonb) IS
  'Applies staged field_availability rows. A row whose location/field_name matches no fields row in the organisation is REFUSED, not applied: it is counted in unresolved_field_rows, its reason is written to staging_import_rows.validation_errors with reason=field_unresolved, and it keeps applied_at IS NULL so re-running finalize applies it once the field exists. Before 20260908000000 the resolution had no NOT FOUND guard and the profile was created with field_id NULL, which made every blackout hung off it unattributable to ground -- invisible to any field-scoped query through public.field_closures.';

-- **The one reader's own comment, corrected.** `field_closures` says the union
-- "collapses to field_blackouts alone once finalize_field_availability_import_job
-- resolves a profile to a field reliably". After this migration that sentence
-- reads as "the precondition is met, go and collapse it", and that is false: the
-- import is no longer a producer of field-less profiles, but the DELETE path
-- still is. A comment made misleading by a change is that change's
-- responsibility, so it is rewritten here rather than left to be believed.
COMMENT ON VIEW public.field_closures IS
  'THE reader for "is this ground closed on this date". Unions admin-authored field_blackouts with import-derived field_blackout_windows so the question has one answer. SCOPE is closes_location_id / closes_field_id -- what this row shuts. field_location_id is a different fact (the site the closed field sits on) and is never a scope; the two were one column in the first draft and a location filter therefore closed every other pitch on the site. closes_field_id is NULL for import rows whose profile has no field -- surfaced, not filtered, because a closure nobody can attribute is what an inner join would hide. reason is NULL on the import arm because the import carries no structured reason, and its own words travel in source_reason_text rather than in note -- note is admin free text on both arms, so a privacy guard or an enum filter cannot silently mean two things. COLLAPSING THE UNION IS STILL BLOCKED, and only half the obstacle is gone: as of 20260908000000 the IMPORT can no longer create a profile with no field (such a row is refused and reported), but fields.id is referenced ON DELETE SET NULL and field_availability_profiles is deliberately excluded from admin_delete_field''s booking guard, so deleting a field still orphans every profile pointing at it. Until that second producer is closed, a profile-scoped blackout still cannot be expressed in a scope-bearing table.';

-- **What this database already holds.** Reported at apply time rather than
-- repaired: the header argues why a blanket backfill or delete is worse than
-- the state it would repair. A count of zero is stated too, so "no warning"
-- means "measured and none" rather than "the check did not run".
DO $$
DECLARE v_profiles bigint; v_windows bigint;
BEGIN
  SELECT count(*) INTO v_profiles FROM public.field_availability_profiles WHERE field_id IS NULL;
  SELECT count(*) INTO v_windows
    FROM public.field_blackout_windows w
    JOIN public.field_availability_profiles p ON p.id = w.profile_id
   WHERE p.field_id IS NULL;
  IF v_profiles > 0 THEN
    RAISE WARNING 'PRE-EXISTING: % field_availability_profiles row(s) have field_id IS NULL, carrying % blackout window(s) that no field-scoped query can attribute to ground. This migration stops the import creating more; it does not repair these. The listing query is in this migration''s header.', v_profiles, v_windows;
  ELSE
    RAISE NOTICE 'no pre-existing field-less availability profiles in this database (checked % profile rows against field_id IS NULL)', (SELECT count(*) FROM public.field_availability_profiles);
  END IF;
END $$;

COMMIT;
