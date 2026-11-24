-- The retired table and copy helper are gone; the saved schedule, scores, and their public RPCs survive.
\set ON_ERROR_STOP on
BEGIN;
DO $smoke$
BEGIN
    IF to_regclass('public.games') IS NOT NULL OR to_regprocedure('public.copy_legacy_game_scores()') IS NOT NULL THEN
        RAISE EXCEPTION 'The legacy table or its copy helper still exists';
    END IF;
    IF to_regclass('public.game_assignments') IS NULL OR to_regclass('public.game_scores') IS NULL
       OR to_regclass('public.current_game_runs') IS NULL THEN
        RAISE EXCEPTION 'A saved schedule or score object is missing';
    END IF;
    IF (SELECT count(*) FROM pg_class WHERE oid IN ('public.game_assignments'::regclass,'public.game_scores'::regclass) AND relrowsecurity) <> 2 THEN
        RAISE EXCEPTION 'Saved games and scores must both be protected by row-level security';
    END IF;
    IF to_regprocedure('public.admin_delete_team(uuid)') IS NULL
       OR to_regprocedure('public.field_bookings(uuid,uuid,date,text)') IS NULL
       OR to_regprocedure('public.rollback_field_import_job(uuid)') IS NULL THEN
        RAISE EXCEPTION 'A public RPC that uses the saved schedule is missing';
    END IF;
END
$smoke$;
ROLLBACK;
