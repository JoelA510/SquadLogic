-- No birthdates stored: a natural age replaces them (plan
-- docs/changes/2026-10-22-admin-focus.md, R5; owner decision 3 of
-- 2026-10-22: birthdates are never stored server-side, a stored natural age
-- replaces them; docs/product.md "Constraints").
--
-- **Why.** A player's birth date is a minor's personal data that teaming needs
-- only as an age group. The import now stores the player's natural age (the
-- U-number the play-up rule compares with a division's band,
-- `packages/core/src/ageGroups.js`) and never the date. Production held 0
-- players when this was written (read-only, 2026-10-25), so no stored birth
-- date is lost there.
--
-- **The change.**
--   1. What the drops destroy, counted in a NOTICE: players with a birth date
--      or birth year, and staged rows whose payload carries a birth key.
--   2. `players.natural_age smallint`, NULL or 1-25 (the age groups the
--      browser's division derivation accepts). It is the age for the season
--      of the import that wrote it, as the player's division is; a re-import
--      rewrites both.
--   3. `import_allowed_keys(text)` (20261022010000), the SQL copy of the
--      import allowlist: the player list loses `date_of_birth`, `dob` and
--      `birth_year` and gains `natural_age`. The purge reduces an unfinished
--      job's staged rows with it, so a birth key no longer survives there.
--   4. Kept functions whose bodies named a dropped column, each replaced from
--      its latest body (20261025010000) with only those lines changed
--      (CREATE OR REPLACE keeps the grants; the SET clauses are restated):
--        - `sanitize_player_patch(jsonb)`: `date_of_birth` is no longer an
--          editable key, so a patch naming it is refused 22023 like any
--          unknown field; IMMUTABLE, search_path=public;
--        - `apply_player_patch(uuid, jsonb)`: no longer writes the date;
--          search_path=public and timezone=UTC;
--        - `admin_bulk_update_players(uuid[], jsonb)`: its refusal of a bulk
--          `date_of_birth` patch goes (the sanitizer refuses the key first);
--          SECURITY DEFINER, search_path=public;
--        - `finalize_import_job(uuid, jsonb)`: reads the natural age (the
--          `natural_age` import-validation staged: computed from the file's
--          birth date with the season's cutoff, else the export's age group;
--          for a row staged without it, the age group the export states),
--          stores it on insert and on a re-import, and promotes a row with no
--          birth date; a row with neither is promoted with no natural age
--          (placed and flagged by teaming, Phase B2). Matching across imports
--          is unchanged (the external registration id). SECURITY DEFINER,
--          search_path=public, timezone=UTC.
--   5. Every staged player and import row loses the birth keys the import
--      reads (`date_of_birth`, `dob`, `birth_year`, and the headers that
--      alias to them), from both payloads.
--   6. `players.date_of_birth` and `players.birth_year` dropped.
--   7. An end-state check: no `public` function body (comments and string
--      literals stripped, so the purge's list of audit keys to redact is not a
--      reference), view or policy names a dropped column, and no column named
--      like a birth date or `dob` is left on `players`, `coaches`,
--      `staging_players` or `staging_import_rows`.
--
-- Every drop names its object, with no CASCADE, so anything still depending
-- on one fails the migration.
--
-- **Kept.** `divisions.birthdate_start` and `birthdate_end` (a division's
-- window, not a person's date) and `season_settings.age_cutoff_mode`.
-- `coach_team_requests.child_birth_date`, which nothing writes (R0) and the R5
-- row does not name. `minimise_import_people_data()` is unchanged: it reads no
-- dropped column, and its list of audit metadata keys to redact still names
-- the birth keys, which old audit rows can carry.
--
-- Reversible in structure only: docs/sql/20261026010000_revert.sql restores
-- every object as it stood before this migration, with the two columns empty.
-- It cannot restore the dates this drops; the NOTICE below counts them.
-- Smoke checks: docs/sql/20261026010000_smoke.sql.
-- pgTAP: supabase/tests/natural_age.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What the drops destroy.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_players bigint;
    v_staged bigint;
    v_rows bigint;
BEGIN
    SELECT count(*) INTO v_players FROM public.players
     WHERE date_of_birth IS NOT NULL OR birth_year IS NOT NULL;
    SELECT count(*) INTO v_staged FROM public.staging_players sp
     WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(sp.raw_payload, '{}'::jsonb)
                                                   || COALESCE(sp.normalized_payload, '{}'::jsonb)) k
                    WHERE lower(btrim(k)) IN ('date_of_birth', 'dob', 'birth_year', 'date of birth', 'birthdate'));
    SELECT count(*) INTO v_rows FROM public.staging_import_rows sr
     WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(sr.raw_payload, '{}'::jsonb)
                                                   || COALESCE(sr.normalized_payload, '{}'::jsonb)) k
                    WHERE lower(btrim(k)) IN ('date_of_birth', 'dob', 'birth_year', 'date of birth', 'birthdate'));
    RAISE NOTICE 'dropping the birth date or birth year of % player(s); removing the birth keys of % staged player row(s) and % staged import row(s)',
        v_players, v_staged, v_rows;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The natural age.
