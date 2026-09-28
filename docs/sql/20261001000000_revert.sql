-- Revert for 20261001000000_drop_coach_preferred_practice_columns.sql
--
-- Re-adds coaches.preferred_practice_days (day_of_week[]) and
-- coaches.preferred_practice_window (tsrange), both NULLABLE and empty. The
-- forward migration refused to run while any coach held a value, so there is
-- nothing to restore: the columns come back exactly as they were when they
-- were dropped (every value NULL).
--
-- Nothing reads them after this revert either -- their readers were never
-- written -- so re-adding them changes no behaviour.
-- `scripts/dbharness/run.sh` checks the columns are back, nullable and of
-- their original types, and that re-applying the forward migration then
-- refuses while a coach holds a value.

BEGIN;

ALTER TABLE public.coaches
    ADD COLUMN IF NOT EXISTS preferred_practice_days public.day_of_week[],
    ADD COLUMN IF NOT EXISTS preferred_practice_window tsrange;

-- A database built from 20251208000000_consolidated_schema.sql (whose
-- `coaches` table the definitive schema's CREATE TABLE IF NOT EXISTS kept)
-- carried this CHECK, and the drop took it with the column. Restored on every
-- database: the column comes back empty, so it holds trivially, and a revert
-- should not leave the column laxer than it ever was.
ALTER TABLE public.coaches
    DROP CONSTRAINT IF EXISTS coaches_preferred_practice_days_check,
    ADD CONSTRAINT coaches_preferred_practice_days_check
        CHECK (preferred_practice_days <@ ARRAY['mon', 'tue', 'wed', 'thu']::public.day_of_week[]);

COMMIT;
