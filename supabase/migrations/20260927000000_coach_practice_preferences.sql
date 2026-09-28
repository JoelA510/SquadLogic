-- 8.6 PR 3b, PR 1: coach practice preferences -- the store and its three writers.
--
-- Plan of record: docs/PHASE_8_6_PR3B_PLAN.md §4 (operator ruling 3) and §7 row 1.
--
-- **What this adds.** Per coach, for each of weekday, start time and venue, a
-- level -- must_keep | prefer_keep | dont_care -- and optionally the value it
-- keeps. Coaches REQUEST; only an organisation admin approves, rejects or
-- changes. A decision is written onto the request row, never a row deleted,
-- and an approval supersedes the coach's previously approved row for that
-- dimension (status 'superseded', effective_to closed the day before).
--
-- **No free text, and no PII beyond the coach id.** `dimension`, `level` and
-- `status` are closed vocabularies, and `value` is a weekday code, minutes
-- past local midnight, or a location id -- each checked for its own dimension
-- below. There is deliberately no note or reason column: an operator's prose is
-- where a family's name lands (the BLACKOUT_REASON stance).
--
-- **The copied pattern** is 20260923000000_team_coach_assignments.sql: no FK on
-- coach_id (deleting a coach erases their personal data and leaves an opaque
-- id), RLS on with a single SELECT policy and NO write policy, and definer RPCs
-- as the only writers, each auditing through record_audit_event.
--
-- **Nothing reads this yet.** The UI (PR 2) calls the RPCs; the repair (PR 4)
-- and the auto-scheduler's Deno twin (PR 8) consume approved rows. The dead
-- coaches.preferred_practice_* columns are dropped in PR 8, not here.

BEGIN;

