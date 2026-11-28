-- Confirm that both reviewed definitions are installed. The import suites exercise their behavior.
DO $guard$
DECLARE
    -- The harness runs historical smokes on the complete migration set. Both reviewed game definitions retain this fix.
    expected_game_body text := CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'game_scores' AND column_name = 'score_revision')
        THEN '1614dc2c4c29a9daf914a25aa32ed58e' ELSE '2c79d51acc5e4daa895bdaddaa500ad3' END;
BEGIN
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.apply_game_import_job(uuid,boolean,jsonb)')) IS DISTINCT FROM expected_game_body THEN
        RAISE EXCEPTION 'Unexpected body for apply_game_import_job(uuid,boolean,jsonb)';
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.apply_practice_import_job(uuid,boolean)')) IS DISTINCT FROM 'f0195de03b5ab04ed526d08d4ee24fbc' THEN
        RAISE EXCEPTION 'Unexpected body for apply_practice_import_job(uuid,boolean)';
    END IF;
END
$guard$;
