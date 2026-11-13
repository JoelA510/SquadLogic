// @vitest-environment node
/**
 * The reads behind the three schedule reports (PR 7 of the schedule expansion): venues, fields, divisions, teams,
 * coaches, the coaching assignments, game slots, practices, the TIME TBD list, one stored baseline and the schedule
 * audit log.
 *
 * What this file holds (lessons 90, 92, 93):
 * - the read is all or nothing: a table that fails, as an error answer AND as a rejected request, makes the whole
 *   read `{ ok: false }` naming that table, with no data, so no report is drawn over a partial league;
 * - the subject sets come from the registry rows read (the season's divisions, its teams, its coaches), not from
 *   the games: a team of another season is not in the league, a coach with no team is;
 * - the coach read selects a name and an id and nothing that reaches a person (data minimisation);
 * - practices are mapped to the shape the reports take from the rows the database returns;
 * - a stored baseline is re-checked on read (its digest), and one that fails the check is not compared against.
 */
import { describe, expect, it } from 'vitest';

import * as reads from '../frontend/src/utils/scheduleReportsRead.js';
import { PUBLICATION_REASON } from '../packages/core/src/publication/reasonCodes.js';
import {
  COACH_ASSIGNMENTS,
  ORG_ID,
  SEASON_ID,
  baselineRows,
  practiceRows,
  practices,
  savedGames,
  tbdRows,
} from './helpers/reportsWorld.js';

