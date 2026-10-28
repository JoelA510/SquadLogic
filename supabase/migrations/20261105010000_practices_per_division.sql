-- Practices per division, and the practice writer's gate (Phase D, PR B; plan
-- docs/changes/2026-10-27-phase-d-scheduling.md, section B and the owner's answers of 2026-10-27;
-- the AGENTS.md rule 14 plan for this persistence change, approved by the owner).
--
-- **Why.** Every team got exactly one practice a week, because nothing said otherwise. A division
-- now says how many practices a week its teams get (0 to 7) and how long each is (15 to 240
-- minutes, or any slot length), and the auto-scheduler places that many, each on a different
-- weekday. The Edge function reads the two settings itself, as the caller through RLS, and the
-- writer below refuses the rows it can check, whichever path wrote them.
--
-- **The change.**
--   1. What it touches, counted in a NOTICE.
--   2. `divisions.practices_per_week smallint NOT NULL DEFAULT 1 CHECK (0..7)` and
--      `divisions.practice_minutes smallint NULL CHECK (15..240)`, NULL meaning any slot length.
--      Every existing division takes 1 and NULL, which is what the solver did before: a division at
--      1 a week with no length set schedules byte-identically (tests/autoSchedulerDatedSweep.test.js).
--      Production (read-only, 2026-10-27): 32 divisions, 0 teams, 0 practice assignments.
--   3. `admin_upsert_division_settings` gains `p_practices_per_week` and `p_practice_minutes`
--      (trailing, defaulted): NULL keeps the stored value, a new division takes 1 and NULL, and
--      `p_practice_minutes => 0` clears the length to "any slot length". Both are in the
--      `settings.updated` before and after. A value out of range is 23514, as the CHECK would say.
--      The old 11-argument signature is dropped by its exact name and arguments (no CASCADE) and the
--      13-argument one created from the latest body (20261101010000) with this change only, so every
--      call by name -- the app before it sends the new arguments, a cached browser mid-deploy -- still
--      resolves.
--   4. `practice_new_auto_row_refusals(organization, assignment ids)`: for the rows a save just
--      INSERTED as auto-scheduler placements, which rule each breaks. Read-only, SECURITY INVOKER.
--   5. `persist_practice_schedule` is replaced (behind its md5) and calls it after its upsert, before
--      anything else is written: a new row that is an `auto` placement (source auto AND assigned_via
--      auto) must keep
--        capacity    -- at no date does its slot hold more rows than its capacity;
--        reservation -- a slot reserved to a division (practice_slots.division_id) takes only that
--                       division's teams;
--        length      -- when the division sets a practice length, the slot is exactly that long;
--        weekday     -- no other row of the team is live on the same weekday on a shared date;
--        count       -- at no date does the team hold more live rows than its division's count.
--      A refusal is P0001, naming each row and rule, and the whole save rolls back. Manual, repair,
--      recommendation and override rows keep today's checks (the override prompt governs them), as
--      does a row the save only updates. **Declared, not enforced here:** coach overlap, coach
--      preferences and daylight (the Edge function's; the server-side verify of a later PR checks
--      them again), and "a division with a reserved slot uses only its reserved slots" (the solver's,
--      over the run's slots; the writer cannot know which slots a run held). Dates are read as the
--      solver reads them: a row is live weekly, on its slot's weekday, from the later of its range
--      start and the slot's `valid_from` to the earlier of its range end and `valid_until`; two rows
--      share a date when those weekly runs overlap on one weekday.
--   6. An end-state check.
--
-- **Production's bodies are not read from here.** The migration refuses to replace a function whose
-- text it has not seen (the md5 of `prosrc`, carriage returns stripped, below; read off a build of
-- the repository at 20261103020000 and equal to production's, read 2026-10-27). If a body differs it
-- stops before changing anything.
--
-- Every drop names its object, with no CASCADE. No DDL touches the auth or storage schemas.
--
-- Reversible in structure: docs/sql/20261105010000_revert.sql restores both bodies, drops the helper
-- and the two columns (it counts the divisions whose settings it loses). Smoke:
-- docs/sql/20261105010000_smoke.sql. pgTAP: supabase/tests/practices_per_division.sql and
-- practice_writer_v3.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting bodies are checked, and what changes is counted.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_expected constant jsonb := '{
        "persist_practice_schedule(jsonb,jsonb,boolean,jsonb,jsonb,jsonb,jsonb,text)": "2d3b68c192d881a153c1bec102779ea0",
        "admin_upsert_division_settings(uuid,uuid,uuid,text,integer,integer,integer,integer,integer,integer,boolean)": "fe36f0e26a724e81b7883e14e8dd2079"
    }';
    v_sig text;
    v_md5 text;
    v_divisions bigint;
    v_teams bigint;
    v_rows bigint;
BEGIN
    FOR v_sig IN SELECT jsonb_object_keys(v_expected) LOOP
        -- Carriage returns stripped: production stores some bodies with CRLF line ends.
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_sig);
        IF v_md5 IS DISTINCT FROM v_expected ->> v_sig THEN
            RAISE EXCEPTION 'public.% has a body this migration has not seen (md5 %, expected %): not replacing it',
                v_sig, v_md5, v_expected ->> v_sig;
        END IF;
    END LOOP;
    SELECT count(*) INTO v_divisions FROM public.divisions;
    SELECT count(*) INTO v_teams FROM public.teams;
    SELECT count(*) INTO v_rows FROM public.practice_assignments;
    RAISE NOTICE '% division(s) take 1 practice a week and any slot length; % team(s) and % practice row(s) are not changed',
        v_divisions, v_teams, v_rows;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The two settings.
-- ---------------------------------------------------------------------------

ALTER TABLE public.divisions
    ADD COLUMN practices_per_week smallint NOT NULL DEFAULT 1,
    ADD COLUMN practice_minutes smallint;
ALTER TABLE public.divisions
    ADD CONSTRAINT divisions_practices_per_week_range CHECK (practices_per_week BETWEEN 0 AND 7),
    ADD CONSTRAINT divisions_practice_minutes_range CHECK (practice_minutes IS NULL OR practice_minutes BETWEEN 15 AND 240);

COMMENT ON COLUMN public.divisions.practices_per_week IS
    'How many practices a week each team of the division gets (0 to 7), each on a different weekday. 1 until set. 20261105010000.';
COMMENT ON COLUMN public.divisions.practice_minutes IS
    'How long each practice is, in minutes (15 to 240): a practice takes a slot of exactly this length. NULL: any slot length. 20261105010000.';