INSERT INTO public.audit_actions (action) VALUES
    ('coach_preference.requested'),
    ('coach_preference.approved'),
    ('coach_preference.rejected'),
    ('coach_preference.changed')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. The store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coach_practice_preferences (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    coach_id        uuid NOT NULL,
    dimension       text NOT NULL,
    level           text NOT NULL,
    value           jsonb,
    status          text NOT NULL DEFAULT 'requested',
    requested_by    uuid,
    requested_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
    decided_by      uuid,
    decided_at      timestamptz,
    effective_from  date,
    effective_to    date,
    CONSTRAINT coach_practice_preferences_dimension_known
        CHECK (dimension IN ('weekday', 'start_time', 'venue')),
    CONSTRAINT coach_practice_preferences_level_known
        CHECK (level IN ('must_keep', 'prefer_keep', 'dont_care')),
    CONSTRAINT coach_practice_preferences_status_known
        CHECK (status IN ('requested', 'approved', 'rejected', 'superseded')),
    -- CASE rather than OR: Postgres does not promise to evaluate an OR's arms
    -- in order, so the integer cast must sit behind the test that allows it.
    -- The codes and ranges are core's (`practice/schemas.js`
    -- PracticeWeekdaySchema; minutes 0-1439; a lowercase canonical uuid).
    CONSTRAINT coach_practice_preferences_value_valid CHECK (CASE
        WHEN value IS NULL THEN true
        WHEN dimension = 'weekday' THEN jsonb_typeof(value) = 'string'
             AND value #>> '{}' IN ('SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT')
        WHEN dimension = 'start_time' THEN CASE
             WHEN jsonb_typeof(value) = 'number' AND value #>> '{}' ~ '^[0-9]{1,4}$'
                 THEN (value #>> '{}')::integer <= 1439
             ELSE false END
        WHEN dimension = 'venue' THEN jsonb_typeof(value) = 'string'
             AND value #>> '{}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        ELSE false END),
    CONSTRAINT coach_practice_preferences_decision_recorded
        CHECK ((status = 'requested') = (decided_at IS NULL)),
    CONSTRAINT coach_practice_preferences_in_force_dated
        CHECK ((status IN ('approved', 'superseded')) = (effective_from IS NOT NULL)
               AND (status = 'superseded') = (effective_to IS NOT NULL)),
    CONSTRAINT coach_practice_preferences_window_ordered
        CHECK (effective_to IS NULL OR effective_to >= effective_from - 1)
);

COMMENT ON TABLE public.coach_practice_preferences IS
  'Per coach and dimension (weekday, start_time, venue): must_keep | prefer_keep | dont_care, optionally with the value kept. Coaches request; only org admins decide. Written only by request_coach_practice_preference, admin_decide_coach_practice_preference and admin_set_coach_practice_preference. No free text.';
COMMENT ON COLUMN public.coach_practice_preferences.coach_id IS
  'A coaches.id, deliberately without a foreign key (the team_coach_assignments stance): deleting a coach erases their personal data and leaves this history holding an opaque id.';
COMMENT ON COLUMN public.coach_practice_preferences.value IS
  'weekday: a JSON string SUN..SAT; start_time: a JSON integer 0-1439 (minutes past local midnight); venue: a JSON string holding a locations.id. The reference is the team''s current series when that series is being moved, otherwise this value (plan §4); with neither, the preference does nothing.';

-- At most one approved row per (coach, dimension). The strictest-wins rule
-- reads ONE level per coach per dimension; a second approved row would make
-- the answer depend on read order.
CREATE UNIQUE INDEX IF NOT EXISTS coach_practice_preferences_one_approved
    ON public.coach_practice_preferences (coach_id, dimension)
    WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS coach_practice_preferences_org_coach
    ON public.coach_practice_preferences (organization_id, coach_id);

ALTER TABLE public.coach_practice_preferences ENABLE ROW LEVEL SECURITY;

-- Admins read every row of their organisation; a coach reads their own rows
-- (plan §5 decision 9). There is no write policy: the three definer RPCs below
-- are the only writers.
DROP POLICY IF EXISTS "Coach practice preferences: admins and the coach read"
    ON public.coach_practice_preferences;
CREATE POLICY "Coach practice preferences: admins and the coach read"
    ON public.coach_practice_preferences
    FOR SELECT TO authenticated
    USING (
        public.is_org_member(organization_id)
        AND (
            public.is_org_admin(organization_id)
            OR EXISTS (
                SELECT 1
                  FROM public.coaches c
                 WHERE c.id = coach_practice_preferences.coach_id
                   AND c.organization_id = coach_practice_preferences.organization_id
                   AND c.user_id = (SELECT auth.uid())
            )
        )
    );

-- Default privileges hand new tables to authenticated and service_role with
-- every privilege, so the revoke names them too (the 20260923000000 reasoning).
REVOKE ALL ON public.coach_practice_preferences FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.coach_practice_preferences TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. request: the coach themself, or an admin of the coach's organisation
-- ---------------------------------------------------------------------------
--
-- A request is never in force alone (the `proposer` change of the plan): it
-- waits for admin_decide_coach_practice_preference. JSON null is read as SQL
-- NULL, so "no value" has one spelling in the store.
CREATE OR REPLACE FUNCTION public.request_coach_practice_preference(
    p_coach_id uuid,
    p_dimension text,
    p_level text,
    p_value jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_value jsonb := NULLIF(p_value, 'null'::jsonb);
    v_org uuid;
    v_is_self boolean;
    v_id uuid;
BEGIN
    IF p_coach_id IS NULL OR p_dimension IS NULL OR p_level IS NULL THEN
        RAISE EXCEPTION 'p_coach_id, p_dimension and p_level are required'
            USING ERRCODE = '23502';
    END IF;

    SELECT c.organization_id INTO v_org FROM public.coaches c WHERE c.id = p_coach_id;

    -- An unknown coach and a coach who is not the caller refuse alike, so the
    -- RPC cannot be used to probe which coach ids exist.
    v_is_self := v_uid IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.coaches c
         WHERE c.id = p_coach_id
           AND c.user_id = v_uid
    );
    IF v_org IS NULL
       OR NOT ((v_is_self AND public.is_org_member(v_org)) OR public.is_org_admin(v_org)) THEN
        RAISE EXCEPTION 'Access denied: only the coach themself or an admin of their organization requests a coach practice preference'
            USING ERRCODE = '42501';
    END IF;

    IF p_dimension = 'venue' AND jsonb_typeof(v_value) = 'string' AND NOT EXISTS (
        SELECT 1 FROM public.locations l
         WHERE l.organization_id = v_org AND l.id::text = v_value #>> '{}'
    ) THEN
        RAISE EXCEPTION 'venue % is not a location of the coach''s organization', v_value #>> '{}'
            USING ERRCODE = '23503';
    END IF;

    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, dimension, level, value, status, requested_by)
    VALUES (v_org, p_coach_id, p_dimension, p_level, v_value, 'requested', v_uid)
    RETURNING id INTO v_id;

    PERFORM public.record_audit_event(
        v_org,
        'coach_preference.requested',
        'coach_practice_preference',
        v_id,
        jsonb_build_object(
            'coach_id', p_coach_id, 'dimension', p_dimension, 'level', p_level,
            'value', v_value, 'by_coach', v_is_self
        )
    );

    RETURN jsonb_build_object(
        'id', v_id, 'organization_id', v_org, 'coach_id', p_coach_id,
        'dimension', p_dimension, 'level', p_level, 'value', v_value, 'status', 'requested'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.request_coach_practice_preference(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_coach_practice_preference(uuid, text, text, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. decide: approve or reject a request -- admins only
-- ---------------------------------------------------------------------------
--
-- An approval may change the requested level or value (the plan's
-- approved-option step): SQL NULL keeps what was requested, JSON null clears
-- the value. It supersedes the coach's approved row for the dimension FIRST,
-- because the one-approved index is checked per statement.
CREATE OR REPLACE FUNCTION public.admin_decide_coach_practice_preference(
    p_preference_id uuid,
    p_decision text,
    p_level text DEFAULT NULL,
    p_value jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_row public.coach_practice_preferences%ROWTYPE;
    v_status text;
    v_level text;
    v_value jsonb;
    v_superseded uuid;
BEGIN
    IF p_preference_id IS NULL OR p_decision IS NULL THEN
        RAISE EXCEPTION 'p_preference_id and p_decision are required'
            USING ERRCODE = '23502';
    END IF;
    IF p_decision NOT IN ('approve', 'reject') THEN
        RAISE EXCEPTION 'p_decision must be approve or reject, not %', p_decision
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row
      FROM public.coach_practice_preferences
     WHERE id = p_preference_id
       FOR UPDATE;

    -- Only an admin of the row's organisation decides. A coach -- the one who
    -- asked included -- is refused: that is the whole of ruling 3.
    IF NOT FOUND OR NOT public.is_org_admin(v_row.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin decides a coach practice preference'
            USING ERRCODE = '42501';
    END IF;
    IF v_row.status <> 'requested' THEN
        RAISE EXCEPTION 'coach practice preference % is already %; only a requested row is decided',
            p_preference_id, v_row.status
            USING ERRCODE = '22023';
    END IF;

    IF p_decision = 'reject' THEN
        IF p_level IS NOT NULL OR p_value IS NOT NULL THEN
            RAISE EXCEPTION 'a rejection changes nothing; p_level and p_value belong to an approval'
                USING ERRCODE = '22023';
        END IF;
        v_status := 'rejected';
        UPDATE public.coach_practice_preferences
           SET status = v_status, decided_by = v_uid, decided_at = clock_timestamp()
         WHERE id = p_preference_id;
    ELSE
        v_status := 'approved';
        v_level := COALESCE(p_level, v_row.level);
        v_value := CASE WHEN p_value IS NULL THEN v_row.value
                        WHEN jsonb_typeof(p_value) = 'null' THEN NULL
                        ELSE p_value END;
        IF v_row.dimension = 'venue' AND jsonb_typeof(v_value) = 'string' AND NOT EXISTS (
            SELECT 1 FROM public.locations l
             WHERE l.organization_id = v_row.organization_id AND l.id::text = v_value #>> '{}'
        ) THEN
            RAISE EXCEPTION 'venue % is not a location of the coach''s organization', v_value #>> '{}'
                USING ERRCODE = '23503';
        END IF;

        -- One writer per (coach, dimension) at a time, so a concurrent approval
        -- waits here rather than losing to the one-approved index with a raw 23505.
        PERFORM pg_advisory_xact_lock(hashtext('coach_practice_preferences'), hashtext(v_row.coach_id::text || '/' || v_row.dimension));
        IF NOT EXISTS (SELECT 1 FROM public.coaches c
                        WHERE c.id = v_row.coach_id AND c.organization_id = v_row.organization_id) THEN
            RAISE EXCEPTION 'coach % no longer exists in the organization; the request cannot be approved', v_row.coach_id
                USING ERRCODE = '23503';
        END IF;
        -- A request older than the decision in force is stale: approving it
        -- would silently undo a newer decision. Reject it, or request again.
        IF EXISTS (SELECT 1 FROM public.coach_practice_preferences p
                    WHERE p.coach_id = v_row.coach_id AND p.dimension = v_row.dimension
                      AND p.status = 'approved' AND p.decided_at > v_row.requested_at) THEN
            RAISE EXCEPTION 'coach practice preference % is stale: a later decision on % is in force', p_preference_id, v_row.dimension
                USING ERRCODE = '22023';
        END IF;

        UPDATE public.coach_practice_preferences
           SET status = 'superseded', effective_to = current_date - 1
         WHERE coach_id = v_row.coach_id
           AND dimension = v_row.dimension
           AND status = 'approved'
        RETURNING id INTO v_superseded;

        UPDATE public.coach_practice_preferences
           SET status = v_status, level = v_level, value = v_value,
               decided_by = v_uid, decided_at = clock_timestamp(),
               effective_from = current_date
         WHERE id = p_preference_id;
    END IF;

    PERFORM public.record_audit_event(
        v_row.organization_id,
        'coach_preference.' || v_status,
        'coach_practice_preference',
        p_preference_id,
        jsonb_build_object(
            'coach_id', v_row.coach_id, 'dimension', v_row.dimension,
            'requested_level', v_row.level, 'requested_value', v_row.value,
            'level', v_level, 'value', v_value, 'superseded_id', v_superseded
        )
    );

    RETURN jsonb_build_object(
        'id', p_preference_id, 'status', v_status, 'coach_id', v_row.coach_id,
        'dimension', v_row.dimension, 'level', v_level, 'value', v_value,
        'superseded_id', v_superseded
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_decide_coach_practice_preference(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_decide_coach_practice_preference(uuid, text, text, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. set: an admin writes a coach's preference directly -- admins only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_coach_practice_preference(
    p_coach_id uuid,
    p_dimension text,
    p_level text,
    p_value jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_value jsonb := NULLIF(p_value, 'null'::jsonb);
    v_org uuid;
    v_before public.coach_practice_preferences%ROWTYPE;
    v_id uuid;
BEGIN
    IF p_coach_id IS NULL OR p_dimension IS NULL OR p_level IS NULL THEN
        RAISE EXCEPTION 'p_coach_id, p_dimension and p_level are required'
            USING ERRCODE = '23502';
    END IF;

    SELECT c.organization_id INTO v_org FROM public.coaches c WHERE c.id = p_coach_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin sets a coach practice preference'
            USING ERRCODE = '42501';
    END IF;

    IF p_dimension = 'venue' AND jsonb_typeof(v_value) = 'string' AND NOT EXISTS (
        SELECT 1 FROM public.locations l
         WHERE l.organization_id = v_org AND l.id::text = v_value #>> '{}'
    ) THEN
        RAISE EXCEPTION 'venue % is not a location of the coach''s organization', v_value #>> '{}'
            USING ERRCODE = '23503';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('coach_practice_preferences'), hashtext(p_coach_id::text || '/' || p_dimension));

    UPDATE public.coach_practice_preferences
       SET status = 'superseded', effective_to = current_date - 1
     WHERE coach_id = p_coach_id
       AND dimension = p_dimension
       AND status = 'approved'
    RETURNING * INTO v_before;

    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, dimension, level, value, status,
         requested_by, decided_by, decided_at, effective_from)
    VALUES (v_org, p_coach_id, p_dimension, p_level, v_value, 'approved',
            v_uid, v_uid, clock_timestamp(), current_date)
    RETURNING id INTO v_id;

    PERFORM public.record_audit_event(
        v_org,
        'coach_preference.changed',
        'coach_practice_preference',
        v_id,
        jsonb_build_object(
            'coach_id', p_coach_id, 'dimension', p_dimension,
            'level', p_level, 'value', v_value,
            'superseded_id', v_before.id,
            'before_level', v_before.level, 'before_value', v_before.value
        )
    );

    RETURN jsonb_build_object(
        'id', v_id, 'status', 'approved', 'coach_id', p_coach_id, 'dimension', p_dimension,
        'level', p_level, 'value', v_value, 'superseded_id', v_before.id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_coach_practice_preference(uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_coach_practice_preference(uuid, text, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.request_coach_practice_preference(uuid, text, text, jsonb) IS
  'A coach (for themself) or an org admin requests a practice preference. Never in force until decided. Audited as coach_preference.requested.';
COMMENT ON FUNCTION public.admin_decide_coach_practice_preference(uuid, text, text, jsonb) IS
  'Org admins only: approve (optionally changing level/value; supersedes the previous approved row) or reject a requested preference. Audited as coach_preference.approved / coach_preference.rejected.';
COMMENT ON FUNCTION public.admin_set_coach_practice_preference(uuid, text, text, jsonb) IS
  'Org admins only: write a coach''s preference directly as approved, superseding the previous approved row. Audited as coach_preference.changed.';

COMMIT;
