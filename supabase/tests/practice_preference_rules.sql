-- pgTAP: practice preference rules (Phase D, C1; migration 20261112010000; plan
-- docs/changes/2026-10-26-coach-preference-rules.md "Revised 2026-10-27" and
-- docs/changes/2026-10-27-phase-d-scheduling.md, section C).
--
-- A row of `coach_practice_preferences` is one RULE for one team: weekdays / start_minutes / venue_ids
-- (any of, each optional) or keep-current per condition, a level (prefer | must), a requested level and
-- a must decision (pending | accepted | kept_prefer), an optional priority and date window. Only
-- admins write, through five RPCs, each audited and each refused to a signed-in non-member and to
-- another organization's admin. `docs/sql/20261112010000_smoke.sql` covers the same ground in the local
-- harness; the backfill of the old scalar rows is planted and checked there (the harness builds to the
-- previous migration, plants old-shape rows and applies this one).
--
-- Every date is relative to CURRENT_DATE: the RPCs read the coach's assignment as of today.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(63);

-- ---- the roster (as the table owner, before any role is set) -------------------------------------
-- Org A, season aaa (active): A-Team (the fixture's) and A2; coach C1 coaches both, C2 coaches A-Team only,
-- C3 coaches nothing. Org B has a location and a team of its own.
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000a2', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111abcd', 'Rules A2');
INSERT INTO public.coaches (id, organization_id, season_settings_id, full_name, email, status) VALUES
    ('c0000000-0000-4000-8000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Rules Coach One', 'rules-one@test.local', 'active'),
    ('c0000000-0000-4000-8000-000000000002', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Rules Coach Two', 'rules-two@test.local', 'active'),
    ('c0000000-0000-4000-8000-000000000003', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Rules Coach Three', 'rules-three@test.local', 'active'),
    ('c0000000-0000-4000-8000-0000000000b1', 'b2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222bbb', 'Rules Coach B', 'rules-b@test.local', 'active');
INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, started_via) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'lead', CURRENT_DATE - 30, 'test'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'c0000000-0000-4000-8000-000000000001', 'lead', CURRENT_DATE - 30, 'test'),
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'assistant', CURRENT_DATE - 30, 'test');
INSERT INTO public.locations (id, organization_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111100c1', 'a1111111-1111-1111-1111-111111111111', 'Rules Park One'),
    ('a1111111-1111-1111-1111-1111111100c2', 'a1111111-1111-1111-1111-111111111111', 'Rules Park Two'),
    ('b2222222-2222-2222-2222-2222222200c1', 'b2222222-2222-2222-2222-222222222222', 'Rules Park B');
-- A completed season of Org A with a team and its coach: it takes no change.
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('a1111111-1111-1111-1111-111111111ccc', 'a1111111-1111-1111-1111-111111111111', 'Org A Fall 2025', 'completed', 2025);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-11111111ccc1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111ccc', 'Org A U10 old');
INSERT INTO public.teams (id, organization_id, division_id, name) VALUES
    ('aaaaaaaa-0000-0000-0000-0000000000c1', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-11111111ccc1', 'Rules Old Team');
INSERT INTO public.coaches (id, organization_id, season_settings_id, full_name, email, status) VALUES
    ('c0000000-0000-4000-8000-0000000000c4', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111ccc', 'Rules Old Coach', 'rules-old@test.local', 'active');
INSERT INTO public.team_coach_assignments (organization_id, team_id, coach_id, role, effective_from, started_via) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'c0000000-0000-4000-8000-0000000000c4', 'lead', CURRENT_DATE - 30, 'test');
-- Two import jobs of Org A and one rule row per, for Accept all (written as the owner; the import itself is practice_preference_import.sql).
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, season_settings_id) VALUES
    ('a1111111-1111-1111-1111-1111111a0001', 'a1111111-1111-1111-1111-111111111111', 'registration', 'imports/test/rules-1.csv', 'completed', 'a1111111-1111-1111-1111-111111111aaa'),
    ('a1111111-1111-1111-1111-1111111a0002', 'a1111111-1111-1111-1111-111111111111', 'registration', 'imports/test/rules-2.csv', 'completed', 'a1111111-1111-1111-1111-111111111aaa');
INSERT INTO public.coach_practice_preferences
    (id, organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision, status, source, import_job_id) VALUES
    ('c0000000-0000-4000-8000-0000000000e1', 'a1111111-1111-1111-1111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', ARRAY['TUE'], 'prefer', 'must', 'pending', 'in_force', 'import', 'a1111111-1111-1111-1111-1111111a0001'),
    ('c0000000-0000-4000-8000-0000000000e2', 'a1111111-1111-1111-1111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', ARRAY['THU'], 'prefer', 'must', 'pending', 'in_force', 'import', 'a1111111-1111-1111-1111-1111111a0001'),
    ('c0000000-0000-4000-8000-0000000000e3', 'a1111111-1111-1111-1111-111111111111', 'c0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', ARRAY['WED'], 'prefer', 'must', 'pending', 'in_force', 'import', 'a1111111-1111-1111-1111-1111111a0002');

-- ---- the CHECKs, as the table owner (a direct write: the RPCs would refuse some of these earlier) ------
CREATE TEMP TABLE t_rule AS
SELECT 'a1111111-1111-1111-1111-111111111111'::uuid AS organization_id,
       'c0000000-0000-4000-8000-000000000001'::uuid AS coach_id,
       'aaaaaaaa-0000-0000-0000-000000000001'::uuid AS team_id;

SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY[]::text[], 'prefer', 'prefer' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_weekdays_valid"%', 'an empty weekday set is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY['TUE', 'TUE'], 'prefer', 'prefer' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_weekdays_valid"%', 'a duplicate weekday is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY['TUESDAY'], 'prefer', 'prefer' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_weekdays_valid"%', 'a weekday outside SUN..SAT is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, start_minutes, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY[1020, 1440], 'prefer', 'prefer' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_start_minutes_valid"%', 'a start minute past 1439 is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, start_minutes, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY[1020, 1020], 'prefer', 'prefer' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_start_minutes_valid"%', 'a duplicate start minute is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, venue_ids, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY['b2222222-2222-2222-2222-2222222200c1'::uuid], 'prefer', 'prefer' FROM t_rule$$,
    'practice preference: 1 venue(s) are not locations of organization %', 'another organization''s venue is refused (the tenancy trigger)');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, venue_ids, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY['a1111111-1111-1111-1111-1111111100c1'::uuid, 'a1111111-1111-1111-1111-1111111100c1'::uuid], 'prefer', 'prefer' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_venue_ids_valid"%', 'a duplicate venue is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, level, requested_level)
      SELECT organization_id, coach_id, team_id, 'prefer', 'prefer' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_has_condition"%', 'a rule with no condition is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, keep_weekday, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY['TUE'], true, 'prefer', 'prefer' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_keep_or_values"%', 'values and keep-current on one condition are refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level, must_decision)
      SELECT organization_id, coach_id, team_id, ARRAY['TUE'], 'must', 'must', 'pending' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_must_only_when_accepted"%', 'a must nobody accepted is refused: only a decision makes a rule a must');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY['TUE'], 'prefer', 'must' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_must_asked_decided"%', 'a requested must with no decision is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level, effective_from, effective_to)
      SELECT organization_id, coach_id, team_id, ARRAY['TUE'], 'prefer', 'prefer', CURRENT_DATE, CURRENT_DATE - 1 FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_window_ordered"%', 'a window that ends before it starts is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level, coach_priority)
      SELECT organization_id, coach_id, team_id, ARRAY['TUE'], 'prefer', 'prefer', 'urgent' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_priority_known"%', 'a priority outside high, medium, low is refused');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level)
      SELECT organization_id, 'c0000000-0000-4000-8000-0000000000b1'::uuid, team_id, ARRAY['TUE'], 'prefer', 'prefer' FROM t_rule$$,
    'practice preference: coach % is not a coach of organization %', 'another organization''s coach is refused (the tenancy trigger)');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level)
      SELECT organization_id, 'c0000000-0000-4000-8000-0000000000c4'::uuid, team_id, ARRAY['TUE'], 'prefer', 'prefer' FROM t_rule$$,
    'practice preference: coach % and team % belong to different seasons', 'a coach of another season is refused for this season''s team (the tenancy trigger)');
