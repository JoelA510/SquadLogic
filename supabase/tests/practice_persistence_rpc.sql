-- pgTAP: practice persistence RPC is current-schema compatible and org-scoped.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(15);

INSERT INTO public.locations (id, organization_id, name)
VALUES
    (
        'a1111111-1111-1111-1111-00000000f001',
        'a1111111-1111-1111-1111-111111111111',
        'Org A Practice Complex'
    ),
    (
        'b2222222-2222-2222-2222-00000000f002',
        'b2222222-2222-2222-2222-222222222222',
        'Org B Practice Complex'
    );

INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES
    (
        'a1111111-1111-1111-1111-00000000fa01',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-00000000f001',
        'Org A Field 1'
    ),
    (
        'b2222222-2222-2222-2222-00000000fb02',
        'b2222222-2222-2222-2222-222222222222',
        'b2222222-2222-2222-2222-00000000f002',
        'Org B Field 1'
    );

INSERT INTO public.practice_slots (
    id,
    organization_id,
    field_id,
    day_of_week,
    start_time,
    end_time,
    valid_from,
    valid_until
)
VALUES
    (
        'a1111111-1111-1111-1111-00000000aa01',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-00000000fa01',
        'mon',
        '17:00',
        '18:00',
        '2026-03-01',
        '2026-06-01'
    ),
    (
        'b2222222-2222-2222-2222-00000000bb02',
        'b2222222-2222-2222-2222-222222222222',
        'b2222222-2222-2222-2222-00000000fb02',
        'tue',
        '17:00',
        '18:00',
        '2026-03-01',
        '2026-06-01'
    );

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    public.persist_practice_schedule(
        jsonb_build_object(
            'id', 'a1111111-1111-1111-1111-00000000dead',
            'organization_id', 'a1111111-1111-1111-1111-111111111111',
            'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
            'run_type', 'practice',
            'status', 'completed',
            'parameters', jsonb_build_object('source', 'pgtap'),
            'metrics', '{}'::jsonb,
            'results', jsonb_build_object('assignment_count', 1)
        ),
        jsonb_build_array(jsonb_build_object(
            'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
            'practice_slot_id', 'a1111111-1111-1111-1111-00000000aa01',
            'effective_date_range', '[2026-03-01,2026-06-01)',
            'source', 'locked'
        ))
    )->>'run_id',
    'a1111111-1111-1111-1111-00000000dead',
    'persist_practice_schedule returns the scheduler run id in its jsonb result'
);

SELECT is(
    (
        SELECT organization_id::text
        FROM public.scheduler_runs
        WHERE id = 'a1111111-1111-1111-1111-00000000dead'
    ),
    'a1111111-1111-1111-1111-111111111111',
    'scheduler run is persisted under the current organization'
);

SELECT is(
    (
        SELECT created_by::text
        FROM public.scheduler_runs
        WHERE id = 'a1111111-1111-1111-1111-00000000dead'
    ),
    '11111111-1111-1111-1111-111111111111',
    'authenticated callers cannot spoof the scheduler run creator'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.practice_assignments
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND practice_slot_id = 'a1111111-1111-1111-1111-00000000aa01'
          AND effective_date_range = '[2026-03-01,2026-06-01)'::daterange
    )::int,
    1,
    'practice assignment is inserted once'
);

SELECT is(
    (
        SELECT source::text
        FROM public.practice_assignments
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND practice_slot_id = 'a1111111-1111-1111-1111-00000000aa01'
          AND effective_date_range = '[2026-03-01,2026-06-01)'::daterange
    ),
    'manual',
    'locked assignments are normalized to manual source'
);

SELECT is(
    (
        SELECT run_id::text
        FROM public.practice_assignments
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND practice_slot_id = 'a1111111-1111-1111-1111-00000000aa01'
          AND effective_date_range = '[2026-03-01,2026-06-01)'::daterange
    ),
    'a1111111-1111-1111-1111-00000000dead',
    'practice assignment is linked to the persisted scheduler run'
);

SELECT lives_ok(
    $$
        SELECT public.persist_practice_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000dead',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'practice',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'practice_slot_id', 'a1111111-1111-1111-1111-00000000aa01',
                'effective_date_range', '[2026-03-01,2026-06-01)',
                'source', 'manual'
            ))
        )
    $$,
    're-running the same practice snapshot is idempotent'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.practice_assignments
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND practice_slot_id = 'a1111111-1111-1111-1111-00000000aa01'
          AND effective_date_range = '[2026-03-01,2026-06-01)'::daterange
    )::int,
    1,
    'idempotent re-run does not duplicate the assignment'
);

SELECT is(
    public.persist_practice_schedule(
        jsonb_build_object(
            'id', 'a1111111-1111-1111-1111-00000000beef',
            'organization_id', 'a1111111-1111-1111-1111-111111111111',
            'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
            'run_type', 'practice',
            'status', 'completed'
        ),
        jsonb_build_array(jsonb_build_object(
            'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
            'practice_slot_id', 'a1111111-1111-1111-1111-00000000aa01',
            'effective_date_range', '[2026-03-01,2026-06-01)',
            'source', 'auto'
        ))
    )->>'run_id',
    'a1111111-1111-1111-1111-00000000beef',
    'later persisted snapshots return the new scheduler run id'
);

SELECT is(
    (
        SELECT run_id::text
        FROM public.practice_assignments
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND practice_slot_id = 'a1111111-1111-1111-1111-00000000aa01'
          AND effective_date_range = '[2026-03-01,2026-06-01)'::daterange
    ),
    'a1111111-1111-1111-1111-00000000beef',
    'idempotent assignment upsert re-links to the latest persisted scheduler run'
);

RESET ROLE;
SET LOCAL role = 'service_role';
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';

SELECT throws_ok(
    $$
        SELECT public.persist_practice_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de01',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'practice',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'team_id', 'bbbbbbbb-0000-0000-0000-000000000002',
                'practice_slot_id', 'a1111111-1111-1111-1111-00000000aa01',
                'effective_date_range', '[2026-03-01,2026-06-01)',
                'source', 'auto'
            ))
        )
    $$,
    '42501',
    NULL,
    'RPC rejects assignments whose team belongs to another organization'
);

SELECT throws_ok(
    $$
        SELECT public.persist_practice_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de02',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'practice',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'practice_slot_id', 'b2222222-2222-2222-2222-00000000bb02',
                'effective_date_range', '[2026-03-01,2026-06-01)',
                'source', 'auto'
            ))
        )
    $$,
    '42501',
    NULL,
    'RPC rejects assignments whose slot belongs to another organization'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$
        SELECT public.persist_practice_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de03',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'practice',
                'status', 'completed'
            ),
            '[]'::jsonb
        )
    $$,
    '42501',
    NULL,
    'Org B admin cannot persist an Org A practice run'
);

RESET ROLE;
SET LOCAL role = 'service_role';
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';

SELECT throws_ok(
    $$
        SELECT public.persist_practice_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de04',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'b2222222-2222-2222-2222-222222222bbb',
                'run_type', 'practice',
                'status', 'completed'
            ),
            '[]'::jsonb
        )
    $$,
    '42501',
    NULL,
    'RPC rejects season settings outside the requested organization'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
    $$
        SELECT public.persist_practice_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de05',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            '[]'::jsonb
        )
    $$,
    '22023',
    NULL,
    'RPC rejects non-practice run types'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
