-- The Published switch on games: a per-game flag, a guard on every writer, an audited way to turn it off.
--
-- Plan of record: docs/changes/2026-11-03-schedule-expansion.md, sections 3.1 to 3.4 and PR 1 (A1). Owner answers of
-- 2026-11-06 bind it: any organization admin (staff included) may allow changes to a Published game, with a reason from
-- a closed list and an optional note of at most 200 characters (decision 1); both per game and in bulk, capped at 2,400
-- ids a call (decision 2); no auto-expiry (decision 11). Turning Published ON needs nothing. Turning it OFF is the
-- deliberate, audited, reversible act ("Allow changes"); no save, move or cancel ever does it as a side effect
-- (lesson 86).
--
-- ## What this changes
--
--   * `game_assignments` gains `published boolean NOT NULL DEFAULT false`, `published_at timestamptz` and
--     `published_by uuid` (an actor id; set null when the user goes), and a partial index on (organization_id) WHERE
--     published. The default makes this a no-op for every existing row: a league that never touches the switch behaves
--     exactly as before (lesson 94). `published_at` and `published_by` record the most recent time the flag was turned
--     ON and are KEPT when it is turned off, so "changes allowed" is `NOT published AND published_at IS NOT NULL`.
--   * `game_assignments_published_guard`, a BEFORE UPDATE OR DELETE row trigger judged on the OLD row (so clearing the
--     flag and moving in one statement is refused): for a signed-in caller, a Published row cannot be deleted (a team or
--     slot cascade included) and cannot have its `game_slot_id`, `slot_id`, `field_id`, `home_team_id`, `away_team_id`,
--     `week_index`, `start` or `"end"` changed. `run_id`, `assignment_source`, `division` (a label that follows a
--     division rename), `updated_at` and the `published*` columns stay writable; an unchanged value is not a change, so
--     carrying a row forward as it is passes. 22023, DETAIL `game_published`. No signed-in user passes (the retention
--     job, the demo purge, the service role) and so does the cascade of a deleted organization: the completed-season
--     trigger's two exemptions (20261111010000), copied by contract (lesson 56).
--   * `persist_game_schedule` (copied whole from 20261108020000, its latest body) refuses a save that OMITS a Published
--     game of its season (of the organization, when the run names no season): a row trigger cannot see an absence, and
--     the older run's rows would be orphaned and vanish from the page. 22023, DETAIL
--     `game_published_omitted count=<n> ids=<the first 50 ids, in id order>`. Nothing is written. A payload that moves a
--     Published row is refused by the trigger above.
--     **Identity, said plainly.** The save keys its upsert on the matchup tuple (home, away, slot, week) and never
--     writes or reads an `id` (its INSERT lists no id and its DO UPDATE does not touch one), so the omission check and
--     the guard work on that tuple too. A save that changes a Published row in place (same tuple, another field, start
--     or end) is refused by the trigger; a save that MOVES a game to another slot or week is a new tuple, hence a NEW
--     row with a new id, and the old row stays behind in its older run. Anything keyed by `game_assignments.id` (the
--     Published flag, its audit rows, a score) stays with the old row at a move. That is today's behaviour of the save,
--     not something this migration adds or fixes; an identity layer is a separate decision (the F11 plan).
--   * `admin_cancel_game_assignment` (copied whole from 20260613000003) and `admin_delete_team` (copied whole from
--     20261112010000, its latest body: it also counts the practice preference rules its cascade takes) refuse a
--     Published game with 22023 `game_published`, the second before anything is deleted and with the count; the
--     trigger stays the backstop.
--   * `admin_set_games_published(org, ids, published, reason, note, scope)` and `get_schedule_audit_log(org, game, limit)`.
--     The switch's gates, in order, each a test in supabase/tests/game_published.sql: a signed-in caller (42501
--     `signed_in_required`); `is_org_admin` (42501 `admin_required`); 1 to 2,400 distinct ids, all existing (23503
--     `game_not_found`) and all in the organization (42501 `game_other_organization`); the rows locked FOR UPDATE in id
--     order (lesson 64), where a completed season's rows are refused by the existing read-only trigger; turning OFF
--     needs a reason from `field-change`, `coach-request`, `conflict-fix`, `published-in-error`, `other` and takes an
--     optional note; turning ON takes neither; a game already at the value is `unchanged` and never audited. Audit, in
--     the same transaction (a failed write rolls the change back, SQLSTATE SLA01, as the save does):
--     `game.published_set`, one row per call (the way, the scope, the counts, the ids changed: at most 2,400, about
--     96 KB as text, measured by the pgTAP file), and `game.publish_overridden`, one row per game turned off with its
--     before-image, the reason, the note and the scope. The log read returns those two actions without the call rows'
--     `ids` (the per-game rows hold them) and with the actor's name, never a contact.
--
-- ## Words
--
-- "Published" here means: these games were told to families. It is not the Exports panel's "Published baseline"
-- (`publication_baselines`, untouched, still the evidence) and not a roster status. The user-facing words are
-- "Published" and "Allow changes"; "override" is kept for what the repository already calls an override.
--
-- ## Cost, said plainly
--
-- `persist_game_schedule` and `admin_delete_team` are replaced WHOLE (a migration cannot patch a function), so every
-- mutation plant aimed at their older bodies has to follow (lesson 70): re-aimed in scripts/dbharness/prove.sh in this
-- PR. `admin_cancel_game_assignment` is replaced whole too. The bodies are copied from the migrations that define them
-- last, found by search (lesson 87), with only the lines named below added; they were NOT read from production.
--
-- Reversible, with the data caveat that the flags are lost: docs/sql/20261119010000_revert.sql. The two audit actions
-- stay (audit rows keep pointing at them). Smoke: docs/sql/20261119010000_smoke.sql. pgTAP:
-- supabase/tests/game_published.sql. The catalogue snapshot gains the two functions, the trigger function and the trigger.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The two audit actions (the audit_log foreign key fails at runtime otherwise, lesson 5).
-- ---------------------------------------------------------------------------