SELECT throws_like(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level, status, import_job_id, source)
      SELECT organization_id, coach_id, team_id, ARRAY['TUE'], 'prefer', 'prefer', 'in_force', 'a1111111-1111-1111-1111-1111111a0001', 'admin' FROM t_rule$$,
    '%violates check constraint "coach_practice_preferences_import_job_is_import"%', 'an import job id on an admin rule is refused');
SELECT lives_ok(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, start_minutes, venue_ids, level, requested_level)
      SELECT organization_id, coach_id, team_id, ARRAY['TUE', 'THU'], ARRAY[1020, 1080], ARRAY['a1111111-1111-1111-1111-1111111100c1'::uuid], 'prefer', 'prefer' FROM t_rule$$,
    'control: a rule with several values in each of the three conditions is accepted');
DELETE FROM public.coach_practice_preferences WHERE weekdays = ARRAY['TUE', 'THU'] AND start_minutes = ARRAY[1020, 1080];

-- ---- the admin RPCs -------------------------------------------------------------------------------
SET LOCAL role = 'authenticated';

-- Charlie: signed in, a member of no organization.
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is((SELECT count(*)::int FROM public.coach_practice_preferences), 0, 'a signed-in non-member reads no rule');
SELECT throws_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'prefer', ARRAY['TUE'])$$,
    '42501', NULL, 'a signed-in non-member cannot add a rule');
