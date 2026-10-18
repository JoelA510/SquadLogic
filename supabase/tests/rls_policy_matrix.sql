-- RLS persona matrix: what each persona can read and write, table by table,
-- on the 26 tables whose policies the Supabase performance advisors flag
-- (`auth_rls_initplan`, `multiple_permissive_policies`; the waivers in
-- docs/security/supabase-advisor-waivers.json). docs/PLAN_RLS_ADVISOR_REWRITE.md
-- section 4.2.
--
-- **Why it exists.** The advisor rewrite wraps `auth.uid()` as
-- `(select auth.uid())`, splits each admin `FOR ALL` policy into INSERT,
-- UPDATE and DELETE policies, and drops one redundant `import_jobs` policy. It
-- is meant to change no access at all. This file records, against today's
-- policies, the access every persona has, and lands on `main` before the
-- rewrite does; the rewrite must leave it green WITHOUT editing it. A change
-- to this file's expected table in the same pull request as a policy change is
-- an access change, and has to be argued as one.
--
-- **Personas** (seven): the fixtures' Alice (admin of Org A), Charlie (coach
-- of Org A) and Bob (admin of Org B), plus three seeded here: a
-- `tenant_admin` of Org A, a parent of Org A, and a signed-in user with no
-- membership anywhere ("outsider"); and the `anon` role.
--
-- **Subjects**: the 26 tables, as a literal list taken from the advisor
-- findings (the plan's section 1), never derived from `pg_policies`, so a
-- dropped policy cannot shrink the set. Each table carries one row in Org A
-- and one in Org B (from the fixtures where they have one, seeded below
-- otherwise).
--
-- **Probes**, per persona and table (26 x 7 x 4 = 728 cells):
--   sel  which of the two subject rows SELECT returns: 'AB', 'A', 'B' or '-';
--   ins  an INSERT of a new Org A row: 'ok', or 'rls' (refused by a policy's
--        WITH CHECK), or 'grant' (refused by a table privilege);
--   upd  how many rows an UPDATE of Org A's subject row reaches (each sets one
--        column to itself), or 'rls'/'grant';
--   del  how many rows a DELETE of Org A's subject row reaches, or 'grant'.
-- Every write probe undoes itself: it raises the private SQLSTATE `MXUND`
-- after the write and catches only that (and 42501, the refusal it is
-- measuring), so its subtransaction rolls back and no probe sees another's
-- effect. Any other error is not caught: it aborts the test.
--
-- **Assertions** (32): five meta-assertions (the subject list is 26
-- RLS-enabled tables, every subject row was seeded, every persona ran as the
-- identity it claims, the expected table covers all 182 table-persona pairs,
-- the probes produced all 728 cells); one that no cell anywhere differs from
-- the literal expected table below; and one `results_eq` per table, so a
-- failure names its table. Every differing cell is printed as a diagnostic.
--
-- The expected table was generated on `main` (a31ddde, 82 policies) and each
-- row was then checked by hand against the policy text it follows; the notes
-- beside the rows say which policy decides.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(32);

-- ── 1. The three personas the fixtures lack, and a spare user ─────────────
-- The spare user exists only so the profiles INSERT probe has an auth user
-- with no profile yet (handle_new_user creates one; it is removed again).
INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role)
VALUES
    ('44444444-4444-4444-4444-444444444444', 'tara@test.local',
     jsonb_build_object('full_name', 'Tara Tenant-Admin-A', 'password_length', 12), 'authenticated', 'authenticated'),
    ('55555555-5555-5555-5555-555555555555', 'pat@test.local',
     jsonb_build_object('full_name', 'Pat Parent-A', 'password_length', 12),       'authenticated', 'authenticated'),
    ('66666666-6666-6666-6666-666666666666', 'olive@test.local',
     jsonb_build_object('full_name', 'Olive Outsider', 'password_length', 12),     'authenticated', 'authenticated'),
    ('77777777-7777-7777-7777-777777777777', 'spare@test.local',
     jsonb_build_object('full_name', 'Spare User', 'password_length', 12),         'authenticated', 'authenticated')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name)
VALUES
    ('44444444-4444-4444-4444-444444444444', 'tara@test.local',  'Tara Tenant-Admin-A'),
    ('55555555-5555-5555-5555-555555555555', 'pat@test.local',   'Pat Parent-A'),
    ('66666666-6666-6666-6666-666666666666', 'olive@test.local', 'Olive Outsider')
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.profiles WHERE id = '77777777-7777-7777-7777-777777777777';