INSERT INTO public.audit_actions (action) VALUES ('game.published_set')
    ON CONFLICT (action) DO NOTHING;
INSERT INTO public.audit_actions (action) VALUES ('game.publish_overridden')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The flag.
-- ---------------------------------------------------------------------------

ALTER TABLE public.game_assignments
    ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS published_at timestamptz,
    ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_game_assignments_org_published
    ON public.game_assignments (organization_id)
    WHERE published;

-- ---------------------------------------------------------------------------
-- 3. The guard.
-- ---------------------------------------------------------------------------
--
-- Named to sort before game_assignments_readonly_when_completed (20261111010000) and
-- game_assignments_set_timestamp; none of the three depends on the order. Turning the flag on or off touches only
-- columns this guard lets through, so it is the read-only trigger that refuses a toggle on a completed season's game
-- (the read-only rule wins over the flag). A move or a delete of a Published game there meets this guard first;
-- either way it is refused.

CREATE FUNCTION public.game_assignments_published_guard()
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

CREATE TRIGGER game_assignments_published_guard
    BEFORE UPDATE OR DELETE ON public.game_assignments
    FOR EACH ROW
    WHEN (OLD.published)
    EXECUTE FUNCTION public.game_assignments_published_guard();

REVOKE ALL ON FUNCTION public.game_assignments_published_guard() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.game_assignments_published_guard() IS
    'Trigger function on game_assignments: a signed-in caller cannot delete a Published row or change its slot, field, teams, week, start or end (22023, game_published). Callers with no signed-in user and the cascade of a deleted organization pass. 20261119010000.';

