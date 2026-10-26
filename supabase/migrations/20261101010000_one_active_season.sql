-- One active season per organization, and imports that carry their season
-- (plan docs/changes/2026-10-22-phase-e-seasons.md, E1; decisions 5.1-5.3 of
-- docs/changes/2026-10-20-core-roadmap.md; the AGENTS.md rule 14 plan for this
-- persistence change, approved by the owner).
--
-- **Why.** The organization's "current" season was whichever row was newest
-- (the browser), whichever had the latest start (the importer) or whichever
-- the free-text label named, and nothing stopped a second `active` row. A draft
-- season created for next year would have become current the moment it existed.
-- Phase E3 adds drafts, so before anything can create one every reader has to
-- stop meaning "newest" and the database has to say what "the" season is.
--
-- **The change.**
--   1. What it touches, counted in a NOTICE; the inventory RAISEs, naming the
--      organizations, if any has two `active` seasons or two seasons whose names
--      differ only in case or padding (the owner decides which; this does not
--      guess).
--   2. An organization with seasons and none `active` gets its newest season
--      activated: it is what every reader shows that organization today. A NULL
--      status becomes `draft`. Production (read-only, 2026-10-22): one
--      organization, one season, `active`, no duplicate names.
--   3. `season_settings.status` is NOT NULL DEFAULT 'draft'. Unique partial
--      index `season_settings_one_active` (one `active` row per organization)
--      and unique index `season_settings_org_name_key` on
--      `(organization_id, lower(btrim(name)))`.
--   4. The three direct-write policies on `season_settings` are dropped (insert,
--      update, delete: admins and staff). The table keeps its member SELECT
--      policy; every writer is a SECURITY DEFINER function (`initialize_new_tenant`,
--      `admin_set_season_timezone`, the demo start) or the service role, and
--      Phase E3 adds the season RPCs. Nothing in the app wrote the table
--      directly.
--   5. `import_jobs.season_settings_id` (FK, ON DELETE CASCADE, indexed; NULL for
--      jobs made before this). `create_import_job` takes a trailing
--      `p_season_settings_id uuid DEFAULT NULL`: it must be the organization's
--      and not completed (42501, 22023); none named means the organization's
--      active season, fixed now rather than at finalize time. The 3-argument
--      signature is dropped by its exact name and signature (no CASCADE) and the
--      4-argument one created, so every call by name (the app, the Edge
--      tests, a cached browser mid-deploy) still resolves.
--   6. `finalize_import_job` and `finalize_field_import_job` read the job's
--      season (a job without one: the active season) instead of the active-
--      then-latest-start-then-newest order, and refuse a completed one (22023,
--      detail `season_completed`). `upsert_division_for_import` and
--      `admin_upsert_division_settings` refuse a completed season the same way.
--      Each replaced body is the latest one (20261026010000, 20261029010000,
--      20261021040000, 20261029010000, 20261021040000) with this change only;
--      the UTC idiom (`now()`, TimeZone pinned) is kept.
--   7. An end-state check: the column, indexes, absent policies and signature,
--      and that each replaced body reads the job's season.
--
-- **Nothing changes for an organization with one active season** (every
-- organization today): the job's season is that season, every reader that used
-- to say "newest" says the same row, and no draft can exist until E3.
--
-- **Production's bodies are not read from here.** The migration refuses to
-- replace a function whose text it has not seen (the md5 of `prosrc` below, read
-- off a build of the repository at 20261031010000). If production's differs, the
-- migration stops before changing anything and the operator compares the two.
--
-- Every drop names its object, with no CASCADE. No DDL touches the auth or
-- storage schemas.
--
-- Reversible in structure: docs/sql/20261101010000_revert.sql restores every
-- replaced function and the policies, drops the indexes and the column, and
-- relaxes the status column. It cannot restore the seasons it activated or the
-- NULL statuses it filled. Smoke: docs/sql/20261101010000_smoke.sql. pgTAP:
-- supabase/tests/one_active_season.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What changes, counted, and what stops it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_orgs bigint;
    v_seasons bigint;
    v_null_status bigint;
    v_no_active bigint;
    v_dup_active text;
    v_dup_names text;
