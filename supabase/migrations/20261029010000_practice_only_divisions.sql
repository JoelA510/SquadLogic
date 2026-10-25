-- Practice-only divisions and reserved practice slots (plan
-- docs/changes/2026-10-22-demo-mode.md, D2; agreed by the owner 2026-10-22,
-- the AGENTS.md rule 14 plan for this scheduler and persistence change).
--
-- **Why.** A league's youngest division may practise without playing games
-- (the demo league's U4: four cohorts, one 30-minute session a week each, one
-- at a time, at least 15 minutes apart), and a practice slot may belong to one
-- division. Neither could be said: `divisions` had no games flag, and
-- `practice_slots` no division. The turnover between two practices on the
-- same ground existed only in the after-the-fact rule engine.
--
-- **The change.**
--   1. What it touches, counted in a NOTICE; after section 4, the existing
--      practice slot pairs that would clash under the new rule (kept: rows
--      already written are not judged again).
--   2. `divisions.plays_games boolean NOT NULL DEFAULT true`, and the key
--      `divisions_id_organization_id_key UNIQUE (id, organization_id)` that a
--      composite reference needs.
--   3. `practice_slots.division_id uuid NULL`, a reference to a division of
--      the SAME organization (composite, `(division_id, organization_id)`, as
--      Phase E's programs will be), `ON DELETE SET NULL (division_id)`: a
--      deleted division's slots are open again. Indexed. A slot with a
--      division is used only by that division's teams, and a division with a
--      reserved slot uses only its reserved slots: the schedulers read it
--      (packages/core `schedulePractices`, the Edge solver).
--   4. `practice_slot_conflicts(...)`, internal (no client role may execute
--      it): the slots one would clash with. Only slots on the same bookable
--      surface (the same subunit; or, for a whole field, the field and each
--      of its subunits, since a subunit is narrower than its field), on the
--      same weekday, whose effective windows share a date on that weekday,
--      and that overlap it or sit less than the turnover apart (default 0:
--      back-to-back slots are allowed, an overlap is not; owner, 2026-10-25,
--      since real grids run back to back. A league that needs a gap, as the
--      demo's U4 cohorts do, spaces its slots). Two halves of
--      one field never clash.
--   5. `finalize_field_import_job(uuid, jsonb)` replaced from its latest body
--      (20260503070000; 20261021040000 pinned its TimeZone with ALTER
--      FUNCTION, restated here), extracted from its file with its md5 checked
--      equal to the build's: a practice row's `division` column (the CSV's
--      "Division", aliased to `division_name` by import-validation) is
--      resolved by name within the import's season (the season
--      `finalize_import_job` attaches divisions to: the active one first,
--      then the latest start) and stored as the slot's reservation; a name
--      the season lacks fails the row with its reason. A practice row that
--      would clash (4) fails with its reason before anything is written. A
--      game row's division is read exactly as before (organization-wide by
--      name, an unknown one left blank). `v_now` is `now()`, the UTC idiom
--      guard (tests/utcNowIdiom.test.js).
--   6. `rollback_field_import_job(uuid)` replaced from its latest body
--      (20260909000000, md5 checked; TimeZone restated): an updated slot gets
--      back the reservation the import replaced.
--   7. `admin_upsert_division_settings` takes `p_plays_games` (NULL keeps the
--      stored value; a new division plays games). Adding a parameter changes
--      the signature, so the old ten-argument function is dropped by its exact
--      signature and the new one created from the latest body (20260504020000;
--      TimeZone from 20261021040000), with `plays_games` in its change test
--      and in the `settings.updated` audit row's before and after.
--   8. New: `admin_set_practice_slot_division(p_slot_id, p_division_id)`, an
--      admin's, behind the division select on each slot in Field Management:
--      sets or clears one slot's reservation (a division of the slot's own
--      organization), audited as `practice_slot.division_set` (registered
--      here) with the before and after; a repeat changes and audits nothing.
--   9. An end-state check: the columns, key, reference and index as declared;
--      the old signature gone; the grants as declared; the helper callable by
--      no client role; the finalizer reaches the helper and resolves a
--      practice division within the season.
--
-- Every drop names its object, with no CASCADE. No new table, so no new
-- policy: `practice_slots` keeps its one member read and no write policy
-- (writes go through the definers above); `divisions` keeps its policies,
-- whose admin update has always let an admin write any column directly
-- (pre-existing: every other division column too; declared).
--
-- **Not judged at write (declared).** A rollback restores the slots the
-- import replaced without asking whether they now clash: it puts back what
-- was there, and refusing would leave an import that cannot be undone. A
-- direct insert by the service role or the owner is not checked either: no
-- client may write `practice_slots` directly.
--
-- Reversible: docs/sql/20261029010000_revert.sql restores every object as it
-- stood after 20261028010000. Smoke checks: docs/sql/20261029010000_smoke.sql.
-- pgTAP: supabase/tests/practice_only_divisions.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What changes, counted.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_divisions bigint;
    v_slots bigint;
BEGIN
    SELECT count(*) INTO v_divisions FROM public.divisions;
    SELECT count(*) INTO v_slots FROM public.practice_slots;
    RAISE NOTICE '% division(s) will play games (plays_games true) until an admin says otherwise; % practice slot(s) are open to every division (no reservation)',
        v_divisions, v_slots;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. divisions.plays_games, and the key a composite reference needs.
-- ---------------------------------------------------------------------------

ALTER TABLE public.divisions
    ADD COLUMN plays_games boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.divisions.plays_games IS
    'false: a practice-only division. The game page builds it no round robin and lists it as practice only, not as unscheduled; its teams still practise. Default true. 20261029010000.';

ALTER TABLE public.divisions
    ADD CONSTRAINT divisions_id_organization_id_key UNIQUE (id, organization_id);

-- ---------------------------------------------------------------------------
-- 3. practice_slots.division_id: a reservation, in the slot's organization.
-- ---------------------------------------------------------------------------

ALTER TABLE public.practice_slots
    ADD COLUMN division_id uuid;

ALTER TABLE public.practice_slots
    ADD CONSTRAINT practice_slots_division_fkey
    FOREIGN KEY (division_id, organization_id)
    REFERENCES public.divisions (id, organization_id)
    ON DELETE SET NULL (division_id);

CREATE INDEX idx_practice_slots_division_id
    ON public.practice_slots (division_id, organization_id)
    WHERE division_id IS NOT NULL;

COMMENT ON COLUMN public.practice_slots.division_id IS
    'The division this slot is reserved to, or NULL (open to every division). A reserved slot is used only by its division''s teams, and a division with a reserved slot uses only its reserved slots. Set by the fields CSV''s Division column (finalize_field_import_job) and admin_set_practice_slot_division. 20261029010000.';

