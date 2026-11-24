BEGIN;
DO $guard$
BEGIN
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
         WHERE oid = to_regprocedure('public.practice_new_auto_row_refusals(uuid,uuid[])')) IS DISTINCT FROM '5a6658441b95a7444bfcb99fef293042' THEN
        RAISE EXCEPTION 'Unexpected body for practice_new_auto_row_refusals(uuid,uuid[])';
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
         WHERE oid = to_regprocedure('public.admin_set_scoped_setting(text,text,uuid,jsonb)')) IS DISTINCT FROM '0906847fa620d4664d72c18b1ab669ec' THEN
        RAISE EXCEPTION 'Unexpected body for admin_set_scoped_setting(text,text,uuid,jsonb)';
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
         WHERE oid = to_regprocedure('public.apply_practice_import_job(uuid,boolean)')) IS DISTINCT FROM '57186608a02b889ebf58c898e7116e5a' THEN
        RAISE EXCEPTION 'Unexpected body for apply_practice_import_job(uuid,boolean)';
    END IF;
END
$guard$;

INSERT INTO public.scoped_setting_keys (key, value_type, allowed_values, default_value, label) VALUES
    ('practice_pairs', 'text_set', '["mon-wed","tue-thu","wed-fri"]', '[]', 'Paired practice days');

CREATE FUNCTION public.division_practice_pairs(p_division public.divisions)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT public.scoped_setting_value(d.id, 'practice_pairs')
                       FROM public.divisions d WHERE d.id = p_division.id AND d.practices_per_week = 2
                        AND (public.is_org_member(d.organization_id) OR (SELECT auth.role()) = 'service_role')), '[]'::jsonb)
