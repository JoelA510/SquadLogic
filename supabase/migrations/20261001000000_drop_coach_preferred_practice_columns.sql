-- 8.6 PR 3b PR 8: retire coaches.preferred_practice_days / preferred_practice_window.
--
-- Plan of record: docs/PHASE_8_6_PR3B_PLAN.md §4 "Retire dead fields" and §5
-- decision 8 ("Drop (prod count 0)"). CLAUDE.md §3: never leave a field
-- parsed and unread.
--
-- **Why.** Both columns date from the first schema and nothing ever honoured
-- them: no RPC, view, policy, Edge Function, core module or page reads either
-- one (the repo-wide grep is in the PR). A coach's practice preference is now
-- a row in public.coach_practice_preferences (20260927000000), requested by
-- the coach and approved by an admin, and the auto-scheduler loads the
-- approved rows itself (8.6 PR 3b PR 8). Two columns that read as the place a
-- coach's availability lives, and are not, are how a preference gets typed in
-- and silently ignored.
--
-- **Production count 2026-09-24: 0 of 130 coaches hold a value in either.**
-- That count is re-checked here rather than trusted: if any coach holds a
-- value when this runs, the migration refuses (55000) and drops nothing, so a
-- value typed in since the count was taken is never destroyed in silence.
--
-- Revert: docs/sql/20261001000000_revert.sql (re-adds both columns, nullable,
-- empty). Smoke: docs/sql/20261001000000_smoke.sql.

BEGIN;

-- Held from the count to the drop, so a value written in between cannot be
-- destroyed after the guard has counted zero.
LOCK TABLE public.coaches IN SHARE ROW EXCLUSIVE MODE;

DO $guard$
DECLARE
    v_held integer;
BEGIN
    SELECT count(*) INTO v_held
      FROM public.coaches
     WHERE preferred_practice_days IS NOT NULL
        OR preferred_practice_window IS NOT NULL;
    IF v_held > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '55000',
            MESSAGE = format(
                'refusing to drop coaches.preferred_practice_days/_window: %s coach(es) hold a value',
                v_held),
            HINT = 'Move each value into coach_practice_preferences (or clear it deliberately) first.';
    END IF;
END;
$guard$;

ALTER TABLE public.coaches
    DROP COLUMN preferred_practice_days,
    DROP COLUMN preferred_practice_window;

COMMIT;
