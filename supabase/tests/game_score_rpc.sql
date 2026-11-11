-- pgTAP: game score updates are org-scoped, role-scoped, and audited.
-- Since 20261122010000 (F11-2) the game is a saved game and its score a row of `game_scores`; the game below is seeded
-- through the real save. The rules of the new table are in game_scores.sql.
-- Since 20261028010000 (plan docs/changes/2026-10-22-admin-focus.md, R6)
-- score entry is an admin function behind the league's `score_entry`
-- setting: a coach scores nothing, and an admin only while it is on. Since 20261104010000 no coach
-- signs in: the persona that was a coach (Charlie) is a signed-in user with no membership.

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

-- 20261122010000 (F11-2): a score names a SAVED game (game_assignments), so the game is seeded the way the product makes
-- one: through the real save, as the organization's admin. The save gives the game its id; `pg_temp.game_a()` reads it
-- back by its sides. No row is put in the legacy `games` table (no schedule save ever filled it).
INSERT INTO public.locations (id, organization_id, name) VALUES
    ('a1111111-1111-1111-1111-00000000a0c1', 'a1111111-1111-1111-1111-111111111111', 'Score Park');
INSERT INTO public.fields (id, organization_id, location_id, name) VALUES
    ('a1111111-1111-1111-1111-00000000a0f1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000000a0c1', 'Score Field');
INSERT INTO public.game_slots (id, organization_id, field_id, division_id, start, "end", slot_date, start_time, end_time, week_index, capacity) VALUES
    ('a1111111-1111-1111-1111-00000000a0d1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000000a0f1', 'a1111111-1111-1111-1111-11111111abcd',
     '2026-04-04T08:00:00Z', '2026-04-04T09:00:00Z', '2026-04-04', '08:00', '09:00', 1, 1);

CREATE FUNCTION pg_temp.game_a() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $f$
    SELECT id FROM public.game_assignments
     WHERE home_team_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND away_team_id = 'aaaaaaaa-0000-0000-0000-000000000003'
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.game_a() TO PUBLIC;

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';
SELECT public.persist_game_schedule(
    jsonb_build_object('organization_id', 'a1111111-1111-1111-1111-111111111111', 'season_settings_id', 'a1111111-1111-1111-1111-111111111aaa',
                       'run_type', 'game', 'status', 'completed', 'completed_at', clock_timestamp()),
    jsonb_build_array(jsonb_build_object(
        'home_team_id', 'aaaaaaaa-0000-0000-0000-000000000001', 'away_team_id', 'aaaaaaaa-0000-0000-0000-000000000003',
        'game_slot_id', 'a1111111-1111-1111-1111-00000000a0d1', 'field_id', 'a1111111-1111-1111-1111-00000000a0f1',
        'week_index', 1, 'start', '2026-04-04T08:00:00Z', 'end', '2026-04-04T09:00:00Z', 'source', 'auto', 'division', 'Org A U10'))) \gset saved_
SET LOCAL "request.jwt.claims" TO '';

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"role":"admin"}}';

SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            pg_temp.game_a(),
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
            pg_temp.game_a(),
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
        FROM public.game_scores
        WHERE game_id = pg_temp.game_a()
    )::int,
    2,
    'home score is persisted'
);

SELECT is(
    (
        SELECT score_away
        FROM public.game_scores
        WHERE game_id = pg_temp.game_a()
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
          AND resource_id = pg_temp.game_a()
    )::int,
    1,
    'score update writes one audit row'
);

SELECT is(
    (
        SELECT metadata->>'source'
        FROM public.audit_log
        WHERE action = 'competition.score_updated'
          AND resource_id = pg_temp.game_a()
    ),
    'pgtap',
    'audit metadata includes caller-supplied context'
);

SELECT is(
    (
        SELECT (public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            pg_temp.game_a(),
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
          AND resource_id = pg_temp.game_a()
    )::int,
    1,
    'idempotent no-op does not write another audit row'
);

RESET ROLE;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333","app_metadata":{"role":"coach"}}';

-- 20261028010000: no coach scores; Charlie is no member at all.
SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            pg_temp.game_a(),
            5::smallint,
            5::smallint
        )
    $$,
    '42501',
    NULL,
    'a signed-in non-member is refused'
);

RESET ROLE;
INSERT INTO public.coaches (id, organization_id, full_name, email, status)
VALUES ('c3333333-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111',
        'Charlie Coach-A', 'charlie@test.local', 'active');
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
            pg_temp.game_a(),
            3::smallint,
            1::smallint
        )
    $$,
    '42501',
    NULL,
    'a non-member is refused even when the home team''s current coach record carries their name: score entry is an admin''s'
);

RESET ROLE;
SELECT is(
    (
        SELECT score_home
        FROM public.game_scores
        WHERE game_id = pg_temp.game_a()
    )::int,
    2,
    'the attempt leaves the score as the admin entered it'
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222","app_metadata":{"role":"admin"}}';

SELECT throws_ok(
    $$
        SELECT public.update_game_score(
            'a1111111-1111-1111-1111-111111111111',
            pg_temp.game_a(),
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
            pg_temp.game_a(),
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
            pg_temp.game_a(),
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
