-- Revert for 20261109010000_season_rollover.sql
--
-- Puts back the three replaced functions as they stood after 20261108010000 (create_import_job,
-- finalize_import_job and finalize_coach_import_job: the active season only takes an import; each
-- checked by the md5 of its text at the end), drops the four season writers, the catalogues, the
-- three guard triggers (with the pending-import helper, `import_age_rule`, the division age-rule helpers and the revision trigger) and the
-- completed-season triggers on the people and schedule tables with their functions, the two cutoff
-- columns, `season_settings.age_rule_revision`, `import_jobs.age_rule_season_id`/`age_rule_revision` and the `custom` mode, and unregisters the four audit actions while no audit row uses
-- them.
--
-- **What it cannot undo.** A season set to the `custom` cutoff goes back to the default school year
-- (`school_year_aug_jul`): the day it held is lost, and the NOTICE counts those seasons. Draft
-- seasons, the players and coaches imported into one, and the divisions a rollover copied all stay:
-- they are ordinary rows, and the E3a keys hold them. With the old guard back, a draft that has
-- players takes no further import until it is activated.
-- Run it only together with the frontend change it came with.

BEGIN;

DO $revert$
DECLARE
    v_custom bigint;
    v_drafts bigint;
    v_draft_players bigint;
BEGIN
    SELECT count(*) INTO v_custom FROM public.season_settings WHERE age_cutoff_mode = 'custom';
    SELECT count(*) INTO v_drafts FROM public.season_settings WHERE status = 'draft';
    SELECT count(*) INTO v_draft_players FROM public.players p
      JOIN public.season_settings s ON s.id = p.season_settings_id WHERE s.status = 'draft';
    RAISE NOTICE 'this revert sets % custom-cutoff season(s) back to the school year; % draft season(s) stay (% player(s) imported into drafts)',
        v_custom, v_drafts, v_draft_players;
END;
$revert$;

-- Seasons on the custom cutoff go back to the default before the constraint narrows.
ALTER TABLE public.season_settings DISABLE TRIGGER season_settings_cutoff_guard;
UPDATE public.season_settings
   SET age_cutoff_mode = 'school_year_aug_jul', age_cutoff_month = NULL, age_cutoff_day = NULL
 WHERE age_cutoff_mode = 'custom';
ALTER TABLE public.season_settings ENABLE TRIGGER season_settings_cutoff_guard;

-- The triggers, then their functions.
DROP TRIGGER teams_readonly_when_completed ON public.teams;
DROP TRIGGER team_players_readonly_when_completed ON public.team_players;
DROP TRIGGER team_coach_assignments_readonly_when_completed ON public.team_coach_assignments;
DROP TRIGGER practice_assignments_readonly_when_completed ON public.practice_assignments;
DROP TRIGGER practice_exceptions_readonly_when_completed ON public.practice_exceptions;
DROP TRIGGER game_assignments_readonly_when_completed ON public.game_assignments;
DROP TRIGGER schedule_tbd_readonly_when_completed ON public.schedule_tbd;
DROP TRIGGER players_readonly_when_completed ON public.players;
DROP TRIGGER coaches_readonly_when_completed ON public.coaches;
DROP TRIGGER season_settings_completed_guard ON public.season_settings;
DROP TRIGGER divisions_age_rule_revision ON public.divisions;
DROP TRIGGER divisions_window_guard ON public.divisions;
DROP TRIGGER season_settings_cutoff_guard ON public.season_settings;
DROP FUNCTION public.season_schedule_readonly_when_completed();
DROP FUNCTION public.season_rows_readonly_when_completed();
DROP FUNCTION public.season_settings_completed_guard();
DROP FUNCTION public.divisions_age_rule_revision();
DROP FUNCTION public.divisions_window_guard();
DROP FUNCTION public.division_age_rule_differs(public.divisions, public.divisions);
DROP FUNCTION public.season_settings_cutoff_guard();
DROP FUNCTION public.season_has_pending_player_import(uuid);
DROP FUNCTION public.import_age_rule(uuid, uuid, boolean);

-- The writers and the catalogues.
DROP FUNCTION public.admin_create_season_from(uuid, text, integer, date, date);
DROP FUNCTION public.admin_update_draft_season(uuid, jsonb);
DROP FUNCTION public.admin_set_division_birthdate_window(uuid, date, date);
DROP FUNCTION public.admin_activate_season(uuid);
DROP FUNCTION public.rollover_division_columns();
DROP FUNCTION public.rollover_division_skipped_columns();
DROP FUNCTION public.rollover_season_columns();
DROP FUNCTION public.rollover_season_skipped_columns();

-- The cutoff columns and the mode check, as they stood.
ALTER TABLE public.season_settings DROP CONSTRAINT season_settings_age_cutoff_day_check;
ALTER TABLE public.season_settings DROP COLUMN age_cutoff_month;
ALTER TABLE public.season_settings DROP COLUMN age_cutoff_day;
ALTER TABLE public.season_settings DROP CONSTRAINT season_settings_age_cutoff_mode_check;
ALTER TABLE public.season_settings
    ADD CONSTRAINT season_settings_age_cutoff_mode_check
    CHECK (age_cutoff_mode IN ('birth_year', 'school_year_aug_jul'));
