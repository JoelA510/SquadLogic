-- pgTAP: one setting at organization, program and division level, the most specific winning (migration
-- 20261124010000; plan docs/changes/2026-11-13-settings-scope.md, F11-4a, tasks A1 and A2).
--
-- Written first, and red against the code before the migration. Every refusal is paired with a control that the allowed
-- twin passes.
--
--   1. The shape: `scoped_setting_keys` and `scoped_settings`, RLS with one SELECT policy each and no client write grant,
--      the standings key registered (boolean, default false), the resolver closed to client roles, the two setters open
--      to `authenticated` and not to `anon`.
--   2. Precedence: the case table below, the eight set/unset combinations of the three levels under two value patterns,
--      through `scoped_setting_value`. An explicit `false` beats an inherited `true` and the reverse; all unset is the
--      registry default. `tests/scopedSettingsParity.test.js` reads THIS table (between its two markers) and runs the core
--      twin over the same rows: keep its one-row-per-line format. The default equals `org_flag`'s (flag absent = off), and
--      the retired `feature_flags` key is not read any more.
--   3. The setter, `admin_set_scoped_setting`: each refusal writes nothing and has an allowed control; set, change and
--      unset each write exactly one `settings.updated` row with `old` and `new`; an unchanged write writes none; no client
--      writes the table directly.
--   4. The rollover: a program's and a division's values are copied to their copies in the next season, counted in the
--      audit row and the result; the organization's value is not per season and is not copied.
--   5. The seam: `standings_counts_outside` follows the cascade, and still answers false to a non-member.
--   6. `admin_set_division_practice_settings`: only the two practice columns change; the roster rules stay.
--   7. A deleted program takes its own values with it (decision S8).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(92);

