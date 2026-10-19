-- Team and game saves write their audit row in the same transaction, refuse a
-- caller with no user, and the game save requires an organization admin.
--
-- Plan: docs/PLAN_AUDIT_IN_TRANSACTION.md (approved by the owner on
-- 2026-10-18, every recommendation as written), sections 3 to 5.
--
-- **Why.** `team-persistence` and `game-persistence` called these RPCs with the
-- service-role client and wrote `team.saved` / `game.saved` afterwards, in a
-- second call that only logged its failure, so a save could land without its
-- audit row. Both RPCs exempted `service_role` from their own caller check, so
-- the Edge Function's early check was the only gate. And `persist_game_schedule`
-- checked only `is_org_member`, while `authenticated` may execute it: any
-- member -- a coach of the organization, on a scratch build -- could overwrite
-- the season's games by calling it directly (plan section 1.1, Q6).
--
-- **What changes**, in each function, replaced wholesale from its latest
-- revision (persist_team_schedule from 20260923000000, persist_game_schedule
-- from 20260503030000; both bodies equal production's, md5(prosrc) read back
-- on 2026-10-18):
--   1. A caller with no `auth.uid()` (the service role) is refused 42501 after
--      the input checks and before the organization is resolved or anything is
--      written (Q2). The `service_role` exemption from the caller check is gone,
--      and `created_by` is always `auth.uid()`.
--   2. `persist_game_schedule` requires `is_org_admin` at both of its caller
--      checks, as `persist_team_schedule` does (Q6).
--   3. The audit row (`team.saved` / `game.saved` on `scheduler_run`, with the
--      run id; Q4) is written last, inside the save's transaction. A failed
--      audit write is re-raised as SQLSTATE SLA01 (a custom class nothing else
--      raises), which aborts the whole save (Q3); the Edge Function answers 500
--      "Nothing was saved".
-- Signatures, RETURNS uuid, SECURITY DEFINER, the search_path and the grants
-- are unchanged, so no DROP and no caller breaks; a service-role caller now
-- gets the 42501 above. Every other line is copied, not retyped.
--
-- **Deploy window.** CI applies this migration before it deploys the Edge
-- Functions, so for a few minutes the old Edge code calls these RPCs with the
-- service role and is refused 42501: refused saves, never partial ones.
-- Production has 0 teams and 0 games (plan section 6).
--
-- Reversible: see docs/sql/20261018070000_revert.sql.
-- Smoke checks: see docs/sql/20261018070000_smoke.sql.

