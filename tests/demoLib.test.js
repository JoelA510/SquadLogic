/**
 * The demo's client-side helpers (plan docs/changes/2026-10-22-demo-mode.md, D4): the clock's
 * formatting, how a refusal from `start_demo_session()` is worded, the hosted-service line's rule,
 * the result of the RPC read at the trust boundary, and the mock client's twin of the RPC.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: { rpc } }));

import {
  DemoStartError,
  canEditPlayerField,
  demoExpiryMs,
  demoStartFailure,
  formatTimeLeft,
  hostedSiteNotice,
  isDemoOrganization,
  spokenTimeLeft,
  startDemoSession,
} from '../frontend/src/lib/demo.js';
import { handleDemoRpc, makeAnonymousSession } from '../frontend/src/lib/mockDemo.js';
import { demoSeasonWindow, demoToday } from '../frontend/src/lib/demoSeasons.js';

describe('formatTimeLeft', () => {
  it.each([
    [30 * 60_000, '30:00'],
    [22 * 60_000 + 14_000, '22:14'],
    [60_000, '1:00'],
    [59_000, '0:59'],
    [1_000, '0:01'],
    [0, '0:00'],
    [-5_000, '0:00'],
  ])('%i ms is %s', (ms, text) => {
    expect(formatTimeLeft(ms)).toBe(text);
  });

  it('rounds a partial second up, so the clock never reads 0:00 before the demo ends', () => {
    expect(formatTimeLeft(400)).toBe('0:01');
    expect(formatTimeLeft(59_001)).toBe('1:00');
  });
});

describe('spokenTimeLeft', () => {
  it('says minutes, singular at one', () => {
    expect(spokenTimeLeft(5 * 60_000)).toBe('5 minutes');
    expect(spokenTimeLeft(60_000)).toBe('1 minute');
  });
});

describe('the organization row', () => {
  it('is a demo exactly when demo_expires_at is set', () => {
    expect(isDemoOrganization({ demo_expires_at: '2026-10-26T12:00:00Z' })).toBe(true);
    expect(isDemoOrganization({ demo_expires_at: null })).toBe(false);
    expect(isDemoOrganization({})).toBe(false);
    expect(isDemoOrganization(null)).toBe(false);
  });

  it('reads the expiry as epoch milliseconds, and null when it is absent or unreadable', () => {
    expect(demoExpiryMs({ demo_expires_at: '2026-10-26T12:00:00Z' })).toBe(
      Date.parse('2026-10-26T12:00:00Z')
    );
    expect(demoExpiryMs({ demo_expires_at: 'not a time' })).toBeNull();
    expect(demoExpiryMs({ demo_expires_at: null })).toBeNull();
    expect(demoExpiryMs(undefined)).toBeNull();
  });
});

describe('canEditPlayerField', () => {
  it('lets everything be edited outside a demo', () => {
    for (const field of ['first_name', 'last_name', 'gender', 'buddy_request', 'notes', 'status']) {
      expect(canEditPlayerField(false, field)).toBe(true);
    }
  });

  it("in a demo lets only the fields D3's fence lets through be edited", () => {
    for (const field of [
      'team_id',
      'division_id',
      'status',
      'rating',
      'years_played',
      'jersey_number',
      'willing_to_coach',
    ]) {
      expect(canEditPlayerField(true, field), field).toBe(true);
    }
    for (const field of [
      'first_name',
      'last_name',
      'preferred_name',
      'gender',
      'grade',
      'notes',
      'buddy_request',
      'play_up_requested',
      // Dropped by 20261118010000: nothing read or wrote it, and a column that no longer exists is not
      // editable in a demo (the fence's list no longer names it either).
      'placement_eligible',
    ]) {
      expect(canEditPlayerField(true, field), field).toBe(false);
    }
  });
});

/**
 * The browser's list of editable demo player fields is a second copy of the server fence's list
 * (`demo_fence_player_write`'s `c_allowed`, less `updated_at`, which the server stamps itself), and a column
 * list is a second copy of the schema: the dropped `placement_eligible` stayed on both for as long as nothing
 * compared them. This reads the newest migration that defines the function and the library's own source.
 */
