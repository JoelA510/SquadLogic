-- Revert for 20261018000000_create_import_job_no_file_name.sql
--
-- Restores `create_import_job` exactly as 20260522130000 defines it (the text
-- is copied from that migration, not retyped), so its `import.started` audit
-- row stores the uploaded file's name again. Nothing else changes: the
-- signature, the grant and the comment were never touched.
--
-- Rows written while the forward migration was live keep no file name; this
-- revert does not add one to them (the audit log is append-only).
--
-- Verified: the transcript fails unless the restored body writes `file_name`
-- into its audit metadata again and the posture (SECURITY DEFINER,
-- search_path=public) is intact. The harness also compares the body's md5
-- with 20260522130000's.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_import_job(
    p_organization_id uuid,
    p_import_type text,
    p_file_name text
)
RETURNS public.import_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_import_type text := lower(NULLIF(btrim(COALESCE(p_import_type, '')), ''));
    v_file_name text := btrim(COALESCE(p_file_name, ''));
    v_job_type text;
    v_now timestamptz := timezone('utc', now());
    v_job public.import_jobs%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
      RAISE EXCEPTION 'Only organization admins can create import jobs' USING ERRCODE='42501';
    END IF;
    IF v_import_type NOT IN ('players', 'coaches', 'fields', 'field_availability') THEN
      RAISE EXCEPTION 'invalid import type: %', p_import_type USING ERRCODE='22023';
    END IF;
    v_file_name := regexp_replace(v_file_name, '[/\\:]+', '_', 'g');
    IF v_file_name = '' THEN RAISE EXCEPTION 'file_name is required' USING ERRCODE='22023'; END IF;

    v_job_type := CASE WHEN v_import_type = 'fields' THEN 'fields' WHEN v_import_type='field_availability' THEN 'field_availability' ELSE 'registration' END;

    INSERT INTO public.import_jobs (organization_id,job_type,storage_path,status,total_rows,processed_rows,progress_percent,last_heartbeat_at,created_by,started_at)
    VALUES (p_organization_id,v_job_type,format('imports/%s/%s', auth.uid(), v_file_name),'importing',0,0,0,v_now,auth.uid(),v_now)
    RETURNING * INTO v_job;

    PERFORM public.record_audit_event(p_organization_id,'import.started','import_job',v_job.id,jsonb_build_object('import_type',v_import_type,'job_type',v_job_type,'file_name',v_file_name,'status','importing'));
    RETURN v_job;
END;
$$;

DO $revert$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
         WHERE p.oid = 'public.create_import_job(uuid, text, text)'::regprocedure
           AND p.prosecdef
           AND p.proconfig = ARRAY['search_path=public']
           AND p.prosrc LIKE '%''job_type'',v_job_type,''file_name'',v_file_name,''status''%') THEN
        RAISE EXCEPTION 'create_import_job was not restored to its 20260522130000 body and posture';
    END IF;
    RAISE NOTICE 'revert verified: create_import_job writes file_name into import.started again, SECURITY DEFINER with search_path=public';
END;
$revert$;

COMMIT;