-- ── Helpers ────────────────────────────────────────────────────────────────
-- err: SQLSTATE:DETAIL of the first error, or 'no error' (the statement's effect stays).
CREATE FUNCTION pg_temp.err(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE s text; d text;
BEGIN
    EXECUTE p_sql;
    RETURN 'no error';
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    RETURN s || ':' || COALESCE(d, '');
END
$f$;
-- val: the first column of the first row as text, or 'ERROR <sqlstate>' (a read today's code cannot do).
CREATE FUNCTION pg_temp.val(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
    EXECUTE p_sql INTO r;
    RETURN COALESCE(r, 'NULL');
EXCEPTION WHEN OTHERS THEN
    RETURN 'ERROR ' || SQLSTATE;
END
$f$;
-- set: the setter's answer in short ("changed=true old=x new=y"), or SQLSTATE:DETAIL.
CREATE FUNCTION pg_temp.set(p_scope text, p_id uuid, p_value jsonb, p_key text DEFAULT 'standings_count_outside_results')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r jsonb; s text; d text;
BEGIN
    r := public.admin_set_scoped_setting(p_key, p_scope, p_id, p_value);
    RETURN 'changed=' || (r ->> 'changed') || ' old=' || COALESCE(r -> 'previous', 'null'::jsonb)::text
        || ' new=' || COALESCE(r -> 'current', 'null'::jsonb)::text;
EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE, d = PG_EXCEPTION_DETAIL;
    RETURN s || ':' || COALESCE(d, '');
END
$f$;
-- audits: the scoped-setting audit rows of Org A.
CREATE FUNCTION pg_temp.audits() RETURNS integer LANGUAGE sql AS $f$
    SELECT count(*)::int FROM public.audit_log
     WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action = 'settings.updated'
       AND resource_type = 'scoped_setting'
$f$;
-- resolve: Org A's three levels for division D1 (in program P1) set directly as given (NULL = no row), then D1 resolved.
CREATE FUNCTION pg_temp.resolve(p_org jsonb, p_program jsonb, p_division jsonb) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
    DELETE FROM public.scoped_settings WHERE organization_id = 'a1111111-1111-1111-1111-111111111111';
    IF p_org IS NOT NULL THEN
        INSERT INTO public.scoped_settings (organization_id, key, value)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'standings_count_outside_results', p_org);
    END IF;
    IF p_program IS NOT NULL THEN
        INSERT INTO public.scoped_settings (organization_id, program_id, key, value)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000005c001', 'standings_count_outside_results', p_program);
    END IF;
    IF p_division IS NOT NULL THEN
        INSERT INTO public.scoped_settings (organization_id, division_id, key, value)
        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000005c101', 'standings_count_outside_results', p_division);
    END IF;
    RETURN public.scoped_setting_value('a1111111-1111-1111-1111-00000005c101', 'standings_count_outside_results')::text;
EXCEPTION WHEN OTHERS THEN
    RETURN 'ERROR ' || SQLSTATE;
END
$f$;
GRANT EXECUTE ON FUNCTION pg_temp.err(text), pg_temp.val(text), pg_temp.set(text, uuid, jsonb, text), pg_temp.audits(),
    pg_temp.resolve(jsonb, jsonb, jsonb) TO PUBLIC;

-- ── Seed (no signed-in user) ───────────────────────────────────────────────
-- Org A, season A (active, the fixture's): program P1 with divisions D1 and D3, division D2 in no program. A completed
-- season C with its program PC and division DC. Org B keeps only its fixture division.
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.programs (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-00000005c001', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Juniors');
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, program_id, max_roster_size, min_roster_size) VALUES
    ('a1111111-1111-1111-1111-00000005c101', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Scope U9', 'a1111111-1111-1111-1111-00000005c001', 14, 9),
    ('a1111111-1111-1111-1111-00000005c103', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Scope U11', 'a1111111-1111-1111-1111-00000005c001', NULL, NULL);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-00000005c102', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Scope U8');
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-00000005c0c0', 'a1111111-1111-1111-1111-111111111111', 'Org A Scope Old', 'draft', 2024);
INSERT INTO public.programs (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-00000005c0c1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000005c0c0', 'Old Juniors');
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, program_id) VALUES
    ('a1111111-1111-1111-1111-00000005c0c2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000005c0c0', 'Old U9', 'a1111111-1111-1111-1111-00000005c0c1');
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-00000005c0c3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000005c0c0', 'Old U8'),
    ('a1111111-1111-1111-1111-00000005c0c4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000005c0c0', 'Old U10');
UPDATE public.season_settings SET status = 'completed' WHERE id = 'a1111111-1111-1111-1111-00000005c0c0';

-- ── 1. The shape ───────────────────────────────────────────────────────────
SELECT is(pg_temp.val($$SELECT (to_regclass('public.scoped_settings') IS NOT NULL AND to_regclass('public.scoped_setting_keys') IS NOT NULL)::text$$),
    'true', 'the settings table and its key registry exist');
SELECT is(pg_temp.val($$SELECT string_agg(c.relname || ':' || c.relrowsecurity, ',' ORDER BY c.relname) FROM pg_class c
                         WHERE c.oid IN ('public.scoped_settings'::regclass, 'public.scoped_setting_keys'::regclass)$$),
    'scoped_setting_keys:true,scoped_settings:true', 'both have row level security');
SELECT is(pg_temp.val($$SELECT string_agg(c.relname || ':' || p.polcmd::text, ',' ORDER BY c.relname) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                         WHERE c.oid IN ('public.scoped_settings'::regclass, 'public.scoped_setting_keys'::regclass)$$),
    'scoped_setting_keys:r,scoped_settings:r', 'each has exactly one policy, for SELECT: no write policy');
SELECT is(pg_temp.val($$SELECT (has_table_privilege('authenticated', 'public.scoped_settings', 'SELECT')
                          AND NOT has_table_privilege('authenticated', 'public.scoped_settings', 'INSERT')
                          AND NOT has_table_privilege('authenticated', 'public.scoped_settings', 'UPDATE')
                          AND NOT has_table_privilege('authenticated', 'public.scoped_settings', 'DELETE')
                          AND NOT has_table_privilege('anon', 'public.scoped_settings', 'SELECT')
                          AND NOT has_table_privilege('authenticated', 'public.scoped_setting_keys', 'INSERT')
                          AND NOT has_table_privilege('anon', 'public.scoped_setting_keys', 'SELECT'))::text$$),
    'true', 'a signed-in user reads both tables and writes neither; anon reads nothing');
SELECT is(pg_temp.val($$SELECT value_type || ' ' || default_value::text || ' ' || (allowed_values IS NULL)::text FROM public.scoped_setting_keys
                         WHERE key = 'standings_count_outside_results'$$),
    'boolean false true', 'the standings key is registered: a boolean, default false');
SELECT is(pg_temp.val($$SELECT (NOT has_function_privilege('authenticated', 'public.scoped_setting_value(uuid,text)', 'EXECUTE')
                          AND NOT has_function_privilege('anon', 'public.scoped_setting_value(uuid,text)', 'EXECUTE'))::text$$),
    'true', 'the resolver is internal: no client role executes it');
SELECT is(pg_temp.val($$SELECT (has_function_privilege('authenticated', 'public.admin_set_scoped_setting(text,text,uuid,jsonb)', 'EXECUTE')
                          AND NOT has_function_privilege('anon', 'public.admin_set_scoped_setting(text,text,uuid,jsonb)', 'EXECUTE')
                          AND has_function_privilege('authenticated', 'public.admin_set_division_practice_settings(uuid,integer,integer)', 'EXECUTE')
                          AND NOT has_function_privilege('anon', 'public.admin_set_division_practice_settings(uuid,integer,integer)', 'EXECUTE'))::text$$),
    'true', 'the two setters: authenticated executes them, anon does not');

-- ── 2. Precedence ──────────────────────────────────────────────────────────
-- precedence-cases:begin
-- One assertion per line (tests/pgtapPlanCounts.test.js counts them): organization, program, division (NULL = no row),
-- then the expected value, then 'precedence <n>: <label>'.
SELECT is(pg_temp.resolve(NULL, NULL, NULL), 'false', 'precedence 1: T/F/T: none set');
SELECT is(pg_temp.resolve('true', NULL, NULL), 'true', 'precedence 2: T/F/T: organization only');
SELECT is(pg_temp.resolve(NULL, 'false', NULL), 'false', 'precedence 3: T/F/T: program only');
SELECT is(pg_temp.resolve('true', 'false', NULL), 'false', 'precedence 4: T/F/T: organization and program');
SELECT is(pg_temp.resolve(NULL, NULL, 'true'), 'true', 'precedence 5: T/F/T: division only');
SELECT is(pg_temp.resolve('true', NULL, 'true'), 'true', 'precedence 6: T/F/T: organization and division');
SELECT is(pg_temp.resolve(NULL, 'false', 'true'), 'true', 'precedence 7: T/F/T: program and division');
SELECT is(pg_temp.resolve('true', 'false', 'true'), 'true', 'precedence 8: T/F/T: all three');
SELECT is(pg_temp.resolve(NULL, NULL, NULL), 'false', 'precedence 9: F/T/F: none set');
SELECT is(pg_temp.resolve('false', NULL, NULL), 'false', 'precedence 10: F/T/F: organization only');
SELECT is(pg_temp.resolve(NULL, 'true', NULL), 'true', 'precedence 11: F/T/F: program only');
SELECT is(pg_temp.resolve('false', 'true', NULL), 'true', 'precedence 12: F/T/F: organization and program');
SELECT is(pg_temp.resolve(NULL, NULL, 'false'), 'false', 'precedence 13: F/T/F: division only');
SELECT is(pg_temp.resolve('false', NULL, 'false'), 'false', 'precedence 14: F/T/F: organization and division');
SELECT is(pg_temp.resolve(NULL, 'true', 'false'), 'false', 'precedence 15: F/T/F: program and division');
SELECT is(pg_temp.resolve('false', 'true', 'false'), 'false', 'precedence 16: F/T/F: all three');
-- precedence-cases:end
SELECT is(pg_temp.err($$SELECT public.scoped_setting_value('a1111111-1111-1111-1111-00000005c101', 'no_such_setting')$$),
    '22023:unknown_setting', 'an unknown key is refused, not read as unset');
SELECT is(pg_temp.val($$SELECT public.scoped_setting_value('00000000-0000-0000-0000-00000000dead', 'standings_count_outside_results')::text$$),
    'false', 'a division that does not exist resolves to the default');
-- The default equals today's behaviour: an organization with no row resolves as org_flag(org, key, false) did with the key absent.
SELECT is(pg_temp.val($$SELECT public.scoped_setting_value('b2222222-2222-2222-2222-22222222bcde', 'standings_count_outside_results')::text
                          || ' ' || to_jsonb(public.org_flag('b2222222-2222-2222-2222-222222222222', 'no_such_flag_key', false))::text$$),
    'false false', 'with no row the registry default equals org_flag''s for an absent key (off)');
-- The retired key is not read: a feature_flags value written after the move changes nothing.
UPDATE public.organizations SET feature_flags = feature_flags || '{"standings_count_outside_results": true}'::jsonb
 WHERE id = 'b2222222-2222-2222-2222-222222222222';
SELECT is(pg_temp.val($$SELECT public.scoped_setting_value('b2222222-2222-2222-2222-22222222bcde', 'standings_count_outside_results')::text$$),
    'false', 'the retired feature_flags key is no longer read');
DELETE FROM public.scoped_settings WHERE organization_id = 'a1111111-1111-1111-1111-111111111111';

-- ── 3. The setter ──────────────────────────────────────────────────────────
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'true'), '42501:', 'no signed-in user: refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'true'), '42501:', 'a signed-in user who is not an admin: refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'true'), '42501:', 'another organization''s admin: refused');
SELECT is(pg_temp.set('organization', 'a1111111-1111-1111-1111-111111111111', 'true'), '42501:', 'nor at the organization level');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.set('division', '00000000-0000-0000-0000-00000000dead', 'true'), '42501:', 'a division that does not exist: the same refusal');
SELECT is(pg_temp.set('season', 'a1111111-1111-1111-1111-111111111aaa', 'true'), '22023:scope_invalid', 'a scope that is not one of the three: refused');
SELECT is(pg_temp.set('program', (SELECT id FROM public.programs WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' AND is_default), 'true'),
    '22023:default_program', 'the default program ("No program") holds no value');
SELECT is(pg_temp.set('program', 'a1111111-1111-1111-1111-00000005c0c1', 'true'), '22023:season_completed', 'a program of a completed season: refused');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c0c2', 'true'), '22023:season_completed', 'a division of a completed season: refused');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'true', 'no_such_setting'), '22023:unknown_setting', 'an unknown key: refused');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', '"true"'), '22023:setting_value_invalid', 'a string for a boolean: refused');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'null'), '22023:setting_value_invalid', 'a JSON null (not "inherit"): refused');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scoped_settings WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'$$)
          || ' ' || pg_temp.audits(), '0 0', 'every refusal wrote nothing and audited nothing');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'true'), 'changed=true old=null new=true', 'control: the admin sets a division value');
