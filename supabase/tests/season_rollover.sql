-- pgTAP: start the next season from this one; draft editing, activation, the age cutoff and
-- division windows; drafts take imports; completed seasons are read-only
-- (migration 20261109010000; plans docs/changes/2026-10-22-phase-e-seasons.md, "The seven points",
-- "Concurrency", Decisions 4-7, and docs/changes/2026-10-27-season-enrollment.md, C3; PR E3b).
--
--   * the catalogue of what a rollover copies names every column of `divisions` and
--     `season_settings` once, and fails when a column is added in the test's own transaction;
--   * `admin_create_season_from` copies divisions (every catalogue column, a birth-date window
--     moved by the difference in season years) and programs (the new default is the source
--     default's copy) and no player, coach or team; the new season is a draft; it is audited, takes
--     the organization's season lock, refuses a non-admin, a duplicate name, a bad year or dates, and
--     a rollover made to fail after its divisions insert leaves no season and no copy;
--   * `admin_update_draft_season` patches name and dates (draft or active) and the year and cutoff
--     (a draft with no players only), audited with old and new values, refusing each bad value;
--   * `admin_set_division_birthdate_window` sets and clears a window, refused once the season has
--     players (also for a direct write, by trigger), half a window and a completed season;
--   * `admin_activate_season` needs a known timezone, both dates and a year; completes the previous
--     active season; never reactivates a completed one; is audited; takes the lock;
--   * an import into a draft season leaves the active season's row untouched (the case Codex found
--     on #666), for players and coaches; a completed season and a field import into a draft are
--     refused;
--   * a completed season is read-only for a signed-in caller (players and coaches) and still
--     reachable by the retention job; deleting an organization is not blocked by it.
-- Season A is Org A's fixture season (active, 2026). Run as `authenticated` with a JWT sub where a
-- caller matters.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(199);

-- Helpers: the SQLSTATE and DETAIL of a refusal, and whether a call took the organization's lock.
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
CREATE FUNCTION pg_temp.takes_lock(p_sql text, p_org uuid) RETURNS boolean LANGUAGE plpgsql AS $f$
DECLARE
    v_key bigint := hashtextextended('season:' || p_org::text, 0);
    v_held boolean := false;
BEGIN
    BEGIN
        EXECUTE p_sql;
        SELECT EXISTS (SELECT 1 FROM pg_locks l
                        WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted
                          AND l.classid::bigint = ((v_key >> 32) & 4294967295)
                          AND l.objid::bigint = (v_key & 4294967295)) INTO v_held;
        -- Undone, so the lock the call took is released and the next call is measured alone.
        RAISE EXCEPTION 'probe' USING ERRCODE = 'P0001';
    EXCEPTION WHEN OTHERS THEN
        -- The probe's own raise, or a refusal: either way nothing stays done.
        NULL;
    END;
    RETURN v_held;
END
$f$;

-- ── The catalogue ───────────────────────────────────────────────────────────
SELECT is(
    (SELECT array_agg(c.column_name::text ORDER BY c.column_name::text)
       FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'divisions'),
    (SELECT array_agg(x ORDER BY x) FROM unnest(public.rollover_division_columns() || public.rollover_division_skipped_columns()) AS x),
    'every column of divisions is classified as copied or skipped by a rollover, once');
SELECT is(
    (SELECT array_agg(c.column_name::text ORDER BY c.column_name::text)
       FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'season_settings'),
    (SELECT array_agg(x ORDER BY x) FROM unnest(public.rollover_season_columns() || public.rollover_season_skipped_columns()) AS x),
    'and every column of season_settings');
SELECT is(
    (SELECT count(*)::int FROM (SELECT unnest(public.rollover_division_columns()) INTERSECT SELECT unnest(public.rollover_division_skipped_columns())) AS both_lists),
    0, 'no divisions column is both copied and skipped');
SELECT is(
    (SELECT count(*)::int FROM (SELECT unnest(public.rollover_season_columns()) INTERSECT SELECT unnest(public.rollover_season_skipped_columns())) AS both_lists),
    0, 'nor a season_settings column');

-- ── Seed: season A has divisions in a program, players, a coach and a team ───
UPDATE public.season_settings
   SET timezone = 'America/Los_Angeles', season_start = '2026-08-01', season_end = '2027-06-30',
       school_day_end = '15:30', age_cutoff_mode = 'custom', age_cutoff_month = 9, age_cutoff_day = 1,
       roster_formula = '{"minimum": 7}'::jsonb, exports_config = '{"layout": "wide"}'::jsonb,
       daylight_adjustments = '[{"date": "2026-11-01", "note": "dst"}]'::jsonb
 WHERE id = 'a1111111-1111-1111-1111-111111111aaa';
INSERT INTO public.programs (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-0000000e3b01', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111aaa', 'Minis');
UPDATE public.divisions
   SET min_age = 9, max_age = 10, birthdate_start = '2015-09-01', birthdate_end = '2016-08-31',
       max_roster_size = 12, min_roster_size = 8, target_team_size = 10, min_teams = 1, max_teams = 4,
       team_count_override = 2, play_format = '7v7', format = 'league', plays_games = false,
       practices_per_week = 2, practice_minutes = 75, gender_policy = 'girls'
 WHERE id = 'a1111111-1111-1111-1111-11111111abcd';
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, program_id, min_age, max_age) VALUES
    ('a1111111-1111-1111-1111-11111111abce', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-111111111aaa', 'Org A U4', 'a1111111-1111-1111-1111-0000000e3b01', 4, 4);
INSERT INTO public.players (id, organization_id, division_id, first_name, last_name, external_registration_id, natural_age) VALUES
    ('a1111111-1111-1111-1111-0000000e3b11', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'Pia', 'Active', 'E3B-1', 10),
    ('a1111111-1111-1111-1111-0000000e3b12', 'a1111111-1111-1111-1111-111111111111',
     'a1111111-1111-1111-1111-11111111abcd', 'Quin', 'Active', 'E3B-2', 10);
INSERT INTO public.coaches (id, organization_id, full_name, email) VALUES
    ('a1111111-1111-1111-1111-0000000e3c11', 'a1111111-1111-1111-1111-111111111111', 'Cora Active', 'cora@example.test');
CREATE TEMP TABLE src_before ON COMMIT DROP AS
    SELECT 'season' AS k, to_jsonb(s) AS row FROM public.season_settings s WHERE s.id = 'a1111111-1111-1111-1111-111111111aaa'
    UNION ALL SELECT 'division', to_jsonb(d) FROM public.divisions d WHERE d.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
    UNION ALL SELECT 'player', to_jsonb(p) FROM public.players p WHERE p.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
    UNION ALL SELECT 'coach', to_jsonb(c) FROM public.coaches c WHERE c.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
    UNION ALL SELECT 'program', to_jsonb(g) FROM public.programs g WHERE g.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa';
GRANT SELECT ON src_before TO PUBLIC;

-- ── admin_create_season_from ────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

CREATE TEMP TABLE created ON COMMIT DROP AS
    SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', '  Org A 2027  ', 2027, '2027-08-01', '2028-06-30') AS r;
GRANT SELECT ON created TO PUBLIC;
SELECT is((SELECT r ->> 'status' FROM created), 'draft', 'the new season is a draft');
SELECT is((SELECT (r ->> 'divisions_copied')::int || '/' || (r ->> 'programs_copied')::int FROM created), '2/1',
    'it reports two divisions and one program copied');
RESET role;
SELECT is(
    (SELECT s.name || '|' || s.status || '|' || s.season_year || '|' || s.season_start || '|' || s.season_end
       FROM public.season_settings s WHERE s.id = (SELECT (r ->> 'id')::uuid FROM created)),
    'Org A 2027|draft|2027|2027-08-01|2028-06-30', 'name trimmed, a draft, the year and the dates given');
SELECT is(
    (SELECT to_jsonb(n) - public.rollover_season_skipped_columns() = to_jsonb(o) - public.rollover_season_skipped_columns()
       FROM public.season_settings n, public.season_settings o
      WHERE n.id = (SELECT (r ->> 'id')::uuid FROM created) AND o.id = 'a1111111-1111-1111-1111-111111111aaa'),
    true, 'every copied season setting equals the source''s (timezone, custom cutoff, school day end, roster formula, exports)');
SELECT is(
    (SELECT n.daylight_adjustments FROM public.season_settings n WHERE n.id = (SELECT (r ->> 'id')::uuid FROM created)),
    '[]'::jsonb, 'the source''s dated daylight adjustments are not copied');
SELECT is(
    (SELECT count(*)::int FROM public.divisions n JOIN public.divisions o ON o.name = n.name AND o.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
      WHERE n.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created)
        AND to_jsonb(n) - public.rollover_division_skipped_columns() - 'birthdate_start' - 'birthdate_end'
          = to_jsonb(o) - public.rollover_division_skipped_columns() - 'birthdate_start' - 'birthdate_end'),
    2, 'both divisions carry every copied column of the source''s, roster rules, band, format, practices and gender included');