COMMENT ON COLUMN public.season_settings.age_cutoff_mode IS
    'Age-group cutoff model: birth_year (calendar) or school_year_aug_jul (Aug 1 cutoff). Default school_year_aug_jul.';

-- The audit actions, while no audit row uses them.
DO $revert$
DECLARE
    v_rows bigint;
BEGIN
    SELECT count(*) INTO v_rows FROM public.audit_log
     WHERE action IN ('season.created_from', 'season.updated', 'season.activated', 'division.window_changed');
    IF v_rows = 0 THEN
        DELETE FROM public.audit_actions
         WHERE action IN ('season.created_from', 'season.updated', 'season.activated', 'division.window_changed');
        RAISE NOTICE 'the four season audit actions are unregistered; no audit row used them';
    ELSE
        RAISE NOTICE 'the four season audit actions stay registered: % audit row(s) use them', v_rows;
    END IF;
END;
$revert$;

-- The guards, as they stood.
CREATE OR REPLACE FUNCTION public.create_import_job(p_organization_id uuid, p_import_type text, p_file_name text, p_season_settings_id uuid DEFAULT NULL::uuid)
 RETURNS import_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_import_type text := lower(NULLIF(btrim(COALESCE(p_import_type, '')), ''));
    v_file_name text := btrim(COALESCE(p_file_name, ''));
    v_job_type text;
    v_now timestamptz := now();
    v_job public.import_jobs%ROWTYPE;
    v_season_id uuid;
    v_season_status text;
