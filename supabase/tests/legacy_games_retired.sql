-- The saved schedule and its scores survive retiring the legacy table and its one-off copy helper.
BEGIN;
SELECT plan(4);
SELECT ok(to_regclass('public.games') IS NULL,'the legacy table is gone');
SELECT ok(to_regprocedure('public.copy_legacy_game_scores()') IS NULL,'its one-off copy helper is gone');
SELECT has_table('public','game_assignments','saved games still exist');
SELECT has_table('public','game_scores','saved scores still exist');
SELECT * FROM finish();
ROLLBACK;