SELECT is(
    (SELECT n.birthdate_start || '..' || n.birthdate_end FROM public.divisions n
      WHERE n.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created) AND n.name = 'Org A U10'),
    '2016-09-01..2017-08-31', 'a birth-date window moves one year (the difference in season years)');
SELECT is(
    (SELECT n.birthdate_start IS NULL AND n.birthdate_end IS NULL FROM public.divisions n
      WHERE n.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created) AND n.name = 'Org A U4'),
    true, 'and a division with none still has none');
SELECT is(
    (SELECT count(*)::int FROM public.programs n WHERE n.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created)),
    2, 'the new season has two programs: its default and the copy of Minis, not a second default');
SELECT is(
    (SELECT n.copied_from_program_id FROM public.programs n
      WHERE n.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created) AND n.name = 'Minis'),
    'a1111111-1111-1111-1111-0000000e3b01'::uuid, 'the copied program names its source');
SELECT is(
    (SELECT o.is_default AND n.is_default FROM public.programs n JOIN public.programs o ON o.id = n.copied_from_program_id
      WHERE n.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created) AND n.is_default),
    true, 'the new default program is the source default''s copy');
SELECT is(
    (SELECT p.name FROM public.divisions d JOIN public.programs p ON p.id = d.program_id
      WHERE d.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created) AND d.name = 'Org A U4'),
    'Minis', 'a division is in the copy of its program');
SELECT is(
    (SELECT p.is_default FROM public.divisions d JOIN public.programs p ON p.id = d.program_id
      WHERE d.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created) AND d.name = 'Org A U10'),
    true, 'and a division of the default program is in the new default');
SELECT is(
    (SELECT (SELECT count(*) FROM public.players WHERE season_settings_id = (SELECT (r ->> 'id')::uuid FROM created))
          + (SELECT count(*) FROM public.coaches WHERE season_settings_id = (SELECT (r ->> 'id')::uuid FROM created))
          + (SELECT count(*) FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
              WHERE d.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created)))::int,
    0, 'no player, coach or team is copied (the source has two players, a coach and a team)');
SELECT is(
    (SELECT count(*)::int FROM src_before b
      JOIN (SELECT 'season' AS k, to_jsonb(s) AS row FROM public.season_settings s WHERE s.id = 'a1111111-1111-1111-1111-111111111aaa'
            UNION ALL SELECT 'division', to_jsonb(d) FROM public.divisions d WHERE d.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
            UNION ALL SELECT 'player', to_jsonb(p) FROM public.players p WHERE p.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
            UNION ALL SELECT 'coach', to_jsonb(c) FROM public.coaches c WHERE c.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'
            UNION ALL SELECT 'program', to_jsonb(g) FROM public.programs g WHERE g.season_settings_id = 'a1111111-1111-1111-1111-111111111aaa') a
        ON a.k = b.k AND a.row = b.row),
    (SELECT count(*)::int FROM src_before), 'the source season is untouched, row for row');
SELECT is(
    (SELECT a.metadata ->> 'source_season_id' || '|' || (a.metadata ->> 'divisions_copied') || '|' || (a.metadata ->> 'programs_copied')
            || '|' || (a.metadata ->> 'window_shift_years')
       FROM public.audit_log a WHERE a.organization_id = 'a1111111-1111-1111-1111-111111111111' AND a.action = 'season.created_from'),
    'a1111111-1111-1111-1111-111111111aaa|2|1|1', 'one season.created_from row names the source, the counts and the shift');

-- The two-year shift (the window moves by the difference in years), from the new draft.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE created2 ON COMMIT DROP AS
    SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Org A 2028', 2028) AS r;
GRANT SELECT ON created2 TO PUBLIC;
RESET role;
SELECT is(
    (SELECT n.birthdate_start || '..' || n.birthdate_end FROM public.divisions n
      WHERE n.season_settings_id = (SELECT (r ->> 'id')::uuid FROM created2) AND n.name = 'Org A U10'),
    '2017-09-01..2018-08-31', 'a season two years on moves the window two years');
SELECT is((SELECT s.season_start IS NULL AND s.season_end IS NULL FROM public.season_settings s WHERE s.id = (SELECT (r ->> 'id')::uuid FROM created2)),
    true, 'dates are optional on creation');

-- Refusals.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Bob Season', 2027)$$),
    '42501:', 'an admin of another organization is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Charlie Season', 2027)$$),
    '42501:', 'so is a signed-in user who belongs to no organization');
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Nobody Season', 2027)$$),
    '42501:', 'and nobody signed in');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111fff', 'Ghost', 2027)$$),
    '42501:', 'an unknown source is refused the same way');
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', ' org a 2027', 2029)$$),
    '23505:', 'a name already taken (ignoring case and padding) is refused');
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', '   ', 2029)$$),
    '22023:', 'an empty name is refused');
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Bad Year', 1999)$$),
    '22023:season_year_invalid', 'a year outside 2000-2100 is refused');
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Bad Year', NULL)$$),
    '22023:season_year_invalid', 'and no year');
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Bad Dates', 2029, '2029-09-01', '2029-08-01')$$),
    '22023:season_dates_invalid', 'a season that ends before it starts is refused');
RESET role;
SELECT is((SELECT count(*)::int FROM public.season_settings WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'), 3,
    'the refused calls left no season behind (the fixture season and the two drafts)');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'season.created_from'), 2, 'and wrote no audit row');

-- A rollover made to fail after its divisions insert leaves no season and no copy.
CREATE FUNCTION pg_temp.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
    IF NEW.action = 'season.created_from' THEN RAISE EXCEPTION 'planted failure' USING ERRCODE = 'P0001'; END IF;
    RETURN NEW;
END
$f$;
CREATE TRIGGER zz_fail_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_audit();
CREATE TEMP TABLE counts_before ON COMMIT DROP AS
    SELECT (SELECT count(*) FROM public.season_settings) AS seasons, (SELECT count(*) FROM public.divisions) AS divisions,
           (SELECT count(*) FROM public.programs) AS programs;
GRANT SELECT ON counts_before TO PUBLIC;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Will Fail', 2030)$$),
    'P0001:', 'a rollover whose last step fails raises');
RESET role;
DROP TRIGGER zz_fail_audit ON public.audit_log;
SELECT is(
    (SELECT (SELECT count(*) FROM public.season_settings) = b.seasons AND (SELECT count(*) FROM public.divisions) = b.divisions
        AND (SELECT count(*) FROM public.programs) = b.programs FROM counts_before b),
    true, 'and leaves no season, no division and no program behind');

-- The lock.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.takes_lock($$SELECT public.admin_create_season_from('a1111111-1111-1111-1111-111111111aaa', 'Lock Probe', 2031)$$,
    'a1111111-1111-1111-1111-111111111111'), true, 'the rollover takes the organization''s season lock');
SELECT is(pg_temp.takes_lock($$SELECT public.admin_activate_season('a1111111-1111-1111-1111-111111111fff')$$,
    'a1111111-1111-1111-1111-111111111111'), false,
    'control: a call refused before the lock (unknown season) does not take it, so the probe can say no');

-- ── admin_update_draft_season ───────────────────────────────────────────────
CREATE TEMP TABLE ids ON COMMIT DROP AS
    SELECT (SELECT (r ->> 'id')::uuid FROM created) AS d27, (SELECT (r ->> 'id')::uuid FROM created2) AS d28;
GRANT SELECT ON ids TO PUBLIC;
SELECT is(pg_temp.takes_lock(format($$SELECT public.admin_update_draft_season(%L, '{"name": "Org A Lock"}')$$, (SELECT d27 FROM ids)),
    'a1111111-1111-1111-1111-111111111111'), true, 'the draft update takes the season lock');
SELECT is(
    (SELECT (public.admin_update_draft_season((SELECT d27 FROM ids),
        '{"name": " Org A Next ", "season_start": "2027-09-01", "season_end": null, "season_year": 2027, "age_cutoff_mode": "birth_year"}'::jsonb)) ->> 'changed'),
    'true', 'a draft takes a new name, a start date, a cleared end date and a calendar-year cutoff');
RESET role;
SELECT is(
    (SELECT s.name || '|' || s.season_start || '|' || COALESCE(s.season_end::text, 'null') || '|' || s.age_cutoff_mode
            || '|' || COALESCE(s.age_cutoff_month::text, 'null') || '|' || COALESCE(s.age_cutoff_day::text, 'null')
       FROM public.season_settings s WHERE s.id = (SELECT d27 FROM ids)),
    'Org A Next|2027-09-01|null|birth_year|null|null', 'stored: trimmed, a null clears, and leaving custom clears its day');
SELECT is(
    (SELECT a.metadata -> 'changed' -> 'name' ->> 'old' || ' > ' || (a.metadata -> 'changed' -> 'name' ->> 'new')
       FROM public.audit_log a WHERE a.action = 'season.updated' AND a.resource_id = (SELECT d27 FROM ids)),
    'Org A 2027 > Org A Next', 'one season.updated row carries the old and new name');
