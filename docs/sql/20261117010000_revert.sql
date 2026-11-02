-- Revert for 20261117010000_players_custom_attributes_gin_index.sql
--
-- **This revert changes nothing, on purpose.**
--
-- The migration creates `players_custom_attributes_gin_idx` where it is missing and skips it where it
-- exists, and it cannot tell afterwards which of the two happened: in production the index was built
-- by hand before any migration named it, and a `DROP INDEX` here would remove an object that exists
-- independently of the migration. Nothing else was changed by the migration, so there is nothing else
-- to put back.
--
-- To remove the index, on purpose, write a migration that drops it (it is read by no function, policy,
-- view or filter, and it costs on every write to `players`: docs/changes/2026-11-02-data-followups.md,
-- item 1). A database built only to test a rollback can drop it by hand.
--
-- Verified: the harness applies this on a database built up to the migration and checks the index is
-- still there, the same GIN index, and was not rebuilt.

BEGIN;

DO $$
BEGIN
    RAISE NOTICE 'this revert changes nothing: players_custom_attributes_gin_idx is %, and is left in place because it exists in production independently of this migration',
        CASE WHEN to_regclass('public.players_custom_attributes_gin_idx') IS NULL THEN 'absent' ELSE 'present' END;
END;
$$;

COMMIT;
