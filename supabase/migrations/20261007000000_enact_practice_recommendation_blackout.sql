-- ==========================================
-- 8.6 3b PR 11d-2: enacting a BLACKOUT practice recommendation
-- ==========================================
--
-- Plan of record: docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md (APPROVED
-- 2026-10-12), §2.4 and §4; operator answers Q4 (no unlock is sent), Q5 (only
-- a saved blackout, as saved), Q9 (this is one pending production migration;
-- the writer is unchanged) and Q10 (the cause row is held FOR SHARE, on the
-- blackout arm and, as a declared departure from 11b, on the retirement arm).
--
-- ## What this changes
--
-- `public.enact_practice_recommendation`, same signature, replaced. The
-- retirement arm is the 20261004000000 body unchanged except for the Q10
-- lock. `persist_practice_schedule` is NOT touched (LESSONS #11): it is
-- called exactly as before.
--
-- The blackout arm (`cause.kind = 'blackout'`):
--
--   3.  the record: `cause.loss.from`/`until` and `series.window` dates, a
--       `cause.stored` object, `decision.kind` in (`relocate`, `time_tbd`) and
--       `prompt.accepted = true` (Q4: the tick is required although nothing
--       is unlocked). `rehome` stays retirement-only, and `relocate`
--       blackout-only (plan §2.3);
--   2a. right after the season lock, the cause row is LOCKED FOR SHARE (Q10)
--       and re-read: no `field_blackouts` row of this id in the caller's
--       organisation refuses "blackout X is not saved"; any of its scope,
--       dates, minutes or reason differing from `cause.stored` or from
--       `cause.loss`, or `loss.surface_ids` other than `{field_id}` or every
--       field of `location_id` (the adapter's `fieldsOfLocation`), refuses
--       "blackout X changed" (22023 both);
--   7.  only S, and only one exception on it: `closed`, `unlocked` and
--       `superseded` are empty, EVERY pre-enact row of the organisation, S
--       included, is unchanged in team, slot, range, source and
--       assigned_via, no row was created, and exactly one exception was
--       recorded: on S, `cause_kind = 'blackout'`, `cause_id = cause.id`,
--       `"window" = series.window`, and `relocated` on a slot of
--       `decision.to`'s shape for `relocate`, or `time_tbd` with
--       `decision.tbd_reason` (22023 otherwise; everything rolls back);
--   8.  the audit row carries `cause.stored` as step 2a READ it.
--
-- ## The FOR SHARE lock, and why it is a helper (a DEPARTURE from §2.4)
--
-- Plan §2.4 step 2a writes `SELECT ... FROM field_blackouts ... FOR SHARE`
-- inside the wrapper. The wrapper is SECURITY INVOKER, and PostgreSQL applies
-- a table's UPDATE policies to the rows a `SELECT ... FOR UPDATE/SHARE` locks.
-- Neither `field_blackouts` nor `fields` has an UPDATE policy (writes go
-- through SECURITY DEFINER admin RPCs), so as the caller that read would
-- return NO row, and every enact would be refused "not saved" / "not
-- committed". The lock is therefore taken by `enact_lock_cause_row`, a
-- SECURITY DEFINER helper that locks exactly the one row, in the caller's
-- organisation, for an org admin with a uid, and returns whether it found it.
-- The wrapper then re-reads the row AS THE CALLER (RLS on), after the lock,
-- so the read sees the row as committed and nothing can change it until the
-- enact commits: `admin_update_field_blackout` / `admin_delete_field_blackout`
-- (and the field RPCs) take `FOR UPDATE` on it and wait. The smoke and the
-- pgTAP file both record the premise (an invoker `FOR SHARE` reads 0 rows).
--
-- ## What this does NOT do
--
-- The writer's mid-range daylight refusal stays (Q3; the adapter adopts it).
-- `field_blackouts` is still not in the fingerprint (D8): the lock covers the
-- click-to-commit window for the cause row only. A blackout edited after the
-- enact commits leaves its exception live and locked (D7). Overlapping live
-- windows stay unreachable (the EXCLUDE constraint, D2).
--
-- Reversible: see docs/sql/20261007000000_revert.sql.
-- Smoke checks: see docs/sql/20261007000000_smoke.sql.

BEGIN;

-- The Q10 lock, taken as the table owner (see above). Org-admin-only, one
-- row, one organisation; it reads nothing back but whether the row exists.
CREATE OR REPLACE FUNCTION public.enact_lock_cause_row(
    p_organization_id uuid,
    p_kind text,
    p_cause_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL OR p_organization_id IS NULL
       OR NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'enact_lock_cause_row: only an organization admin with a uid can lock an enact cause (organization %)', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_kind = 'retirement' THEN
        PERFORM 1 FROM public.fields f
         WHERE f.id = p_cause_id
           AND f.organization_id = p_organization_id
           FOR SHARE;
    ELSIF p_kind = 'blackout' THEN
        PERFORM 1 FROM public.field_blackouts fb
         WHERE fb.id = p_cause_id
           AND fb.organization_id = p_organization_id
           FOR SHARE;
    ELSE
        RAISE EXCEPTION 'enact_lock_cause_row: unknown cause kind %', p_kind
            USING ERRCODE = '22023';
    END IF;
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.enact_lock_cause_row(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enact_lock_cause_row(uuid, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.enact_lock_cause_row(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enact_lock_cause_row(uuid, text, uuid) TO service_role;

COMMENT ON FUNCTION public.enact_lock_cause_row(uuid, text, uuid) IS
  'Locks ONE enact cause row (a field for a retirement, a field_blackouts row for a blackout) FOR SHARE until the caller''s transaction ends (8.6 3b PR 11d-2, plan Q10). SECURITY DEFINER because neither table has an UPDATE policy, which a SELECT ... FOR SHARE as the caller would need; org-admin-only, own organisation only. Returns whether the row exists. Called by enact_practice_recommendation, which re-reads the row as the caller.';

CREATE OR REPLACE FUNCTION public.enact_practice_recommendation(
    run_data jsonb,
    assignments jsonb,
    unlock jsonb,
    closes jsonb,
    exceptions jsonb,
    base_fingerprint text,
    enact jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    c_date constant text := '^\d{4}-\d{2}-\d{2}$';
    c_keys constant text[] := ARRAY[
        'base_fingerprint', 'cause', 'chains', 'declined', 'decision', 'enact_key',
        'enacted_before', 'fingerprint_covers', 'local', 'prompt', 'rejudge',
        'result_fingerprint', 'run_id', 'schema_version', 'season_settings_id',
        'series', 'solver', 'unlock', 'writes'];
    v_season_id uuid;
    v_org_id uuid;
    v_key uuid;
    v_series uuid;
    v_team uuid;
    v_field uuid;
    v_kind text;
    v_loss_from date;
    v_stored date;
    v_bo_stored jsonb;
    v_bo_loss jsonb;
    v_bo_surfaces text[];
    v_window daterange;
    v_exc jsonb;
    v_run_data jsonb;
    v_before uuid[];
    v_result jsonb;
    v_stray text;
    v_new_count integer;
    v_new_bad integer;
    v_new_undeclared integer;
    v_before_rows jsonb;
    v_meta jsonb;
BEGIN
    IF run_data IS NULL OR jsonb_typeof(run_data) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'run_data must be a JSON object'
            USING ERRCODE = '22023';
    END IF;
    IF COALESCE(run_data->>'season_settings_id', '') !~ c_uuid THEN
        RAISE EXCEPTION 'an enact needs run_data.season_settings_id (a lowercase uuid)'
            USING ERRCODE = '22023';
    END IF;
    v_season_id := (run_data->>'season_settings_id')::uuid;
    -- Read as the caller (SECURITY INVOKER): a season the caller cannot see
    -- has no organisation here, and is refused as not theirs.
    SELECT ss.organization_id INTO v_org_id
      FROM public.season_settings ss
     WHERE ss.id = v_season_id;

    -- 1. Admin-only, with a uid to audit.
    IF auth.uid() IS NULL OR v_org_id IS NULL OR NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'enact_practice_recommendation: only an organization admin with a uid can enact a recommendation (season %)', v_season_id
            USING ERRCODE = '42501';
    END IF;

    -- 2. Never blind.
    IF base_fingerprint IS NULL THEN
        RAISE EXCEPTION 'an enact is never blind: base_fingerprint is required'
            USING ERRCODE = '22023';
    END IF;

    -- 3. The record's shape, and that it describes what is actually sent.
    IF enact IS NULL OR jsonb_typeof(enact) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'enact must be a JSON object'
            USING ERRCODE = '22023';
    END IF;
    -- Compared as sets, in one collation on both sides.
    IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(enact) AS k)
       IS DISTINCT FROM (SELECT array_agg(k ORDER BY k COLLATE "C") FROM unnest(c_keys) AS k) THEN
        RAISE EXCEPTION 'enact must carry exactly the plan section 5 keys (%), got %',
            array_to_string(c_keys, ', '),
            (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(enact) AS k)
            USING ERRCODE = '22023';
    END IF;
    v_kind := enact->'cause'->>'kind';
    IF enact->'schema_version' IS DISTINCT FROM '1'::jsonb
       OR COALESCE(enact->>'enact_key', '') !~ c_uuid
       OR enact->>'run_id' IS DISTINCT FROM enact->>'enact_key'
       OR run_data->>'id' IS DISTINCT FROM enact->>'enact_key'
       OR enact->>'season_settings_id' IS DISTINCT FROM run_data->>'season_settings_id'
       OR enact->>'base_fingerprint' IS DISTINCT FROM base_fingerprint
       OR enact->'result_fingerprint' IS DISTINCT FROM 'null'::jsonb
       OR COALESCE(v_kind, '') NOT IN ('retirement', 'blackout')
       OR COALESCE(enact->'cause'->>'id', '') !~ c_uuid
       OR COALESCE(enact->'cause'->'loss'->>'from', '') !~ c_date
       OR (v_kind = 'retirement' AND (
              COALESCE(enact->'cause'->>'stored_effective_to', '') !~ c_date
              OR COALESCE(enact->'decision'->>'kind', '') NOT IN ('rehome', 'time_tbd')))
       OR (v_kind = 'blackout' AND (
              COALESCE(enact->'cause'->'loss'->>'until', '') !~ c_date
              OR jsonb_typeof(enact->'cause'->'stored') IS DISTINCT FROM 'object'
              OR jsonb_typeof(enact->'cause'->'loss'->'surface_ids') IS DISTINCT FROM 'array'
              OR COALESCE(enact->'series'->'window'->>'from', '') !~ c_date
              OR COALESCE(enact->'series'->'window'->>'until', '') !~ c_date
              OR COALESCE(enact->'decision'->>'kind', '') NOT IN ('relocate', 'time_tbd')
              OR enact->'prompt'->'accepted' IS DISTINCT FROM 'true'::jsonb))
       OR COALESCE(enact->'series'->>'assignment_id', '') !~ c_uuid
       OR COALESCE(enact->'series'->>'team_id', '') !~ c_uuid
       OR jsonb_typeof(enact->'writes'->'new_rows') IS DISTINCT FROM 'array'
       OR enact->'unlock' IS DISTINCT FROM COALESCE(unlock, '[]'::jsonb)
       OR enact->'writes'->'closes' IS DISTINCT FROM COALESCE(closes, '[]'::jsonb)
       OR enact->'writes'->'exceptions' IS DISTINCT FROM to_jsonb(jsonb_array_length(COALESCE(exceptions, '[]'::jsonb)))
       OR (jsonb_array_length(COALESCE(unlock, '[]'::jsonb)) > 0
           AND enact->'prompt'->'accepted' IS DISTINCT FROM 'true'::jsonb) THEN
        RAISE EXCEPTION 'enact record is malformed or does not describe the write sent (run id, season, base fingerprint, unlock, closes and exceptions must match; a retirement or a blackout of its own shape; result_fingerprint null)'
            USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(run_data->'parameters') IS NOT NULL
       AND jsonb_typeof(run_data->'parameters') <> 'object' THEN
        RAISE EXCEPTION 'run_data.parameters must be a JSON object'
            USING ERRCODE = '22023';
    END IF;
    v_key := (enact->>'enact_key')::uuid;
    v_series := (enact->'series'->>'assignment_id')::uuid;
    v_field := (enact->'cause'->>'id')::uuid;
    -- The regexes above admit 2026-02-30; the cast refuses it as 22008, which
    -- is a malformed record (22023), not a crash.
    BEGIN
        v_loss_from := (enact->'cause'->'loss'->>'from')::date;
        IF v_kind = 'retirement' THEN
            PERFORM (enact->'cause'->>'stored_effective_to')::date;
        ELSE
            PERFORM (enact->'cause'->'loss'->>'until')::date;
            v_window := daterange((enact->'series'->'window'->>'from')::date,
                                  (enact->'series'->'window'->>'until')::date, '[]');
        END IF;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR data_exception THEN
        RAISE EXCEPTION 'enact record carries an impossible date (loss.from %, stored_effective_to %, loss.until %, series.window %)',
            enact->'cause'->'loss'->>'from', enact->'cause'->>'stored_effective_to',
            enact->'cause'->'loss'->>'until', enact->'series'->'window'
            USING ERRCODE = '22023';
    END;

    -- 4. The writer's own season lock (re-entrant within this transaction).
    PERFORM pg_advisory_xact_lock(
        hashtextextended('persist_practice_schedule:' || v_org_id::text || ':' || v_season_id::text, 0)
    );

    -- 2a. The commit gate (Q3, Q5), immediately after the lock: the STORED
    -- row decides, never the record's claim. The row is locked FOR SHARE
    -- first (Q10; the helper, see the header), then read as the caller.
    PERFORM public.enact_lock_cause_row(v_org_id, v_kind, v_field);
    IF v_kind = 'retirement' THEN
        SELECT f.effective_to INTO v_stored
          FROM public.fields f
         WHERE f.id = v_field
           AND f.organization_id = v_org_id;
        IF v_stored IS NULL THEN
            RAISE EXCEPTION 'retirement of field % is not committed: no effective_to is stored; save the retirement first', v_field
                USING ERRCODE = '22023';
        END IF;
        IF v_stored <> v_loss_from - 1 THEN
            RAISE EXCEPTION 'retirement of field % is committed with a different date: % stored, % expected (the day before %)', v_field, v_stored, v_loss_from - 1, v_loss_from
                USING ERRCODE = '22023';
        END IF;
        IF (enact->'cause'->>'stored_effective_to')::date <> v_stored THEN
            RAISE EXCEPTION 'enact record claims stored_effective_to %, but % is stored', enact->'cause'->>'stored_effective_to', v_stored
                USING ERRCODE = '22023';
        END IF;
    ELSE
        -- The blackout as stored, in field_blackouts' own columns (the
        -- record's `cause.stored`), and as the loss the repair priced.
        SELECT jsonb_build_object(
                   'field_id', fb.field_id, 'location_id', fb.location_id,
                   'blackout_from', to_char(fb.blackout_from, 'YYYY-MM-DD'),
                   'blackout_until', to_char(fb.blackout_until, 'YYYY-MM-DD'),
                   'start_minutes', fb.start_minutes, 'end_minutes', fb.end_minutes,
                   'reason', fb.reason),
               jsonb_build_object(
                   'from', to_char(fb.blackout_from, 'YYYY-MM-DD'),
                   'until', to_char(fb.blackout_until, 'YYYY-MM-DD'),
                   'start_minutes', fb.start_minutes, 'end_minutes', fb.end_minutes,
                   'reason', fb.reason),
               CASE WHEN fb.field_id IS NOT NULL THEN ARRAY[fb.field_id::text]
                    ELSE COALESCE((SELECT array_agg(f.id::text ORDER BY f.id::text COLLATE "C")
                                     FROM public.fields f
                                    WHERE f.location_id = fb.location_id
                                      AND f.organization_id = v_org_id), '{}'::text[]) END
          INTO v_bo_stored, v_bo_loss, v_bo_surfaces
          FROM public.field_blackouts fb
         WHERE fb.id = v_field
           AND fb.organization_id = v_org_id;
        IF v_bo_stored IS NULL THEN
            RAISE EXCEPTION 'blackout % is not saved: no field_blackouts row of this organisation has that id; save the blackout first', v_field
                USING ERRCODE = '22023';
        END IF;
        IF v_bo_stored IS DISTINCT FROM enact->'cause'->'stored'
           OR v_bo_loss IS DISTINCT FROM (enact->'cause'->'loss') - 'surface_ids' THEN
            RAISE EXCEPTION 'blackout % changed: stored %, the record claims stored % and loss %', v_field, v_bo_stored, enact->'cause'->'stored', (enact->'cause'->'loss') - 'surface_ids'
                USING ERRCODE = '22023';
        END IF;
        IF v_bo_surfaces IS DISTINCT FROM (
               SELECT COALESCE(array_agg(s ORDER BY s COLLATE "C"), '{}'::text[])
                 FROM jsonb_array_elements_text(enact->'cause'->'loss'->'surface_ids') AS s) THEN
            RAISE EXCEPTION 'blackout % changed: it closes %, the record''s loss.surface_ids are %', v_field, v_bo_surfaces, enact->'cause'->'loss'->'surface_ids'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    -- 5. Idempotency, under the lock, keyed on the enact's own audit row:
    -- immutable, and written only by step 8 of a committed enact. (The run's
    -- `parameters` are not the key: any later save under the same run id
    -- rewrites them.)
    IF EXISTS (SELECT 1 FROM public.audit_log al
                WHERE al.organization_id = v_org_id
                  AND al.action = 'practice.recommendation_enacted'
                  AND al.metadata->>'enact_key' = v_key::text) THEN
        RETURN jsonb_build_object(
            'idempotent', true,
            'run_id', v_key,
            'fingerprint', public.practice_schedule_fingerprint(v_season_id),
            'audited', true,
            'enact_audited', true
        );
    END IF;
    IF EXISTS (SELECT 1 FROM public.scheduler_runs sr WHERE sr.id = v_key) THEN
        RAISE EXCEPTION 'run id % already names a run that is not this enact; mint a new enact key', v_key
            USING ERRCODE = '22023';
    END IF;

    -- S must be a row of this season, of the team the record names.
    SELECT pa.team_id INTO v_team
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.id = v_series
       AND pa.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;
    IF v_team IS NULL OR v_team::text <> enact->'series'->>'team_id' THEN
        RAISE EXCEPTION 'enact series % is not a row of season % held by team %', v_series, v_season_id, enact->'series'->>'team_id'
            USING ERRCODE = '22023';
    END IF;

    -- The ORGANISATION's rows before the write, not the season's: the
    -- writer's insert is scoped by organisation, so a row it creates for
    -- another season's team must still be seen below.
    SELECT COALESCE(array_agg(pa.id), '{}'::uuid[]),
           COALESCE(jsonb_agg(jsonb_build_object(
               'id', pa.id, 'team_id', pa.team_id, 'slot', pa.practice_slot_id,
               'range', pa.effective_date_range::text, 'source', pa.source, 'via', pa.assigned_via)), '[]'::jsonb)
      INTO v_before, v_before_rows
      FROM public.practice_assignments pa
     WHERE pa.organization_id = v_org_id;

    -- 6. The writer, unchanged.
    v_run_data := jsonb_set(run_data, '{parameters}',
        COALESCE(run_data->'parameters', '{}'::jsonb) || jsonb_build_object('enact_key', v_key::text));
    v_result := public.persist_practice_schedule(
        v_run_data, assignments, false, unlock, closes, exceptions, '[]'::jsonb, base_fingerprint);

    -- 7. Only S. Every list the writer returns, and every row it created.
    SELECT string_agg(DISTINCT t.what || ' ' || t.id, ', ') INTO v_stray
      FROM (
            SELECT 'closed' AS what, e.value->>'id' AS id FROM jsonb_array_elements(v_result->'closed') e
            UNION ALL
            SELECT 'unlocked', e.value->>'id' FROM jsonb_array_elements(v_result->'unlocked') e
            UNION ALL
            SELECT 'superseded', e.value->>'id' FROM jsonb_array_elements(v_result->'superseded') e
            UNION ALL
            SELECT 'an exception on', e.value->>'assignment_id' FROM jsonb_array_elements(v_result->'exceptions_recorded') e
            UNION ALL
            SELECT 'withdrew an exception on', e.value->>'assignment_id' FROM jsonb_array_elements(v_result->'exceptions_withdrawn') e
           ) t
     WHERE t.id IS DISTINCT FROM v_series::text;
    IF v_stray IS NOT NULL THEN
        RAISE EXCEPTION 'enact of series % touched more than it: %', v_series, v_stray
            USING ERRCODE = '22023';
    END IF;
    IF v_kind = 'retirement'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'closed') e WHERE e.value->>'id' = v_series::text)
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'superseded') e WHERE e.value->>'id' = v_series::text) THEN
        RAISE EXCEPTION 'enact of series % neither closed nor replaced it: nothing was enacted', v_series
            USING ERRCODE = '22023';
    END IF;
    -- A blackout keeps S's range: it closes, unlocks and replaces nothing.
    IF v_kind = 'blackout'
       AND (jsonb_array_length(COALESCE(v_result->'closed', '[]'::jsonb)) <> 0
            OR jsonb_array_length(COALESCE(v_result->'unlocked', '[]'::jsonb)) <> 0
            OR jsonb_array_length(COALESCE(v_result->'superseded', '[]'::jsonb)) <> 0) THEN
        RAISE EXCEPTION 'blackout enact of series % closed, unlocked or replaced a row: a blackout only adds an exception (closed %, unlocked %, superseded %)',
            v_series, v_result->'closed', v_result->'unlocked', v_result->'superseded'
            USING ERRCODE = '22023';
    END IF;
    -- Every pre-enact row but S (for a blackout, S too) still stands
    -- unchanged in team, slot, range, source and assigned_via: the writer's
    -- upsert (ON CONFLICT DO UPDATE) can rewrite a re-sent row that none of
    -- the lists above names.
    SELECT string_agg(b.value->>'id', ', ') INTO v_stray
      FROM jsonb_array_elements(v_before_rows) b
     WHERE ((b.value->>'id')::uuid <> v_series OR v_kind = 'blackout')
       AND NOT EXISTS (
           SELECT 1 FROM public.practice_assignments pa
            WHERE pa.id = (b.value->>'id')::uuid
              AND pa.team_id IS NOT DISTINCT FROM (b.value->>'team_id')::uuid
              AND pa.practice_slot_id IS NOT DISTINCT FROM (b.value->>'slot')::uuid
              AND pa.effective_date_range IS NOT DISTINCT FROM (b.value->>'range')::daterange
              AND pa.source::text IS NOT DISTINCT FROM b.value->>'source'
              AND pa.assigned_via IS NOT DISTINCT FROM b.value->>'via');
    IF v_stray IS NOT NULL THEN
        RAISE EXCEPTION 'enact of series % changed other rows: %', v_series, v_stray
            USING ERRCODE = '22023';
    END IF;
    SELECT count(*), count(*) FILTER (WHERE pa.team_id <> v_team OR pa.assigned_via <> 'recommendation'),
           count(*) FILTER (WHERE NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(enact->'writes'->'new_rows') n
                WHERE n.value->>'team_id' = pa.team_id::text
                  AND n.value->>'practice_slot_id' = pa.practice_slot_id::text
                  AND n.value->>'effective_date_range' IS NOT NULL
                  AND (n.value->>'effective_date_range')::daterange = pa.effective_date_range))
      INTO v_new_count, v_new_bad, v_new_undeclared
      FROM public.practice_assignments pa
     WHERE pa.organization_id = v_org_id
       AND NOT (pa.id = ANY (v_before));
    IF v_new_bad > 0 THEN
        RAISE EXCEPTION 'enact of series % created % row(s) that are not its team''s assigned_via = recommendation', v_series, v_new_bad
            USING ERRCODE = '22023';
    END IF;
    IF v_new_undeclared > 0 THEN
        RAISE EXCEPTION 'enact of series % created % row(s) its record does not declare in writes.new_rows (team, slot, range)', v_series, v_new_undeclared
            USING ERRCODE = '22023';
    END IF;
    IF v_new_count <> jsonb_array_length(enact->'writes'->'new_rows')
       OR (enact->'decision'->>'kind' = 'rehome' AND v_new_count <> 1)
       OR (enact->'decision'->>'kind' = 'time_tbd'
           AND (v_new_count <> 0 OR jsonb_array_length(v_result->'exceptions_recorded') <> 1))
       OR (v_kind = 'blackout'
           AND (v_new_count <> 0 OR jsonb_array_length(v_result->'exceptions_recorded') <> 1)) THEN
        RAISE EXCEPTION 'enact of series % (%) created % row(s) and recorded % exception(s); the record declares % new row(s)',
            v_series, enact->'decision'->>'kind', v_new_count,
            jsonb_array_length(v_result->'exceptions_recorded'), jsonb_array_length(enact->'writes'->'new_rows')
            USING ERRCODE = '22023';
    END IF;
    -- A blackout's one exception: on S, for this blackout, over S's window,
    -- of the decision's kind (a relocation on a slot of `decision.to`'s
    -- shape, or a TIME TBD with its reason).
    IF v_kind = 'blackout' THEN
        v_exc := v_result->'exceptions_recorded'->0;
        IF v_exc->>'assignment_id' IS DISTINCT FROM v_series::text
           OR v_exc->>'cause_kind' IS DISTINCT FROM 'blackout'
           OR v_exc->>'cause_id' IS DISTINCT FROM v_field::text
           OR (v_exc->>'window')::daterange IS DISTINCT FROM v_window
           OR (enact->'decision'->>'kind' = 'relocate' AND (
                  v_exc->>'kind' IS DISTINCT FROM 'relocated'
                  OR NOT EXISTS (
                      SELECT 1 FROM public.practice_slots ps
                       WHERE ps.id = (v_exc->>'practice_slot_id')::uuid
                         AND ps.organization_id = v_org_id
                         AND COALESCE(ps.field_subunit_id, ps.field_id)::text = enact->'decision'->'to'->>'surface_id'
                         AND upper(ps.day_of_week::text) = enact->'decision'->'to'->>'weekday'
                         AND (extract(epoch FROM ps.start_time) / 60)::integer::text = enact->'decision'->'to'->>'start_minutes'
                         AND (extract(epoch FROM (ps.end_time - ps.start_time)) / 60)::integer::text = enact->'decision'->'to'->>'duration_minutes')))
           OR (enact->'decision'->>'kind' = 'time_tbd' AND (
                  v_exc->>'kind' IS DISTINCT FROM 'time_tbd'
                  OR v_exc->>'tbd_reason' IS DISTINCT FROM enact->'decision'->>'tbd_reason')) THEN
            RAISE EXCEPTION 'blackout enact of series % recorded an exception that is not the one its record declares (on S, cause blackout %, window %, %): %',
                v_series, v_field, v_window, enact->'decision'->>'kind', v_exc
                USING ERRCODE = '22023';
        END IF;
    END IF;

    -- 8. The enact audit row, atomic with the write.
    IF v_kind = 'retirement' THEN
        v_meta := jsonb_set(enact, '{cause,stored_effective_to}', to_jsonb(v_stored::text));
    ELSE
        v_meta := jsonb_set(enact, '{cause,stored}', v_bo_stored);
    END IF;
    v_meta := v_meta || jsonb_build_object('result_fingerprint', v_result->'fingerprint');
    PERFORM public.record_audit_event(
        v_org_id,
        'practice.recommendation_enacted',
        'practice_assignment',
        v_series,
        v_meta
    );

    -- 9.
    RETURN v_result || jsonb_build_object('enact_audited', true, 'idempotent', false);
END;
$$;
REVOKE ALL ON FUNCTION public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) IS
  'Enacts ONE practice repair recommendation, for a field retirement (8.6 3b PR 11b) or a blackout (PR 11d-2): admin-only, never blind, only after the cause is committed (the retirement date, or the saved blackout exactly as recorded), the cause row held FOR SHARE, idempotent by run id, one series only (a blackout adds exactly one exception on it and changes no row), audited as practice.recommendation_enacted in the same transaction. Calls persist_practice_schedule unchanged.';

COMMIT;
