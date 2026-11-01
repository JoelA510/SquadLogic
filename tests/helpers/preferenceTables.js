/**
 * Shared fixtures for the practice preference screens' tests (Phase D C2): ids, a set of plain
 * tables (a season's coaches, teams, their rosters and practice series, and a few rules), and a
 * supabase-style query builder over them. The builder answers `eq`, `in`, `order` and `range`, and
 * returns only the filters it was asked for, so a screen that selects a column by name sees the
 * same rows a database would (LESSONS_LEARNED 60). A table named in `errors` answers with that error.
 */
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../../frontend/src/lib/mockSeedIds.js';

export const ORG = MOCK_ORG_ID;
// The mock client's own seed season: its active season is the one an import without a named season
// adds to, so the fixtures live in it.
export const SEASON = MOCK_SEASON_ID;
export const C1 = '11111111-1111-4111-8111-111111111111';
export const C3 = '33333333-3333-4333-8333-333333333333';
export const LAST = '44444444-4444-4444-8444-444444444444';
export const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
export const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
export const T3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
export const L1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
export const L2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

export const slot = (day, time) => ({
  day_of_week: day,
  start_time: time,
  field: { location_id: L1 },
});

/** A rule row as the store holds it. */
export const ruleRow = (over) => ({
  organization_id: ORG,
  coach_id: C1,
  team_id: T1,
  level: 'prefer',
  requested_level: 'prefer',
  must_decision: null,
  status: 'in_force',
  source: 'import',
  import_job_id: 'job-1',
  weekdays: null,
  start_minutes: null,
  venue_ids: null,
  keep_weekday: false,
  keep_start: false,
  keep_venue: false,
  coach_priority: null,
  effective_from: null,
  effective_to: null,
  created_at: '2026-09-20T10:00:00Z',
  decided_at: null,
  ...over,
});

/** Two current teams for C1 (T1 on Monday, T2 on Wednesday) and one ended (T3). */
export function freshTables() {
  return {
    // Coaches belong to one season (20261108010000): the page lists the season shown, 'season-1'.
    coaches: [
      {
        id: C1,
        organization_id: ORG,
        season_settings_id: SEASON,
        full_name: 'Casey Coach',
        email: 'casey@example.test',
      },
      {
        id: C3,
        organization_id: ORG,
        season_settings_id: SEASON,
        full_name: 'Robin Unassigned',
        email: 'robin@example.test',
      },
      {
        id: LAST,
        organization_id: ORG,
        season_settings_id: 'season-0',
        full_name: 'Last Season Coach',
        email: 'last@example.test',
      },
    ],
    locations: [
      { id: L1, organization_id: ORG, name: 'Riverside Park' },
      { id: L2, organization_id: ORG, name: 'North Fields' },
    ],
    divisions: [{ id: 'div-1', organization_id: ORG, season_settings_id: SEASON }],
    teams: [
      { id: T1, organization_id: ORG, name: 'U10 Hawks', division_id: 'div-1' },
      { id: T2, organization_id: ORG, name: 'U12 Owls', division_id: 'div-1' },
      { id: T3, organization_id: ORG, name: 'U8 Wrens', division_id: 'div-1' },
    ],
    team_coach_assignments: [
      {
        id: 'tca-1',
        organization_id: ORG,
        team_id: T1,
        coach_id: C1,
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: null,
      },
      {
        id: 'tca-2',
        organization_id: ORG,
        team_id: T2,
        coach_id: C1,
        role: 'assistant',
        effective_from: '2026-01-01',
        effective_to: null,
      },
      // Ended: T3 is not a current team, so its series must not be listed.
      {
        id: 'tca-3',
        organization_id: ORG,
        team_id: T3,
        coach_id: C1,
        role: 'lead',
        effective_from: '2026-01-01',
        effective_to: '2026-02-01',
      },
    ],
    practice_assignments: [
      {
        id: 'pa-1',
        organization_id: ORG,
        team_id: T1,
        effective_date_range: null,
        slot: slot('mon', '18:00:00'),
      },
      {
        id: 'pa-2',
        organization_id: ORG,
        team_id: T2,
        effective_date_range: null,
        slot: slot('wed', '18:00:00'),
      },
      {
        id: 'pa-3',
        organization_id: ORG,
        team_id: T3,
        effective_date_range: null,
        slot: slot('mon', '17:00:00'),
      },
    ],
    import_jobs: [
      {
        id: 'job-1',
        organization_id: ORG,
        storage_path: 'imports/user-admin/spring-prefs.csv',
        created_at: '2026-09-20T10:00:00Z',
      },
    ],
    coach_practice_preferences: [
      // A must the file asked for, in force as prefer until accepted.
      ruleRow({ id: 'r1', weekdays: ['WED'], requested_level: 'must', must_decision: 'pending' }),
      // A plain prefer in force.
      ruleRow({ id: 'r2', team_id: T2, venue_ids: [L1], created_at: '2026-09-19T10:00:00Z' }),
    ],
  };
}

/**
 * A `supabase.from` implementation over `tables`. `errors` maps a table name to the error its reads
 * answer with. `reads` (optional) records `[table, columns]` for each select.
 *
 * @param {Record<string, any[]>} tables
 * @param {Record<string, any>} errors
 * @param {Array<[string, string]>} [reads]
 */
export function makeFrom(tables, errors, reads = []) {
  return (table) => {
    const filters = [];
    let range = null;
    let columns = null;
    const run = () => {
      if (errors[table]) return { data: null, error: errors[table] };
      let rows = (tables[table] || []).filter((row) => filters.every((test) => test(row)));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (columns && columns !== '*' && !columns.includes('(')) {
        const wanted = columns.split(',').map((name) => name.trim());
        rows = rows.map((row) => Object.fromEntries(wanted.map((name) => [name, row[name]])));
      }
      return { data: rows, error: null };
    };
    const b = {
      select: (cols) => {
        columns = cols;
        reads.push([table, cols]);
        return b;
      },
      eq: (column, value) => {
        filters.push((row) => String(row[column]) === String(value));
        return b;
      },
      in: (column, values) => {
        filters.push((row) => values.map(String).includes(String(row[column])));
        return b;
      },
      order: () => b,
      range: (from, to) => {
        range = [from, to];
        return b;
      },
      then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
    };
    return b;
  };
}

/** The user the mock-client tests sign in as: an admin of ORG. */
export const ADMIN_USER = 'admin-user';

/**
 * The tables for the real mock client (`mockSupabase`), seeded into sessionStorage's `__MOCK_DB__`:
 * the page's tables with no rules and no import jobs, an active season, and an admin member. A test
 * that drives the import end to end through the mock's `create_import_job`, `import-validation` and
 * finalizer starts here.
 */
export function freshMockDb() {
  const base = freshTables();
  return {
    ...base,
    organization_members: [{ organization_id: ORG, profile_id: ADMIN_USER, role: 'admin' }],
    season_settings: [
      { id: SEASON, organization_id: ORG, status: 'active', name: 'Fall 2026' },
      { id: 'season-draft', organization_id: ORG, status: 'draft', name: 'Spring 2027' },
      { id: 'season-done', organization_id: ORG, status: 'completed', name: 'Spring 2026' },
    ],
    import_jobs: [],
    staging_import_rows: [],
    coach_practice_preferences: [],
    audit_log: [],
  };
}
