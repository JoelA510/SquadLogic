-- 8.8 PR 2: effective-dated coach assignment.
--
-- **What this adds.** `team_coach_assignments` is the source of truth for who
-- coaches which team, in which role, and from when to when. One row per
-- (team, coach, role) appointment. An assignment ending is an END DATE
-- WRITTEN, never a row deleted -- that is the lifecycle 8.8 exists to add,
-- and it is what makes "who coached this team three weeks ago" answerable.
--
-- **`teams.coach_id` and `teams.assistant_coach_ids` stay**, as the
-- current-state denormalisation every existing reader depends on
-- (`frontend/src/utils/teamCoaches.js` exists because a team row reaches the
-- app under half a dozen spellings). They are now written ONLY through
-- `public.set_team_coaches()`, which writes the assignment rows and the two
-- columns in one statement sequence inside the caller's transaction.
--
-- **No trigger, deliberately.** `frontend/src/lib/mockSupabaseClient.js`
-- hand-implements these RPCs and has no trigger engine, so a sync trigger
-- would exist in Postgres and not in the mock: a twin arm, half-applied.
-- LESSONS_LEARNED #7 recommends a trigger for denormalised pointers; the 8.8
-- planning ruling (PHASE_8_PROGRESS, "Rulings on the proposed four-PR split",
-- item 4) overrides it here for that reason, and the drift check below is
-- what stands in for the trigger's guarantee.
--
-- **The writer census this migration routes** (the live definition of every
-- function whose body writes either column, established per signature across
-- every migration -- see the PR body for the commands):
--
--   admin_assign_team_coach   20260503050000  UPDATE teams SET coach_id
--   admin_delete_coaches      20260613000000  UPDATE teams SET coach_id / assistant_coach_ids
--   persist_team_schedule     20260610000000  INSERT .. ON CONFLICT DO UPDATE SET both
--
-- `finalize_coach_import_job`, `rollback_coach_import_job` and
-- `admin_update_coach_status` READ the columns (as assignment guards) and
-- write neither. The FK `teams.coach_id -> coaches ON DELETE SET NULL` is an
-- implicit writer; both coach-deleting functions keep it from firing
-- (`admin_delete_coaches` routes the unassignment first; the import rollback
-- refuses to delete an assigned coach). No RLS policy on `teams` permits a
-- client write (the last one was dropped by 20260726000000), and the seed
-- files write the columns only at database creation, before any assignment
-- exists -- the backfill at the end of this file covers what they leave.
--
-- **Dates.** `effective_from` and `effective_to` are INCLUSIVE, matching
-- `windowCoversDate()` in `packages/core/src/people/roster.js`, so a row read
-- by `buildCoachRoster({ asOf })` means what it means here. A change that
-- takes effect on day D ends the old row on D - 1 and starts the new one on
-- D. A row started and ended on the same D therefore carries
-- `effective_to = effective_from - 1`: it never took effect, and it is KEPT,
-- because the lifecycle deletes nothing.
--
-- **Ids, not names.** `docs/MODEL_GAPS.md` records that append-only baselines
-- freeze coach names and emails with no erasure path. This table holds a
-- coach id and nothing that identifies a person, and `coach_id` carries NO
-- foreign key on purpose: deleting a coach erases their personal data from
-- `coaches`, and the history keeps an opaque id that no longer resolves.
-- A cascade would erase the history; SET NULL would keep a row that says
-- "somebody coached this team" and nothing else.
--
-- Out of scope by ruling: team effective dating (GAP-37; a deleted team's
-- assignment rows go with it, ON DELETE CASCADE), notification state (8.10),
-- resolve-run persistence (GAP-35).

BEGIN;

INSERT INTO public.audit_actions (action) VALUES ('team.coach_assignments_changed')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. The store
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_coach_assignments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    team_id         uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    coach_id        uuid NOT NULL,
    role            text NOT NULL CHECK (role IN ('lead', 'assistant')),
    effective_from  date NOT NULL,
    effective_to    date,
    started_via     text NOT NULL,
    started_by      uuid,
    ended_via       text,
    ended_by        uuid,
    created_at      timestamptz NOT NULL DEFAULT timezone('utc', now()),
    ended_at        timestamptz,
    CONSTRAINT team_coach_assignments_window_ordered
        CHECK (effective_to IS NULL OR effective_to >= effective_from - 1),
    CONSTRAINT team_coach_assignments_end_recorded
        CHECK ((effective_to IS NULL) = (ended_via IS NULL))
);

COMMENT ON TABLE public.team_coach_assignments IS
  'Source of truth for who coaches which team, in which role, over which INCLUSIVE date window. Written only by set_team_coaches(); an ending is an effective_to written, never a row deleted. teams.coach_id / assistant_coach_ids are the current-state denormalisation of the rows current today; team_coach_assignment_drift() checks they agree.';
COMMENT ON COLUMN public.team_coach_assignments.coach_id IS
  'A coaches.id, deliberately without a foreign key: deleting a coach erases their personal data and leaves this history holding an opaque id.';
COMMENT ON COLUMN public.team_coach_assignments.effective_to IS
  'Inclusive last day. NULL = open. effective_from - 1 = recorded but never in effect (started and ended on the same day).';

-- One open appointment per (team, coach, role). A second open row for the
-- same key would make "is this person on the team" answer twice.
CREATE UNIQUE INDEX IF NOT EXISTS team_coach_assignments_one_open
    ON public.team_coach_assignments (team_id, coach_id, role)
    WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS team_coach_assignments_org_team
    ON public.team_coach_assignments (organization_id, team_id, effective_from);
CREATE INDEX IF NOT EXISTS team_coach_assignments_coach
    ON public.team_coach_assignments (coach_id);

ALTER TABLE public.team_coach_assignments ENABLE ROW LEVEL SECURITY;

-- Read-only to members of the organisation. There is no write policy: the
-- only writer is set_team_coaches(), reached through the definer RPCs below.
DROP POLICY IF EXISTS "Team coach assignments: members read" ON public.team_coach_assignments;
CREATE POLICY "Team coach assignments: members read"
    ON public.team_coach_assignments
    FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id));