-- ---------------------------------------------------------------------------
-- 3. Which rule a new auto row breaks.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.practice_new_auto_row_refusals(p_organization_id uuid, p_assignment_ids uuid[])
 RETURNS TABLE (assignment_id uuid, team_id uuid, practice_slot_id uuid, rule text, detail text)
 LANGUAGE sql
 STABLE
 SECURITY INVOKER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
    WITH scoped AS (
        -- Every row of a judged row's slot or team, as the table stands after the save.
        SELECT pa.id, pa.team_id, pa.practice_slot_id,
               pa.effective_date_range AS rng,
               ps.day_of_week, ps.start_time, ps.end_time, ps.capacity, ps.valid_from, ps.valid_until,
               ps.division_id AS slot_division, t.division_id AS team_division,
               array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun']::public.day_of_week[], ps.day_of_week) AS dow
          FROM public.practice_assignments pa
          JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
          JOIN public.teams t ON t.id = pa.team_id
         WHERE pa.organization_id = p_organization_id
           AND pa.practice_slot_id IS NOT NULL
           AND pa.effective_date_range IS NOT NULL
           AND (pa.id = ANY (p_assignment_ids)
                OR pa.team_id IN (SELECT j.team_id FROM public.practice_assignments j WHERE j.id = ANY (p_assignment_ids))
                OR pa.practice_slot_id IN (SELECT j.practice_slot_id FROM public.practice_assignments j WHERE j.id = ANY (p_assignment_ids)))
    ), bounded AS (
        -- The weekly dates a row is live on run from the first to the last date on its weekday
        -- inside [lo, hi]: its range, cut to the slot's validity. A run unbounded at the top is
        -- read as a year.
        SELECT s.*,
               GREATEST(lower(s.rng), s.valid_from) AS lo,
               COALESCE(LEAST(upper(s.rng) - 1, s.valid_until),
                        GREATEST(lower(s.rng), s.valid_from) + 366) AS hi
          FROM scoped s
    ), dated AS (
        SELECT b.id, b.team_id, b.practice_slot_id, b.day_of_week, b.start_time, b.end_time,
               b.capacity, b.slot_division, b.team_division,
               b.lo + ((b.dow - extract(isodow FROM b.lo)::int + 7) % 7) AS first_day,
               b.hi - ((extract(isodow FROM b.hi)::int - b.dow + 7) % 7) AS last_day
          FROM bounded b
         WHERE b.lo IS NOT NULL
    ), live AS (
        -- A row with no date on its weekday inside [lo, hi] holds nothing.
        SELECT x.* FROM dated x WHERE x.first_day <= x.last_day
    ), judged AS (
        SELECT l.*, d.practices_per_week, d.practice_minutes
          FROM live l
          JOIN public.divisions d ON d.id = l.team_division
         WHERE l.id = ANY (p_assignment_ids)
    )
    SELECT j.id, j.team_id, j.practice_slot_id, 'capacity'::text,
           format('the slot holds %s at once, its capacity is %s', pk.peak, COALESCE(j.capacity, 1))
      FROM judged j
     CROSS JOIN LATERAL (
         SELECT max(q.n) AS peak
           FROM (SELECT (SELECT count(*) FROM live o
                          WHERE o.practice_slot_id = j.practice_slot_id
                            AND o.first_day <= p.first_day AND p.first_day <= o.last_day) AS n
                   FROM live p
                  WHERE p.practice_slot_id = j.practice_slot_id
                    AND p.first_day BETWEEN j.first_day AND j.last_day) q) pk
     WHERE pk.peak > COALESCE(j.capacity, 1)
    UNION ALL
    SELECT j.id, j.team_id, j.practice_slot_id, 'reservation'::text,
           format('the slot is reserved to division %s, the team is in %s', j.slot_division, j.team_division)
      FROM judged j
     WHERE j.slot_division IS NOT NULL AND j.slot_division IS DISTINCT FROM j.team_division
    UNION ALL
    SELECT j.id, j.team_id, j.practice_slot_id, 'length'::text,
           format('the slot is %s minutes, the division''s practice is %s',
                  (extract(epoch FROM (j.end_time - j.start_time)) / 60)::int, j.practice_minutes)
      FROM judged j
     WHERE j.practice_minutes IS NOT NULL
       AND (j.end_time - j.start_time) <> make_interval(mins => j.practice_minutes)
    UNION ALL
    SELECT j.id, j.team_id, j.practice_slot_id, 'weekday'::text,
           format('the team already has row %s on the same weekday on a shared date', o.id)
      FROM judged j
      JOIN live o
        ON o.team_id = j.team_id AND o.id <> j.id AND o.day_of_week = j.day_of_week
       AND o.first_day <= j.last_day AND j.first_day <= o.last_day
    UNION ALL
    SELECT j.id, j.team_id, j.practice_slot_id, 'count'::text,
           format('the team holds %s practices at once, its division''s count is %s', pk.peak, j.practices_per_week)
      FROM judged j
     CROSS JOIN LATERAL (
         SELECT max(q.n) AS peak
           FROM (SELECT (SELECT count(*) FROM live o
                          WHERE o.team_id = j.team_id
                            AND o.first_day <= p.first_day AND p.first_day <= o.last_day) AS n
                   FROM live p
                  WHERE p.team_id = j.team_id
                    AND p.first_day BETWEEN j.first_day AND j.last_day) q) pk
     WHERE pk.peak > j.practices_per_week;
$function$;

