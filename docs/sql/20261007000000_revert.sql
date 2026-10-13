-- Revert for 20261007000000_enact_practice_recommendation_blackout.sql
--
-- Restores `enact_practice_recommendation` to its 20261004000000 body,
-- byte for byte (retirement-only, no Q10 lock), and drops the
-- `enact_lock_cause_row` helper that 20261007000000 added. Nothing else: the
-- migration created no table, and `persist_practice_schedule` was never
-- touched, so it stays exactly as 20261002000000 left it.
--
-- What a blackout enact wrote stays: its exceptions are ordinary
-- `practice_exceptions` rows (`cause_kind = 'blackout'`), live and locked
-- (plan decision 6), and its audit rows stay under
-- `practice.recommendation_enacted`. Audit history is not this revert's to
-- erase. The counts are printed so the transcript of a revert says what it
-- leaves behind. After this revert a blackout enact is refused again
-- (`cause.kind` must be `retirement`).
--
-- The restored body below is the 20261004000000 text, copied verbatim; the
-- verify block checks it by the md5 of `prosrc` (the 20261005000000 revert's
-- precedent), so a hand edit cannot pass as a restore.

BEGIN;

DO $warn$
DECLARE
    v_enacts integer;
    v_exceptions integer;
BEGIN
    SELECT count(*) INTO v_enacts
      FROM public.audit_log
     WHERE action = 'practice.recommendation_enacted'
       AND metadata->'cause'->>'kind' = 'blackout';
    SELECT count(*) INTO v_exceptions
      FROM public.practice_exceptions
     WHERE cause_kind = 'blackout'
       AND withdrawn_at IS NULL
       AND run_id IN (SELECT (al.metadata->>'run_id')::uuid
                        FROM public.audit_log al
                       WHERE al.action = 'practice.recommendation_enacted'
                         AND al.metadata->'cause'->>'kind' = 'blackout');
    RAISE NOTICE 'this revert makes blackout enact refused again; % blackout practice.recommendation_enacted audit row(s) and % live exception(s) they wrote stay', v_enacts, v_exceptions;
