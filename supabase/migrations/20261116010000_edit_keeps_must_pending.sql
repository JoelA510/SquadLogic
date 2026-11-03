-- Editing a pending must leaves it pending (owner decision 2026-11-02, "address smaller items as
-- recommended"; plan docs/changes/2026-11-02-preference-followups.md, item 1; follows C1,
-- 20261112010000, and C2, whose editor had to warn about this).
--
-- **Why.** `admin_edit_practice_preference` decided a requested must by the level it was sent: a rule
-- with `requested_level = 'must'` saved at `prefer` became `kept_prefer`, saved at `must` became
-- `accepted`. An admin correcting the days of a rule that is still waiting for a decision therefore
-- declined it without meaning to (the editor warned, and defaulted to Prefer so as not to accept it
-- instead). Correcting a coach's typo should decide nothing.
--
-- **The change.** One rule, in the one function: a rule whose `must_decision` is `pending` and that is
-- saved at `prefer` (the level it is already in force at) stays `pending`, and its `decided_by` and
-- `decided_at` are not stamped. Everything else is the deployed body:
--   - a pending must saved at `must` is `accepted` (the edit decides, explicitly), stamped;
--   - an accepted must saved at `prefer` is `kept_prefer`, stamped (the admin changed the level);
--   - a rule kept as prefer, and a rule nobody asked a must of, behave as before.
-- Only an admin makes a rule a must, as before: the decisions are Accept as must and Keep as prefer
-- (`admin_decide_must_preference`), Accept all (`admin_accept_all_musts`), or an edit that changes the
-- level to must.
--
-- **Why that is safe for a caller written before this.** A pending must and a must kept as prefer are
-- both in force as `prefer` (`level`), and every reader of a rule's strength (core, the Edge twin, the
-- solver gate, the repair) reads `level` and never `must_decision`, so the scheduler cannot tell the
-- two apart. No row becomes a must unless `must` is sent or an Accept is made. The visible difference
-- is that the rule stays on the Pending musts list.
--
-- **What does not change.** The signature (eleven arguments, `p_level` still defaulting to `prefer`),
-- the result (the row as jsonb), every refusal (42501 for a non-admin and for another organization's
-- admin alike, 22023 `not_in_force`, 22023 `season_completed`, the CHECKs' 23514), the audit action
-- (`practice_preference.edited`, with `before` and `after`), the row lock (`SELECT ... FOR UPDATE`: none
-- of the five admin RPCs takes a per-team advisory lock, only the import finalizer does) and the
-- grants. No table, column, CHECK, policy or grant is touched, and no new audit action.
--
-- `CREATE OR REPLACE` keeps the function's owner and ACL and resets its `SET` clauses (lesson 40), so
-- the pinned search path and time zone are stated again and the end-state check reads them.
--
-- Reversible: docs/sql/20261116010000_revert.sql restores the deployed body (md5 checked) and its
-- comment. Smoke: docs/sql/20261116010000_smoke.sql. pgTAP: supabase/tests/practice_preference_rules.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting body is checked: the one 20261112010000 created, as deployed.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_md5 text;
    v_n integer;
BEGIN
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'admin_edit_practice_preference';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'expected one admin_edit_practice_preference, found %', v_n;
    END IF;
    -- Carriage returns stripped, as 20261112010000 does: a body stored with CRLF line ends is the same text.
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)');
    IF v_md5 IS DISTINCT FROM '4d909e3ea286460367c2ca7c8671f89d' THEN
        RAISE EXCEPTION 'admin_edit_practice_preference is not the body this migration replaces (md5 %, expected 4d909e3ea286460367c2ca7c8671f89d)', v_md5;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The function, from the deployed body.
-- ---------------------------------------------------------------------------

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
           -- prefer has kept it as prefer; a rule nobody asked a must of stays plain. A requested must
           -- that is still pending and is saved at prefer (the level it is in force at) is not decided:
           -- only Accept, Keep as prefer, Accept all or a save at must decide it.
           requested_level = CASE WHEN v_level = 'must' THEN 'must' ELSE requested_level END,
           must_decision = CASE WHEN v_level = 'must' THEN 'accepted'
                                WHEN must_decision = 'pending' THEN 'pending'
                                WHEN requested_level = 'must' THEN 'kept_prefer'
                                ELSE NULL END,
           decided_by = CASE WHEN v_level = 'must'
                                  OR (requested_level = 'must' AND must_decision IS DISTINCT FROM 'pending')
                             THEN auth.uid() ELSE decided_by END,
           decided_at = CASE WHEN v_level = 'must'
                                  OR (requested_level = 'must' AND must_decision IS DISTINCT FROM 'pending')
                             THEN now() ELSE decided_at END,
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
  'Admin-only: replace an in-force rule''s conditions, level, priority and window (the coach and team stay). A requested must that is still pending stays pending when it is saved at prefer, and only Accept, Keep as prefer, Accept all or a save at must decides it. Audited as practice_preference.edited with before and after. 20261112010000, 20261116010000.';

-- ---------------------------------------------------------------------------
-- 3. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_oid oid := to_regprocedure('public.admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)');
    v_body text;
BEGIN
    IF v_oid IS NULL OR (SELECT count(*) FROM pg_proc p
                          WHERE p.pronamespace = 'public'::regnamespace
                            AND p.proname = 'admin_edit_practice_preference') <> 1 THEN
        RAISE EXCEPTION 'admin_edit_practice_preference is not exactly the one signature it had';
    END IF;
    SELECT p.prosrc INTO v_body FROM pg_proc p WHERE p.oid = v_oid;
    IF md5(replace(v_body, E'\r', '')) = '4d909e3ea286460367c2ca7c8671f89d' THEN
        RAISE EXCEPTION 'admin_edit_practice_preference is still the body this migration replaces';
    END IF;
    IF position('must_decision = ''pending'' THEN ''pending''' IN v_body) = 0
       OR position('must_decision IS DISTINCT FROM ''pending''' IN v_body) = 0 THEN
        RAISE EXCEPTION 'admin_edit_practice_preference does not leave a pending must pending';
    END IF;
    -- The refusals and the audit are the deployed ones.
    IF position('only an organization admin edits a practice preference' IN v_body) = 0
       OR position('FOR UPDATE' IN v_body) = 0
       OR position('practice_preference.edited' IN v_body) = 0 THEN
        RAISE EXCEPTION 'admin_edit_practice_preference lost its admin check, its row lock or its audit';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = v_oid AND p.prosecdef
                      AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']) THEN
        RAISE EXCEPTION 'admin_edit_practice_preference is not a definer with search_path and UTC pinned';
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'admin_edit_practice_preference is not executable by authenticated and only by it (anon must not)';
    END IF;
    IF (SELECT obj_description(v_oid, 'pg_proc')) NOT LIKE '%stays pending when it is saved at prefer%' THEN
        RAISE EXCEPTION 'admin_edit_practice_preference does not carry its new comment';
    END IF;
END;
$check$;

COMMIT;
