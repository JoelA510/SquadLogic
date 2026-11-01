-- pgTAP: the practice preference import (Phase D, C1; migration 20261112010000).
--
-- A preference file is staged like a coach file (import type `practice_preferences` in
-- `staging_import_rows`) and applied by `finalize_practice_preference_import_job`: one rule per row and
-- team, the coach by email within the job's season and the team by name within the season, a blank team
-- for a coach of several teams making one rule per team, an unknown coach or team listed and never
-- created, a re-import replacing the imported rules of the teams the file names and leaving admin rules
-- alone, a requested must pending until an admin accepts it. The rules themselves are
-- practice_preference_rules.sql.
--
-- Every date is relative to CURRENT_DATE (the coach's assignment is read as of today).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(52);

-- ---- the roster (as the table owner) -----------------------------------------------------------
-- Org A, season aaa (active): teams "Imp A1" and "Imp A2" (coach P coaches both), "Imp A3" (coach Q coaches it),
-- "Imp Solo" (coach R). Venues "Imp Park" and "Imp Fields, North" (a name with a comma). Season ccc is completed.
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000a1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Imp A1'),
    ('aaaaaaaa-0000-0000-0000-0000000000a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Imp A2'),
    ('aaaaaaaa-0000-0000-0000-0000000000a3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Imp A3'),
    ('aaaaaaaa-0000-0000-0000-0000000000a4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Imp Solo');
INSERT INTO public.coaches (id, organization_id, season_settings_id, full_name, email, status) VALUES
    ('c0000000-0000-4000-8000-0000000000a1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Imp Coach P', 'imp-p@test.local', 'active'),
    ('c0000000-0000-4000-8000-0000000000a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Imp Coach Q', 'imp-q@test.local', 'active'),
    ('c0000000-0000-4000-8000-0000000000a3', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Imp Coach R', 'imp-r@test.local', 'active'),
    ('c0000000-0000-4000-8000-0000000000a4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Imp Coach S (no team)', 'imp-s@test.local', 'active'),
    ('c0000000-0000-4000-8000-0000000000b1', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222bbb', 'Imp Coach B', 'imp-b@test.local', 'active');
INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, started_via) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-4000-8000-0000000000a1', 'lead', CURRENT_DATE - 30, 'test'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'c0000000-0000-4000-8000-0000000000a1', 'lead', CURRENT_DATE - 30, 'test'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a3', 'c0000000-0000-4000-8000-0000000000a2', 'lead', CURRENT_DATE - 30, 'test'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a4', 'c0000000-0000-4000-8000-0000000000a3', 'lead', CURRENT_DATE - 30, 'test');
INSERT INTO public.locations (id, organization_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111100c1', 'a1111111-1111-1111-1111-111111111111', 'Imp Park'),
    ('a1111111-1111-1111-1111-1111111100c2', 'a1111111-1111-1111-1111-111111111111', 'Imp Fields, North');
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-111111111ccc', 'a1111111-1111-1111-1111-111111111111', 'Org A Fall 2025', 'completed', 2025);
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-111111111ddd', 'a1111111-1111-1111-1111-111111111111', 'Org A Fall 2027 draft', 'draft', 2027);
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, season_settings_id) VALUES
    ('a1111111-1111-1111-1111-1111111b0001', 'a1111111-1111-1111-1111-111111111111', 'registration', 'imports/test/prefs-1.csv', 'importing', 'a1111111-1111-1111-1111-111111111aaa'),
    ('a1111111-1111-1111-1111-1111111b0002', 'a1111111-1111-1111-1111-111111111111', 'registration', 'imports/test/prefs-2.csv', 'importing', 'a1111111-1111-1111-1111-111111111aaa'),
    ('a1111111-1111-1111-1111-1111111b0003', 'a1111111-1111-1111-1111-111111111111', 'registration', 'imports/test/prefs-3.csv', 'importing', 'a1111111-1111-1111-1111-111111111ccc');

-- File 1. Row 1: P, no team (two teams): any of Tue and Thu, "5:00 PM" or "6pm", must. Row 2: Q on its team,
-- a venue by name and a window, high priority. Row 3: unknown coach. Row 4: unknown team. Row 5: R names
-- Q's team. Row 6: S coaches none and names none. Row 7: an unknown day. Row 8: row 1 again (a duplicate).
-- Row 9: an unknown venue. Row 10: R, the venue name with a comma, keep as prefer by default.
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload) VALUES
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 1, '{}',
  '{"email":"imp-p@test.local","request_level":"Must","weekdays":"Tuesday and Thursday","start_times":"5:00 PM; 6pm"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 2, '{}',
  '{"email":"imp-q@test.local","team_name":"imp a3","venues":"Imp Park","effective_from":"2099-01-05","effective_to":"1/31/2099","coach_priority":"High"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 3, '{}',
  '{"email":"nobody@test.local","weekdays":"Mon"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 4, '{}',
  '{"email":"imp-p@test.local","team_name":"No Such Team","weekdays":"Mon"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 5, '{}',
  '{"email":"imp-r@test.local","team_name":"Imp A3","weekdays":"Mon"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 6, '{}',
  '{"email":"imp-s@test.local","weekdays":"Mon"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 7, '{}',
  '{"email":"imp-p@test.local","weekdays":"Funday"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 8, '{}',
  '{"email":"imp-p@test.local","request_level":"must","weekdays":"Thu, Tue","start_times":"17:00, 18:00"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 9, '{}',
  '{"email":"imp-r@test.local","venues":"Imp Park; Somewhere Else"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0001', 'practice_preferences', 10, '{}',
  '{"email":"IMP-R@test.local ","venues":"Imp Fields, North","request_level":"prefer"}');