SELECT is(
    (SELECT (a.metadata -> 'changed') ? 'age_cutoff_month' FROM public.audit_log a
      WHERE a.action = 'season.updated' AND a.resource_id = (SELECT d27 FROM ids)),
    true, 'and the cleared cutoff month');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    (SELECT (public.admin_update_draft_season((SELECT d27 FROM ids), '{"age_cutoff_mode": "custom", "age_cutoff_month": 7, "age_cutoff_day": 31}')) ->> 'changed'),
    'true', 'a custom cutoff day is set (July 31)');
SELECT is(
    (SELECT (public.admin_update_draft_season((SELECT d27 FROM ids), '{"age_cutoff_mode": "custom", "age_cutoff_month": 7, "age_cutoff_day": 31, "name": "Org A Next"}')) ->> 'changed'),
    'false', 'the same values again change nothing');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'season.updated' AND resource_id = (SELECT d27 FROM ids)), 2,
    'and write no audit row (two updates so far)');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "custom", "age_cutoff_month": 2}')$$, (SELECT d27 FROM ids))),
    '22023:cutoff_day_invalid', 'a day the new month does not have (the stored 31st in February) is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "custom", "age_cutoff_month": 13, "age_cutoff_day": 1}')$$, (SELECT d27 FROM ids))),
    '22023:cutoff_day_invalid', 'a month of 13 is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "birth_year"}')$$, (SELECT d27 FROM ids)) ||''), 'no error',
    'switching back to the calendar year is fine');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "custom"}')$$, (SELECT d27 FROM ids))),
    '22023:cutoff_day_missing', 'choosing custom without a day is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "lunar"}')$$, (SELECT d27 FROM ids))),
    '22023:', 'an unknown mode is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"status": "active"}')$$, (SELECT d27 FROM ids))),
    '22023:', 'a key that is not editable here (status) is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"season_start": "not a date"}')$$, (SELECT d27 FROM ids))),
    '22023:', 'a value that is not a date is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"season_start": "2028-01-01", "season_end": "2027-01-01"}')$$, (SELECT d27 FROM ids))),
    '22023:season_dates_invalid', 'an end before the start is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"season_year": 1800}')$$, (SELECT d27 FROM ids))),
    '22023:season_year_invalid', 'a year outside 2000-2100 is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"name": "Org A 2028"}')$$, (SELECT d27 FROM ids))),
    '23505:', 'a name another season holds is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"name": null}')$$, (SELECT d27 FROM ids))),
    '22023:', 'and a season cannot lose its name');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '[]')$$, (SELECT d27 FROM ids))),
    '22023:', 'a patch that is not an object is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"name": "Mine now"}')$$, (SELECT d27 FROM ids))),
    '42501:', 'another organization''s admin is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- The active season: name and dates, not the rule that counts ages.
SELECT is(pg_temp.err($$SELECT public.admin_update_draft_season('a1111111-1111-1111-1111-111111111aaa', '{"name": "Org A Spring 2026 (renamed)", "season_end": "2027-07-15"}')$$),
    'no error', 'the active season takes a new name and end date');
SELECT is(pg_temp.err($$SELECT public.admin_update_draft_season('a1111111-1111-1111-1111-111111111aaa', '{"age_cutoff_mode": "birth_year"}')$$),
    '22023:season_not_draft', 'but not a new cutoff');
SELECT is(pg_temp.err($$SELECT public.admin_update_draft_season('a1111111-1111-1111-1111-111111111aaa', '{"season_year": 2027}')$$),
    '22023:season_not_draft', 'nor a new season year');
SELECT is(pg_temp.err($$SELECT public.admin_update_draft_season('a1111111-1111-1111-1111-111111111aaa', '{"season_year": 2026}')$$),
    'no error', 'the year it already has is not a change');

-- ── admin_set_division_birthdate_window ─────────────────────────────────────
CREATE TEMP TABLE draft_div ON COMMIT DROP AS
    SELECT d.id FROM public.divisions d WHERE d.season_settings_id = (SELECT d27 FROM ids) AND d.name = 'Org A U4';
GRANT SELECT ON draft_div TO PUBLIC;
SELECT is(pg_temp.takes_lock(format($$SELECT public.admin_set_division_birthdate_window(%L, '2023-01-01', '2024-07-31')$$, (SELECT id FROM draft_div)),
    'a1111111-1111-1111-1111-111111111111'), true, 'the window writer takes the season lock');
SELECT is((public.admin_set_division_birthdate_window((SELECT id FROM draft_div), '2023-01-01', '2024-07-31') ->> 'changed'), 'true',
    'a draft division takes a window');
SELECT is((public.admin_set_division_birthdate_window((SELECT id FROM draft_div), '2023-01-01', '2024-07-31') ->> 'changed'), 'false',
    'the same window again is no change');
RESET role;
SELECT is(
    (SELECT a.metadata ->> 'new_start' || '..' || (a.metadata ->> 'new_end') FROM public.audit_log a
      WHERE a.action = 'division.window_changed' AND a.resource_id = (SELECT id FROM draft_div)),
    '2023-01-01..2024-07-31', 'one division.window_changed row records it');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_set_division_birthdate_window(%L, '2023-01-01', NULL)$$, (SELECT id FROM draft_div))),
    '22023:window_incomplete', 'half a window is refused');
SELECT is(pg_temp.err(format($$SELECT public.admin_set_division_birthdate_window(%L, '2024-01-01', '2023-01-01')$$, (SELECT id FROM draft_div))),
    '22023:window_invalid', 'a window that ends before it starts is refused');
SELECT is((public.admin_set_division_birthdate_window((SELECT id FROM draft_div), NULL, NULL) ->> 'changed'), 'true',
    'both ends null clear the window');
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_set_division_birthdate_window(%L, '2023-01-01', '2024-07-31')$$, (SELECT id FROM draft_div))),
    '42501:', 'another organization''s admin is refused');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.admin_set_division_birthdate_window('a1111111-1111-1111-1111-11111111abcd', '2015-01-01', '2016-12-31')$$),
    '22023:season_has_players', 'a division of a season with players cannot change its window');
SELECT is(pg_temp.err($$SELECT public.admin_update_draft_season('a1111111-1111-1111-1111-111111111aaa', '{"name": "Org A Spring 2026"}')$$),
    'no error', 'while the season''s name still can');

-- The same rule for every writer: triggers.
RESET role;
SELECT is(pg_temp.err($$UPDATE public.divisions SET birthdate_start = '2010-01-01', birthdate_end = '2011-01-01' WHERE id = 'a1111111-1111-1111-1111-11111111abcd'$$),
    '22023:season_has_players', 'a direct update of a window in a season with players is refused');
SELECT is(pg_temp.err($$UPDATE public.season_settings SET age_cutoff_mode = 'birth_year', age_cutoff_month = NULL, age_cutoff_day = NULL WHERE id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    '22023:season_has_players', 'a direct update of the cutoff is refused');
SELECT is(pg_temp.err($$UPDATE public.season_settings SET season_year = 2027 WHERE id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    '22023:season_has_players', 'and of the season year');
SELECT is(pg_temp.err($$INSERT INTO public.divisions (organization_id, season_settings_id, name, birthdate_start, birthdate_end) VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Org A U8 window', '2018-01-01', '2018-12-31')$$),
    '22023:season_has_players', 'a new division with a window in such a season is refused');
SELECT is(pg_temp.err($$INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Org A U8 plain')$$),
    'no error', 'while one with no window is fine');
SELECT is(pg_temp.err($$UPDATE public.divisions SET max_roster_size = 14 WHERE id = 'a1111111-1111-1111-1111-11111111abcd'$$),
    'no error', 'and any other column of a division still updates');
SELECT is(pg_temp.err(format($$UPDATE public.season_settings SET age_cutoff_mode = 'birth_year', age_cutoff_month = NULL, age_cutoff_day = NULL WHERE id = %L$$, (SELECT d28 FROM ids))),
    'no error', 'a draft with no players changes its cutoff freely, by any writer');

-- ── admin_activate_season ───────────────────────────────────────────────────
-- d28 (created with no dates) from a source with a timezone; d27 has a start date and no end.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d28 FROM ids))),
    '22023:season_dates_missing', 'a draft with no dates is not activated');
SELECT is(pg_temp.err(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d27 FROM ids))),
    '22023:season_dates_missing', 'nor with only a start');
RESET role;
UPDATE public.season_settings SET timezone = NULL, season_start = '2028-08-01', season_end = '2029-06-30' WHERE id = (SELECT d28 FROM ids);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d28 FROM ids))),
    '22023:season_timezone_missing', 'nor with no timezone');
RESET role;
UPDATE public.season_settings SET timezone = 'Mars/Olympus' WHERE id = (SELECT d28 FROM ids);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d28 FROM ids))),
    '22023:season_timezone_missing', 'nor with a timezone the server does not know');
