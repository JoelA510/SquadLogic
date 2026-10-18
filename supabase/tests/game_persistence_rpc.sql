-- pgTAP: game persistence RPC is current-schema compatible and org-scoped.
--
-- Since 20261018060000 (docs/PLAN_AUDIT_IN_TRANSACTION.md) it requires an
-- organization admin (a coach could save the season's games before: plan
-- section 1.1, pinned below), writes its `game.saved` audit row in the save's
-- own transaction, and refuses a caller with no user. Every refusal runs as a
-- user and pins its message: run as the service role, each would now be
-- refused 42501 for having no user and pass for the wrong reason.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(27);

INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    (
        'aaaaaaaa-0000-0000-0000-000000000003',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd',
        'A-Team 2'
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.locations (id, organization_id, name)
VALUES
    (
        'a1111111-1111-1111-1111-00000000f101',
        'a1111111-1111-1111-1111-111111111111',
        'Org A Game Complex'
    ),
    (
        'b2222222-2222-2222-2222-00000000f102',
        'b2222222-2222-2222-2222-222222222222',
        'Org B Game Complex'
    );

INSERT INTO public.fields (id, organization_id, location_id, name)
VALUES
    (
        'a1111111-1111-1111-1111-00000000fa11',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-00000000f101',
        'Org A Game Field 1'
    ),
    (
        'b2222222-2222-2222-2222-00000000fb12',
        'b2222222-2222-2222-2222-222222222222',
        'b2222222-2222-2222-2222-00000000f102',
        'Org B Game Field 1'
    );

INSERT INTO public.game_slots (
    id,
    organization_id,
    field_id,
    division_id,
    start,
    "end",
    slot_date,
    start_time,
    end_time,
    week_index,
    capacity
)
VALUES
    (
        'a1111111-1111-1111-1111-00000000ca01',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-00000000fa11',
        'a1111111-1111-1111-1111-11111111abcd',
        '2026-04-04T08:00:00Z',
        '2026-04-04T09:00:00Z',
        '2026-04-04',
        '08:00',
        '09:00',
        1,
        1
    ),
    (
        'b2222222-2222-2222-2222-00000000cb02',
        'b2222222-2222-2222-2222-222222222222',
        'b2222222-2222-2222-2222-00000000fb12',
        'b2222222-2222-2222-2222-22222222bcde',
        '2026-04-04T08:00:00Z',
        '2026-04-04T09:00:00Z',
        '2026-04-04',
        '08:00',
        '09:00',
        1,
        1
    );

-- Atomicity: an audit row that cannot be written fails the whole save
-- (SLA01): no run, no game. A trigger planted for this test, inside its own
-- rolled-back transaction, refuses the `game.saved` insert; it is dropped
-- right after. Planted as the test's own superuser role; the claims name Org
-- A's admin.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE FUNCTION public.pgtap_refuse_save_audit() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'planted audit failure' USING ERRCODE = 'P0001';
END;
$fn$;
CREATE TRIGGER pgtap_refuse_save_audit BEFORE INSERT ON public.audit_log
    FOR EACH ROW WHEN (NEW.action = 'game.saved')
    EXECUTE FUNCTION public.pgtap_refuse_save_audit();

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000da0a',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
                'game_slot_id', 'a1111111-1111-1111-1111-00000000ca01',
                'week_index', 1,
                'start', '2026-04-04T08:00:00Z',
                'end', '2026-04-04T09:00:00Z',
                'source', 'auto'
            ))
        )
    $$,
    'SLA01',
    NULL,
    'a game save whose audit row cannot be written fails with SLA01'
);

SELECT is(
    (SELECT count(*) FROM public.scheduler_runs WHERE id = 'a1111111-1111-1111-1111-00000000da0a')::int,
    0,
    'the save that failed its audit left no run'
);

SELECT is(
    (SELECT count(*) FROM public.game_assignments WHERE organization_id = 'a1111111-1111-1111-1111-111111111111')::int,
    0,
    'the save that failed its audit left no game assignment'
);

DROP TRIGGER pgtap_refuse_save_audit ON public.audit_log;
DROP FUNCTION public.pgtap_refuse_save_audit();

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    public.persist_game_schedule(
        jsonb_build_object(
            'id', 'a1111111-1111-1111-1111-00000000da01',
            'organization_id', 'a1111111-1111-1111-1111-111111111111',
            'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
            'run_type', 'game',
            'status', 'completed',
            'parameters', jsonb_build_object('source', 'pgtap'),
            'metrics', '{}'::jsonb,
            'results', jsonb_build_object('assignment_count', 1)
        ),
        jsonb_build_array(jsonb_build_object(
            'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
            'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
            'game_slot_id', 'a1111111-1111-1111-1111-00000000ca01',
            'field_id', 'a1111111-1111-1111-1111-00000000fa11',
            'division', 'Org A U10',
            'week_index', 1,
            'start', '2026-04-04T08:00:00Z',
            'end', '2026-04-04T09:00:00Z',
            'source', 'locked'
        ))
    )::text,
    'a1111111-1111-1111-1111-00000000da01',
    'persist_game_schedule returns the scheduler run id'
);

