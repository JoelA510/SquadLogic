-- ==========================================
-- #64: persist_practice_schedule supersedes what it replaces
-- ==========================================
--
-- `persist_practice_schedule` (last defined in 20260503020000) wrote
-- `practice_assignments` with an INSERT ... ON CONFLICT (team, slot, range)
-- upsert and nothing else. A save that moved a team from slot A to slot B
-- therefore ADDED the B row and left the A row standing; a save that changed
-- a slot's date range left the old range standing; a save that dropped a team
-- left its rows standing. Executed against the full migration chain, a
-- five-team re-run left Team 1 with two weekly practices (26 occurrences for
-- 13 weeks) and Team 2 with two identical Monday events on every overlapping
-- week. Every reader that selects by `team_id` -- the ICS feed families
-- subscribe to, the team portal, the player record -- reads all of them.
--
-- ## What this changes
--
-- In the same transaction as the upsert, the RPC now removes the rows the new
-- schedule supersedes, scoped to the teams of the run's season. A payload team
-- outside that season is upserted exactly as before and never pruned: a save
-- of one season cannot delete another's rows, whichever lock it holds.
--
--   * a team IN the payload loses every prior row whose (team, slot, range)
--     key the payload does not carry, whatever its source. Locked rows are
--     re-sent as `manual`, keep their key, and are upserted as before;
--   * a team in the season but ABSENT from the payload loses its `auto` rows;
--     its `manual` rows are kept and REPORTED in the result
--     (`retained_manual`).
--
-- Also:
--   * `season_settings_id` is required (the prune has no scope without it);
--   * an empty payload is refused unless `allow_empty => true`;
--   * `pg_advisory_xact_lock(org, season)` serialises two saves of a season;
--   * a re-save under an existing run id APPENDS to that run's
--     `superseded_rows` rather than replacing them;
--   * non-service-role callers must be org ADMINS -- which the
--     `practice_assignments_write_admin` policy already required of every
--     write; the check turns a silent zero-row DELETE into a refusal;
--   * the result is now jsonb: `run_id`, the superseded rows in full, the
--     retained manual rows, and whether the save was audited. The return type
--     changes, so the two-argument function is DROPped and recreated.
--
-- ## Audit, and the one caller it cannot cover
--
-- Every superseded row gets one `practice.superseded` audit row carrying the
-- full row, and every save one `practice.saved` row -- when the caller has an
-- `auth.uid()`. The live caller does: the `practice-persistence` Edge Function
-- calls this RPC with a USER client (the anon key plus the caller's JWT), so
-- the admin check below, the `practice_assignments_write_admin` policy and the
-- audit all apply on the live path.
--
-- A service-role caller has no uid. `record_audit_event` writes `auth.uid()`
-- into the NOT NULL `audit_log.user_id`, so auditing there would fail the save
-- with 23502 -- the defect 20260726000200 records as KNOWN PRE-EXISTING. That
-- branch returns `audited: false` with the reason. No live code path takes it
-- after #64: its remaining callers are an operator running the RPC with the
-- service key, and `packages/core`'s `persistPracticeSnapshotTransactional`,
-- which nothing in the app wires to a service-role client. The superseded
-- before-images are ALSO written to the run's
-- `scheduler_runs.results.superseded_rows` on every path, which is what makes
-- a prune readable and reversible whichever way it was called.
--
-- ## What this does NOT do
--
-- It cleans up nothing already in the database. Superseded rows written
-- before this migration stay until an operator decides how to remove them.
-- It does not touch any reader.
--
-- Reversible: see docs/sql/20260924000000_revert.sql.
-- Smoke checks: see docs/sql/20260924000000_smoke.sql.

BEGIN;

INSERT INTO public.audit_actions (action) VALUES ('practice.superseded')
    ON CONFLICT (action) DO NOTHING;
INSERT INTO public.audit_actions (action) VALUES ('practice.saved')
    ON CONFLICT (action) DO NOTHING;

DROP FUNCTION IF EXISTS public.persist_practice_schedule(jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.persist_practice_schedule(
    run_data jsonb,
    assignments jsonb,
    allow_empty boolean DEFAULT false
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
    v_missing_team_ref uuid;
    v_cross_team_ref uuid;
    v_missing_slot_ref uuid;
    v_cross_slot_ref uuid;
    v_removed jsonb;
    v_retained jsonb;
    v_row jsonb;
    v_audited boolean := false;
    v_updated integer;
    v_prior_superseded jsonb;
    v_payload_teams uuid[];
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
    SELECT sr.results->'superseded_rows'
      INTO v_prior_superseded
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
            END AS source
        FROM jsonb_to_recordset(assignments) AS raw_assignments(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text,
            source text
        )
    ),
    validated_assignments AS (
        SELECT
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source,
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
        missing_team_ref,
        cross_team_ref,
        missing_slot_ref,
        cross_slot_ref
      INTO
        v_missing_team_count,
        v_missing_slot_count,
        v_missing_range_count,
        v_invalid_source_count,
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

    -- #64: supersede what this schedule replaces. The upsert below only ever
    -- ADDED rows, so a team moved from slot A to slot B kept both, and every
    -- reader that selects by team showed the family both practices.
    --
    -- Scope: the season's teams, and only those.
    --   * a team IN the payload: every prior row whose (team, slot, range) key
    --     the payload does not carry is superseded, whatever its source -- a
    --     locked row is re-sent as `manual` and so keeps its key;
    --   * a team in scope but ABSENT from the payload: its `auto` rows are
    --     superseded and anything else (`manual`) is kept and reported below.
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
    removed AS (
        DELETE FROM public.practice_assignments pa
         USING scope s
         WHERE pa.team_id = s.team_id
           AND pa.organization_id = v_org_id
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
        RETURNING pa.*,
            CASE WHEN s.in_payload THEN 'replaced' ELSE 'team_not_in_schedule' END
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
            END AS source
        FROM jsonb_to_recordset(assignments) AS raw_assignments(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text,
            source text
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
        source
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
        source::source_enum
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

    -- The run carries its own before-images, so what it superseded can be
    -- read back and restored whether or not the audit rows below exist.
    UPDATE public.scheduler_runs
       SET results = COALESCE(results, '{}'::jsonb) || jsonb_build_object(
               'superseded_rows',
                   CASE WHEN jsonb_typeof(v_prior_superseded) = 'array'
                        THEN v_prior_superseded ELSE '[]'::jsonb END || v_removed,
               'retained_manual', v_retained
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
    -- are on the run.
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
                'allow_empty', COALESCE(allow_empty, false)
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
        'audited', v_audited,
        'audit_gap', CASE WHEN v_audited THEN NULL ELSE
            'no auth.uid(): record_audit_event cannot attribute this save; the superseded rows are recorded on scheduler_runs.results instead'
        END
    );
END;
$$;
REVOKE ALL ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean) TO service_role;

COMMIT;