SELECT throws_ok(
    $$SELECT public.admin_edit_practice_preference('c0000000-0000-4000-8000-0000000000e1', 'prefer', ARRAY['TUE'])$$,
    '42501', NULL, 'a signed-in non-member cannot edit a rule');
SELECT throws_ok(
    $$SELECT public.admin_remove_practice_preference('c0000000-0000-4000-8000-0000000000e1')$$,
    '42501', NULL, 'a signed-in non-member cannot remove a rule');
SELECT throws_ok(
    $$SELECT public.admin_decide_must_preference('c0000000-0000-4000-8000-0000000000e1', 'accept')$$,
    '42501', NULL, 'a signed-in non-member cannot accept a must');
SELECT throws_ok(
    $$SELECT public.admin_accept_all_musts('a1111111-1111-1111-1111-1111111a0001', 2)$$,
    '42501', NULL, 'a signed-in non-member cannot accept all');
SELECT throws_ok(
    $$INSERT INTO public.coach_practice_preferences (organization_id, coach_id, team_id, weekdays, level, requested_level)
      VALUES ('a1111111-1111-1111-1111-111111111111', 'c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', ARRAY['TUE'], 'prefer', 'prefer')$$,
    '42501', NULL, 'no client writes the table directly');

-- Bob: an admin of Org B.
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is((SELECT count(*)::int FROM public.coach_practice_preferences), 0, 'another organization''s admin reads no rule');
SELECT throws_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'prefer', ARRAY['TUE'])$$,
    '42501', NULL, 'another organization''s admin cannot add a rule');
SELECT throws_ok(
    $$SELECT public.admin_decide_must_preference('c0000000-0000-4000-8000-0000000000e1', 'accept')$$,
    '42501', NULL, 'another organization''s admin cannot accept a must');
SELECT throws_ok(
    $$SELECT public.admin_accept_all_musts('a1111111-1111-1111-1111-1111111a0001', 2)$$,
    '42501', NULL, 'another organization''s admin cannot accept all');
SELECT throws_ok(
    $$SELECT public.admin_remove_practice_preference('c0000000-0000-4000-8000-0000000000e1')$$,
    '42501', NULL, 'another organization''s admin cannot remove a rule');

-- Alice: an admin of Org A.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((SELECT count(*)::int FROM public.coach_practice_preferences), 3, 'an admin reads their organization''s rules');

-- Many rules per coach and team; every rule is its own row (nothing supersedes).
SELECT lives_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'prefer', ARRAY['TUE', 'THU'])$$,
    'an admin adds a prefer rule for two weekdays');
SELECT lives_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'prefer', NULL, ARRAY[1020, 1080], NULL, false, false, false, 'high')$$,
    'a second rule for the same coach and team is added beside the first: nothing supersedes');