-- ---------------------------------------------------------------------------
-- 4. persist_game_schedule: a save carries every Published game of its season.
-- ---------------------------------------------------------------------------
--
-- Copied whole from 20261108020000 (its latest body, found by search, R19). Added: the two variables and the check
-- before the upsert. The pin is as that migration stated it.

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

    -- 20261119010000: A PUBLISHED GAME IS CARRIED, NEVER LEFT OUT. The save upserts and deletes nothing, so a game
    -- the payload leaves out is not removed: it is orphaned in an older run and vanishes from the page. A row
    -- trigger cannot see an absence, so the check is here: every Published game of the season (of the organization,
    -- when the run names no season) whose matchup key (home, away, slot, week) the payload does not carry refuses
    -- the whole save, and nothing is written. A payload that carries the key but moves the row is refused by
    -- game_assignments_published_guard; one that carries it unchanged passes, and the upsert below reaches it. The
    -- key is the matchup tuple because the upsert below is keyed on it and writes no id: a game moved to another slot or
    -- week is a new tuple, so the Published original counts as omitted here and its id is not carried over. The
    -- season of a game is its home team's division's, as the read-only trigger finds it (20261111010000).
    WITH payload AS (
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
            COALESCE(NULLIF(value->>'week_index', '')::integer, NULLIF(value->>'weekIndex', '')::integer) AS week_index
        FROM jsonb_array_elements(assignments) AS assignment_items(value)
    ),
    missing AS (
        SELECT ga.id
          FROM public.game_assignments ga
         WHERE ga.organization_id = v_org_id
           AND ga.published
           AND (v_season_id IS NULL
                OR EXISTS (SELECT 1
                             FROM public.teams home_team
                             JOIN public.divisions home_division ON home_division.id = home_team.division_id
                            WHERE home_team.id = ga.home_team_id
                              AND home_division.season_settings_id = v_season_id))
           AND NOT EXISTS (SELECT 1
                             FROM payload pl
                            WHERE pl.home_team_id = ga.home_team_id
                              AND pl.away_team_id = ga.away_team_id
                              AND pl.game_slot_id = ga.game_slot_id
                              AND pl.week_index = ga.week_index)
    )
    SELECT count(*), COALESCE((array_agg(m.id ORDER BY m.id))[1:50], '{}'::uuid[])
      INTO v_omitted_count, v_omitted_ids
      FROM missing m;

    IF v_omitted_count > 0 THEN
        RAISE EXCEPTION 'this save leaves out % Published game(s): a save carries every Published game of its season, unchanged (allow changes to a game first to move or drop it)', v_omitted_count
            USING ERRCODE = '22023',
                  DETAIL = format('game_published_omitted count=%s ids=%s', v_omitted_count, array_to_string(v_omitted_ids, ','));
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

-- ---------------------------------------------------------------------------
-- 5. admin_cancel_game_assignment: a Published game is not cancelled.
-- ---------------------------------------------------------------------------
--
-- Copied whole from 20260613000003 (its latest body). Added: `published` read with the organization, and the refusal.

