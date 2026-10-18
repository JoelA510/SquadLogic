-- pgTAP: team persistence RPC is current-schema compatible, org-scoped, and
-- treats submitted team rosters as authoritative for the teams in the payload.
--
-- Since 20261018070000 (docs/PLAN_AUDIT_IN_TRANSACTION.md) it also writes its
-- `team.saved` audit row in the save's own transaction, refuses a caller with
-- no user, and applies its admin check to every caller. So every refusal below
-- runs as an admin and pins its message: run as the service role, each would
-- now be refused 42501 for having no user and pass for the wrong reason.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(24);

INSERT INTO public.players (id, organization_id, division_id, first_name, last_name)
VALUES
    (
        'a1111111-1111-1111-1111-00000000a001',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd',
        'Ava',
        'Admin'
    ),
    (
        'a1111111-1111-1111-1111-00000000a002',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd',
        'Amir',
        'Admin'
    ),
    (
        'a1111111-1111-1111-1111-00000000a003',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd',
        'Ana',
        'Admin'
    ),
    (
        'b2222222-2222-2222-2222-00000000b001',
        'b2222222-2222-2222-2222-222222222222',
        'b2222222-2222-2222-2222-22222222bcde',
        'Ben',
        'Bob'
    )
ON CONFLICT (id) DO NOTHING;

-- Atomicity: an audit row that cannot be written fails the whole save
-- (SLA01): no run, no team. A trigger planted for this test, inside its own
-- rolled-back transaction, refuses the `team.saved` insert; it is dropped
-- right after. Planted as the test's own superuser role; the claims name Org
-- A's admin.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';
CREATE FUNCTION public.pgtap_refuse_save_audit() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION 'planted audit failure' USING ERRCODE = 'P0001';
END;
$fn$;
CREATE TRIGGER pgtap_refuse_save_audit BEFORE INSERT ON public.audit_log
    FOR EACH ROW WHEN (NEW.action = 'team.saved')
    EXECUTE FUNCTION public.pgtap_refuse_save_audit();

SELECT throws_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea0a',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'team',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'id', 'aaaaaaaa-0000-0000-0000-00000000000a',
                'division_id', 'a1111111-1111-1111-1111-11111111abcd',
                'name', 'Unaudited Team'
            )),
            '[]'::jsonb
        )
    $$,
    'SLA01',
    NULL,
    'a team save whose audit row cannot be written fails with SLA01'
);

SELECT is(
    (SELECT count(*) FROM public.scheduler_runs WHERE id = 'a1111111-1111-1111-1111-00000000ea0a')::int,
    0,
    'the save that failed its audit left no run'
);

SELECT is(
    (SELECT count(*) FROM public.teams WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a')::int,
    0,
    'the save that failed its audit left no team'
);

DROP TRIGGER pgtap_refuse_save_audit ON public.audit_log;
DROP FUNCTION public.pgtap_refuse_save_audit();

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';

SELECT is(
    public.persist_team_schedule(
        jsonb_build_object(
            'id', 'a1111111-1111-1111-1111-00000000ea01',
            'organization_id', 'a1111111-1111-1111-1111-111111111111',
            'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
            'run_type', 'team',
            'status', 'completed',
            'parameters', jsonb_build_object('source', 'pgtap'),
            'metrics', jsonb_build_object('updatedTeams', 1),
            'results', jsonb_build_object('team_count', 1)
        ),
        jsonb_build_array(jsonb_build_object(
            'id', 'aaaaaaaa-0000-0000-0000-000000000001',
            'organization_id', 'a1111111-1111-1111-1111-111111111111',
            'division_id', 'a1111111-1111-1111-1111-11111111abcd',
            'name', 'A-Team Updated'
        )),
        jsonb_build_array(
            jsonb_build_object(
                'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'player_id', 'a1111111-1111-1111-1111-00000000a001',
                'role', 'captain',
                'source', 'locked'
            ),
            jsonb_build_object(
                'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'player_id', 'a1111111-1111-1111-1111-00000000a002',
                'role', 'player',
                'source', 'auto'
            )
        )
    )::text,
    'a1111111-1111-1111-1111-00000000ea01',
    'persist_team_schedule returns the scheduler run id'
);

SELECT is(
    (
        SELECT organization_id::text
        FROM public.scheduler_runs
        WHERE id = 'a1111111-1111-1111-1111-00000000ea01'
    ),
    'a1111111-1111-1111-1111-111111111111',
    'scheduler run is persisted under the current organization'
);

SELECT is(
    (
        SELECT created_by::text
        FROM public.scheduler_runs
        WHERE id = 'a1111111-1111-1111-1111-00000000ea01'
    ),
    '11111111-1111-1111-1111-111111111111',
    'authenticated callers cannot spoof the scheduler run creator'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.audit_log
        WHERE action = 'team.saved'
          AND resource_type = 'scheduler_run'
          AND resource_id = 'a1111111-1111-1111-1111-00000000ea01'
          AND user_id = '11111111-1111-1111-1111-111111111111'
          AND organization_id = 'a1111111-1111-1111-1111-111111111111'
    )::int,
    1,
    'the save writes one team.saved row on its run, attributed to the caller'
);