RESET role;
UPDATE public.season_settings SET timezone = 'America/Denver', season_end = '2028-01-01' WHERE id = (SELECT d28 FROM ids);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d28 FROM ids))),
    '22023:season_dates_invalid', 'nor ending before it starts');
RESET role;
UPDATE public.season_settings SET season_end = '2029-06-30', season_year = NULL WHERE id = (SELECT d28 FROM ids);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d28 FROM ids))),
    '22023:season_year_missing', 'nor with no season year');
RESET role;
SELECT is((SELECT s.status FROM public.season_settings s WHERE s.id = (SELECT d28 FROM ids)), 'draft', 'every refusal left the season a draft');
SELECT is((SELECT s.status FROM public.season_settings s WHERE s.id = 'a1111111-1111-1111-1111-111111111aaa'), 'active', 'and the active season active');
SELECT is((SELECT count(*)::int FROM public.audit_log WHERE action = 'season.activated'), 0, 'with no audit row');
UPDATE public.season_settings SET season_year = 2028 WHERE id = (SELECT d28 FROM ids);

-- Other organizations' admins, and the lock.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d28 FROM ids))),
    '42501:', 'another organization''s admin cannot activate');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.takes_lock(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d28 FROM ids)),
    'a1111111-1111-1111-1111-111111111111'), true, 'activation takes the season lock');
SELECT is((SELECT s.status FROM public.season_settings s WHERE s.id = (SELECT d28 FROM ids)), 'draft', 'the probe was undone');

-- Players of season A exist; the transition completes it.
SELECT is((public.admin_activate_season((SELECT d28 FROM ids)) ->> 'previous_active_season_id'),
    'a1111111-1111-1111-1111-111111111aaa', 'activation reports the season it completed');
RESET role;
SELECT is(
    (SELECT array_agg(s.name || '=' || s.status ORDER BY s.name) FROM public.season_settings s
      WHERE s.organization_id = 'a1111111-1111-1111-1111-111111111111' AND s.id IN ('a1111111-1111-1111-1111-111111111aaa', (SELECT d28 FROM ids))),
    ARRAY['Org A 2028=active', 'Org A Spring 2026=completed'], 'the draft is active and the previous active season is completed');
SELECT is((SELECT count(*)::int FROM public.season_settings WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' AND status = 'active'), 1,
    'exactly one season is active');
SELECT is(
    (SELECT a.metadata ->> 'previous_active_season_id' FROM public.audit_log a WHERE a.action = 'season.activated' AND a.resource_id = (SELECT d28 FROM ids)),
    'a1111111-1111-1111-1111-111111111aaa', 'one season.activated row names the season it completed');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.admin_activate_season('a1111111-1111-1111-1111-111111111aaa')$$),
    '22023:season_completed', 'a completed season cannot be activated again (Decision 6)');
SELECT is(pg_temp.err(format($$SELECT public.admin_activate_season(%L)$$, (SELECT d28 FROM ids))),
    '22023:season_not_draft', 'nor the active season (the second of two admins at once finds it no longer a draft)');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"name": "x"}')$$, 'a1111111-1111-1111-1111-111111111aaa')),
    '22023:season_completed', 'a completed season''s name cannot change');
SELECT is(pg_temp.err($$SELECT public.admin_set_division_birthdate_window('a1111111-1111-1111-1111-11111111abce', NULL, NULL)$$),
    '22023:season_completed', 'a completed season''s division window cannot be written, even to the value it has');

-- ── A completed season is read-only ─────────────────────────────────────────
SELECT is(pg_temp.err($$SELECT public.admin_update_player('a1111111-1111-1111-1111-0000000e3b11', '{"notes": "late edit"}')$$),
    '22023:season_completed', 'an admin cannot patch a player of the completed season');
SELECT is(pg_temp.err($$SELECT public.admin_delete_players(ARRAY['a1111111-1111-1111-1111-0000000e3b11']::uuid[])$$),
    '22023:season_completed', 'nor delete one');
SELECT is(pg_temp.err($$INSERT INTO public.players (organization_id, season_settings_id, first_name, last_name) VALUES ('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'New', 'Late')$$),
    '22023:season_completed', 'nor insert one, even directly');
SELECT is(pg_temp.err($$SELECT public.admin_update_coach_status('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-0000000e3c11', 'inactive')$$),
    '22023:season_completed', 'nor change a coach of the completed season');
SELECT is(pg_temp.err($$SELECT public.admin_delete_coaches(ARRAY['a1111111-1111-1111-1111-0000000e3c11']::uuid[])$$),
    '22023:season_completed', 'nor delete one');
SELECT is((SELECT count(*)::int FROM public.players WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa'), 2,
    'reads still work: the completed season keeps its two players');
RESET role;
SET LOCAL "request.jwt.claims" TO '{}';
WITH u AS (UPDATE public.players SET custom_attributes = '{}'::jsonb
            WHERE season_settings_id = 'a1111111-1111-1111-1111-111111111aaa' RETURNING 1)
SELECT is((SELECT count(*)::int FROM u), 2,
    'with no signed-in user (the retention job''s case) the two rows are still reachable');
SELECT is(pg_temp.err($$SELECT public.minimise_import_people_data()$$), 'no error', 'the retention job runs over a completed season');

-- Deleting an organization is not blocked by its completed season (the cascade).
RESET role;
INSERT INTO public.organizations (id, name, slug) VALUES ('c3333333-3333-3333-3333-333333333333', 'Org C', 'org-c-e3b');
DELETE FROM public.season_settings WHERE organization_id = 'c3333333-3333-3333-3333-333333333333';
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('c3333333-3333-3333-3333-3333333333c1', 'c3333333-3333-3333-3333-333333333333', 'Org C Old', 'completed', 2025);
INSERT INTO public.players (organization_id, season_settings_id, first_name, last_name) VALUES
    ('c3333333-3333-3333-3333-333333333333', 'c3333333-3333-3333-3333-3333333333c1', 'Gone', 'Soon');
INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email) VALUES
    ('c3333333-3333-3333-3333-333333333333', 'c3333333-3333-3333-3333-3333333333c1', 'Gone Coach', 'gone@example.test');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$DELETE FROM public.organizations WHERE id = 'c3333333-3333-3333-3333-333333333333'$$), 'no error',
    'a signed-in caller can still delete an organization whose seasons are completed');
SELECT is((SELECT count(*)::int FROM public.players WHERE organization_id = 'c3333333-3333-3333-3333-333333333333')
        + (SELECT count(*)::int FROM public.coaches WHERE organization_id = 'c3333333-3333-3333-3333-333333333333'), 0,
    'and its players and coaches went with it');

-- ── An import into a draft season ──────────────────────────────────────────
-- Season "Org A 2028" is the active one now; "Org A 2027" (d27, a draft) is next.
RESET role;
UPDATE public.season_settings SET timezone = 'America/Los_Angeles', season_start = '2027-08-01', season_end = '2028-06-30', season_year = 2027
 WHERE id = (SELECT d27 FROM ids);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-1111111d27a1', 'a1111111-1111-1111-1111-111111111111', (SELECT d27 FROM ids), 'Draft U10');
-- A player and a coach of the active season (2028) that a draft import must not touch.
INSERT INTO public.players (id, organization_id, season_settings_id, first_name, last_name, external_registration_id) VALUES
    ('a1111111-1111-1111-1111-0000000e3b21', 'a1111111-1111-1111-1111-111111111111', (SELECT d28 FROM ids), 'Reg', 'Active', 'E3B-9');
INSERT INTO public.coaches (id, organization_id, season_settings_id, full_name, email) VALUES
    ('a1111111-1111-1111-1111-0000000e3c21', 'a1111111-1111-1111-1111-111111111111', (SELECT d28 FROM ids), 'Dina Active', 'dina@example.test');
CREATE TEMP TABLE active_before ON COMMIT DROP AS
    SELECT p.id, to_jsonb(p) AS row FROM public.players p WHERE p.id = 'a1111111-1111-1111-1111-0000000e3b21'
    UNION ALL SELECT c.id, to_jsonb(c) FROM public.coaches c WHERE c.id = 'a1111111-1111-1111-1111-0000000e3c21';
GRANT SELECT ON active_before TO PUBLIC;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE jobs ON COMMIT DROP AS
    SELECT (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'draft-players.csv', (SELECT d27 FROM ids))).id AS players_job,
           (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'coaches', 'draft-coaches.csv', (SELECT d27 FROM ids))).id AS coaches_job;
GRANT SELECT ON jobs TO PUBLIC;
SELECT is((SELECT count(*)::int FROM public.import_jobs j WHERE j.id IN (SELECT players_job FROM jobs UNION SELECT coaches_job FROM jobs)
            AND j.season_settings_id = (SELECT d27 FROM ids)), 2, 'a player and a coach import job can be made for the draft');
SELECT is(pg_temp.err(format($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'fields', 'draft-fields.csv', %L)$$, (SELECT d27 FROM ids))),
    '22023:season_not_active', 'a field import for the draft is refused: fields and locations belong to the active season');