REVOKE ALL ON FUNCTION public.practice_new_auto_row_refusals(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.practice_new_auto_row_refusals(uuid, uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.practice_new_auto_row_refusals(uuid, uuid[]) IS
    'For practice rows a save just inserted as auto placements: which rule each breaks (capacity, reservation, length, weekday, count). Read by persist_practice_schedule; 20261105010000.';

-- ---------------------------------------------------------------------------
-- 4. persist_practice_schedule: the 20261002000000 body, restated with the gate (and now()).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.persist_practice_schedule(run_data jsonb, assignments jsonb, allow_empty boolean DEFAULT false, unlock jsonb DEFAULT '[]'::jsonb, closes jsonb DEFAULT '[]'::jsonb, exceptions jsonb DEFAULT '[]'::jsonb, withdraw_exceptions jsonb DEFAULT '[]'::jsonb, base_fingerprint text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
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
    v_effective_role text;
    v_missing_team_count integer;
    v_missing_slot_count integer;
    v_missing_range_count integer;
    v_invalid_source_count integer;
    v_invalid_via_count integer;
    v_missing_team_ref uuid;
    v_cross_team_ref uuid;
    v_missing_slot_ref uuid;
    v_cross_slot_ref uuid;
    v_removed jsonb;
    v_retained jsonb;
    v_row jsonb;
    v_audited boolean := false;
    v_updated integer;
    v_prior_results jsonb;
    v_payload_teams uuid[];
    v_teams_with_prior uuid[];
    v_season_team_count integer;
    v_without_practice jsonb;
    -- v3
    v_arg text;
    v_arg_value jsonb;
    v_unlock_ids uuid[];
    v_close_ids uuid[];
    v_withdraw_ids uuid[];
    v_withdraw_assignment_ids uuid[];
    v_prune_ids uuid[];
    v_replaced_ids uuid[];
    v_bad_id uuid;
    v_bad_why text;
    v_locked_id uuid;
    v_locked_why text;
    v_overlap_id uuid;
    v_fingerprint text;
    v_unlocked jsonb := '[]'::jsonb;
    v_closed jsonb := '[]'::jsonb;
    v_withdrawn jsonb := '[]'::jsonb;
    v_superseded_exceptions jsonb := '[]'::jsonb;
    v_recorded jsonb := '[]'::jsonb;
    v_time_tbd jsonb;
    -- 8.9 PR 6b
    v_bad_ref jsonb;
    -- 20261105010000: the writer gate for new auto rows
    v_new_auto_ids uuid[];
    v_refusal_text text;
    v_refusal_rows integer;
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

    -- v3: the four repair arguments are arrays of objects, like `assignments`.
    unlock := COALESCE(unlock, '[]'::jsonb);
    closes := COALESCE(closes, '[]'::jsonb);
    exceptions := COALESCE(exceptions, '[]'::jsonb);
    withdraw_exceptions := COALESCE(withdraw_exceptions, '[]'::jsonb);
    FOR v_arg, v_arg_value IN
        SELECT a.n, a.v FROM (VALUES ('unlock', unlock), ('closes', closes),
                                     ('exceptions', exceptions),
                                     ('withdraw_exceptions', withdraw_exceptions)) AS a(n, v)
    LOOP
        IF jsonb_typeof(v_arg_value) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION '% must be a JSON array of objects', v_arg
                USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_arg_value) e
                    WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object') THEN
            RAISE EXCEPTION '% must be a JSON array of objects', v_arg
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    v_run_type := COALESCE(NULLIF(run_data->>'run_type', ''), 'practice');
    IF v_run_type <> 'practice' THEN
        RAISE EXCEPTION 'persist_practice_schedule only accepts practice runs'
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

    v_run_id := COALESCE(NULLIF(run_data->>'id', '')::uuid, gen_random_uuid());
    v_org_id := NULLIF(run_data->>'organization_id', '')::uuid;
    v_season_settings_id := NULLIF(run_data->>'season_settings_id', '')::uuid;
    v_season_id := COALESCE(NULLIF(run_data->>'season_id', '')::uuid, v_season_settings_id);
    v_effective_role := COALESCE(auth.role(), current_role, '');

    IF v_org_id IS NOT NULL
       AND v_effective_role <> 'service_role'
       AND NOT public.is_org_member(v_org_id) THEN
        RAISE EXCEPTION 'caller is not a member of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    IF v_season_settings_id IS NOT NULL
       AND v_season_id IS NOT NULL
       AND v_season_settings_id <> v_season_id THEN
        RAISE EXCEPTION 'season_id must match season_settings_id for practice persistence'
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

    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_member(v_org_id) THEN
        RAISE EXCEPTION 'caller is not a member of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- v3: the override prompt is admin-only and audited (plan §3). Its own
    -- gate, BEFORE the general admin check below and with its own message,
    -- so it holds even for a caller that check exempts: a service-role caller
    -- has no uid to audit, so it cannot unlock at all -- and with nothing
    -- unlocked it can neither prune, close nor withdraw.
    IF jsonb_array_length(unlock) > 0
       AND (auth.uid() IS NULL OR NOT public.is_org_admin(v_org_id)) THEN
        RAISE EXCEPTION 'unlock requires an org admin with a uid to audit: % assignment(s) named', jsonb_array_length(unlock)
            USING ERRCODE = '42501';
    END IF;

    -- #64: the prune below removes rows, so the caller must be able to remove
    -- them. `practice_assignments_write_admin` already limits every write to
    -- org admins; saying so here turns a silent zero-row DELETE into a refusal.
    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- #64: the prune is scoped to one season. Without one there is no scope,
    -- and guessing one is how another season's schedule would be deleted.
    IF v_season_id IS NULL THEN
        RAISE EXCEPTION 'season_settings_id is required: a practice schedule replaces one season''s schedule'
            USING ERRCODE = '23502';
    END IF;

    -- #64: an empty payload would supersede every auto row in the season. That
    -- is a legitimate request only when the caller says so.
    IF jsonb_array_length(assignments) = 0 AND NOT COALESCE(allow_empty, false) THEN
        RAISE EXCEPTION 'refusing an empty practice schedule: it would remove every auto assignment in season %; pass allow_empty => true to mean it', v_season_id
            USING ERRCODE = '22023';
    END IF;

    -- #64: two saves of the same season must not interleave their prune and
    -- upsert, or each keeps rows the other superseded.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('persist_practice_schedule:' || v_org_id::text || ':' || v_season_id::text, 0)
    );

    -- v3: optimistic concurrency. Read under the season lock, so nothing can
    -- change between this comparison and the writes below.
    v_fingerprint := public.practice_schedule_fingerprint(v_season_id);
    IF base_fingerprint IS NOT NULL AND base_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'season % changed since this plan was read (fingerprint % is now %); reload and re-plan', v_season_id, base_fingerprint, v_fingerprint
            USING ERRCODE = '40001';
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

    IF v_effective_role = 'service_role' THEN
        BEGIN
            v_created_by := NULLIF(run_data->>'created_by', '')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            v_created_by := NULL;
        END;
    ELSE
        v_created_by := auth.uid();
    END IF;

    v_started_at := COALESCE(NULLIF(run_data->>'started_at', '')::timestamptz, now());
    v_completed_at := COALESCE(NULLIF(run_data->>'completed_at', '')::timestamptz, now());

    -- #64: the upsert below replaces `results`, so a re-save under the same
    -- run id would erase the before-images an earlier save of it recorded --
    -- for a service-role caller, the only record of those rows. Read them first.
    SELECT sr.results
      INTO v_prior_results
      FROM public.scheduler_runs sr
     WHERE sr.id = v_run_id
       AND sr.organization_id = v_org_id;

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
        'practice',
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
            NULLIF(raw_assignments.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(raw_assignments.practice_slot_id, '')::uuid,
                NULLIF(raw_assignments.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(raw_assignments.effective_date_range, '')::daterange AS effective_date_range,
            CASE
                WHEN lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto'))
            END AS source,
            NULLIF(raw_assignments.assigned_via, '') AS assigned_via
        FROM jsonb_to_recordset(assignments) AS raw_assignments(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text,
            source text,
            assigned_via text
        )
    ),
    validated_assignments AS (
        SELECT
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source,
            parsed_assignments.assigned_via,
            t.id AS existing_team_id,
            t.organization_id AS team_org_id,
            ps.id AS existing_slot_id,
            ps.organization_id AS slot_org_id
        FROM parsed_assignments
        LEFT JOIN public.teams t
          ON t.id = parsed_assignments.team_id
        LEFT JOIN public.practice_slots ps
          ON ps.id = parsed_assignments.practice_slot_id
    ),
    validation_summary AS (
        SELECT
            count(*) FILTER (WHERE team_id IS NULL) AS missing_team_count,
            count(*) FILTER (WHERE practice_slot_id IS NULL) AS missing_slot_count,
            count(*) FILTER (WHERE effective_date_range IS NULL) AS missing_range_count,
            count(*) FILTER (WHERE source NOT IN ('auto', 'manual')) AS invalid_source_count,
            count(*) FILTER (
                WHERE assigned_via IS NOT NULL
                  AND assigned_via NOT IN ('auto', 'manual', 'repair', 'recommendation', 'override')
            ) AS invalid_via_count,
            (
                array_agg(team_id)
                    FILTER (WHERE team_id IS NOT NULL AND existing_team_id IS NULL)
            )[1] AS missing_team_ref,
            (
                array_agg(team_id)
                    FILTER (
                        WHERE existing_team_id IS NOT NULL
                          AND team_org_id <> v_org_id
                    )
            )[1] AS cross_team_ref,
            (
                array_agg(practice_slot_id)
                    FILTER (
                        WHERE practice_slot_id IS NOT NULL
                          AND existing_slot_id IS NULL
                    )
            )[1] AS missing_slot_ref,
            (
                array_agg(practice_slot_id)
                    FILTER (
                        WHERE existing_slot_id IS NOT NULL
                          AND slot_org_id <> v_org_id
                    )
            )[1] AS cross_slot_ref
        FROM validated_assignments
    )
    SELECT
        missing_team_count,
        missing_slot_count,
        missing_range_count,
        invalid_source_count,
        invalid_via_count,
        missing_team_ref,
        cross_team_ref,
        missing_slot_ref,
        cross_slot_ref
      INTO
        v_missing_team_count,
        v_missing_slot_count,
        v_missing_range_count,
        v_invalid_source_count,
        v_invalid_via_count,
        v_missing_team_ref,
        v_cross_team_ref,
        v_missing_slot_ref,
        v_cross_slot_ref
      FROM validation_summary;

    IF v_missing_team_count > 0 THEN
        RAISE EXCEPTION 'assignment team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_slot_count > 0 THEN
        RAISE EXCEPTION 'assignment practice_slot_id or slot_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_range_count > 0 THEN
        RAISE EXCEPTION 'assignment effective_date_range is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_invalid_source_count > 0 THEN
        RAISE EXCEPTION 'invalid practice assignment source'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_via_count > 0 THEN
        RAISE EXCEPTION 'invalid practice assignment assigned_via'
            USING ERRCODE = '22023';
    END IF;

    IF v_missing_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_id % does not exist', v_missing_team_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_cross_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_id % belongs to another organization', v_cross_team_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_missing_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'practice_slot_id % does not exist', v_missing_slot_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_cross_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'practice_slot_id % belongs to another organization', v_cross_slot_ref
            USING ERRCODE = '42501';
    END IF;

    -- -----------------------------------------------------------------------
    -- 8.9 PR 6b: an exception names its row by `assignment_id` (a row that
    -- exists) OR by `new_assignment` (a (team, slot, range) key this save's
    -- `assignments` carries, resolved to its row after the insert below) --
    -- exactly one of the two. A key the payload does not carry would resolve
    -- to nothing, or to a row this save did not place.
    -- -----------------------------------------------------------------------
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(exceptions) e
                WHERE e.value ? 'new_assignment' AND e.value ? 'assignment_id') THEN
        RAISE EXCEPTION 'an exceptions entry names both assignment_id and new_assignment; name its row once'
            USING ERRCODE = '22023';
    END IF;
    SELECT e.value->'new_assignment'
      INTO v_bad_ref
      FROM jsonb_array_elements(exceptions) e
     WHERE e.value ? 'new_assignment'
       AND (jsonb_typeof(e.value->'new_assignment') IS DISTINCT FROM 'object'
            OR NOT EXISTS (
                SELECT 1
                  FROM jsonb_to_recordset(assignments) AS p(
                      team_id text,
                      practice_slot_id text,
                      slot_id text,
                      effective_date_range text
                  )
                 WHERE NULLIF(p.team_id, '')::uuid
                           = NULLIF(e.value#>>'{new_assignment,team_id}', '')::uuid
                   AND COALESCE(NULLIF(p.practice_slot_id, '')::uuid, NULLIF(p.slot_id, '')::uuid)
                           = NULLIF(e.value#>>'{new_assignment,practice_slot_id}', '')::uuid
                   AND NULLIF(p.effective_date_range, '')::daterange
                           = NULLIF(e.value#>>'{new_assignment,effective_date_range}', '')::daterange))
     LIMIT 1;
    IF v_bad_ref IS NOT NULL THEN
        RAISE EXCEPTION 'exceptions names new_assignment %, which is not a (team, slot, range) key this save''s assignments carry', v_bad_ref
            USING ERRCODE = '22023';
    END IF;
    -- The `assignment_id` path's season scope (42501, below), adopted: a
    -- new row named here must belong to a team of THIS season.
    SELECT e.value->'new_assignment'
      INTO v_bad_ref
      FROM jsonb_array_elements(exceptions) e
     WHERE e.value ? 'new_assignment'
       AND NOT EXISTS (
            SELECT 1
              FROM public.teams t
              JOIN public.divisions d ON d.id = t.division_id
             WHERE t.id = NULLIF(e.value#>>'{new_assignment,team_id}', '')::uuid
               AND t.organization_id = v_org_id
               AND d.season_settings_id = v_season_id)
     LIMIT 1;
    IF v_bad_ref IS NOT NULL THEN
        RAISE EXCEPTION 'exceptions names new_assignment %, whose team is not a team of season %', v_bad_ref, v_season_id
            USING ERRCODE = '42501';
    END IF;

    -- -----------------------------------------------------------------------
    -- v3: every assignment id the repair arguments name must be a row of THIS
    -- season. One that exists elsewhere is 42501, whatever the argument: a
    -- save of one season must not unlock, close or annotate another's rows.
    -- (An exception naming a `new_assignment` is judged above instead.)
    -- -----------------------------------------------------------------------
    SELECT x.id, x.arg
      INTO v_bad_id, v_bad_why
      FROM (
            SELECT NULLIF(u.value->>'assignment_id', '')::uuid AS id, 'unlock' AS arg
              FROM jsonb_array_elements(unlock) u
            UNION ALL
            SELECT NULLIF(c.value->>'assignment_id', '')::uuid, 'closes'
              FROM jsonb_array_elements(closes) c
            UNION ALL
            SELECT NULLIF(e.value->>'assignment_id', '')::uuid, 'exceptions'
              FROM jsonb_array_elements(exceptions) e
             WHERE NOT (e.value ? 'new_assignment')
           ) x
     WHERE x.id IS NULL
        OR NOT EXISTS (
            SELECT 1
              FROM public.practice_assignments pa
              JOIN public.teams t ON t.id = pa.team_id
              JOIN public.divisions d ON d.id = t.division_id
             WHERE pa.id = x.id
               AND pa.organization_id = v_org_id
               AND d.season_settings_id = v_season_id)
     LIMIT 1;
    IF v_bad_why IS NOT NULL THEN
        IF v_bad_id IS NULL THEN
            RAISE EXCEPTION '% entry has no assignment_id', v_bad_why
                USING ERRCODE = '23502';
        ELSIF EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.id = v_bad_id) THEN
            RAISE EXCEPTION '% names assignment %, which is not a row of season %', v_bad_why, v_bad_id, v_season_id
                USING ERRCODE = '42501';
        ELSE
            RAISE EXCEPTION '% names assignment %, which does not exist', v_bad_why, v_bad_id
                USING ERRCODE = '23503';
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(unlock) u
                WHERE length(btrim(COALESCE(u.value->>'reason', ''))) = 0) THEN
        RAISE EXCEPTION 'every unlock entry needs a reason'
            USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT (u.value->>'assignment_id')::uuid), '{}'::uuid[])
      INTO v_unlock_ids
      FROM jsonb_array_elements(unlock) u;
    SELECT COALESCE(array_agg(DISTINCT (c.value->>'assignment_id')::uuid), '{}'::uuid[])
      INTO v_close_ids
      FROM jsonb_array_elements(closes) c;

    IF jsonb_array_length(closes) <> cardinality(v_close_ids) THEN
        RAISE EXCEPTION 'closes names an assignment more than once'
            USING ERRCODE = '22023';
    END IF;
    -- A close must SHORTEN the row and leave it non-empty: last_day inside it.
    SELECT (c.value->>'assignment_id')::uuid
      INTO v_bad_id
      FROM jsonb_array_elements(closes) c
      JOIN public.practice_assignments pa ON pa.id = (c.value->>'assignment_id')::uuid
     WHERE NULLIF(c.value->>'last_day', '') IS NULL
        OR (c.value->>'last_day')::date < lower(pa.effective_date_range)
        OR NOT (upper_inf(pa.effective_date_range)
                OR (c.value->>'last_day')::date + 1 < upper(pa.effective_date_range))
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'closes: last_day for assignment % must fall inside its range and shorten it', v_bad_id
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(withdraw_exceptions) w
                WHERE NULLIF(w.value->>'exception_id', '') IS NULL) THEN
        RAISE EXCEPTION 'withdraw_exceptions entry has no exception_id'
            USING ERRCODE = '23502';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT (w.value->>'exception_id')::uuid), '{}'::uuid[])
      INTO v_withdraw_ids
      FROM jsonb_array_elements(withdraw_exceptions) w;
    SELECT x.id INTO v_bad_id
      FROM unnest(v_withdraw_ids) AS x(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe
                        WHERE pe.id = x.id AND pe.organization_id = v_org_id
                          AND pe.season_settings_id = v_season_id AND pe.withdrawn_at IS NULL)
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'withdraw_exceptions names %, which is not a live exception of season %', v_bad_id, v_season_id
            USING ERRCODE = '42501';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT pe.assignment_id), '{}'::uuid[])
      INTO v_withdraw_assignment_ids
      FROM public.practice_exceptions pe
     WHERE pe.id = ANY (v_withdraw_ids);

    -- #64: which of the season's teams held a practice BEFORE this save, for
    -- `teams_without_practice.had_prior_rows` below.
    SELECT COALESCE(array_agg(DISTINCT pa.team_id), '{}'::uuid[])
      INTO v_teams_with_prior
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- #64's prune set, computed rather than executed: v3 must refuse before
    -- it deletes anything. Scope is the season's teams, and only those.
    --   * a team IN the payload: every prior row whose (team, slot, range) key
    --     the payload does not carry -- unless `closes` names it, which keeps
    --     it by id with a shorter range;
    --   * a team in scope but ABSENT from the payload: its `auto` rows; its
    --     `manual` rows are kept and reported, as in #444.
    WITH payload AS MATERIALIZED (
        SELECT DISTINCT
            NULLIF(p.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(p.practice_slot_id, '')::uuid,
                NULLIF(p.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(p.effective_date_range, '')::daterange AS effective_date_range
        FROM jsonb_to_recordset(assignments) AS p(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text
        )
    ),
    scope AS (
        SELECT
            t.id AS team_id,
            EXISTS (SELECT 1 FROM payload k WHERE k.team_id = t.id) AS in_payload
        FROM public.teams t
        JOIN public.divisions d
          ON d.id = t.division_id
         AND d.organization_id = v_org_id
         AND d.season_settings_id = v_season_id
        WHERE t.organization_id = v_org_id
    ),
    prunable AS (
        SELECT pa.id, s.in_payload
          FROM public.practice_assignments pa
          JOIN scope s ON s.team_id = pa.team_id
         WHERE pa.organization_id = v_org_id
           AND NOT (pa.id = ANY (v_close_ids))
           AND (
               (
                   s.in_payload
                   AND NOT EXISTS (
                       SELECT 1
                         FROM payload k
                        WHERE k.team_id = pa.team_id
                          AND k.practice_slot_id = pa.practice_slot_id
                          AND k.effective_date_range = pa.effective_date_range
                   )
               )
               OR (NOT s.in_payload AND pa.source = 'auto')
           )
    )
    SELECT COALESCE(array_agg(prunable.id), '{}'::uuid[]),
           COALESCE(array_agg(prunable.id) FILTER (WHERE prunable.in_payload), '{}'::uuid[])
      INTO v_prune_ids, v_replaced_ids
      FROM prunable;

    -- -----------------------------------------------------------------------
    -- v3: THE LOCK. Every existing row this call would delete, re-range or
    -- move must be named in `unlock`, by its own id.
    -- -----------------------------------------------------------------------
    SELECT t.id, t.why
      INTO v_locked_id, v_locked_why
      FROM (
            SELECT p.id,
                   CASE WHEN p.id = ANY (v_replaced_ids)
                        THEN 'the payload no longer carries its (team, slot, range) key'
                        ELSE 'it is an auto row of a season team absent from the payload' END AS why
              FROM unnest(v_prune_ids) AS p(id)
            UNION ALL
            SELECT c.id, 'closes re-ranges it' FROM unnest(v_close_ids) AS c(id)
            UNION ALL
            SELECT w.id, 'an exception on it is withdrawn' FROM unnest(v_withdraw_assignment_ids) AS w(id)
           ) t
     WHERE NOT (t.id = ANY (v_unlock_ids))
     ORDER BY t.id
     LIMIT 1;
    IF v_locked_id IS NOT NULL THEN
        RAISE EXCEPTION 'assignment % is locked: % -- list it in unlock, with a reason, to change it', v_locked_id, v_locked_why
            USING ERRCODE = '22023';
    END IF;

    -- An exception on a series this same save prunes would have nothing to
    -- attach to after the prune, and would vanish without a word.
    SELECT (e.value->>'assignment_id')::uuid INTO v_bad_id
      FROM jsonb_array_elements(exceptions) e
     WHERE (e.value->>'assignment_id')::uuid = ANY (v_prune_ids)
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'exceptions names assignment %, which this save removes', v_bad_id
            USING ERRCODE = '22023';
    END IF;

    -- The override prompt was accepted: one audit row per unlocked
    -- assignment, carrying the row as it stood before this save touched it.
    -- The gate above guarantees a uid whenever this list is non-empty.
    SELECT COALESCE(jsonb_agg(to_jsonb(pa.*) ORDER BY pa.id), '[]'::jsonb)
      INTO v_unlocked
      FROM public.practice_assignments pa
     WHERE pa.id = ANY (v_unlock_ids);
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_unlocked) LOOP
        PERFORM public.record_audit_event(
            v_org_id,
            'practice.unlock_accepted',
            'practice_assignment',
            (v_row->>'id')::uuid,
            jsonb_build_object(
                'run_id', v_run_id,
                'season_settings_id', v_season_id,
                'reason', (SELECT u.value->>'reason' FROM jsonb_array_elements(unlock) u
                            WHERE (u.value->>'assignment_id')::uuid = (v_row->>'id')::uuid LIMIT 1),
                'before', v_row
            )
        );
    END LOOP;

    -- Withdrawals (their assignments are unlocked, checked above).
    WITH w AS (
        UPDATE public.practice_exceptions pe
           SET withdrawn_at = now(),
               withdrawn_by = auth.uid()
         WHERE pe.id = ANY (v_withdraw_ids)
           AND pe.withdrawn_at IS NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(w.*) ORDER BY w.id), '[]'::jsonb)
      INTO v_withdrawn
      FROM w;

    -- Closes: shorten in place; the id survives (plan §3, retirement split).
    WITH pre AS (
        SELECT pa.*, (c.value->>'last_day')::date AS last_day
          FROM jsonb_array_elements(closes) c
          JOIN public.practice_assignments pa ON pa.id = (c.value->>'assignment_id')::uuid
    ),
    upd AS (
        UPDATE public.practice_assignments pa
           SET effective_date_range = daterange(lower(pa.effective_date_range), b.last_day + 1, '[)'),
               updated_at = now()
          FROM pre b
         WHERE pa.id = b.id
        RETURNING pa.id, pa.effective_date_range
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', upd.id,
               'before', to_jsonb(b.*) - 'last_day',
               'effective_date_range', upd.effective_date_range::text)
             ORDER BY upd.id), '[]'::jsonb)
      INTO v_closed
      FROM upd JOIN pre b ON b.id = upd.id;

    -- The unlocked prune. A WITHDRAWN exception no longer overrides anything,
    -- so it is archived onto this run and removed with its series; a LIVE one
    -- is left for the RESTRICT foreign key to refuse (23503): deleting an
    -- overridden series is never silent.
    WITH gone AS (
        DELETE FROM public.practice_exceptions pe
         WHERE pe.assignment_id = ANY (v_prune_ids)
           AND pe.withdrawn_at IS NOT NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(gone.*) ORDER BY gone.id), '[]'::jsonb)
      INTO v_superseded_exceptions
      FROM gone;

    WITH removed AS (
        DELETE FROM public.practice_assignments pa
         WHERE pa.id = ANY (v_prune_ids)
           AND pa.organization_id = v_org_id
        RETURNING pa.*,
            CASE WHEN pa.id = ANY (v_replaced_ids) THEN 'replaced' ELSE 'team_not_in_schedule' END
                AS superseded_reason
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(removed) ORDER BY removed.team_id, removed.id), '[]'::jsonb)
      INTO v_removed
      FROM removed;

    -- What the prune deliberately kept: rows of in-season teams the payload
    -- does not mention and whose source is not `auto`. Reported, not deleted.
    SELECT COALESCE(array_agg(DISTINCT NULLIF(p.team_id, '')::uuid), '{}'::uuid[])
      INTO v_payload_teams
      FROM jsonb_to_recordset(assignments) AS p(team_id text);

    SELECT COALESCE(
               jsonb_agg(to_jsonb(pa.*) ORDER BY pa.team_id, pa.id),
               '[]'::jsonb
           )
      INTO v_retained
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.organization_id = v_org_id
       AND d.season_settings_id = v_season_id
       AND pa.team_id <> ALL (v_payload_teams);

    -- v3: a NEW key must not double-book its team. An addition removes
    -- nothing -- the rows the team holds stay protected by the delete,
    -- re-range and move locks above -- so the only harm it can do is a clash:
    -- a row the team still holds whose date range overlaps the new key's AND
    -- whose slot falls on the same weekday at overlapping minutes. A second
    -- weekday, or the same weekday at another time, is allowed (the corpus's
    -- normal two-weekday shape). Checked after closes and the prune, so an
    -- unlocked row that is removed or shortened makes room.
    WITH payload AS (
        SELECT DISTINCT
            NULLIF(p.team_id, '')::uuid AS team_id,
            COALESCE(NULLIF(p.practice_slot_id, '')::uuid, NULLIF(p.slot_id, '')::uuid) AS practice_slot_id,
            NULLIF(p.effective_date_range, '')::daterange AS effective_date_range
        FROM jsonb_to_recordset(assignments) AS p(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text
        )
    )
    SELECT pa.id
      INTO v_overlap_id
      FROM payload k
      JOIN public.practice_slots ks
        ON ks.id = k.practice_slot_id
      JOIN public.practice_assignments pa
        ON pa.team_id = k.team_id
       AND pa.effective_date_range && k.effective_date_range
      JOIN public.practice_slots ps
        ON ps.id = pa.practice_slot_id
     WHERE ps.day_of_week = ks.day_of_week
       AND ps.start_time < ks.end_time
       AND ks.start_time < ps.end_time
       AND NOT EXISTS (
               SELECT 1
                 FROM public.practice_assignments e
                WHERE e.team_id = k.team_id
                  AND e.practice_slot_id = k.practice_slot_id
                  AND e.effective_date_range = k.effective_date_range)
     ORDER BY pa.id
     LIMIT 1;
    IF v_overlap_id IS NOT NULL THEN
        RAISE EXCEPTION 'assignment % is locked: a new row for its team overlaps it in time -- unlock and remove or close it first', v_overlap_id
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_assignments AS (
        SELECT
            NULLIF(raw_assignments.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(raw_assignments.practice_slot_id, '')::uuid,
                NULLIF(raw_assignments.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(raw_assignments.effective_date_range, '')::daterange AS effective_date_range,
            CASE
                WHEN lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto'))
            END AS source,
            NULLIF(raw_assignments.assigned_via, '') AS assigned_via
        FROM jsonb_to_recordset(assignments) AS raw_assignments(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text,
            source text,
            assigned_via text
        )
    ),
    org_scoped_assignments AS (
        SELECT DISTINCT ON (
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range
        )
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source,
            COALESCE(
                parsed_assignments.assigned_via,
                CASE WHEN parsed_assignments.source = 'manual' THEN 'manual' ELSE 'auto' END
            ) AS assigned_via,
            ps.day_of_week::text AS day_of_week,
            ps.start_time::text AS start_time,
            ps.end_time::text AS end_time,
            ps.field_id
        FROM parsed_assignments
        JOIN public.teams t
          ON t.id = parsed_assignments.team_id
         AND t.organization_id = v_org_id
        JOIN public.practice_slots ps
          ON ps.id = parsed_assignments.practice_slot_id
         AND ps.organization_id = v_org_id
        ORDER BY
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source DESC
    ),
    ins AS (
    INSERT INTO public.practice_assignments (
        organization_id,
        run_id,
        team_id,
        slot_id,
        practice_slot_id,
        day_of_week,
        start_time,
        end_time,
        field_id,
        effective_date_range,
        source,
        assigned_via
    )
    SELECT
        v_org_id,
        v_run_id,
        team_id,
        practice_slot_id,
        practice_slot_id,
        day_of_week,
        start_time,
        end_time,
        field_id,
        effective_date_range,
        source::source_enum,
        assigned_via
    FROM org_scoped_assignments
    ON CONFLICT (team_id, practice_slot_id, effective_date_range)
        WHERE practice_slot_id IS NOT NULL
          AND effective_date_range IS NOT NULL
    DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        run_id = EXCLUDED.run_id,
        slot_id = EXCLUDED.slot_id,
        day_of_week = EXCLUDED.day_of_week,
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        field_id = EXCLUDED.field_id,
        source = EXCLUDED.source,
        updated_at = now()
    RETURNING id, source, assigned_via, (xmax = 0) AS inserted
    )
    SELECT COALESCE(
               array_agg(ins.id ORDER BY ins.id)
                   FILTER (WHERE ins.inserted AND ins.source = 'auto' AND ins.assigned_via = 'auto'),
               '{}'::uuid[])
      INTO v_new_auto_ids
      FROM ins;
    -- (assigned_via is provenance: an existing row keeps the one it was
    -- placed with.)

    -- 20261105010000: THE WRITER GATE. A row this save INSERTED as an auto-scheduler
    -- placement must keep the rules the solver keeps and SQL can check -- slot capacity,
    -- the slot's division reservation, the division's practice length, a different
    -- weekday for each of a team's practices, and no more practices at once than the
    -- division's count. Judged on the table as this save leaves it, so a row removed or
    -- shortened by an unlock makes room. Manual, repair, recommendation and override rows,
    -- and a row that already existed, keep today's checks. Coach overlap, preferences and
    -- daylight stay the Edge function's (declared). The whole save rolls back.
    IF cardinality(v_new_auto_ids) > 0 THEN
        SELECT count(DISTINCT r.assignment_id),
               string_agg(
                   format('%s (team %s, slot %s): %s, %s', r.assignment_id, r.team_id,
                          r.practice_slot_id, r.rule, r.detail),
                   '; ' ORDER BY r.assignment_id, r.rule)
          INTO v_refusal_rows, v_refusal_text
          FROM public.practice_new_auto_row_refusals(v_org_id, v_new_auto_ids) r;
        IF v_refusal_rows > 0 THEN
            RAISE EXCEPTION 'refusing % new auto practice row(s) that break a rule the auto-scheduler keeps: %',
                v_refusal_rows, v_refusal_text
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- v3: exceptions are their own rows, keyed to the assignment they
    -- override -- never an assignment row (plan §1).
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(exceptions) e
         WHERE NULLIF(e.value->>'practice_slot_id', '') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.practice_slots ps
                            WHERE ps.id = (e.value->>'practice_slot_id')::uuid
                              AND ps.organization_id = v_org_id)
    ) THEN
        RAISE EXCEPTION 'an exception names a practice slot outside organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;
    WITH ins AS (
        INSERT INTO public.practice_exceptions (
            organization_id, season_settings_id, team_id, assignment_id, "window",
            kind, practice_slot_id, tbd_reason, cause_kind, cause_id, run_id, created_by
        )
        SELECT v_org_id, v_season_id, pa.team_id, pa.id,
               NULLIF(e.value->>'window', '')::daterange,
               e.value->>'kind',
               NULLIF(e.value->>'practice_slot_id', '')::uuid,
               NULLIF(e.value->>'tbd_reason', ''),
               NULLIF(e.value->>'cause_kind', ''),
               NULLIF(e.value->>'cause_id', '')::uuid,
               v_run_id,
               v_created_by
          FROM jsonb_array_elements(exceptions) e
          JOIN public.practice_assignments pa
            ON pa.id = COALESCE(
                   (e.value->>'assignment_id')::uuid,
                   -- 8.9 PR 6b: a row this save placed, found by the unique
                   -- (team, slot, range) key it was just inserted under.
                   (SELECT r.id
                      FROM public.practice_assignments r
                     WHERE r.organization_id = v_org_id
                       AND r.team_id = (e.value#>>'{new_assignment,team_id}')::uuid
                       AND r.practice_slot_id = (e.value#>>'{new_assignment,practice_slot_id}')::uuid
                       AND r.effective_date_range = (e.value#>>'{new_assignment,effective_date_range}')::daterange))
        RETURNING *
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ins.*) ORDER BY ins.id), '[]'::jsonb)
      INTO v_recorded
      FROM ins;
    -- 8.9 PR 6b: the join above drops an entry that resolves to no row, so
    -- every entry handed in must come out recorded -- never one lost quietly.
    IF jsonb_array_length(v_recorded) <> jsonb_array_length(exceptions) THEN
        RAISE EXCEPTION 'recorded % of % exceptions: an entry resolved to no assignment row', jsonb_array_length(v_recorded), jsonb_array_length(exceptions)
            USING ERRCODE = '23503';
    END IF;
    -- 8.9 plan D13 (c): a daylight TIME TBD window must be a TAIL window --
    -- reaching the end of its series' range, or lying after it. Readers do
    -- not apply exceptions until 3b PR 12, so a mid-range one would still be
    -- shown as a practice. Refused here (the whole save rolls back), not
    -- only noted for the 3b PR 9 adapter.
    SELECT (r.value->>'assignment_id')::uuid
      INTO v_bad_id
      FROM jsonb_array_elements(v_recorded) r
      JOIN public.practice_assignments pa ON pa.id = (r.value->>'assignment_id')::uuid
     WHERE r.value->>'tbd_reason' IN ('past-sunset', 'sunset-unknown')
       AND NOT (upper_inf((r.value->>'window')::daterange)
                OR (NOT upper_inf(pa.effective_date_range)
                    AND upper((r.value->>'window')::daterange) >= upper(pa.effective_date_range)))
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'a daylight TIME TBD window on assignment % ends before its series does: mid-range windows are refused until readers apply exceptions (3b PR 12)', v_bad_id
            USING ERRCODE = '22023';
    END IF;

    -- #64: every team of the season left with NO practice by this save --
    -- unplaced by the solver, absent from the payload, stripped of its auto
    -- row, or never scheduled at all. Enumerated from the season's ROSTER, not
    -- from the payload or the superseded list: a team either of those lost
    -- track of must still be named here, which is the point of the list.
    SELECT count(*),
           COALESCE(
               jsonb_agg(
                   jsonb_build_object(
                       'team_id', t.id,
                       'team_name', t.name,
                       'had_prior_rows', t.id = ANY (v_teams_with_prior)
                   )
                   ORDER BY t.name, t.id
               ) FILTER (
                   WHERE NOT EXISTS (
                       SELECT 1 FROM public.practice_assignments pa WHERE pa.team_id = t.id
                   )
                   -- A division that gives no practice (0 a week) leaves its teams with none on
                   -- purpose: that is not a team the save left without one.
                   AND d.practices_per_week > 0
               ),
               '[]'::jsonb
           )
      INTO v_season_team_count, v_without_practice
      FROM public.teams t
      JOIN public.divisions d ON d.id = t.division_id
     WHERE t.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- v3: every roster team holding a live TIME TBD window after this save,
    -- enumerated from the season's ROSTER for the same reason as above.
    SELECT COALESCE(
               jsonb_agg(
                   jsonb_build_object(
                       'team_id', t.id,
                       'team_name', t.name,
                       'exception_id', pe.id,
                       'assignment_id', pe.assignment_id,
                       'window', pe."window"::text,
                       'tbd_reason', pe.tbd_reason
                   )
                   ORDER BY t.name, t.id, lower(pe."window")
               ),
               '[]'::jsonb
           )
      INTO v_time_tbd
      FROM public.teams t
      JOIN public.divisions d ON d.id = t.division_id
      JOIN public.practice_exceptions pe
        ON pe.team_id = t.id
       AND pe.kind = 'time_tbd'
       AND pe.withdrawn_at IS NULL
     WHERE t.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- The run carries its own before-images, so what it superseded, unlocked,
    -- closed and withdrew can be read back whether or not the audit rows exist.
    UPDATE public.scheduler_runs
       SET results = COALESCE(results, '{}'::jsonb) || jsonb_build_object(
               'superseded_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'superseded_rows') = 'array'
                        THEN v_prior_results->'superseded_rows' ELSE '[]'::jsonb END || v_removed,
               'retained_manual', v_retained,
               'unlocked_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'unlocked_rows') = 'array'
                        THEN v_prior_results->'unlocked_rows' ELSE '[]'::jsonb END || v_unlocked,
               'closed_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'closed_rows') = 'array'
                        THEN v_prior_results->'closed_rows' ELSE '[]'::jsonb END || v_closed,
               'superseded_exceptions',
                   CASE WHEN jsonb_typeof(v_prior_results->'superseded_exceptions') = 'array'
                        THEN v_prior_results->'superseded_exceptions' ELSE '[]'::jsonb END || v_superseded_exceptions
           )
     WHERE id = v_run_id
       AND organization_id = v_org_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RAISE EXCEPTION 'scheduler run % could not record what it superseded', v_run_id
            USING ERRCODE = '42501';
    END IF;

    -- Audit: one row per superseded assignment, with the full row, and one per
    -- run. `record_audit_event` writes `auth.uid()` into the NOT NULL
    -- `audit_log.user_id`, so a caller with no uid -- a service-role caller;
    -- `practice-persistence` calls as the user -- cannot be audited here:
    -- calling it would fail the save with 23502 (the defect 20260726000200
    -- records as KNOWN PRE-EXISTING). That caller is told so in the result
    -- rather than the audit being skipped in silence, and its before-images
    -- are on the run. (v3: such a caller cannot unlock, so it can supersede
    -- nothing; what it can still do unaudited is ADD rows and exceptions.)
    IF auth.uid() IS NOT NULL THEN
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_removed) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.superseded',
                'practice_assignment',
                (v_row->>'id')::uuid,
                jsonb_build_object(
                    'run_id', v_run_id,
                    'season_settings_id', v_season_id,
                    'reason', v_row->>'superseded_reason',
                    'row', v_row - 'superseded_reason'
                )
            );
        END LOOP;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_withdrawn) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.exception_withdrawn',
                'practice_exception',
                (v_row->>'id')::uuid,
                jsonb_build_object('run_id', v_run_id, 'reason', 'withdrawn_by_save', 'row', v_row)
            );
        END LOOP;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_recorded) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.exception_recorded',
                'practice_exception',
                (v_row->>'id')::uuid,
                jsonb_build_object('run_id', v_run_id, 'row', v_row)
            );
        END LOOP;
        PERFORM public.record_audit_event(
            v_org_id,
            'practice.saved',
            'scheduler_run',
            v_run_id,
            jsonb_build_object(
                'season_settings_id', v_season_id,
                'assignment_count', jsonb_array_length(assignments),
                'superseded_count', jsonb_array_length(v_removed),
                'retained_manual_count', jsonb_array_length(v_retained),
                'allow_empty', COALESCE(allow_empty, false),
                'unlocked_count', jsonb_array_length(v_unlocked),
                'closed_count', jsonb_array_length(v_closed),
                'exceptions_recorded', jsonb_array_length(v_recorded),
                'exceptions_withdrawn', jsonb_array_length(v_withdrawn),
                'base_fingerprint', base_fingerprint
            )
        );
        v_audited := true;
    END IF;

    RETURN jsonb_build_object(
        'run_id', v_run_id,
        'superseded', v_removed,
        'superseded_count', jsonb_array_length(v_removed),
        'retained_manual', v_retained,
        'retained_manual_count', jsonb_array_length(v_retained),
        'teams_without_practice', v_without_practice,
        'season_team_count', v_season_team_count,
        'teams_time_tbd', v_time_tbd,
        'unlocked', v_unlocked,
        'closed', v_closed,
        'exceptions_recorded', v_recorded,
        'exceptions_withdrawn', v_withdrawn,
        'fingerprint', public.practice_schedule_fingerprint(v_season_id),
        'audited', v_audited,
        'audit_gap', CASE WHEN v_audited THEN NULL ELSE
            'no auth.uid(): record_audit_event cannot attribute this save; the superseded rows are recorded on scheduler_runs.results instead'
        END
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. admin_upsert_division_settings takes the two settings (a new signature).
-- ---------------------------------------------------------------------------

DROP FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean);