-- ---------------------------------------------------------------------------

ALTER TABLE public.players
    ADD COLUMN natural_age smallint,
    ADD CONSTRAINT players_natural_age_check
        CHECK (natural_age IS NULL OR natural_age BETWEEN 1 AND 25);

COMMENT ON COLUMN public.players.natural_age IS
    'The player''s natural age group (the U-number the play-up rule compares with a division''s band), for the season of the import that wrote it: computed at import from the file''s birth date with the season''s cutoff, else the age group the export states. NULL when neither gave one (teaming places and flags the player). Birth dates are never stored (admin-focus plan R5).';

-- ---------------------------------------------------------------------------
-- 3. The SQL copy of the allowlist, without the birth keys.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_allowed_keys(p_import_type text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT CASE p_import_type
        WHEN 'players' THEN ARRAY[
            'first_name', 'last_name', 'preferred_name', 'nickname', 'external_registration_id',
            'gotsport_id', 'registration_id', 'player_id', 'natural_age',
            'age group', 'age_group', 'age', 'gender', 'grade', 'division_id', 'division_name',
            'division', 'group', 'program', 'skill_tier', 'skill_level', 'years_played',
            'years played',
            'how many years has your player played in an organized soccer program?', 'waitlist',
            'waitlisted', 'play_up', 'play up',
            'are you coaching so this player can play up a division?', 'willing_to_coach',
            'coach_volunteer', 'can you coach for this player''s team?', 'buddy_request',
            'buddy_id', 'buddy_external_registration_id', 'buddy_registration_id',
            'friend_request', 'mutual_buddy_code', 'buddy_code', 'friend_code', 'team name',
            'team age', 'team gender'
        ]::text[]
        WHEN 'coaches' THEN ARRAY[
            'full_name', 'email', 'status', 'coach_status', 'can_coach_multiple_teams',
            'multiple_teams', 'multi_team', 'certifications', 'certification', 'first_name',
            'last_name'
        ]::text[]
        ELSE ARRAY[]::text[]
    END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The player writers, without the birth date.
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
            WHEN 'willing_to_coach' THEN
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

CREATE OR REPLACE FUNCTION public.admin_bulk_update_players(
    p_player_ids uuid[],
    p_patch jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id uuid;
    v_org_count integer;
    v_sanitized jsonb;
    v_id uuid;
    v_count integer := 0;
BEGIN
    IF p_player_ids IS NULL OR array_length(p_player_ids, 1) IS NULL THEN
        RAISE EXCEPTION 'p_player_ids must be a non-empty array' USING ERRCODE = '22023';
    END IF;
    IF array_length(p_player_ids, 1) > 2000 THEN
        RAISE EXCEPTION 'bulk update limited to 2000 players' USING ERRCODE = '22023';
    END IF;

    SELECT count(DISTINCT organization_id), min(organization_id)
    INTO v_org_count, v_org_id
    FROM public.players
    WHERE id = ANY(p_player_ids);

    IF v_org_count <> 1 THEN
        RAISE EXCEPTION 'players must belong to exactly one organization' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    v_sanitized := public.sanitize_player_patch(p_patch);
    IF v_sanitized ? 'division_id' OR v_sanitized ? 'team_id' OR v_sanitized ? 'first_name'
        OR v_sanitized ? 'last_name' THEN
        RAISE EXCEPTION 'field not allowed in bulk updates' USING ERRCODE = '22023';
    END IF;

    FOR v_id IN SELECT unnest(p_player_ids) LOOP
        PERFORM public.apply_player_patch(v_id, v_sanitized);
        v_count := v_count + 1;
    END LOOP;

    PERFORM public.record_audit_event(
        v_org_id,
        'player.bulk_updated',
        'players',
        NULL,
        jsonb_build_object('patch', v_sanitized, 'player_count', v_count)
    );

    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_import_job(
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
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_error_count integer := 0;
    v_total_promoted_count integer := 0;
    v_status text;
    v_result jsonb;
    v_gender_model text;
    v_season_settings_id uuid;
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

    -- Season that auto-created divisions attach to (divisions are per-season).
    SELECT s.id
    INTO v_season_settings_id
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
    ORDER BY (s.status = 'active') DESC, s.season_start DESC NULLS LAST, s.created_at DESC
    LIMIT 1;

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
                    WHEN p.play_up_text IS NOT NULL
                    THEN jsonb_build_object('play_up', p.play_up_text)
                    ELSE '{}'::jsonb
                END
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
            buddy_request = COALESCE(de.buddy_request, p.buddy_request),
            -- An existing player's undeclared keys go too; the import's own
            -- keys (play-up, coaching answer, team placement) stay.
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
$$;

-- ---------------------------------------------------------------------------
-- 5. No staged row keeps a birth key.
-- ---------------------------------------------------------------------------

UPDATE public.staging_players sp
SET
    raw_payload = (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                     FROM jsonb_each(sp.raw_payload) e
                    WHERE lower(btrim(e.key)) NOT IN ('date_of_birth', 'dob', 'birth_year', 'date of birth', 'birthdate')),
    normalized_payload = CASE WHEN sp.normalized_payload IS NULL THEN NULL ELSE
        (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
           FROM jsonb_each(sp.normalized_payload) e
          WHERE lower(btrim(e.key)) NOT IN ('date_of_birth', 'dob', 'birth_year', 'date of birth', 'birthdate')) END
WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(sp.raw_payload, '{}'::jsonb)
                                              || COALESCE(sp.normalized_payload, '{}'::jsonb)) k
               WHERE lower(btrim(k)) IN ('date_of_birth', 'dob', 'birth_year', 'date of birth', 'birthdate'));

UPDATE public.staging_import_rows sr
SET
    raw_payload = (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                     FROM jsonb_each(sr.raw_payload) e
                    WHERE lower(btrim(e.key)) NOT IN ('date_of_birth', 'dob', 'birth_year', 'date of birth', 'birthdate')),
    normalized_payload = CASE WHEN sr.normalized_payload IS NULL THEN NULL ELSE
        (SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
           FROM jsonb_each(sr.normalized_payload) e
          WHERE lower(btrim(e.key)) NOT IN ('date_of_birth', 'dob', 'birth_year', 'date of birth', 'birthdate')) END
WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(COALESCE(sr.raw_payload, '{}'::jsonb)
                                              || COALESCE(sr.normalized_payload, '{}'::jsonb)) k
               WHERE lower(btrim(k)) IN ('date_of_birth', 'dob', 'birth_year', 'date of birth', 'birthdate'));