SELECT is(pg_temp.err($$SELECT public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'old.csv', 'a1111111-1111-1111-1111-111111111aaa')$$),
    '22023:season_completed', 'and a job for a completed season is refused');
RESET role;
INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
SELECT 'a1111111-1111-1111-1111-111111111111'::uuid, (SELECT players_job FROM jobs), 1, '{}'::jsonb,
       '{"first_name": "Reg", "last_name": "Draft", "external_registration_id": "E3B-9", "division": "Draft U10", "natural_age": "10"}'::jsonb
UNION ALL SELECT 'a1111111-1111-1111-1111-111111111111'::uuid, (SELECT players_job FROM jobs), 2, '{}'::jsonb,
       '{"first_name": "Sam", "last_name": "Draft", "external_registration_id": "E3B-10", "division": "Draft U10", "natural_age": "10"}'::jsonb;
INSERT INTO public.staging_import_rows (organization_id, import_job_id, import_type, source_row_number, raw_payload, normalized_payload, validation_errors)
VALUES ('a1111111-1111-1111-1111-111111111111', (SELECT coaches_job FROM jobs), 'coaches', 1, '{}'::jsonb,
        '{"full_name": "Dina Draft", "email": "dina@example.test"}'::jsonb, '[]'::jsonb);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE draft_fin ON COMMIT DROP AS SELECT public.finalize_import_job((SELECT players_job FROM jobs)) AS r;
GRANT SELECT ON draft_fin TO PUBLIC;
SELECT is((SELECT r ->> 'inserted_players' || '/' || (r ->> 'updated_players') FROM draft_fin), '2/0',
    'the import into the draft inserts both players and updates none, E3B-9 included');
CREATE TEMP TABLE draft_cfin ON COMMIT DROP AS SELECT public.finalize_coach_import_job((SELECT coaches_job FROM jobs)) AS r;
GRANT SELECT ON draft_cfin TO PUBLIC;
SELECT is((SELECT r ->> 'inserted_coaches' || '/' || (r ->> 'updated_coaches') FROM draft_cfin), '1/0',
    'and the coach import inserts a new coach with the same email and updates none');
RESET role;
SELECT is(
    (SELECT count(*)::int FROM active_before b
      JOIN (SELECT p.id, to_jsonb(p) AS row FROM public.players p UNION ALL SELECT c.id, to_jsonb(c) FROM public.coaches c) a
        ON a.id = b.id AND a.row = b.row),
    2, 'the active season''s player and coach are untouched, to the last column (the case Codex found on #666)');
SELECT is((SELECT p.last_name FROM public.players p WHERE p.external_registration_id = 'E3B-9' AND p.season_settings_id = (SELECT d27 FROM ids)),
    'Draft', 'the draft has its own row for the same registration id');
SELECT is((SELECT count(*)::int FROM public.players p WHERE p.external_registration_id IN ('E3B-9', 'E3B-10') AND p.season_settings_id = (SELECT d28 FROM ids)),
    1, 'and the active season still has exactly its one');
SELECT is((SELECT count(*)::int FROM public.players p JOIN public.divisions d ON d.id = p.division_id
            WHERE p.season_settings_id = (SELECT d27 FROM ids) AND d.season_settings_id = (SELECT d27 FROM ids)), 2,
    'the draft''s players are in the draft''s division');
SELECT is((SELECT count(*)::int FROM public.coaches c WHERE c.email = 'dina@example.test' AND c.season_settings_id = (SELECT d27 FROM ids)), 1,
    'the draft has the coach');

-- Once the draft has players its rule is fixed.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "custom", "age_cutoff_month": 9, "age_cutoff_day": 1}')$$, (SELECT d27 FROM ids))),
    '22023:season_has_players', 'a draft with imported players can no longer change its cutoff');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"name": "Org A 2027-28"}')$$, (SELECT d27 FROM ids))),
    'no error', 'but still its name');
RESET role;

-- A completed season takes no import, whoever made the job.
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id) VALUES
    ('a1111111-0000-4000-8000-0000000e3b31', 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/e3b-old.csv', 'importing',
     '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa'),
    ('a1111111-0000-4000-8000-0000000e3b32', 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/e3b-old-c.csv', 'importing',
     '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err($$SELECT public.finalize_import_job('a1111111-0000-4000-8000-0000000e3b31')$$), '22023:season_completed',
    'a player import into the completed season is refused');
SELECT is(pg_temp.err($$SELECT public.finalize_coach_import_job('a1111111-0000-4000-8000-0000000e3b32')$$), '22023:season_completed',
    'and a coach import');

-- ── A player import in progress fixes the rule too ────────────────────────
-- Validation has already staged each natural age under the rule in force, and finalization copies
-- it without a birth date; so while a registration job has staged rows not yet promoted, the cutoff,
-- the year and a division's window do not change (ages are not recomputed: finish or cancel first).
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
CREATE TEMP TABLE pend ON COMMIT DROP AS
    SELECT (r ->> 'id')::uuid AS season FROM (SELECT public.admin_create_season_from(
        (SELECT d28 FROM ids), 'Pending Draft', 2029) AS r) x;
GRANT SELECT ON pend TO PUBLIC;
RESET role;
CREATE TEMP TABLE pend_job ON COMMIT DROP AS SELECT gen_random_uuid() AS id;
GRANT SELECT ON pend_job TO PUBLIC;
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id)
SELECT id, 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/pending.csv', 'ready_to_apply',
       '11111111-1111-1111-1111-111111111111', (SELECT season FROM pend) FROM pend_job;
INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
SELECT 'a1111111-1111-1111-1111-111111111111'::uuid, id, 1, '{}'::jsonb,
       '{"first_name": "Pen", "last_name": "Ding", "external_registration_id": "PEND-1", "natural_age": "9"}'::jsonb
  FROM pend_job;
SELECT is(public.season_has_pending_player_import((SELECT season FROM pend)), true,
    'a ready job with staged player rows is a pending import');
SELECT is(public.season_has_pending_player_import((SELECT d28 FROM ids)), false,
    'control: a season with none is not (the answer is not always yes)');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "school_year_aug_jul"}')$$, (SELECT season FROM pend))),
    '22023:import_pending', 'a cutoff change is refused while a player import is pending');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"season_year": 2030}')$$, (SELECT season FROM pend))),
    '22023:import_pending', 'so is a season year change');
SELECT is(pg_temp.err(format($$SELECT public.admin_set_division_birthdate_window(%L, '2023-01-01', '2024-07-31')$$,
    (SELECT d.id FROM public.divisions d WHERE d.season_settings_id = (SELECT season FROM pend) AND d.name = 'Org A U4'))),
    '22023:import_pending', 'and a division window');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"name": "Pending Draft (named)"}')$$, (SELECT season FROM pend))),
    'no error', 'while the name still changes');
RESET role;
SELECT is(pg_temp.err(format($$UPDATE public.season_settings SET age_cutoff_mode = 'school_year_aug_jul', age_cutoff_month = NULL, age_cutoff_day = NULL WHERE id = %L$$, (SELECT season FROM pend))),
    '22023:import_pending', 'a direct write of the cutoff meets the same rule');
SELECT is(pg_temp.err(format($$UPDATE public.divisions SET birthdate_start = '2023-01-01', birthdate_end = '2024-07-31' WHERE season_settings_id = %L AND name = 'Org A U4'$$, (SELECT season FROM pend))),
    '22023:import_pending', 'and so does a direct write of a window');
-- Cancelling the import (failing the job) frees the rule; the staged rows stay, unpromoted.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT lives_ok(format($$SELECT public.fail_import_job(%L, 'cancelled by the admin')$$, (SELECT id FROM pend_job)),
    'the admin cancels the pending import');
RESET role;
SELECT is(public.season_has_pending_player_import((SELECT season FROM pend)), false,
    'it is no longer pending, though its staged rows are still there');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "school_year_aug_jul"}')$$, (SELECT season FROM pend))),
    'no error', 'and the cutoff changes');
SELECT is(pg_temp.err(format($$SELECT public.admin_set_division_birthdate_window(%L, '2023-01-01', '2024-07-31')$$,
    (SELECT d.id FROM public.divisions d WHERE d.season_settings_id = (SELECT season FROM pend) AND d.name = 'Org A U4'))),
    'no error', 'and a division window');
RESET role;
-- A finished job is not pending either.
UPDATE public.import_jobs SET status = 'completed' WHERE id = (SELECT id FROM pend_job);
UPDATE public.staging_players SET promoted_at = now() WHERE import_job_id = (SELECT id FROM pend_job);
SELECT is(public.season_has_pending_player_import((SELECT season FROM pend)), false, 'a completed job is not pending');
-- A job whose rows are all promoted but not yet marked finished is not pending; one with a row left is.
UPDATE public.import_jobs SET status = 'importing' WHERE id = (SELECT id FROM pend_job);
SELECT is(public.season_has_pending_player_import((SELECT season FROM pend)), false, 'unfinished, with every row promoted: not pending');
INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
SELECT 'a1111111-1111-1111-1111-111111111111'::uuid, id, 2, '{}'::jsonb, '{"first_name": "Two"}'::jsonb FROM pend_job;
SELECT is(public.season_has_pending_player_import((SELECT season FROM pend)), true, 'unfinished, with a row left to promote: pending');

