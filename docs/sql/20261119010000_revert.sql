-- Revert for 20261119010000_game_published.sql
--
-- Drops the guard trigger and its function, the two RPCs, the partial index and the three columns, and puts the
-- three replaced functions back to the bodies the migrations before this one defined last: persist_game_schedule
-- from 20261108020000, admin_cancel_game_assignment from 20260613000003 and admin_delete_team from 20261112010000.
-- **Those texts are the repository's, not read from production** (lesson 87 reads production where it can; this change
-- did not): the end of this file checks each restored body against the md5 of the body a build of the migrations
-- before this one holds (carriage returns removed), so a typo here fails the revert instead of shipping.
--
-- **What it cannot restore: the flags.** Dropping `published`, `published_at` and `published_by` forgets which games
-- were Published and which had changes allowed; the NOTICE counts them. After the revert nothing guards a game
-- again. The `game.published_set` and `game.publish_overridden` audit actions stay registered (audit rows keep
-- pointing at them), and the audit rows themselves are kept. A revert never runs automatically (ci-cd.md).
--
-- Order matters: the trigger goes before the column it names, and the functions that name the column are replaced
-- before it goes (PL/pgSQL is not checked when a column is dropped).
--
-- Verified: the harness applies this on a database built up to the migration, with a Published game planted, and
-- reads the catalogue afterwards.

BEGIN;

DO $revert$
BEGIN
    RAISE NOTICE 'this revert drops the Published flag: % game(s) are Published and % have changes allowed; the flags, the published times and the actors are lost, and nothing guards a game afterwards (the audit rows stay)',
        (SELECT count(*) FROM public.game_assignments WHERE published),
        (SELECT count(*) FROM public.game_assignments WHERE NOT published AND published_at IS NOT NULL);
END;
$revert$;

DROP TRIGGER IF EXISTS game_assignments_published_guard ON public.game_assignments;
DROP FUNCTION IF EXISTS public.game_assignments_published_guard();
DROP FUNCTION IF EXISTS public.admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb);
DROP FUNCTION IF EXISTS public.get_schedule_audit_log(uuid, uuid, integer);