CREATE FUNCTION public.admin_upsert_division_settings(p_organization_id uuid, p_season_settings_id uuid, p_division_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_max_roster_size integer DEFAULT NULL::integer, p_min_roster_size integer DEFAULT NULL::integer, p_target_team_size integer DEFAULT NULL::integer, p_team_count_override integer DEFAULT NULL::integer, p_min_teams integer DEFAULT NULL::integer, p_max_teams integer DEFAULT NULL::integer, p_plays_games boolean DEFAULT NULL::boolean, p_practices_per_week integer DEFAULT NULL::integer, p_practice_minutes integer DEFAULT NULL::integer)
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
    -- 20261105010000: the practice settings this save leaves the division with.
    v_ppw integer;
    v_min integer;
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

    -- 20261105010000: NULL keeps the stored value (a new division: 1 a week, any slot length);
    -- p_practice_minutes => 0 clears the length to "any slot length".
    v_ppw := COALESCE(
        p_practices_per_week,
        CASE WHEN v_existing.id IS NULL THEN 1 ELSE v_existing.practices_per_week END
    );
    v_min := CASE
        WHEN p_practice_minutes IS NULL THEN
            CASE WHEN v_existing.id IS NULL THEN NULL ELSE v_existing.practice_minutes END
        WHEN p_practice_minutes = 0 THEN NULL
        ELSE p_practice_minutes
    END;
    IF v_ppw NOT BETWEEN 0 AND 7 THEN
        RAISE EXCEPTION 'practices per week must be from 0 to 7, not %', v_ppw
            USING ERRCODE = '23514';
    END IF;
    IF v_min IS NOT NULL AND v_min NOT BETWEEN 15 AND 240 THEN
        RAISE EXCEPTION 'a practice length must be from 15 to 240 minutes (or 0 for any slot length), not %', v_min
            USING ERRCODE = '23514';
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
                plays_games,
                practices_per_week,
                practice_minutes
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
                COALESCE(p_plays_games, true),
                v_ppw,
                v_min
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
                   -- 20261105010000: v_ppw and v_min already carry "NULL keeps".
                   practices_per_week = v_ppw,
                   practice_minutes = v_min,
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
                   OR public.divisions.practices_per_week IS DISTINCT FROM v_ppw
                   OR public.divisions.practice_minutes IS DISTINCT FROM v_min
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
            OR (p_plays_games IS NOT NULL AND v_existing.plays_games IS DISTINCT FROM p_plays_games)
            OR v_existing.practices_per_week IS DISTINCT FROM v_ppw
            OR v_existing.practice_minutes IS DISTINCT FROM v_min;

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
                   practices_per_week = v_ppw,
                   practice_minutes = v_min,
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
                        'plays_games', v_existing.plays_games,
                        'practices_per_week', v_existing.practices_per_week,
                        'practice_minutes', v_existing.practice_minutes
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
                    'plays_games', v_result.plays_games,
                    'practices_per_week', v_result.practices_per_week,
                    'practice_minutes', v_result.practice_minutes
                )
            )
        );
    END IF;

    RETURN to_jsonb(v_result) || jsonb_build_object('changed', v_changed);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean, integer, integer) IS
    'Creates or updates a division''s team-generation rules, whether it plays games, how many practices a week its teams get and how long each is. NULL keeps a stored value; p_practice_minutes => 0 clears the length to any slot length. Audited as settings.updated. 20261105010000.';