-- ── A file is checked under one rule: the revision, the stamp, and the refusal at finalization ──
-- The pending guard cannot see a rule change made after import-validation read the rule and before
-- it staged its first row (nothing is staged yet), nor a change and its reversal (A, B, A). The
-- season carries a revision that only goes up; `import_age_rule` returns the rule and its revision
-- from one statement and stamps the job; the finalizer refuses a job whose stamp is not the
-- season's revision now (age_rule_changed).
RESET role;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SET LOCAL role = 'authenticated';
CREATE TEMP TABLE stampd ON COMMIT DROP AS
    SELECT (r ->> 'id')::uuid AS s1 FROM (SELECT public.admin_create_season_from((SELECT d28 FROM ids), 'Stamp Draft', 2031) AS r) x;
CREATE TEMP TABLE stampd2 ON COMMIT DROP AS
    SELECT (r ->> 'id')::uuid AS s2 FROM (SELECT public.admin_create_season_from((SELECT d28 FROM ids), 'Stamp Draft Two', 2032) AS r) x;
CREATE TEMP TABLE stampd3 ON COMMIT DROP AS
    SELECT (r ->> 'id')::uuid AS s3 FROM (SELECT public.admin_create_season_from((SELECT d28 FROM ids), 'Stamp Draft Three', 2033) AS r) x;
CREATE TEMP TABLE stamp_jobs ON COMMIT DROP AS
    SELECT (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'stamp-1.csv', (SELECT s1 FROM stampd))).id AS j1,
           (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'players', 'stamp-2.csv', (SELECT s2 FROM stampd2))).id AS j2,
           (public.create_import_job('a1111111-1111-1111-1111-111111111111', 'fields', 'stamp-fields.csv')).id AS jf;
GRANT SELECT ON stampd, stampd2, stampd3, stamp_jobs TO PUBLIC;
RESET role;
-- Season 1 has one division that bears a window, with a band, before anything is stamped.
CREATE TEMP TABLE stamp_div ON COMMIT DROP AS
    SELECT d.id FROM public.divisions d WHERE d.season_settings_id = (SELECT s1 FROM stampd) ORDER BY d.id LIMIT 1;
GRANT SELECT ON stamp_div TO PUBLIC;
-- The copy carries whatever windows the source season's divisions had (the fixture gives one a
-- window), and division ids are random, so clear them: exactly one division bears a window.
UPDATE public.divisions SET birthdate_start = NULL, birthdate_end = NULL WHERE season_settings_id = (SELECT s1 FROM stampd);
UPDATE public.divisions SET min_age = 4, max_age = 4, birthdate_start = '2023-01-01', birthdate_end = '2024-07-31'
 WHERE id = (SELECT id FROM stamp_div);
SELECT is((SELECT age_rule_revision FROM public.import_jobs WHERE id = (SELECT j1 FROM stamp_jobs)), NULL,
    'a new job carries no stamp');

-- Who may read the rule and stamp: the service role, and nobody signed in.
SELECT is(has_function_privilege('authenticated', 'public.import_age_rule(uuid,uuid,boolean)', 'EXECUTE')
          OR has_function_privilege('anon', 'public.import_age_rule(uuid,uuid,boolean)', 'EXECUTE'), false,
    'no signed-in caller may read the import rule or stamp a job');
SELECT is(has_function_privilege('service_role', 'public.import_age_rule(uuid,uuid,boolean)', 'EXECUTE'), true,
    'the service role (import-validation) may');
SET LOCAL role = 'service_role';
CREATE TEMP TABLE rule0 ON COMMIT DROP AS
    SELECT public.import_age_rule('a1111111-1111-1111-1111-111111111111', (SELECT j1 FROM stamp_jobs), true) AS r;
RESET role;
GRANT SELECT ON rule0 TO PUBLIC;
SELECT is((SELECT r ->> 'season_id' FROM rule0), (SELECT s1 FROM stampd)::text, 'the rule is the job''s season''s');
SELECT is((SELECT (r ->> 'age_cutoff_mode') FROM rule0), (SELECT age_cutoff_mode FROM public.season_settings WHERE id = (SELECT s1 FROM stampd)),
    'and carries its cutoff mode');
SELECT is((SELECT jsonb_array_length(r -> 'divisions') FROM rule0), 1, 'and only the divisions that bear a window');
SELECT is((SELECT (r -> 'divisions' -> 0 ->> 'min_age') || '/' || (r -> 'divisions' -> 0 ->> 'birthdate_start') FROM rule0), '4/2023-01-01',
    'with their band and window');
SELECT is((SELECT (r ->> 'revision')::bigint FROM rule0), (SELECT age_rule_revision FROM public.season_settings WHERE id = (SELECT s1 FROM stampd)),
    'its revision is the season''s');
SELECT is((SELECT age_rule_season_id::text || '/' || age_rule_revision FROM public.import_jobs WHERE id = (SELECT j1 FROM stamp_jobs)),
          (SELECT s1 FROM stampd)::text || '/' || (SELECT r ->> 'revision' FROM rule0), 'and the job is stamped with the season and that revision');
SELECT is((SELECT r ->> 'season_id' FROM (SELECT public.import_age_rule('a1111111-1111-1111-1111-111111111111') AS r) x), (SELECT d28 FROM ids)::text,
    'with no job the rule is the active season''s');
SELECT is(pg_temp.err(format($$SELECT public.import_age_rule('a1111111-1111-1111-1111-111111111111', %L, true)$$, (SELECT jf FROM stamp_jobs))),
    'P0002:', 'a field job has no age rule to stamp');

-- The revision goes up with every change that moves an age, and with nothing else.
CREATE TEMP TABLE rev ON COMMIT DROP AS SELECT 0::bigint AS n;
CREATE FUNCTION pg_temp.rev3() RETURNS bigint LANGUAGE sql AS $f$
    SELECT age_rule_revision FROM public.season_settings WHERE id = (SELECT s3 FROM stampd3) $f$;
UPDATE rev SET n = pg_temp.rev3();
UPDATE public.season_settings SET age_cutoff_mode = age_cutoff_mode, season_year = season_year WHERE id = (SELECT s3 FROM stampd3);
SELECT is(pg_temp.rev3(), (SELECT n FROM rev), 'a write that changes no value does not move it');
UPDATE public.season_settings SET age_cutoff_mode = 'custom', age_cutoff_month = 3, age_cutoff_day = 1 WHERE id = (SELECT s3 FROM stampd3);
SELECT is(pg_temp.rev3(), (SELECT n + 1 FROM rev), 'a cutoff change moves it by one');
UPDATE rev SET n = pg_temp.rev3();
UPDATE public.season_settings SET season_year = 2040 WHERE id = (SELECT s3 FROM stampd3);
SELECT is(pg_temp.rev3(), (SELECT n + 1 FROM rev), 'so does the season year');
UPDATE rev SET n = pg_temp.rev3();
UPDATE public.season_settings SET name = 'Stamp Draft Three (renamed)', season_start = '2040-08-01' WHERE id = (SELECT s3 FROM stampd3);
SELECT is(pg_temp.rev3(), (SELECT n FROM rev), 'a name or date change does not');
CREATE TEMP TABLE div3 ON COMMIT DROP AS
    WITH ins AS (INSERT INTO public.divisions (organization_id, season_settings_id, name)
                 VALUES ('a1111111-1111-1111-1111-111111111111', (SELECT s3 FROM stampd3), 'Band Probe') RETURNING id)
    SELECT id FROM ins;
UPDATE public.divisions SET min_age = 5, max_age = 5 WHERE id = (SELECT id FROM div3);
SELECT is(pg_temp.rev3(), (SELECT n FROM rev), 'a band change on a division with no window does not');
UPDATE public.divisions SET birthdate_start = '2023-01-01', birthdate_end = '2024-07-31' WHERE id = (SELECT id FROM div3);
SELECT is(pg_temp.rev3(), (SELECT n + 1 FROM rev), 'a window put on a division does');
UPDATE rev SET n = pg_temp.rev3();
UPDATE public.divisions SET min_age = 6, max_age = 6 WHERE id = (SELECT id FROM div3);
SELECT is(pg_temp.rev3(), (SELECT n + 1 FROM rev), 'a band change on a division that bears a window does');
UPDATE rev SET n = pg_temp.rev3();
UPDATE public.divisions SET name = name || ' (renamed)' WHERE id = (SELECT id FROM div3);
SELECT is(pg_temp.rev3(), (SELECT n FROM rev), 'a name change does not, where the band columns supply the band');
UPDATE public.divisions SET min_age = NULL WHERE id = (SELECT id FROM div3);
UPDATE rev SET n = pg_temp.rev3();
UPDATE public.divisions SET name = 'U7 Renamed' WHERE id = (SELECT id FROM div3);
SELECT is(pg_temp.rev3(), (SELECT n + 1 FROM rev), 'and does where the name supplies the band');
UPDATE rev SET n = pg_temp.rev3();
INSERT INTO public.divisions (organization_id, season_settings_id, name) VALUES
    ('a1111111-1111-1111-1111-111111111111', (SELECT s3 FROM stampd3), 'No Window Division');
