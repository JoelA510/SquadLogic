-- Restore the prior game and practice import functions together.
BEGIN;
DO $guard$
BEGIN
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.apply_game_import_job(uuid,boolean,jsonb)')) IS DISTINCT FROM '2c79d51acc5e4daa895bdaddaa500ad3' THEN
        RAISE EXCEPTION 'Unexpected body for apply_game_import_job(uuid,boolean,jsonb)';
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
        WHERE oid = to_regprocedure('public.apply_practice_import_job(uuid,boolean)')) IS DISTINCT FROM 'f0195de03b5ab04ed526d08d4ee24fbc' THEN
        RAISE EXCEPTION 'Unexpected body for apply_practice_import_job(uuid,boolean)';
    END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.apply_game_import_job(p_import_job_id uuid, p_dry_run boolean DEFAULT false, p_confirmed_counts jsonb DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    -- The closed list of reasons a row is refused and listed (packages/core/src/scheduleImport/reasonCodes.js,
    -- SCHEDULE_IMPORT_ROW_REFUSALS; tests/gameImportReasonParity.test.js holds this text to it). A staged row refused by
    -- the file check carries one of them in its validation_errors; the apply adds the ones it can only know once labels
    -- are mapped.
    c_row_refusals constant text[] := ARRAY[
        'bad-game-id', 'bad-date', 'bad-time', 'end-not-after-start', 'same-team', 'bad-week', 'missing-week',
        'outside-season-window', 'time-in-dst-gap', 'unknown-division', 'unknown-team', 'unknown-venue', 'unknown-field',
        'label-is-own-team', 'duplicate-row', 'game-id-reused'];
    -- The closed list of reasons a game the file names is NOT written. It can grow by one (F11-2: skipped-scored);
    -- packages/core/src/scheduleImport/reasonCodes.js holds the words for each (SCHEDULE_IMPORT_SKIP_REASONS).
    c_skip_published constant text := 'skipped-published';
    -- 20261122010000: a held game that is not Published is held by its score.
    c_skip_scored constant text := 'skipped-scored';
    v_held_scored uuid[];
    n_skip_scored integer;
    c_listed constant integer := 200;
    c_listed_ids constant integer := 50;
    v_uid uuid := auth.uid();
    v_dry boolean := COALESCE(p_dry_run, false);
    v_job public.import_jobs%ROWTYPE;
    v_org uuid;
    v_season uuid;
    v_season_status text;
    v_map jsonb;
    v_arrive boolean;
    v_now timestamptz := now();
    v_prev_run uuid;
    v_run_id uuid := gen_random_uuid();
    v_bad_row integer;
    v_bad_code text;
    v_held uuid[];
    v_rc bigint;
    v_planned bigint;
    n_staged integer; n_refused integer; n_skipped integer; n_ok integer; n_tbd integer;
    n_ins integer; n_upd integer; n_unch integer; n_skip_pub integer; n_repoint integer; n_hidden integer;
    n_tbd_ins integer; n_tbd_unch integer; n_tbd_upd integer; n_tbd_rem integer; n_tbd_conflict integer; n_tbd_held integer; n_conv integer;
    n_div integer; n_ven integer; n_fld integer; n_shell integer; n_out integer; n_slot_new integer; n_slot_reused integer;
    n_not_in_file integer; v_not_in_file jsonb;
    v_work integer;
    v_nothing boolean;
    v_warnings jsonb;
    v_refused_by_reason jsonb;
    v_listed_refused jsonb; v_listed_skipped jsonb; v_listed_games jsonb;
    v_skipped_obj jsonb;
    v_result jsonb;
    v_ids jsonb := jsonb_build_object('run_id', NULL, 'team_run_ids', '[]'::jsonb);
    v_team_runs jsonb := '[]'::jsonb;
    v_status text;
    v_current_counts jsonb;
    v_published_ids uuid[];
    v_div record;
    v_base jsonb; v_grouped jsonb; v_results jsonb; v_key text; v_label text; v_shell_arr uuid[]; v_team_run uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'apply_game_import_job needs a signed-in caller' USING ERRCODE = '42501';
    END IF;
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    v_org := v_job.organization_id;
    IF NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_org USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'games' THEN
        RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;

    -- An apply takes the game writers' lock and then the season writers' (every other path takes at most one of the two,
    -- so no order can deadlock), and holds the job row; a dry run only reads.
    IF NOT v_dry THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || v_org::text, 0));
        PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
        SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    END IF;

    -- A finished job answers with the result it stored (a retry after a lost response writes nothing).
    IF v_job.status IN ('completed', 'completed_with_warnings') THEN
        IF v_job.warning_summary ? 'game_import' THEN
            RETURN (v_job.warning_summary -> 'game_import') || jsonb_build_object('replayed', true);
        END IF;
        RAISE EXCEPTION 'Import job % is already %', p_import_job_id, v_job.status USING ERRCODE = '22023';
    END IF;
    IF v_job.status IN ('failed', 'needs_fix') THEN
        RAISE EXCEPTION '% import job % cannot be applied: a new file is a new job', initcap(v_job.status), p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'import_not_ready_to_apply';
    END IF;
    IF v_job.status IS DISTINCT FROM 'ready_to_apply' THEN
        RAISE EXCEPTION 'Import job % is %, not ready_to_apply: stage the whole file first', p_import_job_id, v_job.status
            USING ERRCODE = '22023', DETAIL = 'import_not_ready_to_apply';
    END IF;

    v_season := v_job.season_settings_id;
    SELECT s.status INTO v_season_status FROM public.season_settings s
     WHERE s.id = v_season AND s.organization_id = v_org;
    IF v_season_status IS NULL THEN
        RAISE EXCEPTION 'Import job % has no season to import into', p_import_job_id USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no games import: only the active season does', v_season, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;
    v_map := v_job.warning_summary -> 'game_mapping';
    IF v_map IS NULL THEN
        RAISE EXCEPTION 'Import job % has no mapping: confirm what each label of the file is first', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'mapping_required';
    END IF;
    v_arrive := COALESCE((v_map -> 'options' ->> 'arrive_published')::boolean, true);

    -- ------------------------------------------------------------------ 1. The staged rows, read once.
    DROP TABLE IF EXISTS pg_temp._gi_tbefore, pg_temp._gi_rows, pg_temp._gi_dec, pg_temp._gi_div, pg_temp._gi_venue, pg_temp._gi_field,
        pg_temp._gi_team, pg_temp._gi_res, pg_temp._gi_work, pg_temp._gi_g, pg_temp._gi_slotnew, pg_temp._gi_t,
        pg_temp._gi_carry, pg_temp._gi_final, pg_temp._gi_before, pg_temp._gi_newgames;

    CREATE TEMP TABLE _gi_rows ON COMMIT DROP AS
    SELECT sr.id AS staging_id,
           sr.source_row_number AS rowno,
           (sr.normalized_payload IS NULL OR COALESCE(jsonb_array_length(sr.validation_errors), 0) > 0) AS parse_refused,
           sr.validation_errors -> 0 ->> 'code' AS parse_reason,
           sr.validation_errors -> 0 ->> 'message' AS parse_message,
           sr.normalized_payload ->> 'row_key' AS row_key,
           NULLIF(btrim(sr.normalized_payload ->> 'game_id', E' \t\r\n'), '') AS game_id,
           sr.normalized_payload ->> 'status' AS status,
           sr.normalized_payload ->> 'tbd_reason' AS tbd_reason,
           CASE WHEN sr.normalized_payload ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (sr.normalized_payload ->> 'date')::date END AS gdate,
           CASE WHEN sr.normalized_payload ->> 'start_time' ~ '^\d{2}:\d{2}$' THEN (sr.normalized_payload ->> 'start_time')::time END AS start_time,
           CASE WHEN sr.normalized_payload ->> 'end_time' ~ '^\d{2}:\d{2}$' THEN (sr.normalized_payload ->> 'end_time')::time END AS end_time,
           CASE WHEN sr.normalized_payload ->> 'start' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
                THEN (sr.normalized_payload ->> 'start')::timestamptz END AS start_ts,
           CASE WHEN sr.normalized_payload ->> 'end' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
                THEN (sr.normalized_payload ->> 'end')::timestamptz END AS end_ts,
           CASE WHEN sr.normalized_payload ->> 'week_index' ~ '^\d{1,3}$' THEN (sr.normalized_payload ->> 'week_index')::integer END AS week_index,
           CASE WHEN jsonb_typeof(sr.normalized_payload -> 'flags') = 'array'
                THEN ARRAY(SELECT jsonb_array_elements_text(sr.normalized_payload -> 'flags')) ELSE ARRAY[]::text[] END AS flags,
           btrim(sr.normalized_payload ->> 'division', E' \t\r\n') AS division_label,
           sr.normalized_payload ->> 'division_key' AS division_key,
           btrim(sr.normalized_payload ->> 'venue', E' \t\r\n') AS venue_label,
           sr.normalized_payload ->> 'venue_key' AS venue_key,
           btrim(sr.normalized_payload ->> 'field', E' \t\r\n') AS field_label,
           sr.normalized_payload ->> 'field_key' AS field_key,
           btrim(sr.normalized_payload ->> 'home_team', E' \t\r\n') AS home_label,
           sr.normalized_payload ->> 'home_key' AS home_key,
           btrim(sr.normalized_payload ->> 'away_team', E' \t\r\n') AS away_label,
           sr.normalized_payload ->> 'away_key' AS away_key
      FROM public.staging_import_rows sr
     WHERE sr.import_job_id = p_import_job_id
       AND sr.organization_id = v_org
       AND sr.import_type = 'games';

    SELECT count(*) INTO n_staged FROM _gi_rows;
    IF n_staged = 0 THEN
        RAISE EXCEPTION 'Import job % has no staged games rows', p_import_job_id USING ERRCODE = '22023', DETAIL = 'no_rows';
    END IF;

    -- A staged row is the Edge function's work, and a malformed one is a defect there, not a row to guess at: the whole
    -- apply refuses, naming the first.
    SELECT r.rowno, r.parse_reason INTO v_bad_row, v_bad_code
      FROM _gi_rows r
     WHERE r.parse_refused AND NOT (COALESCE(r.parse_reason, '') = ANY (c_row_refusals))
     ORDER BY r.rowno LIMIT 1;
    IF v_bad_row IS NOT NULL THEN
        RAISE EXCEPTION 'staged row % is refused for a reason this import does not know', v_bad_row
            USING ERRCODE = '22023', DETAIL = 'game_import_staged_invalid';
    END IF;
    SELECT r.rowno INTO v_bad_row
      FROM _gi_rows r
     WHERE NOT r.parse_refused
       AND NOT (r.status IN ('ok', 'tbd') AND r.gdate IS NOT NULL AND r.week_index BETWEEN 1 AND 255
                AND COALESCE(r.row_key, '') <> '' AND COALESCE(char_length(r.game_id), 0) <= 40
                AND COALESCE(r.division_key, '') <> '' AND COALESCE(r.home_key, '') <> '' AND COALESCE(r.away_key, '') <> ''
                AND COALESCE(r.division_label, '') <> '' AND COALESCE(r.home_label, '') <> '' AND COALESCE(r.away_label, '') <> ''
                AND (CASE WHEN r.status = 'ok'
                          THEN r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND r.start_ts IS NOT NULL AND r.end_ts IS NOT NULL
                               AND r.end_ts > r.start_ts AND COALESCE(r.venue_key, '') <> '' AND COALESCE(r.field_key, '') <> ''
                               AND COALESCE(r.venue_label, '') <> '' AND COALESCE(r.field_label, '') <> ''
                          ELSE r.start_ts IS NULL AND r.end_ts IS NULL END)
                -- 20261122010000: the parse's two warnings are staged flags now (a time that could not be read made the
                -- game a dated TIME TBD game; a Week that could not be stored was taken from the date), so they reach the
                -- saved result.
                AND r.flags <@ ARRAY['time-ambiguous', 'week-differs', 'bad-time', 'bad-week'])
     ORDER BY r.rowno LIMIT 1;
    IF v_bad_row IS NOT NULL THEN
        RAISE EXCEPTION 'staged row % is not a games row', v_bad_row
            USING ERRCODE = '22023', DETAIL = 'game_import_staged_invalid';
    END IF;

    -- ------------------------------------------------------------------ 2. What the admin decided, and what each label is.
    CREATE TEMP TABLE _gi_dec ON COMMIT DROP AS
    SELECT g.kind, e.key AS dkey, e.value ->> 'action' AS action,
           CASE WHEN e.value ->> 'action' = 'map'
                 AND e.value ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (e.value ->> 'id')::uuid END AS ref_id,
           NULLIF(btrim(e.value ->> 'name', E' \t\r\n'), '') AS dname
      FROM (VALUES ('division', 'divisions'), ('venue', 'venues'), ('field', 'fields'), ('team', 'teams')) AS g(kind, grp)
      CROSS JOIN LATERAL jsonb_each(COALESCE(v_map -> g.grp, '{}'::jsonb)) AS e(key, value)
     WHERE e.value ->> 'action' = ANY (CASE WHEN g.kind = 'team' THEN ARRAY['map', 'create', 'outside', 'skip']
                                            ELSE ARRAY['map', 'create', 'skip'] END);

    -- Divisions: of this season. A `create` over a name the season already has would meet UNIQUE (season, name), and so
    -- would two labels that create one name: those are ONE creation (the first label by key makes it, the others share its
    -- id), as core's resolveScheduleRows coalesces them. `creator` marks the label whose row writes the record.
    CREATE TEMP TABLE _gi_div ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.division_key AS dkey, (array_agg(r.division_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused GROUP BY r.division_key
    ), j AS (
        SELECT k.dkey, k.label, d.action,
               CASE WHEN d.action = 'map' THEN
                   (SELECT dv.id FROM public.divisions dv
                     WHERE dv.id = d.ref_id AND dv.organization_id = v_org AND dv.season_settings_id = v_season) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k LEFT JOIN _gi_dec d ON d.kind = 'division' AND d.dkey = k.dkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.divisions dv
                    WHERE dv.organization_id = v_org AND dv.season_settings_id = v_season
                      AND public.normalise_external_label(dv.name) = public.normalise_external_label(j.cname))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.dkey, k3.label, k3.action, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref,
           COALESCE((SELECT dv.name FROM public.divisions dv WHERE dv.id = k3.existing_id), CASE WHEN k3.can_create THEN k3.final_cname END) AS final_name
      FROM k3;

    -- Venues (locations of the organization).
    CREATE TEMP TABLE _gi_venue ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.venue_key AS vkey, (array_agg(r.venue_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused AND r.status = 'ok' GROUP BY r.venue_key
    ), j AS (
        SELECT k.vkey, k.label, d.action,
               CASE WHEN d.action = 'map' THEN
                   (SELECT l.id FROM public.locations l WHERE l.id = d.ref_id AND l.organization_id = v_org) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k LEFT JOIN _gi_dec d ON d.kind = 'venue' AND d.dkey = k.vkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.locations l
                    WHERE l.organization_id = v_org AND public.normalise_external_label(l.name) = public.normalise_external_label(j.cname))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.vkey, k3.label, k3.action, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref
      FROM k3;

    -- Fields, judged inside their venue.
    CREATE TEMP TABLE _gi_field ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.field_key AS fkey, (array_agg(r.venue_key ORDER BY r.rowno))[1] AS vkey,
               (array_agg(r.field_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused AND r.status = 'ok' GROUP BY r.field_key
    ), j AS (
        SELECT k.fkey, k.vkey, k.label, d.action, v.ref AS venue_ref, v.existing_id AS venue_existing,
               CASE WHEN d.action = 'map' AND v.existing_id IS NOT NULL THEN
                   (SELECT f.id FROM public.fields f
                     WHERE f.id = d.ref_id AND f.organization_id = v_org AND f.location_id = v.existing_id) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k
          LEFT JOIN _gi_dec d ON d.kind = 'field' AND d.dkey = k.fkey
          LEFT JOIN _gi_venue v ON v.vkey = k.vkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND j.venue_ref IS NOT NULL
                AND NOT (j.venue_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.fields f
                    WHERE f.location_id = j.venue_existing AND public.normalise_external_label(f.name) = public.normalise_external_label(j.cname)))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.fkey, k3.vkey, k3.label, k3.action, k3.venue_ref, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref
      FROM k3;

    -- Teams, judged inside their division. kind: skip | existing | shell | ext-existing | ext-new | own-name | bad. Two labels
    -- that resolve to one new team (the same final name in the same resolved division) are ONE creation, shell or outside
    -- club, as core coalesces them; and an outside club whose name a shell created here already takes is the same refusal as
    -- one named like an own team (`own-name`), for UNIQUE (division_id, name) holds for both.
    CREATE TEMP TABLE _gi_team ON COMMIT DROP AS
    WITH keys AS (
        SELECT t.tkey, t.dkey, (array_agg(t.label ORDER BY t.rowno, t.side))[1] AS label
          FROM (SELECT r.home_key AS tkey, r.division_key AS dkey, r.home_label AS label, r.rowno, 1 AS side
                  FROM _gi_rows r WHERE NOT r.parse_refused
                UNION ALL
                SELECT r.away_key, r.division_key, r.away_label, r.rowno, 2
                  FROM _gi_rows r WHERE NOT r.parse_refused) t
         GROUP BY t.tkey, t.dkey
    ), j AS (
        SELECT k.tkey, k.dkey, k.label, d.action, d.ref_id, COALESCE(d.dname, k.label) AS cname,
               dv.ref AS division_ref, dv.existing_id AS division_existing
          FROM keys k
          LEFT JOIN _gi_dec d ON d.kind = 'team' AND d.dkey = k.tkey
          LEFT JOIN _gi_div dv ON dv.dkey = k.dkey
    ), k2 AS (
        SELECT j.*,
               CASE WHEN j.action = 'map' AND j.division_existing IS NOT NULL THEN
                   (SELECT t.id FROM public.teams t
                     WHERE t.id = j.ref_id AND t.organization_id = v_org AND t.division_id = j.division_existing) END AS map_id,
               (j.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                    WHERE t.division_id = j.division_existing AND NOT t.is_external
                      AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname))) AS own_named,
               (SELECT t.id FROM public.teams t
                 WHERE j.division_existing IS NOT NULL AND t.division_id = j.division_existing AND t.is_external
                   AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname) ORDER BY t.id LIMIT 1) AS ext_id,
               (j.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                    WHERE t.division_id = j.division_existing AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname))) AS name_taken,
               (j.action = 'outside' AND j.division_ref IS NOT NULL AND EXISTS (SELECT 1 FROM j j2
                    WHERE j2.action = 'create' AND j2.division_ref = j.division_ref AND public.normalise_external_label(j2.cname) = public.normalise_external_label(j.cname)
                      AND NOT (j2.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                                WHERE t.division_id = j2.division_existing AND public.normalise_external_label(t.name) = public.normalise_external_label(j2.cname))))) AS shell_here,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               CASE
                   WHEN k2.action = 'skip' THEN 'skip'
                   WHEN k2.action = 'map' AND k2.map_id IS NOT NULL THEN 'existing'
                   WHEN k2.action = 'create' AND k2.division_ref IS NOT NULL AND NOT k2.name_taken THEN 'shell'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL AND (k2.own_named OR k2.shell_here) THEN 'own-name'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL AND k2.ext_id IS NOT NULL THEN 'ext-existing'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL THEN 'ext-new'
                   ELSE 'bad'
               END AS kind
          FROM k2
    ), k4 AS (
        SELECT k3.*,
               first_value(k3.own_id) OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) AS new_id,
               first_value(k3.cname) OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) AS final_cname,
               (row_number() OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) = 1) AS creator
          FROM k3
    )
    SELECT k4.tkey, k4.dkey, k4.label, k4.action, k4.kind,
           CASE WHEN k4.kind IN ('shell', 'ext-new') THEN k4.final_cname ELSE k4.cname END AS cname, k4.division_ref, k4.new_id,
           (k4.kind IN ('shell', 'ext-new') AND k4.creator) AS creator,
           CASE k4.kind WHEN 'existing' THEN k4.map_id WHEN 'ext-existing' THEN k4.ext_id
                        WHEN 'shell' THEN k4.new_id WHEN 'ext-new' THEN k4.new_id END AS ref,
           (k4.kind IN ('ext-existing', 'ext-new')
            OR (k4.kind = 'existing' AND EXISTS (SELECT 1 FROM public.teams t WHERE t.id = k4.map_id AND t.is_external))) AS is_outside
      FROM k4;

    -- ------------------------------------------------------------------ 3. Each row, resolved, in the order core does it.
    CREATE TEMP TABLE _gi_res ON COMMIT DROP AS
    SELECT r.*,
           dv.ref AS division_ref, dv.final_name AS division_name, v.ref AS venue_ref, f.ref AS field_ref,
           th.ref AS home_ref, ta.ref AS away_ref, th.is_outside AS home_out, ta.is_outside AS away_out,
           CASE
               WHEN r.parse_refused THEN 'refused:' || r.parse_reason
               WHEN dv.action = 'skip' THEN 'skipped:division'
               WHEN dv.ref IS NULL THEN 'refused:unknown-division'
               WHEN r.status = 'ok' AND v.action = 'skip' THEN 'skipped:venue'
               WHEN r.status = 'ok' AND v.ref IS NULL THEN 'refused:unknown-venue'
               WHEN r.status = 'ok' AND f.action = 'skip' THEN 'skipped:field'
               WHEN r.status = 'ok' AND f.ref IS NULL THEN 'refused:unknown-field'
               WHEN th.kind = 'skip' THEN 'skipped:team'
               WHEN th.kind = 'own-name' THEN 'refused:label-is-own-team'
               WHEN th.ref IS NULL THEN 'refused:unknown-team'
               WHEN ta.kind = 'skip' THEN 'skipped:team'
               WHEN ta.kind = 'own-name' THEN 'refused:label-is-own-team'
               WHEN ta.ref IS NULL THEN 'refused:unknown-team'
               WHEN th.is_outside AND ta.is_outside THEN 'refused:unknown-team'
               WHEN th.ref = ta.ref THEN 'refused:same-team'
               ELSE 'ok'
           END AS outcome,
           CASE
               WHEN dv.action = 'skip' THEN r.division_label
               WHEN r.status = 'ok' AND v.action = 'skip' THEN r.venue_label
               WHEN r.status = 'ok' AND f.action = 'skip' THEN r.field_label
               WHEN th.kind = 'skip' THEN r.home_label
               WHEN ta.kind = 'skip' THEN r.away_label
           END AS skip_label
      FROM _gi_rows r
      LEFT JOIN _gi_div dv ON dv.dkey = r.division_key
      LEFT JOIN _gi_venue v ON v.vkey = r.venue_key AND r.status = 'ok'
      LEFT JOIN _gi_field f ON f.fkey = r.field_key AND r.status = 'ok'
      LEFT JOIN _gi_team th ON th.tkey = r.home_key AND th.dkey = r.division_key
      LEFT JOIN _gi_team ta ON ta.tkey = r.away_key AND ta.dkey = r.division_key;

    -- The same game twice by the admin's own mapping (two labels mapped onto one team): the first row wins. A TIME TBD
    -- game is one row per (home, away, week) in the table, so a second is refused as a duplicate too. Then one Game ID on
    -- two different games: the first wins.
    CREATE TEMP TABLE _gi_work ON COMMIT DROP AS
    SELECT x.*,
           CASE WHEN x.outcome = 'ok' AND x.dup_rank > 1 THEN 'refused:duplicate-row'
                WHEN x.outcome = 'ok' AND x.game_id IS NOT NULL AND x.gid_rank > 1 THEN 'refused:game-id-reused'
                ELSE x.outcome END AS final_outcome
      FROM (
        SELECT d.*,
               CASE WHEN d.outcome = 'ok' AND d.dup_rank = 1 AND d.game_id IS NOT NULL
                    THEN row_number() OVER (PARTITION BY d.game_id, (d.outcome = 'ok' AND d.dup_rank = 1) ORDER BY d.rowno) END AS gid_rank
          FROM (
            SELECT r.*,
                   CASE WHEN r.outcome = 'ok' THEN row_number() OVER (
                        PARTITION BY (r.outcome = 'ok'), CASE WHEN r.status = 'ok'
                                          THEN concat_ws('|', 'ok', r.home_ref, r.away_ref, r.field_ref, r.gdate, r.start_time)
                                          ELSE concat_ws('|', 'tbd', r.home_ref, r.away_ref, r.week_index) END
                        ORDER BY r.rowno) END AS dup_rank
              FROM _gi_res r) d) x;

    -- ------------------------------------------------------------------ 4. Placed games: the slot, the match, the verdict.
    CREATE TEMP TABLE _gi_g ON COMMIT DROP AS
    WITH base AS (
        SELECT w.rowno, w.row_key, w.game_id, w.home_ref, w.away_ref, w.field_ref, w.gdate, w.start_time, w.end_time,
               w.start_ts, w.end_ts, w.week_index, w.flags, w.division_ref, w.division_name,
               s.id AS slot_id, s.week_index AS slot_week,
               m.id AS match_id
          FROM _gi_work w
          LEFT JOIN LATERAL (SELECT gs.id, gs.week_index FROM public.game_slots gs
                              WHERE gs.organization_id = v_org AND gs.field_id = w.field_ref
                                AND gs.slot_date = w.gdate AND gs.start_time = w.start_time
                              ORDER BY gs.created_at, gs.id LIMIT 1) s ON true
          LEFT JOIN LATERAL (SELECT ga.id FROM public.game_assignments ga
                              WHERE ga.organization_id = v_org
                                AND CASE WHEN w.game_id IS NOT NULL
                                         THEN ga.season_settings_id = v_season AND ga.external_ref = w.game_id
                                         ELSE s.id IS NOT NULL AND ga.home_team_id = w.home_ref AND ga.away_team_id = w.away_ref
                                              AND ga.game_slot_id = s.id AND ga.week_index = w.week_index END
                              LIMIT 1) m ON true
         WHERE w.final_outcome = 'ok' AND w.status = 'ok'
    )
    SELECT b.*, ga.run_id AS m_run, ga.published AS m_published,
           (ga.id IS NOT NULL) AS matched,
           (ga.id IS NOT NULL
            AND ga.field_id IS NOT DISTINCT FROM b.field_ref AND ga.home_team_id = b.home_ref AND ga.away_team_id = b.away_ref
            AND ga.week_index IS NOT DISTINCT FROM b.week_index AND ga.start IS NOT DISTINCT FROM b.start_ts
            AND ga."end" IS NOT DISTINCT FROM b.end_ts AND ga.division IS NOT DISTINCT FROM b.division_name
            AND gsm.slot_date IS NOT DISTINCT FROM b.gdate AND gsm.start_time IS NOT DISTINCT FROM b.start_time) AS same,
           -- The game this row names stands on a place (home, away, slot, week) that is not the one the row puts it on: if the
           -- row is written, the game LEAVES its place. (A game that changes only its division label does not.)
           (ga.id IS NOT NULL
            AND (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
                IS DISTINCT FROM (b.home_ref, b.away_ref, b.slot_id, b.week_index)) AS leaves
      FROM base b
      LEFT JOIN public.game_assignments ga ON ga.id = b.match_id
      LEFT JOIN public.game_slots gsm ON gsm.id = ga.game_slot_id;

    -- TIME TBD games: a date and no time (the staged row has no instants, and a game with no field has no slot). A row is
    -- found by (season, Game ID) FIRST, in the table's own `external_ref`; a row with no Game ID, and a row whose Game ID
    -- no TIME TBD game carries yet but whose (home, away, week) one does that has no Game ID of its own, is found by the
    -- tuple, as the placed games are. `c_id` is another TIME TBD game that already holds the tuple this row would stand
    -- on (the table is unique on it): a different game, so the row is refused as a duplicate. `ga_id` is the placed game
    -- the row's Game ID names: the file now says it has no time.
    CREATE TEMP TABLE _gi_t ON COMMIT DROP AS
    SELECT w.rowno, w.row_key, w.game_id, w.home_ref, w.away_ref, w.week_index, w.division_ref, w.gdate, w.tbd_reason, w.flags,
           m.id AS m_id, m.external_ref AS m_ref, m.game_date AS m_date, m.week_index AS m_week, m.division_id AS m_div,
           m.home_team_id AS m_home, m.away_team_id AS m_away, m.reason AS m_reason,
           c.id AS c_id, a.id AS ga_id, gen_random_uuid() AS new_id
      FROM _gi_work w
      LEFT JOIN LATERAL (SELECT s.* FROM public.schedule_tbd s
                          WHERE s.organization_id = v_org AND s.season_settings_id = v_season AND s.kind = 'game'
                            AND ((w.game_id IS NOT NULL AND s.external_ref = w.game_id)
                                 OR (s.home_team_id = w.home_ref AND s.away_team_id = w.away_ref AND s.week_index = w.week_index
                                     AND (w.game_id IS NULL OR s.external_ref IS NULL)))
                          ORDER BY (s.external_ref IS NOT DISTINCT FROM w.game_id) DESC, s.id LIMIT 1) m ON true
      LEFT JOIN LATERAL (SELECT s.id FROM public.schedule_tbd s
                          WHERE s.season_settings_id = v_season AND s.kind = 'game'
                            AND s.home_team_id = w.home_ref AND s.away_team_id = w.away_ref AND s.week_index = w.week_index
                            AND s.id IS DISTINCT FROM m.id LIMIT 1) c ON true
      LEFT JOIN LATERAL (SELECT ga.id FROM public.game_assignments ga
                          WHERE w.game_id IS NOT NULL AND ga.organization_id = v_org AND ga.season_settings_id = v_season
                            AND ga.external_ref = w.game_id LIMIT 1) a ON true
     WHERE w.final_outcome = 'ok' AND w.status = 'tbd';

    -- The one predicate: a game is held where it is (F11-1's game_held_ids; F11-2 adds a score). The games a row names, a
    -- placed one or one a TIME TBD row would take out.
    SELECT COALESCE(array_agg(DISTINCT x.id), ARRAY[]::uuid[]) INTO v_held
      FROM (SELECT g.match_id AS id FROM _gi_g g UNION SELECT t.ga_id FROM _gi_t t) x WHERE x.id IS NOT NULL;
    v_held := ARRAY(SELECT public.game_held_ids(v_held));
    -- 20261122010000: which of the held games are held by a score and not Published (the words of the skip, nothing else:
    -- whether a game is held is v_held, the one predicate's answer).
    v_held_scored := ARRAY(SELECT h FROM unnest(v_held) AS h WHERE public.game_hold_code(h) = 'game_scored');

    ALTER TABLE _gi_g ADD COLUMN verdict text, ADD COLUMN new_id uuid DEFAULT gen_random_uuid(), ADD COLUMN slot_final uuid, ADD COLUMN flagged text[],
                      ADD COLUMN tbd_id uuid, ADD COLUMN swapped_with uuid, ADD COLUMN dup_target boolean DEFAULT false, ADD COLUMN carry_ref text;
    UPDATE _gi_g g SET verdict = CASE
            WHEN NOT g.matched THEN 'insert'
            WHEN g.same THEN 'unchanged'
            WHEN g.match_id = ANY (v_held) THEN 'skip-held'
            ELSE 'update' END;

    -- The TIME TBD rows' verdicts. A placed game of the Game ID that is held (Published) is not taken out: the row is
    -- skipped, as a held game's row that changed is. Another game on the tuple refuses the row.
    ALTER TABLE _gi_t ADD COLUMN verdict text, ADD COLUMN conv boolean, ADD COLUMN dup_target boolean DEFAULT false;
    UPDATE _gi_t t SET verdict = CASE
            WHEN t.ga_id IS NOT NULL AND t.ga_id = ANY (v_held) THEN 'skip-held'
            WHEN t.c_id IS NOT NULL THEN 'conflict'
            WHEN t.m_id IS NULL THEN 'insert'
            WHEN t.m_date IS NOT DISTINCT FROM t.gdate AND t.m_week = t.week_index AND t.m_div = t.division_ref
                 AND t.m_home = t.home_ref AND t.m_away = t.away_ref AND t.m_ref IS NOT DISTINCT FROM COALESCE(t.game_id, t.m_ref)
                 AND t.m_reason = 'imported-without-time' THEN 'unchanged'
            ELSE 'update' END;

    -- Two rows of the file that resolve to ONE saved record (Codex on e699b1f): a row with no Game ID finds a saved game by
    -- its teams, place and week, and another row finds the same game by its Game ID (or names it to take it out, or both
    -- find one TIME TBD game). One record cannot be written twice (the apply's own row count raised, and the whole import
    -- went with it), so this is a plan the apply cannot execute and a NECESSARY refusal: the row that carries the Game ID
    -- is kept (then the earlier row of the file), and every other row that names the record is refused `duplicate-row`
    -- in words that say so, in the preview as in the apply. A claim is a saved game (a placed row's match, or the game a
    -- TIME TBD row's Game ID names) or a saved TIME TBD game (a TIME TBD row's match).
    WITH claim AS (
        SELECT 'game' AS kind, g.match_id AS target, g.rowno, (g.game_id IS NOT NULL) AS by_id, 'g' AS src FROM _gi_g g WHERE g.match_id IS NOT NULL
        UNION ALL
        SELECT 'game', t.ga_id, t.rowno, true, 't' FROM _gi_t t WHERE t.ga_id IS NOT NULL AND t.verdict <> 'conflict'
        UNION ALL
        SELECT 'tbd', t.m_id, t.rowno, (t.game_id IS NOT NULL AND t.m_ref IS NOT DISTINCT FROM t.game_id), 't' FROM _gi_t t
         WHERE t.m_id IS NOT NULL AND t.verdict <> 'conflict'
    ), lose AS (
        SELECT DISTINCT q.src, q.rowno
          FROM (SELECT c.*, row_number() OVER (PARTITION BY c.kind, c.target ORDER BY c.by_id DESC, c.rowno) AS rn FROM claim c) q
         WHERE q.rn > 1
    ), lost_g AS (
        UPDATE _gi_g g SET verdict = 'collision', dup_target = true FROM lose l WHERE l.src = 'g' AND l.rowno = g.rowno RETURNING 1
    )
    UPDATE _gi_t t SET verdict = 'conflict', dup_target = true FROM lose l WHERE l.src = 't' AND l.rowno = t.rowno;
    UPDATE _gi_t t SET conv = (t.ga_id IS NOT NULL AND t.verdict NOT IN ('skip-held', 'conflict'));

    -- Another game already stands on the place a row would put its game ((home, away, slot, week) is unique): that is a
    -- refusal of the row, the same word as a duplicate, UNLESS the game standing there is one the file itself moves away
    -- (a row that names it, and writes it, to another place): then the row is written after that game has left, and it is
    -- a warning, `games-swapped`. A game that moves is judged against the games the file does NOT move, so a row that
    -- cannot be written (its own place is taken) is not counted among the movers, and the rows that depended on it are
    -- judged again, until no row changes: collisions only ever grow, so this ends. A placed game the file now gives no time
    -- is taken out of the schedule, so it leaves its place too.
    LOOP
        UPDATE _gi_g g SET verdict = 'collision'
         WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.game_assignments g2
                        WHERE g2.home_team_id = g.home_ref AND g2.away_team_id = g.away_ref AND g2.game_slot_id = g.slot_id
                          AND g2.week_index = g.week_index AND g2.id IS DISTINCT FROM g.match_id
                          AND g2.id NOT IN (SELECT x.match_id FROM _gi_g x WHERE x.verdict = 'update' AND x.leaves)
                          AND g2.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        EXIT WHEN v_rc = 0;
    END LOOP;
    -- The rows that take the place of a game this file moves away, named for the warning.
    UPDATE _gi_g g SET swapped_with = (SELECT g2.id FROM public.game_assignments g2
                                        WHERE g2.home_team_id = g.home_ref AND g2.away_team_id = g.away_ref AND g2.game_slot_id = g.slot_id
                                          AND g2.week_index = g.week_index AND g2.id IS DISTINCT FROM g.match_id
                                          AND (g2.id IN (SELECT x.match_id FROM _gi_g x WHERE x.verdict = 'update' AND x.leaves)
                                               OR g2.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv))
                                        LIMIT 1)
     WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NOT NULL;

    -- A TIME TBD row the file now places: the game it names is written (a new or updated placed game) and the row goes.
    UPDATE _gi_g g SET tbd_id = (SELECT s.id FROM public.schedule_tbd s
                                  WHERE s.organization_id = v_org AND s.season_settings_id = v_season AND s.kind = 'game'
                                    AND ((g.game_id IS NOT NULL AND s.external_ref = g.game_id)
                                         OR (s.home_team_id = g.home_ref AND s.away_team_id = g.away_ref AND s.week_index = g.week_index
                                             AND (g.game_id IS NULL OR s.external_ref IS NULL)))
                                  ORDER BY (s.external_ref IS NOT DISTINCT FROM g.game_id) DESC, s.id LIMIT 1)
     WHERE g.verdict IN ('insert', 'update');
    -- One TIME TBD game is placed by ONE row: when two rows of the file would both take it (two games of one pair in one
    -- week, neither with a Game ID), the row that carries its Game ID, then the earlier row, is the game it becomes and
    -- the other is simply a new game.
    UPDATE _gi_g g SET tbd_id = NULL
     WHERE g.tbd_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM _gi_g o WHERE o.tbd_id = g.tbd_id AND o.rowno <> g.rowno AND o.verdict IN ('insert', 'update')
                      AND ((o.game_id IS NOT NULL), -o.rowno) > ((g.game_id IS NOT NULL), -g.rowno));
    -- An identifier a matched record already carries is never erased by a row that omits it (Codex on e699b1f): a TIME TBD
    -- game with a Game ID that a row with NO Game ID places becomes a placed game with that Game ID, so a later row that
    -- carries it finds the game instead of writing a second one. (The other matches keep theirs already: a placed game
    -- changed in place is not given the row's Game ID, and a TIME TBD game changed in place keeps its own when the row has
    -- none.) Not when the TIME TBD row stays (a TIME TBD row of the file writes it), nor when a game already has the Game ID.
    UPDATE _gi_g g SET carry_ref = s.external_ref
      FROM public.schedule_tbd s
     WHERE g.verdict = 'insert' AND g.game_id IS NULL AND s.id = g.tbd_id AND s.external_ref IS NOT NULL
       AND g.tbd_id NOT IN (SELECT t.m_id FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict IN ('insert', 'update', 'unchanged'))
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.season_settings_id = v_season AND ga.external_ref = s.external_ref)
       AND NOT EXISTS (SELECT 1 FROM _gi_g o WHERE o.game_id = s.external_ref AND o.verdict = 'insert');

    -- The invariant of the plan, checked where the plan ends and before anything is counted: no saved record is named
    -- twice among the rows that are kept. A plan that broke it would be refused here, in the preview too, never half-applied.
    IF EXISTS (SELECT 1 FROM (SELECT g.match_id AS id FROM _gi_g g WHERE g.match_id IS NOT NULL AND g.verdict <> 'collision'
                              UNION ALL SELECT t.ga_id FROM _gi_t t WHERE t.ga_id IS NOT NULL AND t.verdict <> 'conflict') x
                GROUP BY x.id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict <> 'conflict' GROUP BY t.m_id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM _gi_g g WHERE g.tbd_id IS NOT NULL AND g.verdict IN ('insert', 'update') GROUP BY g.tbd_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'game import plan names one saved record in two rows' USING ERRCODE = 'XX000';
    END IF;

    -- New slots: one per place no slot stands on yet, among the rows that write (a skipped or unchanged game makes none).
    CREATE TEMP TABLE _gi_slotnew ON COMMIT DROP AS
    SELECT g.field_ref AS field_id, g.gdate, g.start_time,
           (array_agg(g.end_time ORDER BY g.rowno))[1] AS end_time,
           (array_agg(g.start_ts ORDER BY g.rowno))[1] AS start_ts,
           (array_agg(g.end_ts ORDER BY g.rowno))[1] AS end_ts,
           (array_agg(g.week_index ORDER BY g.rowno))[1] AS week_index,
           gen_random_uuid() AS new_id
      FROM _gi_g g
     WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NULL
     GROUP BY g.field_ref, g.gdate, g.start_time;
    UPDATE _gi_g g SET slot_final = COALESCE(g.slot_id, (SELECT s.new_id FROM _gi_slotnew s
                                                          WHERE s.field_id = g.field_ref AND s.gdate = g.gdate AND s.start_time = g.start_time))
     WHERE g.verdict IN ('insert', 'update');
    UPDATE _gi_g g SET flagged = g.flags
                         || CASE WHEN g.slot_id IS NOT NULL AND g.slot_week IS DISTINCT FROM g.week_index
                                  AND NOT ('week-differs' = ANY (g.flags)) THEN ARRAY['week-differs'] ELSE ARRAY[]::text[] END
     WHERE g.verdict IN ('insert', 'update');

    -- ------------------------------------------------------------------ 5. The schedule it makes, and what is carried.
    SELECT sr.id INTO v_prev_run
      FROM public.scheduler_runs sr
     WHERE sr.organization_id = v_org AND sr.run_type = 'game' AND sr.status = 'completed'
       AND (sr.season_settings_id = v_season OR sr.season_id = v_season)
     ORDER BY sr.completed_at DESC, sr.created_at DESC
     LIMIT 1;

    SELECT count(*) FILTER (WHERE verdict = 'insert'), count(*) FILTER (WHERE verdict = 'update'),
           count(*) FILTER (WHERE verdict = 'unchanged'), count(*) FILTER (WHERE verdict = 'skip-held')
      INTO n_ins, n_upd, n_unch, n_skip_pub
      FROM _gi_g;
    SELECT count(*) FILTER (WHERE verdict = 'insert'), count(*) FILTER (WHERE verdict = 'update'),
           count(*) FILTER (WHERE verdict = 'unchanged'), count(*) FILTER (WHERE verdict = 'conflict'),
           count(*) FILTER (WHERE verdict = 'skip-held'), count(*) FILTER (WHERE conv)
      INTO n_tbd_ins, n_tbd_upd, n_tbd_unch, n_tbd_conflict, n_tbd_held, n_conv
      FROM _gi_t;
    -- TIME TBD rows the file now places: one per row, however many placed rows name it.
    SELECT count(DISTINCT g.tbd_id) INTO n_tbd_rem FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.tbd_id IS NOT NULL
       AND g.tbd_id NOT IN (SELECT t.m_id FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict IN ('insert', 'update', 'unchanged'));
    n_skip_pub := n_skip_pub + n_tbd_held;

    -- A matched game the file leaves as it is or skips, but that is not in the latest run, becomes visible again.
    SELECT count(*) INTO n_hidden FROM _gi_g g
     WHERE g.verdict IN ('unchanged', 'skip-held') AND g.m_run IS DISTINCT FROM v_prev_run;
    n_hidden := n_hidden + (SELECT count(*) FROM public.game_assignments ga
                             WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held') AND ga.run_id IS DISTINCT FROM v_prev_run);
    v_work := n_ins + n_upd + n_tbd_ins + n_tbd_upd + n_tbd_rem + n_conv + n_hidden;
    v_nothing := (v_work = 0);

    -- Carried into the new run without a write to the game but its run: every game of the previous latest run that is
    -- not rewritten, and every hidden game the file found. Nothing is carried when there is nothing to apply.
    CREATE TEMP TABLE _gi_carry ON COMMIT DROP AS
    SELECT ga.id
      FROM public.game_assignments ga
     WHERE NOT v_nothing AND ga.organization_id = v_org
       AND ((v_prev_run IS NOT NULL AND ga.run_id = v_prev_run)
            OR ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict IN ('unchanged', 'skip-held'))
            OR ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held'))
       AND ga.id NOT IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update')
       AND ga.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
    SELECT count(*) INTO n_repoint FROM _gi_carry;

    -- The games the previous run held that no row of the file names (listed, never deleted).
    SELECT count(*), COALESCE(jsonb_agg(x.id ORDER BY x.id) FILTER (WHERE x.rn <= c_listed_ids), '[]'::jsonb)
      INTO n_not_in_file, v_not_in_file
      FROM (SELECT ga.id, row_number() OVER (ORDER BY ga.id) AS rn
              FROM public.game_assignments ga
             WHERE v_prev_run IS NOT NULL AND ga.organization_id = v_org AND ga.run_id = v_prev_run
               AND ga.id NOT IN (SELECT g.match_id FROM _gi_g g WHERE g.match_id IS NOT NULL AND g.verdict <> 'collision')
               AND ga.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.ga_id IS NOT NULL)) x;

    -- The schedule the new run holds, for the conflict flags: carried games as they are, rewritten ones as they will be,
    -- new ones as planned.
    CREATE TEMP TABLE _gi_final ON COMMIT DROP AS
    SELECT ga.id AS gid, NULL::text AS rkey, 'g:' || ga.id::text AS skey, ga.field_id, ga.start, ga."end" AS finish,
           ga.home_team_id AS home_id, ga.away_team_id AS away_id, ga.week_index, ga.division
      FROM public.game_assignments ga JOIN _gi_carry c ON c.id = ga.id
    UNION ALL
    SELECT g.match_id, g.row_key, 'g:' || g.match_id::text, g.field_ref, g.start_ts, g.end_ts, g.home_ref, g.away_ref, g.week_index, g.division_name
      FROM _gi_g g WHERE NOT v_nothing AND g.verdict = 'update'
    UNION ALL
    SELECT NULL::uuid, g.row_key, 'r:' || lpad(g.rowno::text, 8, '0'), g.field_ref, g.start_ts, g.end_ts, g.home_ref, g.away_ref, g.week_index, g.division_name
      FROM _gi_g g WHERE NOT v_nothing AND g.verdict = 'insert';

    -- ------------------------------------------------------------------ 6. What would be created, only what a written row uses.
    CREATE TEMP TABLE _gi_newgames ON COMMIT DROP AS
    SELECT g.division_ref, g.field_ref, g.home_ref, g.away_ref FROM _gi_g g WHERE g.verdict IN ('insert', 'update')
    UNION ALL
    SELECT t.division_ref, NULL, t.home_ref, t.away_ref FROM _gi_t t WHERE t.verdict IN ('insert', 'update');

    SELECT count(*) INTO n_div FROM _gi_div d WHERE d.creator AND d.new_id IN (SELECT division_ref FROM _gi_newgames);
    SELECT count(*) INTO n_fld FROM _gi_field f WHERE f.creator AND f.new_id IN (SELECT field_ref FROM _gi_newgames);
    SELECT count(*) INTO n_ven FROM _gi_venue v WHERE v.creator
       AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames));
    SELECT count(*) FILTER (WHERE t.kind = 'shell' AND t.creator), count(*) FILTER (WHERE t.kind = 'ext-new' AND t.creator) INTO n_shell, n_out
      FROM _gi_team t WHERE t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
    SELECT count(*) INTO n_slot_new FROM _gi_slotnew;
    SELECT count(DISTINCT g.slot_id) INTO n_slot_reused FROM _gi_g g
     WHERE g.verdict IN ('insert', 'update', 'unchanged') AND g.slot_id IS NOT NULL;

    -- ------------------------------------------------------------------ 7. The conflict flags the SQL can judge.
    -- The first overlap per field and per own team, as evaluateGameSchedule finds it: games sorted by start, each judged
    -- against the one before. An outside club merges several real teams, so it is never double-booked.
    v_warnings := '[]'::jsonb;
    IF NOT v_nothing THEN
        WITH seq AS (
            SELECT f.field_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division,
                   lag(f.gid) OVER w AS pgid, lag(f.rkey) OVER w AS prkey, lag(f.start) OVER w AS pstart,
                   lag(f.finish) OVER w AS pfinish, lag(f.week_index) OVER w AS pweek, lag(f.division) OVER w AS pdiv
              FROM _gi_final f
             WHERE f.field_id IS NOT NULL AND f.start IS NOT NULL AND f.finish IS NOT NULL
            WINDOW w AS (PARTITION BY f.field_id ORDER BY f.start, f.skey)
        ), first_overlap AS (
            SELECT DISTINCT ON (s.field_id) s.* FROM seq s WHERE s.pfinish IS NOT NULL AND s.start < s.pfinish
             ORDER BY s.field_id, s.start, s.skey
        ), sides AS (
            SELECT f.home_id AS team_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division FROM _gi_final f
            UNION ALL
            SELECT f.away_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division FROM _gi_final f
        ), tseq AS (
            SELECT s.team_id, s.gid, s.rkey, s.skey, s.start, s.finish, s.week_index, s.division,
                   lag(s.gid) OVER w AS pgid, lag(s.rkey) OVER w AS prkey, lag(s.start) OVER w AS pstart,
                   lag(s.finish) OVER w AS pfinish, lag(s.week_index) OVER w AS pweek, lag(s.division) OVER w AS pdiv
              FROM sides s
             WHERE s.start IS NOT NULL AND s.finish IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = s.team_id AND t.is_external)
               AND s.team_id NOT IN (SELECT t.ref FROM _gi_team t WHERE t.kind = 'ext-new')
            WINDOW w AS (PARTITION BY s.team_id ORDER BY s.start, s.skey)
        ), team_overlap AS (
            SELECT DISTINCT ON (t.team_id) t.* FROM tseq t WHERE t.pfinish IS NOT NULL AND t.start < t.pfinish
             ORDER BY t.team_id, t.start, t.skey
        ), flag_rows AS (
            SELECT g.rowno, g.row_key, g.game_id, g.gdate, fl AS flag
              FROM _gi_g g, LATERAL unnest(g.flagged) AS fl
             WHERE g.verdict IN ('insert', 'update')
            UNION ALL
            -- A TIME TBD game's week is judged against its date as a placed game's is: the file's week is kept, and said.
            SELECT t.rowno, t.row_key, t.game_id, t.gdate, fl
              FROM _gi_t t, LATERAL unnest(t.flags) AS fl
             WHERE t.verdict IN ('insert', 'update')
        )
        SELECT COALESCE(jsonb_agg(w.warning ORDER BY w.sort_type, w.sort_key), '[]'::jsonb) INTO v_warnings
          FROM (
            SELECT 1 AS sort_type, o.field_id::text AS sort_key,
                   jsonb_build_object('type', 'field-overlap', 'message', format('Field %s has overlapping games', o.field_id),
                       'details', jsonb_build_object('fieldId', o.field_id, 'conflicts', jsonb_build_array(
                           jsonb_build_object('gameId', o.pgid, 'rowKey', o.prkey, 'start', o.pstart, 'end', o.pfinish, 'weekIndex', o.pweek, 'division', o.pdiv),
                           jsonb_build_object('gameId', o.gid, 'rowKey', o.rkey, 'start', o.start, 'end', o.finish, 'weekIndex', o.week_index, 'division', o.division)))) AS warning
              FROM first_overlap o
            UNION ALL
            SELECT 2, o.team_id::text,
                   jsonb_build_object('type', 'team-double-booked', 'message', format('Team %s has overlapping games', o.team_id),
                       'details', jsonb_build_object('teamId', o.team_id, 'conflicts', jsonb_build_array(
                           jsonb_build_object('gameId', o.pgid, 'rowKey', o.prkey, 'start', o.pstart, 'end', o.pfinish, 'weekIndex', o.pweek, 'division', o.pdiv, 'teamId', o.team_id),
                           jsonb_build_object('gameId', o.gid, 'rowKey', o.rkey, 'start', o.start, 'end', o.finish, 'weekIndex', o.week_index, 'division', o.division, 'teamId', o.team_id))))
              FROM team_overlap o
            UNION ALL
            SELECT CASE fr.flag WHEN 'time-ambiguous' THEN 3 ELSE 4 END, lpad(fr.rowno::text, 8, '0'),
                   jsonb_build_object('type', fr.flag,
                       'message', CASE fr.flag WHEN 'time-ambiguous' THEN 'The clocks repeat this time on its date; the first occurrence was taken.'
                                               WHEN 'bad-time' THEN 'The time could not be read: the game is a TIME TBD game on its date.'
                                               WHEN 'bad-week' THEN 'The Week could not be read or stored: the week was taken from the date.'
                                               ELSE 'The week is not the week the date falls in.' END,
                       'details', jsonb_build_object('rowKey', fr.row_key, 'gameId', fr.game_id, 'date', fr.gdate))
              FROM flag_rows fr
            UNION ALL
            -- A game moved onto the place of a game this same file moves away (a swap, or a chain of moves): written, in an
            -- order the unique place allows, and said.
            SELECT 5, lpad(g.rowno::text, 8, '0'),
                   jsonb_build_object('type', 'games-swapped',
                       'message', 'This game takes the place of a game the file moves away: both are written.',
                       'details', jsonb_build_object('rowKey', g.row_key, 'gameId', g.game_id, 'takesPlaceOf', g.swapped_with))
              FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.swapped_with IS NOT NULL
            UNION ALL
            -- A placed game the file now says has no time: taken out, and a dated TIME TBD game stands for it.
            SELECT 6, lpad(t.rowno::text, 8, '0'),
                   jsonb_build_object('type', 'game-made-time-tbd',
                       'message', 'The file gives this game a date and no time: it is no longer placed, and stands on the TIME TBD list.',
                       'details', jsonb_build_object('rowKey', t.row_key, 'gameId', t.game_id, 'game', t.ga_id, 'date', t.gdate))
              FROM _gi_t t WHERE t.conv) w;
    END IF;

    -- ------------------------------------------------------------------ 8. The answer, from the plan.
    SELECT count(*) FILTER (WHERE final_outcome LIKE 'refused:%'), count(*) FILTER (WHERE final_outcome LIKE 'skipped:%'),
           count(*) FILTER (WHERE final_outcome = 'ok' AND status = 'ok'), count(*) FILTER (WHERE final_outcome = 'ok' AND status = 'tbd')
      INTO n_refused, n_skipped, n_ok, n_tbd
      FROM _gi_work;
    -- A placed row another game's place refuses is refused too (listed, counted, nothing written for it).
    n_refused := n_refused + (SELECT count(*) FROM _gi_g WHERE verdict = 'collision') + n_tbd_conflict;
    n_ok := n_ok - (SELECT count(*) FROM _gi_g WHERE verdict = 'collision');
    n_tbd := n_tbd - n_tbd_conflict;

    SELECT COALESCE(jsonb_object_agg(x.reason, x.n), '{}'::jsonb) INTO v_refused_by_reason
      FROM (SELECT z.reason, count(*) AS n FROM (
                SELECT substr(w.final_outcome, 9) AS reason FROM _gi_work w WHERE w.final_outcome LIKE 'refused:%'
                UNION ALL
                SELECT 'duplicate-row' FROM _gi_g g WHERE g.verdict = 'collision'
                UNION ALL
                SELECT 'duplicate-row' FROM _gi_t t WHERE t.verdict = 'conflict') z GROUP BY z.reason) x;

    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.rowno) FILTER (WHERE x.rn <= c_listed), '[]'::jsonb) INTO v_listed_refused
      FROM (SELECT z.rowno, z.item, row_number() OVER (ORDER BY z.rowno) AS rn FROM (
                SELECT w.rowno,
                       jsonb_build_object('row_number', w.rowno, 'row_key', w.row_key, 'reason', substr(w.final_outcome, 9),
                           'message', CASE substr(w.final_outcome, 9)
                               WHEN 'unknown-division' THEN 'The division ' || to_json(COALESCE(w.division_label, ''))::text || ' is not one of yours: map it to a division, create it, or skip its rows.'
                               WHEN 'unknown-venue' THEN 'The venue ' || to_json(COALESCE(w.venue_label, ''))::text || ' is not one of yours: map it to a venue, create it, or skip its rows.'
                               WHEN 'unknown-field' THEN 'The field ' || to_json(COALESCE(w.field_label, ''))::text || ' is not one of its venue''s: map it to a field, create it, or skip its rows.'
                               WHEN 'unknown-team' THEN CASE WHEN w.home_out AND w.away_out THEN 'Neither team is one of yours: both are outside clubs. A game needs at least one of your teams.'
                                                             ELSE 'A team of this row is not one of your teams in its division: map it to a team, create it, mark it an outside club, or skip its rows.' END
                               WHEN 'label-is-own-team' THEN 'A label was marked as an outside club, but the division has a team of that name: map it to that team instead.'
                               WHEN 'same-team' THEN 'The home and away teams were mapped to the same team.'
                               WHEN 'duplicate-row' THEN 'After mapping, this is the same game as an earlier row of the file; the earlier row is the one imported.'
                               WHEN 'game-id-reused' THEN 'The Game ID belongs to a different game earlier in the file.'
                               ELSE COALESCE(w.parse_message, 'The file check refused this row.') END) AS item
                  FROM _gi_work w WHERE w.final_outcome LIKE 'refused:%'
                UNION ALL
                SELECT g.rowno,
                       jsonb_build_object('row_number', g.rowno, 'row_key', g.row_key, 'reason', 'duplicate-row',
                           'message', CASE WHEN g.dup_target
                               THEN 'Another row of this file names the same saved game as this row (one by its Game ID, one by its teams, place and week), and one saved game cannot be written twice. The other row is the one imported; nothing is written for this row.'
                               ELSE 'A game this file does not move already stands on this place, and this row''s Game ID (or the lack of one) does not name it. Nothing is written for the row.' END)
                  FROM _gi_g g WHERE g.verdict = 'collision'
                UNION ALL
                SELECT t.rowno,
                       jsonb_build_object('row_number', t.rowno, 'row_key', t.row_key, 'reason', 'duplicate-row',
                           'message', CASE WHEN t.dup_target
                               THEN 'Another row of this file names the same saved game as this row (one by its Game ID, one by its teams, place and week), and one saved game cannot be written twice. The other row is the one imported; nothing is written for this row.'
                               ELSE 'Another TIME TBD game already holds this home team, away team and week, and this row''s Game ID (or the lack of one) does not name it. Nothing is written for the row.' END)
                  FROM _gi_t t WHERE t.verdict = 'conflict') z) x;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('row_number', w.rowno, 'row_key', w.row_key,
                        'kind', substr(w.final_outcome, 9), 'label', w.skip_label) ORDER BY w.rowno)
                    FILTER (WHERE w.rn <= c_listed), '[]'::jsonb) INTO v_listed_skipped
      FROM (SELECT z.*, row_number() OVER (ORDER BY z.rowno) AS rn FROM _gi_work z WHERE z.final_outcome LIKE 'skipped:%') w;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('row_number', g.rowno, 'row_key', g.row_key, 'game_id', g.game_id,
                        'game', g.match_id,
                        'reason', CASE WHEN g.match_id = ANY (v_held_scored) THEN c_skip_scored ELSE c_skip_published END)
                    ORDER BY g.rowno) FILTER (WHERE g.rn <= c_listed), '[]'::jsonb)
      INTO v_listed_games
      FROM (SELECT z.rowno, z.row_key, z.game_id, z.match_id, row_number() OVER (ORDER BY z.rowno) AS rn
              FROM (SELECT g2.rowno, g2.row_key, g2.game_id, g2.match_id FROM _gi_g g2 WHERE g2.verdict = 'skip-held'
                    UNION ALL
                    SELECT t.rowno, t.row_key, t.game_id, t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held') z) g;
    SELECT count(*) INTO n_skip_scored
      FROM (SELECT g2.match_id AS id FROM _gi_g g2 WHERE g2.verdict = 'skip-held'
            UNION ALL
            SELECT t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held') z
     WHERE z.id = ANY (v_held_scored);
    v_skipped_obj := CASE WHEN n_skip_pub - n_skip_scored > 0 THEN jsonb_build_object(c_skip_published, n_skip_pub - n_skip_scored) ELSE '{}'::jsonb END
                  || CASE WHEN n_skip_scored > 0 THEN jsonb_build_object(c_skip_scored, n_skip_scored) ELSE '{}'::jsonb END;

    v_result := jsonb_build_object(
        'dry_run', v_dry,
        'job_id', p_import_job_id,
        'season_settings_id', v_season,
        'arrive_published', v_arrive,
        'rows', jsonb_build_object('staged', n_staged, 'refused', n_refused, 'skipped', n_skipped, 'games', n_ok, 'time_tbd', n_tbd),
        'refused_by_reason', v_refused_by_reason,
        'games', jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'unchanged', n_unch, 'repointed', n_repoint,
                                    'skipped', v_skipped_obj),
        'time_tbd', jsonb_build_object('inserted', n_tbd_ins, 'updated', n_tbd_upd, 'unchanged', n_tbd_unch, 'removed', n_tbd_rem,
                                       'converted', n_conv),
        'created', jsonb_build_object('divisions', n_div, 'venues', n_ven, 'fields', n_fld, 'teams', n_shell,
                                      'outside_teams', n_out, 'slots', n_slot_new),
        'reused', jsonb_build_object('slots', n_slot_reused),
        'not_in_file', jsonb_build_object('count', n_not_in_file, 'ids', v_not_in_file),
        'nothing_to_apply', v_nothing,
        'warnings', v_warnings,
        'not_judged', jsonb_build_array('coach-conflict', 'home-away-imbalance'),
        'listed', jsonb_build_object('refused', v_listed_refused, 'skipped', v_listed_skipped, 'skipped_games', v_listed_games),
        'ids', v_ids);

    IF v_dry THEN
        RETURN v_result;
    END IF;

    -- Compare inside the game/season writer locks with the plan that this statement is about to write.
    IF jsonb_typeof(p_confirmed_counts) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Preview the import and confirm its counts before applying.'
            USING ERRCODE = '22023', DETAIL = 'confirmed_counts_required';
    END IF;
    IF jsonb_typeof(p_confirmed_counts -> 'arrive_published') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(p_confirmed_counts -> 'nothing_to_apply') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(p_confirmed_counts -> 'rows.staged') IS DISTINCT FROM 'number'
       OR (SELECT count(*) FROM jsonb_object_keys(p_confirmed_counts)) > 120
       OR EXISTS (SELECT 1 FROM jsonb_each(p_confirmed_counts) c
                   WHERE length(c.key) > 80 OR jsonb_typeof(c.value) NOT IN ('number','boolean')) THEN
        RAISE EXCEPTION 'The confirmed counts do not have the shape of a games preview.'
            USING ERRCODE = '22023', DETAIL = 'confirmed_counts_required';
    END IF;
    v_current_counts := public.game_import_confirm_counts(v_result);
    -- An absent numeric count is zero. Boolean false and numeric zero are distinct in the client contract.
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_current_counts || p_confirmed_counts) AS k(key)
                WHERE coalesce(v_current_counts -> k.key, '0'::jsonb)
                      IS DISTINCT FROM coalesce(p_confirmed_counts -> k.key, '0'::jsonb)) THEN
        RAISE EXCEPTION 'The schedule changed after this preview. Review the new preview and confirm again.'
            USING ERRCODE = '22023', DETAIL = 'game_import_preview_stale';
    END IF;

    -- ------------------------------------------------------------------ 9. The writes, in order, each counted against the plan.
    IF NOT v_nothing THEN
        -- The before-images of every game the run change or the rewrite touches (a rollback puts them back).
        CREATE TEMP TABLE _gi_before ON COMMIT DROP AS
        SELECT ga.id, to_jsonb(ga) AS img FROM public.game_assignments ga
         WHERE ga.id IN (SELECT id FROM _gi_carry) OR ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update');
        -- The before-images of the TIME TBD rows the file changes or removes (a rollback puts them back).
        CREATE TEMP TABLE _gi_tbefore ON COMMIT DROP AS
        SELECT s.id, to_jsonb(s) AS img, (s.id IN (SELECT t.m_id FROM _gi_t t WHERE t.verdict = 'update')) AS changed
          FROM public.schedule_tbd s
         WHERE s.id IN (SELECT t.m_id FROM _gi_t t WHERE t.verdict = 'update')
            OR s.id IN (SELECT g.tbd_id FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.tbd_id IS NOT NULL
                           AND g.tbd_id NOT IN (SELECT t.m_id FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict IN ('insert', 'update', 'unchanged')));

        -- Divisions, venues, fields.
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
        SELECT d.new_id, v_org, v_season, d.cname FROM _gi_div d
         WHERE d.creator AND d.new_id IN (SELECT division_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_div THEN RAISE EXCEPTION 'game import planned % divisions and wrote %', n_div, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'divisions', dv.id, 'inserted', NULL, to_jsonb(dv), v_now, v_uid
          FROM public.divisions dv WHERE dv.id IN (SELECT d.new_id FROM _gi_div d WHERE d.can_create AND d.new_id IN (SELECT division_ref FROM _gi_newgames));

        INSERT INTO public.locations (id, organization_id, name)
        SELECT v.new_id, v_org, v.cname FROM _gi_venue v
         WHERE v.creator AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_ven THEN RAISE EXCEPTION 'game import planned % venues and wrote %', n_ven, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'locations', l.id, 'inserted', NULL, to_jsonb(l), v_now, v_uid
          FROM public.locations l WHERE l.id IN (SELECT v.new_id FROM _gi_venue v WHERE v.can_create
               AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames)));

        INSERT INTO public.fields (id, organization_id, location_id, name)
        SELECT f.new_id, v_org, f.venue_ref, f.cname FROM _gi_field f
         WHERE f.creator AND f.new_id IN (SELECT field_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_fld THEN RAISE EXCEPTION 'game import planned % fields and wrote %', n_fld, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'fields', f.id, 'inserted', NULL, to_jsonb(f), v_now, v_uid
          FROM public.fields f WHERE f.id IN (SELECT x.new_id FROM _gi_field x WHERE x.can_create AND x.new_id IN (SELECT field_ref FROM _gi_newgames));

        -- Team shells, through the audited team writer, in ONE team run for the whole apply. The Teams, Practices and Games
        -- pages read the LATEST team run (`mapSchedulerRunToSummary` reads `results.teamsByDivision`), so the run is the
        -- latest completed run's results carried forward whole (every key, every division it names) with each division's
        -- shells added to the division: a run of only the new shells, or of one division, would make every other team look
        -- absent, and one run in the keys `TEAM_RUN_RESULT_KEYS` (packages/core/src/utils/teamRunResults.js, which the mock
        -- uses; tests/gameImportTeamRunShape.test.js holds this text to that list) carries what the readers read. A division
        -- is grouped under the key the carried run already uses for it (its id, its name, or the key of a group whose teams
        -- carry its id), else under its name; a division no saved run names is seeded with its own teams as the table has
        -- them (an outside club is not one).
        SELECT COALESCE(array_agg(t.new_id ORDER BY t.new_id), ARRAY[]::uuid[]) INTO v_shell_arr
          FROM _gi_team t
         WHERE t.kind = 'shell' AND t.creator AND t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
        IF cardinality(v_shell_arr) > 0 THEN
            SELECT sr.results INTO v_base
              FROM public.scheduler_runs sr
             WHERE sr.organization_id = v_org AND sr.run_type = 'team' AND sr.status = 'completed'
               AND (sr.season_settings_id = v_season OR sr.season_id = v_season)
             ORDER BY sr.created_at DESC, sr.id DESC
             LIMIT 1;
            IF jsonb_typeof(v_base) IS DISTINCT FROM 'object' THEN v_base := '{}'::jsonb; END IF;
            IF jsonb_typeof(v_base -> 'teamsByDivision') = 'object' THEN
                SELECT COALESCE(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END), '{}'::jsonb)
                  INTO v_grouped FROM jsonb_each(v_base -> 'teamsByDivision') e;
            ELSIF jsonb_typeof(v_base -> 'teams') = 'array' THEN
                SELECT COALESCE(jsonb_object_agg(g.k, g.arr), '{}'::jsonb) INTO v_grouped
                  FROM (SELECT COALESCE(NULLIF(et ->> 'division', ''), NULLIF(et ->> 'division_id', ''), 'Unassigned') AS k,
                               jsonb_agg(et ORDER BY x.ord) AS arr
                          FROM jsonb_array_elements(v_base -> 'teams') WITH ORDINALITY AS x(et, ord) GROUP BY 1) g;
            ELSE
                v_grouped := '{}'::jsonb;
            END IF;
            FOR v_div IN
                SELECT t.division_ref,
                       (SELECT d.final_name FROM _gi_div d WHERE d.ref = t.division_ref ORDER BY d.dkey LIMIT 1) AS dname
                  FROM _gi_team t
                 WHERE t.kind = 'shell' AND t.creator AND t.new_id = ANY (v_shell_arr)
                 GROUP BY t.division_ref
                 ORDER BY t.division_ref
            LOOP
                SELECT e.key INTO v_key
                  FROM jsonb_each(v_grouped) e
                 WHERE lower(e.key) = lower(v_div.division_ref::text) OR e.key = v_div.dname
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.value) et
                                WHERE lower(COALESCE(et ->> 'division_id', et ->> 'divisionId', '')) = lower(v_div.division_ref::text))
                 ORDER BY e.key COLLATE "C"
                 LIMIT 1;
                IF v_key IS NULL THEN
                    v_key := v_div.dname;
                    v_grouped := v_grouped || jsonb_build_object(v_key, COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'division', v_key, 'division_id', v_div.division_ref,
                                   'coachId', t.coach_id, 'assistantCoachIds', to_jsonb(COALESCE(t.assistant_coach_ids, '{}'::uuid[])),
                                   'players', '[]'::jsonb) ORDER BY t.name, t.id)
                          FROM public.teams t
                         WHERE t.division_id = v_div.division_ref AND NOT t.is_external AND t.id <> ALL (v_shell_arr)), '[]'::jsonb));
                END IF;
                v_label := COALESCE(NULLIF(v_grouped -> v_key -> 0 ->> 'division', ''), v_key);
                v_grouped := jsonb_set(v_grouped, ARRAY[v_key], (v_grouped -> v_key) || COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('id', t.new_id, 'name', t.cname, 'division', v_label, 'division_id', v_div.division_ref,
                               'coachId', NULL, 'assistantCoachIds', '[]'::jsonb, 'players', '[]'::jsonb) ORDER BY t.cname, t.new_id)
                      FROM _gi_team t
                     WHERE t.kind = 'shell' AND t.creator AND t.division_ref = v_div.division_ref AND t.new_id = ANY (v_shell_arr)), '[]'::jsonb));
            END LOOP;
            v_results := v_base || jsonb_build_object(
                'teamsByDivision', v_grouped,
                'teams', COALESCE((SELECT jsonb_agg(x.team) FROM jsonb_each(v_grouped) e, jsonb_array_elements(e.value) AS x(team)), '[]'::jsonb),
                'team_players', CASE WHEN jsonb_typeof(v_base -> 'team_players') = 'array' THEN v_base -> 'team_players' ELSE '[]'::jsonb END);
            v_team_run := public.persist_team_schedule(
                jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'team', 'status', 'completed',
                    'completed_at', clock_timestamp(),
                    'parameters', jsonb_build_object('source', 'import', 'import_job_id', p_import_job_id, 'shell_ids', to_jsonb(v_shell_arr)),
                    'results', v_results),
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.new_id, 'division_id', t.division_ref, 'name', t.cname) ORDER BY t.new_id), '[]'::jsonb)
                   FROM _gi_team t WHERE t.kind = 'shell' AND t.creator AND t.new_id = ANY (v_shell_arr)),
                '[]'::jsonb);
            v_team_runs := v_team_runs || to_jsonb(v_team_run);
        END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'teams', t.id, 'inserted', NULL, to_jsonb(t), v_now, v_uid
          FROM public.teams t WHERE t.id IN (SELECT x.new_id FROM _gi_team x WHERE x.kind = 'shell'
               AND x.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_shell THEN RAISE EXCEPTION 'game import planned % team shells and wrote %', n_shell, v_rc USING ERRCODE = 'XX000'; END IF;

        -- Outside clubs: team rows flagged is_external, in NO team run.
        INSERT INTO public.teams (id, organization_id, division_id, name, is_external)
        SELECT t.new_id, v_org, t.division_ref, t.cname, true FROM _gi_team t
         WHERE t.kind = 'ext-new' AND t.creator AND t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_out THEN RAISE EXCEPTION 'game import planned % outside clubs and wrote %', n_out, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'teams', t.id, 'inserted', NULL, to_jsonb(t), v_now, v_uid
          FROM public.teams t WHERE t.is_external AND t.id IN (SELECT x.new_id FROM _gi_team x WHERE x.kind = 'ext-new'
               AND x.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames));

        -- Slots.
        INSERT INTO public.game_slots (id, organization_id, field_id, start, "end", slot_date, start_time, end_time, week_index, capacity)
        SELECT s.new_id, v_org, s.field_id, s.start_ts, s.end_ts, s.gdate, s.start_time, s.end_time, s.week_index, 1 FROM _gi_slotnew s;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_slot_new THEN RAISE EXCEPTION 'game import planned % slots and wrote %', n_slot_new, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_slots', gs.id, 'inserted', NULL, to_jsonb(gs), v_now, v_uid
          FROM public.game_slots gs WHERE gs.id IN (SELECT new_id FROM _gi_slotnew);

        -- The run: made last of the structure, first of the games, so every game can name it.
        INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, parameters, metrics, results,
                                           created_by, started_at, completed_at, created_at)
        VALUES (v_run_id, v_org, v_season, v_season, 'game', 'completed',
                jsonb_build_object('source', 'import', 'import_job_id', p_import_job_id, 'arrive_published', v_arrive,
                                   'previous_run_id', v_prev_run),
                '{}'::jsonb,
                jsonb_build_object('summary', jsonb_build_object('totalAssignments', n_ins + n_upd + n_repoint, 'source', 'import'),
                                   'warnings', v_warnings, 'unscheduled', '[]'::jsonb, 'not_judged', jsonb_build_array('coach-conflict', 'home-away-imbalance'),
                                   'import_job_id', p_import_job_id),
                v_uid, clock_timestamp(), clock_timestamp(), clock_timestamp());

        -- Placed games the file now says have no time are taken out (a dated TIME TBD game stands for each, below). Only a
        -- game that is not held is here (a held one was skipped), and its image is kept so a rollback can put it back.
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', ga.id, 'deleted', to_jsonb(ga), '{}'::jsonb, v_now, v_uid
          FROM public.game_assignments ga WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
        DELETE FROM public.game_assignments ga WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_conv THEN RAISE EXCEPTION 'game import planned % games made TIME TBD and removed %', n_conv, v_rc USING ERRCODE = 'XX000'; END IF;

        -- Room is made first (as `persist_game_schedule` makes it, 20261120010000): the unique place (home, away, slot, week) is
        -- not deferrable, so a game that leaves a place another row of this file is about to take would meet that row in the
        -- index whichever is written first. A game that moves, and whose place a row of the file takes, is taken out of the
        -- index (its slot set null for the length of this apply) and given its final place by the update below, in this
        -- transaction. The clashes with games the file does NOT move were refused in the plan, so no game ends where another is.
        UPDATE public.game_assignments ga SET game_slot_id = NULL, slot_id = NULL
         WHERE ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update' AND g.leaves)
           AND EXISTS (SELECT 1 FROM _gi_g h
                        WHERE h.verdict IN ('insert', 'update') AND h.slot_final = ga.game_slot_id
                          AND h.home_ref = ga.home_team_id AND h.away_ref = ga.away_team_id AND h.week_index = ga.week_index);

        -- New games, Published when the job says so (decision 4).
        INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, game_slot_id, slot_id, field_id, home_team_id,
                                             away_team_id, division, week_index, start, "end", external_ref, import_job_id,
                                             published, published_at, published_by)
        SELECT g.new_id, v_org, v_season, v_run_id, g.slot_final, g.slot_final, g.field_ref, g.home_ref, g.away_ref, g.division_name,
               g.week_index, g.start_ts, g.end_ts, COALESCE(g.game_id, g.carry_ref), p_import_job_id,
               v_arrive, CASE WHEN v_arrive THEN v_now END, CASE WHEN v_arrive THEN v_uid END
          FROM _gi_g g WHERE g.verdict = 'insert';
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_ins THEN RAISE EXCEPTION 'game import planned % games and wrote %', n_ins, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', ga.id, 'inserted', NULL, to_jsonb(ga), v_now, v_uid
          FROM public.game_assignments ga WHERE ga.id IN (SELECT new_id FROM _gi_g WHERE verdict = 'insert');
        SELECT COALESCE(array_agg(g.new_id ORDER BY g.new_id), ARRAY[]::uuid[]) INTO v_published_ids FROM _gi_g g WHERE g.verdict = 'insert' AND v_arrive;

        -- Games changed in place, by id: a held game is never here (it was skipped).
        UPDATE public.game_assignments ga
           SET game_slot_id = g.slot_final, slot_id = g.slot_final, field_id = g.field_ref, home_team_id = g.home_ref, away_team_id = g.away_ref,
               division = g.division_name, week_index = g.week_index, start = g.start_ts, "end" = g.end_ts,
               run_id = v_run_id, import_job_id = p_import_job_id
          FROM _gi_g g
         WHERE g.verdict = 'update' AND ga.id = g.match_id;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_upd THEN RAISE EXCEPTION 'game import planned % game updates and wrote %', n_upd, v_rc USING ERRCODE = 'XX000'; END IF;

        -- The rest of the previous schedule, and the hidden games the file found, are carried into the new run.
        UPDATE public.game_assignments ga SET run_id = v_run_id WHERE ga.id IN (SELECT id FROM _gi_carry);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_repoint THEN RAISE EXCEPTION 'game import planned % carried games and moved %', n_repoint, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', b.id, 'updated', b.img, to_jsonb(ga), v_now, v_uid
          FROM _gi_before b JOIN public.game_assignments ga ON ga.id = b.id;

        -- TIME TBD games: a DATE and no time (`game_date`), the Game ID in `external_ref`. A row the file names is changed in
        -- place; one the file now places is removed (the placed game stands for it); a new one is inserted. Every one has an
        -- application record, with the image it had, so the rollback puts it back.
        UPDATE public.schedule_tbd s
           SET division_id = t.division_ref, home_team_id = t.home_ref, away_team_id = t.away_ref, week_index = t.week_index::smallint,
               external_ref = COALESCE(t.game_id, s.external_ref), game_date = t.gdate, reason = 'imported-without-time',
               detail = jsonb_strip_nulls(jsonb_build_object('game_id', COALESCE(t.game_id, s.external_ref), 'import_job_id', p_import_job_id)),
               run_id = v_run_id
          FROM _gi_t t WHERE t.verdict = 'update' AND s.id = t.m_id;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_upd THEN RAISE EXCEPTION 'game import planned % TIME TBD updates and wrote %', n_tbd_upd, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', s.id, 'updated', b.img, to_jsonb(s), v_now, v_uid
          FROM _gi_tbefore b JOIN public.schedule_tbd s ON s.id = b.id WHERE b.changed;
        DELETE FROM public.schedule_tbd s WHERE s.id IN (SELECT b.id FROM _gi_tbefore b WHERE NOT b.changed);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_rem THEN RAISE EXCEPTION 'game import planned % TIME TBD removals and made %', n_tbd_rem, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', b.id, 'deleted', b.img, '{}'::jsonb, v_now, v_uid
          FROM _gi_tbefore b WHERE NOT b.changed;
        INSERT INTO public.schedule_tbd (id, organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index,
                                         reason, detail, run_id, external_ref, game_date)
        SELECT t.new_id, v_org, v_season, 'game', t.division_ref, t.home_ref, t.away_ref, t.week_index::smallint, 'imported-without-time',
               jsonb_strip_nulls(jsonb_build_object('game_id', t.game_id, 'import_job_id', p_import_job_id)), v_run_id, t.game_id, t.gdate
          FROM _gi_t t WHERE t.verdict = 'insert';
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_ins THEN RAISE EXCEPTION 'game import planned % TIME TBD games and wrote %', n_tbd_ins, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', s.id, 'inserted', NULL, to_jsonb(s), v_now, v_uid
          FROM public.schedule_tbd s WHERE s.id IN (SELECT t.new_id FROM _gi_t t WHERE t.verdict = 'insert');

        v_ids := jsonb_build_object('run_id', v_run_id, 'team_run_ids', v_team_runs);
    END IF;

    v_result := v_result || jsonb_build_object('ids', v_ids);
    v_status := CASE WHEN n_refused > 0 THEN 'completed_with_warnings' ELSE 'completed' END;

    -- The audit rows, in this transaction. A failed write rolls the apply back; SLA01 tells the caller it was the audit.
    BEGIN
        PERFORM public.record_audit_event(v_org, 'import.completed', 'import_job', p_import_job_id,
            jsonb_build_object('import_type', 'games', 'job_type', 'games', 'season_settings_id', v_season, 'status', v_status,
                               'rows', v_result -> 'rows', 'games', v_result -> 'games', 'time_tbd', v_result -> 'time_tbd',
                               'created', v_result -> 'created', 'reused', v_result -> 'reused',
                               'nothing_to_apply', v_nothing, 'arrive_published', v_arrive));
        IF cardinality(v_published_ids) > 0 THEN
            PERFORM public.record_audit_event(v_org, 'game.published_set', 'game_assignment', NULL,
                jsonb_build_object('published', true, 'scope', jsonb_build_object('kind', 'import', 'value', p_import_job_id::text),
                                   'count', cardinality(v_published_ids), 'unchanged', 0, 'ids', to_jsonb(v_published_ids)));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    UPDATE public.staging_import_rows SET applied_at = v_now, applied_by = v_uid
     WHERE import_job_id = p_import_job_id AND organization_id = v_org AND import_type = 'games';
    UPDATE public.import_jobs
       SET status = v_status, processed_rows = n_staged, progress_percent = 100, completed_at = v_now,
           warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{game_import}', v_result, true)
     WHERE id = p_import_job_id;

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_practice_import_job(p_import_job_id uuid, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    -- The closed list of reasons a row is listed and not written (packages/core/src/practiceImport/reasonCodes.js,
    -- PRACTICE_IMPORT_ROW_REFUSALS). A staged row the parse refused carries one of them; the apply adds the ones it can
    -- only know once the labels are mapped and the slots are found.
    c_row_refusals constant text[] := ARRAY[
        'bad-use', 'bad-day', 'bad-time', 'bad-length', 'end-not-after-start', 'bad-capacity', 'capacity-not-positive',
        'bad-date', 'valid-until-before-from', 'outside-season-window', 'missing-dates', 'unknown-division', 'unknown-team',
        'unknown-location', 'unknown-field', 'unknown-subunit', 'team-in-two-divisions', 'slot-overlaps-another', 'duplicate-row'];
    -- The parse's flags a staged row may carry (core's PRACTICE_STAGED_FLAGS).
    c_staged_flags constant text[] := ARRAY['division-not-reserved'];
    c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_uid uuid := auth.uid();
    v_dry boolean := COALESCE(p_dry_run, false);
    v_job public.import_jobs%ROWTYPE;
    v_org uuid;
    v_season uuid;
    v_season_status text;
    v_season_start date;
    v_season_end date;
    v_map jsonb;
    v_add text[];
    v_now timestamptz := now();
    v_bad_row integer;
    v_rc bigint;
    v_planned bigint;
    v_grp record;
    v_slot record;
    v_ids uuid[];
    v_tbd jsonb;
    v_result jsonb;
    v_status text;
    v_team_run uuid;
    v_shell_arr uuid[];
    v_div record;
    v_base jsonb; v_grouped jsonb; v_results jsonb; v_key text; v_label text;
    n_staged integer;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'apply_practice_import_job needs a signed-in caller' USING ERRCODE = '42501';
    END IF;
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    v_org := v_job.organization_id;
    IF NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_org USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'practice_schedule' THEN
        RAISE EXCEPTION 'Import job % is %, not practice_schedule', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;
    -- The season writers' lock (completion and rollover take it), then the practice writer's own season lock (the save and
    -- the TIME TBD refresh take it), so an import and a save cannot interleave; THEN the job is read again, held, and
    -- judged as it stands (apply_game_import_job's order): a second caller that waited on the locks finds the first one's
    -- completed job and replays it, never applies it twice. A dry run takes them too: it writes.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('persist_practice_schedule:' || v_org::text || ':' || v_job.season_settings_id::text, 0));
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;

    -- A finished job answers with the result it stored (a retry after a lost response writes nothing).
    IF v_job.status IN ('completed', 'completed_with_warnings') THEN
        IF v_job.warning_summary ? 'practice_import' THEN
            RETURN (v_job.warning_summary -> 'practice_import') || jsonb_build_object('replayed', true);
        END IF;
        RAISE EXCEPTION 'Import job % is already %', p_import_job_id, v_job.status USING ERRCODE = '22023';
    END IF;
    IF v_job.status IN ('failed', 'needs_fix') THEN
        RAISE EXCEPTION '% import job % cannot be applied: a new file is a new job', initcap(v_job.status), p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'import_not_ready_to_apply';
    END IF;
    -- Only a job whose staging finished (mark_import_job_ready_to_apply) is applied: one still importing may be missing rows.
    IF v_job.status <> 'ready_to_apply' THEN
        RAISE EXCEPTION 'Import job % is %, not ready_to_apply: stage the whole file first', p_import_job_id, v_job.status
            USING ERRCODE = '22023', DETAIL = 'import_not_ready_to_apply';
    END IF;
    v_season := v_job.season_settings_id;
    SELECT s.status, s.season_start, s.season_end INTO v_season_status, v_season_start, v_season_end
      FROM public.season_settings s WHERE s.id = v_season AND s.organization_id = v_org;
    IF v_season_status IS NULL THEN
        RAISE EXCEPTION 'Import job % has no season to import into', p_import_job_id USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no practice schedule import: only the active season does', v_season, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;
    v_map := v_job.warning_summary -> 'practice_mapping';
    IF v_map IS NULL THEN
        RAISE EXCEPTION 'Import job % has no mapping: confirm what each label of the file is first', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'mapping_required';
    END IF;
    v_add := ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_map -> 'options' -> 'add_moved_rows', '[]'::jsonb)));

    -- Everything below is ONE code path for the preview and the apply. A dry run ends in a sentinel exception after the
    -- result is in v_result, so every write rolls back with the sub-block (plan 4.11.4).
    BEGIN
        -- A second apply in one transaction finds the first one's tables (they drop at commit); asked first, so a call
        -- prints no notice.
        IF to_regclass('pg_temp._pi_rows') IS NOT NULL THEN
            DROP TABLE IF EXISTS pg_temp._pi_rows, pg_temp._pi_dec, pg_temp._pi_div, pg_temp._pi_loc, pg_temp._pi_fld,
                pg_temp._pi_sub, pg_temp._pi_team, pg_temp._pi_grp, pg_temp._pi_asg, pg_temp._pi_leave, pg_temp._pi_flag;
        END IF;

        -- ------------------------------------------------------------ 1. The staged rows, read once.
        CREATE TEMP TABLE _pi_rows ON COMMIT DROP AS
        SELECT sr.source_row_number AS rowno,
               (sr.normalized_payload IS NULL OR COALESCE(jsonb_array_length(sr.validation_errors), 0) > 0) AS parse_refused,
               sr.validation_errors -> 0 ->> 'code' AS parse_reason,
               sr.validation_errors -> 0 ->> 'message' AS parse_message,
               sr.normalized_payload ->> 'row_key' AS row_key,
               sr.normalized_payload ->> 'status' AS status,
               CASE WHEN sr.normalized_payload ->> 'day' IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
                    THEN (sr.normalized_payload ->> 'day')::public.day_of_week END AS dow,
               CASE WHEN sr.normalized_payload ->> 'start_time' ~ '^([01]\d|2[0-3]):[0-5]\d$' THEN (sr.normalized_payload ->> 'start_time')::time END AS start_time,
               CASE WHEN sr.normalized_payload ->> 'end_time' ~ '^([01]\d|2[0-3]):[0-5]\d$' THEN (sr.normalized_payload ->> 'end_time')::time END AS end_time,
               CASE WHEN sr.normalized_payload ->> 'valid_from' ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
                         AND to_char(to_date(sr.normalized_payload ->> 'valid_from', 'YYYY-MM-DD'), 'YYYY-MM-DD') = sr.normalized_payload ->> 'valid_from'
                    THEN (sr.normalized_payload ->> 'valid_from')::date END AS valid_from,
               CASE WHEN sr.normalized_payload ->> 'valid_until' ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
                         AND to_char(to_date(sr.normalized_payload ->> 'valid_until', 'YYYY-MM-DD'), 'YYYY-MM-DD') = sr.normalized_payload ->> 'valid_until'
                    THEN (sr.normalized_payload ->> 'valid_until')::date END AS valid_until,
               CASE WHEN jsonb_typeof(sr.normalized_payload -> 'capacity') = 'number' AND (sr.normalized_payload ->> 'capacity') ~ '^\d{1,5}$'
                         AND (sr.normalized_payload ->> 'capacity')::integer BETWEEN 1 AND 32767
                    THEN (sr.normalized_payload ->> 'capacity')::smallint END AS capacity,
               CASE WHEN jsonb_typeof(sr.normalized_payload -> 'flags') = 'array'
                    THEN ARRAY(SELECT jsonb_array_elements_text(sr.normalized_payload -> 'flags')) END AS flags,
               btrim(COALESCE(sr.normalized_payload ->> 'division', ''), E' \t\r\n') AS division_label,
               COALESCE(sr.normalized_payload ->> 'division_key', '') AS division_key,
               btrim(COALESCE(sr.normalized_payload ->> 'location', ''), E' \t\r\n') AS location_label,
               COALESCE(sr.normalized_payload ->> 'location_key', '') AS location_key,
               btrim(COALESCE(sr.normalized_payload ->> 'field', ''), E' \t\r\n') AS field_label,
               COALESCE(sr.normalized_payload ->> 'field_key', '') AS field_key,
               btrim(COALESCE(sr.normalized_payload ->> 'subunit', ''), E' \t\r\n') AS subunit_label,
               COALESCE(sr.normalized_payload ->> 'subunit_key', '') AS subunit_key,
               btrim(COALESCE(sr.normalized_payload ->> 'team', ''), E' \t\r\n') AS team_label,
               COALESCE(sr.normalized_payload ->> 'team_key', '') AS team_key
          FROM public.staging_import_rows sr
         WHERE sr.import_job_id = p_import_job_id AND sr.organization_id = v_org AND sr.import_type = 'practice_schedule';

        SELECT count(*) INTO n_staged FROM _pi_rows;
        IF n_staged = 0 THEN
            RAISE EXCEPTION 'Import job % has no staged practice rows', p_import_job_id USING ERRCODE = '22023', DETAIL = 'no_rows';
        END IF;
        -- A staged row is the Edge function's work: a malformed one is a defect there, not a row to guess at. The whole
        -- apply refuses, naming the first.
        SELECT r.rowno INTO v_bad_row FROM _pi_rows r
         WHERE r.rowno IS NULL
            OR (r.parse_refused AND NOT (COALESCE(r.parse_reason, '') = ANY (c_row_refusals)))
            OR (NOT r.parse_refused AND NOT (
                    r.status IN ('placement', 'open', 'hold') AND COALESCE(r.row_key, '') <> '' AND char_length(r.row_key) <= 100
                    AND r.dow IS NOT NULL AND r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND r.end_time > r.start_time
                    AND r.valid_from IS NOT NULL AND r.valid_until IS NOT NULL AND r.valid_until >= r.valid_from
                    AND (r.status = 'hold' OR r.capacity IS NOT NULL)
                    AND r.location_label <> '' AND r.location_key <> '' AND r.field_label <> '' AND r.field_key <> ''
                    AND ((r.subunit_label = '') = (r.subunit_key = ''))
                    AND (CASE WHEN r.status = 'placement'
                              THEN r.division_label <> '' AND r.division_key <> '' AND r.team_label <> '' AND r.team_key <> ''
                              ELSE r.team_label = '' AND r.team_key = '' AND r.division_key = '' END)
                    AND r.flags IS NOT NULL AND r.flags <@ c_staged_flags))
         ORDER BY r.rowno NULLS FIRST LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION 'staged row % is not a practice row', v_bad_row USING ERRCODE = '22023', DETAIL = 'practice_import_staged_invalid';
        END IF;
        IF EXISTS (SELECT 1 FROM _pi_rows WHERE NOT parse_refused GROUP BY row_key HAVING count(*) > 1)
           OR EXISTS (SELECT 1 FROM _pi_rows GROUP BY rowno HAVING count(*) > 1) THEN
            RAISE EXCEPTION 'two staged rows share a row key or a row number' USING ERRCODE = '22023', DETAIL = 'practice_import_staged_invalid';
        END IF;

        ALTER TABLE _pi_rows
            ADD COLUMN outcome text, ADD COLUMN reason text, ADD COLUMN message text, ADD COLUMN skip_kind text,
            ADD COLUMN skip_label text, ADD COLUMN div_ref uuid, ADD COLUMN loc_ref uuid, ADD COLUMN fld_ref uuid,
            ADD COLUMN sub_ref uuid, ADD COLUMN team_ref uuid;
        UPDATE _pi_rows SET outcome = 'refused', reason = parse_reason, message = parse_message WHERE parse_refused;
        UPDATE _pi_rows SET outcome = 'ok' WHERE NOT parse_refused;
        -- The season's window, judged again here (the parse judged it against what the browser read).
        UPDATE _pi_rows SET outcome = 'refused', reason = 'outside-season-window',
               message = format('The dates %s to %s are outside the season (%s to %s).', valid_from, valid_until,
                                COALESCE(v_season_start::text, 'open'), COALESCE(v_season_end::text, 'open'))
         WHERE outcome = 'ok' AND ((v_season_start IS NOT NULL AND valid_from < v_season_start)
                                   OR (v_season_end IS NOT NULL AND valid_until > v_season_end));

        -- ------------------------------------------------------------ 2. What the admin decided, and what each label is.
        CREATE TEMP TABLE _pi_dec ON COMMIT DROP AS
        SELECT g.kind, e.key AS dkey, e.value ->> 'action' AS action,
               CASE WHEN e.value ->> 'action' = 'map' AND e.value ->> 'id' ~* c_uuid THEN (e.value ->> 'id')::uuid END AS ref_id,
               NULLIF(btrim(e.value ->> 'name', E' \t\r\n'), '') AS dname
          FROM (VALUES ('division', 'divisions'), ('location', 'locations'), ('field', 'fields'), ('subunit', 'subunits'), ('team', 'teams')) AS g(kind, grp)
          CROSS JOIN LATERAL jsonb_each(COALESCE(v_map -> g.grp, '{}'::jsonb)) AS e(key, value)
         WHERE e.value ->> 'action' IN ('map', 'create', 'skip');

        -- Divisions of this season. One creation per normalised final name (core's resolvePracticeRows coalesces two labels
        -- that create one name, and UNIQUE (season, name) would refuse the second); a create over a name the season has is
        -- no division (`unknown-division`, core's name-exists).
        CREATE TEMP TABLE _pi_div ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.division_key AS dkey, (array_agg(r.division_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' AND r.status = 'placement' GROUP BY r.division_key
        ), j AS (
            SELECT k.dkey, d.action,
                   CASE WHEN d.action = 'map' THEN (SELECT dv.id FROM public.divisions dv WHERE dv.id = d.ref_id
                                                      AND dv.organization_id = v_org AND dv.season_settings_id = v_season) END AS existing_id,
                   CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k LEFT JOIN _pi_dec d ON d.kind = 'division' AND d.dkey = k.dkey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.divisions dv
                         WHERE dv.organization_id = v_org AND dv.season_settings_id = v_season
                           AND public.normalise_external_label(dv.name) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.dkey, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey);

        -- Locations of the organization.
        CREATE TEMP TABLE _pi_loc ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.location_key AS lkey, (array_agg(r.location_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' GROUP BY r.location_key
        ), j AS (
            SELECT k.lkey, d.action,
                   CASE WHEN d.action = 'map' THEN (SELECT l.id FROM public.locations l WHERE l.id = d.ref_id AND l.organization_id = v_org) END AS existing_id,
                   CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k LEFT JOIN _pi_dec d ON d.kind = 'location' AND d.dkey = k.lkey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.organization_id = v_org
                           AND public.normalise_external_label(l.name) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.lkey, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.lkey);

        -- Fields: of the location the row's location resolved to. A map onto a field of another location is no field.
        CREATE TEMP TABLE _pi_fld ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.field_key AS fkey, (array_agg(r.location_key ORDER BY r.rowno))[1] AS lkey,
                   (array_agg(r.field_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' GROUP BY r.field_key
        ), j AS (
            SELECT k.fkey, l.ref AS loc_ref, d.action,
                   CASE WHEN d.action = 'map' AND l.ref IS NOT NULL
                        THEN (SELECT f.id FROM public.fields f WHERE f.id = d.ref_id AND f.organization_id = v_org AND f.location_id = l.ref) END AS existing_id,
                   CASE WHEN d.action = 'create' AND l.ref IS NOT NULL THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k
              LEFT JOIN _pi_loc l ON l.lkey = k.lkey AND l.action IN ('map', 'create')
              LEFT JOIN _pi_dec d ON d.kind = 'field' AND d.dkey = k.fkey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND j.cname IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fields f
                           WHERE f.organization_id = v_org AND f.location_id = j.loc_ref
                             AND public.normalise_external_label(f.name) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.fkey, k2.loc_ref, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, k2.loc_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey);

        -- Halves and sides: of the field the row's field resolved to.
        CREATE TEMP TABLE _pi_sub ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.subunit_key AS skey, (array_agg(r.field_key ORDER BY r.rowno))[1] AS fkey,
                   (array_agg(r.subunit_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' AND r.subunit_key <> '' GROUP BY r.subunit_key
        ), j AS (
            SELECT k.skey, f.ref AS fld_ref, d.action,
                   CASE WHEN d.action = 'map' AND f.ref IS NOT NULL
                        THEN (SELECT s.id FROM public.field_subunits s WHERE s.id = d.ref_id AND s.organization_id = v_org AND s.field_id = f.ref) END AS existing_id,
                   CASE WHEN d.action = 'create' AND f.ref IS NOT NULL THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k
              LEFT JOIN _pi_fld f ON f.fkey = k.fkey AND f.action IN ('map', 'create')
              LEFT JOIN _pi_dec d ON d.kind = 'subunit' AND d.dkey = k.skey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND j.cname IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.field_subunits s
                           WHERE s.organization_id = v_org AND s.field_id = j.fld_ref
                             AND public.normalise_external_label(s.label) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.skey, k2.fld_ref, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, k2.fld_ref, public.normalise_external_label(k2.cname) ORDER BY k2.skey);

        -- Teams: of the division the row's division resolved to; never an outside club (it has no practice). A created team
        -- is a shell; its name must not be a name the division holds, an outside club's included (UNIQUE (division, name)).
        CREATE TEMP TABLE _pi_team ON COMMIT DROP AS
        WITH keys AS (
            SELECT r.team_key AS tkey, (array_agg(r.division_key ORDER BY r.rowno))[1] AS dkey,
                   (array_agg(r.team_label ORDER BY r.rowno))[1] AS label
              FROM _pi_rows r WHERE r.outcome = 'ok' AND r.status = 'placement' GROUP BY r.team_key
        ), j AS (
            SELECT k.tkey, dv.ref AS div_ref, d.action,
                   CASE WHEN d.action = 'map' AND dv.ref IS NOT NULL
                        THEN (SELECT t.id FROM public.teams t WHERE t.id = d.ref_id AND t.organization_id = v_org
                                AND t.division_id = dv.ref AND NOT t.is_external) END AS existing_id,
                   CASE WHEN d.action = 'create' AND dv.ref IS NOT NULL THEN COALESCE(d.dname, k.label) END AS cname
              FROM keys k
              LEFT JOIN _pi_div dv ON dv.dkey = k.dkey AND dv.action IN ('map', 'create')
              LEFT JOIN _pi_dec d ON d.kind = 'team' AND d.dkey = k.tkey
        ), k2 AS (
            SELECT j.*, (j.action = 'create' AND j.cname IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.teams t
                           WHERE t.organization_id = v_org AND t.division_id = j.div_ref
                             AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname))) AS can_create,
                   gen_random_uuid() AS own_id
              FROM j
        )
        SELECT k2.tkey, k2.div_ref, k2.action, k2.cname, k2.can_create,
               (k2.can_create AND row_number() OVER w = 1) AS creator,
               CASE WHEN k2.action = 'map' THEN k2.existing_id WHEN k2.can_create THEN first_value(k2.own_id) OVER w END AS ref
          FROM k2
        WINDOW w AS (PARTITION BY k2.can_create, k2.div_ref, public.normalise_external_label(k2.cname) ORDER BY k2.tkey);

        -- Each row resolves in core's order: division (a placement), location, field, subunit, team. The first to fail is
        -- the row's reason; a label the admin skipped makes the row skipped.
        UPDATE _pi_rows r
           SET outcome = x.outcome, reason = x.reason, message = x.message, skip_kind = x.skip_kind, skip_label = x.skip_label,
               div_ref = x.div_ref, loc_ref = x.loc_ref, fld_ref = x.fld_ref, sub_ref = x.sub_ref, team_ref = x.team_ref
          FROM (
            SELECT r2.rowno,
                   CASE WHEN step IS NULL THEN 'ok' WHEN step LIKE 'skip:%' THEN 'skipped' ELSE 'refused' END AS outcome,
                   CASE WHEN step LIKE 'unknown-%' THEN step END AS reason,
                   CASE step
                       WHEN 'unknown-division' THEN format('The division "%s" has no decision this import can use: map it, create it, or skip its rows.', r2.division_label)
                       WHEN 'unknown-location' THEN format('The location "%s" has no decision this import can use: map it, create it, or skip its rows.', r2.location_label)
                       WHEN 'unknown-field' THEN format('The field "%s" of "%s" has no decision this import can use: map it, create it, or skip its rows.', r2.field_label, r2.location_label)
                       WHEN 'unknown-subunit' THEN format('The half or side "%s" of "%s" has no decision this import can use. Leave Subunit blank for the whole field.', r2.subunit_label, r2.field_label)
                       WHEN 'unknown-team' THEN format('The team "%s" of "%s" has no decision this import can use: map it, create it, or skip its rows.', r2.team_label, r2.division_label)
                   END AS message,
                   CASE WHEN step LIKE 'skip:%' THEN substr(step, 6) END AS skip_kind,
                   CASE step WHEN 'skip:division' THEN r2.division_label WHEN 'skip:location' THEN r2.location_label
                             WHEN 'skip:field' THEN r2.field_label WHEN 'skip:subunit' THEN r2.subunit_label WHEN 'skip:team' THEN r2.team_label END AS skip_label,
                   CASE WHEN step IS NULL THEN dv.ref END AS div_ref, CASE WHEN step IS NULL THEN l.ref END AS loc_ref,
                   CASE WHEN step IS NULL THEN f.ref END AS fld_ref, CASE WHEN step IS NULL THEN s.ref END AS sub_ref,
                   CASE WHEN step IS NULL THEN t.ref END AS team_ref
              FROM _pi_rows r2
              LEFT JOIN _pi_div dv ON dv.dkey = r2.division_key AND r2.status = 'placement'
              LEFT JOIN _pi_loc l ON l.lkey = r2.location_key
              LEFT JOIN _pi_fld f ON f.fkey = r2.field_key
              LEFT JOIN _pi_sub s ON s.skey = r2.subunit_key AND r2.subunit_key <> ''
              LEFT JOIN _pi_team t ON t.tkey = r2.team_key AND r2.status = 'placement'
              CROSS JOIN LATERAL (SELECT CASE
                       WHEN r2.status = 'placement' AND dv.action = 'skip' THEN 'skip:division'
                       WHEN r2.status = 'placement' AND dv.ref IS NULL THEN 'unknown-division'
                       WHEN l.action = 'skip' THEN 'skip:location'
                       WHEN l.ref IS NULL THEN 'unknown-location'
                       WHEN f.action = 'skip' THEN 'skip:field'
                       WHEN f.ref IS NULL THEN 'unknown-field'
                       WHEN r2.subunit_key <> '' AND s.action = 'skip' THEN 'skip:subunit'
                       WHEN r2.subunit_key <> '' AND s.ref IS NULL THEN 'unknown-subunit'
                       WHEN r2.status = 'placement' AND t.action = 'skip' THEN 'skip:team'
                       WHEN r2.status = 'placement' AND t.ref IS NULL THEN 'unknown-team'
                   END AS step) st
             WHERE r2.outcome = 'ok' AND r2.status IN ('placement', 'open')
          ) x
         WHERE x.rowno = r.rowno;

        -- A hold makes no slot and asks for no mapping: it uses the ground the decisions give it (a map, or what a placement or
        -- open row creates), and has none when they give none (no flag is possible then).
        UPDATE _pi_rows r
           SET loc_ref = (SELECT l.ref FROM _pi_loc l WHERE l.lkey = r.location_key AND l.action IN ('map', 'create')),
               fld_ref = (SELECT f.ref FROM _pi_fld f WHERE f.fkey = r.field_key AND f.action IN ('map', 'create')),
               sub_ref = CASE WHEN r.subunit_key = '' THEN NULL
                              ELSE (SELECT s.ref FROM _pi_sub s WHERE s.skey = r.subunit_key AND s.action IN ('map', 'create')) END
         WHERE r.outcome = 'ok' AND r.status = 'hold';
        -- A hold on a half the decisions do not give has no ground (never the whole field instead).
        UPDATE _pi_rows SET fld_ref = NULL WHERE outcome = 'ok' AND status = 'hold' AND subunit_key <> '' AND sub_ref IS NULL;

        -- The same practice twice by the admin's own mapping: the first wins.
        UPDATE _pi_rows r SET outcome = 'refused', reason = 'duplicate-row',
               message = 'After mapping, this is the same practice as an earlier row; the earlier row is the one imported.'
          FROM (SELECT x.rowno, row_number() OVER (PARTITION BY x.status, x.team_ref, x.fld_ref, x.sub_ref, x.dow, x.start_time,
                                                    x.end_time, x.valid_from, x.valid_until, x.capacity ORDER BY x.rowno) AS n
                  FROM _pi_rows x WHERE x.outcome = 'ok' AND x.status IN ('placement', 'open')) d
         WHERE d.rowno = r.rowno AND d.n > 1;

        -- ------------------------------------------------------------ 3. The grounds the admin chose to create.
        -- Made before the slots (a slot names its field); any that ends up used by no written row is taken out again below,
        -- so what is created is what core's resolvePracticeRows lists from the rows that survive.
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
        SELECT d.ref, v_org, v_season, d.cname FROM _pi_div d
         WHERE d.creator AND d.ref IN (SELECT div_ref FROM _pi_rows WHERE outcome = 'ok');
        INSERT INTO public.locations (id, organization_id, name)
        SELECT l.ref, v_org, l.cname FROM _pi_loc l
         WHERE l.creator AND l.ref IN (SELECT loc_ref FROM _pi_rows WHERE outcome = 'ok' AND status <> 'hold');
        -- A field the import creates supports halves when a row names a half of it (finalize_field_import_job's rule for a
        -- field it creates). A field that exists is never changed, even when the import creates a half on it.
        INSERT INTO public.fields (id, organization_id, location_id, name, supports_halves)
        SELECT f.ref, v_org, f.loc_ref, f.cname,
               EXISTS (SELECT 1 FROM _pi_rows r WHERE r.fld_ref = f.ref AND r.outcome = 'ok' AND r.subunit_key <> '')
          FROM _pi_fld f
         WHERE f.creator AND f.ref IN (SELECT fld_ref FROM _pi_rows WHERE outcome = 'ok' AND status <> 'hold');
        INSERT INTO public.field_subunits (id, organization_id, field_id, label)
        SELECT s.ref, v_org, s.fld_ref, s.cname FROM _pi_sub s
         WHERE s.creator AND s.ref IN (SELECT sub_ref FROM _pi_rows WHERE outcome = 'ok' AND status <> 'hold');

        -- ------------------------------------------------------------ 4. The slots, one per (field, half, weekday, start, from).
        CREATE TEMP TABLE _pi_grp ON COMMIT DROP AS
        SELECT DISTINCT ON (r.fld_ref, r.sub_ref, r.dow, r.start_time, r.valid_from)
               r.fld_ref, r.sub_ref, r.dow, r.start_time, r.valid_from, r.end_time, r.valid_until, r.capacity, r.rowno AS first_row,
               NULL::boolean AS holds_team, NULL::uuid AS slot_id, NULL::boolean AS created, NULL::uuid AS clash_id,
               NULL::uuid AS differs_id, NULL::text AS differs
          FROM _pi_rows r WHERE r.outcome = 'ok' AND r.status IN ('placement', 'open')
         ORDER BY r.fld_ref, r.sub_ref, r.dow, r.start_time, r.valid_from, r.rowno;
        -- A slot is one End, Valid Until and Capacity: a later row that says otherwise is refused.
        UPDATE _pi_rows r SET outcome = 'refused', reason = 'slot-overlaps-another',
               message = format('This is the same slot as row %s with a different End, Valid Until or Capacity. A slot is one of each: make the rows agree.', g.first_row)
          FROM _pi_grp g
         WHERE r.outcome = 'ok' AND r.status IN ('placement', 'open')
           AND r.fld_ref = g.fld_ref AND r.sub_ref IS NOT DISTINCT FROM g.sub_ref AND r.dow = g.dow AND r.start_time = g.start_time
           AND r.valid_from = g.valid_from AND (r.end_time, r.valid_until, r.capacity) IS DISTINCT FROM (g.end_time, g.valid_until, g.capacity);
        UPDATE _pi_grp g SET holds_team = EXISTS (
            SELECT 1 FROM _pi_rows r WHERE r.outcome = 'ok' AND r.status = 'placement' AND r.fld_ref = g.fld_ref
               AND r.sub_ref IS NOT DISTINCT FROM g.sub_ref AND r.dow = g.dow AND r.start_time = g.start_time AND r.valid_from = g.valid_from);
        -- When two slots claim one ground, the one a team is placed in is kept over an empty one, else the earlier row
        -- (core's order): the groups that hold a team first, each in file order.
        FOR v_grp IN SELECT * FROM _pi_grp ORDER BY NOT holds_team, first_row LOOP
            SELECT * INTO v_slot FROM public.ensure_practice_slot(v_org, v_grp.fld_ref, v_grp.sub_ref, v_grp.dow, v_grp.start_time,
                                                                   v_grp.end_time, v_grp.valid_from, v_grp.valid_until, v_grp.capacity);
            UPDATE _pi_grp SET slot_id = v_slot.slot_id, created = v_slot.created, clash_id = v_slot.conflict_slot_id
             WHERE first_row = v_grp.first_row;
        END LOOP;
        -- A slot that is FOUND is never changed (plan 4.11.3), so a row that describes it otherwise (another End, Capacity or
        -- Valid Until) is refused, naming what differs: written against it, a practice could outlive its slot, or sit in a
        -- slot of another length or size than the file says.
        UPDATE _pi_grp g
           SET differs_id = g.slot_id, slot_id = NULL,
               differs = concat_ws('; ',
                   CASE WHEN ps.end_time <> g.end_time THEN format('its end is %s, the row''s %s', left(ps.end_time::text, 5), left(g.end_time::text, 5)) END,
                   CASE WHEN COALESCE(ps.capacity, 1) <> g.capacity THEN format('its capacity is %s, the row''s %s', COALESCE(ps.capacity, 1), g.capacity) END,
                   CASE WHEN ps.valid_until IS DISTINCT FROM g.valid_until
                        THEN format('its last date is %s, the row''s %s', COALESCE(ps.valid_until::text, 'open'), g.valid_until) END)
          FROM public.practice_slots ps
         WHERE ps.id = g.slot_id AND NOT g.created
           AND (ps.end_time <> g.end_time OR COALESCE(ps.capacity, 1) <> g.capacity OR ps.valid_until IS DISTINCT FROM g.valid_until);
        UPDATE _pi_rows r SET outcome = 'refused', reason = 'slot-differs',
               message = format('The slot this row names is saved already (%s) and differs: %s. An import never changes a saved slot: change the slot on Field Management, or make the row match it.',
                                g.differs_id, g.differs)
          FROM _pi_grp g
         WHERE g.differs_id IS NOT NULL AND r.outcome = 'ok' AND r.status IN ('placement', 'open')
           AND r.fld_ref = g.fld_ref AND r.sub_ref IS NOT DISTINCT FROM g.sub_ref AND r.dow = g.dow AND r.start_time = g.start_time
           AND r.valid_from = g.valid_from;
        UPDATE _pi_rows r SET outcome = 'refused', reason = 'slot-overlaps-another',
               message = CASE WHEN o.first_row IS NOT NULL
                              THEN format('This slot overlaps the slot of row %s on the same ground at the same time. Two slots cannot claim one ground: the one a team is placed in is imported, else the earlier row.', o.first_row)
                              ELSE format('This slot overlaps the saved slot %s on the same ground at the same time (a slot that exists is never changed by an import). Fix the slot on Field Management, or set this row''s dates to the slot''s.', g.clash_id) END
          FROM _pi_grp g
          LEFT JOIN _pi_grp o ON o.slot_id = g.clash_id AND o.created
         WHERE g.clash_id IS NOT NULL AND r.outcome = 'ok' AND r.status IN ('placement', 'open')
           AND r.fld_ref = g.fld_ref AND r.sub_ref IS NOT DISTINCT FROM g.sub_ref AND r.dow = g.dow AND r.start_time = g.start_time
           AND r.valid_from = g.valid_from;

        -- What was created and no written row uses (every row of a created half refused, say) is taken out again.
        DELETE FROM public.field_subunits s USING _pi_sub x
         WHERE x.creator AND s.id = x.ref AND NOT EXISTS (SELECT 1 FROM _pi_grp g WHERE g.sub_ref = s.id AND g.slot_id IS NOT NULL);
        -- (A field is deleted only after the shared producer of bookings says it holds none: docs/sql/20260909000000_smoke.sql
        -- holds every function that deletes a field to it. One made a moment ago holds none unless a slot of this file is on it.)
        DELETE FROM public.fields f USING _pi_fld x
         WHERE x.creator AND f.id = x.ref AND NOT EXISTS (SELECT 1 FROM _pi_grp g WHERE g.fld_ref = f.id AND g.slot_id IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM public.field_bookings(v_org, f.id, NULL) b);
        DELETE FROM public.locations l USING _pi_loc x
         WHERE x.creator AND l.id = x.ref AND NOT EXISTS (SELECT 1 FROM public.fields f WHERE f.location_id = l.id);

        -- ------------------------------------------------------------ 5. The rows of the file as practices.
        CREATE TEMP TABLE _pi_asg ON COMMIT DROP AS
        SELECT r.rowno, r.row_key, r.team_ref, r.team_label, g.slot_id, daterange(r.valid_from, r.valid_until, '[]') AS rng,
               (SELECT pa.id FROM public.practice_assignments pa
                 WHERE pa.team_id = r.team_ref AND pa.practice_slot_id = g.slot_id
                   AND pa.effective_date_range = daterange(r.valid_from, r.valid_until, '[]')) AS existing_id,
               NULL::uuid AS new_id, false AS probable_move, false AS held_back
          FROM _pi_rows r
          JOIN _pi_grp g ON g.fld_ref = r.fld_ref AND g.sub_ref IS NOT DISTINCT FROM r.sub_ref AND g.dow = r.dow
                        AND g.start_time = r.start_time AND g.valid_from = r.valid_from
         WHERE r.outcome = 'ok' AND r.status = 'placement' AND g.slot_id IS NOT NULL;

        -- In the schedule, not in this file: a saved practice of a team the file places, the file does not hold, and live on
        -- a date of the file's span for that team (its range cut to its slot's validity, as the gate reads one, against the
        -- first to the last date of the team's rows). A fall practice is not "leaving" a spring file. An import never deletes;
        -- the admin removes one on the Practices page with the unlock prompt, as today.
        CREATE TEMP TABLE _pi_leave ON COMMIT DROP AS
        WITH span AS (
            SELECT a.team_ref, daterange(min(lower(a.rng)), max(upper(a.rng)), '[)') AS rng FROM _pi_asg a GROUP BY a.team_ref
        ), saved AS (
            SELECT pa.id, pa.team_id, t.name AS team, ps.day_of_week::text AS day, ps.start_time, ps.end_time, ps.field_id,
                   ps.field_subunit_id, pa.effective_date_range AS rng,
                   GREATEST(lower(pa.effective_date_range), ps.valid_from) AS lo,
                   LEAST(upper(pa.effective_date_range) - 1, ps.valid_until) AS hi
              FROM public.practice_assignments pa
              JOIN public.teams t ON t.id = pa.team_id AND NOT t.is_external
              JOIN public.divisions d ON d.id = t.division_id AND d.season_settings_id = v_season
              JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
             WHERE pa.organization_id = v_org
               AND (pa.effective_date_range IS NULL OR NOT isempty(pa.effective_date_range))
               AND pa.id NOT IN (SELECT a.existing_id FROM _pi_asg a WHERE a.existing_id IS NOT NULL)
        )
        , lived AS (
            -- (A range that ends before its slot starts holds nothing: empty, never a constructor error.)
            SELECT sv.*, CASE WHEN sv.lo IS NULL OR sv.hi IS NULL OR sv.lo <= sv.hi THEN daterange(sv.lo, sv.hi, '[]')
                              ELSE 'empty'::daterange END AS live
              FROM saved sv
        )
        SELECT lv.id, lv.team_id, lv.team, lv.day, lv.start_time, lv.end_time, lv.field_id, lv.field_subunit_id, lv.rng, lv.live
          FROM lived lv
          JOIN span sp ON sp.team_ref = lv.team_id
         WHERE lv.live && sp.rng;
        -- New in this file, for a team with a row leaving on a date this row is live too: a probable move (the pair is the
        -- team, as core's pairProbableMoves pairs it, narrowed to rows whose dates meet), not added unless the admin ticked it.
        UPDATE _pi_asg a SET probable_move = true, held_back = NOT (a.row_key = ANY (v_add))
         WHERE a.existing_id IS NULL
           AND EXISTS (SELECT 1 FROM _pi_leave l WHERE l.team_id = a.team_ref AND l.live && a.rng);

        -- ------------------------------------------------------------ 6. Team shells, in ONE team run (as the games import's).
        DELETE FROM public.divisions dv USING _pi_div x
         WHERE x.creator AND dv.id = x.ref AND NOT EXISTS (SELECT 1 FROM _pi_asg a JOIN _pi_team t ON t.ref = a.team_ref WHERE t.div_ref = dv.id);
        SELECT COALESCE(array_agg(DISTINCT t.ref ORDER BY t.ref), ARRAY[]::uuid[]) INTO v_shell_arr
          FROM _pi_team t WHERE t.creator AND t.ref IN (SELECT team_ref FROM _pi_asg);
        IF cardinality(v_shell_arr) > 0 THEN
            -- The pages read the LATEST team run (`mapSchedulerRunToSummary` reads `results.teamsByDivision`), so the run is
            -- the latest completed run's results carried forward whole, with each division's shells added to it (lesson 104;
            -- copied from apply_game_import_job's latest body).
            SELECT sr.results INTO v_base
              FROM public.scheduler_runs sr
             WHERE sr.organization_id = v_org AND sr.run_type = 'team' AND sr.status = 'completed'
               AND (sr.season_settings_id = v_season OR sr.season_id = v_season)
             ORDER BY sr.created_at DESC, sr.id DESC
             LIMIT 1;
            IF jsonb_typeof(v_base) IS DISTINCT FROM 'object' THEN v_base := '{}'::jsonb; END IF;
            IF jsonb_typeof(v_base -> 'teamsByDivision') = 'object' THEN
                SELECT COALESCE(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END), '{}'::jsonb)
                  INTO v_grouped FROM jsonb_each(v_base -> 'teamsByDivision') e;
            ELSIF jsonb_typeof(v_base -> 'teams') = 'array' THEN
                SELECT COALESCE(jsonb_object_agg(g.k, g.arr), '{}'::jsonb) INTO v_grouped
                  FROM (SELECT COALESCE(NULLIF(et ->> 'division', ''), NULLIF(et ->> 'division_id', ''), 'Unassigned') AS k,
                               jsonb_agg(et ORDER BY x.ord) AS arr
                          FROM jsonb_array_elements(v_base -> 'teams') WITH ORDINALITY AS x(et, ord) GROUP BY 1) g;
            ELSE
                v_grouped := '{}'::jsonb;
            END IF;
            FOR v_div IN
                SELECT t.div_ref, (SELECT dv.name FROM public.divisions dv WHERE dv.id = t.div_ref) AS dname
                  FROM _pi_team t WHERE t.creator AND t.ref = ANY (v_shell_arr)
                 GROUP BY t.div_ref ORDER BY t.div_ref
            LOOP
                v_key := NULL;
                SELECT e.key INTO v_key
                  FROM jsonb_each(v_grouped) e
                 WHERE lower(e.key) = lower(v_div.div_ref::text) OR e.key = v_div.dname
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.value) et
                                WHERE lower(COALESCE(et ->> 'division_id', et ->> 'divisionId', '')) = lower(v_div.div_ref::text))
                 ORDER BY e.key COLLATE "C"
                 LIMIT 1;
                IF v_key IS NULL THEN
                    v_key := v_div.dname;
                    v_grouped := v_grouped || jsonb_build_object(v_key, COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'division', v_key, 'division_id', v_div.div_ref,
                                   'coachId', t.coach_id, 'assistantCoachIds', to_jsonb(COALESCE(t.assistant_coach_ids, '{}'::uuid[])),
                                   'players', '[]'::jsonb) ORDER BY t.name, t.id)
                          FROM public.teams t
                         WHERE t.division_id = v_div.div_ref AND NOT t.is_external AND t.id <> ALL (v_shell_arr)), '[]'::jsonb));
                END IF;
                v_label := COALESCE(NULLIF(v_grouped -> v_key -> 0 ->> 'division', ''), v_key);
                v_grouped := jsonb_set(v_grouped, ARRAY[v_key], (v_grouped -> v_key) || COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('id', t.ref, 'name', t.cname, 'division', v_label, 'division_id', v_div.div_ref,
                               'coachId', NULL, 'assistantCoachIds', '[]'::jsonb, 'players', '[]'::jsonb) ORDER BY t.cname, t.ref)
                      FROM _pi_team t
                     WHERE t.creator AND t.div_ref = v_div.div_ref AND t.ref = ANY (v_shell_arr)), '[]'::jsonb));
            END LOOP;
            v_results := v_base || jsonb_build_object(
                'teamsByDivision', v_grouped,
                'teams', COALESCE((SELECT jsonb_agg(x.team) FROM jsonb_each(v_grouped) e, jsonb_array_elements(e.value) AS x(team)), '[]'::jsonb),
                'team_players', CASE WHEN jsonb_typeof(v_base -> 'team_players') = 'array' THEN v_base -> 'team_players' ELSE '[]'::jsonb END);
            v_team_run := public.persist_team_schedule(
                jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'team', 'status', 'completed',
                    'completed_at', clock_timestamp(),
                    'parameters', jsonb_build_object('source', 'import', 'import_type', 'practice_schedule', 'import_job_id', p_import_job_id,
                                                     'shell_ids', to_jsonb(v_shell_arr)),
                    'results', v_results),
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.ref, 'division_id', t.div_ref, 'name', t.cname) ORDER BY t.ref), '[]'::jsonb)
                   FROM _pi_team t WHERE t.creator AND t.ref = ANY (v_shell_arr)),
                '[]'::jsonb);
        END IF;

        -- ------------------------------------------------------------ 7. The practices: additive, manual, no run.
        SELECT count(*) INTO v_planned FROM _pi_asg WHERE existing_id IS NULL AND NOT held_back;
        WITH ins AS (
            INSERT INTO public.practice_assignments (organization_id, run_id, team_id, slot_id, practice_slot_id, day_of_week,
                                                     start_time, end_time, field_id, effective_date_range, source, assigned_via)
            SELECT v_org, NULL, a.team_ref, a.slot_id, a.slot_id, ps.day_of_week::text, ps.start_time::text, ps.end_time::text,
                   ps.field_id, a.rng, 'manual'::public.source_enum, 'manual'
              FROM _pi_asg a JOIN public.practice_slots ps ON ps.id = a.slot_id
             -- Every row of the file goes to the insert, the ones already saved too: the unique key (team, slot, range)
             -- turns a saved one into nothing (a re-import inserts nothing), and the count below holds the planned new ones.
             WHERE NOT a.held_back
             ORDER BY a.rowno
            ON CONFLICT (team_id, practice_slot_id, effective_date_range)
                WHERE practice_slot_id IS NOT NULL AND effective_date_range IS NOT NULL
            DO NOTHING
            RETURNING id, team_id, practice_slot_id, effective_date_range
        )
        UPDATE _pi_asg a SET new_id = ins.id
          FROM ins WHERE ins.team_id = a.team_ref AND ins.practice_slot_id = a.slot_id AND ins.effective_date_range = a.rng;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> v_planned THEN
            RAISE EXCEPTION 'practice import planned % practices and wrote %', v_planned, v_rc USING ERRCODE = 'XX000';
        END IF;

        -- The application records, one per row written, with the image it was written with (the rollback compares it).
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'practice_schedule', x.t, x.id, 'inserted', NULL, x.img, v_now, v_uid
          FROM (SELECT 'divisions' AS t, d.id, to_jsonb(d) AS img FROM public.divisions d WHERE d.id IN (SELECT ref FROM _pi_div WHERE creator)
                UNION ALL SELECT 'locations', l.id, to_jsonb(l) FROM public.locations l WHERE l.id IN (SELECT ref FROM _pi_loc WHERE creator)
                UNION ALL SELECT 'fields', f.id, to_jsonb(f) FROM public.fields f WHERE f.id IN (SELECT ref FROM _pi_fld WHERE creator)
                UNION ALL SELECT 'field_subunits', s.id, to_jsonb(s) FROM public.field_subunits s WHERE s.id IN (SELECT ref FROM _pi_sub WHERE creator)
                UNION ALL SELECT 'teams', t.id, to_jsonb(t) FROM public.teams t WHERE t.id = ANY (v_shell_arr)
                UNION ALL SELECT 'practice_slots', ps.id, to_jsonb(ps) FROM public.practice_slots ps WHERE ps.id IN (SELECT slot_id FROM _pi_grp WHERE created)
                UNION ALL SELECT 'practice_assignments', pa.id, to_jsonb(pa) FROM public.practice_assignments pa WHERE pa.id IN (SELECT new_id FROM _pi_asg)) x;

        -- ------------------------------------------------------------ 8. The flags, read from the rows the file names.
        CREATE TEMP TABLE _pi_flag (rowno integer, row_key text, team_id uuid, code text, detail text) ON COMMIT DROP;
        SELECT COALESCE(array_agg(COALESCE(a.existing_id, a.new_id)), ARRAY[]::uuid[]) INTO v_ids
          FROM _pi_asg a WHERE COALESCE(a.existing_id, a.new_id) IS NOT NULL;
        -- The gate's five rules, read-only: it judges whatever source the rows carry (20261105010000). Its words name
        -- assignment ids, which a dry run and an apply make anew; the result says the rule and words that name none.
        INSERT INTO _pi_flag
        SELECT a.rowno, a.row_key, a.team_ref, CASE WHEN g.rule = 'pairing' THEN 'pairing-differs' ELSE g.rule END,
               CASE WHEN g.rule IN ('capacity', 'length', 'count', 'pairing') THEN g.detail
                    WHEN g.rule = 'weekday' THEN 'the team has another practice on this weekday on a shared date'
                    ELSE 'the slot is reserved to another division' END
          FROM public.practice_new_auto_row_refusals(v_org, v_ids) g
          JOIN _pi_asg a ON COALESCE(a.existing_id, a.new_id) = g.assignment_id;
        -- coach-conflict: a coach of this team coaches another team (in force on a shared date, team_coach_assignments) that
        -- practises at an overlapping time on the same weekday on a shared date: any saved row of the season, this file's too.
        INSERT INTO _pi_flag
        SELECT DISTINCT ON (a.rowno, ca.coach_id) a.rowno, a.row_key, a.team_ref, 'coach-conflict',
               format('a coach of this team (%s) also coaches %s at an overlapping time on this weekday', ca.coach_id, ot.name)
          FROM _pi_asg a
          JOIN public.practice_assignments pa ON pa.id = COALESCE(a.existing_id, a.new_id)
          JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
          JOIN public.team_coach_assignments ca ON ca.team_id = a.team_ref
          JOIN public.team_coach_assignments cb ON cb.coach_id = ca.coach_id AND cb.team_id <> a.team_ref
          JOIN public.teams ot ON ot.id = cb.team_id AND NOT ot.is_external
          JOIN public.practice_assignments pb ON pb.team_id = cb.team_id AND pb.organization_id = v_org
          JOIN public.practice_slots pbs ON pbs.id = pb.practice_slot_id
          -- The shared dates: each practice's range cut to its OWN slot's validity (a NULL range, or a bound it lacks, is
          -- the slot's: practice_new_auto_row_refusals' rule and core's assignmentLiveSpan), and both coach assignments in
          -- force. GREATEST and LEAST skip a NULL, so an open bound is open.
          CROSS JOIN LATERAL (
              SELECT COALESCE(GREATEST(lower(pa.effective_date_range), ps.valid_from, lower(pb.effective_date_range), pbs.valid_from,
                                       ca.effective_from, cb.effective_from), '-infinity'::date) AS lo,
                     COALESCE(LEAST(upper(pa.effective_date_range) - 1, ps.valid_until, upper(pb.effective_date_range) - 1, pbs.valid_until,
                                    ca.effective_to, cb.effective_to), 'infinity'::date) AS hi) w
         WHERE pbs.day_of_week = ps.day_of_week AND pbs.start_time < ps.end_time AND ps.start_time < pbs.end_time
           AND (pb.effective_date_range IS NULL OR NOT isempty(pb.effective_date_range))
           AND isfinite(w.lo) AND w.lo <= w.hi
           AND w.lo + ((array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun']::public.day_of_week[], ps.day_of_week)
                        - extract(isodow FROM w.lo)::int + 7) % 7) <= w.hi
         ORDER BY a.rowno, ca.coach_id, ot.name;
        -- team-on-both-halves: a team on two halves of one field at one time (two rows, never merged on the admin's behalf).
        INSERT INTO _pi_flag
        SELECT a.rowno, a.row_key, a.team_ref, 'team-on-both-halves',
               format('the team is on both halves of this field at the same time (rows %s). That is the whole field: leave Subunit blank for the whole field.',
                      string_agg(b.rowno::text, ', ' ORDER BY b.rowno))
          FROM _pi_asg a
          JOIN _pi_rows ra ON ra.rowno = a.rowno
          JOIN _pi_asg b ON b.team_ref = a.team_ref AND b.rowno <> a.rowno
          JOIN _pi_rows rb ON rb.rowno = b.rowno
         WHERE ra.fld_ref = rb.fld_ref AND ra.sub_ref IS NOT NULL AND rb.sub_ref IS NOT NULL AND ra.sub_ref <> rb.sub_ref
           AND ra.dow = rb.dow AND ra.start_time < rb.end_time AND rb.start_time < ra.end_time
           AND GREATEST(ra.valid_from, rb.valid_from) + ((array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun']::public.day_of_week[], ra.dow)
                - extract(isodow FROM GREATEST(ra.valid_from, rb.valid_from))::int + 7) % 7) <= LEAST(ra.valid_until, rb.valid_until)
         GROUP BY a.rowno, a.row_key, a.team_ref;
        -- hold-over-open-slot: a cell held for a non-team activity where a slot is (the file's or a saved one).
        INSERT INTO _pi_flag
        SELECT r.rowno, r.row_key, NULL, 'hold-over-open-slot',
               format('This cell is held for a non-team activity, but %s slot(s) are there%s. The hold makes no slot, and removes or moves nothing.',
                      c.n, CASE WHEN c.used THEN ', with a team in one' ELSE '' END)
          FROM _pi_rows r
          CROSS JOIN LATERAL (
              SELECT count(*) AS n, bool_or(EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.practice_slot_id = x.slot_id)) AS used
                FROM public.practice_slot_conflicts(v_org, r.fld_ref, r.sub_ref, r.dow, r.start_time, r.end_time, r.valid_from, r.valid_until, NULL, 0) x) c
         WHERE r.outcome = 'ok' AND r.status = 'hold' AND r.fld_ref IS NOT NULL
           -- The ground must stand after the plan: a field or half a decision would create but no written row made, or one
           -- made and taken out again, is no ground.
           AND EXISTS (SELECT 1 FROM public.fields f WHERE f.id = r.fld_ref)
           AND (r.sub_ref IS NULL OR EXISTS (SELECT 1 FROM public.field_subunits su WHERE su.id = r.sub_ref)) AND c.n > 0;
        -- division-not-reserved: the parse's own flag (a Division on a row with no team reserves nothing here).
        INSERT INTO _pi_flag
        SELECT r.rowno, r.row_key, NULL, 'division-not-reserved',
               'A Division on a row with no team reserves nothing in this import (an admin sets reservations on Field Management).'
          FROM _pi_rows r WHERE r.outcome = 'ok' AND 'division-not-reserved' = ANY (r.flags);

        -- ------------------------------------------------------------ 9. Teams short of their count join the TIME TBD list.
        v_tbd := public.refresh_schedule_tbd_practices(v_season);

        -- ------------------------------------------------------------ 10. The result: what was (or would be) done.
        v_result := jsonb_build_object(
            'job_id', p_import_job_id,
            'counts', jsonb_build_object(
                'rows', n_staged,
                'placements', (SELECT count(*) FROM _pi_rows WHERE NOT parse_refused AND status = 'placement'),
                'open', (SELECT count(*) FROM _pi_rows WHERE NOT parse_refused AND status = 'open'),
                'holds', (SELECT count(*) FROM _pi_rows WHERE NOT parse_refused AND status = 'hold'),
                'refused', (SELECT count(*) FROM _pi_rows WHERE outcome = 'refused'),
                'skipped', (SELECT count(*) FROM _pi_rows WHERE outcome = 'skipped'),
                'inserted', (SELECT count(*) FROM _pi_asg WHERE new_id IS NOT NULL),
                'unchanged', (SELECT count(*) FROM _pi_asg WHERE existing_id IS NOT NULL),
                'held_back', (SELECT count(*) FROM _pi_asg WHERE held_back),
                'slots_created', (SELECT count(*) FROM _pi_grp WHERE created),
                'slots_found', (SELECT count(*) FROM _pi_grp WHERE slot_id IS NOT NULL AND NOT created),
                'divisions_created', (SELECT count(*) FROM _pi_div x WHERE x.creator AND EXISTS (SELECT 1 FROM public.divisions d WHERE d.id = x.ref)),
                'locations_created', (SELECT count(*) FROM _pi_loc x WHERE x.creator AND EXISTS (SELECT 1 FROM public.locations l WHERE l.id = x.ref)),
                'fields_created', (SELECT count(*) FROM _pi_fld x WHERE x.creator AND EXISTS (SELECT 1 FROM public.fields f WHERE f.id = x.ref)),
                'subunits_created', (SELECT count(*) FROM _pi_sub x WHERE x.creator AND EXISTS (SELECT 1 FROM public.field_subunits s WHERE s.id = x.ref)),
                'team_shells_created', cardinality(v_shell_arr),
                'leaving', (SELECT count(*) FROM _pi_leave),
                'arriving', (SELECT count(*) FROM _pi_asg WHERE existing_id IS NULL),
                'probable_move_teams', (SELECT count(DISTINCT team_ref) FROM _pi_asg WHERE probable_move)),
            'refused_by_reason', (SELECT COALESCE(jsonb_object_agg(reason, n), '{}'::jsonb)
                                    FROM (SELECT reason, count(*) AS n FROM _pi_rows WHERE outcome = 'refused' GROUP BY reason) x),
            'refused', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', rowno, 'row_key', row_key, 'reason', reason, 'message', message) ORDER BY rowno), '[]'::jsonb)
                          FROM _pi_rows WHERE outcome = 'refused'),
            'skipped', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', rowno, 'row_key', row_key, 'kind', skip_kind, 'label', skip_label) ORDER BY rowno), '[]'::jsonb)
                          FROM _pi_rows WHERE outcome = 'skipped'),
            'flags', (SELECT COALESCE(jsonb_object_agg(code, jsonb_build_object('rows', nr, 'teams', nt)), '{}'::jsonb)
                        FROM (SELECT code, count(DISTINCT rowno) AS nr, count(DISTINCT team_id) AS nt FROM _pi_flag GROUP BY code) x),
            'flagged', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', rowno, 'row_key', row_key, 'code', code, 'detail', detail) ORDER BY rowno, code, detail), '[]'::jsonb)
                          FROM _pi_flag),
            'arriving', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', rowno, 'row_key', row_key, 'team_id', team_ref, 'team', team_label,
                                                                    'probable_move', probable_move, 'added', NOT held_back) ORDER BY rowno), '[]'::jsonb)
                           FROM _pi_asg WHERE existing_id IS NULL),
            'leaving', (SELECT COALESCE(jsonb_agg(jsonb_build_object('assignment_id', id, 'team_id', team_id, 'team', team, 'day', day,
                                                                   'start_time', left(start_time::text, 5), 'end_time', left(end_time::text, 5),
                                                                   'field_id', field_id, 'field_subunit_id', field_subunit_id, 'range', rng::text)
                                                ORDER BY team, day, start_time, id), '[]'::jsonb)
                          FROM _pi_leave),
            'holds', (SELECT COALESCE(jsonb_agg(jsonb_build_object('row', h.rowno, 'row_key', h.row_key,
                                  'ground_known', EXISTS (SELECT 1 FROM public.fields f WHERE f.id = h.fld_ref)
                                                  AND (h.sub_ref IS NULL OR EXISTS (SELECT 1 FROM public.field_subunits su WHERE su.id = h.sub_ref)))
                                  ORDER BY h.rowno), '[]'::jsonb)
                        FROM _pi_rows h WHERE h.outcome = 'ok' AND h.status = 'hold'),
            'time_tbd', jsonb_build_object(
                'practice_rows', v_tbd -> 'practice_rows',
                'missing_practices', v_tbd -> 'missing_practices',
                'teams', (SELECT COALESCE(jsonb_agg(jsonb_build_object('team_id', s.team_id, 'missing_count', s.missing_count,
                                                                      'in_file', s.team_id IN (SELECT team_ref FROM _pi_rows WHERE team_ref IS NOT NULL))
                                                    ORDER BY s.team_id), '[]'::jsonb)
                            FROM public.schedule_tbd s
                           WHERE s.organization_id = v_org AND s.season_settings_id = v_season AND s.kind = 'practice')),
            'coverage', jsonb_build_object(
                'checked', jsonb_build_array('capacity', 'reservation', 'length', 'weekday', 'pairing-differs', 'count', 'coach-conflict', 'team-on-both-halves', 'hold-over-open-slot'),
                'not_checked', jsonb_build_array('coach preference rules', 'daylight and sunset', 'field closures and permits', 'travel or turnover between fields'),
                'coach_judged_teams', (SELECT count(DISTINCT a.team_ref) FROM _pi_asg a
                                        WHERE EXISTS (SELECT 1 FROM public.team_coach_assignments c WHERE c.team_id = a.team_ref)),
                'file_teams', (SELECT count(DISTINCT team_ref) FROM _pi_asg)));
        v_status := CASE WHEN (v_result #>> '{counts,refused}')::int > 0 OR (v_result #>> '{counts,skipped}')::int > 0
                              OR v_result -> 'flags' <> '{}'::jsonb OR (v_result #>> '{counts,held_back}')::int > 0
                         THEN 'completed_with_warnings' ELSE 'completed' END;
        v_result := v_result || jsonb_build_object('status', v_status);

        IF v_dry THEN
            RAISE EXCEPTION 'practice import dry run: every write is undone' USING ERRCODE = 'SLD01';
        END IF;

        BEGIN
            PERFORM public.record_audit_event(v_org, 'import.completed', 'import_job', p_import_job_id,
                jsonb_build_object('import_type', 'practice_schedule', 'status', v_status) || (v_result -> 'counts')
                || jsonb_build_object('flags', v_result -> 'flags', 'refused_by_reason', v_result -> 'refused_by_reason'));
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
        END;
        UPDATE public.import_jobs
           SET status = v_status, processed_rows = n_staged, progress_percent = 100, completed_at = v_now,
               warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{practice_import}', v_result, true)
         WHERE id = p_import_job_id;
    EXCEPTION WHEN SQLSTATE 'SLD01' THEN
        -- The dry run's sentinel, and nothing else: every other error propagates.
        NULL;
    END;

    RETURN v_result || jsonb_build_object('dry_run', v_dry,
        'ids', jsonb_build_object('team_run_id', CASE WHEN v_dry THEN NULL ELSE v_team_run END));
END;
$function$;
COMMIT;