BEGIN
    IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
      RAISE EXCEPTION 'Only organization admins can create import jobs' USING ERRCODE='42501';
    END IF;
    IF v_import_type NOT IN ('players', 'coaches', 'fields', 'field_availability') THEN
      RAISE EXCEPTION 'invalid import type: %', p_import_type USING ERRCODE='22023';
    END IF;
    v_file_name := regexp_replace(v_file_name, '[/\\:]+', '_', 'g');
    IF v_file_name = '' THEN RAISE EXCEPTION 'file_name is required' USING ERRCODE='22023'; END IF;

    v_job_type := CASE WHEN v_import_type = 'fields' THEN 'fields' WHEN v_import_type='field_availability' THEN 'field_availability' ELSE 'registration' END;

    -- 20261101010000: the season the import adds to is fixed now, not when it is
    -- finalized. A named season must be this organization's and not completed;
    -- none named is the organization's active season (none at all leaves the job
    -- without one, as a job made before this migration is). Divisions and field
    -- practice reservations land in it.
    IF p_season_settings_id IS NULL THEN
      SELECT s.id INTO v_season_id
        FROM public.season_settings s
       WHERE s.organization_id = p_organization_id AND s.status = 'active';
    ELSE
      SELECT s.id, s.status INTO v_season_id, v_season_status
        FROM public.season_settings s
       WHERE s.id = p_season_settings_id AND s.organization_id = p_organization_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'season % does not belong to organization %', p_season_settings_id, p_organization_id
          USING ERRCODE='42501';
      END IF;
      IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'season % is completed and takes no import', p_season_settings_id
          USING ERRCODE='22023', DETAIL='season_completed';
      END IF;
      IF v_season_status <> 'active' THEN
        RAISE EXCEPTION 'season % is % and takes no import: only the active season does', p_season_settings_id, v_season_status
          USING ERRCODE='22023', DETAIL='season_not_active';
      END IF;
    END IF;

    INSERT INTO public.import_jobs (organization_id,job_type,storage_path,status,total_rows,processed_rows,progress_percent,last_heartbeat_at,created_by,started_at,season_settings_id)
    VALUES (p_organization_id,v_job_type,format('imports/%s/%s', auth.uid(), v_file_name),'importing',0,0,0,v_now,auth.uid(),v_now,v_season_id)
    RETURNING * INTO v_job;

    PERFORM public.record_audit_event(p_organization_id,'import.started','import_job',v_job.id,jsonb_build_object('import_type',v_import_type,'job_type',v_job_type,'status','importing'));
    RETURN v_job;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_error_count integer := 0;
    v_total_promoted_count integer := 0;
    v_status text;
    v_result jsonb;
    v_gender_model text;
    v_season_settings_id uuid;
    v_season_status text;
    v_waitlist_enabled boolean := true;
    v_created_divisions integer := 0;
    v_declared jsonb;
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

    IF v_job.job_type <> 'registration' THEN
        RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    IF v_job.status = 'failed' THEN
        RAISE EXCEPTION 'Failed import job % cannot be finalized', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    -- The organization's declared player fields, read once for every row.
    v_declared := public.import_declared_fields(v_job.organization_id, 'player');

    v_error_count := jsonb_array_length(v_validation_errors);
    v_status := CASE WHEN v_error_count > 0 THEN 'completed_with_warnings' ELSE 'completed' END;

    -- Org division format: 'split' (default) -> gendered U8B/U8G; 'coed' -> U8.
    SELECT COALESCE(o.feature_flags->>'gender_model', 'split'),
           COALESCE((o.feature_flags->>'waitlist')::boolean, true)
    INTO v_gender_model, v_waitlist_enabled
    FROM public.organizations o
    WHERE o.id = v_job.organization_id;
    IF v_gender_model NOT IN ('split', 'coed') THEN
        v_gender_model := 'split';
    END IF;

    -- Season that auto-created divisions attach to (divisions are per-season):
    -- the job's own (20261101010000), or, for a job made before jobs carried one,
    -- the organization's active season. Nothing picks a season by its dates or its
    -- age any more, so a draft season is never imported into by accident. A
    -- completed season takes no import.
    SELECT s.id, s.status
    INTO v_season_settings_id, v_season_status
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
      AND (CASE WHEN v_job.season_settings_id IS NULL
                THEN s.status = 'active'
                ELSE s.id = v_job.season_settings_id END);

    -- A player belongs to one season (20261108010000), so an import needs one to add to.
    IF v_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'Organization % has no season to import into', v_job.organization_id
            USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    -- Enrollment is per season now (20261108010000): this import matches, updates and creates
    -- players in the destination season only, and a registration id seen in another season is
    -- a new row here. The guard stays "the active season only" until draft seasons take imports
    -- (E3b widens it).
    IF v_season_status IS NOT NULL AND v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no import: only the active season does', v_season_settings_id, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;

    -- Auto-create derived divisions that don't exist yet for that season.
    IF v_season_settings_id IS NOT NULL THEN
        WITH staged AS (
            SELECT
                public.import_payload_text(
                    sp.normalized_payload, 'age group', 'age_group', 'age'
                ) AS age_text,
                lower(left(COALESCE(
                    public.import_payload_text(sp.normalized_payload, 'gender'), ''
                ), 1)) AS g
            FROM public.staging_players sp
            WHERE sp.import_job_id = p_import_job_id
              AND sp.organization_id = v_job.organization_id
              AND sp.promoted_at IS NULL
              AND sp.normalized_payload IS NOT NULL
              AND COALESCE(jsonb_array_length(sp.validation_errors), 0) = 0
        ),
        derived AS (
            SELECT DISTINCT
                'U' || (age_text::int + 1)
                    || CASE
                        WHEN v_gender_model = 'coed' THEN ''
                        WHEN g IN ('m', 'b') THEN 'B'
                        WHEN g IN ('f', 'g') THEN 'G'
                        ELSE ''
                    END AS name,
                CASE
                    WHEN v_gender_model = 'coed' THEN 'coed'
                    WHEN g IN ('m', 'b') THEN 'boys'
                    WHEN g IN ('f', 'g') THEN 'girls'
                    ELSE 'coed'
                END AS gender_policy
            FROM staged
            WHERE age_text ~ '^[0-9]+$'
        ),
        created AS (
            INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy)
            SELECT v_job.organization_id, v_season_settings_id, d.name, d.gender_policy::gender_policy_enum
            FROM derived d
            WHERE NOT EXISTS (
                SELECT 1 FROM public.divisions x
                WHERE x.organization_id = v_job.organization_id
                  AND x.season_settings_id = v_season_settings_id
                  AND lower(x.name) = lower(d.name)
            )
            ON CONFLICT (season_settings_id, name) DO NOTHING
            RETURNING id
        )
        SELECT count(*) INTO v_created_divisions FROM created;
    END IF;

    WITH pending AS MATERIALIZED (
        SELECT
            sp.id AS staging_id,
            sp.source_row_number,
            sp.organization_id,
            sp.normalized_payload,
            public.import_payload_text(
                sp.normalized_payload,
                'external_registration_id', 'gotsport_id', 'registration_id', 'player_id'
            ) AS external_registration_id,
            public.import_payload_text(sp.normalized_payload, 'division_id') AS division_id_text,
            public.import_payload_text(
                sp.normalized_payload,
                'division_name', 'division', 'group', 'program'
            ) AS explicit_division_name,
            -- Gendered division derived from age group + gender, honoring the
            -- org gender_model. A player of age N plays in division U(N+1).
            CASE
                WHEN public.import_payload_text(sp.normalized_payload, 'age group', 'age_group', 'age') ~ '^[0-9]+$'
                THEN 'U' || ((public.import_payload_text(sp.normalized_payload, 'age group', 'age_group', 'age'))::int + 1)
                    || CASE
                        WHEN v_gender_model = 'coed' THEN ''
                        WHEN lower(left(COALESCE(public.import_payload_text(sp.normalized_payload, 'gender'), ''), 1)) IN ('m', 'b') THEN 'B'
                        WHEN lower(left(COALESCE(public.import_payload_text(sp.normalized_payload, 'gender'), ''), 1)) IN ('f', 'g') THEN 'G'
                        ELSE ''
                    END
            END AS derived_division_name,
            public.import_payload_text(sp.normalized_payload, 'first_name') AS first_name,
            public.import_payload_text(sp.normalized_payload, 'last_name') AS last_name,
            public.import_payload_text(sp.normalized_payload, 'preferred_name', 'nickname') AS preferred_name,
            -- The natural age (R5): the one import-validation computed from the
            -- file's birth date with the season's cutoff (else from the age
            -- group), else, for a row staged without it, the age group the
            -- export states. No birth date is staged or stored.
            public.import_payload_text(
                sp.normalized_payload, 'age group', 'age_group', 'age'
            ) AS age_group_text,
            public.import_payload_text(sp.normalized_payload, 'natural_age') AS natural_age_text,
            public.import_payload_text(sp.normalized_payload, 'grade') AS grade,
            public.import_payload_text(sp.normalized_payload, 'gender') AS gender,
            lower(public.import_payload_text(sp.normalized_payload, 'skill_tier', 'skill_level')) AS skill_tier_text,
            public.import_payload_text(
                sp.normalized_payload,
                'years_played', 'years played',
                'how many years has your player played in an organized soccer program?'
            ) AS years_played_text,
            lower(COALESCE(public.import_payload_text(
                sp.normalized_payload, 'waitlist', 'waitlisted'
            ), '')) AS waitlist_text,
            public.import_payload_text(
                sp.normalized_payload,
                'play_up', 'play up',
                'are you coaching so this player can play up a division?'
            ) AS play_up_text,
            (sp.normalized_payload ?| ARRAY[
                'play_up', 'play up',
                'are you coaching so this player can play up a division?'
            ]) AS play_up_present,
            public.import_payload_text(sp.normalized_payload, 'buddy_request') AS buddy_request,
            -- Nullable: NULL means the coaching-interest column is genuinely
            -- absent from this row's payload (re-import should preserve the
            -- existing player's willing_to_coach), distinct from a present-
            -- but-negative answer, which lower()s to a non-matching string.
            lower(public.import_payload_text(
                sp.normalized_payload,
                'willing_to_coach', 'coach_volunteer',
                'can you coach for this player''s team?'
            )) AS coaching_answer,
            public.import_payload_text(sp.normalized_payload, 'team name') AS team_name,
            public.import_payload_text(sp.normalized_payload, 'team age') AS team_age,
            public.import_payload_text(sp.normalized_payload, 'team gender') AS team_gender,
            -- The allowlist (R0): only the fields the organization declared
            -- for players, keyed by their declared names. Every other column
            -- of the export is dropped here, whatever reached staging.
            public.import_declared_attributes(v_declared, sp.normalized_payload)
                AS custom_attributes
        FROM public.staging_players sp
        WHERE sp.import_job_id = p_import_job_id
          AND sp.organization_id = v_job.organization_id
          AND sp.promoted_at IS NULL
          AND sp.normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(sp.validation_errors), 0) = 0
    ),
    valid_candidates AS MATERIALIZED (
        SELECT
            p.*,
            COALESCE(p.explicit_division_name, p.derived_division_name) AS division_name,
            d.id AS division_id,
            CASE
                WHEN p.natural_age_text ~ '^[0-9]{1,2}$' AND p.natural_age_text::int BETWEEN 1 AND 25
                    THEN p.natural_age_text::smallint
                WHEN p.age_group_text ~ '^[0-9]{1,2}$' AND p.age_group_text::int BETWEEN 1 AND 25
                    THEN p.age_group_text::smallint
            END AS natural_age,
            CASE
                WHEN p.skill_tier_text IN ('novice', 'developing', 'advanced') THEN p.skill_tier_text
                ELSE NULL
            END AS skill_tier,
            CASE
                WHEN p.years_played_text ~ '^[0-9]{1,2}$'
                     AND p.years_played_text::int BETWEEN 0 AND 30
                THEN p.years_played_text::smallint
            END AS years_played,
            CASE
                WHEN v_waitlist_enabled
                     AND p.waitlist_text IN ('true', 't', 'yes', 'y', '1') THEN 'waitlist'
                ELSE 'active'
            END AS import_status,
            -- The play-up column is the player's request (20261106010000): yes, true, y, t, 1
            -- or x is a request, anything else is none, a blank cell included (a request
            -- withdrawn in the file). NULL only when the column is absent from the row, so a
            -- re-import leaves the stored request alone. `import_payload_text` returns NULL for
            -- a blank cell and for a missing key alike, so presence is read from the key itself.
            CASE
                WHEN NOT p.play_up_present THEN NULL
                ELSE COALESCE(lower(p.play_up_text) IN ('yes', 'true', 'y', 't', '1', 'x'), false)
            END AS play_up_requested,
            -- NULL when the coaching-interest column is absent (preserve
            -- existing value on re-import); a boolean otherwise.
            CASE
                WHEN p.coaching_answer IS NULL THEN NULL
                ELSE p.coaching_answer IN ('true', 't', 'yes', 'y', '1', 'maybe', 'coach',
                    'head coach', 'assistant coach', 'volunteer', 'willing')
            END AS willing_to_coach,
            (p.custom_attributes
                || jsonb_strip_nulls(jsonb_build_object(
                    'team_name', p.team_name,
                    'team_age', p.team_age,
                    'team_gender', p.team_gender
                ))
                || CASE
                    WHEN p.coaching_answer IS NOT NULL AND p.coaching_answer <> ''
                    THEN jsonb_build_object('coaching_answer', p.coaching_answer)
                    ELSE '{}'::jsonb
                END
            ) AS final_custom_attributes
        FROM pending p
        LEFT JOIN LATERAL (
            SELECT divisions.id
            FROM public.divisions
            WHERE divisions.organization_id = p.organization_id
              -- Every match is in the destination season (divisions are unique per season, and
              -- a player's division is always in the player's own season): an explicit division
              -- id from another season matches nothing and is counted as unmatched.
              AND divisions.season_settings_id = v_season_settings_id
              AND (
                  divisions.id = CASE
                      WHEN p.division_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN p.division_id_text::uuid
                      ELSE NULL
                  END
                  OR lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))
                  OR lower(divisions.name) = lower(COALESCE(p.derived_division_name, ''))
              )
            ORDER BY
                -- Prefer explicit id, then explicit name, then derived name.
                (divisions.id::text = p.division_id_text) DESC,
                (lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))) DESC,
                divisions.created_at DESC, divisions.id
            LIMIT 1
        ) d ON true
        WHERE p.first_name IS NOT NULL
          AND p.last_name IS NOT NULL
    ),
    deduped_external AS MATERIALIZED (
        SELECT DISTINCT ON (organization_id, external_registration_id) *
        FROM valid_candidates
        WHERE external_registration_id IS NOT NULL
        ORDER BY organization_id, external_registration_id, source_row_number NULLS LAST, staging_id
    ),
    existing_matches AS MATERIALIZED (
        SELECT de.staging_id, matched_players.id AS player_id
        FROM deduped_external de
        JOIN LATERAL (
            SELECT players.id
            FROM public.players
            WHERE players.organization_id = de.organization_id
              AND players.season_settings_id = v_season_settings_id
              AND players.external_registration_id = de.external_registration_id
            ORDER BY players.created_at, players.id
            LIMIT 1
        ) matched_players ON true
    ),
    updated_existing AS (
        UPDATE public.players p
        SET
            division_id = COALESCE(de.division_id, p.division_id),
            first_name = de.first_name,
            last_name = de.last_name,
            preferred_name = COALESCE(de.preferred_name, p.preferred_name),
            natural_age = de.natural_age,
            grade = COALESCE(de.grade, p.grade),
            gender = COALESCE(de.gender, p.gender),
            skill_tier = COALESCE(de.skill_tier, p.skill_tier),
            years_played = COALESCE(de.years_played, p.years_played),
            status = CASE
                WHEN de.import_status = 'waitlist' THEN 'waitlist'
                WHEN p.status = 'waitlist' AND de.import_status = 'active' THEN 'active'
                ELSE p.status
            END,
            willing_to_coach = COALESCE(de.willing_to_coach, p.willing_to_coach),
            coach_volunteer = COALESCE(de.willing_to_coach, p.coach_volunteer),
            play_up_requested = COALESCE(de.play_up_requested, p.play_up_requested),
            buddy_request = COALESCE(de.buddy_request, p.buddy_request),
            -- An existing player's undeclared keys go too; the import's own
            -- keys (coaching answer, team placement) stay. The play-up column is
            -- `play_up_requested` now, and kept as text only where the organization
            -- declared it as its own field.
            custom_attributes = public.import_kept_player_attributes(v_declared, p.custom_attributes)
                || de.final_custom_attributes,
            last_imported_at = v_now,
            import_source = 'gotsport',
            registration_history = COALESCE(p.registration_history, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                    'import_job_id', p_import_job_id,
                    'imported_at', v_now,
                    'source', 'gotsport',
                    'operation', 'updated'
                ))
        FROM deduped_external de
        JOIN existing_matches em ON em.staging_id = de.staging_id
        WHERE p.id = em.player_id
        RETURNING p.id
    ),
    insert_source AS MATERIALIZED (
        SELECT de.*
        FROM deduped_external de
        LEFT JOIN existing_matches em ON em.staging_id = de.staging_id
        WHERE em.player_id IS NULL

        UNION ALL

        SELECT vc.*
        FROM valid_candidates vc
        WHERE vc.external_registration_id IS NULL
    ),
    inserted_new AS (
        INSERT INTO public.players (
            organization_id,
            season_settings_id,
            division_id,
            first_name,
            last_name,
            preferred_name,
            external_registration_id,
            natural_age,
            grade,
            gender,
            skill_tier,
            years_played,
            status,
            coach_volunteer,
            willing_to_coach,
            play_up_requested,
            buddy_request,
            registration_history,
            last_imported_at,
            import_source,
            custom_attributes
        )
        SELECT
            organization_id,
            v_season_settings_id,
            division_id,
            first_name,
            last_name,
            preferred_name,
            external_registration_id,
            natural_age,
            grade,
            gender,
            skill_tier,
            years_played,
            import_status,
            COALESCE(willing_to_coach, false),
            COALESCE(willing_to_coach, false),
            COALESCE(play_up_requested, false),
            buddy_request,
            jsonb_build_array(jsonb_build_object(
                'import_job_id', p_import_job_id,
                'imported_at', v_now,
                'source', 'gotsport',
                'operation', 'inserted'
            )),
            v_now,
            'gotsport',
            final_custom_attributes
        FROM insert_source
        RETURNING id
    ),
    promoted AS (
        UPDATE public.staging_players sp
        SET
            promoted_at = v_now,
            promoted_by = auth.uid()
        WHERE sp.id IN (SELECT staging_id FROM valid_candidates)
        RETURNING sp.id
    )
    SELECT jsonb_build_object(
        'staged_rows', (SELECT count(*) FROM pending),
        'valid_staged_rows', (SELECT count(*) FROM valid_candidates),
        'promoted_rows', (SELECT count(*) FROM promoted),
        'updated_players', (SELECT count(*) FROM updated_existing),
        'inserted_players', (SELECT count(*) FROM inserted_new),
        'duplicate_external_rows',
            (SELECT count(*) FROM valid_candidates WHERE external_registration_id IS NOT NULL)
            - (SELECT count(*) FROM deduped_external),
        'without_external_id',
            (SELECT count(*) FROM valid_candidates WHERE external_registration_id IS NULL),
        'unmatched_division_rows',
            (SELECT count(*) FROM valid_candidates WHERE division_name IS NOT NULL AND division_id IS NULL),
        'waitlisted_rows',
            (SELECT count(*) FROM valid_candidates WHERE import_status = 'waitlist'),
        'created_divisions', v_created_divisions,
        'validation_error_rows', v_error_count,
        'status', v_status
    )
    INTO v_result;

    SELECT count(*)
    INTO v_total_promoted_count
    FROM public.staging_players
    WHERE import_job_id = p_import_job_id
      AND promoted_at IS NOT NULL;

    v_result := v_result || jsonb_build_object('total_promoted_rows', v_total_promoted_count);

    UPDATE public.import_jobs
    SET
        status = v_status,
        processed_rows = v_total_promoted_count,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{finalize}',
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
$function$;

