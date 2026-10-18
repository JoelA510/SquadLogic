-- `create_import_job` stops writing the uploaded file's name into its
-- `import.started` audit row.
--
-- **Why.** The audit log keeps no upload file names: the owner ruled them out
-- for the import audits on 2026-10-14 (data minimisation; #577 removed it from
-- import-validation's rows). The SQL side's row, written here since
-- 20260522130000, still carried `file_name`, which the remediation plan
-- recorded as the open item (Discovered during execution, 2026-10-14 and
-- 2026-10-17). Plan: docs/PLAN_AUDIT_IN_TRANSACTION.md, section 3.4 and Q1,
-- taken as its own change ahead of the audit-in-transaction one.
--
-- **The one change.** The function is replaced wholesale from its latest
-- revision (20260522130000, whose body equals production's: md5(prosrc) read
-- back on 2026-10-17) with `'file_name', v_file_name` dropped from the audit
-- metadata. Everything else is the same text: the signature, RETURNS, SECURITY
-- DEFINER, the search_path, the admin check, and the file name still forming
-- `storage_path` (`importDeferredActions.js` reads the job's path back), so
-- `p_file_name` stays a required argument. CREATE OR REPLACE keeps the grant
-- (`authenticated`) and the comment from 20260504080000.
--
-- **Existing rows are left alone** (plan Q5): the audit log is append-only,
-- and the rows that carry a file name age out under the 180-day retention
-- (`prune_old_audit_logs`).
--
-- Reversible: see docs/sql/20261018050000_revert.sql.
-- Smoke checks: see docs/sql/20261018050000_smoke.sql.

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

    PERFORM public.record_audit_event(p_organization_id,'import.started','import_job',v_job.id,jsonb_build_object('import_type',v_import_type,'job_type',v_job_type,'status','importing'));
    RETURN v_job;
END;
$$;

COMMIT;
