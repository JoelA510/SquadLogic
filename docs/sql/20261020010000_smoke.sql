-- Smoke checks for 20261020010000_evaluation_run_idempotency.sql
--
-- What it proves, as members of an organization (prelude.sql stubs
-- `auth.uid()` from `request.jwt.claim.sub`):
--   * a call with a key writes one run with its findings and metrics; a second
--     call with the same key (and a different payload) returns the same id and
--     writes no second run, finding or metric;
--   * the key is per call and per organization: a second key writes a second
--     run, and the first key in another organization writes that organization's
--     own run;
--   * with no key the behaviour is unchanged: two calls write two runs;
--   * a caller outside the organization is refused by the membership check
--     before any lookup, and a key that is not a uuid is refused 22P02; neither
--     writes anything;
--   * the posture is unchanged: SECURITY DEFINER, search_path=public, EXECUTE for
--     authenticated and not anon; the unique index is partial on the key.
--
-- Not exercised here: two concurrent calls with one key. That path is
-- PostgreSQL's ON CONFLICT on a unique index (the second insert waits for the
-- first transaction, then does nothing and reads the committed run); one
-- session cannot run it.
--
-- Wrapped in BEGIN ... ROLLBACK: it leaves nothing behind for later stages.
-- Every id is generated and every email is `@example.test`; there is no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_a uuid := gen_random_uuid();
    v_b uuid := gen_random_uuid();
    v_out uuid := gen_random_uuid();
    v_org uuid;
    v_org2 uuid;
    v_key uuid := gen_random_uuid();
    v_key2 uuid := gen_random_uuid();
    v_id1 uuid;
    v_id2 uuid;
    v_id3 uuid;
    v_id4 uuid;
    v_id5 uuid;
    v_code text;
    v_msg text;
    v_runs integer;
    v_one jsonb := jsonb_build_array(jsonb_build_object(
        'severity', 'warning', 'finding_code', 'SMOKE_ONE', 'description', 'first'));
    v_two jsonb := jsonb_build_array(
        jsonb_build_object('severity', 'warning', 'finding_code', 'SMOKE_TWO', 'description', 'second'),
        jsonb_build_object('severity', 'warning', 'finding_code', 'SMOKE_TWO', 'description', 'second'));
    v_metric jsonb := jsonb_build_array(jsonb_build_object('metric_key', 'smoke', 'metric_value', 1));
BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
        (v_a, 'idem-a@example.test', '{"password_length": 16}'),
        (v_b, 'idem-b@example.test', '{"password_length": 16}'),
        (v_out, 'idem-out@example.test', '{"password_length": 16}');
    INSERT INTO public.profiles (id, email) VALUES
        (v_a, 'idem-a@example.test'), (v_b, 'idem-b@example.test'), (v_out, 'idem-out@example.test')
        ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Idem', 'smoke-org-idem')
        RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug) VALUES ('Smoke Org Idem Two', 'smoke-org-idem-two')
        RETURNING id INTO v_org2;
    INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
        (v_org, v_a, 'admin'), (v_org2, v_b, 'admin');

    PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

    -- (a) One key, two calls: one run, the first call's findings and metrics only.
    v_id1 := public.persist_evaluation_run(
        jsonb_build_object('organization_id', v_org, 'scheduler_run_type', 'practice',
                           'idempotency_key', v_key),
        v_one, v_metric);
    v_id2 := public.persist_evaluation_run(
        jsonb_build_object('organization_id', v_org, 'scheduler_run_type', 'practice',
                           'idempotency_key', v_key, 'status', 'failed'),
        v_two, v_metric);
    IF v_id1 IS NULL OR v_id2 IS DISTINCT FROM v_id1 THEN
        RAISE EXCEPTION 'a replay with the same key returned % instead of the first run %', v_id2, v_id1;
    END IF;
    IF (SELECT count(*) FROM public.evaluation_runs WHERE organization_id = v_org) <> 1 THEN
        RAISE EXCEPTION 'a replay with the same key wrote a second run';
    END IF;
    IF (SELECT status FROM public.evaluation_runs WHERE id = v_id1) <> 'completed' THEN
        RAISE EXCEPTION 'a replay with the same key rewrote the first run';
    END IF;
    IF (SELECT count(*) FROM public.evaluation_findings WHERE evaluation_run_id = v_id1) <> 1
       OR (SELECT count(*) FROM public.evaluation_findings WHERE evaluation_run_id = v_id1
                                                            AND finding_code = 'SMOKE_ONE') <> 1
       OR (SELECT count(*) FROM public.evaluation_metrics WHERE evaluation_run_id = v_id1) <> 1 THEN
        RAISE EXCEPTION 'a replay with the same key wrote findings or metrics: % findings, % metrics',
            (SELECT count(*) FROM public.evaluation_findings WHERE evaluation_run_id = v_id1),
            (SELECT count(*) FROM public.evaluation_metrics WHERE evaluation_run_id = v_id1);
    END IF;
    RAISE NOTICE 'a replay with the same key returned the first run and wrote nothing: 1 run, 1 finding, 1 metric';

    -- (b) A second key is a second run; the first key in another organization is that organization's run.
    v_id3 := public.persist_evaluation_run(
        jsonb_build_object('organization_id', v_org, 'idempotency_key', v_key2), v_one, '[]'::jsonb);
    IF v_id3 IS NULL OR v_id3 = v_id1 THEN
        RAISE EXCEPTION 'a second key did not write a second run';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_b::text, true);
    v_id4 := public.persist_evaluation_run(
        jsonb_build_object('organization_id', v_org2, 'idempotency_key', v_key), v_one, '[]'::jsonb);
    IF v_id4 IS NULL OR v_id4 IN (v_id1, v_id3)
       OR (SELECT organization_id FROM public.evaluation_runs WHERE id = v_id4) <> v_org2 THEN
        RAISE EXCEPTION 'the same key in another organization did not write that organization''s own run';
    END IF;
    RAISE NOTICE 'a second key wrote a second run, and the first key in another organization wrote that organization''s own';

    -- (c) No key: two calls, two runs, as before.
    PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
    SELECT count(*) INTO v_runs FROM public.evaluation_runs WHERE organization_id = v_org;
    v_id5 := public.persist_evaluation_run(jsonb_build_object('organization_id', v_org), v_one, '[]'::jsonb);
    PERFORM public.persist_evaluation_run(jsonb_build_object('organization_id', v_org), v_one, '[]'::jsonb);
    IF (SELECT count(*) FROM public.evaluation_runs WHERE organization_id = v_org) <> v_runs + 2
       OR (SELECT idempotency_key FROM public.evaluation_runs WHERE id = v_id5) IS NOT NULL THEN
        RAISE EXCEPTION 'two calls with no key did not write two keyless runs';
    END IF;
    RAISE NOTICE 'with no key, two calls wrote two runs, as before';

    -- (d) Refusals write nothing.
    SELECT count(*) INTO v_runs FROM public.evaluation_runs WHERE organization_id = v_org;
    PERFORM set_config('request.jwt.claim.sub', v_out::text, true);
    v_code := NULL;
    BEGIN
        PERFORM public.persist_evaluation_run(
            jsonb_build_object('organization_id', v_org, 'idempotency_key', v_key), v_one, '[]'::jsonb);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_code IS NULL OR v_msg NOT LIKE 'Not authorized%' THEN
        RAISE EXCEPTION 'a caller outside the organization replaying a key was not refused by the membership check (got %)',
            coalesce(v_msg, 'success');
    END IF;
    PERFORM set_config('request.jwt.claim.sub', v_a::text, true);
    v_code := NULL;
    BEGIN
        PERFORM public.persist_evaluation_run(
            jsonb_build_object('organization_id', v_org, 'idempotency_key', 'not-a-uuid'), v_one, '[]'::jsonb);
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    END;
    IF v_code IS DISTINCT FROM '22P02' THEN
        RAISE EXCEPTION 'a key that is not a uuid was not refused 22P02 (got %)', coalesce(v_code, 'success');
    END IF;
    IF (SELECT count(*) FROM public.evaluation_runs WHERE organization_id = v_org) <> v_runs THEN
        RAISE EXCEPTION 'a refused call wrote a run';
    END IF;
    RAISE NOTICE 'an outsider replaying a key was refused by the membership check and a malformed key 22P02, 2 of 2; nothing written';

    -- (e) Posture.
    IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public']
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
              FROM pg_proc p
             WHERE p.oid = 'public.persist_evaluation_run(jsonb, jsonb, jsonb)'::regprocedure) THEN
        RAISE EXCEPTION 'persist_evaluation_run lost its posture (definer, search_path, grants)';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
         WHERE i.indexrelid = 'public.evaluation_runs_org_idempotency_key_idx'::regclass
           AND i.indisunique
           AND pg_get_expr(i.indpred, i.indrelid) = '(idempotency_key IS NOT NULL)'
    ) THEN
        RAISE EXCEPTION 'evaluation_runs_org_idempotency_key_idx is not a unique index partial on the key';
    END IF;
    RAISE NOTICE 'posture unchanged: SECURITY DEFINER, search_path=public, EXECUTE for authenticated and not anon; the key index is unique and partial';
END;
$$;

ROLLBACK;