SELECT is(pg_temp.audits(), 1, 'one audit row');
SELECT is(pg_temp.val($$SELECT (metadata->>'setting') || ' ' || (metadata->>'field') || ' ' || (metadata->>'scope') || ' ' || COALESCE(metadata->'old', 'null'::jsonb)::text
                          || ' ' || (metadata->'new')::text || ' ' || (metadata->>'scope_name') || ' ' || resource_id
                          FROM public.audit_log WHERE action = 'settings.updated' AND resource_type = 'scoped_setting' ORDER BY created_at DESC, id LIMIT 1$$),
    'scoped_setting standings_count_outside_results division null true Scope U9 a1111111-1111-1111-1111-00000005c101',
    'the audit row names the setting, the level, the value before ("inherited", null) and after');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'false'), 'changed=true old=true new=false', 'a change');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'false'), 'changed=false old=false new=false', 'the same value again changes nothing');
SELECT is(pg_temp.audits(), 2, 'and writes no audit row');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', NULL), 'changed=true old=false new=null', 'unset ("inherit") removes the row');
SELECT is(pg_temp.val($$SELECT count(*) || ' ' || pg_temp.audits() FROM public.scoped_settings WHERE division_id = 'a1111111-1111-1111-1111-00000005c101'$$),
    '0 3', 'no row left, and the unset is audited');