SELECT is(
    (
        SELECT organization_id::text
        FROM public.scheduler_runs
        WHERE id = 'a1111111-1111-1111-1111-00000000da01'
    ),
    'a1111111-1111-1111-1111-111111111111',
    'scheduler run is persisted under the current organization'
);

SELECT is(
    (
        SELECT created_by::text
        FROM public.scheduler_runs
        WHERE id = 'a1111111-1111-1111-1111-00000000da01'
    ),
    '11111111-1111-1111-1111-111111111111',
    'authenticated callers cannot spoof the scheduler run creator'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.audit_log
        WHERE action = 'game.saved'
          AND resource_type = 'scheduler_run'
          AND resource_id = 'a1111111-1111-1111-1111-00000000da01'
          AND user_id = '11111111-1111-1111-1111-111111111111'
          AND organization_id = 'a1111111-1111-1111-1111-111111111111'
    )::int,
    1,
    'the save writes one game.saved row on its run, attributed to the caller'
);

SELECT is(
    (
        SELECT metadata
        FROM public.audit_log
        WHERE action = 'game.saved'
          AND resource_id = 'a1111111-1111-1111-1111-00000000da01'
    ),
    jsonb_build_object(
        'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
        'game_count', 1
    ),
    'the game.saved row carries the season and the count it saved'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.game_assignments
        WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND away_team_id = 'aaaaaaaa-0000-0000-0000-000000000003'
          AND game_slot_id = 'a1111111-1111-1111-1111-00000000ca01'
          AND week_index = 1
    )::int,
    1,
    'game assignment is inserted once'
);

SELECT is(
    (
        SELECT assignment_source::text
        FROM public.game_assignments
        WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND away_team_id = 'aaaaaaaa-0000-0000-0000-000000000003'
          AND game_slot_id = 'a1111111-1111-1111-1111-00000000ca01'
          AND week_index = 1
    ),
    'manual',
    'locked assignments are normalized to manual source'
);

SELECT is(
    (
        SELECT run_id::text
        FROM public.game_assignments
        WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND away_team_id = 'aaaaaaaa-0000-0000-0000-000000000003'
          AND game_slot_id = 'a1111111-1111-1111-1111-00000000ca01'
          AND week_index = 1
    ),
    'a1111111-1111-1111-1111-00000000da01',
    'game assignment is linked to the persisted scheduler run'
);

SELECT lives_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000da01',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
                'slot_id', 'a1111111-1111-1111-1111-00000000ca01',
                'week_index', 1,
                'start', '2026-04-04T08:00:00Z',
                'end', '2026-04-04T09:00:00Z',
                'source', 'manual'
            ))
        )
    $$,
    're-running the same game snapshot is idempotent'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.game_assignments
        WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND away_team_id = 'aaaaaaaa-0000-0000-0000-000000000003'
          AND game_slot_id = 'a1111111-1111-1111-1111-00000000ca01'
          AND week_index = 1
    )::int,
    1,
    'idempotent re-run does not duplicate the assignment'
);

SELECT is(
    public.persist_game_schedule(
        jsonb_build_object(
            'id', 'a1111111-1111-1111-1111-00000000da02',
            'organization_id', 'a1111111-1111-1111-1111-111111111111',
            'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
            'run_type', 'game',
            'status', 'completed'
        ),
        jsonb_build_array(jsonb_build_object(
            'homeTeamId', 'aaaaaaaa-0000-0000-0000-000000000001',
            'awayTeamId', 'aaaaaaaa-0000-0000-0000-000000000003',
            'slotId', 'a1111111-1111-1111-1111-00000000ca01',
            'weekIndex', 1,
            'start', '2026-04-04T08:00:00Z',
            'end', '2026-04-04T09:00:00Z',
            'source', 'auto'
        ))
    )::text,
    'a1111111-1111-1111-1111-00000000da02',
    'later persisted snapshots accept camelCase payloads and return the new run id'
);

SELECT is(
    (
        SELECT run_id::text
        FROM public.game_assignments
        WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND away_team_id = 'aaaaaaaa-0000-0000-0000-000000000003'
          AND game_slot_id = 'a1111111-1111-1111-1111-00000000ca01'
          AND week_index = 1
    ),
    'a1111111-1111-1111-1111-00000000da02',
    'idempotent assignment upsert re-links to the latest persisted scheduler run'
);

SELECT lives_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000da03',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            jsonb_build_array(
                jsonb_build_object(
                    'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                    'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
                    'game_slot_id', 'a1111111-1111-1111-1111-00000000ca01',
                    'week_index', 1,
                    'start', '2026-04-04T08:00:00Z',
                    'end', '2026-04-04T09:00:00Z',
                    'source', 'auto'
                ),
                jsonb_build_object(
                    'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                    'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
                    'game_slot_id', 'a1111111-1111-1111-1111-00000000ca01',
                    'week_index', 1,
                    'start', '2026-04-04T08:00:00Z',
                    'end', '2026-04-04T09:00:00Z',
                    'source', 'locked'
                )
            )
        )
    $$,
    'duplicate matchup/slot/week rows in one payload are deduplicated before upsert'
);

