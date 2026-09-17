-- Revert for 20260910000000_admin_update_field_blackout.sql
--
-- Drops `public.admin_update_field_blackout`. Nothing else in that migration
-- creates, alters or comments on anything, so this is the whole of it.
--
-- **It destroys no data and that is exactly why it needs to be loud.** Every
-- blackout survives, every audit row survives, and the next operator who opens
-- the editor silently gets the pre-8.4-gap-A behaviour back: an edit becomes a
-- delete followed by a create. A revert whose only symptom is that a capability
-- quietly stops existing is the shape LIVE-2's round 1 found naming one cost of
-- three, so all three are named here and two of them are COUNTED against what
-- the database actually holds.
--
-- Revert only if 20260910000000 is itself implicated in an incident.
\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  v_admin bigint; v_edits bigint; v_import bigint;
BEGIN
  -- 1. The headline: editing in place stops existing.
  SELECT count(*) INTO v_admin FROM public.field_blackouts;
  RAISE WARNING 'RESTORING remove-and-re-add as the only way to change a blackout: each of the % admin-authored window(s) in this database now loses its id on any edit, costs FOUR audit rows instead of one (delete before/after, then create before/after), and can no longer be followed across an edit by anything that joins on id', v_admin;

  -- 2. The audit vocabulary stops having a writer. The rows already written
  --    stay readable and become a closed set -- which is worse than none for a
  --    reader who assumes an operation still in use, so it is counted.
  SELECT count(*) INTO v_edits FROM public.audit_log
   WHERE metadata->>'operation' = 'admin_update_field_blackout';
  RAISE WARNING 'ALSO REVERTING the single-entry edit audit shape: % existing audit row(s) carry operation=admin_update_field_blackout with phase=update and both before and after; they are left in place and NOTHING will write another, so that vocabulary becomes a closed historical set rather than a live one', v_edits;

  -- 3. The refusal that told an import-owned window apart from a missing one.
  SELECT count(*) INTO v_import FROM public.field_blackout_windows;
  RAISE WARNING 'ALSO REVERTING the 0A000 import-owned refusal: % window(s) in the frozen public.field_blackout_windows lose the only SERVER-side answer distinguishing "this window is owned by the import" from "no such window"; after this revert the sole guard on that path is the check in frontend/src/hooks/useFieldClosures.js, and a caller that is not that hook has none', v_import;
END $$;

DROP FUNCTION IF EXISTS public.admin_update_field_blackout(uuid, uuid, date, date, integer, integer, text, text);

COMMIT;