BEGIN
    SELECT count(DISTINCT organization_id), count(*) INTO v_orgs, v_seasons FROM public.season_settings;
    SELECT count(*) INTO v_null_status FROM public.season_settings WHERE status IS NULL;
    SELECT count(*) INTO v_no_active FROM (
        SELECT organization_id FROM public.season_settings
         GROUP BY organization_id
        HAVING count(*) FILTER (WHERE status = 'active') = 0
    ) x;

    SELECT string_agg(organization_id::text || ' (' || n || ' active)', ', ' ORDER BY organization_id)
      INTO v_dup_active
      FROM (SELECT organization_id, count(*) AS n FROM public.season_settings
             WHERE status = 'active' GROUP BY organization_id HAVING count(*) > 1) x;
    IF v_dup_active IS NOT NULL THEN
        RAISE EXCEPTION 'organization(s) with more than one active season, which the new unique index would refuse: %. Decide which stays active and complete or draft the rest by hand, then run this again.', v_dup_active
            USING ERRCODE = 'P0001';
    END IF;

    SELECT string_agg(organization_id::text || ' ("' || lower(btrim(name)) || '" x' || n || ')', ', ' ORDER BY organization_id)
      INTO v_dup_names
      FROM (SELECT organization_id, name, count(*) OVER (PARTITION BY organization_id, lower(btrim(name))) AS n
              FROM public.season_settings) x
     WHERE n > 1;
    IF v_dup_names IS NOT NULL THEN
        RAISE EXCEPTION 'organization(s) with two seasons whose names differ only in case or padding, which the new unique index would refuse: %. Rename one by hand, then run this again.', v_dup_names
            USING ERRCODE = 'P0001';
    END IF;

    RAISE NOTICE '% season(s) in % organization(s); % with no status become draft; % organization(s) have no active season and get their newest activated',
        v_seasons, v_orgs, v_null_status, v_no_active;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Every organization with seasons has exactly one active; no status is NULL.
-- ---------------------------------------------------------------------------

WITH needs AS (
    SELECT organization_id FROM public.season_settings
     GROUP BY organization_id
    HAVING count(*) FILTER (WHERE status = 'active') = 0
), newest AS (
    SELECT DISTINCT ON (s.organization_id) s.id
      FROM public.season_settings s
      JOIN needs n ON n.organization_id = s.organization_id
     ORDER BY s.organization_id, s.created_at DESC, s.id DESC
)
UPDATE public.season_settings s SET status = 'active' FROM newest WHERE s.id = newest.id;

UPDATE public.season_settings SET status = 'draft' WHERE status IS NULL;

-- ---------------------------------------------------------------------------
-- 3. The status is a fact, and there is one active season.
-- ---------------------------------------------------------------------------

ALTER TABLE public.season_settings ALTER COLUMN status SET DEFAULT 'draft';
ALTER TABLE public.season_settings ALTER COLUMN status SET NOT NULL;

COMMENT ON COLUMN public.season_settings.status IS
    'draft | active | completed. At most one active season per organization (season_settings_one_active); a new season is a draft. 20261101010000.';

CREATE UNIQUE INDEX season_settings_one_active
    ON public.season_settings (organization_id) WHERE status = 'active';
CREATE UNIQUE INDEX season_settings_org_name_key
    ON public.season_settings (organization_id, lower(btrim(name)));

-- ---------------------------------------------------------------------------
-- 4. No direct writes: the season RPCs are the writers.
-- ---------------------------------------------------------------------------

DROP POLICY "Season Settings: admins insert" ON public.season_settings;
DROP POLICY "Season Settings: admins update" ON public.season_settings;
DROP POLICY "Season Settings: admins delete" ON public.season_settings;

-- ---------------------------------------------------------------------------
-- 5. An import job names its season.
-- ---------------------------------------------------------------------------

ALTER TABLE public.import_jobs
    ADD COLUMN season_settings_id uuid REFERENCES public.season_settings (id) ON DELETE CASCADE;
CREATE INDEX idx_import_jobs_season_settings_id
    ON public.import_jobs (season_settings_id) WHERE season_settings_id IS NOT NULL;
COMMENT ON COLUMN public.import_jobs.season_settings_id IS
    'The season the import adds to, fixed when the job is created (the organization''s active season unless one was named). NULL for a job made before 20261101010000: its finalizer then uses the active season.';

