-- pgTAP: game score updates are org-scoped, role-scoped, and audited.
-- Since 20261028010000 (plan docs/changes/2026-10-22-admin-focus.md, R6)
-- score entry is an admin function behind the league's `score_entry`
-- setting: a coach scores nothing, and an admin only while it is on.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(15);

INSERT INTO public.teams (id, organization_id, division_id, name)
VALUES
    (
        'aaaaaaaa-0000-0000-0000-000000000003',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-11111111abcd',
        'A-Team 2'
    ),
    (
        'bbbbbbbb-0000-0000-0000-000000000004',
        'b2222222-2222-2222-2222-222222222222',
        'b2222222-2222-2222-2222-22222222bcde',
        'B-Team 2'
    )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.games (
    id,
    organization_id,
    season_id,
    home_team_id,
    away_team_id,
    start_time,
    score_home,
    score_away
)
VALUES
    (
        'a1111111-1111-1111-1111-00000000aa01',
        'a1111111-1111-1111-1111-111111111111',
        'a1111111-1111-1111-1111-111111111aaa',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'aaaaaaaa-0000-0000-0000-000000000003',
        timezone('utc', now()) - interval '1 day',
        NULL,
        NULL
    ),
    (
        'b2222222-2222-2222-2222-00000000bb01',
        'b2222222-2222-2222-2222-222222222222',
        'b2222222-2222-2222-2222-222222222bbb',
        'bbbbbbbb-0000-0000-0000-000000000002',
        'bbbbbbbb-0000-0000-0000-000000000004',
        timezone('utc', now()) - interval '1 day',
        NULL,
        NULL
    )
ON CONFLICT (id) DO NOTHING;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';

SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-00000000aa01',
            2::smallint,
            1::smallint
        )
    $$,
    '55000',
    NULL,
    'with score entry off (the default) an Org A admin is refused'
);

RESET ROLE;
UPDATE public.organizations SET feature_flags = '{"score_entry": true}'::jsonb
 WHERE id = 'a1111111-1111-1111-1111-111111111111';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';

SELECT lives_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-00000000aa01',
            2::smallint,
            1::smallint,
            '{"source":"pgtap"}'::jsonb
        )
    $$,
    'Org A admin can update an Org A game score'
);

SELECT is(
    (
        SELECT score_home
        FROM public.games
        WHERE id = 'a1111111-1111-1111-1111-00000000aa01'
    )::int,
    2,
    'home score is persisted'
);

SELECT is(
    (
        SELECT score_away
        FROM public.games
        WHERE id = 'a1111111-1111-1111-1111-00000000aa01'
    )::int,
    1,
    'away score is persisted'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND action = 'competition.score_updated'
          AND resource_type = 'game'
          AND resource_id = 'a1111111-1111-1111-1111-00000000aa01'
    )::int,
    1,
    'score update writes one audit row'
);

SELECT is(
    (
        SELECT metadata->>'source'
        FROM public.audit_log
        WHERE action = 'competition.score_updated'
          AND resource_id = 'a1111111-1111-1111-1111-00000000aa01'
    ),
    'pgtap',
    'audit metadata includes caller-supplied context'
);

SELECT is(
    (
        SELECT (public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-00000000aa01',
            2::smallint,
            1::smallint
        )->>'changed')::boolean
    ),
    false,
    'repeating the same score is an idempotent no-op'
);

SELECT is(
    (
        SELECT count(*)
        FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
          AND action = 'competition.score_updated'
          AND resource_id = 'a1111111-1111-1111-1111-00000000aa01'
    )::int,
    1,
    'idempotent no-op does not write another audit row'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333","app_metadata":{"role":"coach"}}';

-- 20261028010000: no coach scores; this one coaches neither team.
SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-00000000aa01',
            5::smallint,
            5::smallint
        )
    $$,
    '42501',
    NULL,
    'an Org A coach who coaches neither team is refused'
);

RESET ROLE;
INSERT INTO public.coaches (id, organization_id, user_id, full_name, email, status)
VALUES ('c3333333-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'Charlie Coach-A', 'charlie@test.local', 'active');
INSERT INTO public.team_coach_assignments
    (organization_id, team_id, coach_id, role, effective_from, effective_to, started_via, ended_via)
VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
        'c3333333-0000-4000-8000-000000000001', 'lead',
        public.team_local_today('aaaaaaaa-0000-0000-0000-000000000001') - 1, NULL, 'pgtap', NULL);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333","app_metadata":{"role":"coach"}}';

SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-00000000aa01',
            3::smallint,
            1::smallint
        )
    $$,
    '42501',
    NULL,
    'the home team''s current coach is refused: score entry is an admin''s'
);

SELECT is(
    (
        SELECT score_home
        FROM public.games
        WHERE id = 'a1111111-1111-1111-1111-00000000aa01'
    )::int,
    2,
    'the coach''s attempt leaves the score as the admin entered it'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222","app_metadata":{"role":"admin"}}';

SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-00000000aa01',
            4::smallint,
            1::smallint
        )
    $$,
    '42501',
    NULL,
    'Org B admin cannot update an Org A game'
);

SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'b2222222-2222-2222-2222-222222222222',
            'a1111111-1111-1111-1111-00000000aa01',
            4::smallint,
            1::smallint
        )
    $$,
    '42501',
    NULL,
    'game id must belong to the requested organization'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';

SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            'a1111111-1111-1111-1111-00000000aa01',
            -1::smallint,
            1::smallint
        )
    $$,
    '23514',
    NULL,
    'negative scores are rejected'
);

SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            NULL::uuid,
            1::smallint,
            1::smallint
        )
    $$,
    '23502',
    NULL,
    'missing game id is rejected'
);

SELECT * FROM finish();
ROLLBACK;