-- ---------------------------------------------------------------------------
-- 6. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_n integer;
    v_def text;
    v_sig text;
BEGIN
    -- The columns, as declared.
    SELECT count(*) INTO v_n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'divisions'
       AND ((column_name = 'practices_per_week' AND data_type = 'smallint' AND is_nullable = 'NO' AND column_default = '1')
         OR (column_name = 'practice_minutes' AND data_type = 'smallint' AND is_nullable = 'YES' AND column_default IS NULL));
    IF v_n <> 2 THEN RAISE EXCEPTION 'divisions.practices_per_week / practice_minutes are not as declared'; END IF;
    IF EXISTS (SELECT 1 FROM public.divisions WHERE practices_per_week <> 1 OR practice_minutes IS NOT NULL) THEN
        RAISE EXCEPTION 'a division took something other than 1 a week and any slot length';
    END IF;
    SELECT count(*) INTO v_n FROM pg_constraint
     WHERE conrelid = 'public.divisions'::regclass AND contype = 'c'
       AND conname IN ('divisions_practices_per_week_range', 'divisions_practice_minutes_range');
    IF v_n <> 2 THEN RAISE EXCEPTION 'the two range checks are missing'; END IF;

    -- The old signature is gone, the new one is a definer for signed-in users, not anon, not PUBLIC.
    IF to_regprocedure('public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean)') IS NOT NULL THEN
        RAISE EXCEPTION 'the eleven-argument admin_upsert_division_settings is still callable';
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'admin_upsert_division_settings') <> 1 THEN
        RAISE EXCEPTION 'admin_upsert_division_settings has more than one overload';
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = 'public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean, integer, integer)'::regprocedure
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::text LIKE '=%');
    IF v_n <> 1 THEN RAISE EXCEPTION 'admin_upsert_division_settings is not a pinned definer granted to authenticated only'; END IF;
    SELECT prosrc INTO v_def FROM pg_proc
     WHERE oid = 'public.admin_upsert_division_settings(uuid, uuid, uuid, text, integer, integer, integer, integer, integer, integer, boolean, integer, integer)'::regprocedure;
    IF v_def !~ 'season_completed' OR v_def !~ 'practices_per_week' OR v_def !~ 'practice_minutes' THEN
        RAISE EXCEPTION 'admin_upsert_division_settings lost its completed-season refusal or does not write the settings';
    END IF;

    -- The helper is an invoker closed to anon; the writer calls it, is still an invoker, pinned.
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = 'public.practice_new_auto_row_refusals(uuid, uuid[])'::regprocedure
       AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'practice_new_auto_row_refusals is not a pinned invoker closed to anon'; END IF;
    v_sig := 'public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text)';
    SELECT prosrc INTO v_def FROM pg_proc WHERE oid = v_sig::regprocedure;
    IF v_def !~ 'practice_new_auto_row_refusals' OR v_def ~ 'timezone\(''utc''' THEN
        RAISE EXCEPTION '% does not call the gate, or still uses timezone(utc, now())', v_sig;
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = v_sig::regprocedure
       AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'persist_practice_schedule is not a pinned invoker for authenticated and service_role only'; END IF;
END;
$check$;

COMMIT;