-- ---------------------------------------------------------------------------
-- 6. The starting bodies are checked.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_expected constant jsonb := '{
        "finalize_import_job(uuid,jsonb)": "9fd04aac78aca4513e05419ea6ecb933",
        "finalize_field_import_job(uuid,jsonb)": "f4492f35e731db887673667e30a6efd9",
        "upsert_division_for_import(uuid,uuid,text,text,integer,integer,date,date)": "b8b434378b4e25c7604106636050e282",
        "admin_upsert_division_settings(uuid,uuid,uuid,text,integer,integer,integer,integer,integer,integer,boolean)": "2852abb9e572083a4c35315cb05e6cd6",
        "create_import_job(uuid,text,text)": "11f25a77ec09f37d6eca250039f6ae18"
    }';
    v_sig text;
    v_md5 text;
BEGIN
    FOR v_sig IN SELECT jsonb_object_keys(v_expected) LOOP
        SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_sig);
        IF v_md5 IS DISTINCT FROM v_expected ->> v_sig THEN
            RAISE EXCEPTION 'public.% has a body this migration has not seen (md5 %, expected %): not replacing it',
                v_sig, v_md5, v_expected ->> v_sig;
        END IF;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. create_import_job takes the season.
-- ---------------------------------------------------------------------------

DROP FUNCTION public.create_import_job(uuid, text, text);

