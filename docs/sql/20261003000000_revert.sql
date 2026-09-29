-- Revert for 20261003000000_practice_lighting_overrides.sql
--
-- **This revert DESTROYS every portable-lighting override**: requested,
-- decided and withdrawn alike. No other table records them, so the figures
-- are printed BEFORE the drop and the transcript of a revert says what it
-- cost. `scripts/dbharness/run.sh` plants 3 rows across 2 slots, 1 of them
-- approved, and checks this warning prints exactly those figures.
--
-- Removes the four RPCs, the shared caller_coaches_practice_slot helper and
-- the table. The five practice_lighting_override.* audit actions and the
-- audit rows written under them stay: audit history is not this revert's to
-- erase. btree_gist stays: 20260929000000 created it and its exclusion
-- constraint still uses it.

BEGIN;

DO $warn$
DECLARE
    v_rows integer;
    v_slots integer;
    v_approved integer;
BEGIN
    SELECT count(*), count(DISTINCT practice_slot_id), count(*) FILTER (WHERE status = 'approved')
      INTO v_rows, v_slots, v_approved
      FROM public.practice_lighting_overrides;
    RAISE WARNING 'this revert DESTROYS % practice lighting override row(s) across % slot(s); % of them are APPROVED and in force',
        v_rows, v_slots, v_approved;
END;
$warn$;

DROP FUNCTION IF EXISTS public.admin_set_practice_lighting_override(uuid, date, date);
DROP FUNCTION IF EXISTS public.withdraw_practice_lighting_override(uuid);
DROP FUNCTION IF EXISTS public.admin_decide_practice_lighting_override(uuid, text);
DROP FUNCTION IF EXISTS public.request_practice_lighting_override(uuid, date, date);
-- The table's read policy calls the helper, so the table goes first.
DROP TABLE IF EXISTS public.practice_lighting_overrides;
DROP FUNCTION IF EXISTS public.caller_coaches_practice_slot(uuid);

DO $verify$
BEGIN
    IF to_regclass('public.practice_lighting_overrides') IS NOT NULL THEN
        RAISE EXCEPTION 'practice_lighting_overrides survived its own revert';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname IN ('request_practice_lighting_override',
                                    'admin_decide_practice_lighting_override',
                                    'withdraw_practice_lighting_override',
                                    'admin_set_practice_lighting_override',
                                    'caller_coaches_practice_slot')) THEN
        RAISE EXCEPTION 'a practice lighting override function survived its own revert';
    END IF;
    RAISE NOTICE 'revert verified: practice_lighting_overrides, its four RPCs and caller_coaches_practice_slot are gone; the practice_lighting_override.* audit actions stay registered.';
END;
$verify$;

COMMIT;
