-- Confirm that both reviewed definitions are installed. The import suites exercise their behavior.
DO $guard$
BEGIN
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.apply_game_import_job(uuid,boolean,jsonb)')) IS DISTINCT FROM '2c79d51acc5e4daa895bdaddaa500ad3' THEN
        RAISE EXCEPTION 'Unexpected body for apply_game_import_job(uuid,boolean,jsonb)';
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.apply_practice_import_job(uuid,boolean)')) IS DISTINCT FROM 'f0195de03b5ab04ed526d08d4ee24fbc' THEN
        RAISE EXCEPTION 'Unexpected body for apply_practice_import_job(uuid,boolean)';
    END IF;
END
$guard$;
