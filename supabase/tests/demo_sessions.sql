-- pgTAP: the demo organization (migration 20261030010000; plan
-- docs/changes/2026-10-22-demo-mode.md, D3).
--
--   * `start_demo_session` copies the league (counts from `demo_seed`, U4 practice-only with its
--     four 30-minute sessions reserved to it and 15 minutes apart, rosters and coaches whole),
--     flags it a demo expiring in 30 minutes, makes the visitor its admin and writes one
--     `demo.started` row; a second call returns the same demo; a signed-in non-anonymous caller and
--     the `anon` role are refused;
--   * the expiry cannot be changed by a client: a demo's admin cannot clear or move it, a real
--     organization's admin cannot mark theirs a demo, and each still renames their own
--     organization (the control that the refusal is the trigger's);
--   * the people fence: a demo's roster still moves, a team is still deleted and a rating still
--     changes, but no name, note or buddy request changes and no player or coach is added or deleted,
--     whether through an RPC, the invoker `apply_player_patch`, a direct write or the table's owner;
--     every function the catalogue shows writing players or coaches is tested here or declared;
--   * the import fence: `create_import_job` and every table an import writes first refuse a demo (so
--     no job exists for a finalize or rollback RPC to act on), and the same call works in a real
--     organization;
--   * the anonymous fence: `initialize_new_tenant`, `create_org_invite` and `redeem_org_invite`
--     refuse an anonymous caller (each with a working control), an anonymous session joins no
--     organization but its own demo and adds no one else to it, and the catalogue of every function
--     `authenticated` may execute is each on a list that says what an anonymous caller may do with it;
--   * the buckets refuse an object under a demo's folder, and take one under a real one;
--   * expiry: after it and before the purge, a demo's member is no member and no admin, reads nothing
--     and writes nothing;
--   * the purge deletes the expired demo and every row that names it (enumerated from the catalogue,
--     including an append-only baseline), the visitor, and an hour-old anonymous user with no
--     membership, and leaves a live demo, a young anonymous user, real organizations and real users;
--     it logs each run; a user something still references is skipped and counted;
--   * `demo_health` is healthy after a run, and reports a stale expired demo, a stale log and no log;
--   * the cap: at ten live demos the next visitor is refused, and is served once one has expired; one
--     live demo per visitor holds even without the lock (the unique index).
-- Concurrency (the lock) cannot be seen in one transaction: docs/sql/20261030010000_smoke.sql races it
-- with dblink.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(107);

-- ── 0. Setup (as the test's own superuser role) ─────────────────────────────
-- Anonymous visitors V1-V6 and a real user, Dave. The password-length trigger asks every new auth user
-- for a password_length in its metadata (20240405180000).
INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role, is_anonymous, created_at)
VALUES
    ('aaaaaaaa-0000-4000-8000-0000000000a1', NULL, '{"password_length": 12}', 'authenticated', 'authenticated', true, now()),
    ('aaaaaaaa-0000-4000-8000-0000000000a2', NULL, '{"password_length": 12}', 'authenticated', 'authenticated', true, now()),
    ('aaaaaaaa-0000-4000-8000-0000000000a3', NULL, '{"password_length": 12}', 'authenticated', 'authenticated', true, now() - interval '2 hours'),
    ('aaaaaaaa-0000-4000-8000-0000000000a4', NULL, '{"password_length": 12}', 'authenticated', 'authenticated', true, now()),
    ('aaaaaaaa-0000-4000-8000-0000000000a5', NULL, '{"password_length": 12}', 'authenticated', 'authenticated', true, now() - interval '2 hours'),
    ('aaaaaaaa-0000-4000-8000-0000000000a6', NULL, '{"password_length": 12}', 'authenticated', 'authenticated', true, now());
INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role)
VALUES ('dddddddd-0000-4000-8000-0000000000d1', 'dave@test.local',
        '{"full_name": "Dave Real", "password_length": 12}', 'authenticated', 'authenticated');

