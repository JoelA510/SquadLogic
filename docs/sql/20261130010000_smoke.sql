-- Check that the reviewed finalizer is installed. Behavioral coverage is in pgTAP.
DO $guard$
BEGIN
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.finalize_import_job(uuid,jsonb)')) IS DISTINCT FROM '4cd431c8d42791bed185b6a60e22e111' THEN
        RAISE EXCEPTION 'Unexpected body for finalize_import_job(uuid,jsonb)';
    END IF;
END
$guard$;
