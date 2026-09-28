-- ==========================================
-- 8.6 PR 3b, PR 6: persist_practice_schedule v3 -- lock everything assigned
-- ==========================================
--
-- Plan of record: docs/PHASE_8_6_PR3B_PLAN.md §1 (practice_exceptions), §3
-- (lock everything assigned), §5 decision 7 (cancel withdraws exceptions),
-- §6 (witnesses) and §7 row 6. Operator ruling 2: "Everything already
-- assigned is locked ... Neither the auto-scheduler nor the repair may move or
-- re-range it unless an admin accepts an explicit override prompt."
--
-- ## What this changes
--
-- `persist_practice_schedule` (last defined in
-- 20260924000000_practice_writer_prunes_superseded.sql; 20260928000000 changed
-- only the scheduler_runs policies it writes through) is copied whole and
-- becomes **add-only by default**. #444's prune survives only for rows the
-- caller explicitly unlocks -- this deliberately reverses #444's default.
--
--   * Any existing row the call would delete, re-range or move -- a payload
--     team's missing (team, slot, range) key, an absent team's `auto` rows, a
--     `closes` entry, or a row whose exception is withdrawn -- refuses with
--     22023 "assignment X is locked", unless X is listed in
--     `unlock => [{assignment_id, reason}]`. The unlock is PER ROW: a team's
--     other rows stay locked.
--   * A NEW row that overlaps the range of a row its team still holds refuses
--     the same way (a move disguised as an addition).
--   * `unlock` requires an org admin WITH a uid, checked by its own gate
--     before the general admin check, and writes one `practice.unlock_accepted`
--     audit row per assignment carrying the before-image. A service-role
--     caller (no uid) therefore cannot unlock, close or withdraw at all.
--   * `closes => [{assignment_id, last_day}]` ends a row in place at
--     `last_day` (a retirement split): an UPDATE of its range that keeps its
--     id, so exceptions and readers keyed on the id keep pointing at it.
--   * `exceptions => [...]` records temporary overrides and TIME TBD windows
--     in the new `practice_exceptions` table (plan §1), never as assignment
--     rows -- a second assignment row would be pruned by the next save and
--     shown beside the lost ground by every reader.
--     `withdraw_exceptions => [{exception_id}]` withdraws one (locked: its
--     assignment must be unlocked).
--   * `base_fingerprint`: when given, the md5 of the season's assignments
--     (`practice_schedule_fingerprint`, below) must still match it, or the
--     save refuses with 40001 -- the plan was built on a stale read.
--   * `practice_assignments.assigned_via` in (auto, manual, repair,
--     recommendation, override). `source_enum` stays.
--   * The result gains `teams_time_tbd` (enumerated from the season ROSTER),
--     `unlocked`, `closed`, `exceptions_recorded`, `exceptions_withdrawn` and
--     the post-save `fingerprint`. #444's `teams_without_practice` stays; in
--     an ordinary save it now names only never-placed teams.
--
-- `practice_exceptions.assignment_id` is ON DELETE RESTRICT: any path that
-- deletes an overridden series -- the unlocked prune, a raw DELETE, a team or
-- organisation delete -- is a loud 23503, never an orphan. The unlocked prune
-- archives and removes an assignment's WITHDRAWN exceptions first, so only a
-- live override stops it. `admin_cancel_practice_assignment` (copied whole
-- from 20260613000003) withdraws the series' live exceptions in the same
-- transaction, audits each, archives every exception row to its run's
-- `results.archived_exceptions` and to the audit log, and only then deletes
-- (decision 7: the explicit admin cancel counts as its own prompt).
--
-- ## What this does NOT do
--
-- It does not change the auto-scheduler (PR 7), the adapter (PR 9), the UI
-- (PRs 10-11) or any reader (PR 12): nothing reads practice_exceptions yet.
--
-- Reversible: see docs/sql/20260929000000_revert.sql.
-- Smoke checks: see docs/sql/20260929000000_smoke.sql.

BEGIN;

-- The exclusion constraint compares uuids with `=` under GiST, which needs
-- btree_gist. Supabase ships it; it goes in `extensions` (not `public`), and
-- operator-class lookup is by type, not search_path, so the constraint
-- resolves wherever the extension lives.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

INSERT INTO public.audit_actions (action) VALUES ('practice.unlock_accepted')
    ON CONFLICT (action) DO NOTHING;
INSERT INTO public.audit_actions (action) VALUES ('practice.exception_recorded')
    ON CONFLICT (action) DO NOTHING;
INSERT INTO public.audit_actions (action) VALUES ('practice.exception_withdrawn')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- practice_assignments.assigned_via
-- ---------------------------------------------------------------------------
ALTER TABLE public.practice_assignments
    ADD COLUMN IF NOT EXISTS assigned_via text NOT NULL DEFAULT 'auto';
-- Existing rows: the only provenance recorded so far is `source`.
UPDATE public.practice_assignments
   SET assigned_via = 'manual'
 WHERE source = 'manual'
   AND assigned_via = 'auto';
ALTER TABLE public.practice_assignments
    DROP CONSTRAINT IF EXISTS practice_assignments_assigned_via_check;
ALTER TABLE public.practice_assignments
    ADD CONSTRAINT practice_assignments_assigned_via_check
    CHECK (assigned_via IN ('auto', 'manual', 'repair', 'recommendation', 'override'));