END;
$warn$;

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
    v_loss_from date;
    v_stored date;
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
    IF enact->'schema_version' IS DISTINCT FROM '1'::jsonb
       OR COALESCE(enact->>'enact_key', '') !~ c_uuid
       OR enact->>'run_id' IS DISTINCT FROM enact->>'enact_key'
       OR run_data->>'id' IS DISTINCT FROM enact->>'enact_key'
       OR enact->>'season_settings_id' IS DISTINCT FROM run_data->>'season_settings_id'
       OR enact->>'base_fingerprint' IS DISTINCT FROM base_fingerprint
       OR enact->'result_fingerprint' IS DISTINCT FROM 'null'::jsonb
       OR enact->'cause'->>'kind' IS DISTINCT FROM 'retirement'
       OR COALESCE(enact->'cause'->>'id', '') !~ c_uuid
       OR COALESCE(enact->'cause'->'loss'->>'from', '') !~ c_date
       OR COALESCE(enact->'cause'->>'stored_effective_to', '') !~ c_date
       OR COALESCE(enact->'series'->>'assignment_id', '') !~ c_uuid
       OR COALESCE(enact->'series'->>'team_id', '') !~ c_uuid
       OR COALESCE(enact->'decision'->>'kind', '') NOT IN ('rehome', 'time_tbd')
       OR jsonb_typeof(enact->'writes'->'new_rows') IS DISTINCT FROM 'array'
       OR enact->'unlock' IS DISTINCT FROM COALESCE(unlock, '[]'::jsonb)
       OR enact->'writes'->'closes' IS DISTINCT FROM COALESCE(closes, '[]'::jsonb)
       OR enact->'writes'->'exceptions' IS DISTINCT FROM to_jsonb(jsonb_array_length(COALESCE(exceptions, '[]'::jsonb)))
       OR (jsonb_array_length(COALESCE(unlock, '[]'::jsonb)) > 0
           AND enact->'prompt'->'accepted' IS DISTINCT FROM 'true'::jsonb) THEN
        RAISE EXCEPTION 'enact record is malformed or does not describe the write sent (run id, season, base fingerprint, unlock, closes and exceptions must match; a retirement only; result_fingerprint null)'
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
        PERFORM (enact->'cause'->>'stored_effective_to')::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        RAISE EXCEPTION 'enact record carries an impossible date (loss.from %, stored_effective_to %)',
            enact->'cause'->'loss'->>'from', enact->'cause'->>'stored_effective_to'
            USING ERRCODE = '22023';
    END;

    -- 4. The writer's own season lock (re-entrant within this transaction).
    PERFORM pg_advisory_xact_lock(
        hashtextextended('persist_practice_schedule:' || v_org_id::text || ':' || v_season_id::text, 0)
    );

    -- 2a. The commit gate (Q3), immediately after the lock: the STORED date
    -- decides, never the record's claim.
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
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'closed') e WHERE e.value->>'id' = v_series::text)
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result->'superseded') e WHERE e.value->>'id' = v_series::text) THEN
        RAISE EXCEPTION 'enact of series % neither closed nor replaced it: nothing was enacted', v_series
            USING ERRCODE = '22023';
    END IF;
    -- Every pre-enact row but S still stands unchanged in team, slot, range,
    -- source and assigned_via: the writer's upsert (ON CONFLICT DO UPDATE)
    -- can rewrite a re-sent row that none of the lists above names.
    SELECT string_agg(b.value->>'id', ', ') INTO v_stray
      FROM jsonb_array_elements(v_before_rows) b
     WHERE (b.value->>'id')::uuid <> v_series
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
           AND (v_new_count <> 0 OR jsonb_array_length(v_result->'exceptions_recorded') <> 1)) THEN
        RAISE EXCEPTION 'enact of series % (%) created % row(s) and recorded % exception(s); the record declares % new row(s)',
            v_series, enact->'decision'->>'kind', v_new_count,
            jsonb_array_length(v_result->'exceptions_recorded'), jsonb_array_length(enact->'writes'->'new_rows')
            USING ERRCODE = '22023';
    END IF;

    -- 8. The enact audit row, atomic with the write.
    v_meta := jsonb_set(enact, '{cause,stored_effective_to}', to_jsonb(v_stored::text))
              || jsonb_build_object('result_fingerprint', v_result->'fingerprint');
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
  'Enacts ONE practice repair recommendation (retirement-only, 8.6 3b PR 11b): admin-only, never blind, only after the retirement is committed, idempotent by run id, one series only, audited as practice.recommendation_enacted in the same transaction. Calls persist_practice_schedule unchanged.';

DROP FUNCTION IF EXISTS public.enact_lock_cause_row(uuid, text, uuid);

DO $verify$
DECLARE
    c_sig constant text := 'public.enact_practice_recommendation(jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb)';
    v_md5 text;
BEGIN
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = c_sig::regprocedure;
    -- md5 of the 20261004000000 body, taken from that file's dollar-quoted text.
    IF v_md5 IS DISTINCT FROM '67175ed38f1c3852813e7eda745920a5' THEN
        RAISE EXCEPTION 'the revert did not restore the 20261004000000 enact body byte for byte (md5 %)', v_md5;
    END IF;
    IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = c_sig::regprocedure)
       OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = c_sig::regprocedure)
          IS DISTINCT FROM ARRAY['search_path=public'] THEN
        RAISE EXCEPTION 'the revert changed the SECURITY mode or search_path of %', c_sig;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname = 'enact_lock_cause_row') THEN
        RAISE EXCEPTION 'enact_lock_cause_row survived the revert';
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname = 'persist_practice_schedule') <> 1 THEN
        RAISE EXCEPTION 'the revert left other than exactly one persist_practice_schedule';
    END IF;
    RAISE NOTICE 'revert verified: enact_practice_recommendation is the 20261004000000 body (md5 %), SECURITY INVOKER, search_path=public; enact_lock_cause_row is gone; persist_practice_schedule is untouched', v_md5;
END;
$verify$;

COMMIT;