BEGIN;

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

    -- 20261018070000: the save writes its own audit row (below), and an audit
    -- row needs an actor, so a caller with no user -- the service role -- is
    -- refused before anything is read or written (plan Q2).
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'persist_team_schedule needs a signed-in caller to audit the save'
            USING ERRCODE = '42501';
    END IF;

    v_run_id := COALESCE(NULLIF(run_data->>'id', '')::uuid, gen_random_uuid());
    v_org_id := NULLIF(run_data->>'organization_id', '')::uuid;
    v_season_settings_id := NULLIF(run_data->>'season_settings_id', '')::uuid;
    v_season_id := COALESCE(NULLIF(run_data->>'season_id', '')::uuid, v_season_settings_id);

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

    IF NOT public.is_org_admin(v_org_id) THEN
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

    v_created_by := auth.uid();

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

    -- 20261018070000: the audit row, in this transaction (plan section 3.1).
    -- A failed write rolls the whole save back; SLA01 tells the Edge Function
    -- it was the audit, and DETAIL keeps the original SQLSTATE. Every error is
    -- caught and every one is re-raised.
    BEGIN
        PERFORM public.record_audit_event(
            v_org_id, 'team.saved', 'scheduler_run', v_persisted_run_id,
            jsonb_build_object(
                'season_settings_id', COALESCE(v_season_settings_id, v_season_id),
                'team_count', jsonb_array_length(teams),
                'team_player_count', jsonb_array_length(team_players)));
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    RETURN v_persisted_run_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_game_schedule(
    run_data jsonb,
    assignments jsonb
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
    v_season_id uuid;
    v_season_settings_id uuid;
    v_season_org_id uuid;
    v_run_type text;
    v_status text;
    v_created_by uuid;
    v_started_at timestamptz;
    v_completed_at timestamptz;
    v_missing_home_count integer;
    v_missing_away_count integer;
    v_missing_slot_count integer;
    v_missing_week_count integer;
    v_missing_start_count integer;
    v_missing_end_count integer;
    v_same_team_count integer;
    v_invalid_time_count integer;
    v_invalid_source_count integer;
    v_invalid_week_count integer;
    v_missing_home_ref uuid;
    v_missing_away_ref uuid;
    v_missing_slot_ref uuid;
    v_missing_field_ref uuid;
    v_cross_home_ref uuid;
    v_cross_away_ref uuid;
    v_cross_slot_ref uuid;
    v_cross_field_ref uuid;
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

    v_run_type := COALESCE(NULLIF(run_data->>'run_type', ''), 'game');
    IF v_run_type <> 'game' THEN
        RAISE EXCEPTION 'persist_game_schedule only accepts game runs'
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

    -- 20261018070000: the save writes its own audit row (below), and an audit
    -- row needs an actor, so a caller with no user -- the service role -- is
    -- refused before anything is read or written (plan Q2).
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'persist_game_schedule needs a signed-in caller to audit the save'
            USING ERRCODE = '42501';
    END IF;

    v_run_id := COALESCE(NULLIF(run_data->>'id', '')::uuid, gen_random_uuid());
    v_org_id := NULLIF(run_data->>'organization_id', '')::uuid;
    v_season_settings_id := NULLIF(run_data->>'season_settings_id', '')::uuid;
    v_season_id := COALESCE(NULLIF(run_data->>'season_id', '')::uuid, v_season_settings_id);

    -- 20261018070000: an organization admin, not any member (plan Q6), as
    -- persist_team_schedule and persist_practice_schedule require.
    IF v_org_id IS NOT NULL
       AND NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    IF v_season_settings_id IS NOT NULL
       AND v_season_id IS NOT NULL
       AND v_season_settings_id <> v_season_id THEN
        RAISE EXCEPTION 'season_id must match season_settings_id for game persistence'
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

    IF NOT public.is_org_admin(v_org_id) THEN
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

    v_created_by := auth.uid();

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
        'game',
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
            COALESCE(
                NULLIF(value->>'home_team_id', '')::uuid,
                NULLIF(value->>'homeTeamId', '')::uuid
            ) AS home_team_id,
            COALESCE(
                NULLIF(value->>'away_team_id', '')::uuid,
                NULLIF(value->>'awayTeamId', '')::uuid
            ) AS away_team_id,
            COALESCE(
                NULLIF(value->>'game_slot_id', '')::uuid,
                NULLIF(value->>'gameSlotId', '')::uuid,
                NULLIF(value->>'slot_id', '')::uuid,
                NULLIF(value->>'slotId', '')::uuid
            ) AS game_slot_id,
            COALESCE(
                NULLIF(value->>'field_id', '')::uuid,
                NULLIF(value->>'fieldId', '')::uuid
            ) AS field_id,
            COALESCE(NULLIF(value->>'division', ''), NULLIF(value->>'division_name', '')) AS division,
            COALESCE(NULLIF(value->>'week_index', '')::integer, NULLIF(value->>'weekIndex', '')::integer) AS week_index,
            COALESCE(NULLIF(value->>'start', '')::timestamptz, NULLIF(value->>'kickoff', '')::timestamptz) AS start_at,
            NULLIF(value->>'end', '')::timestamptz AS end_at,
            CASE
                WHEN lower(COALESCE(NULLIF(value->>'assignment_source', ''), NULLIF(value->>'source', ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(value->>'assignment_source', ''), NULLIF(value->>'source', ''), 'auto'))
            END AS assignment_source
        FROM jsonb_array_elements(assignments) AS assignment_items(value)
    )
    SELECT
        count(*) FILTER (WHERE home_team_id IS NULL),
        count(*) FILTER (WHERE away_team_id IS NULL),
        count(*) FILTER (WHERE game_slot_id IS NULL),
        count(*) FILTER (WHERE week_index IS NULL),
        count(*) FILTER (WHERE start_at IS NULL),
        count(*) FILTER (WHERE end_at IS NULL),
        count(*) FILTER (WHERE home_team_id = away_team_id),
        count(*) FILTER (WHERE end_at <= start_at),
        count(*) FILTER (WHERE assignment_source NOT IN ('auto', 'manual')),
        count(*) FILTER (WHERE week_index IS NOT NULL AND week_index <= 0)
      INTO
        v_missing_home_count,
        v_missing_away_count,
        v_missing_slot_count,
        v_missing_week_count,
        v_missing_start_count,
        v_missing_end_count,
        v_same_team_count,
        v_invalid_time_count,
        v_invalid_source_count,
        v_invalid_week_count
      FROM parsed_assignments;

    IF v_missing_home_count > 0 THEN
        RAISE EXCEPTION 'assignment home_team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_away_count > 0 THEN
        RAISE EXCEPTION 'assignment away_team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_slot_count > 0 THEN
        RAISE EXCEPTION 'assignment game_slot_id or slot_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_week_count > 0 THEN
        RAISE EXCEPTION 'assignment week_index is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_start_count > 0 OR v_missing_end_count > 0 THEN
        RAISE EXCEPTION 'assignment start and end are required'
            USING ERRCODE = '23502';
    END IF;

    IF v_same_team_count > 0 THEN
        RAISE EXCEPTION 'home_team_id and away_team_id must differ'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_time_count > 0 THEN
        RAISE EXCEPTION 'assignment end must be after start'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_source_count > 0 THEN
        RAISE EXCEPTION 'invalid game assignment source'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_week_count > 0 THEN
        RAISE EXCEPTION 'assignment week_index must be positive'
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_assignments AS MATERIALIZED (
        SELECT
            COALESCE(
                NULLIF(value->>'home_team_id', '')::uuid,
                NULLIF(value->>'homeTeamId', '')::uuid
            ) AS home_team_id,
            COALESCE(
                NULLIF(value->>'away_team_id', '')::uuid,
                NULLIF(value->>'awayTeamId', '')::uuid
            ) AS away_team_id,
            COALESCE(
                NULLIF(value->>'game_slot_id', '')::uuid,
                NULLIF(value->>'gameSlotId', '')::uuid,
                NULLIF(value->>'slot_id', '')::uuid,
                NULLIF(value->>'slotId', '')::uuid
            ) AS game_slot_id,
            COALESCE(
                NULLIF(value->>'field_id', '')::uuid,
                NULLIF(value->>'fieldId', '')::uuid
            ) AS field_id
        FROM jsonb_array_elements(assignments) AS assignment_items(value)
    ),
    validated_assignments AS (
        SELECT
            parsed_assignments.home_team_id,
            parsed_assignments.away_team_id,
            parsed_assignments.game_slot_id,
            parsed_assignments.field_id,
            home_team.id AS existing_home_team_id,
            home_team.organization_id AS home_team_org_id,
            away_team.id AS existing_away_team_id,
            away_team.organization_id AS away_team_org_id,
            game_slot.id AS existing_slot_id,
            game_slot.organization_id AS slot_org_id,
            requested_field.id AS existing_field_id,
            requested_field.organization_id AS field_org_id
        FROM parsed_assignments
        LEFT JOIN public.teams home_team
          ON home_team.id = parsed_assignments.home_team_id
        LEFT JOIN public.teams away_team
          ON away_team.id = parsed_assignments.away_team_id
        LEFT JOIN public.game_slots game_slot
          ON game_slot.id = parsed_assignments.game_slot_id
        LEFT JOIN public.fields requested_field
          ON requested_field.id = parsed_assignments.field_id
    )
    SELECT
        (SELECT home_team_id FROM validated_assignments WHERE existing_home_team_id IS NULL LIMIT 1),
        (SELECT away_team_id FROM validated_assignments WHERE existing_away_team_id IS NULL LIMIT 1),
        (SELECT game_slot_id FROM validated_assignments WHERE existing_slot_id IS NULL LIMIT 1),
        (SELECT field_id FROM validated_assignments WHERE field_id IS NOT NULL AND existing_field_id IS NULL LIMIT 1),
        (SELECT home_team_id FROM validated_assignments WHERE home_team_org_id <> v_org_id LIMIT 1),
        (SELECT away_team_id FROM validated_assignments WHERE away_team_org_id <> v_org_id LIMIT 1),
        (SELECT game_slot_id FROM validated_assignments WHERE slot_org_id <> v_org_id LIMIT 1),
        (SELECT field_id FROM validated_assignments WHERE field_id IS NOT NULL AND field_org_id <> v_org_id LIMIT 1)
      INTO
        v_missing_home_ref,
        v_missing_away_ref,
        v_missing_slot_ref,
        v_missing_field_ref,
        v_cross_home_ref,
        v_cross_away_ref,
        v_cross_slot_ref,
        v_cross_field_ref;

    IF v_missing_home_ref IS NOT NULL THEN
        RAISE EXCEPTION 'home team % does not exist', v_missing_home_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_missing_away_ref IS NOT NULL THEN
        RAISE EXCEPTION 'away team % does not exist', v_missing_away_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_missing_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'game slot % does not exist', v_missing_slot_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_missing_field_ref IS NOT NULL THEN
        RAISE EXCEPTION 'field % does not exist', v_missing_field_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_cross_home_ref IS NOT NULL THEN
        RAISE EXCEPTION 'home team % belongs to another organization', v_cross_home_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_cross_away_ref IS NOT NULL THEN
        RAISE EXCEPTION 'away team % belongs to another organization', v_cross_away_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_cross_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'game slot % belongs to another organization', v_cross_slot_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_cross_field_ref IS NOT NULL THEN
        RAISE EXCEPTION 'field % belongs to another organization', v_cross_field_ref
            USING ERRCODE = '42501';
    END IF;

    WITH parsed_assignments AS MATERIALIZED (
        SELECT
            assignment_items.ordinality AS assignment_ordinal,
            COALESCE(
                NULLIF(value->>'home_team_id', '')::uuid,
                NULLIF(value->>'homeTeamId', '')::uuid
            ) AS home_team_id,
            COALESCE(
                NULLIF(value->>'away_team_id', '')::uuid,
                NULLIF(value->>'awayTeamId', '')::uuid
            ) AS away_team_id,
            COALESCE(
                NULLIF(value->>'game_slot_id', '')::uuid,
                NULLIF(value->>'gameSlotId', '')::uuid,
                NULLIF(value->>'slot_id', '')::uuid,
                NULLIF(value->>'slotId', '')::uuid
            ) AS game_slot_id,
            COALESCE(
                NULLIF(value->>'field_id', '')::uuid,
                NULLIF(value->>'fieldId', '')::uuid
            ) AS field_id,
            COALESCE(NULLIF(value->>'division', ''), NULLIF(value->>'division_name', '')) AS division,
            COALESCE(NULLIF(value->>'week_index', '')::integer, NULLIF(value->>'weekIndex', '')::integer) AS week_index,
            COALESCE(NULLIF(value->>'start', '')::timestamptz, NULLIF(value->>'kickoff', '')::timestamptz) AS start_at,
            NULLIF(value->>'end', '')::timestamptz AS end_at,
            CASE
                WHEN lower(COALESCE(NULLIF(value->>'assignment_source', ''), NULLIF(value->>'source', ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(value->>'assignment_source', ''), NULLIF(value->>'source', ''), 'auto'))
            END AS assignment_source
        FROM jsonb_array_elements(assignments) WITH ORDINALITY AS assignment_items(value, ordinality)
    ),
    assignment_rows AS (
        SELECT
            parsed_assignments.assignment_ordinal,
            v_org_id AS organization_id,
            v_persisted_run_id AS run_id,
            parsed_assignments.game_slot_id,
            parsed_assignments.game_slot_id AS slot_id,
            COALESCE(parsed_assignments.field_id, game_slot.field_id) AS field_id,
            parsed_assignments.home_team_id,
            parsed_assignments.away_team_id,
            COALESCE(parsed_assignments.division, home_division.name, slot_division.name) AS division,
            parsed_assignments.week_index::smallint AS week_index,
            parsed_assignments.start_at AS start,
            parsed_assignments.end_at AS "end",
            parsed_assignments.assignment_source::public.source_enum AS assignment_source
        FROM parsed_assignments
        JOIN public.game_slots game_slot
          ON game_slot.id = parsed_assignments.game_slot_id
        JOIN public.teams home_team
          ON home_team.id = parsed_assignments.home_team_id
        JOIN public.teams away_team
          ON away_team.id = parsed_assignments.away_team_id
        LEFT JOIN public.divisions home_division
          ON home_division.id = home_team.division_id
        LEFT JOIN public.divisions slot_division
          ON slot_division.id = game_slot.division_id
    ),
    deduped_assignment_rows AS (
        SELECT DISTINCT ON (home_team_id, away_team_id, game_slot_id, week_index)
            organization_id,
            run_id,
            game_slot_id,
            slot_id,
            field_id,
            home_team_id,
            away_team_id,
            division,
            week_index,
            start,
            "end",
            assignment_source
        FROM assignment_rows
        ORDER BY
            home_team_id,
            away_team_id,
            game_slot_id,
            week_index,
            assignment_ordinal DESC
    )
    INSERT INTO public.game_assignments (
        organization_id,
        run_id,
        game_slot_id,
        slot_id,
        field_id,
        home_team_id,
        away_team_id,
        division,
        week_index,
        start,
        "end",
        assignment_source
    )
    SELECT
        organization_id,
        run_id,
        game_slot_id,
        slot_id,
        field_id,
        home_team_id,
        away_team_id,
        division,
        week_index,
        start,
        "end",
        assignment_source
    FROM deduped_assignment_rows
    ON CONFLICT (home_team_id, away_team_id, game_slot_id, week_index)
        WHERE home_team_id IS NOT NULL
          AND away_team_id IS NOT NULL
          AND game_slot_id IS NOT NULL
          AND week_index IS NOT NULL
    DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        run_id = EXCLUDED.run_id,
        slot_id = EXCLUDED.slot_id,
        field_id = EXCLUDED.field_id,
        division = EXCLUDED.division,
        start = EXCLUDED.start,
        "end" = EXCLUDED."end",
        assignment_source = EXCLUDED.assignment_source,
        updated_at = timezone('utc', now());

    -- 20261018070000: the audit row, in this transaction (plan section 3.1).
    -- A failed write rolls the whole save back; SLA01 tells the Edge Function
    -- it was the audit, and DETAIL keeps the original SQLSTATE. Every error is
    -- caught and every one is re-raised.
    BEGIN
        PERFORM public.record_audit_event(
            v_org_id, 'game.saved', 'scheduler_run', v_persisted_run_id,
            jsonb_build_object(
                'season_settings_id', COALESCE(v_season_settings_id, v_season_id),
                'game_count', jsonb_array_length(assignments)));
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    RETURN v_persisted_run_id;
END;
$$;

COMMIT;