-- ---------------------------------------------------------------------------
-- practice_exceptions (plan §1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.practice_exceptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    season_settings_id uuid NOT NULL REFERENCES public.season_settings(id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    assignment_id uuid NOT NULL,
    "window" daterange NOT NULL,
    kind text NOT NULL,
    practice_slot_id uuid REFERENCES public.practice_slots(id),
    tbd_reason text,
    cause_kind text,
    cause_id uuid,
    run_id uuid REFERENCES public.scheduler_runs(id) ON DELETE SET NULL,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
    withdrawn_at timestamptz,
    withdrawn_by uuid,
    CONSTRAINT practice_exceptions_assignment_fk FOREIGN KEY (assignment_id)
        REFERENCES public.practice_assignments(id) ON DELETE RESTRICT,
    CONSTRAINT practice_exceptions_kind_check CHECK (kind IN ('relocated', 'time_tbd')),
    CONSTRAINT practice_exceptions_slot_iff_relocated
        CHECK ((kind = 'relocated') = (practice_slot_id IS NOT NULL)),
    -- PRACTICE_TBD_REASON (packages/core/src/practice/repair.js), plus the two
    -- values plan §2 and §4 add (`declined`, `coach-preference`).
    -- tests/practiceWriterV3.test.js pins this list to the core enum.
    CONSTRAINT practice_exceptions_tbd_reason_check CHECK (
        tbd_reason IS NULL OR tbd_reason IN (
            'no-legal-slot-at-venue', 'contended', 'change-budget',
            'objective-preferred-tbd', 'coach-preference', 'declined'
        )
    ),
    CONSTRAINT practice_exceptions_tbd_reason_iff_tbd
        CHECK ((kind = 'time_tbd') = (tbd_reason IS NOT NULL)),
    CONSTRAINT practice_exceptions_cause_kind_check
        CHECK (cause_kind IS NULL OR cause_kind IN ('blackout', 'retirement')),
    CONSTRAINT practice_exceptions_window_nonempty CHECK (NOT isempty("window")),
    CONSTRAINT practice_exceptions_withdrawn_by_needs_at
        CHECK (withdrawn_by IS NULL OR withdrawn_at IS NOT NULL),
    CONSTRAINT practice_exceptions_no_overlap
        EXCLUDE USING gist (assignment_id WITH =, "window" WITH &&)
        WHERE (withdrawn_at IS NULL)
);

CREATE INDEX IF NOT EXISTS practice_exceptions_assignment_idx
    ON public.practice_exceptions (assignment_id);
CREATE INDEX IF NOT EXISTS practice_exceptions_season_idx
    ON public.practice_exceptions (organization_id, season_settings_id);

COMMENT ON TABLE public.practice_exceptions IS
    'Temporary practice overrides and TIME TBD windows on an assignment (8.6 PR 3b plan §1). Written by persist_practice_schedule; withdrawn, never edited.';

ALTER TABLE public.practice_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Practice exceptions: members select" ON public.practice_exceptions;
CREATE POLICY "Practice exceptions: members select"
    ON public.practice_exceptions FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id));

-- persist_practice_schedule is SECURITY INVOKER and writes as the calling
-- admin, exactly as it writes practice_assignments.
DROP POLICY IF EXISTS "Practice exceptions: admins write" ON public.practice_exceptions;
CREATE POLICY "Practice exceptions: admins write"
    ON public.practice_exceptions FOR ALL TO authenticated
    USING (public.is_org_admin(organization_id))
    WITH CHECK (public.is_org_admin(organization_id));

REVOKE ALL ON public.practice_exceptions FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.practice_exceptions TO authenticated;
GRANT ALL ON public.practice_exceptions TO service_role;