-- Default privileges hand new tables to authenticated and service_role with
-- every privilege, so the revoke names them too; a write grant surviving here
-- would let service_role (which bypasses RLS) write rows the columns never see.
REVOKE ALL ON public.team_coach_assignments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.team_coach_assignments TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The single writer of the assignment rows AND the two team columns
-- ---------------------------------------------------------------------------
--
-- `p_lead_coach_id` is the lead from D on (NULL = no lead).
-- `p_assistant_coach_ids` is the full assistant set from D on; NULL means
-- "leave the assistants as they are" -- persist_team_schedule's contract for
-- a payload without the key, which this adopts rather than inventing another.
--
-- SECURITY INVOKER and executable by nobody but the table owner: it is
-- reached only from the SECURITY DEFINER RPCs that have already authorised
-- the caller, so it runs as their owner and inside their transaction. It
-- authorises nobody itself, and a direct call from a client is refused at
-- EXECUTE before RLS is even asked.
--
-- **Append-only in time, per team.** A change may not take effect in the
-- future (the columns are current state, and nothing would move them when
-- the date arrived), and may not take effect before the team's latest
-- recorded change (history would otherwise be rewritten under rows already
-- read). Both refusals are checked only when something actually changes, so
-- a no-op re-persist on any date is still a no-op.
CREATE OR REPLACE FUNCTION public.set_team_coaches(
    p_team_id uuid,
    p_lead_coach_id uuid,
    p_assistant_coach_ids uuid[],
    p_effective_on date,
    p_via text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_org_id uuid;
    v_assistants uuid[];
    v_floor date;
    v_ended jsonb;
    v_started jsonb := '[]'::jsonb;
    v_coach uuid;
    v_columns_written integer;
BEGIN
    IF p_team_id IS NULL THEN
        RAISE EXCEPTION 'p_team_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_effective_on IS NULL THEN
        RAISE EXCEPTION 'p_effective_on is required' USING ERRCODE = '23502';
    END IF;
    IF p_via IS NULL OR btrim(p_via) = '' THEN
        RAISE EXCEPTION 'p_via is required: every assignment row records which writer made it'
            USING ERRCODE = '23502';
    END IF;

    SELECT t.organization_id
      INTO v_org_id
      FROM public.teams t
     WHERE t.id = p_team_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'team % does not exist', p_team_id USING ERRCODE = '23503';
    END IF;

    -- De-duplicated, first occurrence wins, NULL elements dropped.
    IF p_assistant_coach_ids IS NOT NULL THEN
        SELECT COALESCE(array_agg(d.x ORDER BY d.ord), '{}'::uuid[])
          INTO v_assistants
          FROM (
                SELECT DISTINCT ON (u.x) u.x, u.ord
                  FROM unnest(p_assistant_coach_ids) WITH ORDINALITY AS u(x, ord)
                 WHERE u.x IS NOT NULL
                 ORDER BY u.x, u.ord
          ) d;
    END IF;

    -- Every open row that the new state does not keep.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'assignment_id', a.id, 'coach_id', a.coach_id, 'role', a.role,
               'effective_from', a.effective_from) ORDER BY a.role, a.coach_id), '[]'::jsonb)
      INTO v_ended
      FROM public.team_coach_assignments a
     WHERE a.team_id = p_team_id
       AND a.effective_to IS NULL
       AND NOT (
            -- IS NOT DISTINCT FROM, not `=`: with p_lead_coach_id NULL an `=`
            -- yields NULL, NOT NULL is NULL, and the old lead would never end.
            (a.role = 'lead' AND a.coach_id IS NOT DISTINCT FROM p_lead_coach_id)
         OR (a.role = 'assistant' AND (v_assistants IS NULL OR a.coach_id = ANY(v_assistants)))
       );

    -- Every appointment the new state has that no open row carries.
    IF p_lead_coach_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.team_coach_assignments a
         WHERE a.team_id = p_team_id AND a.effective_to IS NULL
           AND a.role = 'lead' AND a.coach_id = p_lead_coach_id
    ) THEN
        v_started := v_started || jsonb_build_array(
            jsonb_build_object('coach_id', p_lead_coach_id, 'role', 'lead'));
    END IF;
    IF v_assistants IS NOT NULL THEN
        FOREACH v_coach IN ARRAY v_assistants LOOP
            IF NOT EXISTS (
                SELECT 1 FROM public.team_coach_assignments a
                 WHERE a.team_id = p_team_id AND a.effective_to IS NULL
                   AND a.role = 'assistant' AND a.coach_id = v_coach
            ) THEN
                v_started := v_started || jsonb_build_array(
                    jsonb_build_object('coach_id', v_coach, 'role', 'assistant'));
            END IF;
        END LOOP;
    END IF;

    IF jsonb_array_length(v_ended) > 0 OR jsonb_array_length(v_started) > 0 THEN
        IF p_effective_on > current_date THEN
            RAISE EXCEPTION 'a coaching change cannot take effect in the future (% is after %): teams.coach_id is current state and nothing would move it when the date arrived',
                p_effective_on, current_date
                USING ERRCODE = '22023';
        END IF;

        SELECT max(GREATEST(a.effective_from, COALESCE(a.effective_to + 1, a.effective_from)))
          INTO v_floor
          FROM public.team_coach_assignments a
         WHERE a.team_id = p_team_id;
        IF v_floor IS NOT NULL AND p_effective_on < v_floor THEN
            RAISE EXCEPTION 'team %''s coaching history already runs to %; a change dated % would rewrite it',
                p_team_id, v_floor, p_effective_on
                USING ERRCODE = '22023';
        END IF;

        UPDATE public.team_coach_assignments a
           SET effective_to = p_effective_on - 1,
               ended_via = p_via,
               ended_by = auth.uid(),
               ended_at = timezone('utc', now())
         WHERE a.id IN (SELECT (e->>'assignment_id')::uuid FROM jsonb_array_elements(v_ended) e);

        INSERT INTO public.team_coach_assignments
            (organization_id, team_id, coach_id, role, effective_from, started_via, started_by)
        SELECT v_org_id, p_team_id, (s->>'coach_id')::uuid, s->>'role', p_effective_on, p_via, auth.uid()
          FROM jsonb_array_elements(v_started) s;
    END IF;

    -- The denormalised columns, from the same inputs, in the same transaction.
    UPDATE public.teams t
       SET coach_id = p_lead_coach_id,
           assistant_coach_ids = COALESCE(v_assistants, t.assistant_coach_ids),
           updated_at = timezone('utc', now())
     WHERE t.id = p_team_id
       AND (t.coach_id IS DISTINCT FROM p_lead_coach_id
            OR (v_assistants IS NOT NULL AND t.assistant_coach_ids IS DISTINCT FROM v_assistants));
    GET DIAGNOSTICS v_columns_written = ROW_COUNT;

    -- Audited whenever either half moved. A column write with no row change is
    -- a drift being healed, and that is exactly the event an operator reading
    -- the audit log needs to be able to find.
    IF jsonb_array_length(v_ended) > 0 OR jsonb_array_length(v_started) > 0
       OR v_columns_written > 0 THEN
        PERFORM public.record_audit_event(
            v_org_id,
            'team.coach_assignments_changed',
            'team',
            p_team_id,
            jsonb_build_object(
                'team_id', p_team_id,
                'effective_on', p_effective_on,
                'via', p_via,
                'ended', v_ended,
                'started', v_started,
                'columns_written', v_columns_written > 0
            )
        );
    END IF;

    RETURN jsonb_build_object(
        'team_id', p_team_id,
        'organization_id', v_org_id,
        'effective_on', p_effective_on,
        'ended', v_ended,
        'started', v_started,
        'columns_written', v_columns_written > 0,
        'changed', jsonb_array_length(v_ended) > 0 OR jsonb_array_length(v_started) > 0
                   OR v_columns_written > 0
    );
