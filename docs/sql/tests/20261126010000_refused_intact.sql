-- Inspect the previous schema after its transaction refused to drop a populated table.
DO $check$
BEGIN
    IF (SELECT count(*) FROM public.games WHERE organization_id='2a000000-0000-4000-8000-00000000000a') <> 3
       OR to_regprocedure('public.copy_legacy_game_scores()') IS NULL
       OR (SELECT md5(replace(prosrc,chr(13),'')) FROM pg_proc WHERE oid='public.admin_delete_team(uuid)'::regprocedure)
          IS DISTINCT FROM 'e7c4db10499eebbac2e222d7184aeaa7' THEN
        RAISE EXCEPTION 'Retirement refusal did not preserve the legacy rows, copy helper and team-deletion routine';
    END IF;
END
$check$;
