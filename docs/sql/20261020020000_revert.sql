-- Revert for 20261020020000_drop_player_medical_columns.sql
--
-- Restores the two columns as 20260331000000 defined them (jsonb, defaults
-- '{}' and '[]'), then `finalize_import_job(uuid, jsonb)` as production ran it
-- before the change: the 20260726000300 body byte for byte (md5
-- 32e607cb8154b91fb7b3cda8e3265ee7, read 2026-10-20), SECURITY DEFINER with
-- search_path=public. CREATE OR REPLACE keeps the grants, which the change
-- never touched.
--
-- What it loses: nothing that existed. The restored columns come back at their
-- defaults; whatever they held before the forward migration is gone with it,
-- and production held no player rows then (read 2026-10-20).
--
-- Verified: the harness compares the restored body's md5 with the one above,
-- checks the posture, and checks both columns are back.

BEGIN;

ALTER TABLE public.players
    ADD COLUMN IF NOT EXISTS medical_info jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS emergency_contacts jsonb DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.finalize_import_job(
    p_import_job_id uuid,
    p_validation_errors jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_now timestamptz := timezone('utc', now());
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
                sp.normalized_payload, 'payment_status', 'payment status'
            ), '')) AS payment_status_text,
            lower(COALESCE(public.import_payload_text(
                sp.normalized_payload, 'waitlist', 'waitlisted'
            ), '')) AS waitlist_text,
            public.import_payload_text(
                sp.normalized_payload,
                'play_up', 'play up',
                'are you coaching so this player can play up a division?'
            ) AS play_up_text,
            public.import_payload_text(sp.normalized_payload, 'buddy_request') AS buddy_request,
            public.import_payload_text(sp.normalized_payload, 'medical_info', 'medical') AS medical_notes,
            public.import_payload_text(sp.normalized_payload, 'email', 'contact_email') AS contact_email,
            public.import_payload_text(sp.normalized_payload, 'phone', 'contact_phone') AS contact_phone,
            public.import_payload_text(sp.normalized_payload, 'guardian_name', 'parent_name') AS guardian_name,
            public.import_payload_text(sp.normalized_payload, 'guardian_email', 'parent_email') AS guardian_email,
            public.import_payload_text(sp.normalized_payload, 'guardian_phone', 'parent_phone') AS guardian_phone,
            public.import_payload_text(
                sp.normalized_payload, 'guardian_1_first_name', 'guardian 1 first name'
            ) AS g1_first,
            public.import_payload_text(
                sp.normalized_payload, 'guardian_1_last_name', 'guardian 1 last name'
            ) AS g1_last,
            public.import_payload_text(
                sp.normalized_payload, 'guardian_1_email', 'guardian 1 email address', 'guardian 1 email'
            ) AS g1_email,
            public.import_payload_text(
                sp.normalized_payload, 'guardian_1_alternate_email', 'guardian 1 alternate email'
            ) AS g1_alt_email,
            public.import_payload_text(
                sp.normalized_payload, 'guardian_2_first_name', 'guardian 2 first name'
            ) AS g2_first,
            public.import_payload_text(
                sp.normalized_payload, 'guardian_2_last_name', 'guardian 2 last name'
            ) AS g2_last,
            public.import_payload_text(
                sp.normalized_payload, 'guardian_2_email', 'guardian 2 email address', 'guardian 2 email'
            ) AS g2_email,
            public.import_payload_text(
                sp.normalized_payload, 'guardian_2_alternate_email', 'guardian 2 alternate email'
            ) AS g2_alt_email,
            -- Nullable: NULL means the coaching-interest column is genuinely
            -- absent from this row's payload (re-import should preserve the
            -- existing player's willing_to_coach), distinct from a present-
            -- but-negative answer, which lower()s to a non-matching string.
            lower(public.import_payload_text(
                sp.normalized_payload,
                'willing_to_coach', 'coach_volunteer',
                'can you coach for this player''s team?'
            )) AS coaching_answer,
            sp.normalized_payload
                - 'first_name' - 'last_name' - 'preferred_name' - 'nickname'
                - 'date_of_birth' - 'dob' - 'grade' - 'gender' - 'birth_year'
                - 'skill_tier' - 'skill_level' - 'buddy_request'
                - 'medical_info' - 'medical' - 'email' - 'contact_email'
                - 'phone' - 'contact_phone' - 'guardian_name' - 'parent_name'
                - 'guardian_email' - 'parent_email' - 'guardian_phone' - 'parent_phone'
                - 'willing_to_coach' - 'coach_volunteer'
                - 'external_registration_id' - 'gotsport_id' - 'registration_id' - 'player_id'
                - 'division_id' - 'division_name' - 'division' - 'group' - 'program'
                - 'id' - 'organization_id' - 'team_id' - 'status' - 'created_at' - 'updated_at'
                - 'full_name' - 'profile_id' - 'user_id'
                - 'years_played' - 'years played'
                - 'how many years has your player played in an organized soccer program?'
                - 'payment_status' - 'payment status' - 'waitlist' - 'waitlisted'
                - 'play_up' - 'play up'
                - 'are you coaching so this player can play up a division?'
                - 'can you coach for this player''s team?'
                - 'guardian_1_first_name' - 'guardian 1 first name'
                - 'guardian_1_last_name' - 'guardian 1 last name'
                - 'guardian_1_email' - 'guardian 1 email address' - 'guardian 1 email'
                - 'guardian_1_alternate_email' - 'guardian 1 alternate email'
                - 'guardian_2_first_name' - 'guardian 2 first name'
                - 'guardian_2_last_name' - 'guardian 2 last name'
                - 'guardian_2_email' - 'guardian 2 email address' - 'guardian 2 email'
                - 'guardian_2_alternate_email' - 'guardian 2 alternate email' AS custom_attributes
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
            -- NULL when the export carried no Payment Status column, so
            -- re-imports never wipe manually recorded payments.
            CASE
                WHEN p.payment_status_text = '' THEN NULL
                ELSE p.payment_status_text IN ('paid', 'yes', 'true', 't', '1', 'y')
            END AS paid,
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
            CASE
                WHEN p.medical_notes IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('notes', p.medical_notes)
            END AS medical_info,
            jsonb_strip_nulls(jsonb_build_object(
                'email', p.contact_email,
                'phone', p.contact_phone
            )) AS contact_info,
            (
                SELECT COALESCE(jsonb_agg(g), '[]'::jsonb)
                FROM (
                    SELECT jsonb_strip_nulls(jsonb_build_object(
                        'name', NULLIF(trim(concat_ws(' ', p.g1_first, p.g1_last)), ''),
                        'email', p.g1_email,
                        'alternate_email', p.g1_alt_email
                    )) AS g
                    WHERE COALESCE(p.g1_first, p.g1_last, p.g1_email) IS NOT NULL
                    UNION ALL
                    SELECT jsonb_strip_nulls(jsonb_build_object(
                        'name', NULLIF(trim(concat_ws(' ', p.g2_first, p.g2_last)), ''),
                        'email', p.g2_email,
                        'alternate_email', p.g2_alt_email
                    ))
                    WHERE COALESCE(p.g2_first, p.g2_last, p.g2_email) IS NOT NULL
                    UNION ALL
                    -- Legacy single-guardian columns, only when the numbered
                    -- guardian columns are absent.
                    SELECT jsonb_strip_nulls(jsonb_build_object(
                        'name', p.guardian_name,
                        'email', p.guardian_email,
                        'phone', p.guardian_phone
                    ))
                    WHERE COALESCE(p.g1_first, p.g1_last, p.g1_email,
                                   p.g2_first, p.g2_last, p.g2_email) IS NULL
                      AND COALESCE(p.guardian_name, p.guardian_email, p.guardian_phone) IS NOT NULL
                ) guardians
            ) AS guardian_contacts,
            (p.custom_attributes
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
            paid = COALESCE(de.paid, p.paid),
            status = CASE
                WHEN de.import_status = 'waitlist' THEN 'waitlist'
                WHEN p.status = 'waitlist' AND de.import_status = 'active' THEN 'active'
                ELSE p.status
            END,
            willing_to_coach = COALESCE(de.willing_to_coach, p.willing_to_coach),
            coach_volunteer = COALESCE(de.willing_to_coach, p.coach_volunteer),
            buddy_request = COALESCE(de.buddy_request, p.buddy_request),
            medical_info = CASE
                WHEN de.medical_info = '{}'::jsonb THEN p.medical_info
                ELSE de.medical_info
            END,
            contact_info = COALESCE(p.contact_info, '{}'::jsonb) || de.contact_info,
            guardian_contacts = COALESCE(NULLIF(de.guardian_contacts, '[]'::jsonb), p.guardian_contacts),
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
            medical_info,
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
            COALESCE(paid, false),
            import_status,
            COALESCE(willing_to_coach, false),
            COALESCE(willing_to_coach, false),
            buddy_request,
            guardian_contacts,
            medical_info,
            jsonb_build_array(jsonb_build_object(
                'import_job_id', p_import_job_id,
                'imported_at', v_now,
                'source', 'gotsport',
                'operation', 'inserted'
            )),
            contact_info,
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

COMMIT;
