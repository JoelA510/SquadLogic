-- pgTAP: the demo league starts with its practices (migration 20261110010000; Phase D, F).
--
--   * each demo division copies the seed's practices a week and length: U4 one of 30 minutes, U5 to U12
--     two of 60, U14 and older two of 90; the demo has exactly one lit venue;
--   * a started demo has the U4 cohorts (once a week) and the U5 to U8 teams (twice a week, on two
--     different weekdays) on the schedule, 68 of 128 teams, and U9 and older on none (the
--     auto-scheduler's to place), under a completed `practice` run whose snapshot is counted from the
--     rows;
--   * U4 meets in the four 30-minute Saturday sessions reserved to it, one cohort at a time, at least 15
--     minutes apart, and nobody else is in a reserved slot (they stay practices);
--   * the schedule is legal: no slot over its capacity, each practice in a slot of its division's
--     length, no coach in two overlapping practices, Monday to Friday outside U4, and nothing on unlit
--     ground past 19:00;
--   * each row is live from its weekday's first date in the season to the season's last day;
--   * the demo's admin reads the rows through row level security, and another organization's admin reads
--     none of them;
--   * the TIME TBD list the Exports panel rebuilds lists the 60 teams of U9 and older (two missing
--     practices each, not scheduled yet) and none of U4 to U8;
--   * a seeded row that finds no slot refuses the start rather than leave a team without its practice.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(31);

INSERT INTO auth.users (id, email, raw_user_meta_data, aud, role, is_anonymous, created_at)
VALUES
    ('aaaaaaaa-0000-4000-8000-0000000000c1', NULL, '{"password_length": 12}', 'authenticated', 'authenticated', true, now()),
    ('aaaaaaaa-0000-4000-8000-0000000000c2', NULL, '{"password_length": 12}', 'authenticated', 'authenticated', true, now());

CREATE TEMP TABLE t_ids (name text PRIMARY KEY, id uuid) ON COMMIT DROP;
GRANT SELECT ON t_ids TO authenticated;

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated","is_anonymous":true}';
SELECT is(public.start_demo_session() ->> 'existing', 'false', 'an anonymous visitor starts a demo');
RESET role;
INSERT INTO t_ids SELECT 'demo', id FROM public.organizations WHERE demo_owner = 'aaaaaaaa-0000-4000-8000-0000000000c1';

-- The demo's own rows, with their slot, team and venue, for the checks below.
CREATE TEMP TABLE t_rows ON COMMIT DROP AS
SELECT pa.id, pa.team_id, t.name AS team, d.name AS division, d.practice_minutes, d.practices_per_week,
       ps.id AS slot_id, ps.capacity, ps.division_id AS slot_division,
       ps.day_of_week::text AS day, ps.start_time, ps.end_time, pa.effective_date_range AS range, pa.run_id,
       l.lighting_available AS lit
  FROM public.practice_assignments pa
  JOIN public.practice_slots ps ON ps.id = pa.practice_slot_id
  JOIN public.fields f ON f.id = ps.field_id
  JOIN public.locations l ON l.id = f.location_id
  JOIN public.teams t ON t.id = pa.team_id
  JOIN public.divisions d ON d.id = t.division_id
 WHERE pa.organization_id = (SELECT id FROM t_ids WHERE name = 'demo');
GRANT SELECT ON t_rows TO authenticated;

-- ── 1. each division's practices, and the lighting ───────────────────────────────
SELECT is(
    (SELECT array_agg(d.name || ':' || d.practices_per_week || 'x' || d.practice_minutes ORDER BY d.name COLLATE "C")
       FROM public.divisions d WHERE d.organization_id = (SELECT id FROM t_ids WHERE name = 'demo')),
    ARRAY['U10B:2x60', 'U10G:2x60', 'U12B:2x60', 'U12G:2x60', 'U14B:2x90', 'U14G:2x90', 'U16B:2x90', 'U16G:2x90',
          'U19B:2x90', 'U19G:2x90', 'U4:1x30', 'U5B:2x60', 'U5G:2x60', 'U6B:2x60', 'U6G:2x60', 'U7B:2x60',
          'U7G:2x60', 'U8B:2x60', 'U8G:2x60', 'U9B:2x60', 'U9G:2x60'],
    'every demo division has the owner''s practices a week and length, copied from the seed');
SELECT is(
    (SELECT array_agg(l.name) FROM public.locations l
      WHERE l.organization_id = (SELECT id FROM t_ids WHERE name = 'demo') AND l.lighting_available),
    ARRAY['Eastgate Sports Complex'],
    'the demo has exactly one lit venue');
SELECT is(
    (SELECT count(*)::int FROM public.practice_slots ps
       JOIN public.fields f ON f.id = ps.field_id JOIN public.locations l ON l.id = f.location_id
      WHERE ps.organization_id = (SELECT id FROM t_ids WHERE name = 'demo') AND NOT l.lighting_available
        AND ps.end_time > time '19:00'),
    0,
    'no slot on unlit ground ends after 19:00');
SELECT is(
    (SELECT count(*)::int FROM public.practice_slots ps
       JOIN public.fields f ON f.id = ps.field_id JOIN public.locations l ON l.id = f.location_id
      WHERE ps.organization_id = (SELECT id FROM t_ids WHERE name = 'demo') AND l.lighting_available
        AND ps.end_time > time '19:00'),
    10,
    'control: the lit ground does run past 19:00 (the 19:00 slot, two halves, five weekdays), so the check above could fail');

-- ── 2. who practises ───────────────────────────────────────────────────────
SELECT is(
    (SELECT array[count(*), count(DISTINCT team_id)] FROM t_rows),
    ARRAY[(SELECT count(*) FROM demo_seed.practice_schedule), 68]::bigint[],
    'every seeded row became an assignment, on 68 teams');
SELECT is(
    (SELECT array[count(*) FILTER (WHERE r.n = 1 AND r.division = 'U4'),
                  count(*) FILTER (WHERE r.n = 2 AND r.division <> 'U4'),
                  count(*) FILTER (WHERE r.n = 0)]
       FROM (SELECT t.id, d.name AS division, (SELECT count(*) FROM t_rows x WHERE x.team_id = t.id) AS n
               FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
              WHERE t.organization_id = (SELECT id FROM t_ids WHERE name = 'demo')) r),
    ARRAY[4, 64, 60]::bigint[],
    'the 4 U4 cohorts practise once, the 64 teams of U5 to U8 twice, and the 60 of U9 and older have no practice yet');
SELECT is(
    (SELECT count(*)::int FROM (SELECT team_id FROM t_rows GROUP BY team_id
                                 HAVING count(DISTINCT day) <> count(*)) same_day),
    0,
    'no team has two practices on one weekday');
SELECT is(
    (SELECT count(*)::int FROM t_rows WHERE regexp_replace(division, '[^0-9]', '', 'g')::int > 8),
    0,
    'no team of U9 or older has a practice');
SELECT is(
    (SELECT count(*)::int FROM t_rows r
      WHERE r.practices_per_week IS DISTINCT FROM CASE WHEN r.division = 'U4' THEN 1 ELSE 2 END),
    0,
    'every practiced division''s count is the owner''s (the rows are judged against what the division says)');

-- ── 3. U4 ────────────────────────────────────────────────────────────────────
SELECT is(
    (SELECT array_agg(end_time - start_time ORDER BY start_time) FROM t_rows WHERE division = 'U4'),
    ARRAY[interval '30 minutes', interval '30 minutes', interval '30 minutes', interval '30 minutes'],
    'the four U4 cohorts each meet once, for 30 minutes');
SELECT is(
    (SELECT count(*)::int FROM t_rows r
      WHERE (r.division = 'U4') <> (r.slot_division = (SELECT id FROM public.divisions WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demo') AND name = 'U4'))),
    0,
    'U4 meets only in the sessions reserved to it, and no other division is in one');
SELECT cmp_ok(
    (SELECT CASE WHEN count(gap) = 3 THEN min(gap) END
       FROM (SELECT start_time - lag(end_time) OVER (ORDER BY start_time) AS gap FROM t_rows WHERE division = 'U4') g),
    '>=', interval '15 minutes',
    'U4 sessions follow one another, one cohort at a time, with at least 15 minutes between each (three gaps)');
SELECT is(
    (SELECT count(DISTINCT (day, start_time))::int FROM t_rows WHERE division = 'U4'),
    4,
    'no two U4 cohorts share a session');
SELECT is(
    (SELECT array_agg(DISTINCT day) FROM t_rows WHERE division = 'U4'),
    ARRAY['sat'],
    'U4 meets on Saturday');

-- ── 4. a legal schedule ──────────────────────────────────────────────────────
SELECT is(
    (SELECT count(*)::int FROM (SELECT 1 FROM t_rows GROUP BY slot_id, capacity HAVING count(*) > capacity) over_full),
    0,
    'no slot holds more teams than its capacity');
SELECT is(
    (SELECT count(*)::int FROM t_rows WHERE extract(epoch FROM end_time - start_time) / 60 <> practice_minutes),
    0,
    'every practice is in a slot of exactly its division''s length');
SELECT is(
    (SELECT count(*)::int FROM t_rows
      WHERE division <> 'U4' AND (day NOT IN ('mon', 'tue', 'wed', 'thu', 'fri') OR start_time < time '16:00')),
    0,
    'the open-slot practices are Monday to Friday, from 16:00');
SELECT is(
    (SELECT count(*)::int FROM t_rows WHERE NOT lit AND end_time > time '19:00'),
    0,
    'no practice on unlit ground ends after 19:00');
SELECT is(
    (SELECT count(*)::int FROM t_rows a
      JOIN public.team_coach_assignments ca ON ca.team_id = a.team_id
      JOIN public.team_coach_assignments cb ON cb.coach_id = ca.coach_id
      JOIN t_rows b ON b.team_id = cb.team_id AND b.id > a.id
     WHERE a.day = b.day AND a.start_time < b.end_time AND b.start_time < a.end_time),
    0,
    'no coach is in two overlapping practices');
SELECT cmp_ok(
    (SELECT count(*)::int FROM public.team_coach_assignments ca JOIN t_rows a ON a.team_id = ca.team_id),
    '>', 0,
    'the coach check examined coaches joined to practices (it is not a statement about an empty set)');

-- ── 5. dating ────────────────────────────────────────────────────────────────
SELECT is(
    (SELECT count(*)::int FROM t_rows r, public.season_settings s
      WHERE s.organization_id = (SELECT id FROM t_ids WHERE name = 'demo')
        AND (lower(r.range) <> s.season_start + (array_position(ARRAY['mon','tue','wed','thu','fri','sat','sun'], r.day) - 1)
             OR upper(r.range) <> s.season_end + 1)),
    0,
    'every row is live from its weekday''s first date in the season to the last day');

-- ── 6. the run ───────────────────────────────────────────────────────────────
SELECT is(
    (SELECT array[(results -> 'summary' ->> 'totalTeams')::bigint, (results -> 'summary' ->> 'assignedTeams')::bigint,
                  (results -> 'summary' ->> 'unassignedTeams')::bigint, (results -> 'summary' ->> 'assignmentsRead')::bigint]
       FROM public.scheduler_runs
      WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demo') AND run_type = 'practice' AND status = 'completed'),
    ARRAY[128, 68, 60, (SELECT count(*) FROM t_rows)]::bigint[],
    'one completed practice run, its snapshot counted from the rows');

-- ── 7. who reads them ────────────────────────────────────────────────────────
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c1","role":"authenticated","is_anonymous":true}';
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments),
    (SELECT count(*)::int FROM t_rows),
    'the demo''s admin reads every practice through row level security');

-- ── 8. TIME TBD: what the Exports panel then lists ──────────────────────────────
SELECT is(
    (public.refresh_schedule_tbd_practices(
        (SELECT id FROM public.season_settings WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demo'))) ->> 'changed')::boolean,
    true,
    'the first refresh of a demo''s TIME TBD list changes it (the demo starts with none stored)');
SELECT is(
    (SELECT array[count(*), count(DISTINCT e ->> 'team_id'), sum((e ->> 'missing_count')::int)]
       FROM jsonb_array_elements(public.get_schedule_tbd(
              (SELECT id FROM public.season_settings WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demo')))) e
      WHERE e ->> 'kind' = 'practice'),
    ARRAY[60, 60, 120]::bigint[],
    'the list holds the 60 teams of U9 and older, two missing practices each, and the 120 practices the visitor is to place');
SELECT is(
    (SELECT array_agg(DISTINCT e ->> 'reason')
       FROM jsonb_array_elements(public.get_schedule_tbd(
              (SELECT id FROM public.season_settings WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demo')))) e),
    ARRAY['not-scheduled-yet'],
    'every one of them is not scheduled yet: the visitor has not run the auto-scheduler');
RESET role;
SELECT is(
    (SELECT count(*)::int FROM public.schedule_tbd s
       JOIN public.teams t ON t.id = s.team_id JOIN public.divisions d ON d.id = t.division_id
      WHERE s.organization_id = (SELECT id FROM t_ids WHERE name = 'demo')
        AND regexp_replace(d.name, '[^0-9]', '', 'g')::int <= 8),
    0,
    'no team of U4 to U8 is on the TIME TBD list');
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT is(
    (SELECT count(*)::int FROM public.practice_assignments WHERE organization_id = (SELECT id FROM t_ids WHERE name = 'demo')),
    0,
    'another organization''s admin reads none of the demo''s practices');
RESET role;

-- ── 9. a row with no slot refuses the start ──────────────────────────────────
UPDATE demo_seed.practice_schedule SET start_time = time '03:00' WHERE id = (SELECT min(id) FROM demo_seed.practice_schedule);
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"aaaaaaaa-0000-4000-8000-0000000000c2","role":"authenticated","is_anonymous":true}';
SELECT throws_like(
    $$ SELECT public.start_demo_session() $$,
    'The demo league''s practice schedule did not match its slots%',
    'a seeded row that finds no slot refuses the start');
RESET role;
SELECT is(
    (SELECT count(*)::int FROM public.organizations WHERE demo_owner = 'aaaaaaaa-0000-4000-8000-0000000000c2'),
    0,
    'the refused start left no demo behind');

SELECT * FROM finish();
ROLLBACK;