describe('the browser copy of the demo fence list', () => {
  const listIn = (text, pattern) => {
    const match = pattern.exec(text);
    return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : null;
  };
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
  const newestFence = () => {
    let found = null;
    for (const file of readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
      if (!/CREATE (OR REPLACE )?FUNCTION public\.demo_fence_player_write\(\)/.test(sql)) continue;
      const names = listIn(sql, /c_allowed constant text\[\] := ARRAY\[([^\]]*)\]/);
      // A later definition without a list is not skipped: it is the newest, and the test says so.
      found = { file, names };
    }
    return found;
  };

  it('equals the newest server definition of the list, less updated_at', () => {
    const server = newestFence();
    expect(
      server,
      'a migration defining demo_fence_player_write with a c_allowed list'
    ).not.toBeNull();
    // The newest definition is the one that dropped the column, not the one that created the function.
    expect(server.file >= '20261118010000').toBe(true);
    expect(server.names, `${server.file} defines the fence with a c_allowed list`).not.toBeNull();
    const browser = listIn(
      readFileSync(path.join(repoRoot, 'frontend', 'src', 'lib', 'demo.js'), 'utf8'),
      /DEMO_EDITABLE_PLAYER_FIELDS = Object\.freeze\(\[([^\]]*)\]\)/
    );
    expect(browser, 'the list in demo.js').not.toBeNull();
    expect(server.names).toContain('updated_at');
    expect(server.names.filter((n) => n !== 'updated_at')).toEqual(browser);
    expect(browser.length).toBeGreaterThanOrEqual(7);
  });

  it('names no dropped column, and every name on it is editable in a demo', () => {
    const server = newestFence();
    expect(server.names).not.toBeNull();
    expect(server.names).not.toContain('placement_eligible');
    for (const name of server.names.filter((n) => n !== 'updated_at')) {
      expect(canEditPlayerField(true, name), name).toBe(true);
    }
  });
});

describe('hostedSiteNotice', () => {
  const HERE = 'https://selfhosted.example';

  it('is null without an official URL', () => {
    expect(hostedSiteNotice(undefined, HERE)).toBeNull();
    expect(hostedSiteNotice('', HERE)).toBeNull();
  });

  it('names the official deployment on any other origin', () => {
    expect(hostedSiteNotice('https://official.example/app', HERE)).toEqual({
      url: 'https://official.example/app',
      host: 'official.example',
    });
  });

  it('is null on the official origin itself, whatever path the URL carries', () => {
    expect(hostedSiteNotice('https://official.example/', 'https://official.example')).toBeNull();
    expect(
      hostedSiteNotice('https://official.example/some/page', 'https://official.example')
    ).toBeNull();
  });

  it('is not fooled by a look-alike origin', () => {
    expect(
      hostedSiteNotice('https://official.example', 'https://official.example.evil.test')
    ).not.toBeNull();
    expect(hostedSiteNotice('http://official.example', 'https://official.example')).not.toBeNull();
  });

  it('is null for something that is not an http(s) URL', () => {
    expect(hostedSiteNotice('javascript:alert(1)', HERE)).toBeNull();
    expect(hostedSiteNotice('not a url', HERE)).toBeNull();
  });
});