END;
$$;

REVOKE ALL ON FUNCTION public.set_team_coaches(uuid, uuid, uuid[], date, text)
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.set_team_coaches(uuid, uuid, uuid[], date, text) IS
  'The ONLY writer of team_coach_assignments and of teams.coach_id / teams.assistant_coach_ids. Ends open rows the new state drops (effective_to = p_effective_on - 1), starts rows it adds, writes both columns, audits. Called from definer RPCs only; executable by nobody else.';

-- ---------------------------------------------------------------------------
-- 3. The drift check: do the columns equal the rows current today?
-- ---------------------------------------------------------------------------
--
-- **The subject set is the teams table, not the assignment rows.** A team
-- whose rows were lost would otherwise be absent from the check rather than
-- reported, which is the "enumerated from the thing a break corrupts" shape
-- CLAUDE.md names. One row per team of the organisation, in sync or not, so a
-- caller can assert it examined every team before trusting "no drift".
--
-- SECURITY INVOKER: RLS on both tables applies to the caller.
CREATE OR REPLACE FUNCTION public.team_coach_assignment_drift(p_organization_id uuid)
RETURNS TABLE (
    team_id uuid,
    in_sync boolean,
    column_lead uuid[],
    assignment_leads uuid[],
    column_assistants uuid[],
    assignment_assistants uuid[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH per_team AS (
        SELECT
            t.id AS team_id,
            ARRAY(SELECT x FROM unnest(ARRAY[t.coach_id]) AS x WHERE x IS NOT NULL) AS column_lead,
            ARRAY(SELECT a.coach_id FROM public.team_coach_assignments a
                   WHERE a.team_id = t.id AND a.role = 'lead'
                     AND a.effective_from <= current_date
                     AND (a.effective_to IS NULL OR a.effective_to >= current_date)
                   ORDER BY a.coach_id) AS assignment_leads,
            ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(t.assistant_coach_ids, '{}'::uuid[])) AS x
                   WHERE x IS NOT NULL ORDER BY x) AS column_assistants,
            ARRAY(SELECT a.coach_id FROM public.team_coach_assignments a
                   WHERE a.team_id = t.id AND a.role = 'assistant'
                     AND a.effective_from <= current_date
                     AND (a.effective_to IS NULL OR a.effective_to >= current_date)
                   ORDER BY a.coach_id) AS assignment_assistants
          FROM public.teams t
         WHERE t.organization_id = p_organization_id
    )
    SELECT p.team_id,
           p.column_lead = p.assignment_leads AND p.column_assistants = p.assignment_assistants,
           p.column_lead, p.assignment_leads, p.column_assistants, p.assignment_assistants
      FROM per_team p
     ORDER BY p.team_id;
$$;

