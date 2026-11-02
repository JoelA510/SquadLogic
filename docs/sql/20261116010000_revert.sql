-- Revert for 20261116010000_edit_keeps_must_pending.sql
--
-- Restores `public.admin_edit_practice_preference` to the body 20261112010000 created (checked by md5 at the
-- end, carriage returns removed) and to its comment: an edit of a rule that was asked for as a must decides the
-- request again, `prefer` keeping it as prefer and `must` accepting it. Nothing else was changed by the
-- migration, so nothing else is restored: the signature, the grants, the audit action and every row are as
-- they were.
--
-- **What it cannot undo.** A rule an admin edited while the migration was in place and that stayed pending is
-- still pending. That is a valid row under the old function (it is in force as prefer, on the Pending musts
-- list), and the old function decides it the next time it is edited.
--
-- **Revert the frontend with it.** The editor deployed with the migration shows "Still pending" with Accept and
-- Keep as prefer buttons for a pending rule and sends the level in force when it saves; against the old
-- function that save keeps the rule as prefer. Redeploy the previous frontend with it.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_edit_practice_preference(
    p_preference_id uuid,
    p_level text DEFAULT 'prefer',
    p_weekdays text[] DEFAULT NULL,
    p_start_minutes integer[] DEFAULT NULL,
    p_venue_ids uuid[] DEFAULT NULL,
    p_keep_weekday boolean DEFAULT false,
    p_keep_start boolean DEFAULT false,
    p_keep_venue boolean DEFAULT false,
    p_coach_priority text DEFAULT NULL,
    p_effective_from date DEFAULT NULL,
    p_effective_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_before public.coach_practice_preferences%ROWTYPE;
    v_after public.coach_practice_preferences%ROWTYPE;
    v_season_status text;
    v_level text := COALESCE(p_level, 'prefer');
BEGIN
    IF p_preference_id IS NULL THEN
        RAISE EXCEPTION 'p_preference_id is required' USING ERRCODE = '23502';
    END IF;
    SELECT * INTO v_before FROM public.coach_practice_preferences WHERE id = p_preference_id FOR UPDATE;
    IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_org_admin(v_before.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin edits a practice preference' USING ERRCODE = '42501';
    END IF;
    IF v_level NOT IN ('prefer', 'must') THEN
        RAISE EXCEPTION 'p_level must be prefer or must, not %', p_level USING ERRCODE = '22023';
    END IF;
    IF v_before.status <> 'in_force' THEN
        RAISE EXCEPTION 'practice preference % is %, not in force, so it cannot be edited', p_preference_id, v_before.status
            USING ERRCODE = '22023', DETAIL = 'not_in_force';
    END IF;
    SELECT s.status INTO v_season_status
      FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
      JOIN public.season_settings s ON s.id = d.season_settings_id
     WHERE t.id = v_before.team_id;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'The season of practice preference % is completed and takes no change', p_preference_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    UPDATE public.coach_practice_preferences
       SET weekdays = p_weekdays,
           start_minutes = p_start_minutes,
           venue_ids = p_venue_ids,
           keep_weekday = COALESCE(p_keep_weekday, false),
           keep_start = COALESCE(p_keep_start, false),
           keep_venue = COALESCE(p_keep_venue, false),
           coach_priority = p_coach_priority,
           effective_from = p_effective_from,
           effective_to = p_effective_to,
           level = v_level,
           -- An admin who makes a rule a must has asked for it; one who makes a requested must a
           -- prefer has kept it as prefer; a rule nobody asked a must of stays plain.
           requested_level = CASE WHEN v_level = 'must' THEN 'must' ELSE requested_level END,
           must_decision = CASE WHEN v_level = 'must' THEN 'accepted'
                                WHEN requested_level = 'must' THEN 'kept_prefer'
                                ELSE NULL END,
           decided_by = CASE WHEN v_level = 'must' OR requested_level = 'must' THEN auth.uid() ELSE decided_by END,
           decided_at = CASE WHEN v_level = 'must' OR requested_level = 'must' THEN now() ELSE decided_at END,
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = p_preference_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        v_after.organization_id, 'practice_preference.edited', 'coach_practice_preference', v_after.id,
        jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after))
    );
    RETURN to_jsonb(v_after);
END;
$function$;

COMMENT ON FUNCTION public.admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date) IS
  'Admin-only: replace an in-force rule''s conditions, level, priority and window (the coach and team stay). Audited as practice_preference.edited with before and after. 20261112010000.';

DO $revert$
DECLARE
    v_oid oid := to_regprocedure('public.admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)');
    v_md5 text;
BEGIN
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5 FROM pg_proc p WHERE p.oid = v_oid;
    IF v_md5 IS DISTINCT FROM '4d909e3ea286460367c2ca7c8671f89d' THEN
        RAISE EXCEPTION 'admin_edit_practice_preference was not restored to its 20261112010000 body (md5 %)', v_md5;
    END IF;
    IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                                          AND p.proname = 'admin_edit_practice_preference') <> 1 THEN
        RAISE EXCEPTION 'admin_edit_practice_preference has more than one signature after the revert';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = v_oid AND p.prosecdef
                      AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']) THEN
        RAISE EXCEPTION 'the restored edit function is not a definer with search_path and UTC pinned';
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'the restored edit function is not executable by authenticated and only by it';
    END IF;
    IF (SELECT obj_description(v_oid, 'pg_proc')) LIKE '%stays pending%' THEN
        RAISE EXCEPTION 'the restored edit function still carries the new comment';
    END IF;
    RAISE NOTICE 'revert verified: admin_edit_practice_preference is back as at 20261112010000 (an edit decides a requested must by the level it is sent)';
END;
$revert$;

COMMIT;