/** A query builder that answers like PostgREST's: every filter returns it, awaiting it gives the table's answer. */
function fakeClient({ tables = {}, failures = {}, rpcs = {}, rpcFailures = {} } = {}) {
  const calls = [];
  const answerFor = (table) => {
    const failure = failures[table];
    if (failure === 'reject') return Promise.reject(new Error(`network down reading ${table}`));
    if (failure) return Promise.resolve({ data: null, error: { message: failure } });
    return Promise.resolve({ data: tables[table] ?? [], error: null });
  };
  const client = {
    calls,
    from(table) {
      const call = { table, select: null, filters: [], ranges: [] };
      calls.push(call);
      const builder = {
        select(columns) {
          call.select = columns;
          return builder;
        },
        eq(column, value) {
          call.filters.push([column, value]);
          return builder;
        },
        order() {
          return builder;
        },
        range(from, to) {
          call.ranges.push([from, to]);
          return builder;
        },
        maybeSingle() {
          return answerFor(table).then(({ data, error }) => ({
            data: Array.isArray(data) ? (data[0] ?? null) : data,
            error,
          }));
        },
        then(resolve, reject) {
          // Past the first page there is nothing: a short first page is the end.
          const rows =
            call.ranges.length > 0 && call.ranges[0][0] > 0
              ? Promise.resolve({ data: [], error: null })
              : answerFor(table);
          return rows.then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name, args) {
      calls.push({ rpc: name, args });
      const failure = rpcFailures[name];
      if (failure === 'reject') return Promise.reject(new Error(`network down calling ${name}`));
      if (failure) return Promise.resolve({ data: null, error: { message: failure } });
      return Promise.resolve({ data: rpcs[name] ?? [], error: null });
    },
  };
  return client;
}

const { PRACTICE_READ_SELECT, practicesFromRows } = reads;
// The results are unions (`ok` selects an arm); the tests read both arms' fields on purpose.
const loadReportsReference =
  /** @type {(...args: Parameters<typeof reads.loadReportsReference>) => Promise<any>} */ (
    reads.loadReportsReference
  );
const loadScheduleAuditRows =
  /** @type {(...args: Parameters<typeof reads.loadScheduleAuditRows>) => Promise<any>} */ (
    reads.loadScheduleAuditRows
  );

const SEASON_TABLES = () => ({
  locations: [{ id: 'v-north', name: 'North Park' }],
  fields: [{ id: 'f-a1', name: 'Field A1', location_id: 'v-north' }],
  divisions: [
    { id: 'd-10', name: 'U10' },
    { id: 'd-12', name: 'U12' },
  ],
  teams: [
    { id: 't-1', name: 'Synthetic Comets', division_id: 'd-10' },
    { id: 't-4', name: 'Synthetic Planets', division_id: 'd-12' },
    // A team of another season: its division is not one of this season's.
    { id: 't-old', name: 'Synthetic Veterans', division_id: 'd-gone' },
  ],
  coaches: [
    { id: 'c-1', full_name: 'Alex Sample' },
    { id: 'c-9', full_name: 'Nobody Sample' },
  ],
  team_coach_assignments: [
    ...COACH_ASSIGNMENTS.filter((a) => ['t-1', 't-4'].includes(a.team_id)),
    {
      id: 'ca-old',
      team_id: 't-old',
      coach_id: 'c-1',
      role: 'lead',
      effective_from: '2025-08-01',
      effective_to: '2025-12-01',
    },
  ],
  game_slots: [
    { id: 's-1', week_index: 1 },
    { id: 's-2', week_index: 1 },
  ],
  practice_assignments: practiceRows().filter((p) => ['t-1', 't-4'].includes(p.team_id)),
});
const RPCS = () => ({ get_schedule_tbd: tbdRows() });
const params = { organizationId: ORG_ID, seasonSettingsId: SEASON_ID };
const TABLES = [
  'locations',
  'fields',
  'divisions',
  'teams',
  'coaches',
  'team_coach_assignments',
  'game_slots',
  'practice_assignments',
];

describe('loadReportsReference: the league the reports are built over', () => {
  it('reads every table and maps the rows to the shapes the reports take', async () => {
    const client = fakeClient({ tables: SEASON_TABLES(), rpcs: RPCS() });
    const result = await loadReportsReference(client, params);
    expect(result.ok).toBe(true);
    const { data } = result;
    expect(data.venues).toEqual([{ id: 'v-north', name: 'North Park' }]);
    expect(data.fields).toEqual([{ id: 'f-a1', name: 'Field A1', venueId: 'v-north' }]);
    expect(data.coaches).toEqual([
      { id: 'c-1', name: 'Alex Sample' },
      { id: 'c-9', name: 'Nobody Sample' },
    ]);
    expect(data.slots).toEqual([
      { id: 's-1', weekIndex: 1 },
      { id: 's-2', weekIndex: 1 },
    ]);
    expect(data.tbdGames).toEqual([
      {
        homeTeamId: 't-1',
        awayTeamId: 't-3',
        weekIndex: 2,
        reason: 'no-slot-available',
        gameDate: null,
      },
    ]);
  });

  it('M2 (20261122010000): uses the date and Game ID the RPC returns, and makes no second read', async () => {
    const [undated] = tbdRows();
    const rows = [
      { ...undated, game_date: null, external_ref: null },
      {
        ...undated,
        id: 'tbd-dated',
        home_team_id: 't-4',
        away_team_id: 't-5',
        week_index: 3,
        reason: 'imported-without-time',
        game_date: '2026-10-17',
        external_ref: 'N-7',
      },
    ];
    const tables = /** @type {Record<string, any>} */ (SEASON_TABLES());
    // A table that would give another answer: reading it would show.
    tables.schedule_tbd = [{ id: 'tbd-dated', game_date: '1999-01-01', external_ref: 'WRONG' }];
    const client = fakeClient({ tables, rpcs: { get_schedule_tbd: rows } });
    const result = await loadReportsReference(client, params);
    expect(result.ok).toBe(true);
    expect(result.data.tbdGames.map((g) => [g.homeTeamId, g.gameDate])).toEqual([
      ['t-1', null],
      ['t-4', '2026-10-17'],
    ]);
    expect(client.calls.some((c) => c.table === 'schedule_tbd')).toBe(false);
  });

  it('takes the teams of the season through its divisions, and names the division on each', async () => {
    const result = await loadReportsReference(
      fakeClient({ tables: SEASON_TABLES(), rpcs: RPCS() }),
      params
    );
    expect(result.data.teams).toEqual([
      {
        id: 't-1',
        name: 'Synthetic Comets',
        divisionId: 'd-10',
        division: 'U10',
        isExternal: false,
      },
      {
        id: 't-4',
        name: 'Synthetic Planets',
        divisionId: 'd-12',
        division: 'U12',
        isExternal: false,
      },
    ]);
  });

  it('keeps the coaching assignments of the season’s teams and drops those of other seasons', async () => {
    const result = await loadReportsReference(
      fakeClient({ tables: SEASON_TABLES(), rpcs: RPCS() }),
      params
    );
    expect(result.data.assignments.map((a) => a.id).sort()).toEqual([
      'ca-1',
      'ca-2',
      'ca-6',
      'ca-7',
    ]);
    expect(result.data.assignments.some((a) => a.team_id === 't-old')).toBe(false);
  });

  it('selects a coach’s id and name and nothing else: no email, no phone', async () => {
    const client = fakeClient({ tables: SEASON_TABLES(), rpcs: RPCS() });
    await loadReportsReference(client, params);
    const coachRead = client.calls.find((c) => c.table === 'coaches');
    expect(coachRead.select).toBe('id, full_name');
    expect(coachRead.filters).toContainEqual(['season_settings_id', SEASON_ID]);
    // No read selects a column that names a contact.
    for (const call of client.calls.filter((c) => c.select)) {
      expect(call.select).not.toMatch(/email|phone|contact|guardian/i);
    }
  });

  it('scopes each read to the organization (and the coaches and divisions to the season)', async () => {
    const client = fakeClient({ tables: SEASON_TABLES(), rpcs: RPCS() });
    await loadReportsReference(client, params);
    for (const table of TABLES) {
      const call = client.calls.find((c) => c.table === table);
      expect(call, table).toBeTruthy();
      expect(call.filters, table).toContainEqual(['organization_id', ORG_ID]);
    }
    const divisions = client.calls.find((c) => c.table === 'divisions');
    expect(divisions.filters).toContainEqual(['season_settings_id', SEASON_ID]);
    const tbd = client.calls.find((c) => c.rpc === 'get_schedule_tbd');
    expect(tbd.args).toEqual({ p_season_settings_id: SEASON_ID });
  });

  it('asks for the practices with their slot and field, by the hint the database needs', () => {
    expect(PRACTICE_READ_SELECT).toContain('slot:practice_slots!practice_slot_id');
    expect(PRACTICE_READ_SELECT).toContain('teams!inner(divisions!inner(season_settings_id))');
  });

  it.each(TABLES)(
    'is not ok, and names %s, when that table answers with an error',
    async (table) => {
      const client = fakeClient({
        tables: SEASON_TABLES(),
        rpcs: RPCS(),
        failures: { [table]: 'permission denied' },
      });
      const result = await loadReportsReference(client, params);
      expect(result.ok).toBe(false);
      expect(result.table).toBe(table);
      expect(result.message).toMatch(/permission denied/);
      expect(result.data).toBeUndefined();
    }
  );

  it.each(TABLES)(
    'is not ok, and names %s, when the request for that table is rejected',
    async (table) => {
      const client = fakeClient({
        tables: SEASON_TABLES(),
        rpcs: RPCS(),
        failures: { [table]: 'reject' },
      });
      const result = await loadReportsReference(client, params);
      expect(result.ok).toBe(false);
      expect(result.table).toBe(table);
      expect(result.data).toBeUndefined();
    }
  );

  it('is not ok, and names the TIME TBD list, when it cannot be read either way', async () => {
    for (const failure of ['denied', 'reject']) {
      const client = fakeClient({
        tables: SEASON_TABLES(),
        rpcs: RPCS(),
        rpcFailures: { get_schedule_tbd: failure },
      });
      const result = await loadReportsReference(client, params);
      expect(result.ok).toBe(false);
      expect(result.table).toBe('get_schedule_tbd');
    }
  });

  it('reads a slot with no week as no week, never as week 0 (a null is not a number)', async () => {
    const tables = /** @type {Record<string, any>} */ (SEASON_TABLES());
    tables.game_slots = [
      { id: 's-1', week_index: 1 },
      { id: 's-2', week_index: null },
      { id: 's-3', week_index: 0 },
      { id: 's-4', week_index: '4' },
      { id: 's-5', week_index: 2.5 },
    ];
    const result = await loadReportsReference(fakeClient({ tables, rpcs: RPCS() }), params);
    expect(result.data.slots).toEqual([
      { id: 's-1', weekIndex: 1 },
      { id: 's-2', weekIndex: null },
      { id: 's-3', weekIndex: null },
      { id: 's-4', weekIndex: 4 },
      { id: 's-5', weekIndex: null },
    ]);
  });

  describe('in two groups, so a report is not blocked by a read it does not use', () => {
    // `schedule_tbd` is the read that joins a TIME TBD game's date onto the list (F6 of PR 6).
    const LEAGUE = ['locations', 'fields', 'divisions', 'teams', 'game_slots'];
    const COACHES_GROUP = ['coaches', 'team_coach_assignments', 'practice_assignments'];
    const tablesRead = (client) =>
      [...new Set(client.calls.filter((c) => c.table).map((c) => c.table))].sort();

    it('the league group reads the venues, fields, divisions, teams, slots and the TIME TBD list, and no coach or practice', async () => {
      const client = fakeClient({ tables: SEASON_TABLES(), rpcs: RPCS() });
      const result = await loadReportsReference(client, params, { groups: ['league'] });
      expect(result.ok).toBe(true);
      expect(tablesRead(client)).toEqual([...LEAGUE].sort());
      expect(client.calls.some((c) => c.rpc === 'get_schedule_tbd')).toBe(true);
      expect(result.data.coaches).toEqual([]);
      expect(result.data.practices).toEqual([]);
      expect(result.data.teams.length).toBe(2);
    });

    it('the coaches group reads the coaches, the assignments and the practices, with the teams that scope them, and no TIME TBD list', async () => {
      const client = fakeClient({ tables: SEASON_TABLES(), rpcs: RPCS() });
      const result = await loadReportsReference(client, params, { groups: ['coaches'] });
      expect(result.ok).toBe(true);
      expect(tablesRead(client)).toEqual([...COACHES_GROUP, 'divisions', 'teams'].sort());
      expect(client.calls.some((c) => c.rpc)).toBe(false);
      expect(result.data.assignments.map((a) => a.id).sort()).toEqual([
        'ca-1',
        'ca-2',
        'ca-6',
        'ca-7',
      ]);
      expect(result.data.practices.length).toBe(3);
      expect(result.data.tbdGames).toEqual([]);
    });

    it.each(COACHES_GROUP)('a failure of %s does not fail the league group', async (table) => {
      const client = fakeClient({
        tables: SEASON_TABLES(),
        rpcs: RPCS(),
        failures: { [table]: 'denied' },
      });
      expect((await loadReportsReference(client, params, { groups: ['league'] })).ok).toBe(true);
      const failed = await loadReportsReference(client, params, { groups: ['coaches'] });
      expect(failed).toMatchObject({ ok: false, table });
    });

    it.each(['locations', 'fields', 'game_slots'])(
      'a failure of %s does not fail the coaches group',
      async (table) => {
        const client = fakeClient({
          tables: SEASON_TABLES(),
          rpcs: RPCS(),
          failures: { [table]: 'denied' },
        });
        expect((await loadReportsReference(client, params, { groups: ['coaches'] })).ok).toBe(true);
        expect(await loadReportsReference(client, params, { groups: ['league'] })).toMatchObject({
          ok: false,
          table,
        });
      }
    );

    it('refuses a group it does not know, rather than reading nothing and calling it a league', async () => {
      const result = await loadReportsReference(fakeClient(), params, {
        groups: /** @type {any} */ (['nonsense']),
      });
      expect(result.ok).toBe(false);
    });
  });

  it('refuses without an organization or a season, and without a client that can read', async () => {
    expect((await loadReportsReference(fakeClient(), { organizationId: ORG_ID })).ok).toBe(false);
    expect((await loadReportsReference(fakeClient(), { seasonSettingsId: SEASON_ID })).ok).toBe(
      false
    );
    expect((await loadReportsReference({}, params)).ok).toBe(false);
  });
});

describe('practicesFromRows', () => {
  it('maps the rows the database returns to the shape the reports take', () => {
    expect(practicesFromRows(practiceRows())).toEqual(practices());
  });

  it('keeps a practice whose slot is gone, with nothing guessed about when it is', () => {
    const [mapped] = practicesFromRows([
      { id: 'p-x', team_id: 't-1', effective_date_range: null, slot: null },
    ]);
    expect(mapped).toEqual({
      id: 'p-x',
      teamId: 't-1',
      range: null,
      dayOfWeek: null,
      startTime: null,
      endTime: null,
      validFrom: null,
      validUntil: null,
      fieldId: null,
      fieldName: null,
    });
  });

  it('reads a slot that comes back as a one-element list', () => {
    const [row] = practiceRows();
    const [mapped] = practicesFromRows([{ ...row, slot: [row.slot] }]);
    expect(mapped.dayOfWeek).toBe('tue');
  });
});

describe('changesBaselineFrom: a stored baseline, as the store hook read it', () => {
  const summary = {
    baselineVersion: 3,
    label: 'Week 1 files',
    recordedAt: '2026-10-02T12:00:00+00:00',
  };
  const snapshot = () => ({ rows: baselineRows(savedGames()) });

  it('gives the rows, the version, the label and when it was recorded', () => {
    const result = /** @type {any} */ (
      reads.changesBaselineFrom({ baseline: summary, snapshot: snapshot(), readFindings: [] })
    );
    expect(result.ok).toBe(true);
    expect(result.baseline).toMatchObject({
      version: 3,
      label: 'Week 1 files',
      recordedAt: '2026-10-02T12:00:00+00:00',
    });
    expect(result.baseline.rows).toHaveLength(baselineRows(savedGames()).length);
  });

  it('does not compare against a baseline whose rows no longer match their digest', () => {
    const findings = [{ code: PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH }];
    const result = /** @type {any} */ (
      reads.changesBaselineFrom({ baseline: summary, snapshot: snapshot(), readFindings: findings })
    );
    expect(result).toMatchObject({ ok: false, table: 'publication_baselines' });
    expect(result.message).toMatch(/integrity|digest/i);
    expect(result.baseline).toBeUndefined();
    // A finding that is not the digest's does not stop the comparison.
    const other = reads.changesBaselineFrom({
      baseline: summary,
      snapshot: snapshot(),
      readFindings: [{ code: 'SOMETHING_ELSE' }],
    });
    expect(other.ok).toBe(true);
  });

  it('does not compare against a baseline with no time it was recorded', () => {
    const result = /** @type {any} */ (
      reads.changesBaselineFrom({
        baseline: { ...summary, recordedAt: null },
        snapshot: snapshot(),
        readFindings: [],
      })
    );
    expect(result).toMatchObject({ ok: false, table: 'publication_baselines' });
  });
});

describe('loadScheduleAuditRows: the audit rows that name a game', () => {
  it('asks get_schedule_audit_log for the organization’s rows, up to its limit of 500', async () => {
    const client = fakeClient({ rpcs: { get_schedule_audit_log: [{ id: 'a-1' }] } });
    const result = await loadScheduleAuditRows(client, { organizationId: ORG_ID });
    expect(result).toEqual({ ok: true, rows: [{ id: 'a-1' }], limit: 500 });
    expect(client.calls.find((c) => c.rpc === 'get_schedule_audit_log').args).toEqual({
      p_organization_id: ORG_ID,
      p_assignment_id: null,
      p_limit: 500,
    });
  });

  it('names the audit log when it cannot be read, either way', async () => {
    for (const failure of ['denied', 'reject']) {
      const result = await loadScheduleAuditRows(
        fakeClient({ rpcFailures: { get_schedule_audit_log: failure } }),
        { organizationId: ORG_ID }
      );
      expect(result).toMatchObject({ ok: false, table: 'get_schedule_audit_log' });
    }
    const odd = await loadScheduleAuditRows(
      fakeClient({ rpcs: { get_schedule_audit_log: { not: 'a list' } } }),
      { organizationId: ORG_ID }
    );
    expect(odd).toMatchObject({ ok: false, table: 'get_schedule_audit_log' });
  });
});