CREATE FUNCTION public.create_import_job(p_organization_id uuid, p_import_type text, p_file_name text, p_season_settings_id uuid DEFAULT NULL::uuid)
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
    END IF;

    INSERT INTO public.import_jobs (organization_id,job_type,storage_path,status,total_rows,processed_rows,progress_percent,last_heartbeat_at,created_by,started_at,season_settings_id)
    VALUES (p_organization_id,v_job_type,format('imports/%s/%s', auth.uid(), v_file_name),'importing',0,0,0,v_now,auth.uid(),v_now,v_season_id)
    RETURNING * INTO v_job;

    PERFORM public.record_audit_event(p_organization_id,'import.started','import_job',v_job.id,jsonb_build_object('import_type',v_import_type,'job_type',v_job_type,'status','importing'));
    RETURN v_job;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_import_job(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_import_job(uuid, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_import_job(uuid, text, text, uuid) TO authenticated;
COMMENT ON FUNCTION public.create_import_job(uuid, text, text, uuid) IS
    'Admin-only import job creation RPC for browser-driven CSV workflows. As of 20261101010000 the job names its season: the one passed (the organization''s, not completed) or else the organization''s active season, fixed at creation.';

-- ---------------------------------------------------------------------------
-- 8. The finalizers and the two division writers, from their latest bodies.
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
$function$;

CREATE OR REPLACE FUNCTION public.finalize_field_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
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
    v_import_season_status text;
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
    -- finalize_import_job chooses the season it attaches divisions to. As of
    -- 20261101010000 that is the job's own season, or, for a job made before
    -- jobs carried one, the organization's active season; a completed season
    -- takes no import.
    SELECT s.id, s.name, s.status
    INTO v_import_season_id, v_import_season_name, v_import_season_status
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
      AND (CASE WHEN v_job.season_settings_id IS NULL
                THEN s.status = 'active'
                ELSE s.id = v_job.season_settings_id END);

    IF v_import_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_import_season_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
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
$function$;

CREATE OR REPLACE FUNCTION public.upsert_division_for_import(p_organization_id uuid, p_season_settings_id uuid, p_name text, p_gender text DEFAULT NULL::text, p_min_age integer DEFAULT NULL::integer, p_max_age integer DEFAULT NULL::integer, p_birthdate_start date DEFAULT NULL::date, p_birthdate_end date DEFAULT NULL::date)
 RETURNS divisions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  v_division public.divisions;
  v_gender public.gender_policy_enum;
  v_season_status text;
BEGIN
  IF NOT public.is_org_admin(p_organization_id) THEN
    RAISE EXCEPTION 'Access denied: admin required for organization %', p_organization_id
      USING ERRCODE = '42501';
  END IF;

  -- The season must belong to the same organization, otherwise an admin of one
  -- org could create/update a division under another org's season.
  SELECT s.status INTO v_season_status
    FROM public.season_settings s
   WHERE s.id = p_season_settings_id
     AND s.organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'season % does not belong to organization %',
      p_season_settings_id, p_organization_id
      USING ERRCODE = '42501';
  END IF;

  -- 20261101010000: a completed season is history; no import adds to it.
  IF v_season_status = 'completed' THEN
    RAISE EXCEPTION 'season % is completed and takes no division', p_season_settings_id
      USING ERRCODE = '22023', DETAIL = 'season_completed';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'division name is required';
  END IF;

  v_gender := (
    CASE
      WHEN lower(coalesce(p_gender, '')) IN ('g', 'girls', 'girl', 'female', 'f', 'women') THEN 'girls'
      WHEN lower(coalesce(p_gender, '')) IN ('b', 'boys', 'boy', 'male', 'm', 'men') THEN 'boys'
      WHEN lower(coalesce(p_gender, '')) IN ('coed', 'co-ed', 'both', 'mixed') THEN 'coed'
      ELSE 'coed'
    END
  )::public.gender_policy_enum;

  INSERT INTO public.divisions AS d (
    organization_id, season_settings_id, name, gender_policy,
    min_age, max_age, birthdate_start, birthdate_end
  )
  VALUES (
    p_organization_id, p_season_settings_id, btrim(p_name), v_gender,
    p_min_age, p_max_age, p_birthdate_start, p_birthdate_end
  )
  ON CONFLICT (season_settings_id, name) DO UPDATE SET
    gender_policy   = EXCLUDED.gender_policy,
    min_age         = COALESCE(EXCLUDED.min_age, d.min_age),
    max_age         = COALESCE(EXCLUDED.max_age, d.max_age),
    birthdate_start = COALESCE(EXCLUDED.birthdate_start, d.birthdate_start),
    birthdate_end   = COALESCE(EXCLUDED.birthdate_end, d.birthdate_end),
    updated_at      = now()
  RETURNING * INTO v_division;

  RETURN v_division;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_upsert_division_settings(p_organization_id uuid, p_season_settings_id uuid, p_division_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_max_roster_size integer DEFAULT NULL::integer, p_min_roster_size integer DEFAULT NULL::integer, p_target_team_size integer DEFAULT NULL::integer, p_team_count_override integer DEFAULT NULL::integer, p_min_teams integer DEFAULT NULL::integer, p_max_teams integer DEFAULT NULL::integer, p_plays_games boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_season_org_id uuid;
    v_season_status text;
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

    SELECT ss.organization_id, ss.status
      INTO v_season_org_id, v_season_status
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

    -- 20261101010000: a completed season is history; its rules are not edited.
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and its division rules cannot be changed', p_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
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
$function$;

-- ---------------------------------------------------------------------------
-- 9. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_n integer;
    v_def text;
    v_sig text;
BEGIN
    -- The status is a fact.
    SELECT count(*) INTO v_n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'season_settings' AND column_name = 'status'
       AND is_nullable = 'NO' AND column_default LIKE '''draft''%';
    IF v_n <> 1 THEN RAISE EXCEPTION 'season_settings.status is not NOT NULL DEFAULT draft'; END IF;
    IF EXISTS (SELECT 1 FROM public.season_settings WHERE status IS NULL) THEN
        RAISE EXCEPTION 'a season still has no status';
    END IF;

    -- One active season, and the two indexes as declared.
    IF EXISTS (SELECT 1 FROM public.season_settings WHERE status = 'active'
                GROUP BY organization_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'an organization still has two active seasons';
    END IF;
    IF EXISTS (SELECT 1 FROM public.season_settings s
                WHERE NOT EXISTS (SELECT 1 FROM public.season_settings a
                                   WHERE a.organization_id = s.organization_id AND a.status = 'active')) THEN
        RAISE EXCEPTION 'an organization with seasons has no active one';
    END IF;
    SELECT indexdef INTO v_def FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'season_settings_one_active';
    IF v_def IS NULL OR v_def NOT LIKE 'CREATE UNIQUE INDEX%(organization_id) WHERE (status = ''active''::text)' THEN
        RAISE EXCEPTION 'season_settings_one_active is not as declared: %', v_def;
    END IF;
    SELECT indexdef INTO v_def FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'season_settings_org_name_key';
    IF v_def IS NULL OR v_def NOT LIKE 'CREATE UNIQUE INDEX%(organization_id, lower(btrim(name)))' THEN
        RAISE EXCEPTION 'season_settings_org_name_key is not as declared: %', v_def;
    END IF;

    -- No client writes the table directly; members still read it.
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'season_settings' AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
    IF v_n <> 0 THEN RAISE EXCEPTION 'season_settings still has % write policy(ies)', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'season_settings' AND cmd = 'SELECT'
       AND policyname = 'Season Settings: members access';
    IF v_n <> 1 THEN RAISE EXCEPTION 'season_settings lost its member read policy'; END IF;

    -- The job's season.
    SELECT count(*) INTO v_n FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.import_jobs'::regclass AND c.contype = 'f'
       AND a.attname = 'season_settings_id' AND c.confrelid = 'public.season_settings'::regclass
       AND c.confdeltype = 'c';
    IF v_n <> 1 THEN RAISE EXCEPTION 'import_jobs.season_settings_id is not a cascading reference to season_settings'; END IF;

    -- create_import_job: the old signature is gone, the new one is a definer for
    -- signed-in users, not anon, not PUBLIC.
    IF to_regprocedure('public.create_import_job(uuid,text,text)') IS NOT NULL THEN
        RAISE EXCEPTION 'the 3-argument create_import_job is still there';
    END IF;
    IF to_regprocedure('public.create_import_job(uuid,text,text,uuid)') IS NULL THEN
        RAISE EXCEPTION 'the 4-argument create_import_job is missing';
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.create_import_job(uuid,text,text,uuid)'::regprocedure)
       OR NOT has_function_privilege('authenticated', 'public.create_import_job(uuid,text,text,uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.create_import_job(uuid,text,text,uuid)', 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proacl) a
                   WHERE p.oid = 'public.create_import_job(uuid,text,text,uuid)'::regprocedure
                     AND a::text LIKE '=%') THEN
        RAISE EXCEPTION 'create_import_job(uuid,text,text,uuid) is not a definer granted to authenticated only';
    END IF;

    -- Each replaced body is the one this migration wrote.
    FOREACH v_sig IN ARRAY ARRAY[
        'public.finalize_import_job(uuid,jsonb)',
        'public.finalize_field_import_job(uuid,jsonb)'
    ] LOOP
        SELECT prosrc INTO v_def FROM pg_proc WHERE oid = v_sig::regprocedure;
        IF v_def !~ 'v_job\.season_settings_id IS NULL' OR v_def !~ 'season_completed'
           OR v_def ~ 'ORDER BY \(s\.status = ''active''\) DESC' THEN
            RAISE EXCEPTION '% does not read the job''s season', v_sig;
        END IF;
    END LOOP;
    SELECT prosrc INTO v_def FROM pg_proc
     WHERE oid = 'public.finalize_field_import_job(uuid,jsonb)'::regprocedure;
    IF v_def !~ 'public\.practice_slot_conflicts\(' OR v_def !~ 'd\.season_settings_id = v_import_season_id' THEN
        RAISE EXCEPTION 'finalize_field_import_job lost its practice division rules';
    END IF;
    FOREACH v_sig IN ARRAY ARRAY[
        'public.upsert_division_for_import(uuid,uuid,text,text,integer,integer,date,date)',
        'public.admin_upsert_division_settings(uuid,uuid,uuid,text,integer,integer,integer,integer,integer,integer,boolean)'
    ] LOOP
        SELECT prosrc INTO v_def FROM pg_proc WHERE oid = v_sig::regprocedure;
        IF v_def !~ 'season_completed' THEN RAISE EXCEPTION '% does not refuse a completed season', v_sig; END IF;
        IF v_def ~ 'timezone\(''utc''' THEN RAISE EXCEPTION '% still uses timezone(utc, now())', v_sig; END IF;
    END LOOP;
    -- All five stay definers with their search_path and zone pinned.
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.create_import_job(uuid,text,text,uuid)'::regprocedure,
                     'public.finalize_import_job(uuid,jsonb)'::regprocedure,
                     'public.finalize_field_import_job(uuid,jsonb)'::regprocedure,
                     'public.upsert_division_for_import(uuid,uuid,text,text,integer,integer,date,date)'::regprocedure,
                     'public.admin_upsert_division_settings(uuid,uuid,uuid,text,integer,integer,integer,integer,integer,integer,boolean)'::regprocedure)
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 5 THEN RAISE EXCEPTION 'only % of the 5 replaced functions are pinned definers closed to anon', v_n; END IF;
END;
$check$;

COMMIT;