REVOKE ALL ON FUNCTION public.team_coach_assignment_drift(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_coach_assignment_drift(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.team_coach_assignment_drift(uuid) IS
  'One row per team of the organisation: do teams.coach_id / assistant_coach_ids equal the team_coach_assignments rows current today? Enumerated from teams, so a team whose rows were lost is reported, not skipped.';

-- ---------------------------------------------------------------------------
-- 4. Every live writer of the two columns, routed through set_team_coaches()
-- ---------------------------------------------------------------------------
--
-- Each is the latest full revision copied whole (LESSONS_LEARNED #11) with the
-- column write replaced; nothing else in the bodies changes.

-- 4a. admin_assign_team_coach gains an optional effective date, so an ending
-- can be recorded on the day it happened. The three-argument signature is
-- DROPPED rather than overloaded: two overloads would make PostgREST's
-- named-argument call ambiguous, and the old body writes the column directly.
DROP FUNCTION IF EXISTS public.admin_assign_team_coach(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.admin_assign_team_coach(
    p_organization_id uuid,
    p_team_id uuid,
    p_coach_id uuid DEFAULT NULL,
    p_effective_on date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_previous_coach_id uuid;
    v_coach_status text;
    v_can_coach_multiple_teams boolean;
    v_existing_assignment_count integer;
    v_action text;
    v_effective_on date := COALESCE(p_effective_on, current_date);
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_team_id IS NULL THEN
        RAISE EXCEPTION 'p_team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT t.coach_id
      INTO v_previous_coach_id
      FROM public.teams t
     WHERE t.id = p_team_id
       AND t.organization_id = p_organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Team not found in organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_coach_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
            hashtextextended(p_organization_id::text || ':' || p_coach_id::text, 0)
        );

        SELECT c.status, c.can_coach_multiple_teams
          INTO v_coach_status, v_can_coach_multiple_teams
          FROM public.coaches c
         WHERE c.id = p_coach_id
           AND c.organization_id = p_organization_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Coach not found in organization %', p_organization_id
                USING ERRCODE = '42501';
        END IF;

        IF COALESCE(v_coach_status, '') NOT IN ('active', 'pending-confirmation') THEN
            RAISE EXCEPTION 'Coach % must be active or pending-confirmation before assignment', p_coach_id
                USING ERRCODE = '23514';
        END IF;

        SELECT count(*)
          INTO v_existing_assignment_count
          FROM public.teams t
         WHERE t.organization_id = p_organization_id
           AND t.coach_id = p_coach_id
           AND t.id <> p_team_id;

        IF NOT COALESCE(v_can_coach_multiple_teams, false)
           AND v_existing_assignment_count > 0 THEN
            RAISE EXCEPTION 'Coach % is already assigned to another team', p_coach_id
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF v_previous_coach_id IS NOT DISTINCT FROM p_coach_id THEN
        RETURN jsonb_build_object(
            'team_id', p_team_id,
            'organization_id', p_organization_id,
            'previous_coach_id', v_previous_coach_id,
            'coach_id', p_coach_id,
            'changed', false
        );
    END IF;

    -- 8.8: the lead changes through the single writer, which ends the old
    -- lead's assignment on v_effective_on - 1, starts the new one on
    -- v_effective_on, and writes teams.coach_id in the same transaction.
    -- Assistants are left as they are (NULL).
    PERFORM public.set_team_coaches(
        p_team_id, p_coach_id, NULL, v_effective_on, 'admin_assign_team_coach');

    v_action := CASE
        WHEN p_coach_id IS NULL THEN 'team.coach_unassigned'
        WHEN v_previous_coach_id IS NULL THEN 'team.coach_assigned'
        ELSE 'team.coach_swapped'
    END;

    PERFORM public.record_audit_event(
        p_organization_id,
        v_action,
        'team',
        p_team_id,
        jsonb_build_object(
            'team_id', p_team_id,
            'previous_coach_id', v_previous_coach_id,
            'coach_id', p_coach_id,
            'effective_on', v_effective_on
        )
    );

    RETURN jsonb_build_object(
        'team_id', p_team_id,
        'organization_id', p_organization_id,
        'previous_coach_id', v_previous_coach_id,
        'coach_id', p_coach_id,
        'effective_on', v_effective_on,
        'changed', true
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_assign_team_coach(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_team_coach(uuid, uuid, uuid, date) TO authenticated;

COMMENT ON FUNCTION public.admin_assign_team_coach(uuid, uuid, uuid, date) IS
  'Admin-only head-coach assignment/swap/unassignment with coach-status and multi-team guards, effective from p_effective_on (default today; never future, never before the team''s latest recorded change). Writes through set_team_coaches(): the old lead''s assignment is end-dated, not erased.';

-- 4b. admin_delete_coaches: unassignment becomes end-dating.
CREATE OR REPLACE FUNCTION public.admin_delete_coaches(p_coach_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id uuid;
    v_org_count integer;
    v_count integer;
    v_team record;
BEGIN
    IF p_coach_ids IS NULL OR array_length(p_coach_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'p_coach_ids must be a non-empty array' USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT organization_id), min(organization_id)
    INTO v_org_count, v_org_id
    FROM public.coaches
    WHERE id = ANY(p_coach_ids);

    IF v_org_count <> 1 THEN
        RAISE EXCEPTION 'coaches must belong to exactly one organization' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- 8.8: every team that names a deleted coach, in either column OR in an
    -- open assignment row, goes through the single writer. The deleted coach's
    -- assignment is END-DATED (effective_to = yesterday), not erased, so the
    -- team's history survives the coach; the FK's SET NULL never fires because
    -- the lead has already been cleared here. The assignment rows keep the
    -- coach's id and nothing else -- see the table's comment on erasure.
    FOR v_team IN
        SELECT t.id, t.coach_id, t.assistant_coach_ids
          FROM public.teams t
         WHERE t.coach_id = ANY(p_coach_ids)
            OR t.assistant_coach_ids && p_coach_ids
            OR EXISTS (
                SELECT 1 FROM public.team_coach_assignments a
                 WHERE a.team_id = t.id
                   AND a.effective_to IS NULL
                   AND a.coach_id = ANY(p_coach_ids)
            )
         ORDER BY t.id
    LOOP
        PERFORM public.set_team_coaches(
            v_team.id,
            CASE WHEN v_team.coach_id = ANY(p_coach_ids) THEN NULL ELSE v_team.coach_id END,
            ARRAY(
                SELECT u.x
                  FROM unnest(COALESCE(v_team.assistant_coach_ids, '{}'::uuid[]))
                       WITH ORDINALITY AS u(x, ord)
                 WHERE NOT (u.x = ANY(p_coach_ids))
                 ORDER BY u.ord
            ),
            current_date,
            'admin_delete_coaches'
        );
    END LOOP;

    -- coach_interested_programs / coach_team_requests cascade via FK;
    -- preferred_co_coach_id references are SET NULL via FK.
    DELETE FROM public.coaches WHERE id = ANY(p_coach_ids);
    GET DIAGNOSTICS v_count = ROW_COUNT;

    PERFORM public.record_audit_event(
        v_org_id,
        'coach.deleted',
        'coach',
        NULL,
        jsonb_build_object('coach_count', v_count, 'coach_ids', to_jsonb(p_coach_ids))
    );

    RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_delete_coaches(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_coaches(uuid[]) TO authenticated, service_role;

-- 4c. persist_team_schedule: the bulk writer.
CREATE OR REPLACE FUNCTION public.persist_team_schedule(
    run_data jsonb,
    teams jsonb,
    team_players jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run_id uuid;
    v_persisted_run_id uuid;
    v_org_id uuid;
    v_candidate_org_id uuid;
    v_candidate_org_count integer;
    v_season_id uuid;
    v_season_settings_id uuid;
    v_season_org_id uuid;
    v_run_type text;
    v_status text;
    v_created_by uuid;
    v_started_at timestamptz;
    v_completed_at timestamptz;
    v_effective_role text;
    v_missing_team_id_count integer;
    v_missing_team_division_count integer;
    v_missing_team_name_count integer;
    v_team_org_mismatch_count integer;
    v_invalid_assistant_ids_count integer;
    v_oversized_assistant_ids_count integer;
    v_missing_player_team_count integer;
    v_missing_player_count integer;
    v_invalid_source_count integer;
    v_missing_division_ref uuid;
    v_cross_division_ref uuid;
    v_missing_coach_ref uuid;
    v_cross_coach_ref uuid;
    v_cross_existing_team_ref uuid;
    v_missing_team_ref uuid;
    v_cross_team_ref uuid;
    v_missing_player_ref uuid;
    v_cross_player_ref uuid;
    v_team record;
BEGIN
    IF run_data IS NULL OR jsonb_typeof(run_data) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'run_data must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF teams IS NULL THEN
        teams := '[]'::jsonb;
    END IF;

    IF team_players IS NULL THEN
        team_players := '[]'::jsonb;
    END IF;

    IF jsonb_typeof(teams) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'teams must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(team_players) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'team_players must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    v_run_type := COALESCE(NULLIF(run_data->>'run_type', ''), 'team');
    IF v_run_type <> 'team' THEN
        RAISE EXCEPTION 'persist_team_schedule only accepts team runs'
            USING ERRCODE = '22023';
    END IF;

    v_status := COALESCE(NULLIF(run_data->>'status', ''), 'completed');
    IF v_status NOT IN (
        'queued',
        'running',
        'completed',
        'completed_with_warnings',
        'needs_manual_review',
        'failed'
    ) THEN
        RAISE EXCEPTION 'invalid scheduler run status: %', v_status
            USING ERRCODE = '22023';
    END IF;

    v_run_id := COALESCE(NULLIF(run_data->>'id', '')::uuid, gen_random_uuid());
    v_org_id := NULLIF(run_data->>'organization_id', '')::uuid;
    v_season_settings_id := NULLIF(run_data->>'season_settings_id', '')::uuid;
    v_season_id := COALESCE(NULLIF(run_data->>'season_id', '')::uuid, v_season_settings_id);
    v_effective_role := COALESCE(auth.role(), current_role, '');

    IF v_season_settings_id IS NOT NULL
       AND v_season_id IS NOT NULL
       AND v_season_settings_id <> v_season_id THEN
        RAISE EXCEPTION 'season_id must match season_settings_id for team persistence'
            USING ERRCODE = '22023';
    END IF;

    IF v_season_id IS NOT NULL THEN
        SELECT ss.organization_id
          INTO v_season_org_id
          FROM public.season_settings ss
         WHERE ss.id = v_season_id;

        IF v_season_org_id IS NULL THEN
            RAISE EXCEPTION 'season_settings_id % does not exist', v_season_id
                USING ERRCODE = '23503';
        END IF;

        IF v_org_id IS NULL THEN
            v_org_id := v_season_org_id;
        ELSIF v_org_id <> v_season_org_id THEN
            RAISE EXCEPTION 'season_settings_id % does not belong to organization %',
                v_season_id, v_org_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF v_org_id IS NULL THEN
        WITH parsed_teams AS (
            SELECT
                NULLIF(item.value->>'id', '')::uuid AS id,
                NULLIF(item.value->>'organization_id', '')::uuid AS organization_id,
                NULLIF(item.value->>'division_id', '')::uuid AS division_id
              FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
        ),
        parsed_team_players AS (
            SELECT
                NULLIF(item.value->>'team_id', '')::uuid AS team_id,
                NULLIF(item.value->>'player_id', '')::uuid AS player_id
              FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
        ),
        candidate_orgs AS (
            SELECT organization_id
              FROM parsed_teams
             WHERE organization_id IS NOT NULL
            UNION
            SELECT d.organization_id
              FROM parsed_teams pt
              JOIN public.divisions d ON d.id = pt.division_id
            UNION
            SELECT t.organization_id
              FROM parsed_teams pt
              JOIN public.teams t ON t.id = pt.id
            UNION
            SELECT t.organization_id
              FROM parsed_team_players ptp
              JOIN public.teams t ON t.id = ptp.team_id
            UNION
            SELECT p.organization_id
              FROM parsed_team_players ptp
              JOIN public.players p ON p.id = ptp.player_id
        )
        SELECT count(DISTINCT organization_id), min(organization_id)
          INTO v_candidate_org_count, v_candidate_org_id
          FROM candidate_orgs;

        IF v_candidate_org_count > 1 THEN
            RAISE EXCEPTION 'team persistence payload references multiple organizations'
                USING ERRCODE = '42501';
        ELSIF v_candidate_org_count = 1 THEN
            v_org_id := v_candidate_org_id;
        END IF;
    END IF;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'organization_id, season_settings_id, or org-scoped team payload is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.scheduler_runs sr
         WHERE sr.id = v_run_id
           AND sr.organization_id <> v_org_id
    ) THEN
        RAISE EXCEPTION 'scheduler run % belongs to another organization', v_run_id
            USING ERRCODE = '42501';
    END IF;

    IF v_effective_role = 'service_role' THEN
        BEGIN
            v_created_by := NULLIF(run_data->>'created_by', '')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            v_created_by := NULL;
        END;
    ELSE
        v_created_by := auth.uid();
    END IF;

    v_started_at := COALESCE(NULLIF(run_data->>'started_at', '')::timestamptz, timezone('utc', now()));
    v_completed_at := COALESCE(NULLIF(run_data->>'completed_at', '')::timestamptz, timezone('utc', now()));

    INSERT INTO public.scheduler_runs (
        id,
        organization_id,
        season_id,
        season_settings_id,
        run_type,
        status,
        parameters,
        metrics,
        results,
        created_by,
        started_at,
        completed_at
    )
    VALUES (
        v_run_id,
        v_org_id,
        v_season_id,
        v_season_settings_id,
        'team',
        v_status,
        COALESCE(run_data->'parameters', '{}'::jsonb),
        COALESCE(run_data->'metrics', '{}'::jsonb),
        COALESCE(run_data->'results', '{}'::jsonb),
        v_created_by,
        v_started_at,
        v_completed_at
    )
    ON CONFLICT (id) DO UPDATE SET
        season_id = EXCLUDED.season_id,
        season_settings_id = EXCLUDED.season_settings_id,
        status = EXCLUDED.status,
        parameters = EXCLUDED.parameters,
        metrics = EXCLUDED.metrics,
        results = EXCLUDED.results,
        completed_at = EXCLUDED.completed_at,
        updated_at = timezone('utc', now())
    WHERE public.scheduler_runs.organization_id = EXCLUDED.organization_id
    RETURNING id INTO v_persisted_run_id;

    IF v_persisted_run_id IS NULL THEN
        RAISE EXCEPTION 'scheduler run % could not be persisted for organization %',
            v_run_id, v_org_id
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(teams) AS team_items(value)
         WHERE jsonb_typeof(team_items.value) IS DISTINCT FROM 'object'
    ) THEN
        RAISE EXCEPTION 'each team must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(team_players) AS team_player_items(value)
         WHERE jsonb_typeof(team_player_items.value) IS DISTINCT FROM 'object'
    ) THEN
        RAISE EXCEPTION 'each team_player must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_teams AS (
        SELECT
            NULLIF(item.value->>'id', '')::uuid AS id,
            NULLIF(item.value->>'organization_id', '')::uuid AS organization_id,
            NULLIF(item.value->>'division_id', '')::uuid AS division_id,
            NULLIF(item.value->>'coach_id', '')::uuid AS coach_id,
            NULLIF(item.value->>'name', '') AS name
          FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT
        count(*) FILTER (WHERE id IS NULL),
        count(*) FILTER (WHERE division_id IS NULL),
        count(*) FILTER (WHERE name IS NULL),
        count(*) FILTER (WHERE organization_id IS NOT NULL AND organization_id <> v_org_id)
      INTO
        v_missing_team_id_count,
        v_missing_team_division_count,
        v_missing_team_name_count,
        v_team_org_mismatch_count
      FROM parsed_teams;

    IF v_missing_team_id_count > 0 THEN
        RAISE EXCEPTION 'team id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_team_division_count > 0 THEN
        RAISE EXCEPTION 'team division_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_team_name_count > 0 THEN
        RAISE EXCEPTION 'team name is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_team_org_mismatch_count > 0 THEN
        RAISE EXCEPTION 'team organization_id must match the scheduler run organization'
            USING ERRCODE = '42501';
    END IF;

    -- assistant_coach_ids is opaque metadata (no FK), so it is shape-validated
    -- and size-capped here, then sanitized below to a deduplicated uuid[]
    -- (non-UUID entries are dropped — they live on in the results JSON).
    SELECT
        count(*) FILTER (
            WHERE item.value ? 'assistant_coach_ids'
              AND jsonb_typeof(item.value->'assistant_coach_ids') NOT IN ('array', 'null')
        ),
        count(*) FILTER (
            WHERE jsonb_typeof(item.value->'assistant_coach_ids') = 'array'
              AND jsonb_array_length(item.value->'assistant_coach_ids') > 50
        )
      INTO
        v_invalid_assistant_ids_count,
        v_oversized_assistant_ids_count
      FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality);

    IF v_invalid_assistant_ids_count > 0 THEN
        RAISE EXCEPTION 'team assistant_coach_ids must be a JSON array when present'
            USING ERRCODE = '22023';
    END IF;

    IF v_oversized_assistant_ids_count > 0 THEN
        RAISE EXCEPTION 'team assistant_coach_ids exceeds the 50-entry limit'
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_team_players AS (
        SELECT
            NULLIF(item.value->>'team_id', '')::uuid AS team_id,
            NULLIF(item.value->>'player_id', '')::uuid AS player_id,
            CASE
                WHEN lower(COALESCE(NULLIF(item.value->>'source', ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(item.value->>'source', ''), 'auto'))
            END AS source
          FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT
        count(*) FILTER (WHERE team_id IS NULL),
        count(*) FILTER (WHERE player_id IS NULL),
        count(*) FILTER (WHERE source NOT IN ('auto', 'manual'))
      INTO
        v_missing_player_team_count,
        v_missing_player_count,
        v_invalid_source_count
      FROM parsed_team_players;

    IF v_missing_player_team_count > 0 THEN
        RAISE EXCEPTION 'team_player team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_player_count > 0 THEN
        RAISE EXCEPTION 'team_player player_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_invalid_source_count > 0 THEN
        RAISE EXCEPTION 'invalid team_player source'
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_teams AS (
        SELECT
            NULLIF(item.value->>'id', '')::uuid AS id,
            NULLIF(item.value->>'division_id', '')::uuid AS division_id,
            NULLIF(item.value->>'coach_id', '')::uuid AS coach_id
          FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_teams.division_id
      INTO v_missing_division_ref
      FROM parsed_teams
      LEFT JOIN public.divisions d ON d.id = parsed_teams.division_id
     WHERE d.id IS NULL
     LIMIT 1;

    IF v_missing_division_ref IS NOT NULL THEN
        RAISE EXCEPTION 'division_id % does not exist', v_missing_division_ref
            USING ERRCODE = '23503';
    END IF;

    WITH parsed_teams AS (
        SELECT NULLIF(item.value->>'division_id', '')::uuid AS division_id
          FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_teams.division_id
      INTO v_cross_division_ref
      FROM parsed_teams
      JOIN public.divisions d ON d.id = parsed_teams.division_id
     WHERE d.organization_id <> v_org_id
     LIMIT 1;

    IF v_cross_division_ref IS NOT NULL THEN
        RAISE EXCEPTION 'division_id % belongs to another organization', v_cross_division_ref
            USING ERRCODE = '42501';
    END IF;

    WITH parsed_teams AS (
        SELECT NULLIF(item.value->>'coach_id', '')::uuid AS coach_id
          FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_teams.coach_id
      INTO v_missing_coach_ref
      FROM parsed_teams
      LEFT JOIN public.coaches c ON c.id = parsed_teams.coach_id
     WHERE parsed_teams.coach_id IS NOT NULL
       AND c.id IS NULL
     LIMIT 1;

    IF v_missing_coach_ref IS NOT NULL THEN
        RAISE EXCEPTION 'coach_id % does not exist', v_missing_coach_ref
            USING ERRCODE = '23503';
    END IF;

    WITH parsed_teams AS (
        SELECT NULLIF(item.value->>'coach_id', '')::uuid AS coach_id
          FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_teams.coach_id
      INTO v_cross_coach_ref
      FROM parsed_teams
      JOIN public.coaches c ON c.id = parsed_teams.coach_id
     WHERE c.organization_id <> v_org_id
     LIMIT 1;

    IF v_cross_coach_ref IS NOT NULL THEN
        RAISE EXCEPTION 'coach_id % belongs to another organization', v_cross_coach_ref
            USING ERRCODE = '42501';
    END IF;

    WITH parsed_teams AS (
        SELECT NULLIF(item.value->>'id', '')::uuid AS id
          FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_teams.id
      INTO v_cross_existing_team_ref
      FROM parsed_teams
      JOIN public.teams t ON t.id = parsed_teams.id
     WHERE t.organization_id <> v_org_id
     LIMIT 1;

    IF v_cross_existing_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team id % belongs to another organization', v_cross_existing_team_ref
            USING ERRCODE = '42501';
    END IF;

    -- 8.8: the team row is upserted WITHOUT its coach columns, and the coaches
    -- then go through the single writer, team by team, from the same parsed
    -- payload (same de-duplication: the last occurrence of an id wins). A
    -- payload without the assistant key passes NULL, which the writer reads as
    -- "leave the assistants as they are" -- the COALESCE this upsert used to
    -- carry. A brand-new team therefore starts with the column default '{}'
    -- rather than NULL when the key is absent; readers already treat the two
    -- alike (see the column comment).
    FOR v_team IN
        SELECT DISTINCT ON (id)
            id, division_id, coach_id, name, notes, assistant_coach_ids
          FROM (
        SELECT
            item.ordinality,
            NULLIF(item.value->>'id', '')::uuid AS id,
            NULLIF(item.value->>'division_id', '')::uuid AS division_id,
            NULLIF(item.value->>'coach_id', '')::uuid AS coach_id,
            NULLIF(item.value->>'name', '') AS name,
            NULLIF(item.value->>'notes', '') AS notes,
            CASE
                WHEN jsonb_typeof(item.value->'assistant_coach_ids') = 'array' THEN
                    -- SECURITY: assistant_coach_ids grants portal/RLS access
                    -- (event_rsvps / team_messages policies match coaches
                    -- against it), so only coaches that EXIST and belong to
                    -- THIS organization may land in the column. Anything else
                    -- (unknown id, cross-org coach, non-UUID) is dropped — it
                    -- still round-trips via the results JSON.
                    COALESCE(
                        (SELECT array_agg(DISTINCT c.id)
                           FROM (
                                SELECT (el.value #>> '{}')::uuid AS candidate_id
                                  FROM jsonb_array_elements(item.value->'assistant_coach_ids') AS el(value)
                                 WHERE jsonb_typeof(el.value) = 'string'
                                   AND (el.value #>> '{}') ~*
                                       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           ) candidates
                           JOIN public.coaches c
                             ON c.id = candidates.candidate_id
                            AND c.organization_id = v_org_id),
                        '{}'::uuid[]
                    )
                -- Absent key (or json null) stays NULL so the upsert below
                -- preserves whatever an earlier payload wrote.
                ELSE NULL
            END AS assistant_coach_ids
          FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
    ) parsed_teams
        ORDER BY id, ordinality DESC
    LOOP
        INSERT INTO public.teams (id, organization_id, division_id, name, notes)
        VALUES (v_team.id, v_org_id, v_team.division_id, v_team.name, v_team.notes)
        ON CONFLICT (id) DO UPDATE SET
            division_id = EXCLUDED.division_id,
            name = EXCLUDED.name,
            notes = COALESCE(EXCLUDED.notes, public.teams.notes),
            updated_at = timezone('utc', now())
        WHERE public.teams.organization_id = EXCLUDED.organization_id;
        -- The cross-organisation refusal above already stops this; restated
        -- here because the writer below authorises nobody, and a skipped
        -- conflict must not go on to write another organisation's coaches.
        IF NOT FOUND THEN
            RAISE EXCEPTION 'team id % belongs to another organization', v_team.id
                USING ERRCODE = '42501';
        END IF;

        PERFORM public.set_team_coaches(
            v_team.id, v_team.coach_id, v_team.assistant_coach_ids,
            current_date, 'persist_team_schedule');
    END LOOP;

    WITH parsed_team_players AS (
        SELECT
            NULLIF(item.value->>'team_id', '')::uuid AS team_id,
            NULLIF(item.value->>'player_id', '')::uuid AS player_id
          FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_team_players.team_id
      INTO v_missing_team_ref
      FROM parsed_team_players
      LEFT JOIN public.teams t ON t.id = parsed_team_players.team_id
     WHERE t.id IS NULL
     LIMIT 1;

    IF v_missing_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_player team_id % does not exist', v_missing_team_ref
            USING ERRCODE = '23503';
    END IF;

    WITH parsed_team_players AS (
        SELECT NULLIF(item.value->>'team_id', '')::uuid AS team_id
          FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_team_players.team_id
      INTO v_cross_team_ref
      FROM parsed_team_players
      JOIN public.teams t ON t.id = parsed_team_players.team_id
     WHERE t.organization_id <> v_org_id
     LIMIT 1;

    IF v_cross_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_player team_id % belongs to another organization', v_cross_team_ref
            USING ERRCODE = '42501';
    END IF;

    WITH parsed_team_players AS (
        SELECT NULLIF(item.value->>'player_id', '')::uuid AS player_id
          FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_team_players.player_id
      INTO v_missing_player_ref
      FROM parsed_team_players
      LEFT JOIN public.players p ON p.id = parsed_team_players.player_id
     WHERE p.id IS NULL
     LIMIT 1;

    IF v_missing_player_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_player player_id % does not exist', v_missing_player_ref
            USING ERRCODE = '23503';
    END IF;

    WITH parsed_team_players AS (
        SELECT NULLIF(item.value->>'player_id', '')::uuid AS player_id
          FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
    )
    SELECT parsed_team_players.player_id
      INTO v_cross_player_ref
      FROM parsed_team_players
      JOIN public.players p ON p.id = parsed_team_players.player_id
     WHERE p.organization_id <> v_org_id
     LIMIT 1;

    IF v_cross_player_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_player player_id % belongs to another organization', v_cross_player_ref
            USING ERRCODE = '42501';
    END IF;

    WITH payload_team_ids AS (
        SELECT NULLIF(item.value->>'id', '')::uuid AS team_id
          FROM jsonb_array_elements(teams) WITH ORDINALITY AS item(value, ordinality)
        UNION
        SELECT NULLIF(item.value->>'team_id', '')::uuid AS team_id
          FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
    ),
    incoming_team_players AS (
        SELECT DISTINCT
            NULLIF(item.value->>'team_id', '')::uuid AS team_id,
            NULLIF(item.value->>'player_id', '')::uuid AS player_id
          FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
    )
    DELETE FROM public.team_players tp
      USING payload_team_ids pti
     WHERE pti.team_id IS NOT NULL
       AND tp.organization_id = v_org_id
       AND tp.team_id = pti.team_id
       AND NOT EXISTS (
            SELECT 1
              FROM incoming_team_players itp
             WHERE itp.team_id = tp.team_id
               AND itp.player_id = tp.player_id
       );

    INSERT INTO public.team_players (
        team_id,
        player_id,
        organization_id,
        role,
        source
    )
    SELECT DISTINCT ON (team_id, player_id)
        team_id,
        player_id,
        v_org_id,
        role,
        source::public.source_enum
    FROM (
        SELECT
            item.ordinality,
            NULLIF(item.value->>'team_id', '')::uuid AS team_id,
            NULLIF(item.value->>'player_id', '')::uuid AS player_id,
            COALESCE(NULLIF(item.value->>'role', ''), 'player') AS role,
            CASE
                WHEN lower(COALESCE(NULLIF(item.value->>'source', ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(item.value->>'source', ''), 'auto'))
            END AS source
          FROM jsonb_array_elements(team_players) WITH ORDINALITY AS item(value, ordinality)
    ) parsed_team_players
    ORDER BY team_id, player_id, ordinality DESC
    ON CONFLICT (team_id, player_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        role = EXCLUDED.role,
        source = EXCLUDED.source;

    RETURN v_persisted_run_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.persist_team_schedule(jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persist_team_schedule(jsonb, jsonb, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Backfill: one open row per appointment the columns already state
-- ---------------------------------------------------------------------------
--
-- **effective_from is the day this migration ran, not the team's creation
-- date.** Nothing recorded when these coaches started, and backdating them to
-- the team's creation would assert history nobody observed. `started_via =
-- 'backfill'` marks the row as "held at least from" rather than "started on",
-- and a question about an earlier date correctly finds no coach on record.
-- Assistant ids are copied as the column holds them (the column carries no FK
-- and may name a coach since deleted), because the drift check compares
-- against the column and a filtered backfill would start life in drift.
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, started_via)
SELECT t.organization_id, t.id, t.coach_id, 'lead', current_date, 'backfill'
  FROM public.teams t
 WHERE t.coach_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.team_coach_assignments a
                    WHERE a.team_id = t.id AND a.role = 'lead' AND a.effective_to IS NULL);

INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, started_via)
SELECT DISTINCT t.organization_id, t.id, x, 'assistant', current_date, 'backfill'
  FROM public.teams t
 CROSS JOIN LATERAL unnest(COALESCE(t.assistant_coach_ids, '{}'::uuid[])) AS x
 WHERE x IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.team_coach_assignments a
                    WHERE a.team_id = t.id AND a.role = 'assistant'
                      AND a.coach_id = x AND a.effective_to IS NULL);

-- The backfill proves itself: after it, no team may be in drift.
DO $verify$
DECLARE
    v_teams integer;
    v_drift integer;
BEGIN
    SELECT count(*) INTO v_teams FROM public.teams;
    SELECT count(*) INTO v_drift
      FROM public.organizations o
     CROSS JOIN LATERAL public.team_coach_assignment_drift(o.id) d
     WHERE NOT d.in_sync;
    IF v_drift > 0 THEN
        RAISE EXCEPTION 'backfill left % team(s) whose coach columns disagree with their assignment rows', v_drift;
    END IF;
    RAISE NOTICE 'team_coach_assignments backfilled: % team(s) examined, 0 in drift', v_teams;
END;
$verify$;

COMMIT;
