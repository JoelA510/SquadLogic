-- pgTAP: players and coaches belong to one season; imports match within it
-- (migration 20261108010000; plan docs/changes/2026-10-27-season-enrollment.md, PR E3a).
--
--   * the column, its keys and its triggers: a season is filled on insert (the division's, else
--     the active one), is the organization's own, never changes, and equals the season of the
--     player's division and team; the same registration id or email is one row per season;
--   * the import matches in the destination season only: a registration id or an email that
--     another season holds is a NEW row, and nothing of the other season's row is read or
--     written (the case Codex found on #666); a division named by id from another season matches
--     nothing; an organization with no season, and a completed season, are refused; a buddy
--     request or a coach's child id reaches players of the job's season only;
--   * the other writers: the player patch, the roster save (persist_team_schedule), a buddy pair,
--     a coach's team assignment and a coach's child link each refuse another season's row;
--     admin_create_player takes a season (default the active one);
--   * view_org_metrics counts per season.
-- Season 1 is Org A's fixture season; it is completed part-way and season 2 made active, as a
-- rollover will (the E1 guard lets only the active season take an import). Run as `authenticated`
-- with a JWT sub where a caller matters; the seeding runs as the test's own role.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(63);

-- ── Shape ───────────────────────────────────────────────────────────────────
SELECT is(
    (SELECT array_agg(table_name::text ORDER BY table_name::text) FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'season_settings_id' AND is_nullable = 'NO'
        AND table_name IN ('players', 'coaches')),
    ARRAY['coaches', 'players'],
    'players and coaches carry a NOT NULL season_settings_id');
SELECT is(
    (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'players_season_external_registration_id_key'),
    'CREATE UNIQUE INDEX players_season_external_registration_id_key ON public.players USING btree (season_settings_id, external_registration_id) WHERE (external_registration_id IS NOT NULL)',
    'a registration id is unique within a season');
SELECT is(
    (SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'coaches_organization_season_email_key'),
    'CREATE UNIQUE INDEX coaches_organization_season_email_key ON public.coaches USING btree (organization_id, season_settings_id, lower(email))',
    'a coach email is unique within an organization and season');
SELECT is(
    (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('idx_players_org_external_registration_id')) +
    (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.coaches'::regclass
        AND conname = 'coaches_organization_id_email_key'),
    0, 'the organization-wide player lookup and coach email key are gone');

-- ── The triggers: fill, organization, immutability, division, team ──────────
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-111111111ddd', 'a1111111-1111-1111-1111-111111111111', 'Org A Draft 2027', 'draft', 2027);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111dabcd', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111ddd', 'Org A U10');

INSERT INTO public.players (id, organization_id, first_name, last_name) VALUES
    ('a1111111-1111-1111-1111-0000000e0001', 'a1111111-1111-1111-1111-111111111111', 'Fill', 'None');
INSERT INTO public.players (id, organization_id, division_id, first_name, last_name) VALUES
    ('a1111111-1111-1111-1111-0000000e0002', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-1111111dabcd', 'Fill', 'Division');
SELECT is((SELECT season_settings_id FROM public.players WHERE id = 'a1111111-1111-1111-1111-0000000e0001'),
    'a1111111-1111-1111-1111-111111111aaa'::uuid,
    'a player inserted with no season and no division takes the active season');
SELECT is((SELECT season_settings_id FROM public.players WHERE id = 'a1111111-1111-1111-1111-0000000e0002'),
    'a1111111-1111-1111-1111-111111111ddd'::uuid,
    'a player inserted with a division and no season takes its division''s season');
SELECT throws_ok($$
    INSERT INTO public.players (organization_id, season_settings_id, division_id, first_name, last_name)
    VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa',
            'a1111111-1111-1111-1111-1111111dabcd', 'Wrong', 'Division')$$,
    '23514', 'the player''s division is in another season',
    'a player cannot be inserted into a division of another season');
SELECT throws_ok($$
    INSERT INTO public.players (organization_id, season_settings_id, first_name, last_name)
    VALUES ('a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222bbb', 'Wrong', 'Org')$$,
    '23514', 'the player''s season belongs to another organization',
    'a player cannot name another organization''s season');
SELECT throws_ok($$
    UPDATE public.players SET season_settings_id = 'a1111111-1111-1111-1111-111111111ddd'
     WHERE id = 'a1111111-1111-1111-1111-0000000e0001'$$,
    '23514', 'a player belongs to one season: season_settings_id cannot change',
    'a player''s season never changes');
SELECT throws_ok($$
    UPDATE public.players SET division_id = 'a1111111-1111-1111-1111-1111111dabcd'
     WHERE id = 'a1111111-1111-1111-1111-0000000e0001'$$,
    '23514', 'the player''s division is in another season',
    'a direct update cannot move a player into another season''s division');
SELECT throws_ok($$
    UPDATE public.players SET team_id = 'bbbbbbbb-0000-0000-0000-000000000002'
     WHERE id = 'a1111111-1111-1111-1111-0000000e0001'$$,
    '23514', 'the player''s team is in another season',
    'nor into a team of another season');
SELECT throws_ok($$
    INSERT INTO public.players (organization_id, first_name, last_name, external_registration_id)
    VALUES ('a1111111-1111-1111-1111-111111111111', 'Dup', 'A', 'DUP-1'), ('a1111111-1111-1111-1111-111111111111', 'Dup', 'B', 'DUP-1')$$,
    '23505', NULL, 'two players of one season cannot share a registration id');
SELECT lives_ok($$
    INSERT INTO public.players (organization_id, season_settings_id, first_name, last_name, external_registration_id)
    VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Dup', 'C', 'DUP-2'),
           ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111ddd', 'Dup', 'D', 'DUP-2')$$,
    'but the same registration id in another season is another player');

INSERT INTO public.coaches (id, organization_id, full_name, email) VALUES
    ('a1111111-1111-1111-1111-00000000e0c1', 'a1111111-1111-1111-1111-111111111111', 'Fill Coach', 'fill@example.test');
SELECT is((SELECT season_settings_id FROM public.coaches WHERE id = 'a1111111-1111-1111-1111-00000000e0c1'),
    'a1111111-1111-1111-1111-111111111aaa'::uuid,
    'a coach inserted with no season takes the active season');
SELECT throws_ok($$
    UPDATE public.coaches SET season_settings_id = 'a1111111-1111-1111-1111-111111111ddd'
     WHERE id = 'a1111111-1111-1111-1111-00000000e0c1'$$,
    '23514', 'a coach row belongs to one season: season_settings_id cannot change',
    'a coach row''s season never changes');
SELECT throws_ok($$
    INSERT INTO public.coaches (organization_id, full_name, email)
    VALUES ('a1111111-1111-1111-1111-111111111111', 'Fill Twin', 'Fill@Example.test'),
           ('a1111111-1111-1111-1111-111111111111', 'Fill Twin', 'fill@example.test')$$,
    '23514', NULL, 'the email check still refuses an un-normalised address');
SELECT throws_ok($$
    INSERT INTO public.coaches (organization_id, full_name, email)
    VALUES ('a1111111-1111-1111-1111-111111111111', 'Fill Twin', 'fill@example.test')$$,
    '23505', NULL, 'two coaches of one organization and season cannot share an email');
SELECT lives_ok($$
    INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email)
    VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111ddd', 'Fill Draft', 'fill@example.test')$$,
    'but the same email in another season is another coach');
