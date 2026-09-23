-- Revert for 20260923000000_team_coach_assignments.sql
--
-- **This revert DESTROYS the coaching history.** The denormalised columns
-- survive (they are current state and the restored writers go on writing
-- them), but every ENDED assignment -- "who coached this team three weeks ago"
-- -- exists only in team_coach_assignments and is gone once the table is
-- dropped. The figure is printed BEFORE the drop, so the transcript of a
-- revert says what it cost.
--
-- Restores the three routed writers to their previous live definitions, copied
-- whole from 20260503050000, 20260613000000 and 20260610000000, and removes the
-- four-argument admin_assign_team_coach, the drift check, the single writer and
-- the table. The audit action and the audit rows written under it are left
-- intact: audit history is not this revert's to erase.

BEGIN;

DO $warn$
DECLARE
    v_rows integer;
    v_ended integer;
    v_teams integer;
BEGIN
    SELECT count(*), count(*) FILTER (WHERE effective_to IS NOT NULL), count(DISTINCT team_id)
      INTO v_rows, v_ended, v_teams
      FROM public.team_coach_assignments;
    RAISE WARNING 'this revert DESTROYS % coach assignment row(s) across % team(s); % of them are ENDED appointments that no other table records',
        v_rows, v_teams, v_ended;
END;
$warn$;

DROP FUNCTION IF EXISTS public.admin_assign_team_coach(uuid, uuid, uuid, date);

CREATE OR REPLACE FUNCTION public.admin_assign_team_coach(
    p_organization_id uuid,
    p_team_id uuid,
    p_coach_id uuid DEFAULT NULL
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

    UPDATE public.teams
       SET coach_id = p_coach_id,
           updated_at = timezone('utc', now())
     WHERE id = p_team_id
       AND organization_id = p_organization_id;

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
            'coach_id', p_coach_id
        )
    );

    RETURN jsonb_build_object(
        'team_id', p_team_id,
        'organization_id', p_organization_id,
        'previous_coach_id', v_previous_coach_id,
        'coach_id', p_coach_id,
        'changed', true
    );
END;
$$;

COMMENT ON FUNCTION public.admin_assign_team_coach(uuid, uuid, uuid) IS
    'Admin-only team head coach assignment RPC with org scoping, serialized single-team capacity checks, and audit logging.';

GRANT EXECUTE ON FUNCTION public.admin_assign_team_coach(uuid, uuid, uuid) TO authenticated;

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

    -- Head-coach (SET NULL FK) is touched explicitly so updated_at reflects
    -- the unassignment; assistant_coach_ids is a bare uuid[] with no FK and
    -- must be scrubbed by hand or rosters keep pointing at deleted coaches.
    UPDATE public.teams t
       SET coach_id = NULL,
           updated_at = timezone('utc', now())
     WHERE t.coach_id = ANY(p_coach_ids);

    UPDATE public.teams t
       SET assistant_coach_ids = (
               SELECT COALESCE(array_agg(x), '{}'::uuid[])
               FROM unnest(t.assistant_coach_ids) AS x
               WHERE NOT (x = ANY(p_coach_ids))
           ),
           updated_at = timezone('utc', now())
     WHERE t.assistant_coach_ids && p_coach_ids;

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

    INSERT INTO public.teams (
        id,
        organization_id,
        division_id,
        coach_id,
        name,
        notes,
        assistant_coach_ids
    )
    SELECT DISTINCT ON (id)
        id,
        v_org_id,
        division_id,
        coach_id,
        name,
        notes,
        assistant_coach_ids
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
    ON CONFLICT (id) DO UPDATE SET
        division_id = EXCLUDED.division_id,
        coach_id = EXCLUDED.coach_id,
        name = EXCLUDED.name,
        notes = COALESCE(EXCLUDED.notes, public.teams.notes),
        assistant_coach_ids = COALESCE(EXCLUDED.assistant_coach_ids, public.teams.assistant_coach_ids),
        updated_at = timezone('utc', now())
    WHERE public.teams.organization_id = EXCLUDED.organization_id;

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

DROP FUNCTION IF EXISTS public.team_coach_assignment_drift(uuid);
DROP FUNCTION IF EXISTS public.set_team_coaches(uuid, uuid, uuid[], date, text);
DROP TABLE IF EXISTS public.team_coach_assignments;

-- The revert verifies itself: nothing it removes may survive, and nothing it
-- restores may still reach the dropped writer.
DO $verify$
DECLARE
    v_bad text;
BEGIN
    IF to_regclass('public.team_coach_assignments') IS NOT NULL THEN
        RAISE EXCEPTION 'revert incomplete: team_coach_assignments still exists';
    END IF;
    IF to_regprocedure('public.set_team_coaches(uuid, uuid, uuid[], date, text)') IS NOT NULL
       OR to_regprocedure('public.team_coach_assignment_drift(uuid)') IS NOT NULL
       OR to_regprocedure('public.admin_assign_team_coach(uuid, uuid, uuid, date)') IS NOT NULL THEN
        RAISE EXCEPTION 'revert incomplete: a function this migration added survives';
    END IF;
    SELECT string_agg(p.proname, ', ') INTO v_bad
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('admin_assign_team_coach', 'admin_delete_coaches', 'persist_team_schedule')
       AND p.prosrc LIKE '%set_team_coaches%';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'revert incomplete: % still call the dropped set_team_coaches()', v_bad;
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('admin_assign_team_coach', 'admin_delete_coaches', 'persist_team_schedule')) <> 3 THEN
        RAISE EXCEPTION 'revert incomplete: expected exactly one overload each of the three restored writers';
    END IF;
    RAISE NOTICE 'revert verified: table, single writer and drift check gone; the three writers restored, one overload each, none calling the dropped writer';
END;
$verify$;

COMMIT;