SELECT is(pg_temp.set('program', 'a1111111-1111-1111-1111-00000005c001', 'true'), 'changed=true old=null new=true', 'a program value');
SELECT is(pg_temp.set('organization', 'a1111111-1111-1111-1111-111111111111', 'false'), 'changed=true old=null new=false', 'an organization value');
SELECT is(pg_temp.val($$SELECT organization_id || ' ' || (program_id IS NULL)::text || ' ' || (division_id IS NULL)::text FROM public.scoped_settings
                         WHERE program_id = 'a1111111-1111-1111-1111-00000005c001'$$),
    'a1111111-1111-1111-1111-111111111111 false true', 'a program''s row carries the program''s own organization, read from the program');
-- No client writes the table directly, whatever it names.
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.err($$INSERT INTO public.scoped_settings (organization_id, division_id, key, value)
                        VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000005c102', 'standings_count_outside_results', 'true')$$),
    '42501:', 'an admin''s direct insert is refused');
SELECT is(pg_temp.err($$UPDATE public.scoped_settings SET value = 'false' WHERE program_id = 'a1111111-1111-1111-1111-00000005c001'$$),
    '42501:', 'and a direct update');
SELECT is(pg_temp.err($$DELETE FROM public.scoped_settings WHERE program_id = 'a1111111-1111-1111-1111-00000005c001'$$),
    '42501:', 'and a direct delete');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scoped_settings$$), '2', 'control: the admin reads the organization''s two rows');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scoped_settings$$), '0', 'another organization''s admin reads none of them');