CREATE TEMP TABLE t_ids (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
GRANT SELECT ON t_ids TO authenticated;

-- ── 1. start_demo_session ───────────────────────────────────────────────────
SELECT ok(
    EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'demo.started'),
    'demo.started is registered in audit_actions'
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT is(public.start_demo_session() ->> 'existing', 'false', 'an anonymous visitor starts a demo');
RESET role;
INSERT INTO t_ids SELECT 'demoA', id FROM public.organizations WHERE demo_owner = 'aaaaaaaa-0000-4000-8000-0000000000a1';

SELECT ok(
    (SELECT demo_expires_at BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes'
        FROM public.organizations WHERE id = (SELECT id FROM t_ids WHERE name = 'demoA')),
    'the demo expires in 30 minutes'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_log
      WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND action = 'demo.started'
        AND user_id = 'aaaaaaaa-0000-4000-8000-0000000000a1'),
    1,
    'one demo.started row is written, by the visitor'
);
SELECT is(
    (SELECT array[
        (SELECT count(*) FROM public.divisions WHERE organization_id = o),
        (SELECT count(*) FROM public.teams WHERE organization_id = o),
        (SELECT count(*) FROM public.players WHERE organization_id = o),
        (SELECT count(*) FROM public.team_players WHERE organization_id = o),
        (SELECT count(*) FROM public.coaches WHERE organization_id = o),
        (SELECT count(*) FROM public.team_coach_assignments WHERE organization_id = o),
        (SELECT count(*) FROM public.locations WHERE organization_id = o),
        (SELECT count(*) FROM public.fields WHERE organization_id = o),
        (SELECT count(*) FROM public.field_subunits WHERE organization_id = o),
        (SELECT count(*) FROM public.practice_slots WHERE organization_id = o)
     ] FROM (SELECT id AS o FROM t_ids WHERE name = 'demoA') x),
    ARRAY[
        (SELECT count(*) FROM demo_seed.divisions),
        (SELECT count(*) FROM demo_seed.teams),
        (SELECT count(*) FROM demo_seed.players),
        (SELECT count(*) FROM demo_seed.players),
        (SELECT count(*) FROM demo_seed.coaches),
        (SELECT count(*) FROM demo_seed.team_coaches),
        (SELECT count(*) FROM demo_seed.locations),
        (SELECT count(*) FROM demo_seed.fields),
        (SELECT count(*) FROM demo_seed.field_subunits),
        (SELECT count(*) FROM demo_seed.practice_slots)
    ]::bigint[],
    'the copy holds every seeded division, team, player (each on a roster), coach, assignment and facility row'
);
SELECT is(
    (SELECT array[count(*), count(DISTINCT team_id)]
       FROM public.players WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')),
    ARRAY[1259, 128]::bigint[],
    'the demo league is 1,259 players on 128 teams'
);
-- The team run the Teams, Practices and Games pages read their teams from (the practice auto-scheduler
-- is disabled without teams): one completed run of the season holding all 128 teams.
SELECT is(
    (SELECT array[count(*), (SELECT sum(jsonb_array_length(e.value))
                               FROM jsonb_each(r.results -> 'teamsByDivision') e)]
       FROM public.scheduler_runs r
      WHERE r.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')
        AND r.run_type = 'team' AND r.status = 'completed'
      GROUP BY r.id),
    ARRAY[1, 128]::bigint[],
    'the demo has one completed team run holding its 128 teams'
);
SELECT is(
    (SELECT count(*)::int FROM public.teams t
      WHERE t.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')
        AND (t.coach_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM public.team_coach_assignments a
                             WHERE a.team_id = t.id AND a.coach_id = t.coach_id AND a.role = 'lead'))),
    0,
    'every team has a lead coach, recorded as an assignment'
);
SELECT is(
    (SELECT count(*)::int FROM public.team_coach_assignment_drift((SELECT id FROM t_ids WHERE name = 'demoA')) d
      WHERE NOT d.in_sync),
    0,
    'no team''s coach columns drift from its assignment rows (the one writer kept them together)'
);
SELECT is(
    (SELECT count(*)::int FROM public.players p JOIN public.teams t ON t.id = p.team_id
      WHERE p.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND p.division_id <> t.division_id),
    0,
    'every player is in their team''s division'
);
-- 20261101020000: the league's programs span divisions, from the fixture's Payment Plan column;
-- U9, U10 and U12 are in no program of their own, so in the season's default.
SELECT is(
    (SELECT array_agg(x ORDER BY x COLLATE "C") FROM (
        SELECT p.name || ':' || string_agg(d.name, ',' ORDER BY d.name) AS x
          FROM public.programs p JOIN public.divisions d ON d.program_id = p.id
         WHERE p.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')
         GROUP BY p.id, p.name) s),
    ARRAY['Junior:U7B,U7G,U8B,U8G', 'Micro:U5B,U5G,U6B,U6G', 'Minis:U4',
          'No program:U10B,U10G,U12B,U12G,U9B,U9G', 'Select:U14B,U14G,U16B,U16G,U19B,U19G'],
    'the demo league has its four programs and its default, every division in one'
);
SELECT is(
    (SELECT count(*)::int FROM public.coaches c JOIN demo_seed.coaches s ON s.email = c.email),
    0,
    'no copy keeps a seed email: coaches.email is unique across organizations, so each copy''s is tagged'
);
SELECT is(
    (SELECT array_agg(d.name || ':' || d.plays_games::text ORDER BY d.name)
       FROM public.divisions d
      WHERE d.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND NOT d.plays_games),
    ARRAY['U4:false'],
    'U4 is the one practice-only division'
);
SELECT is(
    (SELECT array_agg(ps.start_time::text || '-' || ps.end_time::text || ':' || d.name ORDER BY ps.start_time)
       FROM public.practice_slots ps JOIN public.divisions d ON d.id = ps.division_id
      WHERE ps.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')),
    ARRAY['09:00:00-09:30:00:U4', '09:45:00-10:15:00:U4', '10:30:00-11:00:00:U4', '11:15:00-11:45:00:U4'],
    'the only reserved slots are U4''s four 30-minute sessions'
);
SELECT is(
    (SELECT count(*)::int FROM public.practice_slots s,
            LATERAL public.practice_slot_conflicts(s.organization_id, s.field_id, s.field_subunit_id, s.day_of_week,
                                                   s.start_time, s.end_time, s.valid_from, s.valid_until, s.id, 0) c
      WHERE s.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')),
    0,
    'no seeded slot overlaps another on its surface'
);
SELECT is(
    (SELECT count(*)::int FROM public.practice_slots s,
            LATERAL public.practice_slot_conflicts(s.organization_id, s.field_id, s.field_subunit_id, s.day_of_week,
                                                   s.start_time, s.end_time, s.valid_from, s.valid_until, s.id, 15) c
      WHERE s.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND s.division_id IS NOT NULL),
    0,
    'the U4 sessions are at least 15 minutes apart: from the seed''s own slot times'
);
SELECT is(
    (SELECT count(DISTINCT s.id)::int FROM public.practice_slots s,
            LATERAL public.practice_slot_conflicts(s.organization_id, s.field_id, s.field_subunit_id, s.day_of_week,
                                                   s.start_time, s.end_time, s.valid_from, s.valid_until, s.id, 20) c
      WHERE s.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND s.division_id IS NOT NULL),
    4,
    'control: asked for 20 minutes, each U4 session would clash with a neighbour (the check can fail)'
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT ok(public.is_org_admin((SELECT id FROM t_ids WHERE name = 'demoA')), 'the visitor is the demo''s admin');
SELECT is(
    public.start_demo_session() ->> 'organization_id',
    (SELECT id::text FROM t_ids WHERE name = 'demoA'),
    'a second call returns the same demo'
);
RESET role;
SELECT is(
    (SELECT count(*)::int FROM public.organizations WHERE demo_owner = 'aaaaaaaa-0000-4000-8000-0000000000a1'),
    1,
    'and makes no second organization'
);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT throws_ok($$SELECT public.start_demo_session()$$, '42501', NULL,
    'a signed-in caller who is not anonymous is refused');
SET LOCAL "request.jwt.claims" TO '{"role":"authenticated","is_anonymous":true}';
SELECT throws_ok($$SELECT public.start_demo_session()$$, '42501', 'Not authenticated',
    'a caller with no identity is refused');
RESET role;
SET LOCAL role = 'anon';
SELECT throws_ok($$SELECT public.start_demo_session()$$, '42501', NULL, 'the anon role cannot execute it');
RESET role;

-- ── 2. The expiry is not a client's to change ──────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT lives_ok(
    $$UPDATE public.organizations SET name = 'Renamed demo' WHERE id = (SELECT id FROM t_ids WHERE name = 'demoA')$$,
    'control: the demo''s admin may update their organization'
);
SELECT throws_ok(
    $$UPDATE public.organizations SET demo_expires_at = NULL WHERE id = (SELECT id FROM t_ids WHERE name = 'demoA')$$,
    '42501', 'demo_expires_at and demo_owner are set by the server only',
    'a demo''s admin cannot clear its expiry'
);
SELECT throws_ok(
    $$UPDATE public.organizations SET demo_expires_at = now() + interval '1 day' WHERE id = (SELECT id FROM t_ids WHERE name = 'demoA')$$,
    '42501', 'demo_expires_at and demo_owner are set by the server only',
    'nor extend it'
);
SELECT throws_ok(
    $$UPDATE public.organizations SET demo_owner = 'aaaaaaaa-0000-4000-8000-0000000000a2' WHERE id = (SELECT id FROM t_ids WHERE name = 'demoA')$$,
    '42501', 'demo_expires_at and demo_owner are set by the server only',
    'nor hand the demo to another visitor'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT throws_ok(
    $$UPDATE public.organizations SET demo_expires_at = now() + interval '5 minutes' WHERE id = 'a1111111-1111-1111-1111-111111111111'$$,
    '42501', 'demo_expires_at and demo_owner are set by the server only',
    'a real organization''s admin cannot mark theirs a demo'
);
SELECT lives_ok(
    $$UPDATE public.organizations SET name = 'Org A renamed' WHERE id = 'a1111111-1111-1111-1111-111111111111'$$,
    'control: and still updates their organization'
);
RESET role;
SELECT is(
    (SELECT demo_expires_at FROM public.organizations WHERE id = 'a1111111-1111-1111-1111-111111111111'),
    NULL,
    'Org A is not a demo'
);
SELECT throws_ok(
    $$INSERT INTO public.organizations (name, slug, demo_expires_at, demo_owner)
      VALUES ('Second', 'second-demo', now() + interval '1 hour', 'aaaaaaaa-0000-4000-8000-0000000000a1')$$,
    '23505', NULL,
    'even without the lock, a visitor cannot own a second live demo (the unique index)'
);

-- ── 3. The people fence, and what stays free ───────────────────────────────
INSERT INTO t_ids
SELECT 'p1', p.id FROM public.players p JOIN public.divisions d ON d.id = p.division_id
 WHERE p.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND d.name = 'U5B' ORDER BY p.external_registration_id LIMIT 1;
INSERT INTO t_ids
SELECT 'p2', p.id FROM public.players p JOIN public.divisions d ON d.id = p.division_id
 WHERE p.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND d.name = 'U5B'
   AND p.id <> (SELECT id FROM t_ids WHERE name = 'p1') ORDER BY p.external_registration_id LIMIT 1;
INSERT INTO t_ids
SELECT 'tOther', t.id FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
 WHERE t.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND d.name = 'U5B'
   AND t.id <> (SELECT team_id FROM public.players WHERE id = (SELECT id FROM t_ids WHERE name = 'p1')) ORDER BY t.name LIMIT 1;
INSERT INTO t_ids
SELECT 'tDelete', t.id FROM public.teams t WHERE t.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') AND t.name = 'U19G02';
INSERT INTO t_ids
SELECT 'coach1', c.id FROM public.coaches c WHERE c.organization_id = (SELECT id FROM t_ids WHERE name = 'demoA') ORDER BY c.full_name LIMIT 1;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';

SELECT lives_ok(
    $$SELECT public.admin_update_player((SELECT id FROM t_ids WHERE name = 'p1'),
        jsonb_build_object('team_id', (SELECT id FROM t_ids WHERE name = 'tOther')))$$,
    'control: a demo player moves to another team of the division (Team Builder''s write)'
);
SELECT is(
    (SELECT team_id FROM public.team_players WHERE player_id = (SELECT id FROM t_ids WHERE name = 'p1')),
    (SELECT id FROM t_ids WHERE name = 'tOther'),
    'and the roster follows'
);
SELECT lives_ok(
    $$SELECT public.admin_update_player((SELECT id FROM t_ids WHERE name = 'p1'), '{"rating": 3}')$$,
    'control: a rating changes'
);
SELECT lives_ok(
    $$SELECT public.admin_update_player((SELECT id FROM t_ids WHERE name = 'p1'), '{"status": "inactive"}')$$,
    'control: a status changes (the Players grid''s Status cell, which a demo visitor edits)'
);
SELECT is(
    (SELECT status FROM public.players WHERE id = (SELECT id FROM t_ids WHERE name = 'p1')),
    'inactive',
    'and the player is inactive afterwards'
);
SELECT lives_ok(
    $$SELECT public.admin_delete_team((SELECT id FROM t_ids WHERE name = 'tDelete'))$$,
    'control: a team is deleted (its players are unassigned: a players write the fence lets through)'
);
SELECT throws_ok(
    $$SELECT public.admin_update_player((SELECT id FROM t_ids WHERE name = 'p1'), '{"first_name": "Typed"}')$$,
    '42501', NULL, 'a player''s name cannot be changed'
);
SELECT throws_ok(
    $$SELECT public.admin_update_player((SELECT id FROM t_ids WHERE name = 'p1'), '{"notes": "a note"}')$$,
    '42501', NULL, 'nor a note'
);
SELECT throws_ok(
    $$SELECT public.admin_update_player((SELECT id FROM t_ids WHERE name = 'p1'), '{"buddy_request": "Someone"}')$$,
    '42501', NULL, 'nor a buddy request'
);
SELECT throws_ok(
    $$SELECT public.admin_bulk_update_players(ARRAY[(SELECT id FROM t_ids WHERE name = 'p1')], '{"notes": "a note"}')$$,
    '42501', NULL, 'the bulk writer (which takes no name of its own) refuses a note the same way'
);
SELECT throws_ok(
    $$SELECT public.apply_player_patch((SELECT id FROM t_ids WHERE name = 'p1'), '{"first_name": "Typed"}')$$,
    '42501', NULL, 'the invoker apply_player_patch, granted to authenticated, refuses it too'
);
SELECT throws_ok(
    $$SELECT public.admin_create_player((SELECT id FROM t_ids WHERE name = 'demoA'),
        '{"first_name": "Typed", "last_name": "Child"}')$$,
    '42501', NULL, 'no player is created'
);
SELECT throws_ok(
    $$SELECT public.admin_delete_players(ARRAY[(SELECT id FROM t_ids WHERE name = 'p2')])$$,
    '42501', NULL, 'no player is deleted'
);
SELECT throws_ok(
    $$UPDATE public.players SET first_name = 'Typed' WHERE id = (SELECT id FROM t_ids WHERE name = 'p2')$$,
    '42501', NULL, 'a direct write by the admin, which the table''s policy admits, is refused'
);
SELECT throws_ok(
    $$INSERT INTO public.players (organization_id, first_name, last_name)
      VALUES ((SELECT id FROM t_ids WHERE name = 'demoA'), 'Typed', 'Child')$$,
    '42501', NULL, 'and a direct insert'
);
SELECT throws_ok(
    $$DELETE FROM public.players WHERE id = (SELECT id FROM t_ids WHERE name = 'p2')$$,
    '42501', NULL, 'and a direct delete'
);
SELECT throws_ok(
    $$SELECT public.admin_update_coach_status((SELECT id FROM t_ids WHERE name = 'demoA'),
        (SELECT id FROM t_ids WHERE name = 'coach1'), 'inactive')$$,
    '42501', NULL, 'a coach''s status cannot be changed'
);
SELECT throws_ok(
    $$SELECT public.admin_delete_coaches(ARRAY[(SELECT id FROM t_ids WHERE name = 'coach1')])$$,
    '42501', NULL, 'no coach is deleted'
);
SELECT lives_ok($$SELECT public.link_my_coach_record()$$, 'link_my_coach_record runs for an anonymous caller');
RESET role;
SELECT is(
    (SELECT count(*)::int FROM public.coaches WHERE user_id IS NOT NULL OR profile_id IS NOT NULL),
    0,
    'and links no coach record: it matches a confirmed email, which an anonymous user does not have'
);
SELECT throws_ok(
    $$UPDATE public.coaches SET full_name = 'Typed' WHERE id = (SELECT id FROM t_ids WHERE name = 'coach1')$$,
    '42501', NULL, 'the fence holds for the table''s owner too: a coach''s name is read-only whoever writes'
);
INSERT INTO public.players (id, organization_id, first_name, last_name)
VALUES ('a1111111-0000-4000-8000-0000000000e1', 'a1111111-1111-1111-1111-111111111111', 'Real', 'Player');
SELECT throws_ok(
    $$UPDATE public.players SET organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')
       WHERE id = 'a1111111-0000-4000-8000-0000000000e1'$$,
    '42501', NULL, 'a real organization''s player cannot be moved into a demo (a row moved is judged by both)'
);
SELECT is(
    (SELECT (first_name, rating)::text FROM public.players WHERE id = (SELECT id FROM t_ids WHERE name = 'p1')),
    (SELECT '(' || p.first_name || ',3)' FROM demo_seed.players s
       JOIN public.players p ON p.external_registration_id = s.external_registration_id
      WHERE p.id = (SELECT id FROM t_ids WHERE name = 'p1')),
    'after all of it the player keeps their seeded name and the rating the admin set'
);

-- The catalogue: every function a signed-in caller may execute that writes players or coaches (by
-- its body) is tested above, declared roster-structural, or an import writer with no job to act on.
SELECT is(
    (SELECT array_agg(p.proname ORDER BY p.proname)
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND (p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(players|coaches)\M'
             OR p.prosrc ~* 'apply_player_patch')
        AND p.proname <> ALL (ARRAY[
            -- refused by the calls above
            'admin_create_player', 'admin_delete_players', 'admin_update_player', 'admin_bulk_update_players',
            'apply_player_patch', 'admin_delete_coaches', 'admin_update_coach_status', 'link_my_coach_record',
            -- roster-structural: touches only team_id, which a demo may change
            'admin_delete_team',
            -- the seed's own copy: it writes the league before the organization is marked a demo
            'start_demo_session',
            -- import writers: each starts from an import job, and none can exist in a demo (section 4)
            'finalize_import_job', 'finalize_coach_import_job', 'rollback_coach_import_job'
        ])),
    NULL,
    'every function that writes players or coaches is tested here or declared'
);
SELECT is(
    (SELECT count(*)::int FROM unnest(ARRAY[
            'admin_create_player', 'admin_delete_players', 'admin_update_player', 'admin_bulk_update_players',
            'apply_player_patch', 'admin_delete_coaches', 'admin_update_coach_status', 'link_my_coach_record',
            'admin_delete_team', 'start_demo_session', 'finalize_import_job', 'finalize_coach_import_job',
            'rollback_coach_import_job'
         ]) n
      WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = n
                           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                           AND (p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(players|coaches)\M'
                                OR p.prosrc ~* 'apply_player_patch'))),
    0,
    'control: each declared name is still such a function (the scan reads real bodies)'
);

-- ── 4. The import fence ────────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT throws_ok(
    $$SELECT public.create_import_job((SELECT id FROM t_ids WHERE name = 'demoA'), 'players', 'players.csv')$$,
    '42501', 'The demo league cannot import files (import_jobs refused)',
    'create_import_job refuses a demo'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT lives_ok(
    $$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'players.csv')$$,
    'control: the same call works in a real organization'
);
RESET role;
SELECT throws_ok(
    $$INSERT INTO public.import_jobs (organization_id, job_type, storage_path, status, created_by)
      VALUES ((SELECT id FROM t_ids WHERE name = 'demoA'), 'registration', 'x/y.csv', 'queued',
              'aaaaaaaa-0000-4000-8000-0000000000a1')$$,
    '42501', 'The demo league cannot import files (import_jobs refused)',
    'no import job can be created for a demo, by anyone: the finalize and rollback RPCs have none to act on'
);
SELECT throws_ok(
    $$INSERT INTO public.staging_players (organization_id, import_job_id, raw_payload)
      VALUES ((SELECT id FROM t_ids WHERE name = 'demoA'), 'aaaabbbb-1111-1111-1111-111111111111', '{}')$$,
    '42501', 'The demo league cannot import files (staging_players refused)',
    'nor a staged player'
);
SELECT throws_ok(
    $$INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, raw_payload)
      VALUES ((SELECT id FROM t_ids WHERE name = 'demoA'), 'aaaabbbb-1111-1111-1111-111111111111', 'coaches', '{}')$$,
    '42501', 'The demo league cannot import files (staging_import_rows refused)',
    'nor a staged row'
);
SELECT lives_ok(
    $$INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, raw_payload)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaabbbb-1111-1111-1111-111111111111', 'coaches', '{}')$$,
    'control: the same row is staged for a real organization'
);

