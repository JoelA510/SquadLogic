-- pgTAP: a natural age replaces the birth date (migration 20261026010000; plan
-- docs/changes/2026-10-22-admin-focus.md, R5; owner decision 3: birthdates
-- are never stored server-side).
--
--   * **no column named like birth or dob** on `players`, `coaches` or the
--     staging tables (`staging_players`, `staging_import_rows`), with a
--     control showing the same read finds such columns where they stay (a
--     division's birthdate window); no public function (comments and string
--     literals aside), view or policy names `date_of_birth` or `birth_year`;
--   * `players.natural_age` is a smallint; the SQL allowlist holds it and no
--     birth key;
--   * the finalizer, as Org A's admin, on rows staged directly: it promotes
--     every row, a birth date or not; it stores the staged natural age, else
--     the age group, else none; a staged birth date is stored nowhere; a
--     re-import rewrites the natural age;
--   * a patch naming `date_of_birth` is refused 22023, alone and in bulk.
-- Run as `authenticated` with a JWT sub where a caller matters.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(13);

-- ── 1. No birth column ─────────────────────────────────────────────────────
SELECT is(
    (SELECT array_agg(c.relname || '.' || a.attname ORDER BY c.relname, a.attname)
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname IN ('players', 'coaches', 'staging_players', 'staging_import_rows')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname ~* '(birth|dob)'),
    NULL,
    'no column named like birth or dob on players, coaches, staging_players or staging_import_rows'
);
-- Control: the same read, on a table that keeps a birthdate window, finds it,
-- and the four tables it scans exist (so its silence is not a missing table).
SELECT ok(
    (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'divisions'
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~* '(birth|dob)') = 2
    AND (SELECT count(*) FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
            AND c.relname IN ('players', 'coaches', 'staging_players', 'staging_import_rows')) = 4,
    'control: the read finds divisions.birthdate_start and birthdate_end, and the four tables exist'
);
SELECT is(
    (SELECT array_agg(o ORDER BY o) FROM (
        SELECT 'function ' || p.oid::regprocedure::text AS o
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '''[^'']*''', '', 'g')
               ~ '\m(date_of_birth|birth_year)\M'
        UNION ALL
        SELECT 'view ' || c.relname
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
           AND pg_get_viewdef(c.oid) ~ '\m(date_of_birth|birth_year)\M'
        UNION ALL
        SELECT 'policy ' || tablename || '.' || policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '\m(date_of_birth|birth_year)\M'
    ) s),
    NULL,
    'no public function, view or policy names date_of_birth or birth_year'
);
SELECT is(
    (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid = 'public.players'::regclass AND attname = 'natural_age' AND NOT attisdropped),
    'smallint',
    'players.natural_age is a smallint'
);
SELECT ok(
    'natural_age' = ANY (public.import_allowed_keys('players'))
    AND NOT (public.import_allowed_keys('players') && ARRAY['date_of_birth', 'dob', 'birth_year']),
    'the SQL allowlist holds natural_age and no birth key'
);

-- ── 2. The finalizer ───────────────────────────────────────────────────────
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
    ('a1111111-0000-4000-8000-0000000005f1', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/r5-1.csv', 'importing', '11111111-1111-1111-1111-111111111111'),
    ('a1111111-0000-4000-8000-0000000005f2', 'a1111111-1111-1111-1111-111111111111', 'registration',
     'orga/r5-2.csv', 'importing', '11111111-1111-1111-1111-111111111111');
INSERT INTO public.staging_players
    (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000005f1', 1, '{}'::jsonb,
     '{"first_name": "Ana", "last_name": "Rfive", "external_registration_id": "R5-A", "natural_age": "10",
       "age group": "9", "date_of_birth": "2016-04-02", "birth_year": "2016"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000005f1', 2, '{}'::jsonb,
     '{"first_name": "Bea", "last_name": "Rfive", "external_registration_id": "R5-B", "age_group": "9"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000005f1', 3, '{}'::jsonb,
     '{"first_name": "Cy", "last_name": "Rfive", "external_registration_id": "R5-C"}'::jsonb),
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-0000-4000-8000-0000000005f2', 1, '{}'::jsonb,
     '{"first_name": "Ana", "last_name": "Rfive", "external_registration_id": "R5-A", "natural_age": "11"}'::jsonb);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    (public.finalize_import_job('a1111111-0000-4000-8000-0000000005f1') ->> 'promoted_rows')::int,
    3,
    'the finalizer promotes every row, with a birth date or without one'
);
SELECT is(
    (SELECT array_agg(first_name || ':' || coalesce(natural_age::text, '-') ORDER BY first_name)
       FROM public.players WHERE external_registration_id LIKE 'R5-%'),
    ARRAY['Ana:10', 'Bea:9', 'Cy:-'],
    'it stores the staged natural age, else the age group, else none'
);
SELECT ok(
    NOT EXISTS (SELECT 1 FROM public.players p
                 WHERE p.external_registration_id LIKE 'R5-%'
                   AND (strpos(to_jsonb(p)::text, '2016-04-02') > 0
                        OR EXISTS (SELECT 1 FROM jsonb_object_keys(p.custom_attributes) k
                                    WHERE k ~* '(birth|dob)'))),
    'a staged birth date or year is stored nowhere on the player'
);
SELECT is(
    (public.finalize_import_job('a1111111-0000-4000-8000-0000000005f2') ->> 'updated_players')::int,
    1,
    'a re-import updates the player it matches by registration id'
);
SELECT is(
    (SELECT natural_age FROM public.players WHERE external_registration_id = 'R5-A'),
    11::smallint,
    'a re-import rewrites the natural age'
);

-- ── 3. The player writers ──────────────────────────────────────────────────
SELECT throws_ok(
    $$SELECT public.admin_update_player(
        (SELECT id FROM public.players WHERE external_registration_id = 'R5-A'),
        '{"date_of_birth": "2016-04-02"}')$$,
    '22023', NULL, 'a patch naming date_of_birth is refused'
);
SELECT throws_ok(
    $$SELECT public.admin_bulk_update_players(
        ARRAY(SELECT id FROM public.players WHERE external_registration_id = 'R5-A'),
        '{"date_of_birth": "2016-04-02"}')$$,
    '22023', NULL, 'a bulk patch naming date_of_birth is refused'
);
SELECT lives_ok(
    $$SELECT public.admin_update_player(
        (SELECT id FROM public.players WHERE external_registration_id = 'R5-A'), '{"jersey_number": 4}')$$,
    'an admin still patches a player'
);
RESET role;

SELECT * FROM finish();
ROLLBACK;
