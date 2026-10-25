-- Revert for 20261029010000_practice_only_divisions.sql
--
-- Restores every object the migration replaced, as it stood after
-- 20261028010000, and removes what it added: `finalize_field_import_job`
-- without practice reservations or the clash refusal (a practice row's
-- Division is read by nothing again; game rows are unchanged either way),
-- `rollback_field_import_job` without the reservation restore, and the
-- ten-argument `admin_upsert_division_settings` (no `p_plays_games`), each
-- with its comment, grants and posture. Then `admin_set_practice_slot_division`
-- and the internal `practice_slot_conflicts` are dropped, and the columns
-- `practice_slots.division_id` (with its reference and index) and
-- `divisions.plays_games` (with the key the reference needed).
--
-- The function DDL is pg_dump's (16) of a harness build at 20261028010000, so
-- each body is that build's text byte for byte; only the OWNER lines are left
-- out (the objects are created by the role that runs this). Each function's
-- grants are revoked from every client role before the dump's are restated,
-- so the default privileges cannot widen it.
--
-- **It destroys data**, counted first: every slot's reservation and every
-- division's practice-only flag. A practice-only division plays games again
-- (the game page builds it a round robin), and a reserved slot is open to
-- every division.
--
-- **Revert the frontend with it.** The app deployed with 20261029010000 reads
-- `divisions.plays_games` and `practice_slots.division_id` (each read falls
-- back when the column is absent: every division plays, every slot is open),
-- and calls `admin_upsert_division_settings` with `p_plays_games` and
-- `admin_set_practice_slot_division`, which then fail. The Edge solver reads
-- `practice_slots.division_id` and refuses a run without it: roll back the
-- `auto-scheduler` function first. The `practice_slot.division_set` audit
-- action stays registered (audit rows may reference it).
--
-- Verified: the harness compares a fingerprint of every restored object
-- (signature, posture, grants, comment and body md5 of the five functions,
-- and the columns, constraints and indexes of `divisions` and
-- `practice_slots`) with the one read off a build at 20261028010000.

BEGIN;

DO $$
DECLARE
    v_reserved bigint;
    v_practice_only bigint;
BEGIN
    SELECT count(*) INTO v_reserved FROM public.practice_slots WHERE division_id IS NOT NULL;
    SELECT count(*) INTO v_practice_only FROM public.divisions WHERE NOT plays_games;
    RAISE NOTICE 'this revert DESTROYS % practice slot reservation(s), which open to every division, and % practice-only division flag(s), which play games again',
        v_reserved, v_practice_only;
END;
$$;

-- 1. The added functions go.

DROP FUNCTION public.admin_set_practice_slot_division(uuid, uuid);

-- 2. admin_upsert_division_settings, as at 20261028010000 (ten arguments).

DROP FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean);

CREATE FUNCTION public.admin_upsert_division_settings(p_organization_id uuid, p_season_settings_id uuid, p_division_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_max_roster_size integer DEFAULT NULL::integer, p_min_roster_size integer DEFAULT NULL::integer, p_target_team_size integer DEFAULT NULL::integer, p_team_count_override integer DEFAULT NULL::integer, p_min_teams integer DEFAULT NULL::integer, p_max_teams integer DEFAULT NULL::integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
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
                max_teams
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
                p_max_teams
            )
            ON CONFLICT (season_settings_id, name) DO UPDATE
               SET max_roster_size = EXCLUDED.max_roster_size,
                   min_roster_size = EXCLUDED.min_roster_size,
                   target_team_size = EXCLUDED.target_team_size,
                   team_count_override = EXCLUDED.team_count_override,
                   min_teams = EXCLUDED.min_teams,
                   max_teams = EXCLUDED.max_teams,
                   updated_at = timezone('utc', now())
             WHERE public.divisions.organization_id = p_organization_id
               AND (
                   public.divisions.max_roster_size IS DISTINCT FROM EXCLUDED.max_roster_size
                   OR public.divisions.min_roster_size IS DISTINCT FROM EXCLUDED.min_roster_size
                   OR public.divisions.target_team_size IS DISTINCT FROM EXCLUDED.target_team_size
                   OR public.divisions.team_count_override IS DISTINCT FROM EXCLUDED.team_count_override
                   OR public.divisions.min_teams IS DISTINCT FROM EXCLUDED.min_teams
                   OR public.divisions.max_teams IS DISTINCT FROM EXCLUDED.max_teams
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
            OR v_existing.max_teams IS DISTINCT FROM p_max_teams;

        IF v_changed THEN
            UPDATE public.divisions
               SET name = v_name,
                   max_roster_size = p_max_roster_size,
                   min_roster_size = p_min_roster_size,
                   target_team_size = p_target_team_size,
                   team_count_override = p_team_count_override,
                   min_teams = p_min_teams,
                   max_teams = p_max_teams,
                   updated_at = timezone('utc', now())
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
                        'max_teams', v_existing.max_teams
                    )
                END,
                'current', jsonb_build_object(
                    'name', v_result.name,
                    'max_roster_size', v_result.max_roster_size,
                    'min_roster_size', v_result.min_roster_size,
                    'target_team_size', v_result.target_team_size,
                    'team_count_override', v_result.team_count_override,
                    'min_teams', v_result.min_teams,
                    'max_teams', v_result.max_teams
                )
            )
        );
    END IF;

    RETURN to_jsonb(v_result) || jsonb_build_object('changed', v_changed);