-- ── 5. The anonymous fence ─────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT throws_ok(
    $$SELECT public.initialize_new_tenant('Real league', 'real-league-anon', 'America/Chicago', 2026)$$,
    '42501', 'A demo visitor cannot create or join an organization',
    'an anonymous visitor cannot create an organization'
);
SELECT throws_ok(
    $$SELECT public.create_org_invite((SELECT id FROM t_ids WHERE name = 'demoA'), 'coach', interval '7 days')$$,
    '42501', 'A demo visitor cannot invite anyone',
    'nor mint an invite, not even for their own demo'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT lives_ok(
    $$SELECT public.initialize_new_tenant('Real league', 'real-league-control', 'America/Chicago', 2026)$$,
    'control: a signed-in user who is not anonymous creates one'
);
SELECT lives_ok(
    $$SELECT set_config('t.code', (SELECT code FROM public.create_org_invite('a1111111-1111-1111-1111-111111111111', 'coach', interval '7 days') LIMIT 1), true)$$,
    'control: an admin mints an invite for a real organization'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT throws_ok(
    $$SELECT public.redeem_org_invite(current_setting('t.code'))$$,
    '42501', 'A demo visitor cannot create or join an organization',
    'an anonymous visitor cannot redeem a valid invite into a real organization'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"dddddddd-0000-4000-8000-0000000000d1","role":"authenticated"}';
-- redeem_org_invite records 'members.invited_joined', which no migration registers in audit_actions, so a
-- redeem hits the audit foreign key in this build (found by this test; not D3's to change). The control
-- registers it, as the test's own superuser role, so that it can show the refusal above was the fence.
RESET role;
INSERT INTO public.audit_actions (action) VALUES ('members.invited_joined') ON CONFLICT (action) DO NOTHING;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"dddddddd-0000-4000-8000-0000000000d1","role":"authenticated"}';
SELECT lives_ok(
    $$SELECT public.redeem_org_invite(current_setting('t.code'))$$,
    'control: a signed-in user who is not anonymous redeems the same invite'
);
RESET role;
SELECT is(
    (SELECT count(*)::int FROM public.organizations WHERE slug = 'real-league-anon'),
    0,
    'the refused organization was not left behind'
);
-- The trigger's own refusal, as the table's owner (row level security out of the way): the claims decide.
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT throws_ok(
    $$INSERT INTO public.organization_members (organization_id, profile_id, role)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'admin')$$,
    '42501', 'A demo visitor cannot create or join an organization',
    'an anonymous session joins no real organization, by any path'
);
SELECT throws_ok(
    $$INSERT INTO public.organization_members (organization_id, profile_id, role)
      VALUES ((SELECT id FROM t_ids WHERE name = 'demoA'), '11111111-1111-1111-1111-111111111111', 'admin')$$,
    '42501', 'A demo visitor cannot create or join an organization',
    'and adds no one else to its own demo'
);
RESET "request.jwt.claims";
SELECT lives_ok(
    $$INSERT INTO public.organization_members (organization_id, profile_id, role)
      VALUES ((SELECT id FROM t_ids WHERE name = 'demoA'), '11111111-1111-1111-1111-111111111111', 'staff')$$,
    'control: with no anonymous claim the same insert passes (the refusal was the fence)'
);
-- The catalogue of every function a signed-in caller (an anonymous visitor is one) may execute. Each is on a
-- list that says what an anonymous caller may do with it, so a new client-callable function must decide.
CREATE TEMP TABLE t_client_fns ON COMMIT DROP AS
SELECT p.proname AS name, p.prosecdef AS definer, p.prosrc AS body
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');

SELECT is(
    (SELECT array_agg(name ORDER BY name) FROM t_client_fns
      WHERE name <> ALL (ARRAY[
          -- refuse an anonymous caller (each tried above)
          'initialize_new_tenant', 'create_org_invite', 'redeem_org_invite',
          -- requires one
          'start_demo_session',
          -- allowed: gated by the caller's membership of an organization (an anonymous visitor belongs to one,
          -- their demo, and the helpers below end it at expiry), coach-scoped, or pure
        'admin_assign_team_coach', 'admin_bulk_update_players', 'admin_cancel_game_assignment', 'admin_cancel_practice_assignment',
        'admin_change_member_role', 'admin_create_field', 'admin_create_field_blackout', 'admin_create_location',
        'admin_create_player', 'admin_decide_coach_practice_preference', 'admin_decide_practice_lighting_override', 'admin_delete_coaches',
        'admin_delete_field', 'admin_delete_field_blackout', 'admin_delete_players', 'admin_delete_program', 'admin_delete_team',
        'admin_get_coached_team_ids', 'admin_get_division_teams', 'admin_merge_programs', 'admin_publish_schedule_baseline', 'admin_remove_member',
        'admin_retire_field', 'admin_retire_field_subunit', 'admin_retire_location', 'admin_select_field_availability_scenario',
        'admin_set_coach_practice_preference', 'admin_set_division_program', 'admin_set_location_coordinates', 'admin_set_org_heat_settings', 'admin_set_practice_lighting_override',
        'admin_set_practice_slot_division', 'admin_set_season_timezone', 'admin_unretire_field', 'admin_unretire_field_subunit',
        'admin_unretire_location', 'admin_update_coach_status', 'admin_update_field', 'admin_update_field_blackout',
        'admin_update_player', 'admin_update_team', 'admin_upsert_division_settings', 'admin_upsert_organization_schema', 'admin_upsert_program',
        'apply_player_patch', 'caller_coaches_practice_slot', 'cancel_ready_import_job', 'create_import_job',
        'enact_lock_cause_row', 'enact_practice_recommendation', 'enforce_field_retirement_deactivates', 'fail_import_job',
        'fail_stale_import_jobs', 'field_is_live_on', 'finalize_coach_import_job', 'finalize_field_availability_import_job',
        'finalize_field_import_job', 'finalize_import_job', 'finalize_onboarding', 'generate_invite_code',
        'get_field_availability_scenarios', 'get_latest_team_runs_per_division', 'get_my_coached_team_ids', 'get_my_division_teams',
        'get_organization_members', 'get_reserved_keys', 'get_settings_audit_log', 'get_team_roster',
        'get_team_staff', 'import_normalize_capacity_basis', 'import_normalize_field_availability_approval_status', 'import_normalize_field_availability_record_status',
        'import_normalize_format_code', 'import_normalize_requirement_status', 'import_payload_text', 'import_text_to_bool',
        'import_text_to_date', 'import_text_to_day_of_week', 'import_text_to_jsonb_array', 'import_text_to_positive_int',
        'import_text_to_time', 'is_current_team_coach', 'is_demo_org', 'is_org_admin',
        'is_org_member', 'link_my_coach_record', 'log_telemetry_event', 'mark_import_job_ready_to_apply',
        'materialize_import_buddy_pairs', 'min_uuid', 'persist_evaluation_run', 'persist_game_schedule',
        'persist_practice_schedule', 'persist_team_schedule', 'practice_schedule_fingerprint', 'publication_baseline_document_problem',
        'record_audit_event', 'refuse_publication_baseline_mutation', 'refuse_publication_baseline_truncate', 'request_coach_practice_preference',
        'revoke_org_invite', 'rollback_coach_import_job', 'rollback_field_availability_import_job', 'rollback_field_import_job',
        'rotate_calendar_token', 'sanitize_player_patch', 'team_coach_assignment_drift', 'trigger_set_timestamp',
        'update_game_score', 'update_import_job_progress', 'update_org_feature_flags', 'upsert_division_for_import',
        'validate_custom_attributes', 'withdraw_practice_lighting_override'
      ])),
    NULL,
    'every function a signed-in caller may execute is on the anonymous list: refused, required, or allowed'
);
SELECT is(
    (SELECT array_agg(n ORDER BY n) FROM unnest(ARRAY[
          'initialize_new_tenant', 'create_org_invite', 'redeem_org_invite', 'start_demo_session',
        'admin_assign_team_coach', 'admin_bulk_update_players', 'admin_cancel_game_assignment', 'admin_cancel_practice_assignment',
        'admin_change_member_role', 'admin_create_field', 'admin_create_field_blackout', 'admin_create_location',
        'admin_create_player', 'admin_decide_coach_practice_preference', 'admin_decide_practice_lighting_override', 'admin_delete_coaches',
        'admin_delete_field', 'admin_delete_field_blackout', 'admin_delete_players', 'admin_delete_program', 'admin_delete_team',
        'admin_get_coached_team_ids', 'admin_get_division_teams', 'admin_merge_programs', 'admin_publish_schedule_baseline', 'admin_remove_member',
        'admin_retire_field', 'admin_retire_field_subunit', 'admin_retire_location', 'admin_select_field_availability_scenario',
        'admin_set_coach_practice_preference', 'admin_set_division_program', 'admin_set_location_coordinates', 'admin_set_org_heat_settings', 'admin_set_practice_lighting_override',
        'admin_set_practice_slot_division', 'admin_set_season_timezone', 'admin_unretire_field', 'admin_unretire_field_subunit',
        'admin_unretire_location', 'admin_update_coach_status', 'admin_update_field', 'admin_update_field_blackout',
        'admin_update_player', 'admin_update_team', 'admin_upsert_division_settings', 'admin_upsert_organization_schema', 'admin_upsert_program',
        'apply_player_patch', 'caller_coaches_practice_slot', 'cancel_ready_import_job', 'create_import_job',
        'enact_lock_cause_row', 'enact_practice_recommendation', 'enforce_field_retirement_deactivates', 'fail_import_job',
        'fail_stale_import_jobs', 'field_is_live_on', 'finalize_coach_import_job', 'finalize_field_availability_import_job',
        'finalize_field_import_job', 'finalize_import_job', 'finalize_onboarding', 'generate_invite_code',
        'get_field_availability_scenarios', 'get_latest_team_runs_per_division', 'get_my_coached_team_ids', 'get_my_division_teams',
        'get_organization_members', 'get_reserved_keys', 'get_settings_audit_log', 'get_team_roster',
        'get_team_staff', 'import_normalize_capacity_basis', 'import_normalize_field_availability_approval_status', 'import_normalize_field_availability_record_status',
        'import_normalize_format_code', 'import_normalize_requirement_status', 'import_payload_text', 'import_text_to_bool',
        'import_text_to_date', 'import_text_to_day_of_week', 'import_text_to_jsonb_array', 'import_text_to_positive_int',
        'import_text_to_time', 'is_current_team_coach', 'is_demo_org', 'is_org_admin',
        'is_org_member', 'link_my_coach_record', 'log_telemetry_event', 'mark_import_job_ready_to_apply',
        'materialize_import_buddy_pairs', 'min_uuid', 'persist_evaluation_run', 'persist_game_schedule',
        'persist_practice_schedule', 'persist_team_schedule', 'practice_schedule_fingerprint', 'publication_baseline_document_problem',
        'record_audit_event', 'refuse_publication_baseline_mutation', 'refuse_publication_baseline_truncate', 'request_coach_practice_preference',
        'revoke_org_invite', 'rollback_coach_import_job', 'rollback_field_availability_import_job', 'rollback_field_import_job',
        'rotate_calendar_token', 'sanitize_player_patch', 'team_coach_assignment_drift', 'trigger_set_timestamp',
        'update_game_score', 'update_import_job_progress', 'update_org_feature_flags', 'upsert_division_for_import',
        'validate_custom_attributes', 'withdraw_practice_lighting_override'
      ]) n WHERE n NOT IN (SELECT name FROM t_client_fns)),
    NULL,
    'control: every name on the list is still a function a signed-in caller may execute'
);
SELECT is(
    (SELECT array_agg(name ORDER BY name) FROM t_client_fns
      WHERE definer AND body !~ '\m(is_org_admin|is_org_member|is_current_team_coach)\M'
        AND name <> ALL (ARRAY[
            -- the gates themselves, and what asks no organization question
            'is_org_admin', 'is_org_member', 'is_demo_org', 'start_demo_session',
            -- fenced above
            'initialize_new_tenant', 'redeem_org_invite',
            -- coach-scoped: they match the caller to a coach record, and an anonymous user has none
            'caller_coaches_practice_slot', 'get_my_coached_team_ids', 'get_my_division_teams',
            'link_my_coach_record',
            -- reads organization_members itself (declared in the migration: after expiry it still writes the
            -- doomed demo's own evaluation rows until the purge)
            'persist_evaluation_run'
        ])),
    NULL,
    'every definer on the allowed list asks the membership helpers, or is declared why not'
);
SELECT ok(
    NOT has_function_privilege('authenticated', 'public.prune_old_audit_logs()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.prune_old_evaluation_runs()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.prune_old_audit_logs()', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.prune_old_audit_logs()', 'EXECUTE'),
    'the retention sweeps, ungated definers, are no signed-in caller''s (pg_cron and the service role keep them)'
);

-- ── 6. The buckets ─────────────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT throws_ok(
    format($$INSERT INTO storage.objects (bucket_id, name) VALUES ('exports', '%s/master.csv')$$,
           (SELECT id FROM t_ids WHERE name = 'demoA')),
    '42501', 'new row violates row-level security policy for table "objects"',
    'the demo''s own admin uploads nothing to exports'
);
SELECT throws_ok(
    format($$INSERT INTO storage.objects (bucket_id, name) VALUES ('raw-imports', '%s/players.csv')$$,
           (SELECT id FROM t_ids WHERE name = 'demoA')),
    '42501', 'new row violates row-level security policy for table "objects"', 'nor to raw-imports'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
SELECT lives_ok(
    $$INSERT INTO storage.objects (bucket_id, name) VALUES ('exports', 'a1111111-1111-1111-1111-111111111111/demo-control.csv')$$,
    'control: a real organization''s admin uploads to exports'
);
SELECT lives_ok(
    $$INSERT INTO storage.objects (bucket_id, name) VALUES ('raw-imports', 'a1111111-1111-1111-1111-111111111111/demo-control.csv')$$,
    'control: and to raw-imports'
);
RESET role;
SELECT ok(
    public.is_demo_org((SELECT id FROM t_ids WHERE name = 'demoA'))
    AND NOT public.is_demo_org('a1111111-1111-1111-1111-111111111111')
    AND NOT public.is_demo_org(NULL),
    'is_demo_org: true for a demo, false for a real organization and for null'
);

-- ── 7. Expiry, before the purge ────────────────────────────────────────────
UPDATE public.organizations SET demo_expires_at = now() - interval '1 minute'
 WHERE id = (SELECT id FROM t_ids WHERE name = 'demoA');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a1","role":"authenticated","is_anonymous":true}';
SELECT is(
    ARRAY[public.is_org_member((SELECT id FROM t_ids WHERE name = 'demoA')),
          public.is_org_admin((SELECT id FROM t_ids WHERE name = 'demoA'))],
    ARRAY[false, false],
    'after expiry the visitor is no member and no admin of their demo'
);
SELECT is(
    (SELECT count(*)::int FROM public.players WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')),
    0,
    'a member''s read of the demo''s players returns nothing'
);
SELECT is(
    (SELECT count(*)::int FROM public.organizations WHERE id = (SELECT id FROM t_ids WHERE name = 'demoA')),
    0,
    'and the organization itself is not visible'
);
SELECT throws_ok(
    $$SELECT public.admin_assign_team_coach((SELECT id FROM t_ids WHERE name = 'demoA'),
        (SELECT id FROM t_ids WHERE name = 'tOther'), NULL, NULL)$$,
    '42501', NULL, 'and a write that worked before expiry is refused'
);
RESET role;
SELECT is(
    (SELECT count(*)::int FROM public.players WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demoA')),
    1259 - 0,
    'control: the rows are all still there (the refusal is the helpers, not an empty demo)'
);

-- ── 8. The purge ───────────────────────────────────────────────────────────
-- A second, live demo; a baseline (append-only) and telemetry in the expired one; the 2-hour-old orphan
-- (V3), the young one (V4), and V5, an old anonymous user that something outside any demo still names.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a2","role":"authenticated","is_anonymous":true}';
SELECT is(public.start_demo_session() ->> 'existing', 'false', 'a second visitor starts a second demo');
RESET role;
INSERT INTO t_ids SELECT 'demoB', id FROM public.organizations WHERE demo_owner = 'aaaaaaaa-0000-4000-8000-0000000000a2';
INSERT INTO public.publication_baselines (organization_id, baseline_version, document_version, snapshot_id, label,
        channel, published_at, published_by, export_columns, export_rows, row_count, digest)
VALUES ((SELECT id FROM t_ids WHERE name = 'demoA'), 1, 1, 'snap-1', 'Demo baseline', 'email', '2026-10-26T00:00:00',
        'demo', '["Team"]', '[["U5B01"]]', 1, '0123456789abcdef');
INSERT INTO public.telemetry_log (org_id, session_id, event_type, payload, created_by)
VALUES ((SELECT id FROM t_ids WHERE name = 'demoA'), 's', 'demo.test', '{}', 'aaaaaaaa-0000-4000-8000-0000000000a1');
-- V5 is named by an audit row of a REAL organization (audit_log.user_id has no delete action): forced, since no
-- path leaves one (the fences stop it),
-- to prove the purge skips and counts a user it cannot delete rather than ending the run.
INSERT INTO public.audit_log (user_id, organization_id, action, resource_type)
VALUES ('aaaaaaaa-0000-4000-8000-0000000000a5', 'a1111111-1111-1111-1111-111111111111', 'team.saved', 'team');

SELECT ok(
    NOT has_function_privilege('authenticated', 'public.purge_expired_demos()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.purge_expired_demos()', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.purge_expired_demos()', 'EXECUTE'),
    'the purge is the service role''s, no client''s'
);

SELECT is(
    (SELECT public.purge_expired_demos() - 'live_demos'),
    '{"orgs_deleted": 1, "users_deleted": 2, "users_skipped": 1}'::jsonb,
    'the purge deletes the expired demo, its visitor and the old orphan, and counts the user it could not delete'
);
SELECT is(
    (SELECT sum((xpath('/row/c/text()',
                       query_to_xml(format('SELECT count(*) AS c FROM %I.%I WHERE %I = %L',
                                           c.table_schema, c.table_name, c.column_name,
                                           (SELECT id FROM t_ids WHERE name = 'demoA')), false, true, '')))[1]::text::int)::int
       FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.column_name IN ('organization_id', 'org_id')),
    0,
    'no row in any table with an organization_id or org_id names the purged demo'
);
SELECT ok(
    (SELECT count(*) FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name IN ('organization_id', 'org_id')) > 40
    AND (SELECT sum((xpath('/row/c/text()',
                       query_to_xml(format('SELECT count(*) AS c FROM %I.%I WHERE %I = %L',
                                           c.table_schema, c.table_name, c.column_name,
                                           (SELECT id FROM t_ids WHERE name = 'demoB')), false, true, '')))[1]::text::int)::int
       FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.column_name IN ('organization_id', 'org_id')) > 2500,
    'control: the same scan, on the live demo, finds its rows in more than forty tables (it does not read nothing)'
);
SELECT is(
    (SELECT array_agg(id::text ORDER BY id::text) FROM auth.users WHERE id::text LIKE 'aaaaaaaa-0000-4000-8000-0000000000a%'),
    ARRAY['aaaaaaaa-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-0000000000a4',
          'aaaaaaaa-0000-4000-8000-0000000000a5', 'aaaaaaaa-0000-4000-8000-0000000000a6'],
    'the expired visitor (V1) and the old orphan (V3) are gone; the live visitor, the young user, the skipped user and the unused visitor stay'
);
SELECT is(
    (SELECT array_agg(slug ORDER BY slug) FROM public.organizations WHERE slug IN ('org-a-pgtap', 'org-b-pgtap')),
    ARRAY['org-a-pgtap', 'org-b-pgtap'],
    'real organizations are untouched'
);
SELECT is(
    (SELECT count(*)::int FROM public.players WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demoB')),
    1259,
    'and so is the live demo'
);
SELECT is(
    (SELECT (orgs_deleted, users_deleted, users_skipped, live_demos)::text FROM public.demo_purge_log ORDER BY id DESC LIMIT 1),
    '(1,2,1,1)',
    'the run is logged with its counts'
);
SELECT is(
    (SELECT public.purge_expired_demos() - 'live_demos'),
    '{"orgs_deleted": 0, "users_deleted": 0, "users_skipped": 1}'::jsonb,
    'a second run deletes nothing more (and skips the same user again)'
);
SELECT is(
    (SELECT count(*)::int FROM public.demo_purge_log WHERE note IS NULL),
    2,
    'and logs itself too'
);

-- ── 9. demo_health ─────────────────────────────────────────────────────────
SELECT ok(
    NOT has_function_privilege('authenticated', 'public.demo_health()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.demo_health()', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.demo_health()', 'EXECUTE'),
    'demo_health is the service role''s'
);
SELECT is((public.demo_health() ->> 'healthy')::boolean, true, 'healthy after a run, with a live demo and no stale one');
-- A planted stale expired demo.
INSERT INTO public.organizations (name, slug, demo_expires_at) VALUES ('Stale demo', 'stale-demo-pgtap', now() - interval '45 minutes');
SELECT is(
    ARRAY[public.demo_health() ->> 'healthy', ((public.demo_health() -> 'problems' ->> 0) LIKE '1 expired demo organization(s) are over 30 minutes past expiry%')::text],
    ARRAY['false', 'true'],
    'an expired demo 45 minutes past expiry is reported'
);
UPDATE public.organizations SET demo_expires_at = now() - interval '5 minutes' WHERE slug = 'stale-demo-pgtap';
SELECT is((public.demo_health() ->> 'healthy')::boolean, true, 'control: 5 minutes past expiry is still the purge''s ten-minute rhythm');
DELETE FROM public.organizations WHERE slug = 'stale-demo-pgtap';
-- A planted stale log.
UPDATE public.demo_purge_log SET ran_at = now() - interval '45 minutes';
SELECT is(
    ARRAY[public.demo_health() ->> 'healthy', ((public.demo_health() -> 'problems' ->> 0) LIKE 'the newest purge log row is 45 minutes old')::text],
    ARRAY['false', 'true'],
    'a log whose newest row is 45 minutes old is reported'
);
DELETE FROM public.demo_purge_log;
SELECT is(
    ARRAY[public.demo_health() ->> 'healthy', public.demo_health() -> 'problems' ->> 0],
    ARRAY['false', 'the purge has never logged a run'],
    'no log row at all is reported, not read as healthy'
);

-- ── 10. The cap ────────────────────────────────────────────────────────────
-- Demo B is live (1); nine more make ten.
INSERT INTO public.organizations (name, slug, demo_expires_at)
SELECT 'Filler ' || g, 'filler-' || g || '-pgtap', now() + interval '20 minutes' FROM generate_series(1, 9) g;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a6","role":"authenticated","is_anonymous":true}';
SELECT throws_ok(
    $$SELECT public.start_demo_session()$$,
    'P0001', 'The demo is busy right now. Try again in a few minutes.',
    'at ten live demos the next visitor is refused'
);
RESET role;
SELECT is(
    (SELECT count(*)::int FROM public.organizations WHERE demo_expires_at > now()),
    10,
    'and the live count is still ten'
);
UPDATE public.organizations SET demo_expires_at = now() - interval '1 minute' WHERE slug = 'filler-1-pgtap';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000a6","role":"authenticated","is_anonymous":true}';
SELECT is(public.start_demo_session() ->> 'existing', 'false', 'once one has expired the visitor is served');
RESET role;
SELECT is(
    (SELECT count(*)::int FROM public.organizations WHERE demo_expires_at > now()),
    10,
    'and the live count is ten, not eleven'
);

SELECT * FROM finish();
ROLLBACK;