-- ---------------------------------------------------------------------------
-- 4. The slots a practice slot would clash with: same surface, weekday and
--    effective dates, overlapping or inside the turnover.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.practice_slot_conflicts(
    p_organization_id uuid,
    p_field_id uuid,
    p_field_subunit_id uuid,
    p_day_of_week public.day_of_week,
    p_start_time time,
    p_end_time time,
    p_valid_from date,
    p_valid_until date,
    p_exclude_slot_id uuid DEFAULT NULL,
    p_turnover_minutes integer DEFAULT 0
)
RETURNS TABLE (
    slot_id uuid,
    field_subunit_id uuid,
    start_time time,
    end_time time,
    valid_from date,
    valid_until date
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    -- Seconds past midnight, so a turnover near midnight cannot wrap the way
    -- `time + interval` does. A missing bound is open, as the column reads.
    -- The windows must share a date that IS the weekday: two windows that
    -- meet only on other days of the week never hold the slot on one day.
    WITH probe AS (
        SELECT greatest(COALESCE(p_turnover_minutes, 0), 0) * 60 AS turnover,
               extract(epoch FROM p_start_time) AS s,
               extract(epoch FROM p_end_time) AS e,
               CASE p_day_of_week
                   WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3 WHEN 'thu' THEN 4
                   WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 WHEN 'sun' THEN 7
               END AS dow
    )
    SELECT ps.id, ps.field_subunit_id, ps.start_time, ps.end_time, ps.valid_from, ps.valid_until
      FROM public.practice_slots ps
     CROSS JOIN probe
     CROSS JOIN LATERAL (
        SELECT greatest(COALESCE(ps.valid_from, '-infinity'::date), COALESCE(p_valid_from, '-infinity'::date)) AS lo,
               least(COALESCE(ps.valid_until, 'infinity'::date), COALESCE(p_valid_until, 'infinity'::date)) AS hi
     ) w
     WHERE ps.organization_id = p_organization_id
       AND ps.field_id = p_field_id
       AND ps.day_of_week = p_day_of_week
       AND (p_exclude_slot_id IS NULL OR ps.id <> p_exclude_slot_id)
       AND (p_field_subunit_id IS NULL
            OR ps.field_subunit_id IS NULL
            OR ps.field_subunit_id = p_field_subunit_id)
       AND w.lo <= w.hi
       AND (NOT isfinite(w.lo) OR NOT isfinite(w.hi)
            OR w.lo + ((probe.dow - extract(isodow FROM w.lo)::int + 7) % 7) <= w.hi)
       AND extract(epoch FROM ps.start_time) < probe.e + probe.turnover
       AND probe.s < extract(epoch FROM ps.end_time) + probe.turnover;
$$;

REVOKE ALL ON FUNCTION public.practice_slot_conflicts(uuid, uuid, uuid, public.day_of_week, time, time, date, date, uuid, integer)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.practice_slot_conflicts(uuid, uuid, uuid, public.day_of_week, time, time, date, date, uuid, integer) IS
    'Internal: the practice slots a slot on this surface, weekday, window and dates would clash with: the same subunit, or for a whole field the field and each of its subunits; the same weekday; effective windows sharing that weekday; overlapping, or less than the turnover (default 0: back to back is allowed) apart. Read by finalize_field_import_job. 20261029010000.';

-- The pairs already stored that the rule would refuse, each pair once (the
-- relation is symmetric). Kept as they are; reported so an operator can look.
DO $$
DECLARE
    v_pairs bigint;
BEGIN
    SELECT count(*) INTO v_pairs
      FROM public.practice_slots a
     CROSS JOIN LATERAL public.practice_slot_conflicts(
         a.organization_id, a.field_id, a.field_subunit_id, a.day_of_week,
         a.start_time, a.end_time, a.valid_from, a.valid_until, a.id) c
     WHERE c.slot_id > a.id;
    RAISE NOTICE '% stored pair(s) of practice slots on the same ground and weekday overlap: kept as they are; a new or changed slot is judged from now on',
        v_pairs;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. finalize_field_import_job: practice reservations, and clashes refused.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.finalize_field_import_job(
    p_import_job_id uuid,
    p_validation_errors jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_row public.staging_import_rows%ROWTYPE;
    v_location public.locations%ROWTYPE;
    v_location_after public.locations%ROWTYPE;
    v_field public.fields%ROWTYPE;
    v_field_after public.fields%ROWTYPE;
    v_subunit public.field_subunits%ROWTYPE;
    v_subunit_after public.field_subunits%ROWTYPE;
    v_practice_slot public.practice_slots%ROWTYPE;
    v_practice_slot_after public.practice_slots%ROWTYPE;
    v_game_slot public.game_slots%ROWTYPE;
    v_game_slot_after public.game_slots%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_payload jsonb;
    v_location_name text;
    v_location_address text;
    v_lighting_text text;
    v_lighting boolean;
    v_field_name text;
    v_surface_type text;
    v_size text;
    v_max_age text;
    v_priority integer;
    v_supports_halves_text text;
    v_supports_halves boolean;
    v_active_text text;
    v_active boolean;
    v_subunit_label text;
    v_slot_type text;
    v_day public.day_of_week;
    v_start_time time;
    v_end_time time;
    v_capacity integer;
    v_valid_from date;
    v_valid_until date;
    v_slot_date date;
    v_week_index integer;
    v_division_id uuid;
    -- 20261029010000: a practice row's `division` reserves its slot, resolved
    -- by name within the import's season; the row is refused before anything
    -- is written when the name is unknown or the slot would clash.
    v_division_text text;
    v_import_season_id uuid;
    v_import_season_name text;
    v_pre_location_id uuid;
    v_pre_field_id uuid;
    v_pre_subunit_id uuid;
    v_pre_slot_id uuid;
    v_conflict record;
    v_label text;
    v_previous_payload jsonb;
    v_inserted_locations integer := 0;
    v_updated_locations integer := 0;
    v_inserted_fields integer := 0;
    v_updated_fields integer := 0;
    v_inserted_subunits integer := 0;
    v_inserted_practice_slots integer := 0;
    v_updated_practice_slots integer := 0;
    v_inserted_game_slots integer := 0;
    v_updated_game_slots integer := 0;
    v_invalid_rows integer := 0;
    v_total_applied_count integer := 0;
    v_status_result text;
    v_result jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_validation_errors) <> 'array' THEN
        RAISE EXCEPTION 'p_validation_errors must be a jsonb array' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_job
    FROM public.import_jobs
    WHERE id = p_import_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_job.job_type <> 'fields' THEN
        RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    IF v_job.status = 'failed' THEN
        RAISE EXCEPTION 'Failed import job % cannot be finalized', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    -- 20261029010000: two fields imports of one organization must not both
    -- pass the practice-slot clash check before either writes its slot, so
    -- they run one at a time, held to commit.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('finalize_field_import_job:' || v_job.organization_id::text, 0)
    );

    -- 20261029010000: the season a practice row's division is named in, as
    -- finalize_import_job chooses the season it attaches divisions to (the
    -- active one first, then the latest start).
    SELECT s.id, s.name
    INTO v_import_season_id, v_import_season_name
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
    ORDER BY (s.status = 'active') DESC, s.season_start DESC NULLS LAST, s.created_at DESC
    LIMIT 1;

    FOR v_row IN
        SELECT *
        FROM public.staging_import_rows
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'fields'
          AND applied_at IS NULL
          AND normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(validation_errors), 0) = 0
        ORDER BY source_row_number NULLS LAST, id
    LOOP
        v_payload := v_row.normalized_payload;
        v_location_name := public.import_payload_text(
            v_payload,
            'location',
            'location_name',
            'venue'
        );
        v_location_address := public.import_payload_text(v_payload, 'address', 'location_address');
        v_lighting_text := public.import_payload_text(
            v_payload,
            'lighting_available',
            'lights',
            'lighted'
        );
        v_lighting := CASE
            WHEN v_lighting_text IS NULL THEN NULL
            ELSE public.import_text_to_bool(v_lighting_text)
        END;
        v_field_name := public.import_payload_text(v_payload, 'name', 'field', 'field_name');
        v_surface_type := public.import_payload_text(v_payload, 'surface_type', 'surface');
        v_size := public.import_payload_text(v_payload, 'size', 'field_size');
        v_max_age := public.import_payload_text(v_payload, 'max_age');
        v_priority := public.import_text_to_positive_int(
            public.import_payload_text(v_payload, 'priority_rating', 'priority'),
            1
        );
        v_supports_halves_text := public.import_payload_text(
            v_payload,
            'supports_halves',
            'supports_subunits',
            'split_field'
        );
        v_active_text := public.import_payload_text(v_payload, 'active');
        v_subunit_label := public.import_payload_text(v_payload, 'subunit', 'field_subunit');
        v_slot_type := lower(public.import_payload_text(v_payload, 'type', 'slot_type'));
        v_day := public.import_text_to_day_of_week(
            public.import_payload_text(v_payload, 'day', 'day_of_week')
        );
        v_start_time := public.import_text_to_time(
            public.import_payload_text(v_payload, 'start', 'start_time')
        );
        v_end_time := public.import_text_to_time(
            public.import_payload_text(v_payload, 'end', 'end_time')
        );
        v_capacity := public.import_text_to_positive_int(
            public.import_payload_text(v_payload, 'capacity'),
            1
        );
        v_valid_from := public.import_text_to_date(
            public.import_payload_text(v_payload, 'valid_from', 'valid start', 'start_date')
        );
        v_valid_until := public.import_text_to_date(
            public.import_payload_text(v_payload, 'valid_until', 'valid end', 'end_date')
        );
        v_slot_date := public.import_text_to_date(
            public.import_payload_text(v_payload, 'slot_date', 'date', 'game_date', 'valid_from')
        );
        v_week_index := public.import_text_to_positive_int(
            public.import_payload_text(v_payload, 'week_index', 'week'),
            1
        );
        v_label := public.import_payload_text(v_payload, 'label', 'slot_label');
        v_division_id := NULL;

        IF v_location_name IS NULL
           OR v_field_name IS NULL
           OR v_slot_type NOT IN ('practice', 'game')
           OR v_start_time IS NULL
           OR v_end_time IS NULL
           OR v_capacity IS NULL
           OR v_end_time <= v_start_time
           OR (v_slot_type = 'practice' AND (
                v_day IS NULL OR v_valid_from IS NULL OR v_valid_until IS NULL
                OR v_valid_until < v_valid_from
           ))
           OR (v_slot_type = 'game' AND v_slot_date IS NULL) THEN
            v_invalid_rows := v_invalid_rows + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Field row is missing required location/field/slot data or has an invalid slot window',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        IF public.import_payload_text(v_payload, 'division_id') IS NOT NULL THEN
            BEGIN
                SELECT d.id
                INTO v_division_id
                FROM public.divisions d
                WHERE d.id = public.import_payload_text(v_payload, 'division_id')::uuid
                  AND d.organization_id = v_job.organization_id;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'division reference is outside organization';
                END IF;
            EXCEPTION
                WHEN others THEN
                    v_invalid_rows := v_invalid_rows + 1;
                    UPDATE public.staging_import_rows
                    SET validation_errors = jsonb_build_array(jsonb_build_object(
                            'message', 'Field row references a division outside the import organization',
                            'source_row_number', v_row.source_row_number
                        ))
                    WHERE id = v_row.id;
                    CONTINUE;
            END;
        ELSIF v_slot_type = 'practice'
              AND public.import_payload_text(v_payload, 'division', 'division_name') IS NOT NULL THEN
            -- 20261029010000: a practice slot's division is its reservation.
            -- It is named within the season, and a name the season does not
            -- hold fails the row: an unknown name read as "open to every
            -- division" would hand a reserved slot to anyone.
            v_division_text := public.import_payload_text(v_payload, 'division', 'division_name');
            SELECT d.id
            INTO v_division_id
            FROM public.divisions d
            WHERE d.organization_id = v_job.organization_id
              AND d.season_settings_id = v_import_season_id
              AND lower(d.name) = lower(v_division_text)
            ORDER BY d.created_at, d.id
            LIMIT 1;

            IF v_division_id IS NULL THEN
                v_invalid_rows := v_invalid_rows + 1;
                UPDATE public.staging_import_rows
                SET validation_errors = jsonb_build_array(jsonb_build_object(
                        'message', CASE
                            WHEN v_import_season_id IS NULL THEN format(
                                'Practice row names division %s, but the organization has no season to find it in',
                                v_division_text)
                            ELSE format('Practice row names division %s, which season %s does not have',
                                v_division_text, v_import_season_name)
                        END,
                        'reason', 'division_unknown',
                        'division', v_division_text,
                        'source_row_number', v_row.source_row_number
                    ))
                WHERE id = v_row.id;
                CONTINUE;
            END IF;
        ELSIF public.import_payload_text(v_payload, 'division', 'division_name') IS NOT NULL THEN
            SELECT d.id
            INTO v_division_id
            FROM public.divisions d
            WHERE d.organization_id = v_job.organization_id
              AND lower(d.name) = lower(public.import_payload_text(v_payload, 'division', 'division_name'))
            ORDER BY d.created_at, d.id
            LIMIT 1;
        END IF;

        -- 20261029010000: overlap and turnover, refused before anything is
        -- written. The surface is read as the steps below will resolve it
        -- (the first location by name, its first field by name, that field's
        -- first subunit by label); ground that does not exist yet holds no
        -- slot. A subunit this row will create clashes only with slots on the
        -- whole field, so it is passed as the nil uuid, which no subunit has.
        -- The slot this row updates (same surface, weekday, start and valid
        -- from) is not judged against itself.
        IF v_slot_type = 'practice' THEN
            v_pre_location_id := NULL;
            v_pre_field_id := NULL;
            v_pre_subunit_id := NULL;
            v_pre_slot_id := NULL;

            SELECT l.id
            INTO v_pre_location_id
            FROM public.locations l
            WHERE l.organization_id = v_job.organization_id
              AND lower(l.name) = lower(v_location_name)
            ORDER BY l.created_at, l.id
            LIMIT 1;

            IF v_pre_location_id IS NOT NULL THEN
                SELECT f.id
                INTO v_pre_field_id
                FROM public.fields f
                WHERE f.organization_id = v_job.organization_id
                  AND f.location_id = v_pre_location_id
                  AND lower(f.name) = lower(v_field_name)
                ORDER BY f.created_at, f.id
                LIMIT 1;
            END IF;

            IF v_pre_field_id IS NOT NULL THEN
                IF v_subunit_label IS NOT NULL THEN
                    SELECT fs.id
                    INTO v_pre_subunit_id
                    FROM public.field_subunits fs
                    WHERE fs.field_id = v_pre_field_id
                      AND fs.organization_id = v_job.organization_id
                      AND lower(fs.label) = lower(v_subunit_label)
                    ORDER BY fs.created_at, fs.id
                    LIMIT 1;
                    v_pre_subunit_id := COALESCE(v_pre_subunit_id, '00000000-0000-0000-0000-000000000000'::uuid);
                END IF;

                SELECT ps.id
                INTO v_pre_slot_id
                FROM public.practice_slots ps
                WHERE ps.organization_id = v_job.organization_id
                  AND ps.field_id = v_pre_field_id
                  AND (
                    (v_pre_subunit_id IS NULL AND ps.field_subunit_id IS NULL)
                    OR ps.field_subunit_id = v_pre_subunit_id
                  )
                  AND ps.day_of_week = v_day
                  AND ps.start_time = v_start_time
                  AND ps.valid_from = v_valid_from
                ORDER BY ps.created_at, ps.id
                LIMIT 1;

                SELECT c.*
                INTO v_conflict
                FROM public.practice_slot_conflicts(
                    v_job.organization_id,
                    v_pre_field_id,
                    v_pre_subunit_id,
                    v_day,
                    v_start_time,
                    v_end_time,
                    v_valid_from,
                    v_valid_until,
                    v_pre_slot_id
                ) c
                ORDER BY c.start_time, c.slot_id
                LIMIT 1;

                IF FOUND THEN
                    v_invalid_rows := v_invalid_rows + 1;
                    UPDATE public.staging_import_rows
                    SET validation_errors = jsonb_build_array(jsonb_build_object(
                            'message', format(
                                'Practice slot %s %s-%s on %s %s overlaps the practice slot at %s-%s on the same ground',
                                v_day, to_char(v_start_time, 'HH24:MI'), to_char(v_end_time, 'HH24:MI'),
                                v_location_name, v_field_name,
                                to_char(v_conflict.start_time, 'HH24:MI'), to_char(v_conflict.end_time, 'HH24:MI')),
                            'reason', 'practice_slot_conflict',
                            'conflicting_slot_id', v_conflict.slot_id,
                            'source_row_number', v_row.source_row_number
                        ))
                    WHERE id = v_row.id;
                    CONTINUE;
                END IF;
            END IF;
        END IF;

        SELECT *
        INTO v_location
        FROM public.locations l
        WHERE l.organization_id = v_job.organization_id
          AND lower(l.name) = lower(v_location_name)
        ORDER BY l.created_at, l.id
        LIMIT 1;

        IF NOT FOUND THEN
            INSERT INTO public.locations (
                organization_id,
                name,
                address,
                lighting_available
            )
            VALUES (
                v_job.organization_id,
                v_location_name,
                v_location_address,
                COALESCE(v_lighting, false)
            )
            RETURNING * INTO v_location_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'fields',
                'locations',
                v_location_after.id,
                'inserted',
                NULL,
                to_jsonb(v_location_after),
                v_now,
                auth.uid()
            )
            ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

            v_inserted_locations := v_inserted_locations + 1;
            v_location := v_location_after;
        ELSE
            IF v_location_address IS NOT NULL OR v_lighting IS NOT NULL THEN
                v_previous_payload := to_jsonb(v_location);
                UPDATE public.locations
                SET
                    address = COALESCE(v_location_address, address),
                    lighting_available = COALESCE(v_lighting, lighting_available),
                    updated_at = v_now
                WHERE id = v_location.id
                  AND organization_id = v_job.organization_id
                RETURNING * INTO v_location_after;

                INSERT INTO public.import_application_records (
                    organization_id,
                    import_job_id,
                    import_type,
                    target_table,
                    target_id,
                    operation,
                    previous_payload,
                    applied_payload,
                    applied_at,
                    applied_by
                )
                VALUES (
                    v_job.organization_id,
                    p_import_job_id,
                    'fields',
                    'locations',
                    v_location_after.id,
                    'updated',
                    v_previous_payload,
                    to_jsonb(v_location_after),
                    v_now,
                    auth.uid()
                )
                ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

                v_updated_locations := v_updated_locations + 1;
                v_location := v_location_after;
            END IF;
        END IF;

        SELECT *
        INTO v_field
        FROM public.fields f
        WHERE f.organization_id = v_job.organization_id
          AND f.location_id = v_location.id
          AND lower(f.name) = lower(v_field_name)
        ORDER BY f.created_at, f.id
        LIMIT 1;

        IF NOT FOUND THEN
            v_supports_halves := CASE
                WHEN v_subunit_label IS NOT NULL THEN true
                WHEN v_supports_halves_text IS NOT NULL THEN public.import_text_to_bool(v_supports_halves_text)
                ELSE false
            END;
            v_active := CASE
                WHEN v_active_text IS NOT NULL THEN public.import_text_to_bool(v_active_text)
                ELSE true
            END;

            INSERT INTO public.fields (
                organization_id,
                location_id,
                name,
                surface_type,
                size,
                supports_halves,
                max_age,
                priority_rating,
                active
            )
            VALUES (
                v_job.organization_id,
                v_location.id,
                v_field_name,
                v_surface_type,
                v_size,
                v_supports_halves,
                v_max_age,
                COALESCE(v_priority, 1),
                v_active
            )
            RETURNING * INTO v_field_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'fields',
                'fields',
                v_field_after.id,
                'inserted',
                NULL,
                to_jsonb(v_field_after),
                v_now,
                auth.uid()
            )
            ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

            v_inserted_fields := v_inserted_fields + 1;
            v_field := v_field_after;
        ELSE
            v_previous_payload := to_jsonb(v_field);
            v_supports_halves := CASE
                WHEN v_subunit_label IS NOT NULL THEN true
                WHEN v_supports_halves_text IS NOT NULL THEN public.import_text_to_bool(v_supports_halves_text)
                ELSE COALESCE(v_field.supports_halves, false)
            END;
            v_active := CASE
                WHEN v_active_text IS NOT NULL THEN public.import_text_to_bool(v_active_text)
                ELSE COALESCE(v_field.active, true)
            END;

            UPDATE public.fields
            SET
                location_id = v_location.id,
                name = v_field_name,
                surface_type = COALESCE(v_surface_type, surface_type),
                size = COALESCE(v_size, size),
                supports_halves = v_supports_halves,
                max_age = COALESCE(v_max_age, max_age),
                priority_rating = COALESCE(v_priority, priority_rating, 1),
                active = v_active,
                updated_at = v_now
            WHERE id = v_field.id
              AND organization_id = v_job.organization_id
            RETURNING * INTO v_field_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'fields',
                'fields',
                v_field_after.id,
                'updated',
                v_previous_payload,
                to_jsonb(v_field_after),
                v_now,
                auth.uid()
            )
            ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

            v_updated_fields := v_updated_fields + 1;
            v_field := v_field_after;
        END IF;

        IF v_subunit_label IS NOT NULL THEN
            SELECT *
            INTO v_subunit
            FROM public.field_subunits fs
            WHERE fs.field_id = v_field.id
              AND fs.organization_id = v_job.organization_id
              AND lower(fs.label) = lower(v_subunit_label)
            ORDER BY fs.created_at, fs.id
            LIMIT 1;

            IF NOT FOUND THEN
                INSERT INTO public.field_subunits (
                    organization_id,
                    field_id,
                    label
                )
                VALUES (
                    v_job.organization_id,
                    v_field.id,
                    v_subunit_label
                )
                RETURNING * INTO v_subunit_after;

                INSERT INTO public.import_application_records (
                    organization_id,
                    import_job_id,
                    import_type,
                    target_table,
                    target_id,
                    operation,
                    previous_payload,
                    applied_payload,
                    applied_at,
                    applied_by
                )
                VALUES (
                    v_job.organization_id,
                    p_import_job_id,
                    'fields',
                    'field_subunits',
                    v_subunit_after.id,
                    'inserted',
                    NULL,
                    to_jsonb(v_subunit_after),
                    v_now,
                    auth.uid()
                )
                ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

                v_inserted_subunits := v_inserted_subunits + 1;
                v_subunit := v_subunit_after;
            END IF;
        ELSE
            v_subunit.id := NULL;
        END IF;

        IF v_slot_type = 'practice' THEN
            SELECT *
            INTO v_practice_slot
            FROM public.practice_slots ps
            WHERE ps.organization_id = v_job.organization_id
              AND ps.field_id = v_field.id
              AND (
                (v_subunit.id IS NULL AND ps.field_subunit_id IS NULL)
                OR ps.field_subunit_id = v_subunit.id
              )
              AND ps.day_of_week = v_day
              AND ps.start_time = v_start_time
              AND ps.valid_from = v_valid_from
            ORDER BY ps.created_at, ps.id
            LIMIT 1;

            IF NOT FOUND THEN
                INSERT INTO public.practice_slots (
                    organization_id,
                    field_id,
                    field_subunit_id,
                    day_of_week,
                    start_time,
                    end_time,
                    capacity,
                    valid_from,
                    valid_until,
                    label,
                    division_id
                )
                VALUES (
                    v_job.organization_id,
                    v_field.id,
                    v_subunit.id,
                    v_day,
                    v_start_time,
                    v_end_time,
                    v_capacity::smallint,
                    v_valid_from,
                    v_valid_until,
                    v_label,
                    v_division_id
                )
                RETURNING * INTO v_practice_slot_after;

                INSERT INTO public.import_application_records (
                    organization_id,
                    import_job_id,
                    import_type,
                    target_table,
                    target_id,
                    operation,
                    previous_payload,
                    applied_payload,
                    applied_at,
                    applied_by
                )
                VALUES (
                    v_job.organization_id,
                    p_import_job_id,
                    'fields',
                    'practice_slots',
                    v_practice_slot_after.id,
                    'inserted',
                    NULL,
                    to_jsonb(v_practice_slot_after),
                    v_now,
                    auth.uid()
                )
                ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

                v_inserted_practice_slots := v_inserted_practice_slots + 1;
            ELSE
                v_previous_payload := to_jsonb(v_practice_slot);
                UPDATE public.practice_slots
                SET
                    field_id = v_field.id,
                    field_subunit_id = v_subunit.id,
                    day_of_week = v_day,
                    start_time = v_start_time,
                    end_time = v_end_time,
                    capacity = v_capacity::smallint,
                    valid_from = v_valid_from,
                    valid_until = v_valid_until,
                    label = COALESCE(v_label, label),
                    -- 20261029010000: a blank division keeps the slot's
                    -- reservation, as a blank label keeps its label; Field
                    -- Management clears one.
                    division_id = COALESCE(v_division_id, division_id),
                    updated_at = v_now
                WHERE id = v_practice_slot.id
                  AND organization_id = v_job.organization_id
                RETURNING * INTO v_practice_slot_after;

                INSERT INTO public.import_application_records (
                    organization_id,
                    import_job_id,
                    import_type,
                    target_table,
                    target_id,
                    operation,
                    previous_payload,
                    applied_payload,
                    applied_at,
                    applied_by
                )
                VALUES (
                    v_job.organization_id,
                    p_import_job_id,
                    'fields',
                    'practice_slots',
                    v_practice_slot_after.id,
                    'updated',
                    v_previous_payload,
                    to_jsonb(v_practice_slot_after),
                    v_now,
                    auth.uid()
                )
                ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

                v_updated_practice_slots := v_updated_practice_slots + 1;
            END IF;
        ELSE
            SELECT *
            INTO v_game_slot
            FROM public.game_slots gs
            WHERE gs.organization_id = v_job.organization_id
              AND gs.field_id = v_field.id
              AND gs.slot_date = v_slot_date
              AND gs.start_time = v_start_time
            ORDER BY gs.created_at, gs.id
            LIMIT 1;

            IF NOT FOUND THEN
                INSERT INTO public.game_slots (
                    organization_id,
                    field_id,
                    division_id,
                    slot_date,
                    start_time,
                    end_time,
                    week_index,
                    capacity
                )
                VALUES (
                    v_job.organization_id,
                    v_field.id,
                    v_division_id,
                    v_slot_date,
                    v_start_time,
                    v_end_time,
                    v_week_index::smallint,
                    v_capacity::smallint
                )
                RETURNING * INTO v_game_slot_after;

                INSERT INTO public.import_application_records (
                    organization_id,
                    import_job_id,
                    import_type,
                    target_table,
                    target_id,
                    operation,
                    previous_payload,
                    applied_payload,
                    applied_at,
                    applied_by
                )
                VALUES (
                    v_job.organization_id,
                    p_import_job_id,
                    'fields',
                    'game_slots',
                    v_game_slot_after.id,
                    'inserted',
                    NULL,
                    to_jsonb(v_game_slot_after),
                    v_now,
                    auth.uid()
                )
                ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

                v_inserted_game_slots := v_inserted_game_slots + 1;
            ELSE
                v_previous_payload := to_jsonb(v_game_slot);
                UPDATE public.game_slots
                SET
                    field_id = v_field.id,
                    division_id = v_division_id,
                    slot_date = v_slot_date,
                    start_time = v_start_time,
                    end_time = v_end_time,
                    week_index = v_week_index::smallint,
                    capacity = v_capacity::smallint,
                    updated_at = v_now
                WHERE id = v_game_slot.id
                  AND organization_id = v_job.organization_id
                RETURNING * INTO v_game_slot_after;

                INSERT INTO public.import_application_records (
                    organization_id,
                    import_job_id,
                    import_type,
                    target_table,
                    target_id,
                    operation,
                    previous_payload,
                    applied_payload,
                    applied_at,
                    applied_by
                )
                VALUES (
                    v_job.organization_id,
                    p_import_job_id,
                    'fields',
                    'game_slots',
                    v_game_slot_after.id,
                    'updated',
                    v_previous_payload,
                    to_jsonb(v_game_slot_after),
                    v_now,
                    auth.uid()
                )
                ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

                v_updated_game_slots := v_updated_game_slots + 1;
            END IF;
        END IF;

        UPDATE public.staging_import_rows
        SET
            applied_at = v_now,
            applied_by = auth.uid()
        WHERE id = v_row.id;
    END LOOP;

    SELECT count(*)
    INTO v_total_applied_count
    FROM public.import_application_records
    WHERE import_job_id = p_import_job_id
      AND import_type = 'fields';

    v_status_result := CASE
        WHEN jsonb_array_length(v_validation_errors) > 0
          OR v_invalid_rows > 0
        THEN 'completed_with_warnings'
        ELSE 'completed'
    END;

    v_result := jsonb_build_object(
        'status', v_status_result,
        'staged_rows', (
            SELECT count(*)
            FROM public.staging_import_rows
            WHERE import_job_id = p_import_job_id
              AND import_type = 'fields'
        ),
        'inserted_locations', v_inserted_locations,
        'updated_locations', v_updated_locations,
        'inserted_fields', v_inserted_fields,
        'updated_fields', v_updated_fields,
        'inserted_field_subunits', v_inserted_subunits,
        'inserted_practice_slots', v_inserted_practice_slots,
        'updated_practice_slots', v_updated_practice_slots,
        'inserted_game_slots', v_inserted_game_slots,
        'updated_game_slots', v_updated_game_slots,
        'invalid_rows', v_invalid_rows,
        'validation_error_rows', jsonb_array_length(v_validation_errors),
        'total_applied_rows', v_total_applied_count
    );

    UPDATE public.import_jobs
    SET
        status = v_status_result,
        processed_rows = v_total_applied_count,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{field_finalize}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.completed',
        'import_job',
        p_import_job_id,
        v_result
    );

    RETURN v_result;
