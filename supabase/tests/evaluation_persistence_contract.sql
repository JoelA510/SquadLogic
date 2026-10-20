-- pgTAP: current evaluation persistence contract is the JSONB overload only.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(8);

SELECT ok(
    to_regprocedure('public.persist_evaluation_run(uuid,text,jsonb,integer)') IS NULL,
    'legacy four-arg persist_evaluation_run overload is absent'
);

SELECT ok(
    to_regprocedure('public.persist_evaluation_run(jsonb,jsonb,jsonb)') IS NOT NULL,
    'current JSONB persist_evaluation_run overload remains installed'
);

SELECT ok(
    EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'persist_evaluation_run'
          AND pg_get_function_identity_arguments(p.oid) = 'p_run_data jsonb, p_findings jsonb, p_metrics jsonb'
          AND p.prosecdef
          AND p.proconfig @> ARRAY['search_path=public']
    ),
    'current JSONB overload is SECURITY DEFINER with pinned search_path'
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

CREATE TEMP TABLE persisted_evaluation AS
SELECT public.persist_evaluation_run(
    jsonb_build_object(
        'organization_id', 'a1111111-1111-1111-1111-111111111111',
        'scheduler_run_type', 'practice',
        'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
        'status', 'completed',
        'findings_severity', 'warnings',
        'metrics_summary', jsonb_build_object('fairness_index', 0.93),
        'input_snapshot', jsonb_build_object('source', 'pgtap'),
        'execution_time_ms', 42,
        'created_by', '11111111-1111-1111-1111-111111111111',
        'started_at', '2026-05-04T00:00:00Z',
        'completed_at', '2026-05-04T00:00:01Z'
    ),
    jsonb_build_array(
        jsonb_build_object(
            'severity', 'warning',
            'finding_code', 'BALANCE_WARNING',
            'description', 'Fixture warning',
            'affected_entities', jsonb_build_array('practice')
        )
    ),
    jsonb_build_array(
        jsonb_build_object(
            'metric_key', 'fairness_index',
            'metric_value', 0.93,
            'thresholds', jsonb_build_object('min', 0.8)
        )
    )
) AS id;

SELECT ok(
    (SELECT id FROM persisted_evaluation) IS NOT NULL,
    'current JSONB overload returns an evaluation run id'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.evaluation_runs
        WHERE id = (SELECT id FROM persisted_evaluation)
          AND organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND scheduler_run_type = 'practice'
          AND status = 'completed'
    )::int,
    1,
    'current JSONB overload stores the evaluation run with org and status'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.evaluation_findings
        WHERE evaluation_run_id = (SELECT id FROM persisted_evaluation)
          AND organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND finding_code = 'BALANCE_WARNING'
    )::int,
    1,
    'current JSONB overload stores evaluation findings'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.evaluation_metrics
        WHERE evaluation_run_id = (SELECT id FROM persisted_evaluation)
          AND organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND metric_key = 'fairness_index'
    )::int,
    1,
    'current JSONB overload stores evaluation metrics'
);

-- The Edge functions' service-role client carries no auth.uid(), so the membership check
-- refuses it: auto-scheduler and fairness-scoring must call this RPC as the caller (#621).
SET LOCAL role = 'service_role';
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';
SELECT throws_like(
    $$ SELECT public.persist_evaluation_run(
         jsonb_build_object('organization_id', 'a1111111-1111-1111-1111-111111111111'),
         '[]'::jsonb,
         '[]'::jsonb
       ) $$,
    'Not authorized%',
    'the service role (no auth.uid()) is refused: callers must persist as the user'
);

SELECT * FROM finish();
ROLLBACK;