-- A staged file for the completed season, and a rule an admin added by hand on Imp A1 (the re-import leaves it alone).
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload) VALUES
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0003', 'practice_preferences', 1, '{}', '{"email":"imp-p@test.local","weekdays":"Mon"}');
INSERT INTO public.coach_practice_preferences
    (id, organization_id, coach_id, team_id, weekdays, level, requested_level, status, source) VALUES
    ('c0000000-0000-4000-8000-0000000000f1', 'a1111111-1111-1111-1111-111111111111', 'c0000000-0000-4000-8000-0000000000a1',
     'aaaaaaaa-0000-0000-0000-0000000000a1', ARRAY['FRI'], 'prefer', 'prefer', 'in_force', 'admin');

-- ---- the allowlist, the import type and the lifecycle RPCs ------------------------------------------
SELECT is(
    public.import_allowed_keys('practice_preferences'),
    ARRAY['email', 'team_name', 'team name', 'team', 'request_level', 'weekdays', 'days', 'day',
          'start_times', 'start_time', 'start', 'venues', 'location', 'effective_from',
          'valid_from', 'effective_to', 'valid_until', 'coach_priority']::text[],
    'the SQL allowlist for practice_preferences is the 18 keys the finalizer reads');
SELECT is(public.import_allowed_keys('nonsense'), ARRAY[]::text[], 'an unknown import type keeps nothing');

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT throws_ok(
    $$SELECT public.finalize_practice_preference_import_job('a1111111-1111-1111-1111-1111111b0001')$$,
    '42501', NULL, 'a signed-in non-member cannot apply a preference file');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT throws_ok(
    $$SELECT public.finalize_practice_preference_import_job('a1111111-1111-1111-1111-1111111b0001')$$,
    '42501', NULL, 'another organization''s admin cannot apply a preference file');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT lives_ok(
    $$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'practice_preferences', 'prefs.csv')$$,
    'create_import_job opens a job of the practice_preferences type');
SELECT is(
    (SELECT job_type FROM public.import_jobs WHERE storage_path LIKE '%/prefs.csv'),
    'registration', 'it is a registration job, like players and coaches');
SELECT throws_ok(
    $$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'preferences', 'x.csv')$$,
    '22023', NULL, 'an import type it does not know is still refused');
