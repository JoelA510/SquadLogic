-- Confirm the reviewed game import and rollback definitions.
DO $guard$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'game_scores' AND column_name = 'score_revision'
          AND data_type = 'uuid' AND is_nullable = 'NO' AND column_default = 'gen_random_uuid()') THEN
        RAISE EXCEPTION 'Expected a fresh UUID revision on each new score';
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.apply_game_import_job(uuid,boolean,jsonb)')) IS DISTINCT FROM '1614dc2c4c29a9daf914a25aa32ed58e' THEN
        RAISE EXCEPTION 'Unexpected body for apply_game_import_job(uuid,boolean,jsonb)';
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.rollback_game_import_job(uuid)')) IS DISTINCT FROM '220ed4c1f6587ff66f5091464a15e0d2' THEN
        RAISE EXCEPTION 'Unexpected body for rollback_game_import_job(uuid)';
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.update_game_score(uuid,uuid,smallint,smallint,jsonb)')) IS DISTINCT FROM '019c75001f366dcfde0516d0f097c365' THEN
        RAISE EXCEPTION 'Unexpected body for update_game_score(uuid,uuid,smallint,smallint,jsonb)';
    END IF;
END
$guard$;