SELECT lives_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'must', NULL, NULL, ARRAY['a1111111-1111-1111-1111-1111111100c1'::uuid, 'a1111111-1111-1111-1111-1111111100c2'::uuid])$$,
    'an admin adds a must rule on venues for the coach''s other team');
SELECT lives_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'prefer', NULL, NULL, NULL, true)$$,
    'a keep-the-current-weekday rule is added');
SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences
      WHERE coach_id = 'c0000000-0000-4000-8000-000000000001' AND source = 'admin' AND status = 'in_force'),
    3, 'three admin rules of one coach are in force together');
SELECT results_eq(
    $$SELECT level, requested_level, must_decision FROM public.coach_practice_preferences
       WHERE source = 'admin' AND venue_ids IS NOT NULL$$,
    $$VALUES ('must'::text, 'must'::text, 'accepted'::text)$$,
    'a must an admin adds is accepted at once: only an admin makes a rule a must');
SELECT throws_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'prefer', ARRAY['TUE'])$$,
    '22023', NULL, 'a coach who does not coach the team cannot hold a rule for it');
SELECT throws_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'prefer', ARRAY['TUE'])$$,
    '22023', NULL, 'a coach cannot hold a rule for the team of a coach''s colleague');
SELECT throws_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'sometimes', ARRAY['TUE'])$$,
    '22023', NULL, 'a level other than prefer or must is refused');
SELECT throws_ok(
    $$SELECT public.admin_add_practice_preference('c0000000-0000-4000-8000-0000000000c4', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'prefer', ARRAY['TUE'])$$,
    '22023', 'The season of team aaaaaaaa-0000-0000-0000-0000000000c1 is completed and takes no practice preference',
    'a completed season takes no rule');

-- Edit: replaces the conditions, level and window; the coach and team stay.
SELECT lives_ok(
    $$SELECT public.admin_edit_practice_preference(
        (SELECT id FROM public.coach_practice_preferences WHERE weekdays = ARRAY['TUE', 'THU'] AND source = 'admin'),
        'prefer', ARRAY['WED'], NULL, NULL, false, false, false, 'low', CURRENT_DATE, CURRENT_DATE + 30)$$,
    'an admin edits a rule');
SELECT results_eq(
    $$SELECT weekdays, coach_priority, effective_from, effective_to FROM public.coach_practice_preferences
       WHERE source = 'admin' AND coach_priority = 'low'$$,
    $$VALUES (ARRAY['WED']::text[], 'low'::text, CURRENT_DATE, CURRENT_DATE + 30)$$,
    'the edit replaced the weekdays, the priority and the window');
SELECT throws_ok(
    $$SELECT public.admin_edit_practice_preference(
        (SELECT id FROM public.coach_practice_preferences WHERE source = 'admin' AND coach_priority = 'low'),
        'prefer', ARRAY[]::text[])$$,
    '23514', NULL, 'an edit to an empty set is refused by the CHECK');

-- Decide a pending must: accept it, keep another as prefer, and a decided one cannot be decided again.
SELECT results_eq(
    $$SELECT level, must_decision FROM public.coach_practice_preferences
       WHERE id = 'c0000000-0000-4000-8000-0000000000e1'$$,
    $$VALUES ('prefer'::text, 'pending'::text)$$,
    'an imported must is in force as prefer while it is pending');
SELECT lives_ok(
    $$SELECT public.admin_decide_must_preference('c0000000-0000-4000-8000-0000000000e1', 'accept')$$,
    'an admin accepts a pending must');
SELECT results_eq(
    $$SELECT level, requested_level, must_decision FROM public.coach_practice_preferences
       WHERE id = 'c0000000-0000-4000-8000-0000000000e1'$$,
    $$VALUES ('must'::text, 'must'::text, 'accepted'::text)$$,
    'the accepted rule is a must');
SELECT lives_ok(
    $$SELECT public.admin_decide_must_preference('c0000000-0000-4000-8000-0000000000e2', 'keep_prefer')$$,
    'an admin keeps a pending must as prefer');
SELECT results_eq(
    $$SELECT level, requested_level, must_decision FROM public.coach_practice_preferences
       WHERE id = 'c0000000-0000-4000-8000-0000000000e2'$$,
    $$VALUES ('prefer'::text, 'must'::text, 'kept_prefer'::text)$$,
    'a denied must stays in force as prefer, with what was asked and the decision recorded');
