-- RLS invariant: the `exports` storage bucket (20261017000000) is private and
-- scoped to the organization named by each object's first folder.
--
--   * a member of Org A (Alice, admin; Charlie, coach) uploads under A's
--     folder and reads A's exports;
--   * a member of Org B (Bob, admin) reads none of A's exports and cannot
--     upload under A's folder;
--   * a name with no folder, or a folder that is not a UUID, is refused with
--     42501 (the policy's CASE), never 22P02 (a cast error);
--   * an update or a delete, even by A's own admin, changes nothing: there is
--     no UPDATE or DELETE policy;
--   * the anonymous role reads nothing and cannot upload.
--
-- The objects are inserted into `storage.objects` directly, as the caller,
-- which is what the Storage API does with the caller's JWT: the policies are
-- what decide. INSERT raises on a refusal (a row that passes no WITH CHECK);
-- UPDATE and DELETE with no policy see no rows and affect none, so those are
-- asserted as "unchanged", the way rls_field_blackouts.sql asserts them.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(14);

-- ── 1. The bucket, private (as the test's own superuser role) ─────────────
SELECT is(
    (SELECT public FROM storage.buckets WHERE id = 'exports'),
    false,
    'the exports bucket exists and is private'
);

-- ── 2. Org A's members upload under A's folder ────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT lives_ok(
    $$INSERT INTO storage.objects (bucket_id, name)
      VALUES ('exports', 'a1111111-1111-1111-1111-111111111111/master-schedule-pgtap.csv')$$,
    'an Org A admin uploads under Org A''s folder'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT lives_ok(
    $$INSERT INTO storage.objects (bucket_id, name)
      VALUES ('exports', 'a1111111-1111-1111-1111-111111111111/teams/a-team-pgtap.csv')$$,
    'an Org A coach (a member, not an admin) uploads under Org A''s folder'
);

SELECT is(
    (SELECT COUNT(*) FROM storage.objects
      WHERE bucket_id = 'exports' AND name LIKE 'a1111111-1111-1111-1111-111111111111/%')::int,
    2,
    'an Org A coach reads both of Org A''s exports'
);

-- ── 3. Org B's admin: no read, no write under A's folder ──────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT is(
    (SELECT COUNT(*) FROM storage.objects WHERE bucket_id = 'exports')::int,
    0,
    'an Org B admin reads none of Org A''s exports'
);

SELECT throws_ok(
    $$INSERT INTO storage.objects (bucket_id, name)
      VALUES ('exports', 'a1111111-1111-1111-1111-111111111111/planted-by-b.csv')$$,
    '42501',
    NULL,
    'an Org B admin cannot upload under Org A''s folder'
);

-- ── 4. Names outside any organization's folder ────────────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
    $$INSERT INTO storage.objects (bucket_id, name)
      VALUES ('exports', 'master-schedule-no-folder.csv')$$,
    '42501',
    NULL,
    'an upload with no organization folder is refused'
);

SELECT throws_ok(
    $$INSERT INTO storage.objects (bucket_id, name)
      VALUES ('exports', 'not-an-org/master-schedule.csv')$$,
    '42501',
    NULL,
    'an upload under a folder that is not a UUID is refused by the policy, not by a cast error'
);

SELECT throws_ok(
    $$INSERT INTO storage.objects (bucket_id, name)
      VALUES ('exports', 'b2222222-2222-2222-2222-222222222222/planted-by-a.csv')$$,
    '42501',
    NULL,
    'an Org A admin cannot upload under Org B''s folder'
);

-- ── 5. No update, no delete, even by A's own admin ────────────────────────
SELECT is(
    (SELECT COUNT(*) FROM storage.objects
      WHERE bucket_id = 'exports' AND name LIKE 'a1111111-1111-1111-1111-111111111111/%')::int,
    2,
    'an Org A admin reads both of Org A''s exports'
);

UPDATE storage.objects SET name = name || '.renamed'
 WHERE bucket_id = 'exports' AND name LIKE 'a1111111-1111-1111-1111-111111111111/%';

DELETE FROM storage.objects
 WHERE bucket_id = 'exports' AND name LIKE 'a1111111-1111-1111-1111-111111111111/%';

SELECT is(
    (SELECT COUNT(*) FROM storage.objects
      WHERE bucket_id = 'exports' AND name LIKE 'a1111111-1111-1111-1111-111111111111/%'
        AND name NOT LIKE '%.renamed')::int,
    2,
    'an update and a delete by an Org A admin leave both exports as uploaded'
);

-- ── 6. The anonymous role ─────────────────────────────────────────────────
SET LOCAL role = 'anon';
SET LOCAL "request.jwt.claims" TO '{"role":"anon"}';

SELECT is(
    (SELECT COUNT(*) FROM storage.objects WHERE bucket_id = 'exports')::int,
    0,
    'anon reads no exports'
);

SELECT throws_ok(
    $$INSERT INTO storage.objects (bucket_id, name)
      VALUES ('exports', 'a1111111-1111-1111-1111-111111111111/anon.csv')$$,
    '42501',
    NULL,
    'anon cannot upload'
);

-- ── 7. What anon was refused is not there (as the superuser) ──────────────
RESET role;

SELECT is(
    (SELECT array_agg(name ORDER BY name) FROM storage.objects WHERE bucket_id = 'exports'),
    ARRAY[
        'a1111111-1111-1111-1111-111111111111/master-schedule-pgtap.csv',
        'a1111111-1111-1111-1111-111111111111/teams/a-team-pgtap.csv'
    ],
    'the bucket holds exactly the two uploads the policies allowed'
);

SELECT * FROM finish();
ROLLBACK;