INSERT INTO public.organization_members (organization_id, profile_id, role)
VALUES
    ('a1111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'tenant_admin'),
    ('a1111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'parent')
ON CONFLICT (organization_id, profile_id) DO NOTHING;

-- ── 2. Subject rows (one in Org A, one in Org B) and what they need ───────
-- Ids: e00000TT-0000-0000-0000-00000000000a (Org A) / ...0b (Org B), TT the
-- table's number in the subject list below; a second row is ...2a / ...2b,
-- and the INSERT probes write ...fa. Helpers: 30 locations, 31 fields,
-- 32 a second team per organization.
INSERT INTO public.locations (id, organization_id, name) VALUES
    ('e0000030-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'Matrix Park A'),
    ('e0000030-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'Matrix Park B');

INSERT INTO public.fields (id, organization_id, location_id, name) VALUES
    ('e0000031-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'e0000030-0000-0000-0000-00000000000a', 'Matrix Field A'),
    ('e0000031-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'e0000030-0000-0000-0000-00000000000b', 'Matrix Field B');

INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('e0000032-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'A-Team Two'),
    ('e0000032-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-22222222bcde', 'B-Team Two');

-- 10 players (and a second player per organization)
INSERT INTO public.players (id, organization_id, first_name, last_name) VALUES
    ('e0000010-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'Ada',  'Matrix'),
    ('e0000010-0000-0000-0000-00000000002a', 'a1111111-1111-1111-1111-111111111111', 'Abe',  'Matrix'),
    ('e0000010-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'Bea',  'Matrix'),
    ('e0000010-0000-0000-0000-00000000002b', 'b2222222-2222-2222-2222-222222222222', 'Bert', 'Matrix');

-- 01 email_log
INSERT INTO public.email_log (id, organization_id, recipient_email, action) VALUES
    ('e0000001-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'a-coach@test.local', 'sent'),
    ('e0000001-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'b-coach@test.local', 'sent');

-- 05 evaluation_runs, then 02 findings, 03 metrics, 04 run events on them
INSERT INTO public.evaluation_runs (id, organization_id, status) VALUES
    ('e0000005-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'completed'),
    ('e0000005-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'completed');

INSERT INTO public.evaluation_findings (id, organization_id, evaluation_run_id, severity, finding_code, description) VALUES
    ('e0000002-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'e0000005-0000-0000-0000-00000000000a', 'info', 'MATRIX_A', 'Org A finding'),
    ('e0000002-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'e0000005-0000-0000-0000-00000000000b', 'info', 'MATRIX_B', 'Org B finding');

INSERT INTO public.evaluation_metrics (id, organization_id, evaluation_run_id, metric_key) VALUES
    ('e0000003-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'e0000005-0000-0000-0000-00000000000a', 'matrix.a'),
    ('e0000003-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'e0000005-0000-0000-0000-00000000000b', 'matrix.b');

INSERT INTO public.evaluation_run_events (id, organization_id, evaluation_run_id, event_type, event_payload) VALUES
    ('e0000004-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'e0000005-0000-0000-0000-00000000000a', 'note', '{}'::jsonb),
    ('e0000004-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'e0000005-0000-0000-0000-00000000000b', 'note', '{}'::jsonb);

-- 06 export_jobs
INSERT INTO public.export_jobs (id, organization_id, job_type, status) VALUES
    ('e0000006-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'master', 'queued'),
    ('e0000006-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'master', 'queued');

-- 07 game_slots, 08 games
INSERT INTO public.game_slots (id, organization_id, field_id) VALUES
    ('e0000007-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'e0000031-0000-0000-0000-00000000000a'),
    ('e0000007-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'e0000031-0000-0000-0000-00000000000b');

INSERT INTO public.games (id, organization_id, home_team_id, away_team_id) VALUES
    ('e0000008-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'aaaaaaaa-0000-0000-0000-000000000001', 'e0000032-0000-0000-0000-00000000000a'),
    ('e0000008-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'bbbbbbbb-0000-0000-0000-000000000002', 'e0000032-0000-0000-0000-00000000000b');

-- 09 player_buddies
INSERT INTO public.player_buddies (player_id, buddy_player_id, organization_id, source_import_job) VALUES
    ('e0000010-0000-0000-0000-00000000000a', 'e0000010-0000-0000-0000-00000000002a',
     'a1111111-1111-1111-1111-111111111111', 'aaaabbbb-1111-1111-1111-111111111111'),
    ('e0000010-0000-0000-0000-00000000000b', 'e0000010-0000-0000-0000-00000000002b',
     'b2222222-2222-2222-2222-222222222222', 'aaaabbbb-2222-2222-2222-222222222222');

-- 11 practice_assignments (the ...2a/...2b rows carry the practice exceptions,
-- so the subject rows have nothing restricting their delete)
INSERT INTO public.practice_assignments (id, organization_id, team_id) VALUES
    ('e0000011-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001'),
    ('e0000011-0000-0000-0000-00000000002a', 'a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001'),
    ('e0000011-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002'),
    ('e0000011-0000-0000-0000-00000000002b', 'b2222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002');

-- 12 scheduler_runs
INSERT INTO public.scheduler_runs (id, organization_id, run_type, status) VALUES
    ('e0000012-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'team', 'queued'),
    ('e0000012-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'team', 'queued');

-- 13 staging_players
INSERT INTO public.staging_players (id, organization_id, import_job_id, raw_payload) VALUES
    ('e0000013-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'aaaabbbb-1111-1111-1111-111111111111', '{}'::jsonb),
    ('e0000013-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'aaaabbbb-2222-2222-2222-222222222222', '{}'::jsonb);

-- 14 team_players
INSERT INTO public.team_players (team_id, player_id, organization_id) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'e0000010-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111'),
    ('bbbbbbbb-0000-0000-0000-000000000002', 'e0000010-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222');

-- 15 practice_exceptions
INSERT INTO public.practice_exceptions
    (id, organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason)
VALUES
    ('e0000015-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000001',
     'e0000011-0000-0000-0000-00000000002a', '[2026-09-01,2026-09-08)', 'time_tbd', 'declined'),
    ('e0000015-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'b2222222-2222-2222-2222-222222222bbb', 'bbbbbbbb-0000-0000-0000-000000000002',
     'e0000011-0000-0000-0000-00000000002b', '[2026-09-01,2026-09-08)', 'time_tbd', 'declined');

-- 18 registration_forms: Org A's is open, Org B's a draft, so both arms of
-- registration_forms_member_access (member, or status 'open') show.
INSERT INTO public.registration_forms (id, organization_id, title, status) VALUES
    ('e0000018-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'Org A form', 'open'),
    ('e0000018-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'Org B form', 'draft');

-- 22 organization_schema_history
INSERT INTO public.organization_schema_history (id, organization_id, entity_type) VALUES
    ('e0000022-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111', 'player'),
    ('e0000022-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222', 'player');

-- 23 profile_players: Org A's links the parent; Org B's links the outsider,
-- so the policy's own-row arm (profile_id = auth.uid()) shows on its own.
INSERT INTO public.profile_players (profile_id, player_id, organization_id) VALUES
    ('55555555-5555-5555-5555-555555555555', 'e0000010-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111'),
    ('66666666-6666-6666-6666-666666666666', 'e0000010-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222');

-- 25 registrations: Org A's is the parent's own; Org B's is Bob's.
INSERT INTO public.registrations (id, organization_id, form_id, player_id, profile_id) VALUES
    ('e0000025-0000-0000-0000-00000000000a', 'a1111111-1111-1111-1111-111111111111',
     'e0000018-0000-0000-0000-00000000000a', 'e0000010-0000-0000-0000-00000000000a',
     '55555555-5555-5555-5555-555555555555'),
    ('e0000025-0000-0000-0000-00000000000b', 'b2222222-2222-2222-2222-222222222222',
     'e0000018-0000-0000-0000-00000000000b', 'e0000010-0000-0000-0000-00000000000b',
     '22222222-2222-2222-2222-222222222222');

-- ── 3. The matrix's own tables (temporary, owned by the test role) ────────
CREATE TEMP TABLE matrix_persona (ord int PRIMARY KEY, persona text UNIQUE, db_role text, uid uuid);
INSERT INTO matrix_persona VALUES
    (1, 'admin_a',  'authenticated', '11111111-1111-1111-1111-111111111111'),
    (2, 'tenant_a', 'authenticated', '44444444-4444-4444-4444-444444444444'),
    (3, 'coach_a',  'authenticated', '33333333-3333-3333-3333-333333333333'),
    (4, 'parent_a', 'authenticated', '55555555-5555-5555-5555-555555555555'),
    (5, 'admin_b',  'authenticated', '22222222-2222-2222-2222-222222222222'),
    (6, 'outsider', 'authenticated', '66666666-6666-6666-6666-666666666666'),
    (7, 'anon',     'anon',          NULL);

-- tbl: the table; a_row / b_row: the predicate naming its Org A / Org B
-- subject row; upd_col: the column the UPDATE probe sets to itself;
-- insert_sql: the INSERT probe, a new Org A row.
CREATE TEMP TABLE matrix_subject (
    tbl text PRIMARY KEY, a_row text NOT NULL, b_row text NOT NULL,
    upd_col text NOT NULL, insert_sql text NOT NULL
);
INSERT INTO matrix_subject VALUES
    ('email_log',
     $$id = 'e0000001-0000-0000-0000-00000000000a'$$, $$id = 'e0000001-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.email_log (id, organization_id, recipient_email, action)
       VALUES ('e0000001-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111', 'probe@test.local', 'sent')$$),
    ('evaluation_findings',
     $$id = 'e0000002-0000-0000-0000-00000000000a'$$, $$id = 'e0000002-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.evaluation_findings (id, organization_id, evaluation_run_id, severity, finding_code, description)
       VALUES ('e0000002-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'e0000005-0000-0000-0000-00000000000a', 'info', 'MATRIX_PROBE', 'probe')$$),
    ('evaluation_metrics',
     $$id = 'e0000003-0000-0000-0000-00000000000a'$$, $$id = 'e0000003-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.evaluation_metrics (id, organization_id, evaluation_run_id, metric_key)
       VALUES ('e0000003-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'e0000005-0000-0000-0000-00000000000a', 'matrix.probe')$$),
    ('evaluation_run_events',
     $$id = 'e0000004-0000-0000-0000-00000000000a'$$, $$id = 'e0000004-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.evaluation_run_events (id, organization_id, evaluation_run_id, event_type, event_payload)
       VALUES ('e0000004-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'e0000005-0000-0000-0000-00000000000a', 'note', '{}'::jsonb)$$),
    ('evaluation_runs',
     $$id = 'e0000005-0000-0000-0000-00000000000a'$$, $$id = 'e0000005-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.evaluation_runs (id, organization_id, status)
       VALUES ('e0000005-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111', 'queued')$$),
    ('export_jobs',
     $$id = 'e0000006-0000-0000-0000-00000000000a'$$, $$id = 'e0000006-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.export_jobs (id, organization_id, job_type, status)
       VALUES ('e0000006-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111', 'team', 'queued')$$),
    ('game_slots',
     $$id = 'e0000007-0000-0000-0000-00000000000a'$$, $$id = 'e0000007-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.game_slots (id, organization_id, field_id)
       VALUES ('e0000007-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'e0000031-0000-0000-0000-00000000000a')$$),
    ('games',
     $$id = 'e0000008-0000-0000-0000-00000000000a'$$, $$id = 'e0000008-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.games (id, organization_id, home_team_id, away_team_id)
       VALUES ('e0000008-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'e0000032-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001')$$),
    ('player_buddies',
     $$player_id = 'e0000010-0000-0000-0000-00000000000a' AND buddy_player_id = 'e0000010-0000-0000-0000-00000000002a'$$,
     $$player_id = 'e0000010-0000-0000-0000-00000000000b' AND buddy_player_id = 'e0000010-0000-0000-0000-00000000002b'$$,
     'organization_id',
     $$INSERT INTO public.player_buddies (player_id, buddy_player_id, organization_id, source_import_job)
       VALUES ('e0000010-0000-0000-0000-00000000002a', 'e0000010-0000-0000-0000-00000000000a',
               'a1111111-1111-1111-1111-111111111111', 'aaaabbbb-1111-1111-1111-111111111111')$$),
    ('players',
     $$id = 'e0000010-0000-0000-0000-00000000000a'$$, $$id = 'e0000010-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.players (id, organization_id, first_name, last_name)
       VALUES ('e0000010-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111', 'Probe', 'Matrix')$$),
    ('practice_assignments',
     $$id = 'e0000011-0000-0000-0000-00000000000a'$$, $$id = 'e0000011-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.practice_assignments (id, organization_id, team_id)
       VALUES ('e0000011-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'e0000032-0000-0000-0000-00000000000a')$$),
    ('scheduler_runs',
     $$id = 'e0000012-0000-0000-0000-00000000000a'$$, $$id = 'e0000012-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.scheduler_runs (id, organization_id, run_type, status)
       VALUES ('e0000012-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111', 'game', 'queued')$$),
    ('staging_players',
     $$id = 'e0000013-0000-0000-0000-00000000000a'$$, $$id = 'e0000013-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.staging_players (id, organization_id, import_job_id, raw_payload)
       VALUES ('e0000013-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'aaaabbbb-1111-1111-1111-111111111111', '{}'::jsonb)$$),
    ('team_players',
     $$team_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND player_id = 'e0000010-0000-0000-0000-00000000000a'$$,
     $$team_id = 'bbbbbbbb-0000-0000-0000-000000000002' AND player_id = 'e0000010-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.team_players (team_id, player_id, organization_id)
       VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'e0000010-0000-0000-0000-00000000002a',
               'a1111111-1111-1111-1111-111111111111')$$),
    ('practice_exceptions',
     $$id = 'e0000015-0000-0000-0000-00000000000a'$$, $$id = 'e0000015-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.practice_exceptions
         (id, organization_id, season_settings_id, team_id, assignment_id, "window", kind, tbd_reason)
       VALUES ('e0000015-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'a1111111-1111-1111-1111-111111111aaa', 'aaaaaaaa-0000-0000-0000-000000000001',
               'e0000011-0000-0000-0000-00000000002a', '[2026-10-01,2026-10-08)', 'time_tbd', 'declined')$$),
    ('organization_members',
     $$organization_id = 'a1111111-1111-1111-1111-111111111111' AND profile_id = '33333333-3333-3333-3333-333333333333'$$,
     $$organization_id = 'b2222222-2222-2222-2222-222222222222' AND profile_id = '22222222-2222-2222-2222-222222222222'$$,
     'organization_id',
     $$INSERT INTO public.organization_members (organization_id, profile_id, role)
       VALUES ('a1111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666', 'coach')$$),
    ('organizations',
     $$id = 'a1111111-1111-1111-1111-111111111111'$$, $$id = 'b2222222-2222-2222-2222-222222222222'$$,
     'name',
     $$INSERT INTO public.organizations (id, name, slug)
       VALUES ('e0000017-0000-0000-0000-0000000000fa', 'Matrix Probe Org', 'matrix-probe-org')$$),
    ('registration_forms',
     $$id = 'e0000018-0000-0000-0000-00000000000a'$$, $$id = 'e0000018-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.registration_forms (id, organization_id, title)
       VALUES ('e0000018-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111', 'Probe form')$$),
    ('season_settings',
     $$id = 'a1111111-1111-1111-1111-111111111aaa'$$, $$id = 'b2222222-2222-2222-2222-222222222bbb'$$,
     'organization_id',
     $$INSERT INTO public.season_settings (id, organization_id, name)
       VALUES ('e0000019-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111', 'Probe season')$$),
    ('import_jobs',
     $$id = 'aaaabbbb-1111-1111-1111-111111111111'$$, $$id = 'aaaabbbb-2222-2222-2222-222222222222'$$,
     'organization_id',
     $$INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status)
       VALUES ('e0000020-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'registration', 'orga/probe.csv', 'queued')$$),
    ('audit_log',
     $$id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001'$$, $$id = 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002'$$,
     'organization_id',
     $$INSERT INTO public.audit_log (id, user_id, organization_id, action, resource_type, resource_id)
       VALUES ('e0000021-0000-0000-0000-0000000000fa', '11111111-1111-1111-1111-111111111111',
               'a1111111-1111-1111-1111-111111111111', 'team.saved', 'team', 'aaaaaaaa-0000-0000-0000-000000000001')$$),
    ('organization_schema_history',
     $$id = 'e0000022-0000-0000-0000-00000000000a'$$, $$id = 'e0000022-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.organization_schema_history (id, organization_id, entity_type)
       VALUES ('e0000022-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111', 'team')$$),
    ('profile_players',
     $$profile_id = '55555555-5555-5555-5555-555555555555' AND player_id = 'e0000010-0000-0000-0000-00000000000a'$$,
     $$profile_id = '66666666-6666-6666-6666-666666666666' AND player_id = 'e0000010-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.profile_players (profile_id, player_id, organization_id)
       VALUES ('55555555-5555-5555-5555-555555555555', 'e0000010-0000-0000-0000-00000000002a',
               'a1111111-1111-1111-1111-111111111111')$$),
    ('profiles',
     $$id = '33333333-3333-3333-3333-333333333333'$$, $$id = '22222222-2222-2222-2222-222222222222'$$,
     'full_name',
     $$INSERT INTO public.profiles (id, email, full_name)
       VALUES ('77777777-7777-7777-7777-777777777777', 'spare@test.local', 'Spare User')$$),
    ('registrations',
     $$id = 'e0000025-0000-0000-0000-00000000000a'$$, $$id = 'e0000025-0000-0000-0000-00000000000b'$$,
     'organization_id',
     $$INSERT INTO public.registrations (id, organization_id, form_id, player_id, profile_id)
       VALUES ('e0000025-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'e0000018-0000-0000-0000-00000000000a', 'e0000010-0000-0000-0000-00000000002a',
               '55555555-5555-5555-5555-555555555555')$$),
    ('telemetry_log',
     $$id = 'cafefade-1111-1111-1111-111111111111'$$, $$id = 'cafefade-2222-2222-2222-222222222221'$$,
     'org_id',
     $$INSERT INTO public.telemetry_log (id, org_id, session_id, event_type)
       VALUES ('e0000026-0000-0000-0000-0000000000fa', 'a1111111-1111-1111-1111-111111111111',
               'session-probe', 'import.suggestion_received')$$);

CREATE TEMP TABLE matrix_seen (tbl text PRIMARY KEY, a_n bigint, b_n bigint);
CREATE TEMP TABLE matrix_identity (persona text PRIMARY KEY, db_role text, uid uuid);
CREATE TEMP TABLE matrix_result (
    tbl text, persona text, sel text, ins text, upd text, del text,
    PRIMARY KEY (tbl, persona)
);

-- ── 4. The probes ─────────────────────────────────────────────────────────
-- The role and the JWT claims are set OUTSIDE each probe's subtransaction, so
-- the probe's rollback cannot undo them; results are written only after
-- RESET ROLE, as the test's own role.
DO $matrix$
DECLARE
    p record;
    s record;
    na bigint;
    nb bigint;
    n bigint;
    v_sel text;
    v_ins text;
    v_upd text;
    v_del text;
    v_uid uuid;
    v_role text;
BEGIN
    -- Every subject row exists, counted as the owner (RLS does not apply).
    FOR s IN SELECT * FROM matrix_subject ORDER BY tbl LOOP
        EXECUTE format('SELECT (SELECT count(*) FROM public.%I WHERE %s), (SELECT count(*) FROM public.%I WHERE %s)',
                       s.tbl, s.a_row, s.tbl, s.b_row) INTO na, nb;
        INSERT INTO matrix_seen VALUES (s.tbl, na, nb);
    END LOOP;

    FOR p IN SELECT * FROM matrix_persona ORDER BY ord LOOP
        FOR s IN SELECT * FROM matrix_subject ORDER BY tbl LOOP
            -- Cleared each time, so a probe that recorded nothing leaves a
            -- NULL (which the cell-count assertion counts) rather than the
            -- previous table's answer.
            v_sel := NULL; v_ins := NULL; v_upd := NULL; v_del := NULL;
            PERFORM set_config('request.jwt.claims',
                CASE WHEN p.uid IS NULL THEN '{"role":"anon"}'
                     ELSE json_build_object('sub', p.uid, 'role', p.db_role)::text END,
                true);
            EXECUTE format('SET LOCAL ROLE %I', p.db_role);
            v_uid := auth.uid();
            v_role := current_user;

            -- sel: which subject rows the persona reads.
            BEGIN
                EXECUTE format('SELECT (SELECT count(*) FROM public.%I WHERE %s), (SELECT count(*) FROM public.%I WHERE %s)',
                               s.tbl, s.a_row, s.tbl, s.b_row) INTO na, nb;
                v_sel := CASE WHEN na > 0 AND nb > 0 THEN 'AB'
                              WHEN na > 0 THEN 'A'
                              WHEN nb > 0 THEN 'B'
                              ELSE '-' END;
            EXCEPTION WHEN insufficient_privilege THEN
                v_sel := 'grant';
            END;

            -- ins: a new Org A row.
            BEGIN
                EXECUTE s.insert_sql;
                RAISE SQLSTATE 'MXUND' USING MESSAGE = 'ok';
            EXCEPTION
                WHEN SQLSTATE 'MXUND' THEN v_ins := SQLERRM;
                WHEN insufficient_privilege THEN
                    v_ins := CASE WHEN SQLERRM LIKE 'new row violates row-level security policy%' THEN 'rls' ELSE 'grant' END;
            END;

            -- upd: Org A's subject row, one column set to itself.
            BEGIN
                EXECUTE format('UPDATE public.%I SET %I = %I WHERE %s', s.tbl, s.upd_col, s.upd_col, s.a_row);
                GET DIAGNOSTICS n = ROW_COUNT;
                RAISE SQLSTATE 'MXUND' USING MESSAGE = n::text;
            EXCEPTION
                WHEN SQLSTATE 'MXUND' THEN v_upd := SQLERRM;
                WHEN insufficient_privilege THEN
                    v_upd := CASE WHEN SQLERRM LIKE 'new row violates row-level security policy%' THEN 'rls' ELSE 'grant' END;
            END;

            -- del: Org A's subject row.
            BEGIN
                EXECUTE format('DELETE FROM public.%I WHERE %s', s.tbl, s.a_row);
                GET DIAGNOSTICS n = ROW_COUNT;
                RAISE SQLSTATE 'MXUND' USING MESSAGE = n::text;
            EXCEPTION
                WHEN SQLSTATE 'MXUND' THEN v_del := SQLERRM;
                WHEN insufficient_privilege THEN
                    v_del := CASE WHEN SQLERRM LIKE 'new row violates row-level security policy%' THEN 'rls' ELSE 'grant' END;
            END;

            RESET ROLE;
            INSERT INTO matrix_result VALUES (s.tbl, p.persona, v_sel, v_ins, v_upd, v_del);
            INSERT INTO matrix_identity VALUES (p.persona, v_role, v_uid) ON CONFLICT (persona) DO NOTHING;
        END LOOP;
    END LOOP;
    PERFORM set_config('request.jwt.claims', '', true);
END
$matrix$;

-- ── 5. The expected table ─────────────────────────────────────────────────
-- One row per table and persona: sel, ins, upd, del (see the header). The
-- note above each table names the policies its rows follow on a31ddde. The
-- common shape, "member SELECT, admin ALL", is a <t>_select_member policy
-- (is_org_member) beside an admins' FOR ALL policy (is_org_admin, which admits
-- admin and tenant_admin): every member of Org A reads A's row, A's admin and
-- tenant_admin write it, Bob reads B's only, and the outsider and anon read
-- nothing. None of the 26 tables has a policy for `anon`, so anon's writes are
-- refused by RLS (or by the grant, where the table grants anon nothing).
CREATE TEMP TABLE matrix_expected (
    tbl text, persona text, sel text, ins text, upd text, del text,
    PRIMARY KEY (tbl, persona)
);
INSERT INTO matrix_expected VALUES
    -- audit_log: "Audit Log: admins view": a member whose role is 'admin' (not tenant_admin); no write policy.
    ('audit_log',                   'admin_a',  'A',  'rls',   '0',     '0'),
    ('audit_log',                   'tenant_a', '-',  'rls',   '0',     '0'),
    ('audit_log',                   'coach_a',  '-',  'rls',   '0',     '0'),
    ('audit_log',                   'parent_a', '-',  'rls',   '0',     '0'),
    ('audit_log',                   'admin_b',  'B',  'rls',   '0',     '0'),
    ('audit_log',                   'outsider', '-',  'rls',   '0',     '0'),
    ('audit_log',                   'anon',     '-',  'rls',   '0',     '0'),

    -- email_log: member SELECT, admin ALL (is_org_admin: admin or tenant_admin).
    ('email_log',                   'admin_a',  'A',  'ok',    '1',     '1'),
    ('email_log',                   'tenant_a', 'A',  'ok',    '1',     '1'),
    ('email_log',                   'coach_a',  'A',  'rls',   '0',     '0'),
    ('email_log',                   'parent_a', 'A',  'rls',   '0',     '0'),
    ('email_log',                   'admin_b',  'B',  'rls',   '0',     '0'),
    ('email_log',                   'outsider', '-',  'rls',   '0',     '0'),
    ('email_log',                   'anon',     '-',  'rls',   '0',     '0'),

    -- evaluation_findings: member SELECT, admin ALL.
    ('evaluation_findings',         'admin_a',  'A',  'ok',    '1',     '1'),
    ('evaluation_findings',         'tenant_a', 'A',  'ok',    '1',     '1'),
    ('evaluation_findings',         'coach_a',  'A',  'rls',   '0',     '0'),
    ('evaluation_findings',         'parent_a', 'A',  'rls',   '0',     '0'),
    ('evaluation_findings',         'admin_b',  'B',  'rls',   '0',     '0'),
    ('evaluation_findings',         'outsider', '-',  'rls',   '0',     '0'),
    ('evaluation_findings',         'anon',     '-',  'rls',   '0',     '0'),

    -- evaluation_metrics: member SELECT, admin ALL.
    ('evaluation_metrics',          'admin_a',  'A',  'ok',    '1',     '1'),
    ('evaluation_metrics',          'tenant_a', 'A',  'ok',    '1',     '1'),
    ('evaluation_metrics',          'coach_a',  'A',  'rls',   '0',     '0'),
    ('evaluation_metrics',          'parent_a', 'A',  'rls',   '0',     '0'),
    ('evaluation_metrics',          'admin_b',  'B',  'rls',   '0',     '0'),
    ('evaluation_metrics',          'outsider', '-',  'rls',   '0',     '0'),
    ('evaluation_metrics',          'anon',     '-',  'rls',   '0',     '0'),

    -- evaluation_run_events: member SELECT, admin ALL.
    ('evaluation_run_events',       'admin_a',  'A',  'ok',    '1',     '1'),
    ('evaluation_run_events',       'tenant_a', 'A',  'ok',    '1',     '1'),
    ('evaluation_run_events',       'coach_a',  'A',  'rls',   '0',     '0'),
    ('evaluation_run_events',       'parent_a', 'A',  'rls',   '0',     '0'),
    ('evaluation_run_events',       'admin_b',  'B',  'rls',   '0',     '0'),
    ('evaluation_run_events',       'outsider', '-',  'rls',   '0',     '0'),
    ('evaluation_run_events',       'anon',     '-',  'rls',   '0',     '0'),

    -- evaluation_runs: member SELECT, admin ALL.
    ('evaluation_runs',             'admin_a',  'A',  'ok',    '1',     '1'),
    ('evaluation_runs',             'tenant_a', 'A',  'ok',    '1',     '1'),
    ('evaluation_runs',             'coach_a',  'A',  'rls',   '0',     '0'),
    ('evaluation_runs',             'parent_a', 'A',  'rls',   '0',     '0'),
    ('evaluation_runs',             'admin_b',  'B',  'rls',   '0',     '0'),
    ('evaluation_runs',             'outsider', '-',  'rls',   '0',     '0'),
    ('evaluation_runs',             'anon',     '-',  'rls',   '0',     '0'),

    -- export_jobs: member SELECT, admin ALL.
    ('export_jobs',                 'admin_a',  'A',  'ok',    '1',     '1'),
    ('export_jobs',                 'tenant_a', 'A',  'ok',    '1',     '1'),
    ('export_jobs',                 'coach_a',  'A',  'rls',   '0',     '0'),
    ('export_jobs',                 'parent_a', 'A',  'rls',   '0',     '0'),
    ('export_jobs',                 'admin_b',  'B',  'rls',   '0',     '0'),
    ('export_jobs',                 'outsider', '-',  'rls',   '0',     '0'),
    ('export_jobs',                 'anon',     '-',  'rls',   '0',     '0'),

    -- game_slots: member SELECT, admin ALL.
    ('game_slots',                  'admin_a',  'A',  'ok',    '1',     '1'),
    ('game_slots',                  'tenant_a', 'A',  'ok',    '1',     '1'),
    ('game_slots',                  'coach_a',  'A',  'rls',   '0',     '0'),
    ('game_slots',                  'parent_a', 'A',  'rls',   '0',     '0'),
    ('game_slots',                  'admin_b',  'B',  'rls',   '0',     '0'),
    ('game_slots',                  'outsider', '-',  'rls',   '0',     '0'),
    ('game_slots',                  'anon',     '-',  'rls',   '0',     '0'),

    -- games: member SELECT, admin ALL.
    ('games',                       'admin_a',  'A',  'ok',    '1',     '1'),
    ('games',                       'tenant_a', 'A',  'ok',    '1',     '1'),
    ('games',                       'coach_a',  'A',  'rls',   '0',     '0'),
    ('games',                       'parent_a', 'A',  'rls',   '0',     '0'),
    ('games',                       'admin_b',  'B',  'rls',   '0',     '0'),
    ('games',                       'outsider', '-',  'rls',   '0',     '0'),
    ('games',                       'anon',     '-',  'rls',   '0',     '0'),

    -- import_jobs: two member SELECT policies (one the legacy subquery form); no write policy.
    ('import_jobs',                 'admin_a',  'A',  'rls',   '0',     '0'),
    ('import_jobs',                 'tenant_a', 'A',  'rls',   '0',     '0'),
    ('import_jobs',                 'coach_a',  'A',  'rls',   '0',     '0'),
    ('import_jobs',                 'parent_a', 'A',  'rls',   '0',     '0'),
    ('import_jobs',                 'admin_b',  'B',  'rls',   '0',     '0'),
    ('import_jobs',                 'outsider', '-',  'rls',   '0',     '0'),
    ('import_jobs',                 'anon',     '-',  'rls',   '0',     '0'),

    -- organization_members: "Org Members: view members" (member), "admins manage" (ALL, is_org_admin).
    ('organization_members',        'admin_a',  'A',  'ok',    '1',     '1'),
    ('organization_members',        'tenant_a', 'A',  'ok',    '1',     '1'),
    ('organization_members',        'coach_a',  'A',  'rls',   '0',     '0'),
    ('organization_members',        'parent_a', 'A',  'rls',   '0',     '0'),
    ('organization_members',        'admin_b',  'B',  'rls',   '0',     '0'),
    ('organization_members',        'outsider', '-',  'rls',   '0',     '0'),
    ('organization_members',        'anon',     '-',  'rls',   '0',     '0'),

    -- organization_schema_history: "Schema History: Admins Only": role = 'admin' (not tenant_admin); no write policy.
    ('organization_schema_history', 'admin_a',  'A',  'rls',   '0',     '0'),
    ('organization_schema_history', 'tenant_a', '-',  'rls',   '0',     '0'),
    ('organization_schema_history', 'coach_a',  '-',  'rls',   '0',     '0'),
    ('organization_schema_history', 'parent_a', '-',  'rls',   '0',     '0'),
    ('organization_schema_history', 'admin_b',  'B',  'rls',   '0',     '0'),
    ('organization_schema_history', 'outsider', '-',  'rls',   '0',     '0'),
    ('organization_schema_history', 'anon',     '-',  'rls',   '0',     '0'),

    -- organizations: member SELECT and admin ALL on the organization's own id; a new organization has no admin, so no INSERT passes.
    ('organizations',               'admin_a',  'A',  'rls',   '1',     '1'),
    ('organizations',               'tenant_a', 'A',  'rls',   '1',     '1'),
    ('organizations',               'coach_a',  'A',  'rls',   '0',     '0'),
    ('organizations',               'parent_a', 'A',  'rls',   '0',     '0'),
    ('organizations',               'admin_b',  'B',  'rls',   '0',     '0'),
    ('organizations',               'outsider', '-',  'rls',   '0',     '0'),
    ('organizations',               'anon',     '-',  'rls',   '0',     '0'),

    -- player_buddies: member SELECT, admin ALL.
    ('player_buddies',              'admin_a',  'A',  'ok',    '1',     '1'),
    ('player_buddies',              'tenant_a', 'A',  'ok',    '1',     '1'),
    ('player_buddies',              'coach_a',  'A',  'rls',   '0',     '0'),
    ('player_buddies',              'parent_a', 'A',  'rls',   '0',     '0'),
    ('player_buddies',              'admin_b',  'B',  'rls',   '0',     '0'),
    ('player_buddies',              'outsider', '-',  'rls',   '0',     '0'),
    ('player_buddies',              'anon',     '-',  'rls',   '0',     '0'),

    -- players: member SELECT, admin ALL.
    ('players',                     'admin_a',  'A',  'ok',    '1',     '1'),
    ('players',                     'tenant_a', 'A',  'ok',    '1',     '1'),
    ('players',                     'coach_a',  'A',  'rls',   '0',     '0'),
    ('players',                     'parent_a', 'A',  'rls',   '0',     '0'),
    ('players',                     'admin_b',  'B',  'rls',   '0',     '0'),
    ('players',                     'outsider', '-',  'rls',   '0',     '0'),
    ('players',                     'anon',     '-',  'rls',   '0',     '0'),

    -- practice_assignments: member SELECT, admin ALL.
    ('practice_assignments',        'admin_a',  'A',  'ok',    '1',     '1'),
    ('practice_assignments',        'tenant_a', 'A',  'ok',    '1',     '1'),
    ('practice_assignments',        'coach_a',  'A',  'rls',   '0',     '0'),
    ('practice_assignments',        'parent_a', 'A',  'rls',   '0',     '0'),
    ('practice_assignments',        'admin_b',  'B',  'rls',   '0',     '0'),
    ('practice_assignments',        'outsider', '-',  'rls',   '0',     '0'),
    ('practice_assignments',        'anon',     '-',  'rls',   '0',     '0'),

    -- practice_exceptions: member SELECT, admin ALL; anon holds no privilege on the table at all.
    ('practice_exceptions',         'admin_a',  'A',  'ok',    '1',     '1'),
    ('practice_exceptions',         'tenant_a', 'A',  'ok',    '1',     '1'),
    ('practice_exceptions',         'coach_a',  'A',  'rls',   '0',     '0'),
    ('practice_exceptions',         'parent_a', 'A',  'rls',   '0',     '0'),
    ('practice_exceptions',         'admin_b',  'B',  'rls',   '0',     '0'),
    ('practice_exceptions',         'outsider', '-',  'rls',   '0',     '0'),
    ('practice_exceptions',         'anon',     'grant','grant', 'grant', 'grant'),

    -- profile_players: own row (profile_id = auth.uid()) or member; Org B's row is the outsider's own; no write policy.
    ('profile_players',             'admin_a',  'A',  'rls',   '0',     '0'),
    ('profile_players',             'tenant_a', 'A',  'rls',   '0',     '0'),
    ('profile_players',             'coach_a',  'A',  'rls',   '0',     '0'),
    ('profile_players',             'parent_a', 'A',  'rls',   '0',     '0'),
    ('profile_players',             'admin_b',  'B',  'rls',   '0',     '0'),
    ('profile_players',             'outsider', 'B',  'rls',   '0',     '0'),
    ('profile_players',             'anon',     '-',  'rls',   '0',     '0'),

    -- profiles: own row only, read and update; Org A's subject row is Charlie's profile, Org B's is Bob's; no INSERT or DELETE policy.
    ('profiles',                    'admin_a',  '-',  'rls',   '0',     '0'),
    ('profiles',                    'tenant_a', '-',  'rls',   '0',     '0'),
    ('profiles',                    'coach_a',  'A',  'rls',   '1',     '0'),
    ('profiles',                    'parent_a', '-',  'rls',   '0',     '0'),
    ('profiles',                    'admin_b',  'B',  'rls',   '0',     '0'),
    ('profiles',                    'outsider', '-',  'rls',   '0',     '0'),
    ('profiles',                    'anon',     '-',  'rls',   '0',     '0'),

    -- registration_forms: member or status 'open' (Org A's form is open: deliberate, plan Q6); writes need role = 'admin' (not tenant_admin, plan Q5).
    ('registration_forms',          'admin_a',  'A',  'ok',    '1',     '1'),
    ('registration_forms',          'tenant_a', 'A',  'rls',   '0',     '0'),
    ('registration_forms',          'coach_a',  'A',  'rls',   '0',     '0'),
    ('registration_forms',          'parent_a', 'A',  'rls',   '0',     '0'),
    ('registration_forms',          'admin_b',  'AB', 'rls',   '0',     '0'),
    ('registration_forms',          'outsider', 'A',  'rls',   '0',     '0'),
    ('registration_forms',          'anon',     '-',  'rls',   '0',     '0'),

    -- registrations: (own AND member) or is_org_admin, for every command; Org A's row is the parent's own, and so is the INSERT probe's.
    ('registrations',               'admin_a',  'A',  'ok',    '1',     '1'),
    ('registrations',               'tenant_a', 'A',  'ok',    '1',     '1'),
    ('registrations',               'coach_a',  '-',  'rls',   '0',     '0'),
    ('registrations',               'parent_a', 'A',  'ok',    '1',     '1'),
    ('registrations',               'admin_b',  'B',  'rls',   '0',     '0'),
    ('registrations',               'outsider', '-',  'rls',   '0',     '0'),
    ('registrations',               'anon',     '-',  'rls',   '0',     '0'),

    -- scheduler_runs: member SELECT, admin ALL.
    ('scheduler_runs',              'admin_a',  'A',  'ok',    '1',     '1'),
    ('scheduler_runs',              'tenant_a', 'A',  'ok',    '1',     '1'),
    ('scheduler_runs',              'coach_a',  'A',  'rls',   '0',     '0'),
    ('scheduler_runs',              'parent_a', 'A',  'rls',   '0',     '0'),
    ('scheduler_runs',              'admin_b',  'B',  'rls',   '0',     '0'),
    ('scheduler_runs',              'outsider', '-',  'rls',   '0',     '0'),
    ('scheduler_runs',              'anon',     '-',  'rls',   '0',     '0'),

    -- season_settings: member SELECT; writes need role = 'admin' (not tenant_admin, plan Q5).
    ('season_settings',             'admin_a',  'A',  'ok',    '1',     '1'),
    ('season_settings',             'tenant_a', 'A',  'rls',   '0',     '0'),
    ('season_settings',             'coach_a',  'A',  'rls',   '0',     '0'),
    ('season_settings',             'parent_a', 'A',  'rls',   '0',     '0'),
    ('season_settings',             'admin_b',  'B',  'rls',   '0',     '0'),
    ('season_settings',             'outsider', '-',  'rls',   '0',     '0'),
    ('season_settings',             'anon',     '-',  'rls',   '0',     '0'),

    -- staging_players: member SELECT, admin ALL.
    ('staging_players',             'admin_a',  'A',  'ok',    '1',     '1'),
    ('staging_players',             'tenant_a', 'A',  'ok',    '1',     '1'),
    ('staging_players',             'coach_a',  'A',  'rls',   '0',     '0'),
    ('staging_players',             'parent_a', 'A',  'rls',   '0',     '0'),
    ('staging_players',             'admin_b',  'B',  'rls',   '0',     '0'),
    ('staging_players',             'outsider', '-',  'rls',   '0',     '0'),
    ('staging_players',             'anon',     '-',  'rls',   '0',     '0'),

    -- team_players: member SELECT, admin ALL.
    ('team_players',                'admin_a',  'A',  'ok',    '1',     '1'),
    ('team_players',                'tenant_a', 'A',  'ok',    '1',     '1'),
    ('team_players',                'coach_a',  'A',  'rls',   '0',     '0'),
    ('team_players',                'parent_a', 'A',  'rls',   '0',     '0'),
    ('team_players',                'admin_b',  'B',  'rls',   '0',     '0'),
    ('team_players',                'outsider', '-',  'rls',   '0',     '0'),
    ('team_players',                'anon',     '-',  'rls',   '0',     '0'),

    -- telemetry_log: INSERT by any member of the row's organization; SELECT by its admin or tenant_admin; no UPDATE or DELETE policy.
    ('telemetry_log',               'admin_a',  'A',  'ok',    '0',     '0'),
    ('telemetry_log',               'tenant_a', 'A',  'ok',    '0',     '0'),
    ('telemetry_log',               'coach_a',  '-',  'ok',    '0',     '0'),
    ('telemetry_log',               'parent_a', '-',  'ok',    '0',     '0'),
    ('telemetry_log',               'admin_b',  'B',  'rls',   '0',     '0'),
    ('telemetry_log',               'outsider', '-',  'rls',   '0',     '0'),
    ('telemetry_log',               'anon',     '-',  'rls',   '0',     '0');

-- ── 6. Meta-assertions ────────────────────────────────────────────────────
SELECT is(
    (SELECT count(*) FROM matrix_subject s
       JOIN pg_class c ON c.oid = to_regclass('public.' || quote_ident(s.tbl))
      WHERE c.relkind = 'r' AND c.relrowsecurity),
    26::bigint,
    'the subject list is the 26 advisor-flagged tables, each an RLS-enabled table'
);

SELECT is(
    (SELECT count(*) FROM matrix_seen WHERE a_n = 1 AND b_n = 1),
    26::bigint,
    'every subject table holds exactly one Org A and one Org B subject row'
);

SELECT results_eq(
    $$SELECT persona, db_role, uid FROM matrix_identity ORDER BY persona$$,
    $$SELECT persona, db_role, uid FROM matrix_persona ORDER BY persona$$,
    'every persona ran as the role and user it claims'
);

SELECT is(
    (SELECT count(*) FROM matrix_expected e
       JOIN matrix_subject USING (tbl) JOIN matrix_persona USING (persona)),
    182::bigint,
    'the expected table covers every table and persona (26 x 7)'
);

SELECT is(
    (SELECT count(sel) + count(ins) + count(upd) + count(del) FROM matrix_result),
    728::bigint,
    'the probes produced every cell (26 tables x 7 personas x 4 probes)'
);

-- Every differing cell, anywhere in the matrix: printed, then counted. This
-- is the whole-matrix comparison; the per-table assertions below say which
-- table, and are written out one by one (not looped) so that
-- tests/pgtapPlanCounts.test.js can count them against plan().
CREATE TEMP VIEW matrix_diff AS
SELECT coalesce(r.tbl, e.tbl) AS tbl, coalesce(r.persona, e.persona) AS persona,
       concat_ws(', ', r.sel, r.ins, r.upd, r.del) AS got,
       concat_ws(', ', e.sel, e.ins, e.upd, e.del) AS want
  FROM matrix_result r
  FULL JOIN matrix_expected e ON e.tbl = r.tbl AND e.persona = r.persona
 WHERE (r.sel, r.ins, r.upd, r.del) IS DISTINCT FROM (e.sel, e.ins, e.upd, e.del);

SELECT diag(d) FROM (
    SELECT string_agg(format('DIFF %s | %s | got (%s) expected (%s)', tbl, persona, got, want),
                      E'\n' ORDER BY tbl, persona) AS d
      FROM matrix_diff
) x WHERE d IS NOT NULL;

SELECT is(
    (SELECT count(*) FROM matrix_diff),
    0::bigint,
    'no cell of the persona matrix differs from the expected table'
);

-- ── 7. The matrix, one assertion per table ────────────────────────────────
CREATE FUNCTION pg_temp.matrix_rows(source text, t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
    SELECT format('SELECT persona, sel, ins, upd, del FROM %I JOIN matrix_persona USING (persona)'
                  ' WHERE tbl = %L ORDER BY ord', source, t)
$f$;

SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'audit_log'), pg_temp.matrix_rows('matrix_expected', 'audit_log'), 'persona matrix: audit_log');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'email_log'), pg_temp.matrix_rows('matrix_expected', 'email_log'), 'persona matrix: email_log');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'evaluation_findings'), pg_temp.matrix_rows('matrix_expected', 'evaluation_findings'), 'persona matrix: evaluation_findings');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'evaluation_metrics'), pg_temp.matrix_rows('matrix_expected', 'evaluation_metrics'), 'persona matrix: evaluation_metrics');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'evaluation_run_events'), pg_temp.matrix_rows('matrix_expected', 'evaluation_run_events'), 'persona matrix: evaluation_run_events');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'evaluation_runs'), pg_temp.matrix_rows('matrix_expected', 'evaluation_runs'), 'persona matrix: evaluation_runs');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'export_jobs'), pg_temp.matrix_rows('matrix_expected', 'export_jobs'), 'persona matrix: export_jobs');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'game_slots'), pg_temp.matrix_rows('matrix_expected', 'game_slots'), 'persona matrix: game_slots');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'games'), pg_temp.matrix_rows('matrix_expected', 'games'), 'persona matrix: games');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'import_jobs'), pg_temp.matrix_rows('matrix_expected', 'import_jobs'), 'persona matrix: import_jobs');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'organization_members'), pg_temp.matrix_rows('matrix_expected', 'organization_members'), 'persona matrix: organization_members');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'organization_schema_history'), pg_temp.matrix_rows('matrix_expected', 'organization_schema_history'), 'persona matrix: organization_schema_history');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'organizations'), pg_temp.matrix_rows('matrix_expected', 'organizations'), 'persona matrix: organizations');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'player_buddies'), pg_temp.matrix_rows('matrix_expected', 'player_buddies'), 'persona matrix: player_buddies');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'players'), pg_temp.matrix_rows('matrix_expected', 'players'), 'persona matrix: players');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'practice_assignments'), pg_temp.matrix_rows('matrix_expected', 'practice_assignments'), 'persona matrix: practice_assignments');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'practice_exceptions'), pg_temp.matrix_rows('matrix_expected', 'practice_exceptions'), 'persona matrix: practice_exceptions');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'profile_players'), pg_temp.matrix_rows('matrix_expected', 'profile_players'), 'persona matrix: profile_players');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'profiles'), pg_temp.matrix_rows('matrix_expected', 'profiles'), 'persona matrix: profiles');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'registration_forms'), pg_temp.matrix_rows('matrix_expected', 'registration_forms'), 'persona matrix: registration_forms');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'registrations'), pg_temp.matrix_rows('matrix_expected', 'registrations'), 'persona matrix: registrations');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'scheduler_runs'), pg_temp.matrix_rows('matrix_expected', 'scheduler_runs'), 'persona matrix: scheduler_runs');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'season_settings'), pg_temp.matrix_rows('matrix_expected', 'season_settings'), 'persona matrix: season_settings');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'staging_players'), pg_temp.matrix_rows('matrix_expected', 'staging_players'), 'persona matrix: staging_players');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'team_players'), pg_temp.matrix_rows('matrix_expected', 'team_players'), 'persona matrix: team_players');
SELECT results_eq(pg_temp.matrix_rows('matrix_result', 'telemetry_log'), pg_temp.matrix_rows('matrix_expected', 'telemetry_log'), 'persona matrix: telemetry_log');

SELECT * FROM finish();
ROLLBACK;
