-- Play-up by request: the stored request, written by the import and the player patch
-- (plan docs/changes/2026-10-27-play-up-by-request.md, approved by the owner 2026-10-27; the
-- AGENTS.md rule 14 plan for this persistence change).
--
-- **Why.** `players.play_up_requested` (20260530000000) has existed since the first schema and
-- nothing wrote it. The import kept the GotSport play-up column only as text in
-- `custom_attributes.play_up`, which no reader used, and the player patch could not set the
-- flag. Teaming now places everyone in their own age division unless a play-up was requested,
-- so the request has to be a stored fact an admin can set, clear and audit.
--
-- **The change.**
--   1. `finalize_import_job` writes `play_up_requested` from the play-up column (`play_up`,
--      `play up`, or the GotSport question): yes, true, y, t, 1 or x is a request, anything else
--      is none. A row without the column leaves a re-imported player's request alone. The text
--      copy in `custom_attributes.play_up` is no longer written (nothing read it); an
--      organization that declares `play_up` as its own player field still gets that field,
--      through the declared attributes.
--   2. `sanitize_player_patch` accepts `play_up_requested` (boolean, 22023 otherwise) and
--      `apply_player_patch` writes it, so `admin_update_player`, `admin_bulk_update_players` and
--      `admin_create_player` set and clear it, and the audit rows they write carry the patch.
--   3. An end-state check: each replaced body reads the new column.
--
-- Production (read-only, 2026-10-28): 0 players, so nothing to backfill. The three replaced
-- bodies are the ones 20261026010000 (the two patch functions) and 20261101010000 (the
-- finalizer) wrote, with this change only; the UTC idiom and every grant are kept.
--
-- **Production's bodies are not read from here.** The migration refuses to replace a function
-- whose text it has not seen (the md5 of `prosrc` below, read off a build of the repository at
-- 20261104020000 and, read-only, off production at 20261103020000, where all three were equal).
-- If production's differs, the migration stops before changing anything and the operator
-- compares the two.
--
-- Reversible: docs/sql/20261106010000_revert.sql restores the three bodies. It cannot unset the
-- requests stored since. Smoke: docs/sql/20261106010000_smoke.sql. pgTAP:
-- supabase/tests/play_up_requested.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting bodies are checked.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_expected constant jsonb := '{
        "sanitize_player_patch(jsonb)": "7044951715db3786b6ffe20ba8a28bdf",
        "apply_player_patch(uuid,jsonb)": "9e43dd1fc8c56172fb8ef0573049dc5f",
        "finalize_import_job(uuid,jsonb)": "0c098ee5ea357787c1ab8436cf05fdb2"
    }';
    v_sig text;
    v_md5 text;