SELECT is(
    (
        SELECT metadata
        FROM public.audit_log
        WHERE action = 'team.saved'
          AND resource_id = 'a1111111-1111-1111-1111-00000000ea01'
    ),
    jsonb_build_object(
        'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
        'team_count', 1,
        'team_player_count', 2
    ),
    'the team.saved row carries the season and the counts it saved'
);

SELECT is(
    (
        SELECT name
        FROM public.teams
        WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001'
    ),
    'A-Team Updated',
    'team row is upserted under the current schema'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.team_players
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    )::int,
    2,
    'team roster rows are inserted'
);

SELECT is(
    (
        SELECT source::text
        FROM public.team_players
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
          AND player_id = 'a1111111-1111-1111-1111-00000000a001'
    ),
    'manual',
    'locked team-player rows are normalized to manual source'
);

SELECT lives_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea01',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'team',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'id', 'aaaaaaaa-0000-0000-0000-000000000001',
                'division_id', 'a1111111-1111-1111-1111-11111111abcd',
                'name', 'A-Team Updated'
            )),
            jsonb_build_array(
                jsonb_build_object(
                    'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                    'player_id', 'a1111111-1111-1111-1111-00000000a001',
                    'role', 'captain',
                    'source', 'manual'
                ),
                jsonb_build_object(
                    'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
                    'player_id', 'a1111111-1111-1111-1111-00000000a002',
                    'role', 'player',
                    'source', 'auto'
                )
            )
        )
    $$,
    're-running the same team snapshot is idempotent'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.team_players
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    )::int,
    2,
    'idempotent re-run does not duplicate team-player rows'
);

SELECT is(
    public.persist_team_schedule(
        jsonb_build_object(
            'id', 'a1111111-1111-1111-1111-00000000ea02',
            'organization_id', 'a1111111-1111-1111-1111-111111111111',
            'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
            'run_type', 'team',
            'status', 'completed'
        ),
        jsonb_build_array(jsonb_build_object(
            'id', 'aaaaaaaa-0000-0000-0000-000000000001',
            'division_id', 'a1111111-1111-1111-1111-11111111abcd',
            'name', 'A-Team Updated'
        )),
        jsonb_build_array(jsonb_build_object(
            'team_id', 'aaaaaaaa-0000-0000-0000-000000000001',
            'player_id', 'a1111111-1111-1111-1111-00000000a001',
            'role', 'captain',
            'source', 'manual'
        ))
    )::text,
    'a1111111-1111-1111-1111-00000000ea02',
    'later persisted team snapshots return the new scheduler run id'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.team_players
        WHERE team_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    )::int,
    1,
    'submitted roster is authoritative for teams in the payload'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333","app_metadata":{"role":"coach"}}';

SELECT throws_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea03',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'team',
                'status', 'completed'
            ),
            '[]'::jsonb,
            '[]'::jsonb
        )
    $$,
    '42501',
    'caller is not an admin of organization a1111111-1111-1111-1111-111111111111',
    'org members without admin role cannot persist team schedules'
);