-- persist_game_schedule, as 20261108020000 defined it.
CREATE OR REPLACE FUNCTION public.persist_game_schedule(
    run_data jsonb,
    assignments jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
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
    -- 20261108020000: the TIME TBD list
    v_unscheduled jsonb;
    v_tbd_bad_shape integer;
    v_tbd_bad_teams integer;
    v_tbd_same_team integer;
    v_tbd_bad_reason integer;
    v_tbd_missing_team integer;
    v_tbd_other_org integer;
    v_tbd_other_season integer;
    v_tbd_games integer;
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

    v_started_at := COALESCE(NULLIF(run_data->>'started_at', '')::timestamptz, now());
    v_completed_at := COALESCE(NULLIF(run_data->>'completed_at', '')::timestamptz, now());

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
        updated_at = now()
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
        updated_at = now();

    -- 20261108020000: THE TIME TBD LIST FOR GAMES (Phase D, E). A run that found games it could
    -- not place says so in `results.unscheduled` (the scheduler's own list: week, division, the
    -- matchup's home and away team, the reason). When the save carries that list -- an array, even
    -- an empty one -- it REPLACES the season's recorded unscheduled games, so the master export
    -- prints each one as a TIME TBD row for both teams instead of leaving the game out. A save
    -- that carries no such list (a manual move, a rollback) changes nothing here. Every entry is
    -- checked: a week, two different teams of this season and organization, a reason on the closed
    -- list; one bad entry refuses the whole save (nothing is written).
    IF jsonb_typeof(run_data->'results'->'unscheduled') = 'array' THEN
        v_unscheduled := run_data->'results'->'unscheduled';
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_unscheduled) e
                    WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object') THEN
            RAISE EXCEPTION 'each unscheduled game must be a JSON object'
                USING ERRCODE = '22023';
        END IF;
        IF jsonb_array_length(v_unscheduled) > 0 AND v_season_id IS NULL THEN
            RAISE EXCEPTION 'season_settings_id is required to record unscheduled games'
                USING ERRCODE = '23502';
        END IF;
        IF v_season_id IS NOT NULL THEN
            WITH u AS (
            SELECT e.value AS j,
                   CASE WHEN e.value->>'weekIndex' ~ '^[0-9]{1,3}$' THEN (e.value->>'weekIndex')::integer END AS wk,
                   CASE WHEN e.value#>>'{matchup,homeTeamId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (e.value#>>'{matchup,homeTeamId}')::uuid END AS h,
                   CASE WHEN e.value#>>'{matchup,awayTeamId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (e.value#>>'{matchup,awayTeamId}')::uuid END AS a,
                   e.value->>'reason' AS reason,
                   NULLIF(btrim(COALESCE(e.value->>'division', '')), '') AS division
              FROM jsonb_array_elements(v_unscheduled) e
        )
            SELECT count(*) FILTER (WHERE u.wk IS NULL OR u.wk < 1 OR u.wk > 255),
                   count(*) FILTER (WHERE u.h IS NULL OR u.a IS NULL),
                   count(*) FILTER (WHERE u.h = u.a),
                   count(*) FILTER (WHERE u.reason IS NULL OR u.reason NOT IN (
                       'unknown-team', 'division-mismatch', 'duplicate-matchup',
                       'coach-coaches-both-teams', 'coach-scheduling-conflict', 'no-slot-available')),
                   count(*) FILTER (WHERE (u.h IS NOT NULL AND th.id IS NULL) OR (u.a IS NOT NULL AND ta.id IS NULL)),
                   count(*) FILTER (WHERE th.organization_id <> v_org_id OR ta.organization_id <> v_org_id),
                   count(*) FILTER (WHERE dh.season_settings_id <> v_season_id OR da.season_settings_id <> v_season_id)
              INTO v_tbd_bad_shape, v_tbd_bad_teams, v_tbd_same_team, v_tbd_bad_reason,
                   v_tbd_missing_team, v_tbd_other_org, v_tbd_other_season
              FROM u
              LEFT JOIN public.teams th ON th.id = u.h
              LEFT JOIN public.divisions dh ON dh.id = th.division_id
              LEFT JOIN public.teams ta ON ta.id = u.a
              LEFT JOIN public.divisions da ON da.id = ta.division_id;
            IF v_tbd_bad_shape > 0 THEN
                RAISE EXCEPTION 'every unscheduled game needs a weekIndex from 1 to 255 (% do not)', v_tbd_bad_shape
                    USING ERRCODE = '22023';
            END IF;
            IF v_tbd_bad_teams > 0 THEN
                RAISE EXCEPTION 'every unscheduled game needs matchup.homeTeamId and matchup.awayTeamId (% do not)', v_tbd_bad_teams
                    USING ERRCODE = '23502';
            END IF;
            IF v_tbd_same_team > 0 THEN
                RAISE EXCEPTION 'an unscheduled game''s home and away team must differ'
                    USING ERRCODE = '22023';
            END IF;
            IF v_tbd_bad_reason > 0 THEN
                RAISE EXCEPTION 'every unscheduled game needs a reason from the scheduler''s list (% do not)', v_tbd_bad_reason
                    USING ERRCODE = '22023';
            END IF;
            IF v_tbd_missing_team > 0 THEN
                RAISE EXCEPTION 'an unscheduled game names a team that does not exist (% such)', v_tbd_missing_team
                    USING ERRCODE = '23503';
            END IF;
            IF v_tbd_other_org > 0 THEN
                RAISE EXCEPTION 'an unscheduled game names a team of another organization'
                    USING ERRCODE = '42501';
            END IF;
            IF v_tbd_other_season > 0 THEN
                RAISE EXCEPTION 'an unscheduled game names a team that is not in season %', v_season_id
                    USING ERRCODE = '42501';
            END IF;

            DELETE FROM public.schedule_tbd s
             WHERE s.organization_id = v_org_id
               AND s.season_settings_id = v_season_id
               AND s.kind = 'game';
            WITH u AS (
            SELECT e.value AS j,
                   CASE WHEN e.value->>'weekIndex' ~ '^[0-9]{1,3}$' THEN (e.value->>'weekIndex')::integer END AS wk,
                   CASE WHEN e.value#>>'{matchup,homeTeamId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (e.value#>>'{matchup,homeTeamId}')::uuid END AS h,
                   CASE WHEN e.value#>>'{matchup,awayTeamId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (e.value#>>'{matchup,awayTeamId}')::uuid END AS a,
                   e.value->>'reason' AS reason,
                   NULLIF(btrim(COALESCE(e.value->>'division', '')), '') AS division
              FROM jsonb_array_elements(v_unscheduled) e
        )
            INSERT INTO public.schedule_tbd (
                organization_id, season_settings_id, kind, division_id,
                home_team_id, away_team_id, week_index, reason, detail, run_id
            )
            SELECT DISTINCT ON (u.h, u.a, u.wk)
                   v_org_id, v_season_id, 'game', th.division_id,
                   u.h, u.a, u.wk::smallint, u.reason,
                   jsonb_strip_nulls(jsonb_build_object('division', u.division)),
                   v_persisted_run_id
              FROM u
              JOIN public.teams th ON th.id = u.h
             ORDER BY u.h, u.a, u.wk, u.reason;
            SELECT count(*) INTO v_tbd_games
              FROM public.schedule_tbd s
             WHERE s.organization_id = v_org_id AND s.season_settings_id = v_season_id AND s.kind = 'game';
        END IF;
    END IF;

    -- 20261018070000: the audit row, in this transaction (plan section 3.1).
    -- A failed write rolls the whole save back; SLA01 tells the Edge Function
    -- it was the audit, and DETAIL keeps the original SQLSTATE. Every error is
    -- caught and every one is re-raised.
    BEGIN
        PERFORM public.record_audit_event(
            v_org_id, 'game.saved', 'scheduler_run', v_persisted_run_id,
            jsonb_build_object(
                'season_settings_id', COALESCE(v_season_settings_id, v_season_id),
                'game_count', jsonb_array_length(assignments))
            || CASE WHEN v_tbd_games IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('unscheduled_count', v_tbd_games) END);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    RETURN v_persisted_run_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_game_schedule(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_game_schedule(jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.persist_game_schedule(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.persist_game_schedule(jsonb, jsonb) TO service_role;

-- admin_cancel_game_assignment, as 20260613000003 defined it.
CREATE OR REPLACE FUNCTION public.admin_cancel_game_assignment(p_assignment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id uuid;
BEGIN
    SELECT organization_id INTO v_org_id
    FROM public.game_assignments WHERE id = p_assignment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'game assignment % not found', p_assignment_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.game_assignments WHERE id = p_assignment_id;

    PERFORM public.record_audit_event(
        v_org_id,
        'game.cancelled',
        'game_assignments',
        p_assignment_id,
        jsonb_build_object('assignment_id', p_assignment_id)
    );
END;
$$;

-- admin_delete_team, as 20261112010000 defined it.
CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_team public.teams%ROWTYPE;
    v_uid uuid := auth.uid();
    v_pa record;
    v_row jsonb;
    v_withdrawn jsonb;
    v_archived jsonb;
    v_game_ids uuid[];
    v_player_ids uuid[];
    v_counts jsonb;
BEGIN
    SELECT * INTO v_team FROM public.teams WHERE id = p_team_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'team % not found', p_team_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_team.organization_id) THEN
        -- Production's own text, which names no organisation to a caller
        -- outside it.
        RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
    END IF;

    -- 2. The practice series, as admin_cancel_practice_assignment does each.
    --    An exception is the team's if it is on one of the team's series or
    --    names the team: the team_id cascade would remove either.
    WITH w AS (
        UPDATE public.practice_exceptions pe
           SET withdrawn_at = now(),
               withdrawn_by = v_uid
         WHERE (pe.team_id = p_team_id
                OR pe.assignment_id IN (SELECT pa.id FROM public.practice_assignments pa
                                         WHERE pa.team_id = p_team_id))
           AND pe.withdrawn_at IS NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(w.*) ORDER BY w.id), '[]'::jsonb)
      INTO v_withdrawn
      FROM w;
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_withdrawn) LOOP
        PERFORM public.record_audit_event(
            v_team.organization_id,
            'practice.exception_withdrawn',
            'practice_exception',
            (v_row->>'id')::uuid,
            jsonb_build_object('reason', 'team_deleted', 'team_id', p_team_id,
                               'assignment_id', v_row->'assignment_id', 'row', v_row)
        );
    END LOOP;

    WITH gone AS (
        DELETE FROM public.practice_exceptions pe
         WHERE pe.team_id = p_team_id
            OR pe.assignment_id IN (SELECT pa.id FROM public.practice_assignments pa
                                     WHERE pa.team_id = p_team_id)
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

    v_counts := jsonb_build_object(
        'practice_exceptions_deleted', jsonb_array_length(v_archived),
        'practice_assignments_deleted',
            (SELECT count(*) FROM public.practice_assignments WHERE team_id = p_team_id)
    );
    FOR v_pa IN
        SELECT pa.id, to_jsonb(pa.*) AS before
          FROM public.practice_assignments pa
         WHERE pa.team_id = p_team_id
         ORDER BY pa.id
    LOOP
        DELETE FROM public.practice_assignments WHERE id = v_pa.id;
        PERFORM public.record_audit_event(
            v_team.organization_id,
            'practice.cancelled',
            'practice_assignments',
            v_pa.id,
            jsonb_build_object(
                'reason', 'team_deleted',
                'team_id', p_team_id,
                'assignment_id', v_pa.id,
                'before', v_pa.before,
                'withdrawn_exception_ids',
                    (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                       FROM jsonb_array_elements(v_withdrawn) e
                      WHERE (e.value->>'assignment_id')::uuid = v_pa.id),
                'archived_exceptions',
                    (SELECT COALESCE(jsonb_agg(e.value), '[]'::jsonb)
                       FROM jsonb_array_elements(v_archived) e
                      WHERE (e.value->>'assignment_id')::uuid = v_pa.id)
            )
        );
    END LOOP;

    -- 3. The team's games, held until commit, so the game ids and count
    --    team.deleted records are the rows the cascade removes (a concurrent
    --    write cannot move a game off the team in between). 20261022030000:
    --    their RSVPs are gone with the table.
    SELECT COALESCE(array_agg(g.id ORDER BY g.id), ARRAY[]::uuid[])
      INTO v_game_ids
      FROM (SELECT id FROM public.games
             WHERE home_team_id = p_team_id OR away_team_id = p_team_id
             ORDER BY id
               FOR UPDATE) g;

    -- 4. Players assigned through players.team_id (no foreign key), then the team.
    SELECT COALESCE(array_agg(p.id ORDER BY p.id), ARRAY[]::uuid[])
      INTO v_player_ids
      FROM public.players p
     WHERE p.team_id = p_team_id;

    -- 5. What the cascade takes, counted before it runs.
    v_counts := v_counts || jsonb_build_object(
        'games_deleted', cardinality(v_game_ids),
        'game_assignments_deleted',
            (SELECT count(*) FROM public.game_assignments
              WHERE home_team_id = p_team_id OR away_team_id = p_team_id),
        'team_players_deleted',
            (SELECT count(*) FROM public.team_players WHERE team_id = p_team_id),
        'team_coach_assignments_deleted',
            (SELECT count(*) FROM public.team_coach_assignments WHERE team_id = p_team_id),
        'team_calendar_tokens_deleted',
            (SELECT count(*) FROM public.team_calendar_tokens WHERE team_id = p_team_id),
        -- 20261108020000: the TIME TBD rows the cascade takes (as practice team, or as either side of a game).
        'schedule_tbd_deleted',
            (SELECT count(*) FROM public.schedule_tbd
              WHERE team_id = p_team_id OR home_team_id = p_team_id OR away_team_id = p_team_id),
        -- 20261112010000: the practice preference rules the cascade takes.
        'coach_practice_preferences_deleted',
            (SELECT count(*) FROM public.coach_practice_preferences WHERE team_id = p_team_id)
    );

    UPDATE public.players SET team_id = NULL WHERE id = ANY (v_player_ids);
    DELETE FROM public.teams WHERE id = p_team_id;

    PERFORM public.record_audit_event(
        v_team.organization_id,
        'team.deleted',
        'teams',
        p_team_id,
        jsonb_build_object('name', v_team.name, 'division_id', v_team.division_id)
            || v_counts
            || jsonb_build_object(
                   'game_ids', to_jsonb(v_game_ids),
                   'player_ids_unassigned', to_jsonb(v_player_ids),
                   'withdrawn_exception_ids',
                       (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                          FROM jsonb_array_elements(v_withdrawn) e),
                   'archived_exceptions', v_archived)
    );
END;
$$;

DROP INDEX IF EXISTS public.idx_game_assignments_org_published;
ALTER TABLE public.game_assignments
    DROP COLUMN IF EXISTS published,
    DROP COLUMN IF EXISTS published_at,
    DROP COLUMN IF EXISTS published_by;

DO $revert$
DECLARE
    v_fn text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = 'public.game_assignments'::regclass AND NOT a.attisdropped
                  AND a.attname IN ('published', 'published_at', 'published_by')) THEN
        RAISE EXCEPTION 'a published column is still there';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_published_guard') THEN
        RAISE EXCEPTION 'the guard trigger is still there';
    END IF;
    IF to_regprocedure('public.game_assignments_published_guard()') IS NOT NULL
       OR to_regprocedure('public.admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb)') IS NOT NULL
       OR to_regprocedure('public.get_schedule_audit_log(uuid, uuid, integer)') IS NOT NULL THEN
        RAISE EXCEPTION 'a function of the migration is still there';
    END IF;
    IF (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb, jsonb)'::regprocedure) IS DISTINCT FROM '2bb109b2c15535f579d8ccb5c18a69db'
       OR (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_proc p WHERE p.oid = 'public.admin_cancel_game_assignment(uuid)'::regprocedure) IS DISTINCT FROM 'ba4d10554f88d1fd881013cebbe22789'
       OR (SELECT md5(replace(p.prosrc, E'\r', '')) FROM pg_proc p WHERE p.oid = 'public.admin_delete_team(uuid)'::regprocedure) IS DISTINCT FROM '6ee194be26cf4214755a76cfe81637e6' THEN
        RAISE EXCEPTION 'a restored function body is not the one the migrations before 20261119010000 define';
    END IF;
    FOREACH v_fn IN ARRAY ARRAY['persist_game_schedule(jsonb, jsonb)', 'admin_cancel_game_assignment(uuid)', 'admin_delete_team(uuid)'] LOOP
        IF NOT (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn))
           OR NOT has_function_privilege('authenticated', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR has_function_privilege('anon', to_regprocedure('public.' || v_fn), 'EXECUTE') THEN
            RAISE EXCEPTION '% lost its posture', v_fn;
        END IF;
    END LOOP;
    IF NOT (SELECT p.proconfig @> ARRAY['TimeZone=UTC'] FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb, jsonb)'::regprocedure) THEN
        RAISE EXCEPTION 'persist_game_schedule lost its UTC pin';
    END IF;
    RAISE NOTICE 'revert verified: the three functions are the bodies before 20261119010000 (by md5), the flag, its trigger, index and RPCs are gone';
END;
$revert$;

COMMIT;