CREATE OR REPLACE FUNCTION public.admin_cancel_game_assignment(p_assignment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id uuid;
    v_published boolean;
BEGIN
    SELECT organization_id, published INTO v_org_id, v_published
    FROM public.game_assignments WHERE id = p_assignment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'game assignment % not found', p_assignment_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- 20261119010000: a Published game is cancelled only after changes to it are allowed (the guard trigger is the
    -- backstop for every other path).
    IF v_published THEN
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
-- 6. admin_delete_team: a team with a Published game is not deleted.
-- ---------------------------------------------------------------------------
--
-- Copied whole from 20261112010000 (its LATEST body: not 20261108020000's, which lacks the practice preference rules
-- the cascade takes). Added: the variable and the check after the admin check.

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
    SELECT count(*) INTO v_published_games
      FROM public.game_assignments ga
     WHERE (ga.home_team_id = p_team_id OR ga.away_team_id = p_team_id)
       AND ga.published;
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
-- 7. The switch: turn Published on, or allow changes (off) with a reason.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.admin_set_games_published(
    p_organization_id uuid,
    p_assignment_ids uuid[],
    p_published boolean,
    p_reason_code text DEFAULT NULL,
    p_note text DEFAULT NULL,
    p_scope jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    -- The first four are exactly the grid override prompt's reasons (GRID_OVERRIDE_REASONS); a test holds them equal.
    c_reasons constant text[] := ARRAY['field-change', 'coach-request', 'conflict-fix', 'published-in-error', 'other'];
    c_kinds constant text[] := ARRAY['all', 'division', 'date', 'venue', 'selection'];
    c_max_ids constant integer := 2400;   -- the spreadsheet's own row limit
    v_uid uuid := auth.uid();
    v_ids uuid[];
    v_n integer;
    v_found integer;
    v_locked integer;
    v_bad uuid;
    v_reason text := NULLIF(btrim(COALESCE(p_reason_code, '')), '');
    v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
    v_scope jsonb;
    v_changed uuid[];
    v_unchanged integer;
    v_before jsonb;
    v_row record;
BEGIN
    -- Gate 1: a signed-in caller. The audit rows need an actor, so the service role has none to give.
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'admin_set_games_published needs a signed-in caller to audit the change'
            USING ERRCODE = '42501', DETAIL = 'signed_in_required';
    END IF;

    -- Gate 2: an organization admin (admin, tenant admin or staff). Said before anything about the ids.
    IF p_organization_id IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an administrator of the organization sets whether its games are Published'
            USING ERRCODE = '42501', DETAIL = 'admin_required';
    END IF;

    -- Gate 3: 1 to 2,400 distinct ids, all existing, all in the organization.
    IF p_assignment_ids IS NULL OR cardinality(p_assignment_ids) = 0 THEN
        RAISE EXCEPTION 'name at least one game'
            USING ERRCODE = '22023', DETAIL = 'ids_required';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(p_assignment_ids) AS x(id) WHERE x.id IS NULL) THEN
        RAISE EXCEPTION 'a game id cannot be null'
            USING ERRCODE = '22023', DETAIL = 'ids_invalid';
    END IF;
    SELECT array_agg(DISTINCT x.id ORDER BY x.id) INTO v_ids FROM unnest(p_assignment_ids) AS x(id);
    v_n := cardinality(v_ids);
    IF v_n > c_max_ids THEN
        RAISE EXCEPTION 'at most % games can be set in one call (% named)', c_max_ids, v_n
            USING ERRCODE = '22023', DETAIL = 'too_many_ids';
    END IF;
    SELECT count(*) INTO v_found FROM public.game_assignments ga WHERE ga.id = ANY (v_ids);
    IF v_found < v_n THEN
        SELECT x.id INTO v_bad FROM unnest(v_ids) AS x(id)
         WHERE NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.id = x.id)
         ORDER BY x.id LIMIT 1;
        RAISE EXCEPTION 'game % does not exist', v_bad
            USING ERRCODE = '23503', DETAIL = 'game_not_found';
    END IF;
    SELECT ga.id INTO v_bad FROM public.game_assignments ga
     WHERE ga.id = ANY (v_ids) AND ga.organization_id <> p_organization_id
     ORDER BY ga.id LIMIT 1;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'game % belongs to another organization', v_bad
            USING ERRCODE = '42501', DETAIL = 'game_other_organization';
    END IF;

    -- Gate 5, said before the rows are locked (it reads nothing from them): which way, the reason, the note, the scope.
    IF p_published IS NULL THEN
        RAISE EXCEPTION 'say whether the games are Published or not'
            USING ERRCODE = '22023', DETAIL = 'published_required';
    END IF;
    IF p_published THEN
        IF v_reason IS NOT NULL OR v_note IS NOT NULL THEN
            RAISE EXCEPTION 'turning Published on takes no reason and no note: they belong to allowing changes'
                USING ERRCODE = '22023', DETAIL = 'reason_only_when_off';
        END IF;
    ELSE
        IF v_reason IS NULL THEN
            RAISE EXCEPTION 'allowing changes to a Published game needs a reason'
                USING ERRCODE = '22023', DETAIL = 'reason_required';
        END IF;
        IF NOT (v_reason = ANY (c_reasons)) THEN
            RAISE EXCEPTION 'unknown reason "%": one of %', v_reason, array_to_string(c_reasons, ', ')
                USING ERRCODE = '22023', DETAIL = 'reason_unknown';
        END IF;
        IF char_length(v_note) > 200 THEN
            RAISE EXCEPTION 'the note is at most 200 characters (% given)', char_length(v_note)
                USING ERRCODE = '22023', DETAIL = 'note_too_long';
        END IF;
    END IF;
    IF p_scope IS NULL THEN
        v_scope := jsonb_build_object('kind', 'selection');
    ELSE
        IF jsonb_typeof(p_scope) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'the scope is an object with a kind and an optional value'
                USING ERRCODE = '22023', DETAIL = 'scope_invalid';
        END IF;
        IF NOT COALESCE((p_scope ->> 'kind') = ANY (c_kinds), false)
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_scope) AS k WHERE k NOT IN ('kind', 'value'))
           OR (p_scope ? 'value' AND jsonb_typeof(p_scope -> 'value') NOT IN ('string', 'null'))
           OR char_length(COALESCE(p_scope ->> 'value', '')) > 100 THEN
            RAISE EXCEPTION 'the scope kind is one of %, with an optional text value of at most 100 characters', array_to_string(c_kinds, ', ')
                USING ERRCODE = '22023', DETAIL = 'scope_invalid';
        END IF;
        v_scope := jsonb_build_object('kind', p_scope ->> 'kind')
                   || CASE WHEN NULLIF(p_scope ->> 'value', '') IS NOT NULL
                           THEN jsonb_build_object('value', p_scope ->> 'value') ELSE '{}'::jsonb END;
    END IF;

    -- Gate 4: the rows, locked in id order (lesson 64), then judged as they stand. A completed season's rows are
    -- refused below by the existing read-only trigger, which wins over the flag.
    SELECT count(*) INTO v_locked FROM (
        SELECT ga.id
          FROM public.game_assignments ga
         WHERE ga.id = ANY (v_ids) AND ga.organization_id = p_organization_id
         ORDER BY ga.id
           FOR UPDATE) l;
    IF v_locked <> v_n THEN
        RAISE EXCEPTION 'a game was removed while its Published state was being set: nothing was changed, try again'
            USING ERRCODE = '40001';
    END IF;

    -- Gate 6: a game already at the value asked for is unchanged, and never audited.
    SELECT COALESCE(array_agg(ga.id ORDER BY ga.id), '{}'::uuid[]) INTO v_changed
      FROM public.game_assignments ga
     WHERE ga.id = ANY (v_ids) AND ga.published IS DISTINCT FROM p_published;
    v_unchanged := v_n - cardinality(v_changed);
    IF cardinality(v_changed) = 0 THEN
        RETURN jsonb_build_object('changed', 0, 'unchanged', v_unchanged, 'ids', '[]'::jsonb);
    END IF;

    -- The games as they stand before the flag moves: the before-image of each override row.
    IF NOT p_published THEN
        SELECT jsonb_agg(jsonb_build_object(
                   'id', ga.id,
                   'before', jsonb_build_object(
                       'game_slot_id', ga.game_slot_id, 'field_id', ga.field_id,
                       'home_team_id', ga.home_team_id, 'away_team_id', ga.away_team_id,
                       'week_index', ga.week_index, 'start', ga.start, 'end', ga."end")) ORDER BY ga.id)
          INTO v_before
          FROM public.game_assignments ga
         WHERE ga.id = ANY (v_changed);
    END IF;

    -- published_at and published_by are the most recent time the flag was turned ON: kept when it is turned off.
    UPDATE public.game_assignments ga
       SET published = p_published,
           published_at = CASE WHEN p_published THEN now() ELSE ga.published_at END,
           published_by = CASE WHEN p_published THEN v_uid ELSE ga.published_by END
     WHERE ga.id = ANY (v_changed);

    -- The audit rows, in this transaction. A failed write rolls the change back; SLA01 tells the caller it was the
    -- audit, and DETAIL keeps the original SQLSTATE. Every error is caught and every one is re-raised.
    BEGIN
        PERFORM public.record_audit_event(
            p_organization_id, 'game.published_set', 'game_assignment', NULL,
            jsonb_build_object('published', p_published, 'scope', v_scope, 'count', cardinality(v_changed),
                               'unchanged', v_unchanged, 'ids', to_jsonb(v_changed))
            || CASE WHEN p_published THEN '{}'::jsonb ELSE jsonb_build_object('reason_code', v_reason) END);
        IF NOT p_published THEN
            FOR v_row IN
                SELECT (e.value ->> 'id')::uuid AS id, e.value -> 'before' AS before
                  FROM jsonb_array_elements(v_before) AS e(value)
            LOOP
                PERFORM public.record_audit_event(
                    p_organization_id, 'game.publish_overridden', 'game_assignment', v_row.id,
                    jsonb_build_object('reason_code', v_reason, 'scope', v_scope, 'before', v_row.before)
                    || CASE WHEN v_note IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('note', v_note) END);
            END LOOP;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    RETURN jsonb_build_object('changed', cardinality(v_changed), 'unchanged', v_unchanged, 'ids', to_jsonb(v_changed));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb) TO authenticated;