SELECT is(
    (
        SELECT run_id::text
        FROM public.game_assignments
        WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND away_team_id = 'aaaaaaaa-0000-0000-0000-000000000003'
          AND game_slot_id = 'a1111111-1111-1111-1111-00000000ca01'
          AND week_index = 1
    ),
    'a1111111-1111-1111-1111-00000000da03',
    'deduplicated duplicate payload relinks the assignment to the persisted run'
);

-- Plan section 1.1, the coach witness: Charlie, a coach of Org A (a member,
-- not an admin), saved a run and a game assignment here before
-- 20261018060000. Now refused by the admin check, and nothing is written.
RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000da09',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
                'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'game_slot_id', 'a1111111-1111-1111-1111-00000000ca01',
                'week_index', 2,
                'start', '2026-04-11T08:00:00Z',
                'end', '2026-04-11T09:00:00Z',
                'source', 'auto'
            ))
        )
    $$,
    '42501',
    'caller is not an admin of organization a1111111-1111-1111-1111-111111111111',
    'a coach of the organization cannot save its game schedule'
);

RESET ROLE;
SELECT is(
    (
        SELECT count(*)
        FROM public.scheduler_runs
        WHERE id = 'a1111111-1111-1111-1111-00000000da09'
    )::int
    + (
        SELECT count(*)
        FROM public.game_assignments
        WHERE run_id = 'a1111111-1111-1111-1111-00000000da09'
           OR (home_team_id = 'aaaaaaaa-0000-0000-0000-000000000003' AND week_index = 2)
    )::int,
    0,
    'the coach''s refused save wrote no run and no game assignment'
);

SET LOCAL role = 'service_role';
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';

-- No user, no audit actor: refused before anything is read or written.
SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000da0b',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            '[]'::jsonb
        )
    $$,
    '42501',
    'persist_game_schedule needs a signed-in caller to audit the save',
    'a caller with no user (the service role) is refused: there is no one to audit'
);

-- The refusals below run as Org A's admin, so each is refused for its own
-- reason, which its message pins.
RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de01',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'home_team_id', 'bbbbbbbb-0000-0000-0000-000000000002',
                'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
                'game_slot_id', 'a1111111-1111-1111-1111-00000000ca01',
                'week_index', 1,
                'start', '2026-04-04T08:00:00Z',
                'end', '2026-04-04T09:00:00Z',
                'source', 'auto'
            ))
        )
    $$,
    '42501',
    'home team bbbbbbbb-0000-0000-0000-000000000002 belongs to another organization',
    'RPC rejects assignments whose home team belongs to another organization'
);

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de02',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'away_team_id', 'bbbbbbbb-0000-0000-0000-000000000002',
                'game_slot_id', 'a1111111-1111-1111-1111-00000000ca01',
                'week_index', 1,
                'start', '2026-04-04T08:00:00Z',
                'end', '2026-04-04T09:00:00Z',
                'source', 'auto'
            ))
        )
    $$,
    '42501',
    'away team bbbbbbbb-0000-0000-0000-000000000002 belongs to another organization',
    'RPC rejects assignments whose away team belongs to another organization'
);

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de03',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
                'game_slot_id', 'b2222222-2222-2222-2222-00000000cb02',
                'week_index', 1,
                'start', '2026-04-04T08:00:00Z',
                'end', '2026-04-04T09:00:00Z',
                'source', 'auto'
            ))
        )
    $$,
    '42501',
    'game slot b2222222-2222-2222-2222-00000000cb02 belongs to another organization',
    'RPC rejects assignments whose game slot belongs to another organization'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de04',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            '[]'::jsonb
        )
    $$,
    '42501',
    'caller is not an admin of organization a1111111-1111-1111-1111-111111111111',
    'Org B user cannot persist an Org A game run'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de05',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'b2222222-2222-2222-2222-222222222bbb',
                'run_type', 'game',
                'status', 'completed'
            ),
            '[]'::jsonb
        )
    $$,
    '42501',
    'season_settings_id b2222222-2222-2222-2222-222222222bbb does not belong to organization a1111111-1111-1111-1111-111111111111',
    'season/org mismatch fails'
);

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de06',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'practice',
                'status', 'completed'
            ),
            '[]'::jsonb
        )
    $$,
    '22023',
    'persist_game_schedule only accepts game runs',
    'invalid run type fails'
);

SELECT throws_ok(
    $$
        SELECT public.persist_game_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000de07',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'game',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'game_slot_id', 'a1111111-1111-1111-1111-00000000ca01',
                'week_index', 1,
                'start', '2026-04-04T08:00:00Z',
                'end', '2026-04-04T09:00:00Z',
                'source', 'auto'
            ))
        )
    $$,
    '22023',
    'home_team_id and away_team_id must differ',
    'same team assignments fail'
);

SELECT * FROM finish();

ROLLBACK;