-- ---------------------------------------------------------------------------
-- practice_schedule_fingerprint: what `base_fingerprint` is compared against
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.practice_schedule_fingerprint(p_season_settings_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT md5(COALESCE(string_agg(
               pa.id::text || '|' || pa.team_id::text || '|'
               || COALESCE(pa.practice_slot_id::text, '') || '|'
               || COALESCE(pa.effective_date_range::text, '') || '|'
               || pa.source::text || '|' || pa.assigned_via,
               ',' ORDER BY pa.id), ''))
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE d.season_settings_id = p_season_settings_id
       AND pa.organization_id = d.organization_id;
$$;
REVOKE ALL ON FUNCTION public.practice_schedule_fingerprint(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.practice_schedule_fingerprint(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- persist_practice_schedule v3
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.persist_practice_schedule(jsonb, jsonb, boolean);

CREATE OR REPLACE FUNCTION public.persist_practice_schedule(
    run_data jsonb,
    assignments jsonb,
    allow_empty boolean DEFAULT false,
    unlock jsonb DEFAULT '[]'::jsonb,
    closes jsonb DEFAULT '[]'::jsonb,
    exceptions jsonb DEFAULT '[]'::jsonb,
    withdraw_exceptions jsonb DEFAULT '[]'::jsonb,
    base_fingerprint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_run_id uuid;
    v_persisted_run_id uuid;
    v_org_id uuid;
    v_season_id uuid;
    v_season_settings_id uuid;
    v_season_org_id uuid;
    v_run_type text;
    v_status text;
    v_created_by uuid;
    v_started_at timestamptz;
    v_completed_at timestamptz;
    v_effective_role text;
    v_missing_team_count integer;
    v_missing_slot_count integer;
    v_missing_range_count integer;
    v_invalid_source_count integer;
    v_invalid_via_count integer;
    v_missing_team_ref uuid;
    v_cross_team_ref uuid;
    v_missing_slot_ref uuid;
    v_cross_slot_ref uuid;
    v_removed jsonb;
    v_retained jsonb;
    v_row jsonb;
    v_audited boolean := false;
    v_updated integer;
    v_prior_results jsonb;
    v_payload_teams uuid[];
    v_teams_with_prior uuid[];
    v_season_team_count integer;
    v_without_practice jsonb;
    -- v3
    v_arg text;
    v_arg_value jsonb;
    v_unlock_ids uuid[];
    v_close_ids uuid[];
    v_withdraw_ids uuid[];
    v_withdraw_assignment_ids uuid[];
    v_prune_ids uuid[];
    v_replaced_ids uuid[];
    v_bad_id uuid;
    v_bad_why text;
    v_locked_id uuid;
    v_locked_why text;
    v_overlap_id uuid;
    v_fingerprint text;
    v_unlocked jsonb := '[]'::jsonb;
    v_closed jsonb := '[]'::jsonb;
    v_withdrawn jsonb := '[]'::jsonb;
    v_superseded_exceptions jsonb := '[]'::jsonb;
    v_recorded jsonb := '[]'::jsonb;
    v_time_tbd jsonb;
BEGIN
    IF run_data IS NULL OR jsonb_typeof(run_data) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'run_data must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF assignments IS NULL THEN
        assignments := '[]'::jsonb;
    END IF;

    IF jsonb_typeof(assignments) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'assignments must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    -- v3: the four repair arguments are arrays of objects, like `assignments`.
    unlock := COALESCE(unlock, '[]'::jsonb);
    closes := COALESCE(closes, '[]'::jsonb);
    exceptions := COALESCE(exceptions, '[]'::jsonb);
    withdraw_exceptions := COALESCE(withdraw_exceptions, '[]'::jsonb);
    FOR v_arg, v_arg_value IN
        SELECT a.n, a.v FROM (VALUES ('unlock', unlock), ('closes', closes),
                                     ('exceptions', exceptions),
                                     ('withdraw_exceptions', withdraw_exceptions)) AS a(n, v)
    LOOP
        IF jsonb_typeof(v_arg_value) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION '% must be a JSON array of objects', v_arg
                USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_arg_value) e
                    WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object') THEN
            RAISE EXCEPTION '% must be a JSON array of objects', v_arg
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    v_run_type := COALESCE(NULLIF(run_data->>'run_type', ''), 'practice');
    IF v_run_type <> 'practice' THEN
        RAISE EXCEPTION 'persist_practice_schedule only accepts practice runs'
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

    IF v_org_id IS NOT NULL
       AND v_effective_role <> 'service_role'
       AND NOT public.is_org_member(v_org_id) THEN
        RAISE EXCEPTION 'caller is not a member of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    IF v_season_settings_id IS NOT NULL
       AND v_season_id IS NOT NULL
       AND v_season_settings_id <> v_season_id THEN
        RAISE EXCEPTION 'season_id must match season_settings_id for practice persistence'
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
        RAISE EXCEPTION 'organization_id or season_settings_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_member(v_org_id) THEN
        RAISE EXCEPTION 'caller is not a member of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- v3: the override prompt is admin-only and audited (plan §3). Its own
    -- gate, BEFORE the general admin check below and with its own message,
    -- so it holds even for a caller that check exempts: a service-role caller
    -- has no uid to audit, so it cannot unlock at all -- and with nothing
    -- unlocked it can neither prune, close nor withdraw.
    IF jsonb_array_length(unlock) > 0
       AND (auth.uid() IS NULL OR NOT public.is_org_admin(v_org_id)) THEN
        RAISE EXCEPTION 'unlock requires an org admin with a uid to audit: % assignment(s) named', jsonb_array_length(unlock)
            USING ERRCODE = '42501';
    END IF;

    -- #64: the prune below removes rows, so the caller must be able to remove
    -- them. `practice_assignments_write_admin` already limits every write to
    -- org admins; saying so here turns a silent zero-row DELETE into a refusal.
    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- #64: the prune is scoped to one season. Without one there is no scope,
    -- and guessing one is how another season's schedule would be deleted.
    IF v_season_id IS NULL THEN
        RAISE EXCEPTION 'season_settings_id is required: a practice schedule replaces one season''s schedule'
            USING ERRCODE = '23502';
    END IF;

    -- #64: an empty payload would supersede every auto row in the season. That
    -- is a legitimate request only when the caller says so.
    IF jsonb_array_length(assignments) = 0 AND NOT COALESCE(allow_empty, false) THEN
        RAISE EXCEPTION 'refusing an empty practice schedule: it would remove every auto assignment in season %; pass allow_empty => true to mean it', v_season_id
            USING ERRCODE = '22023';
    END IF;

    -- #64: two saves of the same season must not interleave their prune and
    -- upsert, or each keeps rows the other superseded.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('persist_practice_schedule:' || v_org_id::text || ':' || v_season_id::text, 0)
    );

    -- v3: optimistic concurrency. Read under the season lock, so nothing can
    -- change between this comparison and the writes below.
    v_fingerprint := public.practice_schedule_fingerprint(v_season_id);
    IF base_fingerprint IS NOT NULL AND base_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'season % changed since this plan was read (fingerprint % is now %); reload and re-plan', v_season_id, base_fingerprint, v_fingerprint
            USING ERRCODE = '40001';
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

    -- #64: the upsert below replaces `results`, so a re-save under the same
    -- run id would erase the before-images an earlier save of it recorded --
    -- for a service-role caller, the only record of those rows. Read them first.
    SELECT sr.results
      INTO v_prior_results
      FROM public.scheduler_runs sr
     WHERE sr.id = v_run_id
       AND sr.organization_id = v_org_id;

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
        'practice',
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
          FROM jsonb_array_elements(assignments) AS assignment_items(value)
         WHERE jsonb_typeof(assignment_items.value) IS DISTINCT FROM 'object'
    ) THEN
        RAISE EXCEPTION 'each assignment must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_assignments AS MATERIALIZED (
        SELECT
            NULLIF(raw_assignments.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(raw_assignments.practice_slot_id, '')::uuid,
                NULLIF(raw_assignments.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(raw_assignments.effective_date_range, '')::daterange AS effective_date_range,
            CASE
                WHEN lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto'))
            END AS source,
            NULLIF(raw_assignments.assigned_via, '') AS assigned_via
        FROM jsonb_to_recordset(assignments) AS raw_assignments(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text,
            source text,
            assigned_via text
        )
    ),
    validated_assignments AS (
        SELECT
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source,
            parsed_assignments.assigned_via,
            t.id AS existing_team_id,
            t.organization_id AS team_org_id,
            ps.id AS existing_slot_id,
            ps.organization_id AS slot_org_id
        FROM parsed_assignments
        LEFT JOIN public.teams t
          ON t.id = parsed_assignments.team_id
        LEFT JOIN public.practice_slots ps
          ON ps.id = parsed_assignments.practice_slot_id
    ),
    validation_summary AS (
        SELECT
            count(*) FILTER (WHERE team_id IS NULL) AS missing_team_count,
            count(*) FILTER (WHERE practice_slot_id IS NULL) AS missing_slot_count,
            count(*) FILTER (WHERE effective_date_range IS NULL) AS missing_range_count,
            count(*) FILTER (WHERE source NOT IN ('auto', 'manual')) AS invalid_source_count,
            count(*) FILTER (
                WHERE assigned_via IS NOT NULL
                  AND assigned_via NOT IN ('auto', 'manual', 'repair', 'recommendation', 'override')
            ) AS invalid_via_count,
            (
                array_agg(team_id)
                    FILTER (WHERE team_id IS NOT NULL AND existing_team_id IS NULL)
            )[1] AS missing_team_ref,
            (
                array_agg(team_id)
                    FILTER (
                        WHERE existing_team_id IS NOT NULL
                          AND team_org_id <> v_org_id
                    )
            )[1] AS cross_team_ref,
            (
                array_agg(practice_slot_id)
                    FILTER (
                        WHERE practice_slot_id IS NOT NULL
                          AND existing_slot_id IS NULL
                    )
            )[1] AS missing_slot_ref,
            (
                array_agg(practice_slot_id)
                    FILTER (
                        WHERE existing_slot_id IS NOT NULL
                          AND slot_org_id <> v_org_id
                    )
            )[1] AS cross_slot_ref
        FROM validated_assignments
    )
    SELECT
        missing_team_count,
        missing_slot_count,
        missing_range_count,
        invalid_source_count,
        invalid_via_count,
        missing_team_ref,
        cross_team_ref,
        missing_slot_ref,
        cross_slot_ref
      INTO
        v_missing_team_count,
        v_missing_slot_count,
        v_missing_range_count,
        v_invalid_source_count,
        v_invalid_via_count,
        v_missing_team_ref,
        v_cross_team_ref,
        v_missing_slot_ref,
        v_cross_slot_ref
      FROM validation_summary;

    IF v_missing_team_count > 0 THEN
        RAISE EXCEPTION 'assignment team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_slot_count > 0 THEN
        RAISE EXCEPTION 'assignment practice_slot_id or slot_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_range_count > 0 THEN
        RAISE EXCEPTION 'assignment effective_date_range is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_invalid_source_count > 0 THEN
        RAISE EXCEPTION 'invalid practice assignment source'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_via_count > 0 THEN
        RAISE EXCEPTION 'invalid practice assignment assigned_via'
            USING ERRCODE = '22023';
    END IF;

    IF v_missing_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_id % does not exist', v_missing_team_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_cross_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_id % belongs to another organization', v_cross_team_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_missing_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'practice_slot_id % does not exist', v_missing_slot_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_cross_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'practice_slot_id % belongs to another organization', v_cross_slot_ref
            USING ERRCODE = '42501';
    END IF;

    -- -----------------------------------------------------------------------
    -- v3: every assignment id the repair arguments name must be a row of THIS
    -- season. One that exists elsewhere is 42501, whatever the argument: a
    -- save of one season must not unlock, close or annotate another's rows.
    -- -----------------------------------------------------------------------
    SELECT x.id, x.arg
      INTO v_bad_id, v_bad_why
      FROM (
            SELECT NULLIF(u.value->>'assignment_id', '')::uuid AS id, 'unlock' AS arg
              FROM jsonb_array_elements(unlock) u
            UNION ALL
            SELECT NULLIF(c.value->>'assignment_id', '')::uuid, 'closes'
              FROM jsonb_array_elements(closes) c
            UNION ALL
            SELECT NULLIF(e.value->>'assignment_id', '')::uuid, 'exceptions'
              FROM jsonb_array_elements(exceptions) e
           ) x
     WHERE x.id IS NULL
        OR NOT EXISTS (
            SELECT 1
              FROM public.practice_assignments pa
              JOIN public.teams t ON t.id = pa.team_id
              JOIN public.divisions d ON d.id = t.division_id
             WHERE pa.id = x.id
               AND pa.organization_id = v_org_id
               AND d.season_settings_id = v_season_id)
     LIMIT 1;
    IF v_bad_why IS NOT NULL THEN
        IF v_bad_id IS NULL THEN
            RAISE EXCEPTION '% entry has no assignment_id', v_bad_why
                USING ERRCODE = '23502';
        ELSIF EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.id = v_bad_id) THEN
            RAISE EXCEPTION '% names assignment %, which is not a row of season %', v_bad_why, v_bad_id, v_season_id
                USING ERRCODE = '42501';
        ELSE
            RAISE EXCEPTION '% names assignment %, which does not exist', v_bad_why, v_bad_id
                USING ERRCODE = '23503';
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(unlock) u
                WHERE length(btrim(COALESCE(u.value->>'reason', ''))) = 0) THEN
        RAISE EXCEPTION 'every unlock entry needs a reason'
            USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT (u.value->>'assignment_id')::uuid), '{}'::uuid[])
      INTO v_unlock_ids
      FROM jsonb_array_elements(unlock) u;
    SELECT COALESCE(array_agg(DISTINCT (c.value->>'assignment_id')::uuid), '{}'::uuid[])
      INTO v_close_ids
      FROM jsonb_array_elements(closes) c;

    IF jsonb_array_length(closes) <> cardinality(v_close_ids) THEN
        RAISE EXCEPTION 'closes names an assignment more than once'
            USING ERRCODE = '22023';
    END IF;
    -- A close must SHORTEN the row and leave it non-empty: last_day inside it.
    SELECT (c.value->>'assignment_id')::uuid
      INTO v_bad_id
      FROM jsonb_array_elements(closes) c
      JOIN public.practice_assignments pa ON pa.id = (c.value->>'assignment_id')::uuid
     WHERE NULLIF(c.value->>'last_day', '') IS NULL
        OR (c.value->>'last_day')::date < lower(pa.effective_date_range)
        OR NOT (upper_inf(pa.effective_date_range)
                OR (c.value->>'last_day')::date + 1 < upper(pa.effective_date_range))
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'closes: last_day for assignment % must fall inside its range and shorten it', v_bad_id
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(withdraw_exceptions) w
                WHERE NULLIF(w.value->>'exception_id', '') IS NULL) THEN
        RAISE EXCEPTION 'withdraw_exceptions entry has no exception_id'
            USING ERRCODE = '23502';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT (w.value->>'exception_id')::uuid), '{}'::uuid[])
      INTO v_withdraw_ids
      FROM jsonb_array_elements(withdraw_exceptions) w;
    SELECT x.id INTO v_bad_id
      FROM unnest(v_withdraw_ids) AS x(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe
                        WHERE pe.id = x.id AND pe.organization_id = v_org_id
                          AND pe.season_settings_id = v_season_id AND pe.withdrawn_at IS NULL)
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'withdraw_exceptions names %, which is not a live exception of season %', v_bad_id, v_season_id
            USING ERRCODE = '42501';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT pe.assignment_id), '{}'::uuid[])
      INTO v_withdraw_assignment_ids
      FROM public.practice_exceptions pe
     WHERE pe.id = ANY (v_withdraw_ids);

    -- #64: which of the season's teams held a practice BEFORE this save, for
    -- `teams_without_practice.had_prior_rows` below.
    SELECT COALESCE(array_agg(DISTINCT pa.team_id), '{}'::uuid[])
      INTO v_teams_with_prior
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- #64's prune set, computed rather than executed: v3 must refuse before
    -- it deletes anything. Scope is the season's teams, and only those.
    --   * a team IN the payload: every prior row whose (team, slot, range) key
    --     the payload does not carry -- unless `closes` names it, which keeps
    --     it by id with a shorter range;
    --   * a team in scope but ABSENT from the payload: its `auto` rows; its
    --     `manual` rows are kept and reported, as in #444.
    WITH payload AS MATERIALIZED (
        SELECT DISTINCT
            NULLIF(p.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(p.practice_slot_id, '')::uuid,
                NULLIF(p.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(p.effective_date_range, '')::daterange AS effective_date_range
        FROM jsonb_to_recordset(assignments) AS p(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text
        )
    ),
    scope AS (
        SELECT
            t.id AS team_id,
            EXISTS (SELECT 1 FROM payload k WHERE k.team_id = t.id) AS in_payload
        FROM public.teams t
        JOIN public.divisions d
          ON d.id = t.division_id
         AND d.organization_id = v_org_id
         AND d.season_settings_id = v_season_id
        WHERE t.organization_id = v_org_id
    ),
    prunable AS (
        SELECT pa.id, s.in_payload
          FROM public.practice_assignments pa
          JOIN scope s ON s.team_id = pa.team_id
         WHERE pa.organization_id = v_org_id
           AND NOT (pa.id = ANY (v_close_ids))
           AND (
               (
                   s.in_payload
                   AND NOT EXISTS (
                       SELECT 1
                         FROM payload k
                        WHERE k.team_id = pa.team_id
                          AND k.practice_slot_id = pa.practice_slot_id
                          AND k.effective_date_range = pa.effective_date_range
                   )
               )
               OR (NOT s.in_payload AND pa.source = 'auto')
           )
    )
    SELECT COALESCE(array_agg(prunable.id), '{}'::uuid[]),
           COALESCE(array_agg(prunable.id) FILTER (WHERE prunable.in_payload), '{}'::uuid[])
      INTO v_prune_ids, v_replaced_ids
      FROM prunable;

    -- -----------------------------------------------------------------------
    -- v3: THE LOCK. Every existing row this call would delete, re-range or
    -- move must be named in `unlock`, by its own id.
    -- -----------------------------------------------------------------------
    SELECT t.id, t.why
      INTO v_locked_id, v_locked_why
      FROM (
            SELECT p.id,
                   CASE WHEN p.id = ANY (v_replaced_ids)
                        THEN 'the payload no longer carries its (team, slot, range) key'
                        ELSE 'it is an auto row of a season team absent from the payload' END AS why
              FROM unnest(v_prune_ids) AS p(id)
            UNION ALL
            SELECT c.id, 'closes re-ranges it' FROM unnest(v_close_ids) AS c(id)
            UNION ALL
            SELECT w.id, 'an exception on it is withdrawn' FROM unnest(v_withdraw_assignment_ids) AS w(id)
           ) t
     WHERE NOT (t.id = ANY (v_unlock_ids))
     ORDER BY t.id
     LIMIT 1;
    IF v_locked_id IS NOT NULL THEN
        RAISE EXCEPTION 'assignment % is locked: % -- list it in unlock, with a reason, to change it', v_locked_id, v_locked_why
            USING ERRCODE = '22023';
    END IF;

    -- The override prompt was accepted: one audit row per unlocked
    -- assignment, carrying the row as it stood before this save touched it.
    -- The gate above guarantees a uid whenever this list is non-empty.
    SELECT COALESCE(jsonb_agg(to_jsonb(pa.*) ORDER BY pa.id), '[]'::jsonb)
      INTO v_unlocked
      FROM public.practice_assignments pa
     WHERE pa.id = ANY (v_unlock_ids);
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_unlocked) LOOP
        PERFORM public.record_audit_event(
            v_org_id,
            'practice.unlock_accepted',
            'practice_assignment',
            (v_row->>'id')::uuid,
            jsonb_build_object(
                'run_id', v_run_id,
                'season_settings_id', v_season_id,
                'reason', (SELECT u.value->>'reason' FROM jsonb_array_elements(unlock) u
                            WHERE (u.value->>'assignment_id')::uuid = (v_row->>'id')::uuid LIMIT 1),
                'before', v_row
            )
        );
    END LOOP;

    -- Withdrawals (their assignments are unlocked, checked above).
    WITH w AS (
        UPDATE public.practice_exceptions pe
           SET withdrawn_at = timezone('utc', now()),
               withdrawn_by = auth.uid()
         WHERE pe.id = ANY (v_withdraw_ids)
           AND pe.withdrawn_at IS NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(w.*) ORDER BY w.id), '[]'::jsonb)
      INTO v_withdrawn
      FROM w;

    -- Closes: shorten in place; the id survives (plan §3, retirement split).
    WITH pre AS (
        SELECT pa.*, (c.value->>'last_day')::date AS last_day
          FROM jsonb_array_elements(closes) c
          JOIN public.practice_assignments pa ON pa.id = (c.value->>'assignment_id')::uuid
    ),
    upd AS (
        UPDATE public.practice_assignments pa
           SET effective_date_range = daterange(lower(pa.effective_date_range), b.last_day + 1, '[)'),
               updated_at = timezone('utc', now())
          FROM pre b
         WHERE pa.id = b.id
        RETURNING pa.id, pa.effective_date_range
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', upd.id,
               'before', to_jsonb(b.*) - 'last_day',
               'effective_date_range', upd.effective_date_range::text)
             ORDER BY upd.id), '[]'::jsonb)
      INTO v_closed
      FROM upd JOIN pre b ON b.id = upd.id;

    -- The unlocked prune. A WITHDRAWN exception no longer overrides anything,
    -- so it is archived onto this run and removed with its series; a LIVE one
    -- is left for the RESTRICT foreign key to refuse (23503): deleting an
    -- overridden series is never silent.
    WITH gone AS (
        DELETE FROM public.practice_exceptions pe
         WHERE pe.assignment_id = ANY (v_prune_ids)
           AND pe.withdrawn_at IS NOT NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(gone.*) ORDER BY gone.id), '[]'::jsonb)
      INTO v_superseded_exceptions
      FROM gone;

    WITH removed AS (
        DELETE FROM public.practice_assignments pa
         WHERE pa.id = ANY (v_prune_ids)
           AND pa.organization_id = v_org_id
        RETURNING pa.*,
            CASE WHEN pa.id = ANY (v_replaced_ids) THEN 'replaced' ELSE 'team_not_in_schedule' END
                AS superseded_reason
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(removed) ORDER BY removed.team_id, removed.id), '[]'::jsonb)
      INTO v_removed
      FROM removed;

    -- What the prune deliberately kept: rows of in-season teams the payload
    -- does not mention and whose source is not `auto`. Reported, not deleted.
    SELECT COALESCE(array_agg(DISTINCT NULLIF(p.team_id, '')::uuid), '{}'::uuid[])
      INTO v_payload_teams
      FROM jsonb_to_recordset(assignments) AS p(team_id text);

    SELECT COALESCE(
               jsonb_agg(to_jsonb(pa.*) ORDER BY pa.team_id, pa.id),
               '[]'::jsonb
           )
      INTO v_retained
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.organization_id = v_org_id
       AND d.season_settings_id = v_season_id
       AND pa.team_id <> ALL (v_payload_teams);

    -- v3: a NEW key must not overlap a row its team still holds. Checked after
    -- closes and the prune, so an unlocked row that is removed or shortened
    -- makes room; one that stays does not.
    WITH payload AS (
        SELECT DISTINCT
            NULLIF(p.team_id, '')::uuid AS team_id,
            COALESCE(NULLIF(p.practice_slot_id, '')::uuid, NULLIF(p.slot_id, '')::uuid) AS practice_slot_id,
            NULLIF(p.effective_date_range, '')::daterange AS effective_date_range
        FROM jsonb_to_recordset(assignments) AS p(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text
        )
    )
    SELECT pa.id
      INTO v_overlap_id
      FROM payload k
      JOIN public.practice_assignments pa
        ON pa.team_id = k.team_id
       AND pa.effective_date_range && k.effective_date_range
     WHERE NOT EXISTS (
               SELECT 1
                 FROM public.practice_assignments e
                WHERE e.team_id = k.team_id
                  AND e.practice_slot_id = k.practice_slot_id
                  AND e.effective_date_range = k.effective_date_range)
     ORDER BY pa.id
     LIMIT 1;
    IF v_overlap_id IS NOT NULL THEN
        RAISE EXCEPTION 'assignment % is locked: a new row for its team overlaps its range -- unlock and remove or close it first', v_overlap_id
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_assignments AS (
        SELECT
            NULLIF(raw_assignments.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(raw_assignments.practice_slot_id, '')::uuid,
                NULLIF(raw_assignments.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(raw_assignments.effective_date_range, '')::daterange AS effective_date_range,
            CASE
                WHEN lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto'))
            END AS source,
            NULLIF(raw_assignments.assigned_via, '') AS assigned_via
        FROM jsonb_to_recordset(assignments) AS raw_assignments(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text,
            source text,
            assigned_via text
        )
    ),
    org_scoped_assignments AS (
        SELECT DISTINCT ON (
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range
        )
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source,
            COALESCE(
                parsed_assignments.assigned_via,
                CASE WHEN parsed_assignments.source = 'manual' THEN 'manual' ELSE 'auto' END
            ) AS assigned_via,
            ps.day_of_week::text AS day_of_week,
            ps.start_time::text AS start_time,
            ps.end_time::text AS end_time,
            ps.field_id
        FROM parsed_assignments
        JOIN public.teams t
          ON t.id = parsed_assignments.team_id
         AND t.organization_id = v_org_id
        JOIN public.practice_slots ps
          ON ps.id = parsed_assignments.practice_slot_id
         AND ps.organization_id = v_org_id
        ORDER BY
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source DESC
    )
    INSERT INTO public.practice_assignments (
        organization_id,
        run_id,
        team_id,
        slot_id,
        practice_slot_id,
        day_of_week,
        start_time,
        end_time,
        field_id,
        effective_date_range,
        source,
        assigned_via
    )
    SELECT
        v_org_id,
        v_run_id,
        team_id,
        practice_slot_id,
        practice_slot_id,
        day_of_week,
        start_time,
        end_time,
        field_id,
        effective_date_range,
        source::source_enum,
        assigned_via
    FROM org_scoped_assignments
    ON CONFLICT (team_id, practice_slot_id, effective_date_range)
        WHERE practice_slot_id IS NOT NULL
          AND effective_date_range IS NOT NULL
    DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        run_id = EXCLUDED.run_id,
        slot_id = EXCLUDED.slot_id,
        day_of_week = EXCLUDED.day_of_week,
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        field_id = EXCLUDED.field_id,
        source = EXCLUDED.source,
        updated_at = timezone('utc', now());
    -- (assigned_via is provenance: an existing row keeps the one it was
    -- placed with.)

    -- v3: exceptions are their own rows, keyed to the assignment they
    -- override -- never an assignment row (plan §1).
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(exceptions) e
         WHERE NULLIF(e.value->>'practice_slot_id', '') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.practice_slots ps
                            WHERE ps.id = (e.value->>'practice_slot_id')::uuid
                              AND ps.organization_id = v_org_id)
    ) THEN
        RAISE EXCEPTION 'an exception names a practice slot outside organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;
    WITH ins AS (
        INSERT INTO public.practice_exceptions (
            organization_id, season_settings_id, team_id, assignment_id, "window",
            kind, practice_slot_id, tbd_reason, cause_kind, cause_id, run_id, created_by
        )
        SELECT v_org_id, v_season_id, pa.team_id, pa.id,
               NULLIF(e.value->>'window', '')::daterange,
               e.value->>'kind',
               NULLIF(e.value->>'practice_slot_id', '')::uuid,
               NULLIF(e.value->>'tbd_reason', ''),
               NULLIF(e.value->>'cause_kind', ''),
               NULLIF(e.value->>'cause_id', '')::uuid,
               v_run_id,
               v_created_by
          FROM jsonb_array_elements(exceptions) e
          JOIN public.practice_assignments pa ON pa.id = (e.value->>'assignment_id')::uuid
        RETURNING *
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ins.*) ORDER BY ins.id), '[]'::jsonb)
      INTO v_recorded
      FROM ins;

    -- #64: every team of the season left with NO practice by this save --
    -- unplaced by the solver, absent from the payload, stripped of its auto
    -- row, or never scheduled at all. Enumerated from the season's ROSTER, not
    -- from the payload or the superseded list: a team either of those lost
    -- track of must still be named here, which is the point of the list.
    SELECT count(*),
           COALESCE(
               jsonb_agg(
                   jsonb_build_object(
                       'team_id', t.id,
                       'team_name', t.name,
                       'had_prior_rows', t.id = ANY (v_teams_with_prior)
                   )
                   ORDER BY t.name, t.id
               ) FILTER (
                   WHERE NOT EXISTS (
                       SELECT 1 FROM public.practice_assignments pa WHERE pa.team_id = t.id
                   )
               ),
               '[]'::jsonb
           )
      INTO v_season_team_count, v_without_practice
      FROM public.teams t
      JOIN public.divisions d ON d.id = t.division_id
     WHERE t.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- v3: every roster team holding a live TIME TBD window after this save,
    -- enumerated from the season's ROSTER for the same reason as above.
    SELECT COALESCE(
               jsonb_agg(
                   jsonb_build_object(
                       'team_id', t.id,
                       'team_name', t.name,
                       'exception_id', pe.id,
                       'assignment_id', pe.assignment_id,
                       'window', pe."window"::text,
                       'tbd_reason', pe.tbd_reason
                   )
                   ORDER BY t.name, t.id, lower(pe."window")
               ),
               '[]'::jsonb
           )
      INTO v_time_tbd
      FROM public.teams t
      JOIN public.divisions d ON d.id = t.division_id
      JOIN public.practice_exceptions pe
        ON pe.team_id = t.id
       AND pe.kind = 'time_tbd'
       AND pe.withdrawn_at IS NULL
     WHERE t.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- The run carries its own before-images, so what it superseded, unlocked,
    -- closed and withdrew can be read back whether or not the audit rows exist.
    UPDATE public.scheduler_runs
       SET results = COALESCE(results, '{}'::jsonb) || jsonb_build_object(
               'superseded_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'superseded_rows') = 'array'
                        THEN v_prior_results->'superseded_rows' ELSE '[]'::jsonb END || v_removed,
               'retained_manual', v_retained,
               'unlocked_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'unlocked_rows') = 'array'
                        THEN v_prior_results->'unlocked_rows' ELSE '[]'::jsonb END || v_unlocked,
               'closed_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'closed_rows') = 'array'
                        THEN v_prior_results->'closed_rows' ELSE '[]'::jsonb END || v_closed,
               'superseded_exceptions',
                   CASE WHEN jsonb_typeof(v_prior_results->'superseded_exceptions') = 'array'
                        THEN v_prior_results->'superseded_exceptions' ELSE '[]'::jsonb END || v_superseded_exceptions
           )
     WHERE id = v_run_id
       AND organization_id = v_org_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RAISE EXCEPTION 'scheduler run % could not record what it superseded', v_run_id
            USING ERRCODE = '42501';
    END IF;

    -- Audit: one row per superseded assignment, with the full row, and one per
    -- run. `record_audit_event` writes `auth.uid()` into the NOT NULL
    -- `audit_log.user_id`, so a caller with no uid -- a service-role caller;
    -- `practice-persistence` calls as the user -- cannot be audited here:
    -- calling it would fail the save with 23502 (the defect 20260726000200
    -- records as KNOWN PRE-EXISTING). That caller is told so in the result
    -- rather than the audit being skipped in silence, and its before-images
    -- are on the run. (v3: such a caller cannot unlock, so it can supersede
    -- nothing; what it can still do unaudited is ADD rows and exceptions.)
    IF auth.uid() IS NOT NULL THEN
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_removed) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.superseded',
                'practice_assignment',
                (v_row->>'id')::uuid,
                jsonb_build_object(
                    'run_id', v_run_id,
                    'season_settings_id', v_season_id,
                    'reason', v_row->>'superseded_reason',
                    'row', v_row - 'superseded_reason'
                )
            );
        END LOOP;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_withdrawn) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.exception_withdrawn',
                'practice_exception',
                (v_row->>'id')::uuid,
                jsonb_build_object('run_id', v_run_id, 'reason', 'withdrawn_by_save', 'row', v_row)
            );
        END LOOP;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_recorded) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.exception_recorded',
                'practice_exception',
                (v_row->>'id')::uuid,
                jsonb_build_object('run_id', v_run_id, 'row', v_row)
            );
        END LOOP;
        PERFORM public.record_audit_event(
            v_org_id,
            'practice.saved',
            'scheduler_run',
            v_run_id,
            jsonb_build_object(
                'season_settings_id', v_season_id,
                'assignment_count', jsonb_array_length(assignments),
                'superseded_count', jsonb_array_length(v_removed),
                'retained_manual_count', jsonb_array_length(v_retained),
                'allow_empty', COALESCE(allow_empty, false),
                'unlocked_count', jsonb_array_length(v_unlocked),
                'closed_count', jsonb_array_length(v_closed),
                'exceptions_recorded', jsonb_array_length(v_recorded),
                'exceptions_withdrawn', jsonb_array_length(v_withdrawn),
                'base_fingerprint', base_fingerprint
            )
        );
        v_audited := true;
    END IF;

    RETURN jsonb_build_object(
        'run_id', v_run_id,
        'superseded', v_removed,
        'superseded_count', jsonb_array_length(v_removed),
        'retained_manual', v_retained,
        'retained_manual_count', jsonb_array_length(v_retained),
        'teams_without_practice', v_without_practice,
        'season_team_count', v_season_team_count,
        'teams_time_tbd', v_time_tbd,
        'unlocked', v_unlocked,
        'closed', v_closed,
        'exceptions_recorded', v_recorded,
        'exceptions_withdrawn', v_withdrawn,
        'fingerprint', public.practice_schedule_fingerprint(v_season_id),
        'audited', v_audited,
        'audit_gap', CASE WHEN v_audited THEN NULL ELSE
            'no auth.uid(): record_audit_event cannot attribute this save; the superseded rows are recorded on scheduler_runs.results instead'
        END
    );