SELECT is(pg_temp.rev3(), (SELECT n FROM rev), 'a division with no window arriving does not');
INSERT INTO public.divisions (organization_id, season_settings_id, name, birthdate_start, birthdate_end) VALUES
    ('a1111111-1111-1111-1111-111111111111', (SELECT s3 FROM stampd3), 'Window Division', '2020-01-01', '2020-12-31');
SELECT is(pg_temp.rev3(), (SELECT n + 1 FROM rev), 'one that bears a window does');
UPDATE rev SET n = pg_temp.rev3();
DELETE FROM public.divisions WHERE season_settings_id = (SELECT s3 FROM stampd3) AND name = 'Window Division';
SELECT is(pg_temp.rev3(), (SELECT n + 1 FROM rev), 'and so does its going');

-- A, B, A: the rule read, changed, and changed back, with nothing staged between.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, '{"age_cutoff_mode": "custom", "age_cutoff_month": 3, "age_cutoff_day": 1}')$$, (SELECT s1 FROM stampd))),
    'no error', 'nothing is staged, so the cutoff changes (B)');
SELECT is(pg_temp.err(format($$SELECT public.admin_update_draft_season(%L, %L)$$, (SELECT s1 FROM stampd),
    jsonb_build_object('age_cutoff_mode', (SELECT r ->> 'age_cutoff_mode' FROM rule0),
        'age_cutoff_month', (SELECT r -> 'age_cutoff_month' FROM rule0), 'age_cutoff_day', (SELECT r -> 'age_cutoff_day' FROM rule0)))),
    'no error', 'and changes back (A)');
RESET role;
SELECT is((SELECT age_cutoff_mode || '/' || COALESCE(age_cutoff_month::text, '-') FROM public.season_settings WHERE id = (SELECT s1 FROM stampd)),
          (SELECT (r ->> 'age_cutoff_mode') || '/' || COALESCE(r ->> 'age_cutoff_month', '-') FROM rule0),
    'the rule looks exactly as it was when it was read');
SELECT cmp_ok((SELECT age_rule_revision FROM public.season_settings WHERE id = (SELECT s1 FROM stampd)), '>=', (SELECT (r ->> 'revision')::bigint + 2 FROM rule0),
    'but the revision went up by two');
INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
SELECT 'a1111111-1111-1111-1111-111111111111'::uuid, (SELECT j1 FROM stamp_jobs), 1, '{}'::jsonb,
       '{"first_name": "Stamp", "last_name": "One", "external_registration_id": "STAMP-1", "natural_age": "8"}'::jsonb;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.finalize_import_job(%L)$$, (SELECT j1 FROM stamp_jobs))),
    '22023:age_rule_changed', 'the finalizer refuses the file all the same: A, B, A is a change');
RESET role;
SELECT is((SELECT count(*)::int FROM public.players WHERE season_settings_id = (SELECT s1 FROM stampd)), 0, 'no player was written');
SELECT is((SELECT status FROM public.import_jobs WHERE id = (SELECT j1 FROM stamp_jobs)), 'importing', 'the job is left as it was, to be validated again');
-- A later batch of the same file keeps the first stamp; validating the file again (the first batch) takes a new one.
SET LOCAL role = 'service_role';
SELECT public.import_age_rule('a1111111-1111-1111-1111-111111111111', (SELECT j1 FROM stamp_jobs), false);
RESET role;
SELECT is((SELECT age_rule_revision FROM public.import_jobs WHERE id = (SELECT j1 FROM stamp_jobs)), (SELECT (r ->> 'revision')::bigint FROM rule0),
    'a later batch does not replace the stamp');
SET LOCAL role = 'service_role';
SELECT public.import_age_rule('a1111111-1111-1111-1111-111111111111', (SELECT j1 FROM stamp_jobs), true);
RESET role;
SELECT is((SELECT age_rule_revision FROM public.import_jobs WHERE id = (SELECT j1 FROM stamp_jobs)),
          (SELECT age_rule_revision FROM public.season_settings WHERE id = (SELECT s1 FROM stampd)), 'validating the file again stamps the revision now');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((public.finalize_import_job((SELECT j1 FROM stamp_jobs)) ->> 'inserted_players')::int, 1,
    'and the file is applied');
RESET role;
-- A stamp for another season is not this season's (a legacy job that finalizes elsewhere now).
UPDATE public.import_jobs SET age_rule_season_id = (SELECT s3 FROM stampd3), age_rule_revision = 0 WHERE id = (SELECT j2 FROM stamp_jobs);
INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
SELECT 'a1111111-1111-1111-1111-111111111111'::uuid, (SELECT j2 FROM stamp_jobs), 1, '{}'::jsonb,
       '{"first_name": "Stamp", "last_name": "Two", "external_registration_id": "STAMP-2", "natural_age": "8"}'::jsonb;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.finalize_import_job(%L)$$, (SELECT j2 FROM stamp_jobs))),
    '22023:age_rule_changed', 'a stamp for another season is refused even if its revision number matches');
RESET role;
-- A job with no stamp (made before the stamp, or never validated by the Edge function) is not refused.
UPDATE public.import_jobs SET age_rule_season_id = NULL, age_rule_revision = NULL WHERE id = (SELECT j2 FROM stamp_jobs);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is((public.finalize_import_job((SELECT j2 FROM stamp_jobs)) ->> 'inserted_players')::int, 1,
    'an unstamped job finalizes whatever the rule did');
RESET role;