SELECT lives_ok(
    $$SELECT public.mark_import_job_ready_to_apply('a1111111-1111-1111-1111-1111111b0002', 'practice_preferences')$$,
    'a preference job can wait to be applied');
SELECT is((SELECT status FROM public.import_jobs WHERE id = 'a1111111-1111-1111-1111-1111111b0002'), 'ready_to_apply', 'and is ready to apply');
SELECT lives_ok(
    $$SELECT public.cancel_ready_import_job('a1111111-1111-1111-1111-1111111b0002', 'practice_preferences')$$,
    'and can be canceled');

-- ---- the active season or a draft takes a preference job; a completed season never does (E3b's rule) ---
SELECT lives_ok(
    $$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'practice_preferences', 'draft-prefs.csv',
                                      'a1111111-1111-1111-1111-111111111ddd')$$,
    'a preference job opens for a draft season, as a player or coach job does');
SELECT is(
    (SELECT season_settings_id FROM public.import_jobs WHERE storage_path LIKE '%/draft-prefs.csv'),
    'a1111111-1111-1111-1111-111111111ddd'::uuid, 'and it carries that season');
SELECT throws_ok(
    $$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'practice_preferences', 'old-prefs.csv',
                                      'a1111111-1111-1111-1111-111111111ccc')$$,
    '22023', 'season a1111111-1111-1111-1111-111111111ccc is completed and takes no import',
    'but not for a completed season');
SELECT throws_ok(
    $$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'fields', 'draft-fields.csv',
                                      'a1111111-1111-1111-1111-111111111ddd')$$,
    '22023', NULL, 'and a field import still takes the active season only (E3b''s rule is unchanged)');

-- ---- a completed season takes no import --------------------------------------------------------------
SELECT throws_ok(
    $$SELECT public.finalize_practice_preference_import_job('a1111111-1111-1111-1111-1111111b0003')$$,
    '22023', 'Season a1111111-1111-1111-1111-111111111ccc is completed and takes no import',
    'a preference file for a completed season is refused');
SELECT is((SELECT count(*)::int FROM public.coach_practice_preferences WHERE import_job_id = 'a1111111-1111-1111-1111-1111111b0003'), 0,
    'and wrote nothing');

-- ---- overlapping files run one after the other: the teams a file names are locked -----------------------
-- A true two-session race does not fit one transaction, so this asserts what makes the race impossible and
-- can be read here: after a file is applied THIS backend holds a transaction-scoped advisory lock for each
-- team the file names (and none for any other), and the source takes them in id order, before the replacement
-- it protects. The control, before the call, is that none is held.
CREATE FUNCTION pg_temp.team_locks_held() RETURNS text[] LANGUAGE sql AS $f$
    SELECT COALESCE(array_agg(t.name ORDER BY t.name), ARRAY[]::text[])
      FROM public.teams t
     WHERE t.organization_id = 'a1111111-1111-1111-1111-111111111111'
       AND EXISTS (
           SELECT 1 FROM pg_locks l
            WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted AND l.objsubid = 1
              AND l.classid = ((hashtextextended('practice_preferences:team:' || t.id::text, 0) >> 32) & 4294967295)::bigint::oid
              AND l.objid = (hashtextextended('practice_preferences:team:' || t.id::text, 0) & 4294967295)::bigint::oid)
$f$;
SELECT is(pg_temp.team_locks_held(), ARRAY[]::text[], 'control: before a file is applied, no team lock is held');

-- ---- file 1 ------------------------------------------------------------------------------------------
CREATE TEMP TABLE t_result AS
SELECT public.finalize_practice_preference_import_job('a1111111-1111-1111-1111-1111111b0001') AS r;
GRANT SELECT ON t_result TO authenticated;

SELECT is(pg_temp.team_locks_held(), ARRAY['Imp A1', 'Imp A2', 'Imp A3', 'Imp Solo']::text[],
    'applying a file locks each team it names (the four here) and no other team');
