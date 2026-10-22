-- Data minimisation at import, and the purge (plan
-- docs/changes/2026-10-22-admin-focus.md, R0; owner decisions 2026-10-22,
-- docs/product.md "Constraints").
--
-- **Why.** Both finalizers stored every column of the export they did not map
-- in `custom_attributes` (`normalized_payload` minus a denylist), and the
-- sensitive-column filter has no pattern for guardians, addresses, phones or a
-- child's birth date. Production's 130 coaches each carry a phone and a
-- `custom_attributes` holding both guardians' names, addresses, emails and
-- phones, the child's name and birth date, the coach's own birth date and the
-- payment status (read 2026-10-22). A denylist cannot keep up with an export
-- the league does not control, so the import becomes an **allowlist**.
--
-- **The change.**
--   * `import_declared_attributes(org, entity, payload)` (new, SECURITY
--     INVOKER, no grant to any client role) returns the payload's entries
--     whose key matches a field the organization declared in
--     `organization_schemas` for the entity, keyed by the declared name and
--     typed as declared; everything else is dropped. It is the SQL half of
--     the allowlist's rule (c) (`_shared/import-allowlist.ts`).
--   * `finalize_import_job(uuid, jsonb)`, copied from its latest body
--     (20261020020000), no longer reads any email, phone, guardian, parent or
--     payment key: it writes `contact_info = '{}'` and `guardian_contacts =
--     '[]'` on a new player and leaves both untouched on an existing one (the
--     columns are dropped in a later PR), and `paid = false` on a new player
--     and untouched on an existing one. `custom_attributes` is the declared
--     fields, the team placement (`team_name`, `team_age`, `team_gender`,
--     kept for Phase B), `play_up` and `coaching_answer`, not the payload
--     minus a denylist.
--   * `finalize_coach_import_job(uuid, jsonb)`, copied from its latest body
--     (20260726000300), no longer reads or writes a phone: `coaches.phone` is
--     not written, `contact_info` carries the email and loses any phone, and
--     `custom_attributes` is the declared fields only (an existing coach's
--     undeclared keys are dropped on re-import too).
--   * Both keep SECURITY DEFINER, `search_path = public`, their grants
--     (CREATE OR REPLACE keeps them) and `timezone = UTC`, which 20261021040000
--     set with ALTER FUNCTION and CREATE OR REPLACE would otherwise reset. Both
--     use `now()`.
--   * `minimise_import_people_data()` (new, SECURITY INVOKER, no grant to any
--     client role) purges what is stored today, and this migration runs it
--     once:
--       - every coach's `custom_attributes` reduced to its declared fields
--         (production declares none, so `{}`), `phone` NULL and `phone` out of
--         `contact_info`;
--       - the same in the coach snapshots `import_application_records` keeps
--         for rollback (previous, applied and rollback payloads), so a
--         rollback cannot restore what was purged;
--       - both staging tables' rows of every completed, completed with
--         warnings or failed job deleted. Rows of a job still queued,
--         processing, importing, ready to apply or needing a fix stay, so a
--         deferred apply (20260503090000) is not lost;
--       - personal values in `audit_log.metadata` replaced with
--         '[redacted]': the email keys on every row, and the name, birth
--         date, contact, guardian and note keys inside a player event's
--         `patch`, `fields`, `old` and `new`. No row is deleted.
--   * A daily job deletes `staging_import_rows` older than 30 days, as
--     `cleanup-staging-players` (20260416000002) does for `staging_players`.
--
-- The import path's other two halves are code: the browser and the
-- import-validation Edge Function keep only the allowlisted columns
-- (`frontend/src/utils/importAllowlist.js`, `_shared/import-allowlist.ts`);
-- `tests/importAllowlistParity.test.js` holds both lists equal to the keys
-- these functions read.
--
-- Reversible in structure only: docs/sql/20261022010000_revert.sql restores
-- the function bodies and drops the new ones. It cannot restore purged data.
-- Smoke checks: docs/sql/20261022010000_smoke.sql.
-- pgTAP: supabase/tests/import_allowlist.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The declared-fields half of the allowlist.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_declared_attributes(
    p_organization_id uuid,
    p_entity_type text,
    p_payload jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    -- A declared field's identity is what the schema builder stores for a
    -- name: lower case, trimmed, whitespace runs as one underscore. An import
    -- column `Jersey Size` matches a declared `jersey_size` and is stored
    -- under the declared name, typed as declared; a value that does not parse
    -- as its type is dropped rather than stored as text (the
    -- validate_custom_attributes trigger would refuse it).
    WITH declared AS (
        SELECT
            f.key AS name,
            f.value AS field_type,
            regexp_replace(regexp_replace(lower(f.key), '^\s+|\s+$', '', 'g'), '\s+', '_', 'g')
                AS identity
        FROM public.organization_schemas s
        CROSS JOIN LATERAL jsonb_each_text(
            CASE WHEN jsonb_typeof(s.schema_definition) = 'object'
                 THEN s.schema_definition ELSE '{}'::jsonb END
        ) f
        WHERE s.organization_id = p_organization_id
          AND s.entity_type = p_entity_type
    ),
    cells AS (
        SELECT
            d.name,
            d.field_type,
            c.key,
            NULLIF(btrim(c.value #>> '{}'), '') AS v
        FROM jsonb_each(
            CASE WHEN jsonb_typeof(p_payload) = 'object' THEN p_payload ELSE '{}'::jsonb END
        ) c
        JOIN declared d
          ON d.identity = regexp_replace(
                regexp_replace(lower(c.key), '^\s+|\s+$', '', 'g'), '\s+', '_', 'g')
        WHERE jsonb_typeof(c.value) IN ('string', 'number', 'boolean')
    ),
    typed AS (
        SELECT
            name,
            key,
            CASE field_type
                WHEN 'number' THEN
                    CASE WHEN v ~ '^-?[0-9]+(\.[0-9]+)?$' THEN to_jsonb(v::numeric) END
                WHEN 'boolean' THEN
                    CASE
                        WHEN lower(v) IN ('true', 't', 'yes', 'y', '1') THEN 'true'::jsonb
                        WHEN lower(v) IN ('false', 'f', 'no', 'n', '0') THEN 'false'::jsonb
                    END
                WHEN 'date' THEN
                    to_jsonb(to_char(public.import_text_to_date(v), 'YYYY-MM-DD'))
                ELSE to_jsonb(v)
            END AS value
        FROM cells
        WHERE v IS NOT NULL
    )
    SELECT COALESCE(jsonb_object_agg(name, value ORDER BY key COLLATE "C"), '{}'::jsonb)
    FROM typed
    WHERE value IS NOT NULL;
$$;

-- Called only from the SECURITY DEFINER finalizers and the purge, which run
-- as their owner; no client role needs it.
REVOKE ALL ON FUNCTION public.import_declared_attributes(uuid, text, jsonb)
    FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. finalize_import_job: copied from 20261020020000; contact, guardian and
--    payment reads removed; custom_attributes from the allowlist.
-- ---------------------------------------------------------------------------

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
            public.import_text_to_date(
                public.import_payload_text(sp.normalized_payload, 'date_of_birth', 'dob')
            ) AS date_of_birth,
            public.import_payload_text(sp.normalized_payload, 'grade') AS grade,
            public.import_payload_text(sp.normalized_payload, 'gender') AS gender,
            public.import_payload_text(sp.normalized_payload, 'birth_year') AS birth_year_text,
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
            public.import_declared_attributes(
                sp.organization_id, 'player', sp.normalized_payload
            ) AS custom_attributes
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
                WHEN p.birth_year_text ~ '^\d{4}$' THEN p.birth_year_text::integer
                WHEN p.date_of_birth IS NOT NULL THEN EXTRACT(YEAR FROM p.date_of_birth)::integer
                ELSE NULL
            END AS birth_year,
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
          AND p.date_of_birth IS NOT NULL
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
            date_of_birth = de.date_of_birth,
            grade = COALESCE(de.grade, p.grade),
            gender = COALESCE(de.gender, p.gender),
            birth_year = COALESCE(de.birth_year, p.birth_year),
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
            custom_attributes = COALESCE(p.custom_attributes, '{}'::jsonb) || de.final_custom_attributes,
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
            date_of_birth,
            grade,
            gender,
            birth_year,
            skill_tier,
            years_played,
            paid,
            status,
            coach_volunteer,
            willing_to_coach,
            buddy_request,
            guardian_contacts,
            registration_history,
            contact_info,
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
            date_of_birth,
            grade,
            gender,
            birth_year,
            skill_tier,
            years_played,
            false,
            import_status,
            COALESCE(willing_to_coach, false),
            COALESCE(willing_to_coach, false),
            buddy_request,
            '[]'::jsonb,
            jsonb_build_array(jsonb_build_object(
                'import_job_id', p_import_job_id,
                'imported_at', v_now,
                'source', 'gotsport',
                'operation', 'inserted'
            )),
            '{}'::jsonb,
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
-- 3. finalize_coach_import_job: copied from 20260726000300; no phone;
--    custom_attributes from the allowlist.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.finalize_coach_import_job(
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
    v_previous_payload jsonb;
    v_existing_found boolean;
    v_inserted_count integer := 0;
    v_updated_count integer := 0;
    v_invalid_count integer := 0;
    v_cross_org_conflict_count integer := 0;
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
        -- The coach's email is how they sign in; no phone is stored (R0).
        v_contact_info := jsonb_strip_nulls(jsonb_build_object('email', v_email));
        -- The allowlist (R0): only the fields the organization declared for
        -- coaches, keyed by their declared names. Every other column of the
        -- export (a child's details, guardians' addresses and phones, the
        -- coach's own birth date) is dropped here, whatever reached staging.
        v_custom_attributes := public.import_declared_attributes(
            v_job.organization_id, 'coach', v_row.normalized_payload
        );

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

        SELECT *
        INTO v_existing
        FROM public.coaches c
        WHERE lower(c.email) = v_email
        ORDER BY c.created_at, c.id
        LIMIT 1;
        v_existing_found := FOUND;

        IF v_existing_found AND v_existing.organization_id <> v_job.organization_id THEN
            v_cross_org_conflict_count := v_cross_org_conflict_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Coach email already belongs to another organization',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

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
                    v_job.organization_id, 'coach', COALESCE(v_existing.custom_attributes, '{}'::jsonb)
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
          OR v_cross_org_conflict_count > 0
          OR v_blocked_assignment_count > 0
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
        'cross_org_conflict_rows', v_cross_org_conflict_count,
        'blocked_assignment_rows', v_blocked_assignment_count,
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
$$;

-- ---------------------------------------------------------------------------
-- 4. The purge of what is stored today. A function so the pgTAP suite and
--    the smoke can run it against planted rows; this migration runs it once.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.minimise_import_people_data()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    -- Inside a player event's patch, fields, old or new: names, birth date,
    -- contact, guardian and free-text note values.
    v_player_keys text[] := ARRAY[
        'first_name', 'last_name', 'preferred_name', 'nickname', 'full_name', 'name',
        'date_of_birth', 'dob', 'birth_year', 'notes',
        'contact_info', 'guardian_contacts', 'emergency_contacts', 'medical_info',
        'email', 'alternate_email', 'phone', 'address'
    ];
    -- At the top level of any event's metadata: an email or phone.
    v_top_keys text[] := ARRAY[
        'coach_email', 'matched_email', 'email', 'contact_email', 'guardian_email',
        'parent_email', 'invited_email', 'phone'
    ];
    v_coaches integer := 0;
    v_records integer := 0;
    v_staging_players integer := 0;
    v_staging_rows integer := 0;
    v_audit integer := 0;
BEGIN
    UPDATE public.coaches c
    SET
        custom_attributes = public.import_declared_attributes(
            c.organization_id, 'coach', COALESCE(c.custom_attributes, '{}'::jsonb)),
        phone = NULL,
        contact_info = COALESCE(c.contact_info, '{}'::jsonb) - 'phone'
    WHERE c.phone IS NOT NULL
       OR COALESCE(c.contact_info, '{}'::jsonb) ? 'phone'
       OR COALESCE(c.custom_attributes, '{}'::jsonb) IS DISTINCT FROM
          public.import_declared_attributes(
              c.organization_id, 'coach', COALESCE(c.custom_attributes, '{}'::jsonb));
    GET DIAGNOSTICS v_coaches = ROW_COUNT;

    -- A coach snapshot is `to_jsonb(coaches row)`; rollback restores from it.
    -- Each of a record's three payloads is scrubbed alone, and a NULL one
    -- stays NULL.
    WITH parts AS (
        SELECT
            r.id,
            k.payload_key,
            CASE
                WHEN jsonb_typeof(k.payload) = 'object' AND k.payload ? 'full_name' THEN
                    k.payload
                    || CASE WHEN k.payload ? 'phone'
                            THEN jsonb_build_object('phone', NULL) ELSE '{}'::jsonb END
                    || CASE WHEN jsonb_typeof(k.payload -> 'contact_info') = 'object'
                            THEN jsonb_build_object(
                                'contact_info', (k.payload -> 'contact_info') - 'phone')
                            ELSE '{}'::jsonb END
                    || jsonb_build_object(
                        'custom_attributes',
                        public.import_declared_attributes(
                            r.organization_id, 'coach',
                            COALESCE(k.payload -> 'custom_attributes', '{}'::jsonb)))
                ELSE k.payload
            END AS payload
        FROM public.import_application_records r
        CROSS JOIN LATERAL (VALUES
            ('previous_payload', r.previous_payload),
            ('applied_payload', r.applied_payload),
            ('rollback_payload', r.rollback_payload)
        ) AS k(payload_key, payload)
        WHERE r.target_table = 'coaches'
    ),
    scrubbed AS (
        SELECT
            id,
            (array_agg(payload) FILTER (WHERE payload_key = 'previous_payload'))[1] AS previous_payload,
            (array_agg(payload) FILTER (WHERE payload_key = 'applied_payload'))[1] AS applied_payload,
            (array_agg(payload) FILTER (WHERE payload_key = 'rollback_payload'))[1] AS rollback_payload
        FROM parts
        GROUP BY id
    )
    UPDATE public.import_application_records r
    SET
        previous_payload = s.previous_payload,
        applied_payload = s.applied_payload,
        rollback_payload = s.rollback_payload
    FROM scrubbed s
    WHERE r.id = s.id
      AND (r.previous_payload IS DISTINCT FROM s.previous_payload
           OR r.applied_payload IS DISTINCT FROM s.applied_payload
           OR r.rollback_payload IS DISTINCT FROM s.rollback_payload);
    GET DIAGNOSTICS v_records = ROW_COUNT;

    -- Staged rows of a job that is over. A job still queued, processing,
    -- importing, ready to apply or needing a fix keeps its rows.
    DELETE FROM public.staging_players sp
    USING public.import_jobs j
    WHERE j.id = sp.import_job_id
      AND j.status IN ('completed', 'completed_with_warnings', 'failed');
    GET DIAGNOSTICS v_staging_players = ROW_COUNT;

    DELETE FROM public.staging_import_rows sr
    USING public.import_jobs j
    WHERE j.id = sr.import_job_id
      AND j.status IN ('completed', 'completed_with_warnings', 'failed');
    GET DIAGNOSTICS v_staging_rows = ROW_COUNT;

    WITH scrubbed AS (
        SELECT
            a.id,
            (
                SELECT COALESCE(jsonb_object_agg(
                    e.key,
                    CASE
                        WHEN e.key = ANY (v_top_keys) AND jsonb_typeof(e.value) <> 'null'
                            THEN to_jsonb('[redacted]'::text)
                        WHEN (a.resource_type = 'players' OR a.action LIKE 'player.%')
                             AND e.key IN ('patch', 'fields', 'old', 'new')
                             AND jsonb_typeof(e.value) = 'object'
                            THEN (
                                SELECT COALESCE(jsonb_object_agg(
                                    n.key,
                                    CASE WHEN n.key = ANY (v_player_keys)
                                              AND jsonb_typeof(n.value) <> 'null'
                                         THEN to_jsonb('[redacted]'::text)
                                         ELSE n.value END
                                ), '{}'::jsonb)
                                FROM jsonb_each(e.value) n
                            )
                        ELSE e.value
                    END
                ), '{}'::jsonb)
                FROM jsonb_each(a.metadata) e
            ) AS metadata
        FROM public.audit_log a
        WHERE jsonb_typeof(a.metadata) = 'object'
    )
    UPDATE public.audit_log a
    SET metadata = s.metadata
    FROM scrubbed s
    WHERE a.id = s.id
      AND a.metadata IS DISTINCT FROM s.metadata;
    GET DIAGNOSTICS v_audit = ROW_COUNT;

    RETURN jsonb_build_object(
        'coaches', v_coaches,
        'import_application_records', v_records,
        'staging_players', v_staging_players,
        'staging_import_rows', v_staging_rows,
        'audit_log', v_audit
    );
END;
$$;

-- The migration and the test suites run it as the database owner; no client
-- role may (it deletes and rewrites across every organization).
REVOKE ALL ON FUNCTION public.minimise_import_people_data()
    FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
    v_result jsonb := public.minimise_import_people_data();
BEGIN
    RAISE NOTICE 'minimise_import_people_data: %', v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Retention for staging_import_rows, as for staging_players (30 days).
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
    'cleanup-staging-import-rows',
    '0 3 * * *',
    $$ DELETE FROM public.staging_import_rows WHERE created_at < now() - interval '30 days' $$
);

COMMIT;
