-- A game keeps its id: in-place saves, the season on the game, and one held predicate (F11-1).
--
-- Plan of record: docs/changes/2026-11-06-games-table-source-of-truth.md, "Identity (F11-1)" and task A1; the owner
-- approved it on 2026-11-07 (D2 a: the saved game's row id is the game, and a save updates it in place; D6 a: the
-- season lives on the game). AGENTS.md rule 14 applies (persistence and the domain model); nothing in the solver changes.
--
-- ## Why
--
-- `persist_game_schedule` keyed its upsert on the matchup tuple (home, away, slot, week) and never read the `id` the
-- Edge function already passes through. A game moved to another slot or week was therefore a NEW row with a new id, and
-- the old row stayed behind in an older run. Everything keyed by `game_assignments.id` (the Published flag, its audit
-- history, and the score, Game ID and report history that come next) was lost at the first move (lesson 95).
--
-- ## What this changes
--
--   * `game_assignments.season_settings_id` (a foreign key to `season_settings`, ON DELETE SET NULL, indexed), set by
--     the save from the run's season. NULL for a row saved before this migration (production holds none: 0 rows in
--     game_assignments, game_slots, games, teams and players on 2026-11-06), and for a save that names no season. It is
--     not NOT NULL because a season-less save exists and the pgTAP fixtures insert games directly; the writers that come
--     next (the import, scores) set it, and a later migration can require it.
--   * A unique index on (id, organization_id, home_team_id, away_team_id): the key the score table of F11-2 will
--     reference, so a game's sides cannot change under a score. `id` is the primary key, so the index can never refuse
--     a row; it exists to be referenced.
--   * `game_held_ids(uuid[])` and `game_is_held(uuid)`: the ONE predicate "this game is held where it is". Today a
--     game is held when it is Published; F11-2 replaces one body to add "has a score". STABLE, SECURITY INVOKER, pinned
--     `SET search_path = public`, and internal: closed to PUBLIC, anon and authenticated (the definer functions and the
--     trigger below call them as their owner). `game_is_held(NULL)` is false, never NULL.
--   * The guard trigger asks the predicate. It is re-created without its `WHEN (OLD.published)`, so it fires for every
--     row and asks `game_is_held(OLD.id)`; cancel (`admin_cancel_game_assignment`), delete team (`admin_delete_team`) and
--     the omission check of the save ask it too. `admin_set_games_published` does not: it sets the very flag the
--     predicate reads. Every refusal, code and DETAIL is as 20261119010000 made it.
--   * `persist_game_schedule` updates a game IN PLACE when an assignment names it by `id`. Validated in this order, each
--     refusal writing nothing: an id is a uuid (22023 `game_identity_invalid`); each game is named once (22023
--     `game_identity_repeated`); each id is a game of THIS organization (23503 `game_not_found`, in the same words for
--     an id that does not exist and one that belongs to another organization, so an admin cannot probe another tenant);
--     the rows are locked in id order after the organization's lock; no two games end the save at one place, and no
--     game ends where a stored game the save does not name by id already is (22023 `game_identity_conflict`, DETAIL
--     `game_identity_conflict ids=<first>,<second>`, the second absent when the other game is a new one of the same
--     save). A game of a completed season, and a held game that would change, are refused by the triggers on the row
--     (22023 `season_completed`, 22023 `game_published`). An assignment WITHOUT an id is upserted on the tuple exactly
--     as before. Nothing is deleted by a save. Two games that swap places in one save work: the unique index is not
--     deferrable, so a game whose place another is about to take steps out of it first. The omission check counts a
--     game present if its id OR its tuple is in the payload.
--
-- ## Cost, said plainly
--
-- Four functions are replaced WHOLE (a migration cannot patch a function), so every mutation plant aimed at their
-- bodies in 20261119010000 has to follow (lesson 70): re-aimed in scripts/dbharness/prove.sh in this PR. Each body is
-- copied from 20261119010000, which no later migration replaces, with only the lines named in the section headers
-- changed. They were NOT read from production (lesson 87 reads production where it can; this change did not).
--
-- Reversible: docs/sql/20261120010000_revert.sql puts the four bodies and the trigger back and drops the two predicate
-- functions and the two indexes; the season column stays (nullable, harmless). Rows already updated in place keep working
-- under the old save, which upserts on the tuple. Smoke: docs/sql/20261120010000_smoke.sql. pgTAP:
-- supabase/tests/game_identity.sql; supabase/tests/game_persistence_rpc.sql and game_published.sql stay as they are.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The season on the game, and the key a score will reference.
-- ---------------------------------------------------------------------------