SELECT is(pg_temp.set('division', 'b2222222-2222-2222-2222-22222222bcde', 'true'), 'changed=true old=null new=true',
    'control: the setter runs as the role authenticated for an admin of the row''s own organization');
RESET ROLE;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ── 4. The rollover ────────────────────────────────────────────────────────
-- Org A now: program P1 true, organization false. Add D1 false and D2 (no program) true: three per-season values.
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c101', 'false') || ' / ' || pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c102', 'true'),
    'changed=true old=null new=false / changed=true old=null new=true', 'seed: a value on a division in a program and on one in no program');
SELECT is(pg_temp.val($$SELECT (public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Org A Scope Next', 2027) ->> 'scoped_settings_copied')$$),
    '3', 'the next season is created from season A, and the result counts three values copied');
SELECT is(pg_temp.val($$SELECT s.value::text FROM public.scoped_settings s JOIN public.programs np ON np.id = s.program_id
                         JOIN public.season_settings ns ON ns.id = np.season_settings_id AND ns.name = 'Org A Scope Next'
                        WHERE np.copied_from_program_id = 'a1111111-1111-1111-1111-00000005c001'$$),
    'true', 'the program''s copy carries its value');
SELECT is(pg_temp.val($$SELECT string_agg(nd.name || '=' || s.value::text, ',' ORDER BY nd.name) FROM public.scoped_settings s
                         JOIN public.divisions nd ON nd.id = s.division_id
                         JOIN public.season_settings ns ON ns.id = nd.season_settings_id AND ns.name = 'Org A Scope Next'$$),
    'Scope U8=true,Scope U9=false', 'each division''s copy carries its value, found by name (enumerated from the source''s rows)');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scoped_settings s JOIN public.programs np ON np.id = s.program_id
                         JOIN public.season_settings ns ON ns.id = np.season_settings_id AND ns.name = 'Org A Scope Next' WHERE np.is_default$$),
    '0', 'the new default program holds none');