CREATE OR REPLACE FUNCTION public.finalize_coach_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_row public.staging_import_rows%ROWTYPE;
    v_existing public.coaches%ROWTYPE;
    v_after public.coaches%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_email text;
    v_full_name text;
    v_status text;
    v_can_multi_text text;
    v_can_multi boolean;
    v_certifications jsonb;
    v_contact_info jsonb;
    v_custom_attributes jsonb;
    v_declared jsonb;
    v_season_settings_id uuid;
    v_season_status text;
    v_previous_payload jsonb;
    v_existing_found boolean;
    v_inserted_count integer := 0;
    v_updated_count integer := 0;
    v_invalid_count integer := 0;
    -- S7 (admin-only plan): the coach's children, named by player registration id.
    v_child record;
    v_player_id uuid;
    v_slot integer;
    v_previous_links jsonb;
    v_linked_count integer := 0;
    v_unmatched jsonb := '[]'::jsonb;
    v_unmatched_count integer := 0;
    v_blocked_assignment_count integer := 0;
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

    IF v_job.job_type <> 'registration' THEN
        RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    IF v_job.status = 'failed' THEN
        RAISE EXCEPTION 'Failed import job % cannot be finalized', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    -- A coach row belongs to one season (20261108010000), as a player row does: the job's own
    -- season, or for a job made before jobs carried one the organization's active season.
    -- Only the active season takes an import until draft seasons do (E3b widens this, with
    -- the player finalizer's guard); a completed one never does.
    SELECT s.id, s.status
    INTO v_season_settings_id, v_season_status
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
      AND (CASE WHEN v_job.season_settings_id IS NULL
                THEN s.status = 'active'
                ELSE s.id = v_job.season_settings_id END);
    IF v_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'Organization % has no season to import into', v_job.organization_id
            USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no import: only the active season does', v_season_settings_id, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;

    -- The organization's declared coach fields, read once for every row.
    v_declared := public.import_declared_fields(v_job.organization_id, 'coach');

    -- Deliberately row-oriented for the coach slice: each applied row needs an
    -- exact rollback snapshot and independent conflict outcome. The Edge
    -- Function caps imports at 5,000 rows; set-based promotion can replace
    -- this once field-slot promotion shares the same ledger.
    FOR v_row IN
        SELECT *
        FROM public.staging_import_rows
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'coaches'
          AND applied_at IS NULL
          AND normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(validation_errors), 0) = 0
        ORDER BY source_row_number NULLS LAST, id
    LOOP
        v_email := lower(public.import_payload_text(v_row.normalized_payload, 'email'));
        v_full_name := public.import_payload_text(v_row.normalized_payload, 'full_name');
        v_status := lower(COALESCE(
            public.import_payload_text(v_row.normalized_payload, 'status', 'coach_status'),
            'active'
        ));
        v_can_multi_text := public.import_payload_text(
            v_row.normalized_payload,
            'can_coach_multiple_teams',
            'multiple_teams',
            'multi_team'
        );
        v_certifications := public.import_text_to_jsonb_array(
            public.import_payload_text(v_row.normalized_payload, 'certifications', 'certification')
        );
        -- The coach's email is the import's key and an admin's contact; no coach signs in
        -- and no phone is stored (R0).
        v_contact_info := jsonb_strip_nulls(jsonb_build_object('email', v_email));
        -- The allowlist (R0): only the fields the organization declared for
        -- coaches, keyed by their declared names. Every other column of the
        -- export (a child's details, guardians' addresses and phones, the
        -- coach's own birth date) is dropped here, whatever reached staging.
        v_custom_attributes := public.import_declared_attributes(v_declared, v_row.normalized_payload);

        IF v_email IS NULL
           OR v_full_name IS NULL
           OR v_status NOT IN ('active', 'pending-confirmation', 'inactive') THEN
            v_invalid_count := v_invalid_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Coach row is missing full_name/email or has an invalid status',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        -- A coach is one row per organization, season and email (20261108010000): the same
        -- address in another season, or another organization, is another coach, never a
        -- conflict, and nothing is read from or written to that row.
        SELECT *
        INTO v_existing
        FROM public.coaches c
        WHERE c.organization_id = v_job.organization_id
          AND c.season_settings_id = v_season_settings_id
          AND c.email = v_email;
        v_existing_found := FOUND;

        IF v_existing_found
           AND v_status = 'inactive'
           AND EXISTS (
                SELECT 1
                FROM public.teams t
                WHERE t.organization_id = v_job.organization_id
                  AND (
                    t.coach_id = v_existing.id
                    OR v_existing.id = ANY(COALESCE(t.assistant_coach_ids, '{}'::uuid[]))
                  )
           ) THEN
            v_blocked_assignment_count := v_blocked_assignment_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Assigned coaches cannot be marked inactive by import',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        IF v_existing_found THEN
            v_previous_payload := to_jsonb(v_existing);
            -- The links this row is about to replace, kept for the rollback.
            IF v_row.normalized_payload ? 'child_registration_id' THEN
                SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id', r.player_id, 'slot', r.slot)
                                          ORDER BY r.slot), '[]'::jsonb)
                  INTO v_previous_links
                  FROM public.coach_team_requests r
                 WHERE r.organization_id = v_job.organization_id
                   AND r.coach_id = v_existing.id
                   AND r.player_id IS NOT NULL;
                v_previous_payload := v_previous_payload || jsonb_build_object('child_links', v_previous_links);
            END IF;
            v_can_multi := CASE
                WHEN v_can_multi_text IS NULL THEN COALESCE(v_existing.can_coach_multiple_teams, false)
                ELSE public.import_text_to_bool(v_can_multi_text)
            END;

            UPDATE public.coaches
            SET
                full_name = v_full_name,
                email = v_email,
                certifications = COALESCE(NULLIF(v_certifications, '[]'::jsonb), v_existing.certifications),
                can_coach_multiple_teams = v_can_multi,
                status = v_status,
                contact_info = (COALESCE(v_existing.contact_info, '{}'::jsonb) - 'phone') || v_contact_info,
                last_imported_at = v_now,
                import_source = 'coach_csv',
                custom_attributes = public.import_declared_attributes(
                    v_declared, COALESCE(v_existing.custom_attributes, '{}'::jsonb)
                ) || v_custom_attributes,
                updated_at = v_now
            WHERE id = v_existing.id
              AND organization_id = v_job.organization_id
            RETURNING * INTO v_after;

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
                'coaches',
                'coaches',
                v_after.id,
                'updated',
                v_previous_payload,
                to_jsonb(v_after),
                v_now,
                auth.uid()
            )
            ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

            v_updated_count := v_updated_count + 1;
        ELSE
            v_can_multi := COALESCE(public.import_text_to_bool(v_can_multi_text), false);

            INSERT INTO public.coaches (
                organization_id,
                season_settings_id,
                full_name,
                email,
                certifications,
                can_coach_multiple_teams,
                status,
                contact_info,
                last_imported_at,
                import_source,
                custom_attributes
            )
            VALUES (
                v_job.organization_id,
                v_season_settings_id,
                v_full_name,
                v_email,
                v_certifications,
                v_can_multi,
                v_status,
                v_contact_info,
                v_now,
                'coach_csv',
                v_custom_attributes
            )
            RETURNING * INTO v_after;

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
                'coaches',
                'coaches',
                v_after.id,
                'inserted',
                NULL,
                to_jsonb(v_after),
                v_now,
                auth.uid()
            );

            v_inserted_count := v_inserted_count + 1;
        END IF;

        -- S7: the coach's children. A file with the column names them (one or more registration
        -- ids, separated by ; or ,); the coach's links become exactly those that match a player
        -- of THIS organization and season, one row each, in the order the file lists them. An id
        -- that matches no player here (not imported yet, mistyped, or another season's or
        -- organization's) is
        -- reported in the result and writes nothing. A file without the column leaves the
        -- coach's links alone. Nothing but this import writes coach_team_requests.
        IF v_row.normalized_payload ? 'child_registration_id' THEN
            DELETE FROM public.coach_team_requests
             WHERE organization_id = v_job.organization_id
               AND coach_id = v_after.id;
            v_slot := 0;
            FOR v_child IN
                SELECT x.registration_id
                  FROM (
                      SELECT btrim(part) AS registration_id, min(ord) AS first_at
                        FROM regexp_split_to_table(
                                 COALESCE(public.import_payload_text(v_row.normalized_payload, 'child_registration_id'), ''),
                                 '[;,]'
                             ) WITH ORDINALITY AS s(part, ord)
                       WHERE btrim(part) <> ''
                       GROUP BY btrim(part)
                  ) x
                 ORDER BY x.first_at
            LOOP
                SELECT p.id
                  INTO v_player_id
                  FROM public.players p
                 WHERE p.organization_id = v_job.organization_id
                   AND p.season_settings_id = v_season_settings_id
                   AND p.external_registration_id = v_child.registration_id
                 ORDER BY p.updated_at DESC, p.id
                 LIMIT 1;
                IF v_player_id IS NULL THEN
                    v_unmatched_count := v_unmatched_count + 1;
                    IF jsonb_array_length(v_unmatched) < 200 THEN
                        v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object(
                            'coach_id', v_after.id,
                            'registration_id', left(v_child.registration_id, 100)
                        ));
                    END IF;
                ELSE
                    v_slot := v_slot + 1;
                    INSERT INTO public.coach_team_requests (organization_id, coach_id, player_id, slot)
                    VALUES (v_job.organization_id, v_after.id, v_player_id, v_slot);
                    v_linked_count := v_linked_count + 1;
                END IF;
            END LOOP;
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
      AND import_type = 'coaches';

    v_status_result := CASE
        WHEN jsonb_array_length(v_validation_errors) > 0
          OR v_invalid_count > 0
          OR v_blocked_assignment_count > 0
          OR v_unmatched_count > 0
        THEN 'completed_with_warnings'
        ELSE 'completed'
    END;

    v_result := jsonb_build_object(
        'status', v_status_result,
        'staged_rows', (
            SELECT count(*)
            FROM public.staging_import_rows
            WHERE import_job_id = p_import_job_id
              AND import_type = 'coaches'
        ),
        'inserted_coaches', v_inserted_count,
        'updated_coaches', v_updated_count,
        'invalid_rows', v_invalid_count,
        'blocked_assignment_rows', v_blocked_assignment_count,
        'linked_children', v_linked_count,
        'unmatched_child_id_count', v_unmatched_count,
        'unmatched_child_ids', v_unmatched,
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
            '{coach_finalize}',
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
$function$;

COMMENT ON FUNCTION public.create_import_job(uuid, text, text, uuid) IS
    'Admin-only import job creation RPC for browser-driven CSV workflows. As of 20261101010000 the job names its season: the one passed (the organization''s, not completed) or else the organization''s active season, fixed at creation.';

-- The age-rule stamp and revision columns: the finalizer that read them is back to its old body above.
-- Stamped jobs lose their stamp (it only ever made a stale file refuse to apply).
ALTER TABLE public.import_jobs DROP COLUMN age_rule_season_id;
ALTER TABLE public.import_jobs DROP COLUMN age_rule_revision;
ALTER TABLE public.season_settings DROP COLUMN age_rule_revision;

-- End state: the bodies are the ones that stood before.
DO $revert$
DECLARE
    v_expected constant jsonb := '{
        "create_import_job(uuid,text,text,uuid)": "53aed1ffa0c6cea863e60f7ceaba3b02",
        "finalize_import_job(uuid,jsonb)": "883613a7e965168c40e909fb6537dcae",
        "finalize_coach_import_job(uuid,jsonb)": "1199debf6d15fcd15eacc1eeee77054f"
    }';
    v_sig text;
    v_md5 text;
BEGIN
    FOR v_sig IN SELECT jsonb_object_keys(v_expected) LOOP
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_sig);
        IF v_md5 IS DISTINCT FROM v_expected ->> v_sig THEN
            RAISE EXCEPTION 'public.% is not the body that stood before (md5 %, expected %)', v_sig, v_md5, v_expected ->> v_sig;
        END IF;
    END LOOP;
END;
$revert$;

COMMIT;