ALTER TABLE public.game_assignments
    ADD COLUMN IF NOT EXISTS season_settings_id uuid REFERENCES public.season_settings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_game_assignments_season_settings_id
    ON public.game_assignments (season_settings_id);

CREATE UNIQUE INDEX IF NOT EXISTS game_assignments_id_org_teams_key
    ON public.game_assignments (id, organization_id, home_team_id, away_team_id);

-- ---------------------------------------------------------------------------
-- 2. The one predicate: this game is held where it is.
-- ---------------------------------------------------------------------------
--
-- The set form is the definition; the single form asks it, so there is one body to change. Today: Published. F11-2
-- replaces `game_held_ids` to add "has a score", and every path that asks follows.

CREATE FUNCTION public.game_held_ids(p_game_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT ga.id
      FROM public.game_assignments ga
     WHERE ga.id = ANY (p_game_ids)
       AND ga.published
$$;

CREATE FUNCTION public.game_is_held(p_game_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT p_game_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.game_held_ids(ARRAY[p_game_id]))
$$;

REVOKE ALL ON FUNCTION public.game_held_ids(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.game_is_held(uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.game_held_ids(uuid[]) IS
    'Internal: the ids, among those given, of games held where they are (today: Published; F11-2 adds a score). The one definition of "held": the guard trigger, cancel, delete team and the omission check of the game save ask it. 20261120010000.';
COMMENT ON FUNCTION public.game_is_held(uuid) IS
    'Internal: whether one game is held where it is (false for an unknown or NULL id). Asks game_held_ids. 20261120010000.';

-- ---------------------------------------------------------------------------
-- 3. The guard asks the predicate.
-- ---------------------------------------------------------------------------
--
-- Copied whole from 20261119010000. Added: the question. The trigger is re-created without its WHEN clause
-- (a trigger cannot ask a function about a second reason to hold a game unless it fires for the row), which
-- costs a primary-key lookup per updated or deleted row and nothing else.

CREATE OR REPLACE FUNCTION public.game_assignments_published_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    -- A job with no signed-in user: the retention job, the demo purge, the service role.
    IF auth.uid() IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    -- 20261120010000: THE ONE PREDICATE. A row is guarded when `game_is_held` says it is, asked of the row as the
    -- statement found it (so clearing the flag and moving in one statement is still refused). The trigger used to
    -- fire only for rows already flagged Published, which a second reason to hold a game (a score, F11-2) could not
    -- change.
    IF NOT public.game_is_held(OLD.id) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'DELETE' THEN
        -- The cascade of a deleted organization: the organization is already gone, so its games go with it.
        IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = OLD.organization_id) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'Game % is Published and cannot be deleted: allow changes to it first', OLD.id
            USING ERRCODE = '22023', DETAIL = 'game_published';
    END IF;
    -- An UPDATE of a Published row: only a change to where, when or who plays is refused.
    IF (NEW.game_slot_id, NEW.slot_id, NEW.field_id, NEW.home_team_id, NEW.away_team_id, NEW.week_index, NEW.start, NEW."end")
       IS NOT DISTINCT FROM
       (OLD.game_slot_id, OLD.slot_id, OLD.field_id, OLD.home_team_id, OLD.away_team_id, OLD.week_index, OLD.start, OLD."end") THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Game % is Published and cannot be moved: allow changes to it first', OLD.id
        USING ERRCODE = '22023', DETAIL = 'game_published';
END;
$$;

DROP TRIGGER IF EXISTS game_assignments_published_guard ON public.game_assignments;
CREATE TRIGGER game_assignments_published_guard
    BEFORE UPDATE OR DELETE ON public.game_assignments
    FOR EACH ROW
    EXECUTE FUNCTION public.game_assignments_published_guard();

COMMENT ON FUNCTION public.game_assignments_published_guard() IS
    'Trigger function on game_assignments: a signed-in caller cannot delete a held game (game_is_held) or change its slot, field, teams, week, start or end (22023, game_published). Callers with no signed-in user and the cascade of a deleted organization pass. 20261119010000, asks game_is_held since 20261120010000.';

-- ---------------------------------------------------------------------------
-- 4. persist_game_schedule: a save updates a game in place by its id.
-- ---------------------------------------------------------------------------
--
-- Copied whole from 20261119010000 (its latest body, found by search: no later migration replaces it). Changed, and
-- nothing else: the payload is resolved once into `v_resolved`; the ids a payload names are checked (shape, repeats,
-- existence in the organization, row locks, clashes); the omission check counts a game present by its id OR its tuple
-- and asks `game_held_ids`; the writes are an update of the named games (a game whose place another is about to take
-- steps out of the unique index first, so a swap works), then the upsert of the rest, as before; both set the season.

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
    -- 20261119010000: the Published games a save leaves out
    v_omitted_count integer;
    v_omitted_ids uuid[];
    -- 20261120010000: IDENTITY (the payload as it will be stored; the games it names by id; a clash)
    v_resolved jsonb;
    v_bad_id text;
    v_dup_id uuid;
    v_missing_id uuid;
    v_named integer;
    v_locked integer;
    v_clash_first uuid;
    v_clash_second uuid;
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

    -- 20261119010000: SERIALIZED WITH THE SWITCH. The omission check below reads `published`, and
    -- admin_set_games_published locks only the rows it changes, which a save never touches when it leaves a game out:
    -- without a shared lock a publish and a save that omits that game could both commit, and the game would be
    -- Published and absent from the new run (reproduced with two sessions, Codex on #707). Both take this one lock,
    -- per organization, as their FIRST lock and hold it to the end of the transaction, so the second waits for the
    -- first and its next statement sees the first's commit (READ COMMITTED). Lock order everywhere: this advisory
    -- lock, then rows (the switch in id order, the save as its upsert goes). The guard trigger takes no lock, and
    -- cancel and delete team take none of this one: a publish racing them meets the trigger, which judges the
    -- latest committed row.
    PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || v_org_id::text, 0));

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

    -- 20261120010000: an assignment may name a saved game by `id`, and that id is a uuid. An absent id, a JSON null and
    -- an empty string are no id (as every other id in this payload reads them); anything else that is not a uuid is
    -- refused by name rather than by a cast error. The page's staged-game placeholders are not uuids and are never sent.
    SELECT left(e.value ->> 'id', 60)
      INTO v_bad_id
      FROM jsonb_array_elements(assignments) WITH ORDINALITY AS e(value, ord)
     WHERE e.value ? 'id'
       AND jsonb_typeof(e.value -> 'id') <> 'null'
       AND NOT (jsonb_typeof(e.value -> 'id') = 'string'
                AND (e.value ->> 'id' = ''
                     OR e.value ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
     ORDER BY e.ord
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'assignment id "%" is not a game id (a uuid)', v_bad_id
            USING ERRCODE = '22023', DETAIL = 'game_identity_invalid';
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

    -- 20261120010000: THE PAYLOAD AS IT WILL BE STORED, resolved once. Each assignment becomes the row a save writes
    -- (its organization and run, its slot's field when it names none, its division label, its source), as the
    -- insert below used to resolve it in place; the identity checks, the in-place update and the upsert all read this
    -- one list, so they cannot disagree about what a row is. `id` is the saved game the assignment continues, or NULL.
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.assignment_ordinal), '[]'::jsonb)
      INTO v_resolved
      FROM (
            WITH parsed_assignments AS MATERIALIZED (
                SELECT
                    assignment_items.ordinality AS assignment_ordinal,
                    NULLIF(value->>'id', '')::uuid AS id,
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
                    parsed_assignments.id,
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
            )
                SELECT * FROM assignment_rows
      ) r;

    -- IDENTITY (plan docs/changes/2026-11-06-games-table-source-of-truth.md, I1). A game is its row's id, and a save
    -- that names a game by id updates THAT row in place: a move, a flip or a carry keeps the id (the Published flag,
    -- the history, a score, a Game ID are all keyed by it), and leaves no row behind. An assignment without an id is
    -- upserted on the matchup tuple (home, away, slot, week) exactly as it always was. The id is the page's proposal
    -- (lesson 53): it is checked here, in this order, and a refusal writes nothing.
    --   1. an id is a uuid (above), and each game is named once;
    --   2. each id is a game of THIS organization, and an id of another organization reads exactly as one that does not
    --      exist (the words of admin_set_games_published, lesson 95): an admin learns nothing of another tenant's games;
    --   3. the rows are locked FOR UPDATE in id order, after the organization's lock and before any is written;
    --   4. no two games end the save at one place: an in-place update whose new tuple is another row's tuple is
    --      refused, both ids named, because the unique index would otherwise refuse it with a message that names no
    --      game, or (for a row without an id) merge two games into one without a word;
    --   5. a game of a completed season, and a held game that would change, are refused by the triggers on the row.
    SELECT x.id
      INTO v_dup_id
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid)
     WHERE x.id IS NOT NULL
     GROUP BY x.id
    HAVING count(*) > 1
     ORDER BY x.id
     LIMIT 1;
    IF v_dup_id IS NOT NULL THEN
        RAISE EXCEPTION 'game % is named more than once in this save', v_dup_id
            USING ERRCODE = '22023', DETAIL = 'game_identity_repeated';
    END IF;

    SELECT x.id
      INTO v_missing_id
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid)
     WHERE x.id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga
                        WHERE ga.id = x.id AND ga.organization_id = v_org_id)
     ORDER BY x.id
     LIMIT 1;
    IF v_missing_id IS NOT NULL THEN
        RAISE EXCEPTION 'game % does not exist in this organization', v_missing_id
            USING ERRCODE = '23503', DETAIL = 'game_not_found';
    END IF;

    SELECT count(*) INTO v_named
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid)
     WHERE x.id IS NOT NULL;
    SELECT count(*) INTO v_locked
      FROM (SELECT ga.id
              FROM public.game_assignments ga
             WHERE ga.organization_id = v_org_id
               AND ga.id IN (SELECT y.id
                               FROM jsonb_to_recordset(v_resolved) AS y(id uuid)
                              WHERE y.id IS NOT NULL)
             ORDER BY ga.id
               FOR UPDATE) l;
    IF v_locked <> v_named THEN
        RAISE EXCEPTION 'a game was removed while this save was being checked: nothing was saved, try again'
            USING ERRCODE = '40001';
    END IF;

    WITH i AS (
        SELECT x.id, x.home_team_id, x.away_team_id, x.game_slot_id, x.week_index
          FROM jsonb_to_recordset(v_resolved) AS x(id uuid, home_team_id uuid, away_team_id uuid, game_slot_id uuid, week_index smallint)
         WHERE x.id IS NOT NULL
    ),
    n AS (
        SELECT x.home_team_id, x.away_team_id, x.game_slot_id, x.week_index
          FROM jsonb_to_recordset(v_resolved) AS x(id uuid, home_team_id uuid, away_team_id uuid, game_slot_id uuid, week_index smallint)
         WHERE x.id IS NULL
    ),
    clashes AS (
        -- two games of this save ending at one place
        SELECT a.id AS first_id, b.id AS second_id
          FROM i a
          JOIN i b ON a.id < b.id
                  AND (a.home_team_id, a.away_team_id, a.game_slot_id, a.week_index)
                    = (b.home_team_id, b.away_team_id, b.game_slot_id, b.week_index)
        UNION ALL
        -- a game of this save ending where a stored game the save does not name by id already is (an older row of the
        -- same pair at the same place that no run shows any more, or the row a game without an id would be upserted onto)
        SELECT a.id, ga.id
          FROM i a
          JOIN public.game_assignments ga
            ON (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
             = (a.home_team_id, a.away_team_id, a.game_slot_id, a.week_index)
           AND ga.id <> a.id
         WHERE NOT EXISTS (SELECT 1 FROM i WHERE i.id = ga.id)
        UNION ALL
        -- a game of this save ending where a new game of this save (an assignment without an id) is sent
        SELECT a.id, NULL::uuid
          FROM i a
          JOIN n ON (n.home_team_id, n.away_team_id, n.game_slot_id, n.week_index)
                  = (a.home_team_id, a.away_team_id, a.game_slot_id, a.week_index)
    )
    SELECT c.first_id, c.second_id
      INTO v_clash_first, v_clash_second
      FROM clashes c
     ORDER BY c.first_id, c.second_id NULLS LAST
     LIMIT 1;
    IF v_clash_first IS NOT NULL THEN
        RAISE EXCEPTION 'game % would end where % already is: one place holds one game of a pair (the unique matchup, slot and week)',
                v_clash_first, COALESCE(v_clash_second::text, 'a new game of this save')
            USING ERRCODE = '22023',
                  DETAIL = format('game_identity_conflict ids=%s', concat_ws(',', v_clash_first, v_clash_second));
    END IF;

    -- 20261119010000: A PUBLISHED GAME IS CARRIED, NEVER LEFT OUT. The save upserts and deletes nothing, so a game
    -- the payload leaves out is not removed: it is orphaned in an older run and vanishes from the page. A row
    -- trigger cannot see an absence, so the check is here: every HELD game of the season (of the organization,
    -- when the run names no season) that the payload does not carry refuses the whole save, and nothing is written.
    -- A payload that carries the game but moves it is refused by game_assignments_published_guard; one that carries it
    -- unchanged passes, and the update below reaches it.
    -- 20261120010000: a game is CARRIED if its id OR its matchup tuple (home, away, slot, week) is in the payload. A
    -- game named by its id at another place is present (the update then meets the guard, which says it is held and
    -- moved); one named at another place WITHOUT its id is another tuple, so the original is still an omission. HELD is
    -- not decided here: it is `game_held_ids`, the one predicate (Published today; a score later). The season of a
    -- game is its home team's division's, as the read-only trigger finds it (20261111010000).
    WITH payload AS (
        SELECT
            NULLIF(value->>'id', '')::uuid AS id,
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
            COALESCE(NULLIF(value->>'week_index', '')::integer, NULLIF(value->>'weekIndex', '')::integer) AS week_index
        FROM jsonb_array_elements(assignments) AS assignment_items(value)
    ),
    candidates AS (
        SELECT ga.id
          FROM public.game_assignments ga
          LEFT JOIN public.teams home_team ON home_team.id = ga.home_team_id
          LEFT JOIN public.divisions home_division ON home_division.id = home_team.division_id
          LEFT JOIN public.season_settings home_season ON home_season.id = home_division.season_settings_id
         WHERE ga.organization_id = v_org_id
           -- Only a game a save CAN carry is an omission: a complete key (a NULL part matches nothing, so such a game
           -- could never be carried and every season-less save would be refused for it), and a season that is not
           -- completed (a completed season is read-only: the save could not write its games and Allow changes
           -- cannot release them, so they would block every season-less save for good). The guard trigger still
           -- holds both kinds. (Code review, #707.)
           AND ga.home_team_id IS NOT NULL AND ga.away_team_id IS NOT NULL
           AND ga.game_slot_id IS NOT NULL AND ga.week_index IS NOT NULL
           AND home_season.status IS DISTINCT FROM 'completed'
           AND (v_season_id IS NULL OR home_division.season_settings_id = v_season_id)
           -- Two anti-joins and not one with an OR: an OR between the id and the tuple cannot be hashed, and a league of
           -- 2,400 games then compares every game with every row of the payload.
           AND NOT EXISTS (SELECT 1 FROM payload pl WHERE pl.id = ga.id)
           AND NOT EXISTS (SELECT 1
                             FROM payload pl
                            WHERE pl.home_team_id = ga.home_team_id
                              AND pl.away_team_id = ga.away_team_id
                              AND pl.game_slot_id = ga.game_slot_id
                              AND pl.week_index = ga.week_index)
    ),
    missing AS (
        SELECT h.id
          FROM public.game_held_ids(ARRAY(SELECT c.id FROM candidates c)) AS h(id)
    )
    SELECT count(*), COALESCE((array_agg(m.id ORDER BY m.id))[1:50], '{}'::uuid[])
      INTO v_omitted_count, v_omitted_ids
      FROM missing m;

    IF v_omitted_count > 0 THEN
        RAISE EXCEPTION 'this save leaves out % Published game(s): a save carries every Published game of its season, unchanged (allow changes to a game first to move or drop it)', v_omitted_count
            USING ERRCODE = '22023',
                  DETAIL = format('game_published_omitted count=%s ids=%s', v_omitted_count, array_to_string(v_omitted_ids, ','));
    END IF;

    -- 20261120010000: THE WRITES. Games named by id are updated in place; assignments without an id are upserted on the
    -- matchup tuple, as they always were. Nothing is deleted by a save.
    --
    -- First, room is made. The unique matchup index is not deferrable, so two games that swap places in one save would
    -- meet in it whichever is written first. A game whose current place another game of this save is about to take is
    -- taken out of the index (its slot set null for the length of this save) and given its final place by the
    -- update that follows, in this transaction. The clashes were refused above, so no game ends where another is.
    UPDATE public.game_assignments ga
       SET game_slot_id = NULL,
           slot_id = NULL
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid, home_team_id uuid, away_team_id uuid, game_slot_id uuid, week_index smallint)
     WHERE x.id IS NOT NULL
       AND ga.id = x.id
       AND (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
           IS DISTINCT FROM (x.home_team_id, x.away_team_id, x.game_slot_id, x.week_index)
       AND EXISTS (SELECT 1
                     FROM jsonb_to_recordset(v_resolved) AS y(id uuid, home_team_id uuid, away_team_id uuid, game_slot_id uuid, week_index smallint)
                    WHERE y.id IS NOT NULL
                      AND y.id <> ga.id
                      AND (y.home_team_id, y.away_team_id, y.game_slot_id, y.week_index)
                        = (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index));

    -- The games named by id: where they are, when, who plays, the run they now belong to and the season. Not the
    -- Published columns: whether a game is Published is the switch's to say.
    UPDATE public.game_assignments ga
       SET run_id = x.run_id,
           game_slot_id = x.game_slot_id,
           slot_id = x.slot_id,
           field_id = x.field_id,
           home_team_id = x.home_team_id,
           away_team_id = x.away_team_id,
           division = x.division,
           week_index = x.week_index,
           start = x."start",
           "end" = x."end",
           assignment_source = x.assignment_source,
           season_settings_id = COALESCE(v_season_id, ga.season_settings_id),
           updated_at = now()
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid, run_id uuid, game_slot_id uuid, slot_id uuid, field_id uuid, home_team_id uuid, away_team_id uuid, division text, week_index smallint, "start" timestamptz, "end" timestamptz, assignment_source public.source_enum)
     WHERE x.id IS NOT NULL
       AND ga.id = x.id;

    -- The assignments without an id: upserted on the matchup tuple. A season-less save leaves the stored season alone.
    WITH deduped_assignment_rows AS (
        SELECT DISTINCT ON (x.home_team_id, x.away_team_id, x.game_slot_id, x.week_index)
            x.organization_id,
            x.run_id,
            x.game_slot_id,
            x.slot_id,
            x.field_id,
            x.home_team_id,
            x.away_team_id,
            x.division,
            x.week_index,
            x."start" AS start,
            x."end" AS "end",
            x.assignment_source
        FROM jsonb_to_recordset(v_resolved) AS x(assignment_ordinal bigint, id uuid, organization_id uuid, run_id uuid, game_slot_id uuid, slot_id uuid, field_id uuid, home_team_id uuid, away_team_id uuid, division text, week_index smallint, "start" timestamptz, "end" timestamptz, assignment_source public.source_enum)
        WHERE x.id IS NULL
        ORDER BY
            x.home_team_id,
            x.away_team_id,
            x.game_slot_id,
            x.week_index,
            x.assignment_ordinal DESC
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
        assignment_source,
        season_settings_id
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
        assignment_source,
        v_season_id
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
        season_settings_id = COALESCE(EXCLUDED.season_settings_id, public.game_assignments.season_settings_id),
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

-- ---------------------------------------------------------------------------
-- 5. admin_cancel_game_assignment: a held game is not cancelled.
-- ---------------------------------------------------------------------------
--
-- Copied whole from 20261119010000. Changed: "held" is asked of game_is_held, not read from the column.

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

    -- 20261119010000: a Published game is cancelled only after changes to it are allowed (the guard trigger is the
    -- backstop for every other path). 20261120010000: "held" is asked of the one predicate.
    IF public.game_is_held(p_assignment_id) THEN
        RAISE EXCEPTION 'game % is Published and cannot be cancelled: allow changes to it first', p_assignment_id
            USING ERRCODE = '22023', DETAIL = 'game_published';
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

-- ---------------------------------------------------------------------------
-- 6. admin_delete_team: a team with a held game is not deleted.
-- ---------------------------------------------------------------------------
--
-- Copied whole from 20261119010000 (which copied 20261112010000, so the practice preference rules the cascade
-- takes are still counted). Changed: the count is of `game_held_ids` over the team's games.

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
    v_published_games integer;
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

    -- 20261119010000: a team with a Published game is deleted only after changes to its games are allowed. Said
    -- before anything is deleted, with the count (the guard trigger's refusal of the cascade is the backstop).
    -- 20261120010000: counted by the one predicate (`game_held_ids`), over the team's games on either side.
    SELECT count(*) INTO v_published_games
      FROM public.game_held_ids(ARRAY(SELECT ga.id
                                        FROM public.game_assignments ga
                                       WHERE ga.home_team_id = p_team_id OR ga.away_team_id = p_team_id));
    IF v_published_games > 0 THEN
        RAISE EXCEPTION 'team % has % Published game(s) and cannot be deleted: allow changes to them first', p_team_id, v_published_games
            USING ERRCODE = '22023', DETAIL = 'game_published';
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

-- ---------------------------------------------------------------------------
-- 7. The end state, or the migration does not commit.
-- ---------------------------------------------------------------------------
--
-- It changes no existing row: a fresh column is NULL and nothing is updated.

DO $check$
DECLARE
    v_fn text;
    v_src text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = 'public.game_assignments'::regclass AND a.attname = 'season_settings_id' AND NOT a.attisdropped
                      AND format_type(a.atttypid, a.atttypmod) = 'uuid' AND NOT a.attnotnull) THEN
        RAISE EXCEPTION 'game_assignments does not hold season_settings_id (uuid, nullable)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                    WHERE c.conrelid = 'public.game_assignments'::regclass AND c.contype = 'f'
                      AND c.confrelid = 'public.season_settings'::regclass AND c.confdeltype = 'n'
                      AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.game_assignments'::regclass AND a.attname = 'season_settings_id')]) THEN
        RAISE EXCEPTION 'season_settings_id is not a foreign key to season_settings ON DELETE SET NULL';
    END IF;
    -- IF NOT EXISTS compares the name only: read the shape of both indexes back.
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'game_assignments'
                    AND indexname = 'idx_game_assignments_season_settings_id'
                    AND indexdef ~ 'USING btree \(season_settings_id\)$') THEN
        RAISE EXCEPTION 'idx_game_assignments_season_settings_id is not a btree index on (season_settings_id)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'game_assignments'
                    AND indexname = 'game_assignments_id_org_teams_key'
                    AND indexdef ~ '^CREATE UNIQUE INDEX .* USING btree \(id, organization_id, home_team_id, away_team_id\)$') THEN
        RAISE EXCEPTION 'game_assignments_id_org_teams_key is not a unique index on (id, organization_id, home_team_id, away_team_id)';
    END IF;

    -- The guard: an enabled BEFORE UPDATE OR DELETE row trigger with NO WHEN clause (it asks the predicate for every row).
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_published_guard'
                      AND NOT t.tgisinternal AND t.tgenabled = 'O'
                      AND t.tgfoid = to_regprocedure('public.game_assignments_published_guard()')
                      AND pg_get_triggerdef(t.oid) ~ 'BEFORE (DELETE OR UPDATE|UPDATE OR DELETE) ON public.game_assignments FOR EACH ROW EXECUTE FUNCTION')
       OR (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_published_guard') <> 1 THEN
        RAISE EXCEPTION 'game_assignments_published_guard is not one enabled BEFORE UPDATE OR DELETE row trigger without a WHEN clause';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_readonly_when_completed'
                      AND NOT t.tgisinternal AND t.tgenabled = 'O') THEN
        RAISE EXCEPTION 'the completed-season trigger on game_assignments is gone';
    END IF;

    -- The predicate: STABLE invoker functions pinned to search_path, closed to every client role and to PUBLIC.
    FOREACH v_fn IN ARRAY ARRAY['game_held_ids(uuid[])', 'game_is_held(uuid)'] LOOP
        IF NOT (SELECT p.provolatile = 's' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                  FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn)) THEN
            RAISE EXCEPTION '% is not a STABLE invoker function pinned to search_path=public', v_fn;
        END IF;
        IF has_function_privilege('anon', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR has_function_privilege('authenticated', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE p.oid = to_regprocedure('public.' || v_fn) AND a.grantee = 0) THEN
            RAISE EXCEPTION '% is executable by a client role or PUBLIC', v_fn;
        END IF;
    END LOOP;

    -- Every function this migration replaced keeps the posture it had, and is not callable by anon or PUBLIC.
    FOREACH v_fn IN ARRAY ARRAY[
        'game_assignments_published_guard()',
        'persist_game_schedule(jsonb, jsonb)',
        'admin_cancel_game_assignment(uuid)',
        'admin_delete_team(uuid)'
    ] LOOP
        IF NOT (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn)) THEN
            RAISE EXCEPTION '% is not a definer function with a pinned search path', v_fn;
        END IF;
        IF has_function_privilege('anon', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE p.oid = to_regprocedure('public.' || v_fn) AND a.grantee = 0) THEN
            RAISE EXCEPTION '% is executable by anon or PUBLIC', v_fn;
        END IF;
        IF (v_fn <> 'game_assignments_published_guard()')
           IS DISTINCT FROM has_function_privilege('authenticated', to_regprocedure('public.' || v_fn), 'EXECUTE') THEN
            RAISE EXCEPTION '%: authenticated may execute it exactly when it is not the trigger function', v_fn;
        END IF;
    END LOOP;
    IF NOT (SELECT p.proconfig @> ARRAY['TimeZone=UTC'] FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb, jsonb)'::regprocedure)
       OR NOT (SELECT p.proconfig @> ARRAY['TimeZone=UTC'] FROM pg_proc p WHERE p.oid = 'public.game_assignments_published_guard()'::regprocedure) THEN
        RAISE EXCEPTION 'a function lost its UTC pin';
    END IF;

    -- Each replaced function was copied from the right body: it still holds what only that body holds, and the new
    -- lines are in it.
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb, jsonb)'::regprocedure;
    IF v_src !~ 'game_published_omitted' OR v_src !~ 'v_tbd_games' OR v_src !~ 'game\.saved' OR v_src !~ 'SLA01'
       OR v_src !~ 'game_identity_conflict' OR v_src !~ 'game_held_ids' OR v_src !~ 'pg_advisory_xact_lock' THEN
        RAISE EXCEPTION 'persist_game_schedule is not the 20261119010000 body plus the identity checks';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.admin_delete_team(uuid)'::regprocedure;
    IF v_src !~ 'game_published' OR v_src !~ 'coach_practice_preferences_deleted' OR v_src !~ 'schedule_tbd_deleted' OR v_src !~ 'game_held_ids' THEN
        RAISE EXCEPTION 'admin_delete_team is not the 20261119010000 body asking game_held_ids';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.admin_cancel_game_assignment(uuid)'::regprocedure;
    IF v_src !~ 'game_published' OR v_src !~ 'game\.cancelled' OR v_src !~ 'game_is_held' THEN
        RAISE EXCEPTION 'admin_cancel_game_assignment is not the 20261119010000 body asking game_is_held';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.game_assignments_published_guard()'::regprocedure;
    IF v_src !~ 'game_published' OR v_src !~ 'game_is_held' OR v_src ~ 'OLD\.published' THEN
        RAISE EXCEPTION 'the guard is not the 20261119010000 body asking game_is_held';
    END IF;
END;
$check$;

COMMIT;