END;
$$;


COMMENT ON FUNCTION public.finalize_field_import_job(uuid, jsonb) IS
    'Admin-only apply of a staged fields CSV: locations, fields, subunits, practice and game slots, each recorded for rollback. As of 20261029010000 a practice row''s Division reserves its slot (named within the import''s season; an unknown name fails the row) and a practice slot that would overlap another on the same ground and weekday in the same dates fails the row (practice_slot_conflicts); both fail before anything is written.';

-- ---------------------------------------------------------------------------
-- 6. rollback_field_import_job: the reservation comes back with the slot.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rollback_field_import_job(p_import_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_record public.import_application_records%ROWTYPE;
    v_previous jsonb;
    v_now timestamptz := now();
    v_pending_record_count integer := 0;
    v_deleted_locations integer := 0;
    v_deleted_fields integer := 0;
    v_deleted_subunits integer := 0;
    v_deleted_practice_slots integer := 0;
    v_deleted_game_slots integer := 0;
    v_restored_records integer := 0;
    v_blocked_records integer := 0;
    v_blocked jsonb := '[]'::jsonb;
    v_affected_count integer;
    v_result jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_job
    FROM public.import_jobs
    WHERE id = p_import_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT count(*)
    INTO v_pending_record_count
    FROM public.import_application_records
    WHERE import_job_id = p_import_job_id
      AND organization_id = v_job.organization_id
      AND import_type = 'fields'
      AND rolled_back_at IS NULL;

    IF v_pending_record_count = 0 THEN
        RAISE EXCEPTION 'Import job % has no field application records to roll back', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    FOR v_record IN
        SELECT *
        FROM public.import_application_records
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'fields'
          AND rolled_back_at IS NULL
        ORDER BY
          CASE target_table
            WHEN 'game_slots' THEN 1
            WHEN 'practice_slots' THEN 2
            WHEN 'field_subunits' THEN 3
            WHEN 'fields' THEN 4
            WHEN 'locations' THEN 5
            ELSE 99
          END,
          applied_at DESC,
          id DESC
    LOOP
        IF v_record.operation = 'inserted' THEN
            IF v_record.target_table = 'game_slots' THEN
                -- **`ga.slot_id` was missing, and its twin one arm down had
                -- it.** `game_assignments` reaches a game slot through TWO
                -- CASCADE columns -- `game_slot_id` and `slot_id`
                -- (20260503030000:39-56) -- and `persist_game_schedule` writes
                -- both, but nothing requires a row to carry both, and this arm
                -- consulted only the first. The `practice_slots` arm below has
                -- always read `slot_id OR practice_slot_id`. Adopting the
                -- sibling's contract rather than inventing a third one is the
                -- rule that produced this migration; the asymmetry was found by
                -- walking the closure from `game_slots`, not by reading the arm.
                IF EXISTS (
                    SELECT 1 FROM public.games g
                    WHERE g.organization_id = v_job.organization_id
                      AND g.game_slot_id = v_record.target_id
                ) OR EXISTS (
                    SELECT 1 FROM public.game_assignments ga
                    WHERE ga.organization_id = v_job.organization_id
                      AND (
                        ga.game_slot_id = v_record.target_id
                        OR ga.slot_id = v_record.target_id
                      )
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'game_slot_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.game_slots gs
                WHERE gs.id = v_record.target_id
                  AND gs.organization_id = v_job.organization_id;
                v_deleted_game_slots := v_deleted_game_slots + 1;
            ELSIF v_record.target_table = 'practice_slots' THEN
                IF EXISTS (
                    SELECT 1 FROM public.practice_assignments pa
                    WHERE pa.organization_id = v_job.organization_id
                      AND (
                        pa.slot_id = v_record.target_id
                        OR pa.practice_slot_id = v_record.target_id
                      )
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'practice_slot_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.practice_slots ps
                WHERE ps.id = v_record.target_id
                  AND ps.organization_id = v_job.organization_id;
                v_deleted_practice_slots := v_deleted_practice_slots + 1;
            ELSIF v_record.target_table = 'field_subunits' THEN
                -- **A COMPLETE cut, not a narrower guard.** The cascade closure
                -- from `field_subunits` is `practice_slots` and, through it
                -- only, `practice_assignments`; there is no
                -- `game_slots.field_subunit_id` and no
                -- `practice_assignments.field_subunit_id`. So nothing
                -- downstream can be destroyed without a practice slot on this
                -- subunit existing, and that is what this refuses on.
                -- `docs/sql/20260909000000_smoke.sql` section 2 re-derives the
                -- closure every run, so the day a second edge appears this
                -- argument fails loudly instead of going quietly stale.
                IF EXISTS (
                    SELECT 1 FROM public.practice_slots ps
                    WHERE ps.organization_id = v_job.organization_id
                      AND ps.field_subunit_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'subunit_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.field_subunits fs
                WHERE fs.id = v_record.target_id
                  AND fs.organization_id = v_job.organization_id;
                v_deleted_subunits := v_deleted_subunits + 1;
            ELSIF v_record.target_table = 'fields' THEN
                -- **LIVE-3.** This read `EXISTS practice_slots OR EXISTS
                -- game_slots` and nothing else -- two of the six kinds a field
                -- delete reaches. `public.field_bookings` is the shared
                -- reading, already used by `admin_retire_field` and
                -- `admin_delete_field`; a third hand-written list here is what
                -- guarantees the next correction lands on two of three.
                --
                -- `p_after => NULL` because a rollback removes the ground
                -- outright, exactly as a deletion does: no date applies and
                -- everything on it counts, dated or not.
                --
                -- **Locked before it is counted, in the sibling's form and the
                -- sibling's order.** Without this a booking inserted between
                -- the count and the DELETE below is destroyed by the cascade
                -- having been counted as nothing -- and section 1 of this
                -- migration made that worse, because an availability profile
                -- inserted in the window is now CASCADED rather than unlinked.
                -- `FOR UPDATE` on the field blocks a concurrent INSERT into
                -- anything with a foreign key to it; locking the field's SLOTS
                -- as well is what covers `games` and an assignment carrying
                -- only a slot id, neither of which references the field.
                -- Field first, then its slots, which is the order
                -- `admin_delete_field` takes, so the two cannot deadlock
                -- against each other. The header says why the OTHER arms are
                -- left unlocked and section 1b of the smoke holds them to it.
                PERFORM 1 FROM public.fields f
                 WHERE f.id = v_record.target_id
                   AND f.organization_id = v_job.organization_id
                 FOR UPDATE;
                PERFORM 1 FROM public.game_slots gs
                 WHERE gs.organization_id = v_job.organization_id
                   AND gs.field_id = v_record.target_id
                 FOR UPDATE;
                PERFORM 1 FROM public.practice_slots ps
                 WHERE ps.organization_id = v_job.organization_id
                   AND ps.field_id = v_record.target_id
                 FOR UPDATE;

                SELECT count(*) INTO v_affected_count
                  FROM public.field_bookings(
                         v_job.organization_id, v_record.target_id, NULL);

                IF v_affected_count > 0 THEN
                    v_blocked_records := v_blocked_records + 1;
                    -- **The reason and the count, not just the count.** An
                    -- operator told "3 blocked" cannot act; told which record
                    -- and what holds it, they can. The record keeps
                    -- `rolled_back_at IS NULL`, so clearing the booking and
                    -- re-running rolls it back -- refusal means deferral here
                    -- for the same reason it does in
                    -- finalize_field_availability_import_job.
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'bookings_exist',
                        'affected_count', v_affected_count);
                    CONTINUE;
                END IF;

                -- **No scenario prune here, and that is a consequence
                -- rather than an omission.** `admin_delete_field` needs one
                -- because `p_confirm => true` lets it delete a field that
                -- still carries an availability profile. This arm has no
                -- override: it reaches the DELETE only when the producer
                -- returned NOTHING, and `availability_profile` is one of the
                -- six kinds the producer returns, so a profile on this ground
                -- is unreachable at this line and a prune here would be dead
                -- code presented as a guard. Section 4 of the smoke derives
                -- that distinction from the bodies rather than keeping a list
                -- of which deleter needs one.
                DELETE FROM public.fields f
                WHERE f.id = v_record.target_id
                  AND f.organization_id = v_job.organization_id;
                v_deleted_fields := v_deleted_fields + 1;
            ELSIF v_record.target_table = 'locations' THEN
                -- **A complete cut, like the subunit arm, and for the same
                -- kind of reason.** `locations` is referenced directly by
                -- exactly two tables: `fields` (CASCADE), which this refuses
                -- on, and `field_blackouts` (CASCADE, added by
                -- 20260906000100). Everything else a location delete could
                -- reach is under `fields`, so refusing while any field remains
                -- cuts the whole closure at its only other edge.
                --
                -- `field_blackouts` is EXCLUDED, on 20260907000000's reasoning
                -- for excluding it from the booking family: a closure is not a
                -- booking, and removing a site cannot strand the statement that
                -- the site was already shut. Stated here rather than left
                -- implicit, and re-derived every harness run by
                -- docs/sql/20260909000000_smoke.sql section 2b -- that edge did
                -- not exist when this arm was written and nothing noticed when
                -- 20260906000100 added it.
                IF EXISTS (
                    SELECT 1 FROM public.fields f
                    WHERE f.organization_id = v_job.organization_id
                      AND f.location_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'location_has_fields');
                    CONTINUE;
                END IF;

                DELETE FROM public.locations l
                WHERE l.id = v_record.target_id
                  AND l.organization_id = v_job.organization_id;
                v_deleted_locations := v_deleted_locations + 1;
            ELSE
                -- **The arm that used to be missing.** With no ELSE, a record
                -- naming any of the other seven `target_table` values
                -- 20260522120000 admits fell straight through to the ledger
                -- UPDATE below and was stamped `{"deleted": true}` having
                -- deleted nothing -- a lie in the only record of what a
                -- rollback did. DEFENSIVE rather than reachable through the
                -- apply path, which only ever writes the five with
                -- `import_type = 'fields'`: arriving here means the ledger
                -- disagrees with its own import type, and a job whose record
                -- of what it did cannot be trusted must not be half rolled
                -- back on the strength of it. The `ELSE 99` in this
                -- statement's own ORDER BY already conceded the value can
                -- arrive.
                RAISE EXCEPTION
                  'rollback_field_import_job cannot undo an insert into %; the field import applies only locations, fields, field_subunits, practice_slots and game_slots (record %)',
                  v_record.target_table, v_record.id
                  USING ERRCODE = '22023';
            END IF;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = jsonb_build_object('deleted', true)
            WHERE id = v_record.id;
        ELSIF v_record.operation = 'updated' THEN
            v_previous := v_record.previous_payload;

            IF v_record.target_table = 'locations' THEN
                UPDATE public.locations
                SET
                    name = v_previous->>'name',
                    address = v_previous->>'address',
                    lighting_available = COALESCE((v_previous->>'lighting_available')::boolean, false),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'fields' THEN
                UPDATE public.fields
                SET
                    location_id = (v_previous->>'location_id')::uuid,
                    name = v_previous->>'name',
                    surface_type = v_previous->>'surface_type',
                    size = v_previous->>'size',
                    supports_halves = COALESCE((v_previous->>'supports_halves')::boolean, false),
                    max_age = v_previous->>'max_age',
                    priority_rating = COALESCE((v_previous->>'priority_rating')::integer, 1),
                    active = COALESCE((v_previous->>'active')::boolean, true),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'practice_slots' THEN
                UPDATE public.practice_slots
                SET
                    field_id = (v_previous->>'field_id')::uuid,
                    field_subunit_id = NULLIF(v_previous->>'field_subunit_id', '')::uuid,
                    day_of_week = (v_previous->>'day_of_week')::public.day_of_week,
                    start_time = (v_previous->>'start_time')::time,
                    end_time = (v_previous->>'end_time')::time,
                    capacity = COALESCE((v_previous->>'capacity')::smallint, 1),
                    valid_from = NULLIF(v_previous->>'valid_from', '')::date,
                    valid_until = NULLIF(v_previous->>'valid_until', '')::date,
                    label = v_previous->>'label',
                    -- 20261029010000: the reservation the import replaced
                    -- comes back with the slot. A snapshot taken before the
                    -- column existed says nothing about it, so the slot keeps
                    -- the one it has; a division deleted since restores none.
                    division_id = CASE
                        WHEN NOT (v_previous ? 'division_id') THEN division_id
                        ELSE (SELECT d.id
                                FROM public.divisions d
                               WHERE d.id = NULLIF(v_previous->>'division_id', '')::uuid
                                 AND d.organization_id = v_job.organization_id)
                    END,
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'game_slots' THEN
                UPDATE public.game_slots
                SET
                    field_id = (v_previous->>'field_id')::uuid,
                    division_id = NULLIF(v_previous->>'division_id', '')::uuid,
                    slot_date = NULLIF(v_previous->>'slot_date', '')::date,
                    start_time = NULLIF(v_previous->>'start_time', '')::time,
                    end_time = NULLIF(v_previous->>'end_time', '')::time,
                    week_index = NULLIF(v_previous->>'week_index', '')::smallint,
                    capacity = COALESCE((v_previous->>'capacity')::smallint, 1),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSE
                -- **The same missing arm, one branch down, and worse.** An
                -- unhandled `updated` record was stamped with its previous
                -- payload AND counted in `restored_records` -- a counter
                -- testifying to a restore that never happened, which is the
                -- shape 8.4 PR 2 recorded when `lifecycleNodesJudged` reported
                -- work it had not done. `field_subunits` is genuinely absent
                -- from this list because the apply path never UPDATES one: it
                -- inserts subunits or leaves them, so there is nothing to
                -- restore. That is why the union here is four and the union
                -- above is five.
                RAISE EXCEPTION
                  'rollback_field_import_job cannot restore an update to %; the field import updates only locations, fields, practice_slots and game_slots (record %)',
                  v_record.target_table, v_record.id
                  USING ERRCODE = '22023';
            END IF;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = v_previous
            WHERE id = v_record.id;

            v_restored_records := v_restored_records + 1;
        END IF;
    END LOOP;

    -- **The trail gets a BOUNDED rendering; the caller gets the whole list.**
    -- One job's ledger can hold a row per CSV line, so a rollback refused on a
    -- busy season would otherwise write an arbitrarily large `blocked` array
    -- into `import_jobs.warning_summary` AND into the audit row, on every
    -- attempt. `public.field_bookings_digest` is the helper 20260907000000
    -- built for exactly this on the refusal path, and its shape is why the
    -- entries above are keyed `kind`/`id` rather than
    -- `target_table`/`target_id`: it counts `by_kind`, so adopting the
    -- sibling's key names makes the per-table refusal counts fall out instead
    -- of needing a third convention.
    v_result := jsonb_build_object(
        'status', CASE WHEN v_blocked_records > 0 THEN 'completed_with_warnings' ELSE 'rolled_back' END,
        'deleted_locations', v_deleted_locations,
        'deleted_fields', v_deleted_fields,
        'deleted_field_subunits', v_deleted_subunits,
        'deleted_practice_slots', v_deleted_practice_slots,
        'deleted_game_slots', v_deleted_game_slots,
        'restored_records', v_restored_records,
        'blocked_records', v_blocked_records,
        'blocked', public.field_bookings_digest(v_blocked)
    );

    UPDATE public.import_jobs
    SET
        status = CASE WHEN v_blocked_records > 0 THEN 'completed_with_warnings' ELSE 'needs_fix' END,
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{field_rollback}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.rolled_back',
        'import_job',
        p_import_job_id,
        v_result
    );

    -- The caller renders every refusal, so it gets all of them.
    RETURN v_result || jsonb_build_object('blocked', v_blocked);
END;
$$;


COMMENT ON FUNCTION public.rollback_field_import_job(uuid) IS
  'Admin-only rollback for a field-slot CSV apply. Deletes inserted slots, subunits, fields and empty locations, and restores updated rows from the ledger snapshot. As of 20260909000000 a field is refused unless public.field_bookings reports nothing on it -- the same reading admin_delete_field and admin_retire_field use, rather than this function''s former two-table union. A refused record is reported in `blocked` with its table, its id, a reason and, for a field, the booking count, and keeps rolled_back_at NULL so clearing the booking and re-running rolls it back. A target_table neither switch handles raises 22023 rather than stamping the ledger as rolled back. As of 20261029010000 an updated practice slot gets back the reservation (division_id) its snapshot holds; a snapshot from before the column keeps the slot''s current one, and restoring is not judged for clashes.';

-- ---------------------------------------------------------------------------
-- 7. admin_upsert_division_settings takes plays_games (a new signature).
-- ---------------------------------------------------------------------------

DROP FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer);

CREATE FUNCTION public.admin_upsert_division_settings(
    p_organization_id uuid,
    p_season_settings_id uuid,
    p_division_id uuid DEFAULT NULL,
    p_name text DEFAULT NULL,
    p_max_roster_size integer DEFAULT NULL,
    p_min_roster_size integer DEFAULT NULL,
    p_target_team_size integer DEFAULT NULL,
    p_team_count_override integer DEFAULT NULL,
    p_min_teams integer DEFAULT NULL,
    p_max_teams integer DEFAULT NULL,
    p_plays_games boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_season_org_id uuid;
    v_name text := btrim(COALESCE(p_name, ''));
    v_existing public.divisions%ROWTYPE;
    v_result public.divisions%ROWTYPE;
    v_changed boolean := true;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'p_season_settings_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT ss.organization_id
      INTO v_season_org_id
      FROM public.season_settings ss
     WHERE ss.id = p_season_settings_id;

    IF v_season_org_id IS NULL THEN
        RAISE EXCEPTION 'Season settings not found in organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_season_org_id <> p_organization_id THEN
        RAISE EXCEPTION 'Season settings do not belong to organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_division_id IS NOT NULL THEN
        SELECT d.*
          INTO v_existing
          FROM public.divisions d
         WHERE d.id = p_division_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Division not found in organization %', p_organization_id
                USING ERRCODE = '42501';
        END IF;

        IF v_existing.organization_id <> p_organization_id
           OR v_existing.season_settings_id <> p_season_settings_id THEN
            RAISE EXCEPTION 'Division does not belong to the requested organization and season'
                USING ERRCODE = '42501';
        END IF;

        IF v_name = '' THEN
            v_name := v_existing.name;
        END IF;
    ELSE
        IF v_name = '' THEN
            RAISE EXCEPTION 'p_name is required'
                USING ERRCODE = '23502';
        END IF;

        SELECT d.*
          INTO v_existing
          FROM public.divisions d
         WHERE d.organization_id = p_organization_id
           AND d.season_settings_id = p_season_settings_id
           AND d.name = v_name;
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'p_name is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_division_id IS NULL THEN
        WITH upserted AS (
            INSERT INTO public.divisions (
                organization_id,
                season_settings_id,
                name,
                max_roster_size,
                min_roster_size,
                target_team_size,
                team_count_override,
                min_teams,
                max_teams,
                plays_games
            )
            VALUES (
                p_organization_id,
                p_season_settings_id,
                v_name,
                p_max_roster_size,
                p_min_roster_size,
                p_target_team_size,
                p_team_count_override,
                p_min_teams,
                p_max_teams,
                -- 20261029010000: a new division plays games unless told not to.
                COALESCE(p_plays_games, true)
            )
            ON CONFLICT (season_settings_id, name) DO UPDATE
               SET max_roster_size = EXCLUDED.max_roster_size,
                   min_roster_size = EXCLUDED.min_roster_size,
                   target_team_size = EXCLUDED.target_team_size,
                   team_count_override = EXCLUDED.team_count_override,
                   min_teams = EXCLUDED.min_teams,
                   max_teams = EXCLUDED.max_teams,
                   -- 20261029010000: NULL keeps the stored value.
                   plays_games = COALESCE(p_plays_games, public.divisions.plays_games),
                   updated_at = now()
             WHERE public.divisions.organization_id = p_organization_id
               AND (
                   public.divisions.max_roster_size IS DISTINCT FROM EXCLUDED.max_roster_size
                   OR public.divisions.min_roster_size IS DISTINCT FROM EXCLUDED.min_roster_size
                   OR public.divisions.target_team_size IS DISTINCT FROM EXCLUDED.target_team_size
                   OR public.divisions.team_count_override IS DISTINCT FROM EXCLUDED.team_count_override
                   OR public.divisions.min_teams IS DISTINCT FROM EXCLUDED.min_teams
                   OR public.divisions.max_teams IS DISTINCT FROM EXCLUDED.max_teams
                   OR (p_plays_games IS NOT NULL
                       AND public.divisions.plays_games IS DISTINCT FROM p_plays_games)
               )
            RETURNING *
        )
        SELECT upserted.*
          INTO v_result
          FROM upserted;

        IF v_result.id IS NULL THEN
            SELECT d.*
              INTO v_result
              FROM public.divisions d
             WHERE d.organization_id = p_organization_id
               AND d.season_settings_id = p_season_settings_id
               AND d.name = v_name;

            v_changed := false;
        END IF;
    ELSE
        v_changed :=
            v_existing.name IS DISTINCT FROM v_name
            OR v_existing.max_roster_size IS DISTINCT FROM p_max_roster_size
            OR v_existing.min_roster_size IS DISTINCT FROM p_min_roster_size
            OR v_existing.target_team_size IS DISTINCT FROM p_target_team_size
            OR v_existing.team_count_override IS DISTINCT FROM p_team_count_override
            OR v_existing.min_teams IS DISTINCT FROM p_min_teams
            OR v_existing.max_teams IS DISTINCT FROM p_max_teams
            OR (p_plays_games IS NOT NULL AND v_existing.plays_games IS DISTINCT FROM p_plays_games);

        IF v_changed THEN
            UPDATE public.divisions
               SET name = v_name,
                   max_roster_size = p_max_roster_size,
                   min_roster_size = p_min_roster_size,
                   target_team_size = p_target_team_size,
                   team_count_override = p_team_count_override,
                   min_teams = p_min_teams,
                   max_teams = p_max_teams,
                   plays_games = COALESCE(p_plays_games, plays_games),
                   updated_at = now()
             WHERE id = v_existing.id
             RETURNING * INTO v_result;
        ELSE
            v_result := v_existing;
        END IF;
    END IF;

    IF v_changed THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'division',
            v_result.id,
            jsonb_build_object(
                'setting', 'division_team_generation_rules',
                'division_id', v_result.id,
                'season_settings_id', p_season_settings_id,
                'name', v_result.name,
                'previous', CASE
                    WHEN v_existing.id IS NULL THEN NULL
                    ELSE jsonb_build_object(
                        'name', v_existing.name,
                        'max_roster_size', v_existing.max_roster_size,
                        'min_roster_size', v_existing.min_roster_size,
                        'target_team_size', v_existing.target_team_size,
                        'team_count_override', v_existing.team_count_override,
                        'min_teams', v_existing.min_teams,
                        'max_teams', v_existing.max_teams,
                        'plays_games', v_existing.plays_games
                    )
                END,
                'current', jsonb_build_object(
                    'name', v_result.name,
                    'max_roster_size', v_result.max_roster_size,
                    'min_roster_size', v_result.min_roster_size,
                    'target_team_size', v_result.target_team_size,
                    'team_count_override', v_result.team_count_override,
                    'min_teams', v_result.min_teams,
                    'max_teams', v_result.max_teams,
                    'plays_games', v_result.plays_games
                )
            )
        );
    END IF;

    RETURN to_jsonb(v_result) || jsonb_build_object('changed', v_changed);
END;
$$;


REVOKE ALL ON FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean) TO authenticated;