SELECT ok(
    (SELECT position('pg_advisory_xact_lock' IN p.prosrc) > 0
        AND position('pg_advisory_xact_lock' IN p.prosrc) < position('SET status = ''replaced''' IN p.prosrc)
        AND p.prosrc ~ 'array_agg\(DISTINCT \(r ->> ''team_id''\)::uuid ORDER BY \(r ->> ''team_id''\)::uuid\)'
        AND position('FOREACH v_team_id IN ARRAY v_teams_named' IN p.prosrc) < position('pg_advisory_xact_lock' IN p.prosrc)
       FROM pg_proc p WHERE p.oid = 'public.finalize_practice_preference_import_job(uuid, jsonb)'::regprocedure),
    'the teams are collected in id order and locked, in that order, before the imported rules are replaced');

SELECT is((SELECT r ->> 'status' FROM t_result), 'completed_with_warnings', 'the file completes with warnings: it had rows that were not applied');
SELECT is((SELECT (r ->> 'inserted_rules')::int FROM t_result), 4,
    'four rules: P''s two teams (row 1), Q (row 2) and R (row 10)');
SELECT results_eq(
    $$SELECT t.name, p.weekdays, p.start_minutes, p.level, p.requested_level, p.must_decision
        FROM public.coach_practice_preferences p JOIN public.teams t ON t.id = p.team_id
       WHERE p.import_job_id = 'a1111111-1111-1111-1111-1111111b0001' AND p.coach_id = 'c0000000-0000-4000-8000-0000000000a1'
       ORDER BY t.name$$,
    $$VALUES ('Imp A1'::text, ARRAY['TUE', 'THU']::text[], ARRAY[1020, 1080]::integer[], 'prefer'::text, 'must'::text, 'pending'::text),
             ('Imp A2'::text, ARRAY['TUE', 'THU']::text[], ARRAY[1020, 1080]::integer[], 'prefer'::text, 'must'::text, 'pending'::text)$$,
    'a blank team for a coach of two teams makes one rule per team, "Tuesday and Thursday" and "5:00 PM; 6pm" read as sets, and a must waits as prefer');
SELECT is((SELECT (r ->> 'pending_musts')::int FROM t_result), 2, 'two pending musts are counted');
SELECT is((SELECT (r ->> 'duplicate_rule_rows')::int FROM t_result), 2,
    'row 8 repeats row 1 in another order and writes nothing new: its two teams count as two duplicates');
SELECT results_eq(
    $$SELECT t.name, p.venue_ids, p.effective_from, p.effective_to, p.coach_priority, p.level, p.requested_level, p.must_decision
        FROM public.coach_practice_preferences p JOIN public.teams t ON t.id = p.team_id
       WHERE p.import_job_id = 'a1111111-1111-1111-1111-1111111b0001' AND p.coach_id = 'c0000000-0000-4000-8000-0000000000a2'$$,
    $$VALUES ('Imp A3'::text, ARRAY['a1111111-1111-1111-1111-1111111100c1'::uuid], DATE '2099-01-05', DATE '2099-01-31', 'high'::text, 'prefer'::text, 'prefer'::text, NULL::text)$$,
    'a team by name (any case), a venue by name, a window in two date forms and a priority');
SELECT results_eq(
    $$SELECT t.name, p.venue_ids FROM public.coach_practice_preferences p JOIN public.teams t ON t.id = p.team_id
       WHERE p.import_job_id = 'a1111111-1111-1111-1111-1111111b0001' AND p.coach_id = 'c0000000-0000-4000-8000-0000000000a3'$$,
    $$VALUES ('Imp Solo'::text, ARRAY['a1111111-1111-1111-1111-1111111100c2'::uuid])$$,
    'a venue whose name holds a comma is one venue; an email is matched trimmed and in any case; a coach of one team needs no team column');