SELECT is(pg_temp.val($$SELECT count(*) FROM public.scoped_settings WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
                          AND program_id IS NULL AND division_id IS NULL$$),
    '1', 'the organization value is not per season and is not copied');
SELECT is(pg_temp.val($$SELECT metadata->>'scoped_settings_copied' FROM public.audit_log WHERE action = 'season.created_from'
                          AND organization_id = 'a1111111-1111-1111-1111-111111111111' ORDER BY created_at DESC, id LIMIT 1$$),
    '3', 'the season.created_from audit row counts them');
SELECT is(pg_temp.val($$SELECT string_agg(nd.name || ':' || COALESCE(nd.max_roster_size::text, '-'), ',' ORDER BY nd.name) FROM public.divisions nd
                         JOIN public.season_settings ns ON ns.id = nd.season_settings_id AND ns.name = 'Org A Scope Next'$$),
    'Org A U10:-,Scope U11:-,Scope U8:-,Scope U9:14', 'control: the divisions themselves are copied as before');

-- ── 5. The seam: standings_counts_outside follows the cascade ──────────────
-- Org A: organization false, P1 true, D1 false (own), D3 in P1 (none of its own), D2 true (own, no program), U10 (none, no program).
SELECT is(pg_temp.val($$SELECT string_agg(d.name || '=' || public.standings_counts_outside(d.id)::text, ',' ORDER BY d.name)
                         FROM public.divisions d WHERE d.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    'Org A U10=false,Scope U11=true,Scope U8=true,Scope U9=false',
    'the seam reads the cascade: a division''s own value, else its program''s, else the organization''s');
-- The completed season C: Old U9 (in Old Juniors, which has no value), Old U8 (no program) and Old U10 (no program, a
-- value of its own, true). Before the change all but Old U10 inherit the organization's false.
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.scoped_settings (organization_id, division_id, key, value) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-00000005c0c4', 'standings_count_outside_results', 'true');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.set('organization', 'a1111111-1111-1111-1111-111111111111', 'true'), 'changed=true old=false new=true', 'the organization turns it on');
SELECT is(pg_temp.val($$SELECT metadata->>'frozen_completed_divisions' FROM public.audit_log WHERE action = 'settings.updated' AND resource_type = 'scoped_setting'
                         AND metadata->>'scope' = 'organization' AND metadata->'new' = 'true'::jsonb$$),
    '2', 'the change first held the completed season''s two inheriting divisions at their value, counted in its audit row');
SELECT is(pg_temp.val($$SELECT string_agg(d.name || '=' || public.standings_counts_outside(d.id)::text, ',' ORDER BY d.name)
                         FROM public.divisions d WHERE d.season_settings_id = 'a1111111-1111-1111-1111-00000005c0c0'$$),
    'Old U10=true,Old U8=false,Old U9=false',
    'a completed season''s history is not rewritten: its inheriting divisions keep false, its own true stays true');
SELECT is(pg_temp.val($$SELECT string_agg(d.name || ':' || s.frozen_from_organization::text, ',' ORDER BY d.name) FROM public.scoped_settings s
                         JOIN public.divisions d ON d.id = s.division_id WHERE d.season_settings_id = 'a1111111-1111-1111-1111-00000005c0c0'$$),
    'Old U10:false,Old U8:true,Old U9:true', 'the two held rows are marked frozen; the division''s own row is untouched');
SELECT is(pg_temp.val($$SELECT (public.admin_create_season_from('a1111111-1111-1111-1111-00000005c0c0', 'Org A Scope Old Next', 2025) ->> 'scoped_settings_copied')$$),
    '1', 'a season made from the completed one copies the division''s own value and not the frozen ones (the next season inherits)');
SELECT is(pg_temp.val($$SELECT string_agg(d.name || '=' || public.standings_counts_outside(d.id)::text, ',' ORDER BY d.name)
                         FROM public.divisions d WHERE d.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    'Org A U10=true,Scope U11=true,Scope U8=true,Scope U9=false',
    'a division with no value of its own, in no program, follows the organization; an explicit false still wins');
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.val($$SELECT public.standings_counts_outside('a1111111-1111-1111-1111-00000005c103')::text$$), 'true',
    'a signed-in member reads it as the role (the seam is a definer over the internal resolver)');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.val($$SELECT public.standings_counts_outside('a1111111-1111-1111-1111-00000005c103')::text$$), 'false',
    'a member of another organization gets false: the seam is not an oracle');
