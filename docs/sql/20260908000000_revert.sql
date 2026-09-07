-- Revert for 20260908000000_field_availability_profile_field_resolution.sql
--
-- Restores `finalize_field_availability_import_job` to its 20260602000000 body:
-- the field resolution with no NOT FOUND guard, whose result went straight into
-- the profile INSERT.
--
-- **This revert is destructive in the quiet way.** Nothing fails afterwards and
-- no row is deleted; the import simply starts accepting rows that match no
-- field again, creating profiles with `field_id IS NULL` and hanging blackout
-- windows off them that `public.field_closures` cannot attribute to any ground.
-- The operator sees `status: completed` and a count of profiles inserted. So it
-- says so, loudly, and counts what the database already holds -- a revert that
-- silently reinstates a silence is the same defect one level up.
--
-- Revert only if 20260908000000 is itself implicated in an incident.
\set ON_ERROR_STOP on

BEGIN;

-- What is already in this state, before the revert makes more of it possible.
DO $$
DECLARE v_p bigint; v_w bigint;
BEGIN
  SELECT count(*) INTO v_p FROM public.field_availability_profiles WHERE field_id IS NULL;
  SELECT count(*) INTO v_w
    FROM public.field_blackout_windows w
    JOIN public.field_availability_profiles p ON p.id = w.profile_id
   WHERE p.field_id IS NULL;
  RAISE WARNING 'ORPHANS: % field-less availability profile(s) already in this database, carrying % blackout window(s) no field-scoped query can attribute to ground', v_p, v_w;
  RAISE WARNING 'RESTORING finalize_field_availability_import_job to its pre-20260908000000 body: an availability row matching no field will again be APPLIED with field_id NULL instead of refused, and its blackouts will again be invisible to every field-scoped query';
END $$;

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

    IF jsonb_array_length(v_row_errors) > 0 THEN
      v_invalid_rows := v_invalid_rows + 1;
      UPDATE public.staging_import_rows SET validation_errors = v_row_errors WHERE id = v_row.id;
      CONTINUE;
    END IF;

    SELECT f.id INTO v_field_id FROM public.fields f JOIN public.locations l ON l.id=f.location_id WHERE f.organization_id=v_job.organization_id AND lower(l.name)=lower(v_location) AND lower(f.name)=lower(v_field_name) ORDER BY f.created_at, f.id LIMIT 1;

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

    UPDATE public.staging_import_rows SET applied_at=v_now, applied_by=auth.uid() WHERE id=v_row.id;
  END LOOP;

  UPDATE public.import_jobs SET status = CASE WHEN v_invalid_rows > 0 OR jsonb_array_length(COALESCE(p_validation_errors,'[]'::jsonb)) > 0 THEN 'completed_with_warnings' ELSE 'completed' END,
    processed_rows = COALESCE(processed_rows,0) + v_inserted_profiles, progress_percent = 100, completed_at = v_now,
    error_summary = jsonb_build_object('rowErrors', COALESCE(p_validation_errors,'[]'::jsonb)),
    warning_summary = jsonb_build_object('availability_finalize', jsonb_build_object('invalid_rows', v_invalid_rows))
  WHERE id = p_import_job_id;

  RETURN jsonb_build_object('status', CASE WHEN v_invalid_rows > 0 OR jsonb_array_length(COALESCE(p_validation_errors,'[]'::jsonb)) > 0 THEN 'completed_with_warnings' ELSE 'completed' END,'inserted_profiles', v_inserted_profiles,'inserted_formats', v_inserted_formats,'inserted_blackouts', v_inserted_blackouts,'inserted_requirements', v_inserted_requirements,'inserted_scenarios', v_inserted_scenarios,'inserted_scenario_members', v_inserted_members,'invalid_rows', v_invalid_rows);
END;
$$;

-- The comment described a guard that no longer exists once the body above is
-- back. A stale comment claiming a guarantee the code does not make is the
-- unread-field shape, so it goes with the guard.
COMMENT ON FUNCTION public.finalize_field_availability_import_job(uuid, jsonb) IS
  'Applies staged field_availability rows. Reverted to the pre-20260908000000 body: the location/field_name resolution has NO NOT FOUND guard, so a row matching no fields row creates a profile with field_id NULL and its blackout windows are unattributable to ground.';

COMMIT;