COMMENT ON FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean) IS
    'Admin-only org-scoped upsert for division team-generation rules with atomic settings.updated audit logging. As of 20261029010000 it also takes plays_games (NULL keeps the stored value; a new division plays games), in its before and after.';

-- ---------------------------------------------------------------------------
-- 8. admin_set_practice_slot_division: set or clear one slot's reservation.
-- ---------------------------------------------------------------------------

INSERT INTO public.audit_actions (action) VALUES ('practice_slot.division_set')
ON CONFLICT (action) DO NOTHING;

CREATE FUNCTION public.admin_set_practice_slot_division(
    p_slot_id uuid,
    p_division_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_slot public.practice_slots%ROWTYPE;
    v_previous_name text;
    v_division_name text;
BEGIN
    IF p_slot_id IS NULL THEN
        RAISE EXCEPTION 'p_slot_id is required' USING ERRCODE = '23502';
    END IF;

    -- Locked, so a concurrent import cannot read the reservation this call
    -- is replacing. Not found and not an admin are one refusal: the caller
    -- learns nothing about another organization's slots.
    SELECT ps.* INTO v_slot FROM public.practice_slots ps WHERE ps.id = p_slot_id FOR UPDATE;
    IF v_uid IS NULL OR NOT FOUND OR NOT public.is_org_admin(v_slot.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin reserves a practice slot'
            USING ERRCODE = '42501';
    END IF;

    IF p_division_id IS NOT NULL THEN
        SELECT d.name INTO v_division_name
          FROM public.divisions d
         WHERE d.id = p_division_id
           AND d.organization_id = v_slot.organization_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Division % is not a division of this slot''s organization', p_division_id
                USING ERRCODE = '22023';
        END IF;
    END IF;

    IF v_slot.division_id IS NOT DISTINCT FROM p_division_id THEN
        RETURN jsonb_build_object('id', v_slot.id, 'organization_id', v_slot.organization_id,
                                  'division_id', v_slot.division_id, 'changed', false);
    END IF;

    SELECT d.name INTO v_previous_name FROM public.divisions d WHERE d.id = v_slot.division_id;

    UPDATE public.practice_slots
       SET division_id = p_division_id,
           updated_at = now()
     WHERE id = v_slot.id;

    PERFORM public.record_audit_event(
        v_slot.organization_id,
        'practice_slot.division_set',
        'practice_slot',
        v_slot.id,
        jsonb_build_object(
            'practice_slot_id', v_slot.id,
            'previous', jsonb_build_object('division_id', v_slot.division_id, 'name', v_previous_name),
            'current', jsonb_build_object('division_id', p_division_id, 'name', v_division_name)
        )
    );

    RETURN jsonb_build_object('id', v_slot.id, 'organization_id', v_slot.organization_id,
                              'division_id', p_division_id, 'changed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_practice_slot_division(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_practice_slot_division(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_set_practice_slot_division(uuid, uuid) IS
    'Admin-only: reserve a practice slot to a division of its organization, or clear the reservation (NULL). Audited as practice_slot.division_set with the before and after; a repeat changes nothing. 20261029010000.';

-- ---------------------------------------------------------------------------
-- 9. End-state check.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_left text;
BEGIN
    IF (SELECT format('%s|%s|%s', format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid))
          FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = 'public.divisions'::regclass AND a.attname = 'plays_games' AND NOT a.attisdropped)
       IS DISTINCT FROM 'boolean|t|true' THEN
        RAISE EXCEPTION 'divisions.plays_games is not boolean NOT NULL DEFAULT true';
    END IF;

    IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
         WHERE c.conrelid = 'public.practice_slots'::regclass AND c.conname = 'practice_slots_division_fkey')
       IS DISTINCT FROM 'FOREIGN KEY (division_id, organization_id) REFERENCES divisions(id, organization_id) ON DELETE SET NULL (division_id)' THEN
        RAISE EXCEPTION 'practice_slots.division_id does not reference a division of the same organization, cleared on delete';
    END IF;

    IF to_regprocedure('public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer)') IS NOT NULL THEN
        RAISE EXCEPTION 'the ten-argument admin_upsert_division_settings is still callable';
    END IF;

    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_left
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.oid IN ('public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean)'::regprocedure,
                     'public.admin_set_practice_slot_division(uuid, uuid)'::regprocedure,
                     'public.finalize_field_import_job(uuid, jsonb)'::regprocedure,
                     'public.rollback_field_import_job(uuid)'::regprocedure)
       AND NOT (p.prosecdef
                AND 'search_path=public' = ANY (p.proconfig)
                AND 'TimeZone=UTC' = ANY (p.proconfig)
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'not a pinned definer callable by authenticated and not anon: %', v_left;
    END IF;

    IF has_function_privilege('authenticated', 'public.practice_slot_conflicts(uuid, uuid, uuid, public.day_of_week, time, time, date, date, uuid, integer)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.practice_slot_conflicts(uuid, uuid, uuid, public.day_of_week, time, time, date, date, uuid, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'practice_slot_conflicts is callable by a client role';
    END IF;

    -- The finalizer reaches the rule and names a practice division within the
    -- season (comments stripped, so a comment cannot stand in for the code).
    SELECT regexp_replace(prosrc, '--[^\n]*', '', 'g') INTO v_left
      FROM pg_proc WHERE oid = 'public.finalize_field_import_job(uuid, jsonb)'::regprocedure;
    IF NOT (v_left ~ 'public\.practice_slot_conflicts\(' AND v_left ~ 'd\.season_settings_id = v_import_season_id') THEN
        RAISE EXCEPTION 'finalize_field_import_job does not judge clashes and resolve a practice division within the season';
    END IF;
END;
$$;

COMMIT;