RESET ROLE;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT (p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] AND p.prosrc ~ 'is_org_member'
                          AND p.prosrc ~ 'scoped_setting_value' AND p.prosrc !~ 'org_flag')::text
                          FROM pg_proc p WHERE p.oid = to_regprocedure('public.standings_counts_outside(uuid)')$$),
    'true', 'the seam''s body: a definer with the member check that reads the resolver and not org_flag');

-- Tenancy: a row's organization is its program's or division's, whoever writes it (the definer path here).
SELECT is(pg_temp.err($$INSERT INTO public.scoped_settings (organization_id, division_id, key, value)
                        VALUES ('b2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-00000005c103', 'standings_count_outside_results', 'true')$$),
    '23514:', 'a row naming another organization''s division is refused');
SELECT is(pg_temp.err($$INSERT INTO public.scoped_settings (organization_id, program_id, key, value)
                        VALUES ('b2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-00000005c001', 'standings_count_outside_results', 'true')$$),
    '23514:', 'and one naming another organization''s program');

-- ── 6. admin_set_division_practice_settings ────────────────────────────────
SET LOCAL "request.jwt.claims" TO '{}';
UPDATE public.divisions SET practices_per_week = 1, practice_minutes = NULL, min_teams = 2, max_teams = 4
 WHERE id = 'a1111111-1111-1111-1111-00000005c101';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT (public.admin_set_division_practice_settings('a1111111-1111-1111-1111-00000005c101', 2, 60) ->> 'changed')$$),
    'true', 'the admin sets a division''s practices a week and length');
SELECT is(pg_temp.val($$SELECT practices_per_week || ' ' || practice_minutes || ' ' || max_roster_size || ' ' || min_roster_size || ' ' || min_teams || ' ' || max_teams
                         FROM public.divisions WHERE id = 'a1111111-1111-1111-1111-00000005c101'$$),
    '2 60 14 9 2 4', 'only the two practice columns changed; the roster rules are as they were');
SELECT is(pg_temp.val($$SELECT (public.admin_set_division_practice_settings('a1111111-1111-1111-1111-00000005c101', NULL, 0) ->> 'changed')$$)
          || ' ' || pg_temp.val($$SELECT practices_per_week || ' ' || COALESCE(practice_minutes::text, 'any') FROM public.divisions WHERE id = 'a1111111-1111-1111-1111-00000005c101'$$),
    'true 2 any', 'null keeps the count, 0 clears the length to any slot length');
SELECT is(pg_temp.val($$SELECT (public.admin_set_division_practice_settings('a1111111-1111-1111-1111-00000005c101', NULL, NULL) ->> 'changed')$$),
    'false', 'nothing given changes nothing');