-- ---------------------------------------------------------------------------
-- 6. The birth columns, now that nothing writes or reads them.
-- ---------------------------------------------------------------------------

ALTER TABLE public.players
    DROP COLUMN date_of_birth,
    DROP COLUMN birth_year;

-- ---------------------------------------------------------------------------
-- 7. The end state.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_bad text;
BEGIN
    -- Code only: `--` comments and single-quoted literals are stripped, so the
    -- purge's list of audit metadata keys to redact is not a reference.
    SELECT string_agg(o, ', ' ORDER BY o) INTO v_bad FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
               ~ '\m(date_of_birth|birth_year)\M'
        UNION ALL
        SELECT 'view ' || c.relname
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
           AND pg_get_viewdef(c.oid) ~ '\m(date_of_birth|birth_year)\M'
        UNION ALL
        SELECT format('policy %s on %s', policyname, tablename)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '\m(date_of_birth|birth_year)\M'
    ) s;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'these still name a dropped birth column: %', v_bad;
    END IF;

    SELECT string_agg(c.relname || '.' || a.attname, ', ' ORDER BY c.relname, a.attname) INTO v_bad
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname IN ('players', 'coaches', 'staging_players', 'staging_import_rows')
       AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attname ~* '(birth|dob)';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'a people or staging table still has a birth column: %', v_bad;
    END IF;
END;
$$;

COMMIT;
