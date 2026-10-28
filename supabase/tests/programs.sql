-- pgTAP: programs, the optional groups of divisions (migration 20261101020000; plan
-- docs/changes/2026-10-22-phase-e-seasons.md, E2: "Programs (E2)" and "Program management (E2)").
--
--   * every season has exactly one default program ("No program"), including one made after the
--     migration; every division is in a program of its own season, whichever writer created it
--     (the import finalizer, `upsert_division_for_import`, `admin_upsert_division_settings`, a
--     direct insert) and a division cannot be put in another season's program (23503);
--   * `programs` is read by the members of its organization and no one else, and written by no
--     client directly (the four RPCs are the only writers);
--   * `admin_upsert_program`: create, rename, the default refuses a rename, names unique per season
--     ignoring case and padding, a non-admin, another organization's admin and a completed season are
--     refused, a completed season's program named with an active season id is refused, and each
--     success writes one audit row with the old and new name;
--   * `admin_set_division_program`: assign, move, NULL removes (to the default), another season's
--     program raises 23503, and each change writes one audit row with the from and to program;
--   * `admin_delete_program`: its divisions move to the default and the program goes, in one
--     transaction, with one audit row naming the moved divisions; the default cannot be deleted;
--   * `admin_merge_programs`: every source division moves to the target, which keeps its name; the
--     source goes; a program cannot be merged into itself, the default cannot be merged away, and
--     programs of two seasons cannot be merged;
--   * a division's program is not changed by a plain UPDATE of the division (an admin's is refused,
--     42501, even in a completed season), while its other columns update as before;
--   * a refused call writes no audit row and changes nothing;
--   * an organization that never makes a program works as before: its import, its division
--     writers and its listings need no program.
-- Run as `authenticated` with a JWT sub where a caller matters.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(77);

-- The rows a statement touched, for the writes that must still reach their row.
CREATE FUNCTION pg_temp.rows_of(p_sql text) RETURNS integer LANGUAGE plpgsql AS $f$
DECLARE n integer;
BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $f$;