$$;
REVOKE ALL ON FUNCTION public.division_practice_pairs(public.divisions) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.division_practice_pairs(public.divisions) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.practice_new_auto_row_refusals(p_organization_id uuid, p_assignment_ids uuid[])
 RETURNS TABLE(assignment_id uuid, team_id uuid, practice_slot_id uuid, rule text, detail text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
    WITH scoped AS (
        -- Every row of a judged row's slot or team, as the table stands after the save.
        SELECT pa.id, pa.team_id, pa.practice_slot_id,
               pa.effective_date_range AS rng,
               ps.field_id, ps.field_subunit_id, ps.day_of_week, ps.start_time, ps.end_time, ps.capacity, ps.valid_from, ps.valid_until,
               ps.division_id AS slot_division, t.division_id AS team_division,
               array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun']::public.day_of_week[], ps.day_of_week) AS dow
          FROM public.practice_assignments pa
          JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
          JOIN public.teams t ON t.id = pa.team_id
         WHERE pa.organization_id = p_organization_id
           AND pa.practice_slot_id IS NOT NULL
           -- A NULL range is the slot's whole validity (the solver's reading, `assignmentLiveSpan`);
           -- an empty one holds nothing.
           AND (pa.effective_date_range IS NULL OR NOT isempty(pa.effective_date_range))
           AND (pa.id = ANY (p_assignment_ids)
                OR pa.team_id IN (SELECT j.team_id FROM public.practice_assignments j WHERE j.id = ANY (p_assignment_ids))
                OR pa.practice_slot_id IN (SELECT j.practice_slot_id FROM public.practice_assignments j WHERE j.id = ANY (p_assignment_ids)))
    ), bounded AS (
        -- The weekly dates a row is live on run from the first to the last date on its weekday
        -- inside [lo, hi]: its range, cut to the slot's validity (a NULL range, or an end it does
        -- not have, is the slot's own: LEAST and GREATEST skip a NULL). A slot unbounded at the top
        -- is read as a year.
        SELECT s.*,
               GREATEST(lower(s.rng), s.valid_from) AS lo,
               COALESCE(LEAST(upper(s.rng) - 1, s.valid_until),
                        GREATEST(lower(s.rng), s.valid_from) + 366) AS hi
          FROM scoped s
    ), dated AS (
        SELECT b.id, b.team_id, b.practice_slot_id, b.day_of_week, b.start_time, b.end_time,
               b.field_id, b.field_subunit_id, b.capacity, b.slot_division, b.team_division, b.dow,
               b.lo + ((b.dow - extract(isodow FROM b.lo)::int + 7) % 7) AS first_day,
               b.hi - ((extract(isodow FROM b.hi)::int - b.dow + 7) % 7) AS last_day
          FROM bounded b
         WHERE b.lo IS NOT NULL
    ), live AS (
        -- A row with no date on its weekday inside [lo, hi] holds nothing.
        SELECT x.* FROM dated x WHERE x.first_day <= x.last_day
    ), judged AS (
        SELECT l.*, d.practices_per_week, d.practice_minutes, public.division_practice_pairs(d) AS pairs
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
           format('the team holds %s practices in one week, its division''s count is %s', pk.peak, j.practices_per_week)
      FROM judged j
     CROSS JOIN LATERAL (
         -- A scheduling week is Monday to Sunday: the practices a team has in it are the rows with
         -- a date on their weekday in that week, so a Monday and a Wednesday row of one week count
         -- two though no date is shared. Weeks are those the judged row is live in.
         SELECT max(q.n) AS peak
           FROM (SELECT (SELECT count(*) FROM live o
                          WHERE o.team_id = j.team_id
                            AND w.ws::date + (o.dow - 1) BETWEEN o.first_day AND o.last_day) AS n
                   FROM generate_series(date_trunc('week', j.first_day::timestamp),
                                        date_trunc('week', j.last_day::timestamp),
                                        interval '7 days') AS w(ws)) q) pk
     WHERE pk.peak > j.practices_per_week
    UNION ALL
    SELECT j.id, j.team_id, j.practice_slot_id, 'pairing'::text,
           'the two practices do not share a surface and clock window on an allowed pair of weekdays'
      FROM judged j
     WHERE j.practices_per_week = 2 AND j.pairs <> '[]'::jsonb
       AND EXISTS (SELECT 1 FROM live o WHERE o.team_id = j.team_id AND o.id <> j.id
           AND j.first_day - (j.dow - 1) <= o.last_day - (o.dow - 1)
           AND o.first_day - (o.dow - 1) <= j.last_day - (j.dow - 1)
           AND (j.field_id IS DISTINCT FROM o.field_id OR j.field_subunit_id IS DISTINCT FROM o.field_subunit_id
                OR j.start_time <> o.start_time OR j.end_time <> o.end_time
                OR NOT (j.pairs ? (j.day_of_week::text || '-' || o.day_of_week::text)
                        OR j.pairs ? (o.day_of_week::text || '-' || j.day_of_week::text))));
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_scoped_setting(p_key text, p_scope text, p_scope_id uuid, p_value jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_org uuid;
    v_weekly_count integer;
    v_season uuid;
    v_status text;
    v_name text;
    v_is_default boolean := false;
    v_key public.scoped_setting_keys%ROWTYPE;
    v_value jsonb;
    v_row_id uuid;
    v_old jsonb;
    v_old_effective jsonb;
    v_frozen integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_scope IS NULL OR p_scope NOT IN ('organization', 'program', 'division') THEN
        RAISE EXCEPTION 'a setting is set for an organization, a program or a division, not %', COALESCE(p_scope, 'nothing')
            USING ERRCODE = '22023', DETAIL = 'scope_invalid';
    END IF;
    IF p_scope_id IS NULL THEN
        RAISE EXCEPTION 'p_scope_id is required' USING ERRCODE = '23502';
    END IF;

    -- The organization comes from the scope's own row, never from the caller: a missing row and another organization's
    -- get the same refusal.
    IF p_scope = 'organization' THEN
        SELECT o.id, o.name INTO v_org, v_name FROM public.organizations o WHERE o.id = p_scope_id;
    ELSIF p_scope = 'program' THEN
        SELECT p.organization_id, p.season_settings_id, p.name, p.is_default
          INTO v_org, v_season, v_name, v_is_default
          FROM public.programs p WHERE p.id = p_scope_id;
    ELSE
        SELECT d.organization_id, d.season_settings_id, d.name
          INTO v_org, v_season, v_name
          FROM public.divisions d WHERE d.id = p_scope_id;
    END IF;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the %''s organization', p_scope
            USING ERRCODE = '42501';
    END IF;

    -- The organization's season lock, the one the program writers and the rollover take, so a rollover's copy and a
    -- change cannot interleave. Then the scope row is read again under it.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    IF p_scope = 'program' THEN
        SELECT p.season_settings_id, p.name, p.is_default INTO v_season, v_name, v_is_default
          FROM public.programs p WHERE p.id = p_scope_id AND p.organization_id = v_org FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'the program no longer exists' USING ERRCODE = '42501';
        END IF;
    ELSIF p_scope = 'division' THEN
        SELECT d.season_settings_id, d.name, d.practices_per_week INTO v_season, v_name, v_weekly_count
          FROM public.divisions d WHERE d.id = p_scope_id AND d.organization_id = v_org FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'the division no longer exists' USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT * INTO v_key FROM public.scoped_setting_keys k WHERE k.key = p_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown setting %', COALESCE(p_key, 'NULL') USING ERRCODE = '22023', DETAIL = 'unknown_setting';
    END IF;

    -- The value, checked against its registered type. A text set is stored sorted and without repeats, so one set has
    -- one spelling and "unchanged" is an equality.
    IF p_value IS NOT NULL THEN
        IF v_key.value_type = 'boolean' THEN
            IF jsonb_typeof(p_value) <> 'boolean' THEN
                RAISE EXCEPTION 'the setting % takes true or false', p_key USING ERRCODE = '22023', DETAIL = 'setting_value_invalid';
            END IF;
            v_value := p_value;
        ELSE
            IF jsonb_typeof(p_value) <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) e WHERE jsonb_typeof(e) <> 'string')
               OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_value) e
                           WHERE NOT (v_key.allowed_values ? e))
               OR (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(p_value) e) <> jsonb_array_length(p_value) THEN
                RAISE EXCEPTION 'the setting % takes a list of distinct values from %', p_key, v_key.allowed_values::text
                    USING ERRCODE = '22023', DETAIL = 'setting_value_invalid';
            END IF;
            v_value := COALESCE((SELECT jsonb_agg(e ORDER BY e COLLATE "C") FROM jsonb_array_elements_text(p_value) e), '[]'::jsonb);
        END IF;
    END IF;

    IF v_is_default THEN
        RAISE EXCEPTION 'the default program ("No program") holds no settings: its divisions follow the organization'
            USING ERRCODE = '22023', DETAIL = 'default_program';
    END IF;
    IF v_season IS NOT NULL THEN
        SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = v_season;
        IF v_status = 'completed' THEN
            RAISE EXCEPTION 'Season % is completed and its settings cannot be changed', v_season
                USING ERRCODE = '22023', DETAIL = 'season_completed';
        END IF;
    END IF;

    IF p_key = 'practice_pairs' AND p_scope = 'division' AND v_weekly_count IS DISTINCT FROM 2
       AND v_value IS NOT NULL AND v_value <> '[]'::jsonb THEN
        RAISE EXCEPTION 'Paired days apply only to divisions with two practices per week'
            USING ERRCODE = '22023', DETAIL = 'practice_pairing_count';
    END IF;

    -- One plain lookup per level, each the shape of its partial unique index.
    IF p_scope = 'organization' THEN
        SELECT s.id, s.value INTO v_row_id, v_old
          FROM public.scoped_settings s
         WHERE s.organization_id = v_org AND s.key = p_key AND s.program_id IS NULL AND s.division_id IS NULL
           FOR UPDATE;
    ELSIF p_scope = 'program' THEN
        SELECT s.id, s.value INTO v_row_id, v_old
          FROM public.scoped_settings s
         WHERE s.program_id = p_scope_id AND s.key = p_key
           FOR UPDATE;
    ELSE
        SELECT s.id, s.value INTO v_row_id, v_old
          FROM public.scoped_settings s
         WHERE s.division_id = p_scope_id AND s.key = p_key
           FOR UPDATE;
    END IF;

    IF v_old IS NOT DISTINCT FROM v_value THEN
        RETURN jsonb_build_object('changed', false, 'scope', p_scope, 'scope_id', p_scope_id, 'key', p_key,
                                  'previous', v_old, 'current', v_value);
    END IF;

    -- An organization's change does not rewrite a COMPLETED season's history: each of its divisions that inherits the
    -- organization's value today (no row of its own, and no program value: in no program or the default one) is held at
    -- the value it had, by a division row marked frozen_from_organization, before the change is made.
    IF p_scope = 'organization' THEN
        v_old_effective := COALESCE(v_old, v_key.default_value);
        IF v_old_effective IS DISTINCT FROM COALESCE(v_value, v_key.default_value) THEN
            INSERT INTO public.scoped_settings (organization_id, division_id, key, value, updated_by, frozen_from_organization)
            SELECT v_org, d.id, p_key, v_old_effective, auth.uid(), true
              FROM public.divisions d
              JOIN public.season_settings ss ON ss.id = d.season_settings_id AND ss.status = 'completed'
              LEFT JOIN public.programs p ON p.id = d.program_id
             WHERE d.organization_id = v_org
               AND NOT EXISTS (SELECT 1 FROM public.scoped_settings s WHERE s.division_id = d.id AND s.key = p_key)
               AND (p.id IS NULL OR p.is_default
                    OR NOT EXISTS (SELECT 1 FROM public.scoped_settings s WHERE s.program_id = p.id AND s.key = p_key));
            GET DIAGNOSTICS v_frozen = ROW_COUNT;
        END IF;
    END IF;

    IF v_value IS NULL THEN
        DELETE FROM public.scoped_settings WHERE id = v_row_id;
    ELSIF v_row_id IS NULL THEN
        INSERT INTO public.scoped_settings (organization_id, program_id, division_id, key, value, updated_by)
        VALUES (v_org,
                CASE WHEN p_scope = 'program' THEN p_scope_id END,
                CASE WHEN p_scope = 'division' THEN p_scope_id END,
                p_key, v_value, auth.uid());
    ELSE
        UPDATE public.scoped_settings SET value = v_value, updated_by = auth.uid() WHERE id = v_row_id;
    END IF;

    PERFORM public.record_audit_event(
        v_org,
        'settings.updated',
        'scoped_setting',
        p_scope_id,
        jsonb_build_object(
            'setting', 'scoped_setting',
            'field', p_key,
            'key', p_key,
            'scope', p_scope,
            'scope_id', p_scope_id,
            'scope_name', v_name,
            'season_settings_id', v_season,
            'old', v_old,
            'new', v_value,
            'frozen_completed_divisions', v_frozen
        )
    );

    RETURN jsonb_build_object('changed', true, 'scope', p_scope, 'scope_id', p_scope_id, 'key', p_key,
                              'previous', v_old, 'current', v_value, 'frozen_completed_divisions', v_frozen);
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