SELECT throws_ok(
    $$SELECT public.admin_decide_must_preference('c0000000-0000-4000-8000-0000000000e1', 'accept')$$,
    '22023', NULL, 'a decided must is not pending and is refused');
SELECT throws_ok(
    $$SELECT public.admin_decide_must_preference('c0000000-0000-4000-8000-0000000000e3', 'maybe')$$,
    '22023', NULL, 'a decision other than accept or keep_prefer is refused');

-- Accept all: the count must be the one the confirmation showed.
SELECT throws_ok(
    $$SELECT public.admin_accept_all_musts('a1111111-1111-1111-1111-1111111a0002', 5)$$,
    '22023', 'import job a1111111-1111-1111-1111-1111111a0002 has 1 pending must(s), not the 5 the confirmation showed; nothing was accepted',
    'Accept all refuses when the pending count is not the count the confirmation showed');
SELECT is(
    (SELECT must_decision FROM public.coach_practice_preferences WHERE id = 'c0000000-0000-4000-8000-0000000000e3'),
    'pending', 'and nothing was accepted');
SELECT is(
    (SELECT public.admin_accept_all_musts('a1111111-1111-1111-1111-1111111a0002', 1) ->> 'accepted'),
    '1', 'Accept all with the right count accepts the file''s pending musts');
SELECT results_eq(
    $$SELECT level, must_decision FROM public.coach_practice_preferences WHERE id = 'c0000000-0000-4000-8000-0000000000e3'$$,
    $$VALUES ('must'::text, 'accepted'::text)$$,
    'the accepted rule is a must');
SELECT throws_ok(
    $$SELECT public.admin_accept_all_musts('a1111111-1111-1111-1111-1111111a0002', 1)$$,
    '22023', NULL, 'a second Accept all of the same file finds none pending and refuses its stale count');

-- Remove: the row stays as history.
SELECT lives_ok(
    $$SELECT public.admin_remove_practice_preference((SELECT id FROM public.coach_practice_preferences WHERE source = 'admin' AND keep_weekday))$$,
    'an admin removes a rule');
SELECT is(
    (SELECT status FROM public.coach_practice_preferences WHERE source = 'admin' AND keep_weekday),
    'removed', 'the removed rule stays as history, not in force');
SELECT throws_ok(
    $$SELECT public.admin_remove_practice_preference((SELECT id FROM public.coach_practice_preferences WHERE source = 'admin' AND keep_weekday))$$,
    '22023', NULL, 'a rule already removed cannot be removed again');

-- Every write is audited, with the row.
RESET role;
SELECT is(
    (SELECT array_agg(DISTINCT action ORDER BY action) FROM public.audit_log
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND action LIKE 'practice_preference.%'),
    ARRAY['practice_preference.added', 'practice_preference.edited', 'practice_preference.must_decided',
          'practice_preference.musts_accepted', 'practice_preference.removed']::text[],
    'each RPC left its audit action');
SELECT is(
    (SELECT count(*)::int FROM public.audit_log WHERE action = 'practice_preference.added'
        AND resource_id IN (SELECT id FROM public.coach_practice_preferences WHERE source = 'admin')
        AND metadata -> 'after' ->> 'team_id' IS NOT NULL),
    4, 'the four adds are audited, each with the rule it wrote');

-- Deleting a team takes its rules and counts them.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT lives_ok(
    $$SELECT public.admin_delete_team('aaaaaaaa-0000-0000-0000-0000000000a2')$$,
    'an admin deletes a team that has rules');
RESET role;
SELECT is(
    (SELECT (metadata ->> 'coach_practice_preferences_deleted')::int FROM public.audit_log
      WHERE action = 'team.deleted' AND resource_id = 'aaaaaaaa-0000-0000-0000-0000000000a2'),
    2, 'team.deleted counts the two rules its cascade took (the imported pending and the must on venues)');
SELECT is(
    (SELECT count(*)::int FROM public.coach_practice_preferences WHERE team_id = 'aaaaaaaa-0000-0000-0000-0000000000a2'),
    0, 'and none of that team''s rules is left');

SELECT * FROM finish();
ROLLBACK;