RESET ROLE;
SET LOCAL role = 'service_role';
SET LOCAL "request.jwt.claims" TO '{"role":"service_role"}';

-- No user, no audit actor: refused before anything is read or written.
SELECT throws_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea0b',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'team',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'id', 'aaaaaaaa-0000-0000-0000-00000000000b',
                'division_id', 'a1111111-1111-1111-1111-11111111abcd',
                'name', 'Service Role Team'
            )),
            '[]'::jsonb
        )
    $$,
    '42501',
    'persist_team_schedule needs a signed-in caller to audit the save',
    'a caller with no user (the service role) is refused: there is no one to audit'
);

SELECT is(
    (SELECT count(*) FROM public.scheduler_runs WHERE id = 'a1111111-1111-1111-1111-00000000ea0b')::int,
    0,
    'the refused service-role save wrote no run'
);

-- The refusals below run as Org A's admin, so each is refused for its own
-- reason, which its message pins.
RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';

SELECT throws_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea04',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'team',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'id', 'aaaaaaaa-0000-0000-0000-000000000004',
                'division_id', 'b2222222-2222-2222-2222-22222222bcde',
                'name', 'Wrong Division Team'
            )),
            '[]'::jsonb
        )
    $$,
    '42501',
    'division_id b2222222-2222-2222-2222-22222222bcde belongs to another organization',
    'RPC rejects teams whose division belongs to another organization'
);

SELECT throws_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea05',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'team',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'id', 'aaaaaaaa-0000-0000-0000-000000000004',
                'division_id', 'a1111111-1111-1111-1111-11111111abcd',
                'name', 'A-Team 2'
            )),
            jsonb_build_array(jsonb_build_object(
                'team_id', 'aaaaaaaa-0000-0000-0000-000000000004',
                'player_id', 'b2222222-2222-2222-2222-00000000b001',
                'source', 'auto'
            ))
        )
    $$,
    '42501',
    'team_player player_id b2222222-2222-2222-2222-00000000b001 belongs to another organization',
    'RPC rejects team-player rows whose player belongs to another organization'
);

SELECT throws_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea06',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'b2222222-2222-2222-2222-222222222bbb',
                'run_type', 'team',
                'status', 'completed'
            ),
            '[]'::jsonb,
            '[]'::jsonb
        )
    $$,
    '42501',
    'season_settings_id b2222222-2222-2222-2222-222222222bbb does not belong to organization a1111111-1111-1111-1111-111111111111',
    'RPC rejects season settings from another organization'
);

SELECT throws_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea07',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'practice',
                'status', 'completed'
            ),
            '[]'::jsonb,
            '[]'::jsonb
        )
    $$,
    '22023',
    'persist_team_schedule only accepts team runs',
    'RPC rejects invalid run types'
);

SELECT throws_ok(
    $$
        SELECT public.persist_team_schedule(
            jsonb_build_object(
                'id', 'a1111111-1111-1111-1111-00000000ea08',
                'organization_id', 'a1111111-1111-1111-1111-111111111111',
                'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                'run_type', 'team',
                'status', 'completed'
            ),
            jsonb_build_array(jsonb_build_object(
                'id', 'bbbbbbbb-0000-0000-0000-000000000002',
                'division_id', 'a1111111-1111-1111-1111-11111111abcd',
                'name', 'Spoofed Team'
            )),
            '[]'::jsonb
        )
    $$,
    '42501',
    'team id bbbbbbbb-0000-0000-0000-000000000002 belongs to another organization',
    'RPC rejects existing team ids from another organization'
);

SELECT is(
    public.persist_team_schedule(
        jsonb_build_object(
            'id', 'a1111111-1111-1111-1111-00000000ea09',
            'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
            'run_type', 'team',
            'status', 'completed'
        ),
        '[]'::jsonb,
        '[]'::jsonb
    )::text,
    'a1111111-1111-1111-1111-00000000ea09',
    'RPC can derive organization from season settings'
);

SELECT * FROM finish();

ROLLBACK;
