-- Migration: 20251206000000_team_persistence_rpc.sql
-- Description: Adds RPC for atomic team schedule persistence.

CREATE OR REPLACE FUNCTION persist_team_schedule(
    run_data jsonb,
    teams jsonb,
    team_players jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
    v_run_id uuid;
    v_teams_count int;
    v_players_count int;
BEGIN
    -- 1. Persist Scheduler Run
    INSERT INTO scheduler_runs (
        id,
        season_settings_id,
        run_type,
        status,
        parameters,
        metrics,
        results,
        started_at,
        completed_at,
        created_by
    )
    SELECT
        (run_data->>'id')::uuid,
        (run_data->>'season_settings_id')::bigint,
        run_data->>'run_type',
        run_data->>'status',
        run_data->'parameters',
        run_data->'metrics',
        run_data->'results',
        (run_data->>'started_at')::timestamptz,
        (run_data->>'completed_at')::timestamptz,
        (run_data->>'created_by')::uuid
    ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        results = EXCLUDED.results,
        completed_at = EXCLUDED.completed_at;

    v_run_id := (run_data->>'id')::uuid;

    -- 2. Upsert Teams
    IF jsonb_array_length(teams) > 0 THEN
        INSERT INTO teams (
            id,
            division_id,
            coach_id,
            name
        )
        SELECT
            t->>'id',
            t->>'division_id',
            t->>'coach_id',
            t->>'name'
        FROM jsonb_array_elements(teams) t
        ON CONFLICT (id) DO UPDATE SET
            division_id = EXCLUDED.division_id,
            coach_id = EXCLUDED.coach_id,
            name = EXCLUDED.name;
            
        GET DIAGNOSTICS v_teams_count = ROW_COUNT;
    ELSE
        v_teams_count := 0;
    END IF;

    -- 3. Upsert Team Players
    IF jsonb_array_length(team_players) > 0 THEN
        INSERT INTO team_players (
            team_id,
            player_id,
            role,
            source
        )
        SELECT
            (tp->>'team_id')::uuid,
            (tp->>'player_id')::uuid,
            COALESCE(tp->>'role', 'player'),
            COALESCE(tp->>'source', 'auto')::source_enum
        FROM jsonb_array_elements(team_players) tp
        ON CONFLICT (team_id, player_id) DO UPDATE SET
            role = EXCLUDED.role,
            source = EXCLUDED.source;

        GET DIAGNOSTICS v_players_count = ROW_COUNT;
    ELSE
        v_players_count := 0;
    END IF;

    RETURN jsonb_build_object(
        'status', 'success',
        'run_id', v_run_id,
        'updated_teams', v_teams_count,
        'updated_players', v_players_count
    );
END;
$$;