-- Org A: its active season (fixtures), a draft and a completed one, each with a division; Org B only
-- its active season (never makes a program).
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-1111111111d1', 'a1111111-1111-1111-1111-111111111111', 'Org A Fall 2027', 'draft', 2027),
    ('a1111111-1111-1111-1111-1111111111c1', 'a1111111-1111-1111-1111-111111111111', 'Org A Fall 2025', 'completed', 2025);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-11111111d701', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'P U7B'),
    ('a1111111-1111-1111-1111-11111111d702', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'P U7G'),
    ('a1111111-1111-1111-1111-11111111d703', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'P U8B'),
    ('a1111111-1111-1111-1111-11111111d704', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111111d1', 'Draft U7B'),
    ('a1111111-1111-1111-1111-11111111d705', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111111c1', 'Old U7B');

-- ── 1. The default program, and every division in a program of its season ──
SELECT is(
    (SELECT count(*)::int FROM public.season_settings s
      WHERE (SELECT count(*) FROM public.programs p WHERE p.season_settings_id = s.id AND p.is_default) = 1
        AND (SELECT p.name FROM public.programs p WHERE p.season_settings_id = s.id AND p.is_default) = 'No program'),
    (SELECT count(*)::int FROM public.season_settings),
    'every season has exactly one default program, named No program (a season made after the migration too)'
);
SELECT is(
    (SELECT count(*)::int FROM public.divisions d
       JOIN public.programs p ON p.id = d.program_id AND p.season_settings_id = d.season_settings_id
      WHERE p.is_default),
    (SELECT count(*)::int FROM public.divisions),
    'every division is in its own season''s program, the default when it names none (inserted with no program)'
);
SELECT throws_ok(
    $$INSERT INTO public.divisions (organization_id, season_settings_id, name, program_id)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Cross U9',
              (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND is_default))$$,
    '23503', NULL,
    'a division cannot be inserted into another season''s program'
);
SELECT throws_ok(
    $$UPDATE public.divisions SET program_id = (SELECT id FROM public.programs
                                                 WHERE season_settings_id = 'b2222222-2222-2222-2222-222222222bbb' AND is_default)
       WHERE id = 'a1111111-1111-1111-1111-11111111d701'$$,
    '23503', NULL,
    'nor moved into another season''s (or organization''s) program by a direct update'
);
SELECT throws_ok(
    $$UPDATE public.divisions SET program_id = NULL WHERE id = 'a1111111-1111-1111-1111-11111111d701'$$,
    '23502', NULL,
    'a division''s program_id is never NULL'
);
SELECT throws_ok(
    $$INSERT INTO public.programs (organization_id, season_settings_id, name, is_default)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Second default', true)$$,
    '23505', NULL,
    'a season has one default program only'
);
SELECT throws_ok(
    $$INSERT INTO public.programs (organization_id, season_settings_id, name)
      VALUES ('b2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111aaa', 'Wrong org')$$,
    '23503', NULL,
    'a program cannot name another organization''s season'
);

-- ── 2. Who reads and writes the table ──────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    (SELECT count(*)::int FROM public.programs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'),
    3,
    'an admin of Org A reads Org A''s programs (one default per season)'
);
SELECT is(
    (SELECT count(*)::int FROM public.programs WHERE organization_id = 'b2222222-2222-2222-2222-222222222222'),
    0,
    'and none of Org B''s'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(
    (SELECT count(*)::int FROM public.programs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'),
    0,
    'an Org B member reads none of Org A''s programs'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok(
    $$INSERT INTO public.programs (organization_id, season_settings_id, name)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Direct')$$,
    '42501', NULL,
    'an admin''s direct insert into programs is refused'
);
SELECT throws_ok(
    $$UPDATE public.programs SET name = 'Renamed directly' WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$,
    '42501', NULL,
    'an admin''s direct update of programs is refused'
);
SELECT throws_ok(
    $$DELETE FROM public.programs WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$,
    '42501', NULL,
    'an admin''s direct delete of programs is refused'
);
RESET role;
SET LOCAL role = 'anon';
SELECT throws_ok(
    $$SELECT count(*) FROM public.programs$$,
    '42501', NULL,
    'anon has no access to programs at all'
);
RESET role;

-- ── 3. admin_upsert_program ────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', NULL, '  Junior ') ->> 'name'),
    'Junior',
    'an admin creates a program (the name is trimmed)'
);
SELECT results_eq(
    $$ SELECT metadata->>'operation', metadata->>'old_name', metadata->>'new_name', metadata->>'season_settings_id'
         FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action = 'program.upserted'
          AND metadata->>'new_name' = 'Junior' $$,
    $$ VALUES ('created'::text, NULL::text, 'Junior'::text, 'a1111111-1111-1111-1111-111111111aaa'::text) $$,
    'creating it writes one program.upserted row: created, no old name, the new name, the season'
);
SELECT throws_ok(
    $$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', NULL, ' JUNIOR')$$,
    '23505', NULL,
    'a second program of the same name ignoring case and padding is refused'
);
SELECT throws_ok(
    $$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', NULL, 'no program')$$,
    '23505', NULL,
    'a program cannot take the default''s name'
);
SELECT is(
    (public.admin_upsert_program('a1111111-1111-1111-1111-1111111111d1', NULL, 'Junior') ->> 'name'),
    'Junior',
    'the same name in another season is fine'
);
SELECT is(
    (public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', NULL, 'Micro') ->> 'name'),
    'Micro',
    'a second program in the season'
);
SELECT is(
    (public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Micro'),
        'Mini') ->> 'name'),
    'Mini',
    'an admin renames a program'
);
SELECT results_eq(
    $$ SELECT metadata->>'operation', metadata->>'old_name', metadata->>'new_name'
         FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action = 'program.upserted'
          AND metadata->>'new_name' = 'Mini' $$,
    $$ VALUES ('updated'::text, 'Micro'::text, 'Mini'::text) $$,
    'the rename writes one row carrying the old and the new name'
);
SELECT is(
    (public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Mini'),
        'Mini') ->> 'changed'),
    'false',
    'saving the same name changes nothing'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND action = 'program.upserted' AND metadata->>'new_name' = 'Mini'),
    1,
    'and writes no second audit row'
);
SELECT throws_ok(
    $$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND is_default),
        'Everything else')$$,
    '22023', NULL,
    'the default program cannot be renamed'
);
SELECT throws_ok(
    $$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', NULL, '   ')$$,
    '22023', NULL,
    'a blank name is refused'
);
SELECT throws_ok(
    $$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-1111111111c1', NULL, 'History')$$,
    '22023', NULL,
    'a completed season takes no program'
);
SELECT throws_ok(
    $$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111c1' AND is_default),
        'Edited through the active season')$$,
    '23503', NULL,
    'a completed season''s program named with the active season''s id is refused (the program''s own season decides)'
);
SELECT throws_ok(
    $$SELECT public.admin_upsert_program('b2222222-2222-2222-2222-222222222bbb', NULL, 'Not mine')$$,
    '42501', NULL,
    'an admin of another organization is refused'
);
RESET role;
SELECT id AS orgb_default FROM public.programs WHERE season_settings_id = 'b2222222-2222-2222-2222-222222222bbb' AND is_default \gset
SELECT id AS a_draft_junior FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND name = 'Junior' \gset
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok(
    format($q$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', %L, 'Not mine')$q$, :'orgb_default'),
    '23503', NULL,
    'another organization''s program id is not this season''s program'
);

-- ── 4. admin_set_division_program ──────────────────────────────────────────
SELECT is(
    (public.admin_set_division_program('a1111111-1111-1111-1111-11111111d701',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Junior')) ->> 'changed'),
    'true',
    'an admin assigns a division to a program'
);
SELECT is(
    (public.admin_set_division_program('a1111111-1111-1111-1111-11111111d702',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Junior')) ->> 'changed'),
    'true',
    'a second division joins it (a program spans divisions)'
);
SELECT results_eq(
    $$ SELECT metadata->>'division_name', metadata->>'from_program_name', metadata->>'to_program_name'
         FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action = 'division.program_changed'
          AND resource_id = 'a1111111-1111-1111-1111-11111111d701' $$,
    $$ VALUES ('P U7B'::text, 'No program'::text, 'Junior'::text) $$,
    'the assignment writes one division.program_changed row: from the default to Junior'
);
SELECT is(
    (public.admin_set_division_program('a1111111-1111-1111-1111-11111111d701',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Mini')) ->> 'changed'),
    'true',
    'an admin moves a division to another program'
);
SELECT results_eq(
    $$ SELECT p.name FROM public.divisions d JOIN public.programs p ON p.id = d.program_id
        WHERE d.id = 'a1111111-1111-1111-1111-11111111d701' $$,
    $$ VALUES ('Mini'::text) $$,
    'a division is in one program only: Mini now, not Junior'
);
SELECT is(
    (public.admin_set_division_program('a1111111-1111-1111-1111-11111111d701', NULL) ->> 'changed'),
    'true',
    'NULL removes a division from its program'
);
SELECT results_eq(
    $$ SELECT p.name, p.is_default FROM public.divisions d JOIN public.programs p ON p.id = d.program_id
        WHERE d.id = 'a1111111-1111-1111-1111-11111111d701' $$,
    $$ VALUES ('No program'::text, true) $$,
    'and it lands in the season''s default program, "No program"'
);
SELECT is(
    (public.admin_set_division_program('a1111111-1111-1111-1111-11111111d701', NULL) ->> 'changed'),
    'false',
    'removing a division that is in none changes nothing'
);
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND action = 'division.program_changed' AND resource_id = 'a1111111-1111-1111-1111-11111111d701'),
    3,
    'three changes of that division, three audit rows (the repeat wrote none)'
);
SELECT throws_ok(
    $$SELECT public.admin_set_division_program('a1111111-1111-1111-1111-11111111d701',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND name = 'Junior'))$$,
    '23503', NULL,
    'another season''s program raises 23503'
);
SELECT throws_ok(
    $$SELECT public.admin_set_division_program('a1111111-1111-1111-1111-11111111d705', NULL)$$,
    '22023', NULL,
    'a division of a completed season cannot be moved'
);
SELECT throws_ok(
    $$SELECT public.admin_set_division_program('b2222222-2222-2222-2222-22222222bcde', NULL)$$,
    '42501', NULL,
    'another organization''s division is refused'
);

-- ── 5. admin_merge_programs ────────────────────────────────────────────────
SELECT is(
    (public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', NULL, 'Select') ->> 'name'),
    'Select',
    'setup: a Select program'
);
SELECT is(
    (public.admin_set_division_program('a1111111-1111-1111-1111-11111111d703',
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Select')) ->> 'changed'),
    'true',
    'setup: U8B is in Select'
);
SELECT throws_ok(
    $$SELECT public.admin_merge_programs(
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Select'),
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Select'))$$,
    '22023', NULL,
    'a program cannot be merged into itself'
);
SELECT throws_ok(
    $$SELECT public.admin_merge_programs(
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND is_default),
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Select'))$$,
    '22023', NULL,
    'the default program cannot be merged away'
);
SELECT throws_ok(
    $$SELECT public.admin_merge_programs(
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Select'),
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND name = 'Junior'))$$,
    '22023', NULL,
    'programs of two seasons cannot be merged'
);
SELECT throws_ok(
    format($q$SELECT public.admin_merge_programs(
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Select'),
        %L)$q$, :'orgb_default'),
    '22023', NULL,
    'nor with another organization''s program'
);
SELECT is(
    (public.admin_merge_programs(
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Select'),
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Junior'))
     -> 'moved_division_ids'),
    '["a1111111-1111-1111-1111-11111111d703"]'::jsonb,
    'a merge moves the source''s divisions into the target'
);
SELECT results_eq(
    $$ SELECT (SELECT count(*)::int FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Select'),
              (SELECT p.name FROM public.divisions d JOIN public.programs p ON p.id = d.program_id WHERE d.id = 'a1111111-1111-1111-1111-11111111d703') $$,
    $$ VALUES (0, 'Junior'::text) $$,
    'the source is gone and the division is in the target, which keeps its name'
);
SELECT results_eq(
    $$ SELECT metadata->>'source_name', metadata->>'target_name', metadata->'moved_division_ids'
         FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action = 'program.merged' $$,
    $$ VALUES ('Select'::text, 'Junior'::text, '["a1111111-1111-1111-1111-11111111d703"]'::jsonb) $$,
    'one program.merged row names the source, the target and the moved divisions'
);

-- ── 6. admin_delete_program ────────────────────────────────────────────────
SELECT throws_ok(
    $$SELECT public.admin_delete_program((SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND is_default))$$,
    '22023', NULL,
    'the default program cannot be deleted'
);
SELECT throws_ok(
    $$SELECT public.admin_delete_program((SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111c1' AND is_default))$$,
    '22023', NULL,
    'nor can a completed season''s'
);
SELECT is(
    (public.admin_delete_program((SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Junior'))
     -> 'moved_division_ids'),
    '["a1111111-1111-1111-1111-11111111d702", "a1111111-1111-1111-1111-11111111d703"]'::jsonb,
    'deleting a program returns the divisions it moved'
);
SELECT results_eq(
    $$ SELECT d.name, p.name FROM public.divisions d JOIN public.programs p ON p.id = d.program_id
        WHERE d.id IN ('a1111111-1111-1111-1111-11111111d702', 'a1111111-1111-1111-1111-11111111d703') ORDER BY d.name $$,
    $$ VALUES ('P U7G'::text, 'No program'::text), ('P U8B'::text, 'No program'::text) $$,
    'they are in the default now, and the program is gone'
);
SELECT results_eq(
    $$ SELECT metadata->>'name', metadata->'moved_division_ids'
         FROM public.audit_log
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action = 'program.deleted' $$,
    $$ VALUES ('Junior'::text, '["a1111111-1111-1111-1111-11111111d702", "a1111111-1111-1111-1111-11111111d703"]'::jsonb) $$,
    'one program.deleted row names the program and the divisions that moved'
);

-- ── 7. Who may, and what a refusal leaves ──────────────────────────────────
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND action IN ('program.upserted', 'program.deleted', 'program.merged', 'division.program_changed')),
    12,
    'twelve successful writes so far, twelve audit rows (every refusal above wrote none)'
);
-- The ids the refusals name, read while still an admin (a non-member reads no program).
SELECT id AS junior_id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND name = 'Junior' \gset
SELECT id AS default_id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND is_default \gset
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', NULL, 'Coach made')$$,
    '42501', NULL,
    'a signed-in non-member cannot create a program'
);
SELECT throws_ok(
    $$SELECT public.admin_set_division_program('a1111111-1111-1111-1111-11111111d701', NULL)$$,
    '42501', NULL,
    'a non-member cannot move a division'
);
SELECT throws_ok(
    format($q$SELECT public.admin_delete_program(%L)$q$, :'junior_id'),
    '42501', NULL,
    'a non-member cannot delete a program'
);
SELECT throws_ok(
    format($q$SELECT public.admin_merge_programs(%L, %L)$q$, :'junior_id', :'default_id'),
    '42501', NULL,
    'a non-member cannot merge programs'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok(
    format($q$SELECT public.admin_delete_program(%L)$q$, :'a_draft_junior'),
    '42501', NULL,
    'another organization''s admin cannot delete a program (the same refusal as a program that does not exist)'
);
SELECT throws_ok(
    $$SELECT public.admin_delete_program('a1111111-0000-4000-8000-00000000dead')$$,
    '42501', NULL,
    'a program that does not exist is refused the same way'
);
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND action IN ('program.upserted', 'program.deleted', 'program.merged', 'division.program_changed')),
    12,
    'the refusals by a non-member and another organization''s admin wrote no audit row'
);

-- ── 8. A completed season''s program cannot be changed through any writer ───
RESET role;
UPDATE public.season_settings SET status = 'completed' WHERE id = 'a1111111-1111-1111-1111-1111111111d1';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT throws_ok(
    $$SELECT public.admin_delete_program((SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND name = 'Junior'))$$,
    '22023', NULL,
    'a program of a season completed since it was made cannot be deleted'
);
SELECT throws_ok(
    $$SELECT public.admin_merge_programs(
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND name = 'Junior'),
        (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-1111111111d1' AND is_default))$$,
    '22023', NULL,
    'nor merged'
);

-- A client cannot change a division's program with a plain UPDATE (the divisions UPDATE policy
-- would let an admin past the writers' completed-season refusal, lock and audit row); the writers
-- still can, and every other column is updated as before.
SELECT lives_ok(
    $$SELECT public.admin_upsert_program('a1111111-1111-1111-1111-111111111aaa', NULL, 'Guard Probe')$$,
    'a program to try the direct update with'
);
SELECT throws_ok(
    $$UPDATE public.divisions SET program_id = (SELECT id FROM public.programs
                                                 WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND name = 'Guard Probe')
       WHERE id = 'a1111111-1111-1111-1111-11111111d701'$$,
    '42501', 'a division''s program is changed with admin_set_division_program, not by updating the division',
    'an admin''s direct update of a division''s program is refused (a program of the active season)'
);
SELECT throws_ok(
    $$UPDATE public.divisions SET program_id = (SELECT p.id FROM public.programs p
                                                 WHERE p.season_settings_id = 'a1111111-1111-1111-1111-1111111111d1'
                                                   AND p.id <> (SELECT program_id FROM public.divisions
                                                                 WHERE id = 'a1111111-1111-1111-1111-11111111d704')
                                                 LIMIT 1)
       WHERE id = 'a1111111-1111-1111-1111-11111111d704'$$,
    '42501', NULL,
    'and of a completed season''s program'
);
SELECT isnt(
    (SELECT p.name FROM public.programs p JOIN public.divisions d ON d.program_id = p.id
      WHERE d.id = 'a1111111-1111-1111-1111-11111111d701'),
    'Guard Probe',
    'the refused update changed nothing'
);
SELECT is(
    pg_temp.rows_of($$UPDATE public.divisions SET name = 'P U7B (renamed)'
                       WHERE id = 'a1111111-1111-1111-1111-11111111d701'$$),
    1,
    'an admin''s direct update of another column of a division still works'
);
SELECT is(
    pg_temp.rows_of($$UPDATE public.divisions SET name = name, program_id = program_id
                       WHERE id = 'a1111111-1111-1111-1111-11111111d701'$$),
    1,
    'an update that leaves program_id as it is is not refused'
);

-- ── 9. Every division writer puts a new division in the default; programs stay optional ──
RESET role;
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by) VALUES
    ('b2222222-0000-4000-8000-0000000e2001', 'b2222222-2222-2222-2222-222222222222', 'registration',
     'orgb/e2.csv', 'importing', '22222222-2222-2222-2222-222222222222');
INSERT INTO public.staging_players
    (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload) VALUES
    ('b2222222-2222-2222-2222-222222222222', 'b2222222-0000-4000-8000-0000000e2001', 1, '{}'::jsonb,
     '{"first_name": "Pia", "last_name": "Etwo", "external_registration_id": "E2-P", "age group": "9", "gender": "M"}'::jsonb);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(
    (public.finalize_import_job('b2222222-0000-4000-8000-0000000e2001') ->> 'promoted_rows')::int,
    1,
    'an organization that never made a program imports as before'
);
SELECT is(
    (SELECT p.is_default FROM public.divisions d JOIN public.programs p ON p.id = d.program_id
      WHERE d.organization_id = 'b2222222-2222-2222-2222-222222222222' AND d.name = 'U10B'),
    true,
    'and the division the import created is in the default program'
);
SELECT is(
    (SELECT p.is_default FROM public.programs p WHERE p.id = (public.upsert_division_for_import(
        'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222bbb', 'U11B')).program_id),
    true,
    'upsert_division_for_import puts a new division in the default program'
);
SELECT is(
    (SELECT p.is_default FROM public.programs p WHERE p.id = (public.admin_upsert_division_settings('b2222222-2222-2222-2222-222222222222',
          'b2222222-2222-2222-2222-222222222bbb', NULL, 'U12B', 14, NULL, NULL, NULL, NULL, NULL, NULL) ->> 'program_id')::uuid),
    true,
    'admin_upsert_division_settings puts a new division in the default program'
);
SELECT is(
    (SELECT count(*)::int FROM public.programs WHERE organization_id = 'b2222222-2222-2222-2222-222222222222'),
    1,
    'Org B still has the one default program and nothing else'
);

SELECT * FROM finish();
ROLLBACK;