BEGIN
    FOR v_sig IN SELECT jsonb_object_keys(v_expected) LOOP
        -- Carriage returns stripped, as 20261101010000 does: a body stored with CRLF line ends
        -- is the same text.
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_sig);
        IF v_md5 IS DISTINCT FROM v_expected ->> v_sig THEN
            RAISE EXCEPTION 'public.% has a body this migration has not seen (md5 %, expected %): not replacing it',
                v_sig, v_md5, v_expected ->> v_sig;
        END IF;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The player patch accepts and writes the request.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sanitize_player_patch(p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    v_out jsonb := '{}'::jsonb;
    v_key text;
    v_val jsonb;
    v_text text;
    v_num numeric;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'patch must be a JSON object' USING ERRCODE = '22023';
    END IF;

    FOR v_key, v_val IN SELECT * FROM jsonb_each(p_patch) LOOP
        CASE v_key
            WHEN 'first_name', 'last_name', 'preferred_name', 'gender', 'grade', 'notes',
                 'buddy_request' THEN
                v_text := NULLIF(trim(v_val #>> '{}'), '');
                IF v_key IN ('first_name', 'last_name') AND v_text IS NULL THEN
                    RAISE EXCEPTION '% cannot be empty', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, to_jsonb(v_text));
            WHEN 'status' THEN
                v_text := lower(trim(v_val #>> '{}'));
                IF v_text NOT IN ('active', 'inactive', 'pending', 'waitlist') THEN
                    RAISE EXCEPTION 'invalid status %', v_text USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('status', to_jsonb(v_text));
            WHEN 'rating' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 1 OR v_num > 5 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'rating must be an integer 1-5' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('rating', to_jsonb(v_num));
            WHEN 'years_played' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 0 OR v_num > 30 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'years_played must be an integer 0-30' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('years_played', to_jsonb(v_num));
            WHEN 'jersey_number' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 0 OR v_num > 999 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'jersey_number must be an integer 0-999' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('jersey_number', to_jsonb(v_num));
            WHEN 'willing_to_coach', 'play_up_requested' THEN
                IF jsonb_typeof(v_val) <> 'boolean' THEN
                    RAISE EXCEPTION '% must be boolean', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, v_val);
            WHEN 'division_id', 'team_id' THEN
                v_text := NULLIF(trim(v_val #>> '{}'), '');
                IF v_text IS NOT NULL AND v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    RAISE EXCEPTION '% must be a uuid', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, to_jsonb(v_text));
            ELSE
                RAISE EXCEPTION 'field % is not editable', v_key USING ERRCODE = '22023';
        END CASE;
    END LOOP;

    IF v_out = '{}'::jsonb THEN
        RAISE EXCEPTION 'patch contains no editable fields' USING ERRCODE = '22023';
    END IF;

    RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_player_patch(p_player_id uuid, p_sanitized jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    UPDATE public.players p
    SET
        first_name      = COALESCE(CASE WHEN p_sanitized ? 'first_name' THEN p_sanitized->>'first_name' END, p.first_name),
        last_name       = COALESCE(CASE WHEN p_sanitized ? 'last_name' THEN p_sanitized->>'last_name' END, p.last_name),
        preferred_name  = CASE WHEN p_sanitized ? 'preferred_name' THEN p_sanitized->>'preferred_name' ELSE p.preferred_name END,
        gender          = CASE WHEN p_sanitized ? 'gender' THEN p_sanitized->>'gender' ELSE p.gender END,
        grade           = CASE WHEN p_sanitized ? 'grade' THEN p_sanitized->>'grade' ELSE p.grade END,
        notes           = CASE WHEN p_sanitized ? 'notes' THEN p_sanitized->>'notes' ELSE p.notes END,
        buddy_request   = CASE WHEN p_sanitized ? 'buddy_request' THEN p_sanitized->>'buddy_request' ELSE p.buddy_request END,
        status          = CASE WHEN p_sanitized ? 'status' THEN p_sanitized->>'status' ELSE p.status END,
        rating          = CASE WHEN p_sanitized ? 'rating' THEN (p_sanitized->>'rating')::smallint ELSE p.rating END,
        years_played    = CASE WHEN p_sanitized ? 'years_played' THEN (p_sanitized->>'years_played')::smallint ELSE p.years_played END,
        jersey_number   = CASE WHEN p_sanitized ? 'jersey_number' THEN (p_sanitized->>'jersey_number')::smallint ELSE p.jersey_number END,
        willing_to_coach = COALESCE(CASE WHEN p_sanitized ? 'willing_to_coach' THEN (p_sanitized->>'willing_to_coach')::boolean END, p.willing_to_coach),
        play_up_requested = COALESCE(CASE WHEN p_sanitized ? 'play_up_requested' THEN (p_sanitized->>'play_up_requested')::boolean END, p.play_up_requested),
        division_id     = CASE WHEN p_sanitized ? 'division_id' THEN (p_sanitized->>'division_id')::uuid ELSE p.division_id END,
        team_id         = CASE WHEN p_sanitized ? 'team_id' THEN (p_sanitized->>'team_id')::uuid ELSE p.team_id END,
        updated_at      = now()
    WHERE p.id = p_player_id;

    -- team_players is the relational source of truth for rosters (portals,
    -- summaries, scheduler filters read it). Keep it in sync whenever the
    -- denormalized players.team_id is patched, so Team Builder moves are
    -- visible everywhere.
    IF p_sanitized ? 'team_id' THEN
        DELETE FROM public.team_players tp WHERE tp.player_id = p_player_id;
        IF p_sanitized->>'team_id' IS NOT NULL THEN
            INSERT INTO public.team_players (team_id, player_id, organization_id, role, source)
            SELECT (p_sanitized->>'team_id')::uuid, p.id, p.organization_id, 'player', 'manual'
            FROM public.players p
            WHERE p.id = p_player_id
            ON CONFLICT (team_id, player_id) DO NOTHING;
        END IF;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The finalizer writes it.
-- ---------------------------------------------------------------------------

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

    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    -- Players are organization-level and their division is season-level, so an import
    -- that matches an existing player by external id would move a live-season player
    -- into another season's division. Until enrollment is season-scoped (E3 decision), an
    -- import goes only to the active season.
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
            -- or x is a request, anything else is none. NULL when the column is absent from
            -- the row, so a re-import leaves the stored request alone.
            CASE
                WHEN p.play_up_text IS NULL THEN NULL
                ELSE lower(p.play_up_text) IN ('yes', 'true', 'y', 't', '1', 'x')
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
              AND (
                  divisions.id = CASE
                      WHEN p.division_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN p.division_id_text::uuid
                      ELSE NULL
                  END
                  -- Name matches are season-scoped (divisions are unique per
                  -- season); without this, a new season's import attaches
                  -- players to a prior season's same-named division.
                  OR (
                      (v_season_settings_id IS NULL
                       OR divisions.season_settings_id = v_season_settings_id)
                      AND (
                          lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))
                          OR lower(divisions.name) = lower(COALESCE(p.derived_division_name, ''))
                      )
                  )
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

-- ---------------------------------------------------------------------------
-- 4. End state: each replaced body reads the column.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_sig text;
BEGIN
    FOREACH v_sig IN ARRAY ARRAY['sanitize_player_patch(jsonb)', 'apply_player_patch(uuid,jsonb)', 'finalize_import_job(uuid,jsonb)'] LOOP
        IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_sig)) NOT LIKE '%play_up_requested%' THEN
            RAISE EXCEPTION 'public.% does not read play_up_requested', v_sig;
        END IF;
    END LOOP;
END;
$$;

COMMIT;