describe('demoStartFailure', () => {
  it('words the cap by its detail', () => {
    const failure = demoStartFailure({ code: 'P0001', details: 'demo_capacity', message: 'x' });
    expect(failure).toBeInstanceOf(DemoStartError);
    expect(failure.kind).toBe('capacity');
    expect(failure.message).toBe('The demo is busy right now. Try again in a few minutes.');
  });

  it('words the cap by the server message when no detail came through', () => {
    expect(
      demoStartFailure({ message: 'The demo is busy right now. Try again in a few minutes.' }).kind
    ).toBe('capacity');
  });

  it('words a signed-in account', () => {
    expect(
      demoStartFailure({ code: '42501', details: 'demo_requires_anonymous', message: 'x' }).kind
    ).toBe('not_anonymous');
  });

  it('words a season that is neither fall nor spring by its detail', () => {
    const failure = demoStartFailure({
      code: '22023',
      details: 'demo_season_unknown',
      message: 'x',
    });
    expect(failure.kind).toBe('unknown_season');
    expect(failure.message).toBe('Choose a fall or a spring season to start the demo.');
  });

  it.each([
    [{ message: 'Anonymous sign-ins are disabled', status: 422 }],
    [{ message: 'captcha verification process failed' }],
    [new Error('network')],
    [null],
    [undefined],
  ])('anything else is "could not be started" (%j)', (cause) => {
    const failure = demoStartFailure(cause);
    expect(failure.kind).toBe('unavailable');
    expect(failure.message).toBe('The demo could not be started. Try again in a few minutes.');
  });
});

describe('startDemoSession (the RPC result is checked, not trusted)', () => {
  beforeEach(() => rpc.mockReset());

  it('returns the organization, its expiry and whether it was already there', async () => {
    rpc.mockResolvedValue({
      data: { organization_id: 'org-1', expires_at: '2026-10-26T12:30:00Z', existing: true },
      error: null,
    });
    await expect(startDemoSession()).resolves.toEqual({
      organizationId: 'org-1',
      expiresAt: '2026-10-26T12:30:00Z',
      existing: true,
      season: null,
      seasonStart: null,
      seasonEnd: null,
    });
    // no choice: the call is the zero-argument one, which the server dates by the day
    expect(rpc).toHaveBeenCalledWith('start_demo_session');
  });

  it.each(['fall', 'spring'])(
    'asks for the %s by name and returns the dates the server used',
    async (season) => {
      rpc.mockResolvedValue({
        data: {
          organization_id: 'org-1',
          expires_at: '2026-10-26T12:30:00Z',
          existing: false,
          season,
          season_start: '2027-03-22',
          season_end: '2027-06-13',
        },
        error: null,
      });
      await expect(startDemoSession(/** @type {any} */ (season))).resolves.toEqual({
        organizationId: 'org-1',
        expiresAt: '2026-10-26T12:30:00Z',
        existing: false,
        season,
        seasonStart: '2027-03-22',
        seasonEnd: '2027-06-13',
      });
      expect(rpc).toHaveBeenCalledWith('start_demo_session', { p_season: season });
    }
  );

  it('sends a choice that is neither as it is, for the server to refuse (only null is "no choice")', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', details: 'demo_season_unknown', message: 'Unknown demo season' },
    });
    await expect(startDemoSession(/** @type {any} */ (''))).rejects.toMatchObject({
      kind: 'unknown_season',
    });
    expect(rpc).toHaveBeenCalledWith('start_demo_session', { p_season: '' });
    rpc.mockClear();
    await expect(startDemoSession(null)).rejects.toMatchObject({ kind: 'unknown_season' });
    expect(rpc).toHaveBeenCalledWith('start_demo_session');
  });

  it('refuses a result naming a season that is neither (the server is not trusted either)', async () => {
    rpc.mockResolvedValue({
      data: { organization_id: 'org-1', expires_at: '2026-10-26T12:30:00Z', season: 'summer' },
      error: null,
    });
    await expect(startDemoSession('fall')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it("words the server's refusal of a season that is neither", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '22023', details: 'demo_season_unknown', message: 'Unknown demo season' },
    });
    await expect(startDemoSession('fall')).rejects.toMatchObject({ kind: 'unknown_season' });
  });

  it.each([
    [null],
    [{}],
    [{ organization_id: 'org-1' }],
    [{ organization_id: 'org-1', expires_at: 'soon' }],
    [{ organization_id: '', expires_at: '2026-10-26T12:30:00Z' }],
  ])('refuses a malformed result (%j)', async (data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(startDemoSession()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('throws the worded refusal for a server error', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', details: 'demo_capacity' } });
    await expect(startDemoSession()).rejects.toMatchObject({ kind: 'capacity' });
  });
});

