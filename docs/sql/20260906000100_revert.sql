-- Revert for 20260906000100_field_blackouts.sql
--
-- Drops the admin blackout RPCs -- all THREE of them -- the single-reader
-- view, and field_blackouts.
--
-- **This is destructive of every admin-authored blackout.** field_blackouts is
-- the sole producer of them; field_blackout_windows holds only import-derived
-- rows and is untouched here, so reverting loses exactly the closures an
-- operator entered by hand and keeps the ones the importer wrote.
--
-- The COMMENT ON TABLE freeze on field_blackout_windows is restored to NULL,
-- which removes the sentence but not the freeze: tests/fieldBlackoutFreeze.test.js
-- is what enforces it, and reverting this migration without reverting that test
-- leaves the test failing -- deliberately, since a frozen table with no new
-- table to write instead is a state somebody has to decide about.

BEGIN;

DROP FUNCTION IF EXISTS public.admin_delete_field_blackout(uuid, uuid);
DROP FUNCTION IF EXISTS public.admin_create_field_blackout(uuid, uuid, uuid, date, date, integer, integer, text, text);
-- **A LATER migration's function, dropped here on purpose.** 20260910000000
-- added `admin_update_field_blackout`, and it cannot outlive the table this
-- file destroys: a plpgsql body is not a catalogue dependency, so without this
-- line `DROP TABLE public.field_blackouts` below succeeds and leaves a
-- SECURITY DEFINER function that `authenticated` may still EXECUTE, standing
-- on a table that is gone. Every call then answers 42P01 -- an internal
-- "relation does not exist" where the right answer is that the capability was
-- reverted. `IF EXISTS`, so reverting in the normal order (20260910000000
-- first, then this) is unaffected.
--
-- **Stated as unproven, because it is.** `scripts/dbharness/run.sh` checks
-- each revert on a database built up to its OWN migration, so the database
-- this line runs against there never has the function and the statement is a
-- no-op the harness cannot distinguish from a correct one. Reverting this
-- migration on a database at head is what would exercise it, and nothing in
-- this repository does that.
DROP FUNCTION IF EXISTS public.admin_update_field_blackout(uuid, uuid, date, date, integer, integer, text, text);

DROP VIEW IF EXISTS public.field_closures;

DROP INDEX IF EXISTS public.idx_field_blackouts_location_date;
DROP INDEX IF EXISTS public.idx_field_blackouts_field_date;

-- Both names: the one this migration shipped with and the one it was renamed
-- to, so the revert works whichever version of the forward migration ran.
DROP POLICY IF EXISTS "Field Blackouts: members select" ON public.field_blackouts;
DROP POLICY IF EXISTS "Admin field blackouts: members select" ON public.field_blackouts;
DROP TRIGGER IF EXISTS field_blackouts_set_timestamp ON public.field_blackouts;
DROP TABLE IF EXISTS public.field_blackouts;

COMMENT ON TABLE public.field_blackout_windows IS NULL;

COMMIT;
