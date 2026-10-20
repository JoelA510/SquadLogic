-- pgTAP: persist_evaluation_run's idempotency key (migration 20261020010000).
-- A replay with the same key returns the first run and writes nothing more; a new key or no key
-- writes a new run; the membership check still refuses the service role first.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(8);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

CREATE TEMP TABLE idem_calls (label text PRIMARY KEY, id uuid);

INSERT INTO idem_calls VALUES ('first', public.persist_evaluation_run(
    jsonb_build_object(
        'organization_id', 'a1111111-1111-1111-1111-111111111111',
        'scheduler_run_type', 'practice',
        'idempotency_key', 'c3333333-3333-3333-3333-333333333333'
    ),
    jsonb_build_array(jsonb_build_object('finding_code', 'IDEM_FIRST')),
    jsonb_build_array(jsonb_build_object('metric_key', 'idem', 'metric_value', 1))
));

INSERT INTO idem_calls VALUES ('replay', public.persist_evaluation_run(
    jsonb_build_object(
        'organization_id', 'a1111111-1111-1111-1111-111111111111',
        'scheduler_run_type', 'practice',
        'idempotency_key', 'c3333333-3333-3333-3333-333333333333'
    ),
    jsonb_build_array(
        jsonb_build_object('finding_code', 'IDEM_REPLAY'),
        jsonb_build_object('finding_code', 'IDEM_REPLAY')
    ),
    jsonb_build_array(jsonb_build_object('metric_key', 'idem', 'metric_value', 2))
));

SELECT is(
    (SELECT id FROM idem_calls WHERE label = 'replay'),
    (SELECT id FROM idem_calls WHERE label = 'first'),
    'a replay with the same key returns the first run''s id'
);

SELECT is(
    (SELECT count(*)::int FROM public.evaluation_runs
      WHERE idempotency_key = 'c3333333-3333-3333-3333-333333333333'),
    1,
    'a replay with the same key writes no second run'
);

SELECT is(
    (SELECT array_agg(finding_code ORDER BY finding_code) FROM public.evaluation_findings
      WHERE evaluation_run_id = (SELECT id FROM idem_calls WHERE label = 'first')),
    ARRAY['IDEM_FIRST']::text[],
    'a replay with the same key writes no findings: only the first call''s remain'
);

SELECT is(
    (SELECT count(*)::int FROM public.evaluation_metrics
      WHERE evaluation_run_id = (SELECT id FROM idem_calls WHERE label = 'first')),
    1,
    'a replay with the same key writes no metrics'
);

INSERT INTO idem_calls VALUES ('second-key', public.persist_evaluation_run(
    jsonb_build_object(
        'organization_id', 'a1111111-1111-1111-1111-111111111111',
        'idempotency_key', 'c4444444-4444-4444-4444-444444444444'
    )
));

SELECT isnt(
    (SELECT id FROM idem_calls WHERE label = 'second-key'),
    (SELECT id FROM idem_calls WHERE label = 'first'),
    'a different key writes a different run'
);

INSERT INTO idem_calls VALUES ('no-key-1', public.persist_evaluation_run(
    jsonb_build_object('organization_id', 'a1111111-1111-1111-1111-111111111111')
));
INSERT INTO idem_calls VALUES ('no-key-2', public.persist_evaluation_run(
    jsonb_build_object('organization_id', 'a1111111-1111-1111-1111-111111111111')
));

SELECT isnt(
    (SELECT id FROM idem_calls WHERE label = 'no-key-2'),
    (SELECT id FROM idem_calls WHERE label = 'no-key-1'),
    'with no key, two calls write two runs, as before'
);

SELECT throws_ok(
    $$ SELECT public.persist_evaluation_run(
         jsonb_build_object('organization_id', 'a1111111-1111-1111-1111-111111111111',
                            'idempotency_key', 'not-a-uuid')
       ) $$,
    '22P02',
    NULL,
    'a key that is not a uuid is refused 22P02'
);

-- The membership check runs before the key is read, so the service role (no auth.uid()) cannot
-- replay a key to learn a run id.
SET LOCAL role = 'service_role';
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';
SELECT throws_like(
    $$ SELECT public.persist_evaluation_run(
         jsonb_build_object('organization_id', 'a1111111-1111-1111-1111-111111111111',
                            'idempotency_key', 'c3333333-3333-3333-3333-333333333333')
       ) $$,
    'Not authorized%',
    'a replay without membership is refused by the membership check'
);

SELECT * FROM finish();
ROLLBACK;