describe("the mock client's start_demo_session (the twin of migration 20261030010000)", () => {
  // 2 Nov 2026: the fall of 2026 (to 31 October) is over, so the spring of 2027 and the fall of 2027 are next
  const NOW = Date.parse('2026-11-02T12:00:00Z');
  let n = 0;
  const mockId = (prefix = '') => `${prefix}id-${++n}`;
  const anonymous = () => ({ session: makeAnonymousSession(mockId) });

  function start(db, ctx) {
    return handleDemoRpc(db, 'start_demo_session', { mockId, now: NOW, ...ctx });
  }

  it('ignores every other RPC', () => {
    expect(handleDemoRpc({}, 'get_something', { session: null, mockId })).toBeNull();
  });

  it('refuses a caller with no session, and a signed-in account', () => {
    expect(start({}, { session: null }).error.code).toBe('42501');
    const account = { session: { user: { id: 'u1', is_anonymous: false } } };
    expect(start({}, account).error).toMatchObject({
      code: '42501',
      details: 'demo_requires_anonymous',
    });
  });

  it('gives the visitor a Demo league that expires in 30 minutes, with them as its admin', () => {
    const db = {};
    const ctx = anonymous();
    const { data, error } = start(db, ctx);
    expect(error).toBeNull();
    expect(data.existing).toBe(false);
    expect(data.expires_at).toBe(new Date(NOW + 30 * 60_000).toISOString());
    const org = db.organizations.find((o) => o.id === data.organization_id);
    expect(org).toMatchObject({
      name: 'Demo league',
      is_onboarded: true,
      demo_owner: ctx.session.user.id,
      demo_expires_at: data.expires_at,
    });
    expect(db.organization_members).toContainEqual({
      organization_id: org.id,
      profile_id: ctx.session.user.id,
      role: 'admin',
    });
  });

  it('seeds two divisions: U4 practice-only with its four reserved sessions, 15 minutes apart', () => {
    const db = {};
    const { data } = start(db, anonymous());
    const divisions = db.divisions.filter((d) => d.organization_id === data.organization_id);
    expect(divisions.map((d) => [d.name, d.plays_games])).toEqual([
      ['U4', false],
      ['U10 Boys', true],
    ]);
    const u4 = divisions[0];
    const slots = db.practice_slots
      .filter((s) => s.division_id === u4.id)
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
    expect(slots.map((s) => `${s.start_time}-${s.end_time}`)).toEqual([
      '09:00-09:30',
      '09:45-10:15',
      '10:30-11:00',
      '11:15-11:45',
    ]);
    // Every player is on a team in the division of that team; every team has a lead coach.
    const players = db.players.filter((p) => p.organization_id === data.organization_id);
    expect(players).toHaveLength(16);
    for (const player of players) {
      const team = db.teams.find((t) => t.id === player.team_id);
      expect(team.division_id).toBe(player.division_id);
    }
    expect(
      db.team_coach_assignments.filter((a) => a.organization_id === data.organization_id)
    ).toHaveLength(4);
  });

  it("gives each division its practices a week and length, as the server's seed does", () => {
    const db = {};
    const { data } = start(db, anonymous());
    const divisions = db.divisions.filter((d) => d.organization_id === data.organization_id);
    // U4: its once-weekly 30-minute Saturday session; U5 to U12: two practices of 60 minutes.
    expect(divisions.map((d) => [d.name, d.practices_per_week, d.practice_minutes])).toEqual([
      ['U4', 1, 30],
      ['U10 Boys', 2, 60],
    ]);
    // every division has slots of exactly its length to use, the open ones on two weekdays
    const slots = db.practice_slots.filter((s) => s.organization_id === data.organization_id);
    const length = (slot) =>
      Number(slot.end_time.slice(0, 2)) * 60 +
      Number(slot.end_time.slice(3, 5)) -
      (Number(slot.start_time.slice(0, 2)) * 60 + Number(slot.start_time.slice(3, 5)));
    const u4 = divisions[0];
    expect(slots.filter((s) => s.division_id === u4.id).every((s) => length(s) === 30)).toBe(true);
    const open = slots.filter((s) => s.division_id === null);
    expect(open.every((s) => length(s) === 60)).toBe(true);
    expect(new Set(open.map((s) => s.day_of_week)).size).toBeGreaterThanOrEqual(2);
  });

  it('starts with the U4 cohorts scheduled and the U10 teams left for the auto-scheduler', () => {
    const db = {};
    const { data } = start(db, anonymous());
    const org = data.organization_id;
    const teams = db.teams.filter((t) => t.organization_id === org);
    const rows = db.practice_assignments.filter((a) => a.organization_id === org);
    const u4 = db.divisions.find((d) => d.organization_id === org && d.name === 'U4');
    const u4Teams = teams.filter((t) => t.division_id === u4.id);
    // The subject set is the roster: the U4 cohorts hold a practice each, no U10 team holds one.
    expect(new Set(rows.map((a) => a.team_id))).toEqual(new Set(u4Teams.map((t) => t.id)));
    expect(teams.length).toBeGreaterThan(u4Teams.length);
    const slotOf = (row) => db.practice_slots.find((s) => s.id === row.practice_slot_id);
    for (const row of rows) {
      expect(slotOf(row).division_id).toBe(u4.id);
      expect(row.day_of_week).toBe('sat');
      expect(row.effective_date_range).toMatch(/^\[\d{4}-\d\d-\d\d,\d{4}-\d\d-\d\d\)$/);
    }
    const run = db.scheduler_runs.find(
      (r) => r.organization_id === org && r.run_type === 'practice'
    );
    expect(run).toMatchObject({ status: 'completed' });
    expect(run.results.summary).toMatchObject({
      totalTeams: teams.length,
      assignedTeams: u4Teams.length,
      unassignedTeams: teams.length - u4Teams.length,
      assignmentsRead: rows.length,
    });
    expect(rows.every((a) => a.run_id === run.id)).toBe(true);
  });

  it('leaves the team run the pages read their teams from, holding every team and roster entry', () => {
    const db = {};
    const { data } = start(db, anonymous());
    // the team run, and (since 20261110010000) the completed practice run holding the seeded schedule
    const runs = db.scheduler_runs.filter(
      (run) => run.organization_id === data.organization_id && run.run_type === 'team'
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_type: 'team', status: 'completed' });
    const teams = Object.values(runs[0].results.teamsByDivision).flat();
    expect(teams).toHaveLength(4);
    expect(runs[0].results.team_players).toHaveLength(16);
    const ids = new Set(
      db.teams.filter((t) => t.organization_id === data.organization_id).map((t) => t.id)
    );
    expect(teams.every((team) => ids.has(team.id))).toBe(true);
  });

  it("returns the visitor's live demo instead of making another", () => {
    const db = {};
    const ctx = anonymous();
    const first = start(db, ctx).data;
    const again = start(db, ctx).data;
    expect(again).toEqual({ ...first, existing: true });
    expect(db.organizations).toHaveLength(1);
  });

  it('makes a new one once the visitor’s has ended', () => {
    const db = {};
    const ctx = anonymous();
    start(db, ctx);
    const later = handleDemoRpc(db, 'start_demo_session', {
      ...ctx,
      mockId,
      now: NOW + 31 * 60_000,
    });
    expect(later.data.existing).toBe(false);
    expect(db.organizations).toHaveLength(2);
  });

  it('refuses the eleventh live demo, by the server’s detail', () => {
    const db = {};
    for (let i = 0; i < 10; i += 1) expect(start(db, anonymous()).error).toBeNull();
    const refused = start(db, anonymous());
    expect(refused.data).toBeNull();
    expect(refused.error).toMatchObject({ code: 'P0001', details: 'demo_capacity' });
    expect(db.organizations).toHaveLength(10);
  });

  it('refuses with the cap on request (the E2E steps use it to show the failed entry page)', () => {
    const db = {};
    const refused = start(db, { ...anonymous(), failure: 'capacity' });
    expect(refused.error).toMatchObject({ code: 'P0001', details: 'demo_capacity' });
    expect(db.organizations ?? []).toHaveLength(0);
  });

  describe('the season choice (migrations 20261114010000 and, for the fall, 20261115010000)', () => {
    const seasonOf = (db, orgId) => db.season_settings.find((s) => s.organization_id === orgId);

    it.each([
      ['fall', 'Fall', 'Fall 2027', '2027-08-23', '2027-10-31', 70],
      ['spring', 'Spring', 'Spring 2027', '2027-03-22', '2027-06-13', 84],
    ])(
      'dates a demo in the %s: the season, its divisions and every practice',
      (choice, label, name, first, last, days) => {
        const db = {};
        const { data, error } = start(db, { ...anonymous(), params: { p_season: choice } });
        expect(error).toBeNull();
        expect(data).toMatchObject({ season: choice, season_start: first, season_end: last });
        const season = seasonOf(db, data.organization_id);
        expect(season).toMatchObject({
          name,
          season_label: label,
          season_year: 2027,
          season_start: first,
          season_end: last,
        });
        expect((Date.parse(last) - Date.parse(first)) / 86_400_000 + 1).toBe(days);
        const divisions = db.divisions.filter((d) => d.organization_id === data.organization_id);
        expect(divisions).toHaveLength(2);
        for (const division of divisions) {
          expect([division.season_start, division.season_end]).toEqual([first, last]);
        }
        // a Saturday cohort's practice is live from the season's first Saturday to its last day
        const rows = db.practice_assignments.filter(
          (a) => a.organization_id === data.organization_id
        );
        expect(rows.length).toBeGreaterThan(0);
        const firstSaturday = new Date(Date.parse(first) + 5 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const dayAfterEnd = new Date(Date.parse(last) + 86_400_000).toISOString().slice(0, 10);
        for (const row of rows) {
          expect(row.effective_date_range).toBe(`[${firstSaturday},${dayAfterEnd})`);
        }
      }
    );

    it('with no choice dates the demo in the window the date falls in, or else the next to begin', () => {
      // 2 Nov 2026: the fall has just ended (31 October), the spring of 2027 is next
      const autumn = start({}, anonymous());
      expect(autumn.data).toMatchObject({ season: 'spring', season_start: '2027-03-22' });
      // 26 Oct 2026, a week before it ends: the fall in progress, dated from its own Monday of 17 August
      const lateFall = handleDemoRpc({}, 'start_demo_session', {
        ...anonymous(),
        mockId,
        now: Date.parse('2026-10-26T12:00:00Z'),
      });
      expect(lateFall.data).toMatchObject({
        season: 'fall',
        season_start: '2026-08-17',
        season_end: '2026-10-31',
      });
      // in the middle of the fall window (it runs to 31 October)
      const db = {};
      const autumnDay = handleDemoRpc(db, 'start_demo_session', {
        ...anonymous(),
        mockId,
        now: Date.parse('2027-09-20T12:00:00Z'),
      });
      expect(autumnDay.data).toMatchObject({
        season: 'fall',
        season_start: '2027-08-23',
        season_end: '2027-10-31',
      });
      // and the same call made in the middle of the spring window is the spring, in progress
      const may = handleDemoRpc({}, 'start_demo_session', {
        ...anonymous(),
        mockId,
        now: Date.parse('2027-05-10T12:00:00Z'),
      });
      expect(may.data).toMatchObject({ season: 'spring', season_start: '2027-03-22' });
    });

    it('takes the day in the league’s zone, not UTC, for the instance it chooses', () => {
      // 02:00 UTC on 1 Nov 2027 is still the evening of 31 October (the fall's last day) in Pacific time
      const evening = handleDemoRpc({}, 'start_demo_session', {
        ...anonymous(),
        mockId,
        now: Date.parse('2027-11-01T02:00:00Z'),
        params: { p_season: 'fall' },
      });
      expect(evening.data.season_start).toBe('2027-08-23');
      expect(demoToday(Date.parse('2027-11-01T02:00:00Z'))).toBe('2027-10-31');
      const next = handleDemoRpc({}, 'start_demo_session', {
        ...anonymous(),
        mockId,
        now: Date.parse('2027-11-01T12:00:00Z'),
        params: { p_season: 'fall' },
      });
      expect(next.data.season_start).toBe('2028-08-21');
    });

    it.each([['summer'], ['Fall'], [' fall'], [''], [5], [['fall']]])(
      'refuses %j as the server does, before anything else, and leaves nothing behind',
      (choice) => {
        const db = {};
        const refused = start(db, { ...anonymous(), params: { p_season: choice } });
        expect(refused.data).toBeNull();
        expect(refused.error).toMatchObject({ code: '22023', details: 'demo_season_unknown' });
        expect(db.organizations ?? []).toHaveLength(0);
        // ahead of the cap, as the server's check is ahead of its lock
        const full = start(
          {},
          { ...anonymous(), failure: 'capacity', params: { p_season: choice } }
        );
        expect(full.error).toMatchObject({ details: 'demo_season_unknown' });
      }
    );

    it('still refuses a signed-in account first, whatever it chooses', () => {
      const account = { session: { user: { id: 'u1', is_anonymous: false } } };
      expect(start({}, { ...account, params: { p_season: 'summer' } }).error).toMatchObject({
        details: 'demo_requires_anonymous',
      });
    });

    it('treats an explicit null as no choice (the zero-argument call)', () => {
      const { data } = start({}, { ...anonymous(), params: { p_season: null } });
      expect(data.season).toBe(demoSeasonWindow(null, demoToday(NOW)).season);
    });

    it('returns the demo’s FIRST season by creation once its admin has started a next one', () => {
      const db = {};
      const ctx = anonymous();
      const first = start(db, { ...ctx, params: { p_season: 'fall' } }).data;
      const own = db.season_settings[0];
      // created later, and listed first in the table (the server's read has no order of its own)
      db.season_settings.unshift({
        ...own,
        id: 'a-later-season',
        name: 'Autumn 2028',
        season_label: null,
        season_start: '2028-01-10',
        season_end: '2028-03-26',
        created_at: new Date(Date.parse(own.created_at) + 60_000).toISOString(),
      });
      const again = start(db, { ...ctx, params: { p_season: 'spring' } }).data;
      expect(again).toEqual({ ...first, existing: true });
      expect(again.season).toBe('fall');
    });

    it('returns the visitor’s own demo in the season it was started in, whatever is asked now', () => {
      const db = {};
      const ctx = anonymous();
      const first = start(db, { ...ctx, params: { p_season: 'fall' } }).data;
      const again = start(db, { ...ctx, params: { p_season: 'spring' } }).data;
      expect(again).toEqual({ ...first, existing: true });
      expect(again.season).toBe('fall');
      expect(db.organizations).toHaveLength(1);
    });
  });

  it('honours a shortened lifespan (a test or E2E step may set one)', () => {
    const { data } = start({}, { ...anonymous(), lifespanMs: 6_000 });
    expect(data.expires_at).toBe(new Date(NOW + 6_000).toISOString());
  });
});