SELECT is((SELECT r -> 'unknown_coaches' -> 0 ->> 'email' FROM t_result), 'nobody@test.local', 'an unknown coach is listed with its row');
SELECT is((SELECT (r ->> 'unknown_coach_rows')::int FROM t_result), 1, 'one unknown-coach row');
SELECT is((SELECT r -> 'unknown_teams' -> 0 ->> 'team' FROM t_result), 'No Such Team', 'an unknown team is listed');
SELECT is((SELECT (r ->> 'no_team_rows')::int FROM t_result), 1, 'a coach with no team and no team named is listed apart');
SELECT is((SELECT (r ->> 'coach_not_on_team_rows')::int FROM t_result), 1, 'a team the coach does not coach is refused (row 5)');
SELECT is((SELECT (r ->> 'invalid_rows')::int FROM t_result), 2, 'an unknown day (row 7) and an unknown venue (row 9) are invalid rows');
SELECT is(
    (SELECT count(*)::int FROM public.coaches WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND email = 'nobody@test.local'),
    0, 'an unknown coach is never created');
SELECT is(
    (SELECT count(*)::int FROM public.teams WHERE name = 'No Such Team'), 0, 'an unknown team is never created');
SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a3' AND coach_id <> 'c0000000-0000-4000-8000-0000000000a2'),
    0, 'R''s row for Q''s team wrote nothing');
SELECT is(
    (SELECT validation_errors -> 0 ->> 'message' FROM public.staging_import_rows
      WHERE import_job_id = 'a1111111-1111-1111-1111-1111111b0001' AND source_row_number = 3),
    'No coach with this email in the season', 'the reason is written to the staged row, without the email');

-- ---- what is stored on the job and in the audit log carries no coach email -------------------------
RESET role;
SELECT is((SELECT status FROM public.import_jobs WHERE id = 'a1111111-1111-1111-1111-1111111b0001'), 'completed_with_warnings', 'the job is completed with warnings');
SELECT is(
    (SELECT count(*)::int FROM public.import_jobs
      WHERE id = 'a1111111-1111-1111-1111-1111111b0001' AND warning_summary::text LIKE '%nobody@test.local%'),
    0, 'the job''s stored summary does not hold the unknown coach''s email');
SELECT is(
    (SELECT count(*)::int FROM public.audit_log
      WHERE resource_id = 'a1111111-1111-1111-1111-1111111b0001' AND metadata::text LIKE '%@test.local%'),
    0, 'and neither does any audit row of the import');
SELECT is(
    (SELECT array_agg(action ORDER BY action) FROM public.audit_log
      WHERE resource_id = 'a1111111-1111-1111-1111-1111111b0001' AND action IN ('import.completed', 'practice_preference.imported')),
    ARRAY['import.completed', 'practice_preference.imported']::text[], 'the import is audited: completed, and which rules it wrote');

-- ---- accept all, from the file's own pending musts -----------------------------------------------------
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT (public.admin_accept_all_musts('a1111111-1111-1111-1111-1111111b0001', 2) ->> 'accepted')::int), 2,
    'Accept all names the file''s two pending musts');

-- ---- a re-import replaces only the imported rules of the teams the file names ----------------------------
RESET role;
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, season_settings_id) VALUES
    ('a1111111-1111-1111-1111-1111111b0004', 'a1111111-1111-1111-1111-111111111111', 'registration', 'imports/test/prefs-4.csv', 'importing', 'a1111111-1111-1111-1111-111111111aaa');
-- P's file now names only Imp A1 (Mon) -- not Imp A2; Q's team A3 is not named at all.
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload) VALUES
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0004', 'practice_preferences', 1, '{}',
  '{"email":"imp-p@test.local","team_name":"Imp A1","weekdays":"Mon"}');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE t_result2 AS SELECT public.finalize_practice_preference_import_job('a1111111-1111-1111-1111-1111111b0004') AS r;
GRANT SELECT ON t_result2 TO authenticated;
SELECT is((SELECT r ->> 'status' FROM t_result2), 'completed', 'a clean file completes without warnings');
SELECT is((SELECT (r ->> 'replaced_rules')::int FROM t_result2), 1, 'it replaced the one imported rule of the team it names (Imp A1)');
SELECT results_eq(
    $$SELECT t.name, p.status, p.source FROM public.coach_practice_preferences p JOIN public.teams t ON t.id = p.team_id
       WHERE p.coach_id = 'c0000000-0000-4000-8000-0000000000a1' ORDER BY t.name, p.status, p.source$$,
    $$VALUES ('Imp A1'::text, 'in_force'::text, 'admin'::text),
             ('Imp A1'::text, 'in_force'::text, 'import'::text),
             ('Imp A1'::text, 'replaced'::text, 'import'::text),
             ('Imp A2'::text, 'in_force'::text, 'import'::text)$$,
    'Imp A1''s old imported rule is replaced, the admin''s rule on it stays, and Imp A2, which the file did not name, keeps its imported rule');
SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences
      WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a3' AND status = 'in_force'),
    1, 'a team the file does not name keeps its imported rule');
SELECT results_eq(
    $$SELECT level, requested_level, must_decision FROM public.coach_practice_preferences
       WHERE import_job_id = 'a1111111-1111-1111-1111-1111111b0004'$$,
    $$VALUES ('prefer'::text, 'prefer'::text, NULL::text)$$,
    'the replacing rule is a plain prefer');
SELECT results_eq(
    $$SELECT level, must_decision FROM public.coach_practice_preferences
       WHERE import_job_id = 'a1111111-1111-1111-1111-1111111b0001' AND status = 'replaced'$$,
    $$VALUES ('must'::text, 'accepted'::text)$$,
    'the replaced rule keeps what it was: an accepted must, as history');

-- Applying a file twice finds nothing left to apply.
SELECT is((public.finalize_practice_preference_import_job('a1111111-1111-1111-1111-1111111b0004') ->> 'inserted_rules')::int, 0,
    'a second finalize of the same file writes nothing: its rows are applied');
SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences WHERE import_job_id = 'a1111111-1111-1111-1111-1111111b0004'),
    1, 'and the file''s rule is still one');

-- Rows with a problem are not applied and each says why; the clock times read as written (12am is 0).
RESET role;
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, season_settings_id) VALUES
    ('a1111111-1111-1111-1111-1111111b0005', 'a1111111-1111-1111-1111-111111111111', 'registration', 'imports/test/prefs-5.csv', 'importing', 'a1111111-1111-1111-1111-111111111aaa');
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload) VALUES
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0005', 'practice_preferences', 1, '{}', '{"email":"imp-q@test.local","weekdays":"Mon","request_level":"whenever"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0005', 'practice_preferences', 2, '{}', '{"email":"imp-q@test.local","weekdays":"Mon","coach_priority":"urgent"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0005', 'practice_preferences', 3, '{}', '{"email":"imp-q@test.local","weekdays":"Mon","effective_from":"2099-02-01","effective_to":"2099-01-01"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0005', 'practice_preferences', 4, '{}', '{"email":"imp-q@test.local","team_name":"Imp A3"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0005', 'practice_preferences', 5, '{}', '{"email":"imp-q@test.local","weekdays":"Mon","effective_from":"2099-02-30"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0005', 'practice_preferences', 6, '{}', '{"email":"imp-q@test.local","start_times":"12am, 12:30 pm, 25:00"}'),
 ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-1111111b0005', 'practice_preferences', 7, '{}', '{"email":"imp-q@test.local","start_times":"12am, 12:30 pm, 5:05 p.m."}');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE t_result3 AS SELECT public.finalize_practice_preference_import_job('a1111111-1111-1111-1111-1111111b0005') AS r;
SELECT is((SELECT (r ->> 'invalid_rows')::int FROM t_result3), 6,
    'an unknown request level, an unknown priority, a reversed window, no condition, an impossible date and an unreadable time are each an invalid row');
SELECT is((SELECT (r ->> 'inserted_rules')::int FROM t_result3), 1, 'only the clean row wrote a rule');
SELECT results_eq(
    $$SELECT start_minutes FROM public.coach_practice_preferences WHERE import_job_id = 'a1111111-1111-1111-1111-1111111b0005'$$,
    $$VALUES (ARRAY[0, 750, 1025]::integer[])$$,
    '12am is minute 0, 12:30 pm is 750 and 5:05 p.m. is 1025, in ascending order');

SELECT * FROM finish();
ROLLBACK;