COMMENT ON FUNCTION public.admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb) IS
    'Admin-only (staff included), signed in: set whether 1 to 2,400 games are Published. Turning on needs nothing; turning off ("allow changes") needs a reason from field-change, coach-request, conflict-fix, published-in-error, other and takes a note of at most 200 characters. A game already at the value is unchanged and not audited. Audited in the same transaction: game.published_set per call, game.publish_overridden per game turned off. Returns {changed, unchanged, ids}. 20261119010000.';

-- ---------------------------------------------------------------------------
-- 8. The schedule audit log: the two actions above, with the actor's name.
-- ---------------------------------------------------------------------------
--
-- Admin only, like get_settings_audit_log. The call rows come back without their `ids` (up to 2,400 of them); the
-- per-game rows and the audit table hold them. No contact column: the contact catalogue (20261025010000) lists
-- exactly two reads that return one, and this is not a third.

CREATE FUNCTION public.get_schedule_audit_log(
    p_organization_id uuid,
    p_assignment_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 50
)
RETURNS TABLE (
    id uuid,
    created_at timestamptz,
    action text,
    resource_type text,
    resource_id uuid,
    metadata jsonb,
    actor_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    IF p_organization_id IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an administrator of the organization reads its schedule audit log'
            USING ERRCODE = '42501', DETAIL = 'admin_required';
    END IF;

    RETURN QUERY
    SELECT a.id,
           a.created_at,
           a.action,
           a.resource_type,
           a.resource_id,
           CASE WHEN a.action = 'game.published_set' THEN a.metadata - 'ids' ELSE a.metadata END,
           COALESCE(p.full_name, 'Unknown User')
      FROM public.audit_log a
      LEFT JOIN public.profiles p ON p.id = a.user_id
     WHERE a.organization_id = p_organization_id
       AND a.action IN ('game.published_set', 'game.publish_overridden')
       AND (p_assignment_id IS NULL
            OR a.resource_id = p_assignment_id
            OR (a.action = 'game.published_set' AND a.metadata -> 'ids' @> to_jsonb(p_assignment_id::text)))
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
END;
$$;

REVOKE ALL ON FUNCTION public.get_schedule_audit_log(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_schedule_audit_log(uuid, uuid, integer) TO authenticated;
COMMENT ON FUNCTION public.get_schedule_audit_log(uuid, uuid, integer) IS
    'Admin-only: the game.published_set and game.publish_overridden audit rows of an organization (newest first, 50 by default, at most 500), optionally those that name one game, with the actor''s name and no contact. A call row comes back without its ids. 20261119010000.';

-- ---------------------------------------------------------------------------
-- 9. The end state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_fn text;
    v_src text;
BEGIN
    IF (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid = 'public.game_assignments'::regclass AND NOT a.attisdropped
           AND ((a.attname = 'published' AND format_type(a.atttypid, a.atttypmod) = 'boolean' AND a.attnotnull)
             OR (a.attname = 'published_at' AND format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone' AND NOT a.attnotnull)
             OR (a.attname = 'published_by' AND format_type(a.atttypid, a.atttypmod) = 'uuid' AND NOT a.attnotnull))) <> 3 THEN
        RAISE EXCEPTION 'game_assignments does not hold published (boolean NOT NULL), published_at and published_by';
    END IF;
    IF EXISTS (SELECT 1 FROM public.game_assignments WHERE published OR published_at IS NOT NULL OR published_by IS NOT NULL) THEN
        RAISE EXCEPTION 'this migration changes no existing row, and a game is already Published';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'game_assignments'
                    AND indexname = 'idx_game_assignments_org_published' AND indexdef ~ '\(organization_id\) WHERE published') THEN
        RAISE EXCEPTION 'the partial index on published games is missing';
    END IF;

    -- The guard: an enabled BEFORE UPDATE OR DELETE row trigger with the WHEN clause, calling the guard; and the
    -- completed-season trigger it sits beside is still there.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_published_guard'
                      AND NOT t.tgisinternal AND t.tgenabled = 'O'
                      AND t.tgfoid = to_regprocedure('public.game_assignments_published_guard()')
                      AND pg_get_triggerdef(t.oid) ~ 'BEFORE (DELETE OR UPDATE|UPDATE OR DELETE) ON public.game_assignments FOR EACH ROW WHEN \(old.published\)') THEN
        RAISE EXCEPTION 'game_assignments_published_guard is not an enabled BEFORE UPDATE OR DELETE trigger WHEN (OLD.published)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.game_assignments'::regclass AND t.tgname = 'game_assignments_readonly_when_completed'
                      AND NOT t.tgisinternal AND t.tgenabled = 'O') THEN
        RAISE EXCEPTION 'the completed-season trigger on game_assignments is gone';
    END IF;
    IF (SELECT count(*) FROM public.audit_actions WHERE action IN ('game.published_set', 'game.publish_overridden')) <> 2 THEN
        RAISE EXCEPTION 'the two audit actions are not registered';
    END IF;

    -- Every function this migration touched: a definer with a pinned search path, closed to anon and PUBLIC; the
    -- callable ones open to authenticated; the trigger function open to no client role.
    FOREACH v_fn IN ARRAY ARRAY[
        'game_assignments_published_guard()',
        'admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb)',
        'get_schedule_audit_log(uuid, uuid, integer)',
        'persist_game_schedule(jsonb, jsonb)',
        'admin_cancel_game_assignment(uuid)',
        'admin_delete_team(uuid)'
    ] LOOP
        IF to_regprocedure('public.' || v_fn) IS NULL THEN
            RAISE EXCEPTION '% is missing', v_fn;
        END IF;
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
       OR NOT (SELECT p.proconfig @> ARRAY['TimeZone=UTC'] FROM pg_proc p WHERE p.oid = 'public.game_assignments_published_guard()'::regprocedure)
       OR NOT (SELECT p.proconfig @> ARRAY['TimeZone=UTC'] FROM pg_proc p WHERE p.oid = 'public.admin_set_games_published(uuid, uuid[], boolean, text, text, jsonb)'::regprocedure)
       OR NOT (SELECT p.proconfig @> ARRAY['TimeZone=UTC'] FROM pg_proc p WHERE p.oid = 'public.get_schedule_audit_log(uuid, uuid, integer)'::regprocedure) THEN
        RAISE EXCEPTION 'a function lost its UTC pin';
    END IF;

    -- Each replaced function was copied from the right body: it still holds what only that body holds, and the new
    -- lines are in it.
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.persist_game_schedule(jsonb, jsonb)'::regprocedure;
    IF v_src !~ 'game_published_omitted' OR v_src !~ 'v_tbd_games' OR v_src !~ 'game\.saved' OR v_src !~ 'SLA01' THEN
        RAISE EXCEPTION 'persist_game_schedule is not the 20261108020000 body plus the omission check';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.admin_delete_team(uuid)'::regprocedure;
    IF v_src !~ 'game_published' OR v_src !~ 'coach_practice_preferences_deleted' OR v_src !~ 'schedule_tbd_deleted' THEN
        RAISE EXCEPTION 'admin_delete_team is not the 20261112010000 body plus the Published check';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.admin_cancel_game_assignment(uuid)'::regprocedure;
    IF v_src !~ 'game_published' OR v_src !~ 'game\.cancelled' THEN
        RAISE EXCEPTION 'admin_cancel_game_assignment is not the 20260613000003 body plus the Published check';
    END IF;
END;
$check$;

COMMIT;