-- A band is part of the rule: once the season has players it cannot move on a division that bears a
-- window (Codex's finding). A division with no window, a name where the columns supply the band, and
-- a call that asks for no change are not affected.
SELECT is(pg_temp.err(format($$UPDATE public.divisions SET max_age = 5 WHERE id = %L$$, (SELECT id FROM stamp_div))),
    '22023:season_has_players', 'a band change on a window-bearing division is refused once the season has players');
SELECT is(pg_temp.err(format($$UPDATE public.divisions SET name = 'U9 Renamed' WHERE id = %L$$, (SELECT id FROM stamp_div))),
    'no error', 'a rename is allowed where the band columns supply the band');
SELECT is(pg_temp.err(format($$UPDATE public.divisions SET min_age = NULL WHERE id = %L$$, (SELECT id FROM stamp_div))),
    '22023:season_has_players', 'clearing a band column is a band change');
SELECT is(pg_temp.err(format($$UPDATE public.divisions SET min_age = 4 WHERE season_settings_id = %L AND birthdate_start IS NULL$$, (SELECT s1 FROM stampd))),
    'no error', 'a band change on a division that bears no window is allowed');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(pg_temp.err(format($$SELECT public.upsert_division_for_import('a1111111-1111-1111-1111-111111111111', %L, %L, NULL, 7, 8)$$,
    (SELECT s1 FROM stampd), (SELECT name FROM public.divisions WHERE id = (SELECT id FROM stamp_div)))),
    '22023:season_has_players', 'upsert_division_for_import cannot move the band of a window-bearing division either: refused, not ignored');
SELECT is(pg_temp.err(format($$SELECT public.upsert_division_for_import('a1111111-1111-1111-1111-111111111111', %L, %L)$$,
    (SELECT s1 FROM stampd), (SELECT name FROM public.divisions WHERE id = (SELECT id FROM stamp_div)))),
    'no error', 'while a call that names no band (the coed transition''s) changes nothing');
RESET role;
-- The same while an import is pending, before any player exists.
CREATE TEMP TABLE band_pend ON COMMIT DROP AS
    SELECT d.id AS division, d.season_settings_id AS season FROM public.divisions d WHERE d.season_settings_id = (SELECT s3 FROM stampd3) AND d.name = 'U7 Renamed';
CREATE TEMP TABLE band_job ON COMMIT DROP AS SELECT gen_random_uuid() AS id;
INSERT INTO public.import_jobs (id, organization_id, job_type, storage_path, status, created_by, season_settings_id)
SELECT id, 'a1111111-1111-1111-1111-111111111111', 'registration', 'orga/band.csv', 'ready_to_apply',
       '11111111-1111-1111-1111-111111111111', (SELECT season FROM band_pend) FROM band_job;
INSERT INTO public.staging_players (organization_id, import_job_id, source_row_number, raw_payload, normalized_payload)
SELECT 'a1111111-1111-1111-1111-111111111111'::uuid, id, 1, '{}'::jsonb, '{"first_name": "Band"}'::jsonb FROM band_job;
SELECT is(pg_temp.err(format($$UPDATE public.divisions SET max_age = 9 WHERE id = %L$$, (SELECT division FROM band_pend))),
    '22023:import_pending', 'a band change on a window-bearing division is refused while an import is pending');
SELECT is(pg_temp.err(format($$UPDATE public.divisions SET name = 'U8 Renamed' WHERE id = %L$$, (SELECT division FROM band_pend))),
    '22023:import_pending', 'and so is a rename where the name supplies the band');

-- ── A completed season's timezone is fixed ───────────────────────────────────────────
-- The calendar feed expands a season's occurrences in its timezone (Codex, #680): the RPC and a direct
-- write meet one trigger, for a signed-in caller; a job with no user passes.
RESET role;
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SET LOCAL role = 'authenticated';
SELECT is(pg_temp.err($$SELECT public.admin_set_season_timezone('a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111aaa', 'Pacific/Auckland', '{}'::jsonb)$$),
    '22023:season_completed', 'admin_set_season_timezone is refused on a completed season');
SELECT is(pg_temp.err($$SELECT public.admin_set_season_timezone('a1111111-1111-1111-1111-111111111111', (SELECT d28 FROM ids), 'Pacific/Auckland', '{}'::jsonb)$$),
    'no error', 'and allowed on the active one');
RESET role;
SELECT is(pg_temp.err($$UPDATE public.season_settings SET timezone = 'Pacific/Fiji' WHERE id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    '22023:season_completed', 'a direct write of a completed season''s timezone meets the same trigger');
SELECT is(pg_temp.err($$UPDATE public.season_settings SET name = name || ' (renamed)' WHERE id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    'no error', 'while its other columns are not this trigger''s concern');
SET LOCAL "request.jwt.claims" TO '{}';
SELECT is(pg_temp.err($$UPDATE public.season_settings SET timezone = 'Pacific/Fiji' WHERE id = 'a1111111-1111-1111-1111-111111111aaa'$$),
    'no error', 'a job with no signed-in user passes');
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

-- ── The age-rule writers take the season lock ────────────────────────────────────────
-- A true two-session race cannot be run inside one pgTAP transaction, so this shows what makes it
-- safe: each writer path takes the lock the finalizer takes (`pg_advisory_xact_lock` on
-- 'season:<org>'), before it looks at players or a pending import and before it raises the revision.
-- The lock is read off pg_locks for an organization nothing in this file has touched, so the answer
-- cannot come from an earlier statement of the same transaction; the control is that it is not held
-- before the write.
CREATE FUNCTION pg_temp.season_lock_held(p_org uuid) RETURNS boolean LANGUAGE sql AS $f$
    SELECT EXISTS (
        SELECT 1 FROM pg_locks l,
               LATERAL (SELECT hashtextextended('season:' || p_org::text, 0) AS k) h
         WHERE l.locktype = 'advisory' AND l.pid = pg_backend_pid() AND l.granted
           AND l.classid = ((h.k >> 32) & 4294967295)::oid
           AND l.objid = (h.k & 4294967295)::oid AND l.objsubid = 1) $f$;
INSERT INTO public.organizations (id, name, slug) VALUES
    ('e5555555-5555-5555-5555-555555555501', 'Lock Org One', 'lock-org-one'),
    ('e5555555-5555-5555-5555-555555555502', 'Lock Org Two', 'lock-org-two'),
    ('e5555555-5555-5555-5555-555555555503', 'Lock Org Three', 'lock-org-three');
DELETE FROM public.season_settings WHERE organization_id IN ('e5555555-5555-5555-5555-555555555501', 'e5555555-5555-5555-5555-555555555502', 'e5555555-5555-5555-5555-555555555503');
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('e5555555-5555-5555-5555-5555555555a1', 'e5555555-5555-5555-5555-555555555501', 'Lock A', 'draft', 2030),
    ('e5555555-5555-5555-5555-5555555555a2', 'e5555555-5555-5555-5555-555555555502', 'Lock B', 'draft', 2030),
    ('e5555555-5555-5555-5555-5555555555a3', 'e5555555-5555-5555-5555-555555555503', 'Lock C', 'draft', 2030);
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, min_age, max_age) VALUES
    ('e5555555-5555-5555-5555-55555555d001', 'e5555555-5555-5555-5555-555555555501', 'e5555555-5555-5555-5555-5555555555a1', 'Lock U4', 4, 4),
    ('e5555555-5555-5555-5555-55555555d003', 'e5555555-5555-5555-5555-555555555503', 'e5555555-5555-5555-5555-5555555555a3', 'Lock U6', 6, 6);
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555501'), false, 'control: nothing has taken organization one''s season lock');
UPDATE public.divisions SET birthdate_start = '2023-01-01', birthdate_end = '2024-07-31' WHERE id = 'e5555555-5555-5555-5555-55555555d001';
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555501'), true, 'a division write that moves an age takes the season lock (the guard)');
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555502'), false, 'control: nothing has taken organization two''s lock');
UPDATE public.season_settings SET age_cutoff_mode = 'birth_year' WHERE id = 'e5555555-5555-5555-5555-5555555555a2';
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555502'), true, 'a cutoff write takes it too (the season guard)');
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555503'), false, 'control: nothing has taken organization three''s lock');
UPDATE public.divisions SET name = 'Lock U6 renamed' WHERE id = 'e5555555-5555-5555-5555-55555555d003';
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555503'), false, 'a write that moves no age takes no lock (a division with no window)');
UPDATE public.divisions SET birthdate_start = '2023-01-01', birthdate_end = '2024-07-31' WHERE id = 'e5555555-5555-5555-5555-55555555d003';
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555503'), true, 'and the write that gives it a window does');
-- A delete has no guard before it: the revision trigger takes the lock before it raises the revision.
INSERT INTO public.organizations (id, name, slug) VALUES ('e5555555-5555-5555-5555-555555555504', 'Lock Org Four', 'lock-org-four');
DELETE FROM public.season_settings WHERE organization_id = 'e5555555-5555-5555-5555-555555555504';
INSERT INTO public.season_settings (id, organization_id, name, status, season_year) VALUES
    ('e5555555-5555-5555-5555-5555555555a4', 'e5555555-5555-5555-5555-555555555504', 'Lock D', 'draft', 2030);
-- (Put the window-bearing division there with both triggers off, so the insert has not taken the lock.)
ALTER TABLE public.divisions DISABLE TRIGGER divisions_window_guard;
ALTER TABLE public.divisions DISABLE TRIGGER divisions_age_rule_revision;
INSERT INTO public.divisions (id, organization_id, season_settings_id, name, min_age, max_age, birthdate_start, birthdate_end) VALUES
    ('e5555555-5555-5555-5555-55555555d004', 'e5555555-5555-5555-5555-555555555504', 'e5555555-5555-5555-5555-5555555555a4', 'Lock U8', 8, 8, '2018-01-01', '2018-12-31');
ALTER TABLE public.divisions ENABLE TRIGGER divisions_window_guard;
ALTER TABLE public.divisions ENABLE TRIGGER divisions_age_rule_revision;
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555504'), false, 'control: organization four''s lock is not held');
DELETE FROM public.divisions WHERE id = 'e5555555-5555-5555-5555-55555555d004';
SELECT is(pg_temp.season_lock_held('e5555555-5555-5555-5555-555555555504'), true, 'deleting a window-bearing division takes it (the revision trigger)');

-- ── Grants ─────────────────────────────────────────────────────────────────
RESET role;
SELECT is(
    (SELECT array_agg(p.proname::text ORDER BY p.proname::text) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('admin_create_season_from', 'admin_update_draft_season', 'admin_set_division_birthdate_window', 'admin_activate_season')
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('public', p.oid, 'EXECUTE')),
    ARRAY['admin_activate_season', 'admin_create_season_from', 'admin_set_division_birthdate_window', 'admin_update_draft_season'],
    'the four writers are executable by signed-in users and by neither anon nor public');
SELECT is(
    (SELECT count(*)::int FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('season_settings_cutoff_guard', 'divisions_window_guard', 'season_rows_readonly_when_completed',
                          'rollover_division_columns', 'rollover_division_skipped_columns', 'rollover_season_columns', 'rollover_season_skipped_columns')
        AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))),
    0, 'and the trigger functions and catalogues are executable by neither');

-- ── The catalogue check can fail ───────────────────────────────────────────
ALTER TABLE public.divisions ADD COLUMN rollover_probe integer;
ALTER TABLE public.season_settings ADD COLUMN rollover_probe integer;
SELECT is(
    (SELECT array_agg(c.column_name::text) FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'divisions'
        AND NOT (c.column_name = ANY (public.rollover_division_columns() || public.rollover_division_skipped_columns()))),
    ARRAY['rollover_probe'], 'a divisions column nobody classified is found (the check above would fail)');
SELECT is(
    (SELECT array_agg(c.column_name::text) FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'season_settings'
        AND NOT (c.column_name = ANY (public.rollover_season_columns() || public.rollover_season_skipped_columns()))),
    ARRAY['rollover_probe'], 'and so is a season_settings column');

SELECT * FROM finish();
ROLLBACK;