SELECT is(pg_temp.val($$SELECT count(*) || ' ' || string_agg(DISTINCT metadata->>'setting', ',') || ' ' || bool_and(NOT (metadata->'current' ? 'max_roster_size'))
                         || ' ' || max(metadata->'previous'->>'practices_per_week') FILTER (WHERE metadata->'current'->>'practice_minutes' = '60')
                         FROM public.audit_log WHERE action = 'settings.updated' AND resource_type = 'division'
                          AND resource_id = 'a1111111-1111-1111-1111-00000005c101'$$),
    '2 division_team_generation_rules true 1', 'one audit row per change, naming only the practice settings, with the value before');
SELECT is(pg_temp.err($$SELECT public.admin_set_division_practice_settings('a1111111-1111-1111-1111-00000005c101', 8, NULL)$$), '23514:',
    'eight practices a week: refused');
SELECT is(pg_temp.err($$SELECT public.admin_set_division_practice_settings('a1111111-1111-1111-1111-00000005c101', NULL, 10)$$), '23514:',
    'a ten-minute practice: refused');
SELECT is(pg_temp.err($$SELECT public.admin_set_division_practice_settings('a1111111-1111-1111-1111-00000005c0c2', 2, NULL)$$), '22023:season_completed',
    'a division of a completed season: refused');
SELECT is(pg_temp.err($$SELECT public.admin_set_division_practice_settings('b2222222-2222-2222-2222-22222222bcde', 2, NULL)$$), '42501:',
    'another organization''s division: refused');
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.err($$SELECT public.admin_set_division_practice_settings('a1111111-1111-1111-1111-00000005c101', 3, NULL)$$), '42501:',
    'no signed-in user: refused');
SELECT is(pg_temp.val($$SELECT practices_per_week || ' ' || COALESCE(practice_minutes::text, 'any') FROM public.divisions WHERE id = 'a1111111-1111-1111-1111-00000005c101'$$),
    '2 any', 'and every refusal left the division as it was');

-- ── 6b. A text set has one spelling: code point order (COLLATE "C") ────────
-- A registry row made for this test only (rolled back with it): mixed case, an accented letter, a fullwidth letter
-- and an astral one, where code point order and UTF-16 order differ (tests/scopedSettings.test.js holds core's
-- canonical order to the same expected text).
SET LOCAL "request.jwt.claims" TO '{}';
INSERT INTO public.scoped_setting_keys (key, value_type, allowed_values, default_value, label) VALUES
    ('zz_scope_test_set', 'text_set', '["a", "B", "é", "ｚ", "𝒜"]', '[]', 'Test set');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c102', '["𝒜", "ｚ", "é", "a", "B"]', 'zz_scope_test_set'),
    'changed=true old=null new=["B", "a", "é", "ｚ", "𝒜"]', 'a text set is stored in code point order');
SELECT is(pg_temp.set('division', 'a1111111-1111-1111-1111-00000005c102', '["a", "a"]', 'zz_scope_test_set'),
    '22023:setting_value_invalid', 'a text set with a repeat is refused');

-- ── 7. A deleted program takes its values with it (S8) ─────────────────────
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.val($$SELECT (public.admin_delete_program('a1111111-1111-1111-1111-00000005c001') IS NOT NULL)::text$$)
          || ' ' || pg_temp.val($$SELECT count(*) FROM public.scoped_settings WHERE program_id = 'a1111111-1111-1111-1111-00000005c001'$$),
    'true 0', 'deleting the program removes its value');
SELECT is(pg_temp.val($$SELECT public.standings_counts_outside('a1111111-1111-1111-1111-00000005c103')::text
                          || ' ' || public.standings_counts_outside('a1111111-1111-1111-1111-00000005c101')::text$$),
    'true false', 'its divisions now follow the organization (true), and a division''s own value still wins (false)');

SELECT * FROM finish();
ROLLBACK;