END;
$$;

COMMENT ON FUNCTION public.admin_upsert_division_settings(p_organization_id uuid, p_season_settings_id uuid, p_division_id uuid, p_name text, p_max_roster_size integer, p_min_roster_size integer, p_target_team_size integer, p_team_count_override integer, p_min_teams integer, p_max_teams integer) IS 'Admin-only org-scoped upsert for division team-generation rules with atomic settings.updated audit logging.';

REVOKE ALL ON FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.admin_upsert_division_settings(p_organization_id uuid, p_season_settings_id uuid, p_division_id uuid, p_name text, p_max_roster_size integer, p_min_roster_size integer, p_target_team_size integer, p_team_count_override integer, p_min_teams integer, p_max_teams integer) TO authenticated;
GRANT ALL ON FUNCTION public.admin_upsert_division_settings(p_organization_id uuid, p_season_settings_id uuid, p_division_id uuid, p_name text, p_max_roster_size integer, p_min_roster_size integer, p_target_team_size integer, p_team_count_override integer, p_min_teams integer, p_max_teams integer) TO service_role;

-- 3. finalize_field_import_job, as at 20261028010000.

CREATE OR REPLACE FUNCTION public.finalize_field_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
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
    v_now timestamptz := timezone('utc', now());
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
        ELSIF public.import_payload_text(v_payload, 'division', 'division_name') IS NOT NULL THEN
            SELECT d.id
            INTO v_division_id
            FROM public.divisions d
            WHERE d.organization_id = v_job.organization_id
              AND lower(d.name) = lower(public.import_payload_text(v_payload, 'division', 'division_name'))
            ORDER BY d.created_at, d.id
            LIMIT 1;
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
                    label
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
                    v_label
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

COMMENT ON FUNCTION public.finalize_field_import_job(uuid, jsonb) IS NULL;

REVOKE ALL ON FUNCTION public.finalize_field_import_job(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.finalize_field_import_job(p_import_job_id uuid, p_validation_errors jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.finalize_field_import_job(p_import_job_id uuid, p_validation_errors jsonb) TO service_role;

-- 4. rollback_field_import_job, as at 20261028010000.

CREATE OR REPLACE FUNCTION public.rollback_field_import_job(p_import_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_record public.import_application_records%ROWTYPE;
    v_previous jsonb;
    v_now timestamptz := timezone('utc', now());
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

COMMENT ON FUNCTION public.rollback_field_import_job(p_import_job_id uuid) IS 'Admin-only rollback for a field-slot CSV apply. Deletes inserted slots, subunits, fields and empty locations, and restores updated rows from the ledger snapshot. As of 20260909000000 a field is refused unless public.field_bookings reports nothing on it -- the same reading admin_delete_field and admin_retire_field use, rather than this function''s former two-table union. A refused record is reported in `blocked` with its table, its id, a reason and, for a field, the booking count, and keeps rolled_back_at NULL so clearing the booking and re-running rolls it back. A target_table neither switch handles raises 22023 rather than stamping the ledger as rolled back.';

REVOKE ALL ON FUNCTION public.rollback_field_import_job(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.rollback_field_import_job(p_import_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rollback_field_import_job(p_import_job_id uuid) TO service_role;

-- 5. The clash helper, then the columns (the finalizer above no longer
--    names either).

DROP FUNCTION public.practice_slot_conflicts(uuid, uuid, uuid, public.day_of_week, time, time, date, date, uuid, integer);

DROP INDEX public.idx_practice_slots_division_id;
ALTER TABLE public.practice_slots DROP CONSTRAINT practice_slots_division_fkey;
ALTER TABLE public.practice_slots DROP COLUMN division_id;
ALTER TABLE public.divisions DROP CONSTRAINT divisions_id_organization_id_key;
ALTER TABLE public.divisions DROP COLUMN plays_games;

COMMIT;