END;
$$;
REVOKE ALL ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) TO service_role;

-- ---------------------------------------------------------------------------
-- admin_cancel_practice_assignment (copied whole from 20260613000003:102-131)
-- ---------------------------------------------------------------------------
-- Decision 7: the explicit admin cancel counts as its own override prompt. It
-- withdraws the series' live exceptions in the SAME transaction, audits each
-- withdrawal, archives every exception row (withdrawn ones included) to its
-- run's `results.archived_exceptions` and to the audit log, removes them so
-- the RESTRICT foreign key lets the series go, and records the series'
-- before-image and the withdrawn ids on its own `practice.cancelled` row.
CREATE OR REPLACE FUNCTION public.admin_cancel_practice_assignment(p_assignment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id uuid;
    v_before jsonb;
    v_withdrawn jsonb;
    v_archived jsonb;
    v_row jsonb;
BEGIN
    SELECT pa.organization_id, to_jsonb(pa.*) INTO v_org_id, v_before
    FROM public.practice_assignments pa WHERE pa.id = p_assignment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'practice assignment % not found', p_assignment_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    WITH w AS (
        UPDATE public.practice_exceptions pe
           SET withdrawn_at = timezone('utc', now()),
               withdrawn_by = auth.uid()
         WHERE pe.assignment_id = p_assignment_id
           AND pe.withdrawn_at IS NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(w.*) ORDER BY w.id), '[]'::jsonb)
      INTO v_withdrawn
      FROM w;
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_withdrawn) LOOP
        PERFORM public.record_audit_event(
            v_org_id,
            'practice.exception_withdrawn',
            'practice_exception',
            (v_row->>'id')::uuid,
            jsonb_build_object('reason', 'assignment_cancelled',
                               'assignment_id', p_assignment_id, 'row', v_row)
        );
    END LOOP;

    WITH gone AS (
        DELETE FROM public.practice_exceptions pe
         WHERE pe.assignment_id = p_assignment_id
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(gone.*) ORDER BY gone.id), '[]'::jsonb)
      INTO v_archived
      FROM gone;
    UPDATE public.scheduler_runs sr
       SET results = COALESCE(sr.results, '{}'::jsonb) || jsonb_build_object(
               'archived_exceptions',
               COALESCE(sr.results->'archived_exceptions', '[]'::jsonb)
               || (SELECT jsonb_agg(e.value) FROM jsonb_array_elements(v_archived) e
                    WHERE (e.value->>'run_id')::uuid = sr.id))
     WHERE sr.id IN (SELECT (e.value->>'run_id')::uuid FROM jsonb_array_elements(v_archived) e
                      WHERE e.value->>'run_id' IS NOT NULL);

    DELETE FROM public.practice_assignments WHERE id = p_assignment_id;

    PERFORM public.record_audit_event(
        v_org_id,
        'practice.cancelled',
        'practice_assignments',
        p_assignment_id,
        jsonb_build_object(
            'assignment_id', p_assignment_id,
            'before', v_before,
            'withdrawn_exception_ids',
                (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb) FROM jsonb_array_elements(v_withdrawn) e),
            'archived_exceptions', v_archived
        )
    );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_cancel_practice_assignment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_practice_assignment(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.admin_cancel_practice_assignment(uuid) IS
  'Audited practice assignment cancellation for org admins; withdraws, audits and archives the series'' practice exceptions in the same transaction (8.6 PR 3b decision 7).';

COMMIT;