DELETE FROM public.players WHERE first_name IN ('Fill', 'Dup');
DELETE FROM public.coaches WHERE email = 'fill@example.test';

-- ── Season 1 is imported; season 2 then takes over ──────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
RESET role;

INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id) VALUES
    ('a1111111-0000-4000-8000-0000000e3a01', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/e3a-1.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa'),
    ('a1111111-0000-4000-8000-0000000e3a02', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/e3a-c1.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa');
INSERT INTO public.staging_players
    (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a01', 1, '{}'::jsonb,
     '{"first_name": "Ann", "last_name": "One", "external_registration_id": "E3-1", "division": "Org A U10", "buddy_request": "E3-2"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a01', 2, '{}'::jsonb,
     '{"first_name": "Bea", "last_name": "One", "external_registration_id": "E3-2", "division": "Org A U10", "buddy_request": "E3-1"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a01', 3, '{}'::jsonb,
     '{"first_name": "Cy", "last_name": "One", "external_registration_id": "E3-3", "division": "Org A U10"}'::jsonb);
INSERT INTO public.staging_import_rows
    (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a02', 'coaches', 1, '{}'::jsonb,
     '{"full_name": "Dee Coach", "email": "dee@example.test", "child_registration_id": "E3-1"}'::jsonb, '[]'::jsonb);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((public.finalize_import_job('a1111111-0000-4000-8000-0000000e3a01') ->> 'inserted_players')::int, 3,
    'season 1''s import inserts its three players');
SELECT is((public.materialize_import_buddy_pairs('a1111111-0000-4000-8000-0000000e3a01') ->> 'inserted_relationships')::int, 2,
    'and its buddy pair (both directions)');
SELECT is((public.finalize_coach_import_job('a1111111-0000-4000-8000-0000000e3a02') ->> 'linked_children')::int, 1,
    'season 1''s coach import links the coach to E3-1');
RESET role;

SELECT is((SELECT count(*)::int FROM public.players
            WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
              AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND external_registration_id LIKE 'E3-%'),
    3, 'the imported players are in season 1');
SELECT is((SELECT count(*)::int FROM public.coaches WHERE email = 'dee@example.test'
            AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'), 1, 'and the coach');

-- The rollover: season 1 completed, season 2 active. Season 1's rows are kept as they are.
UPDATE public.season_settings SET status = 'completed' WHERE id = 'a1111111-1111-1111-1111-111111111aaa';
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-111111111bbb', 'a1111111-1111-1111-1111-111111111111', 'Org A Fall 2026', 'active', 2026);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111bbcde', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111bbb', 'Org A U10');
CREATE TEMP TABLE s1_before ON COMMIT DROP AS
    SELECT p.id, to_jsonb(p) AS row FROM public.players p WHERE p.external_registration_id LIKE 'E3-%';
CREATE TEMP TABLE s1_coach_before ON COMMIT DROP AS
    SELECT c.id, to_jsonb(c) AS row FROM public.coaches c WHERE c.email = 'dee@example.test';

INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id) VALUES
    ('a1111111-0000-4000-8000-0000000e3a11', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/e3a-2.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111bbb'),
    ('a1111111-0000-4000-8000-0000000e3a12', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/e3a-c2.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111bbb'),
    ('a1111111-0000-4000-8000-0000000e3a13', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/e3a-3.csv', 'importing', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa');
INSERT INTO public.staging_players
    (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a11', 1, '{}'::jsonb,
     '{"first_name": "Ann", "last_name": "Renewed", "external_registration_id": "E3-1", "division": "Org A U10", "buddy_request": "E3-4"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a11', 2, '{}'::jsonb,
     '{"first_name": "Dov", "last_name": "New", "external_registration_id": "E3-4", "division": "Org A U10", "buddy_request": "E3-1"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a11', 3, '{}'::jsonb,
     '{"first_name": "Eli", "last_name": "New", "external_registration_id": "E3-5", "division_id": "a1111111-1111-1111-1111-11111111abcd", "buddy_request": "E3-2"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a13', 1, '{}'::jsonb,
     '{"first_name": "Late", "last_name": "New", "external_registration_id": "E3-9"}'::jsonb);
INSERT INTO public.staging_import_rows
    (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a12', 'coaches', 1, '{}'::jsonb,
     '{"full_name": "Dee Renewed", "email": "dee@example.test", "child_registration_id": "E3-1; E3-3"}'::jsonb, '[]'::jsonb);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE fin2 ON COMMIT DROP AS
    SELECT public.finalize_import_job('a1111111-0000-4000-8000-0000000e3a11') AS r;
GRANT SELECT ON fin2 TO PUBLIC;
SELECT is((SELECT r ->> 'inserted_players' FROM fin2), '3',
    'season 2''s import inserts all three rows as new players, E3-1 included');
SELECT is((SELECT r ->> 'updated_players' FROM fin2), '0',
    'and updates none: a registration id season 1 holds is not a match in season 2');
SELECT ok((SELECT p.division_id IS NULL FROM public.players p WHERE p.external_registration_id = 'E3-5'),
    'a division named by id from season 1 matches nothing in season 2: the new player has none');
SELECT is((public.materialize_import_buddy_pairs('a1111111-0000-4000-8000-0000000e3a11') ->> 'inserted_relationships')::int, 2,
    'season 2''s buddy pair E3-1 and E3-4 is made; Eli''s request for E3-2 reaches no player of season 2');
CREATE TEMP TABLE fin3 ON COMMIT DROP AS
    SELECT public.finalize_coach_import_job('a1111111-0000-4000-8000-0000000e3a12') AS r;
GRANT SELECT ON fin3 TO PUBLIC;
SELECT is((SELECT r ->> 'inserted_coaches' FROM fin3), '1',
    'season 2''s coach import inserts the same email as a new coach');
SELECT is((SELECT r ->> 'updated_coaches' FROM fin3), '0', 'and updates none');
SELECT is((SELECT r ->> 'unmatched_child_id_count' FROM fin3), '1',
    'a child id only season 1 holds (E3-3) is unmatched in season 2, E3-1 matched its season-2 player');
SELECT throws_ok($$SELECT public.finalize_import_job('a1111111-0000-4000-8000-0000000e3a13')$$,
    '22023', 'Season a1111111-1111-1111-1111-111111111aaa is completed and takes no import',
    'an import into a completed season is refused');
RESET role;

SELECT is((SELECT count(*)::int FROM s1_before b JOIN public.players p ON p.id = b.id WHERE to_jsonb(p) = b.row),
    3, 'season 1''s three players are untouched, to the last column (updated_at included)');
SELECT is((SELECT count(*)::int FROM s1_coach_before b JOIN public.coaches c ON c.id = b.id WHERE to_jsonb(c) = b.row),
    1, 'season 1''s coach is untouched');
SELECT is((SELECT count(*)::int FROM public.player_buddies pb JOIN public.players p ON p.id = pb.player_id
            WHERE p.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'), 2,
    'season 1 keeps its own buddy pair and gained none');
SELECT is((SELECT count(*)::int FROM public.player_buddies pb
             JOIN public.players a ON a.id = pb.player_id JOIN public.players b ON b.id = pb.buddy_player_id
            WHERE a.season_settings_id <> b.season_settings_id), 0, 'no buddy pair spans two seasons');
SELECT is((SELECT p.division_id FROM public.players p WHERE p.external_registration_id = 'E3-1'
              AND p.season_settings_id = 'a1111111-1111-1111-1111-111111111bbb'),
    'a1111111-1111-1111-1111-1111111bbcde'::uuid, 'the season-2 row took the season-2 division of that name');
SELECT is((SELECT p.last_name FROM public.players p WHERE p.external_registration_id = 'E3-1'
              AND p.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'), 'One',
    'while season 1''s row still reads as imported');
SELECT is((SELECT count(*)::int FROM public.coach_team_requests r
             JOIN public.coaches c ON c.id = r.coach_id JOIN public.players p ON p.id = r.player_id
            WHERE c.season_settings_id = 'a1111111-1111-1111-1111-111111111bbb'
              AND p.season_settings_id = 'a1111111-1111-1111-1111-111111111bbb'), 1,
    'the season-2 coach is linked to the season-2 child');

-- No season at all.
INSERT INTO public.organizations (id, name, slug) VALUES
    ('c3333333-3333-3333-3333-333333333333', 'Org C', 'org-c-e3a');
INSERT INTO public.organization_members (organization_id, profile_id, role) VALUES
    ('c3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'admin');
DELETE FROM public.season_settings WHERE organization_id = 'c3333333-3333-3333-3333-333333333333';
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
    ('c3333333-0000-4000-8000-0000000e3a01', 'c3333333-3333-3333-3333-333333333333', 'registration',
     'orgc/e3a.csv', 'importing', '11111111-1111-1111-1111-111111111111'),
    ('c3333333-0000-4000-8000-0000000e3a02', 'c3333333-3333-3333-3333-333333333333', 'registration',
     'orgc/e3a-c.csv', 'importing', '11111111-1111-1111-1111-111111111111');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok($$SELECT public.finalize_import_job('c3333333-0000-4000-8000-0000000e3a01')$$,
    '22023', 'Organization c3333333-3333-3333-3333-333333333333 has no season to import into',
    'an organization with no season has nothing to import players into');
SELECT throws_ok($$SELECT public.finalize_coach_import_job('c3333333-0000-4000-8000-0000000e3a02')$$,
    '22023', 'Organization c3333333-3333-3333-3333-333333333333 has no season to import into',
    'nor coaches');
SELECT throws_ok($$SELECT public.admin_create_player('c3333333-3333-3333-3333-333333333333', '{}')$$,
    '22023', 'Organization c3333333-3333-3333-3333-333333333333 has no active season to add a player to',
    'nor a hand-added player');
RESET role;

-- ── The other writers ───────────────────────────────────────────────────────
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('a1111111-0000-4000-8000-0000000e3b01', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-1111111bbcde', 'Fall Team');
CREATE TEMP TABLE ids ON COMMIT DROP AS
    SELECT
        (SELECT id FROM public.players WHERE external_registration_id = 'E3-1' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa') AS p1,
        (SELECT id FROM public.players WHERE external_registration_id = 'E3-1' AND season_settings_id = 'a1111111-1111-1111-1111-111111111bbb') AS p2,
        (SELECT id FROM public.players WHERE external_registration_id = 'E3-4') AS p2b,
        (SELECT id FROM public.coaches WHERE email = 'dee@example.test' AND season_settings_id = 'a1111111-1111-1111-1111-111111111aaa') AS c1,
        (SELECT id FROM public.coaches WHERE email = 'dee@example.test' AND season_settings_id = 'a1111111-1111-1111-1111-111111111bbb') AS c2;
GRANT SELECT ON ids TO PUBLIC;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok(
    format($$SELECT public.admin_update_player(%L, '{"division_id": "a1111111-1111-1111-1111-11111111abcd"}')$$, (SELECT p2 FROM ids)),
    '22023', 'division a1111111-1111-1111-1111-11111111abcd is not in the player''s season',
    'the player patch refuses a division of another season');
SELECT throws_ok(
    format($$SELECT public.admin_update_player(%L, '{"team_id": "aaaaaaaa-0000-0000-0000-000000000001"}')$$, (SELECT p2 FROM ids)),
    '22023', NULL, 'and a team of another season (refused before the team check names its division)');
SELECT lives_ok(
    format($$SELECT public.admin_update_player(%L, '{"division_id": "a1111111-1111-1111-1111-1111111bbcde", "team_id": "a1111111-0000-4000-8000-0000000e3b01"}')$$, (SELECT p2 FROM ids)),
    'but its own season''s division and team are accepted');
SELECT is((SELECT count(*)::int FROM public.team_players WHERE team_id = 'a1111111-0000-4000-8000-0000000e3b01'), 1,
    'and the roster row follows');
SELECT throws_like(
    format($$SELECT public.persist_team_schedule(
        jsonb_build_object('id', 'a1111111-0000-4000-8000-0000000e3c01', 'organization_id', 'a1111111-1111-1111-1111-111111111111',
                           'season_settings_id', 'a1111111-1111-1111-1111-111111111bbb', 'run_type', 'team', 'status', 'completed'),
        jsonb_build_array(jsonb_build_object('id', 'a1111111-0000-4000-8000-0000000e3b01', 'division_id', 'a1111111-1111-1111-1111-1111111bbcde', 'name', 'Fall Team')),
        jsonb_build_array(jsonb_build_object('team_id', 'a1111111-0000-4000-8000-0000000e3b01', 'player_id', %L)))$$, (SELECT p1 FROM ids)),
    'a roster names players of its own season: %', 'a roster save naming a player of another season is refused');
SELECT is((SELECT count(*)::int FROM public.scheduler_runs WHERE id = 'a1111111-0000-4000-8000-0000000e3c01'), 0,
    'and writes nothing');
SELECT lives_ok(
    format($$SELECT public.persist_team_schedule(
        jsonb_build_object('id', 'a1111111-0000-4000-8000-0000000e3c02', 'organization_id', 'a1111111-1111-1111-1111-111111111111',
                           'season_settings_id', 'a1111111-1111-1111-1111-111111111bbb', 'run_type', 'team', 'status', 'completed'),
        jsonb_build_array(jsonb_build_object('id', 'a1111111-0000-4000-8000-0000000e3b01', 'division_id', 'a1111111-1111-1111-1111-1111111bbcde', 'name', 'Fall Team')),
        jsonb_build_array(jsonb_build_object('team_id', 'a1111111-0000-4000-8000-0000000e3b01', 'player_id', %L),
                          jsonb_build_object('team_id', 'a1111111-0000-4000-8000-0000000e3b01', 'player_id', %L)))$$,
        (SELECT p2 FROM ids), (SELECT p2b FROM ids)),
    'while a roster of its own season''s players is saved');
RESET role;

SELECT throws_ok(
    format($$INSERT INTO public.player_buddies (player_id, buddy_player_id, organization_id, source_import_job)
             VALUES (%L, %L, 'a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3a11')$$,
           (SELECT p1 FROM ids), (SELECT p2b FROM ids)),
    '23514', 'a buddy pair is two players of the same season', 'a buddy pair across seasons is refused');
SELECT throws_like(
    format($$INSERT INTO public.team_players (team_id, player_id, organization_id)
             VALUES ('a1111111-0000-4000-8000-0000000e3b01', %L, 'a1111111-1111-1111-1111-111111111111')$$, (SELECT p1 FROM ids)),
    'a roster names players of its own season: %', 'a roster row across seasons is refused');
SELECT throws_ok(
    format($$INSERT INTO public.coach_team_requests (organization_id, coach_id, player_id, slot)
             VALUES ('a1111111-1111-1111-1111-111111111111', %L, %L, 5)$$, (SELECT c2 FROM ids), (SELECT p1 FROM ids)),
    '23514', 'a coach''s child is a player of the coach''s own season', 'a coach-to-child link across seasons is refused');
SELECT throws_ok(
    format($$UPDATE public.coaches SET player_id = %L WHERE id = %L$$, (SELECT p1 FROM ids), (SELECT c2 FROM ids)),
    '23514', 'the coach''s player record is in another season', 'nor can a coach''s own player record be of another season');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok(
    format($$SELECT public.admin_assign_team_coach('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3b01', %L)$$, (SELECT c1 FROM ids)),
    '23514', NULL, 'a coach of another season cannot be assigned to a team');
SELECT lives_ok(
    format($$SELECT public.admin_assign_team_coach('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000e3b01', %L)$$, (SELECT c2 FROM ids)),
    'a coach of the team''s season can');
RESET role;
SELECT throws_ok(
    format($$UPDATE public.teams SET assistant_coach_ids = ARRAY[%L]::uuid[] WHERE id = 'a1111111-0000-4000-8000-0000000e3b01'$$, (SELECT c1 FROM ids)),
    '23514', NULL, 'nor can the team''s assistant column name one');

-- admin_create_player.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((public.admin_create_player('a1111111-1111-1111-1111-111111111111', '{"first_name": "Hand", "last_name": "Active"}')).season_settings_id,
    'a1111111-1111-1111-1111-111111111bbb'::uuid, 'admin_create_player defaults to the active season');
SELECT is((public.admin_create_player('a1111111-1111-1111-1111-111111111111', '{"first_name": "Hand", "last_name": "Draft"}',
                                      'a1111111-1111-1111-1111-111111111ddd')).season_settings_id,
    'a1111111-1111-1111-1111-111111111ddd'::uuid, 'and takes the season it is given');
SELECT throws_ok($$SELECT public.admin_create_player('a1111111-1111-1111-1111-111111111111', '{}', 'a1111111-1111-1111-1111-111111111aaa')$$,
    '22023', 'season a1111111-1111-1111-1111-111111111aaa is completed and takes no new player',
    'a completed season takes no new player');
SELECT throws_ok($$SELECT public.admin_create_player('a1111111-1111-1111-1111-111111111111', '{}', 'b2222222-2222-2222-2222-222222222bbb')$$,
    '42501', NULL, 'nor another organization''s season');
SELECT throws_ok($$SELECT public.admin_create_player('a1111111-1111-1111-1111-111111111111',
        '{"division_id": "a1111111-1111-1111-1111-11111111abcd"}')$$,
    '22023', 'division a1111111-1111-1111-1111-11111111abcd is not in the player''s season',
    'a new player''s division must be in its season');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'player.created'
            AND metadata ->> 'season_settings_id' = 'a1111111-1111-1111-1111-111111111ddd'), 1,
    'and the audit row names the season');

-- view_org_metrics.
SELECT is((SELECT array_agg(season_settings_id::text || ':' || total_players || ':' || total_teams ORDER BY season_settings_id::text)
             FROM public.view_org_metrics WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'),
    ARRAY['a1111111-1111-1111-1111-111111111aaa:3:1', 'a1111111-1111-1111-1111-111111111bbb:4:1',
          'a1111111-1111-1111-1111-111111111ddd:1:0'],
    'view_org_metrics has a row per season of Org A with that season''s players and teams');
SELECT is((SELECT count(*)::int FROM public.view_org_metrics WHERE total_users <> 1), 0,
    'each row carries the organization''s one admin');
RESET role;

SELECT * FROM finish();
ROLLBACK;
