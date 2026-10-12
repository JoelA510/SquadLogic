/**
 * 8.6 3b PR 11d-2: the mock writer's blackout arm mirrors the wrapper's
 * (20261007000000, docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md §2.4, §6).
 *
 * Every subject set is enumerated from the SEEDED rows: the blackout's seven
 * stored columns, the season's practice rows, the one exception sent. The
 * SQL arm of the same guarantees is the smoke and the pgTAP file; this is
 * the E2E mock's twin, so 11d-3's E2E cannot pass against a mock the SQL
 * would refuse.
 *
 * Synthetic ids and names only.
 */
import { describe, expect, it } from 'vitest';

import {
  handlePracticeEnactRpc,
  mockPracticeFingerprint,
} from '../frontend/src/lib/mockPracticeEnact.js';

const U = (n) => `e1d20000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = U(1);
const ADMIN = U(2);
const SEASON = U(3);
const LOC = U(4);
const F1 = U(5);
const F2 = U(6);
const BLACKOUT = U(7);
const S = U(8);
const O = U(9);
const TUE1 = U(10);
const THU2 = U(11);
const WED1 = U(12);
const KEY = U(13);

function world() {
  return {
    season_settings: [{ id: SEASON, organization_id: ORG }],
    divisions: [{ id: U(20), organization_id: ORG, season_settings_id: SEASON }],
    teams: [
      { id: U(21), organization_id: ORG, division_id: U(20) },
      { id: U(22), organization_id: ORG, division_id: U(20) },
    ],
    fields: [
      { id: F1, organization_id: ORG, location_id: LOC },
      { id: F2, organization_id: ORG, location_id: LOC },
    ],
    practice_slots: [
      {
        id: TUE1,
        organization_id: ORG,
        field_id: F1,
        day_of_week: 'tue',
        start_time: '18:00',
        end_time: '19:30',
      },
      {
        id: THU2,
        organization_id: ORG,
        field_id: F2,
        day_of_week: 'thu',
        start_time: '18:00',
        end_time: '19:30',
      },
      {
        id: WED1,
        organization_id: ORG,
        field_id: F1,
        day_of_week: 'wed',
        start_time: '18:00',
        end_time: '19:30',
      },
    ],
    practice_assignments: [
      {
        id: S,
        organization_id: ORG,
        team_id: U(21),
        practice_slot_id: TUE1,
        effective_date_range: '[2026-09-01,2026-11-30]',
        source: 'auto',
        assigned_via: 'auto',
      },
      {
        id: O,
        organization_id: ORG,
        team_id: U(22),
        practice_slot_id: WED1,
        effective_date_range: '[2026-09-01,2026-11-30]',
        source: 'auto',
        assigned_via: 'auto',
      },
    ],
    field_blackouts: [
      {
        id: BLACKOUT,
        organization_id: ORG,
        field_id: F1,
        location_id: null,
        blackout_from: '2026-10-20',
        blackout_until: '2026-10-26',
        start_minutes: 1050,
        end_minutes: 1170,
        reason: 'maintenance',
      },
    ],
    practice_exceptions: [],
    audit_log: [],
  };
}

const ctx = {
  currentUserId: ADMIN,
  isOrgAdmin: (org) => org === ORG,
  newId: (() => {
    let n = 100;
    return () => U((n += 1));
  })(),
};

const STORED = {
  field_id: F1,
  location_id: null,
  blackout_from: '2026-10-20',
  blackout_until: '2026-10-26',
  start_minutes: 1050,
  end_minutes: 1170,
  reason: 'maintenance',
};
const EXCEPTION = {
  assignment_id: S,
  window: '[2026-10-20,2026-10-26]',
  kind: 'relocated',
  practice_slot_id: THU2,
  cause_kind: 'blackout',
  cause_id: BLACKOUT,
};

function params(db, edit = (p) => p) {
  const fp = mockPracticeFingerprint(db, SEASON);
  const assignments = db.practice_assignments.map((a) => ({
    team_id: a.team_id,
    practice_slot_id: a.practice_slot_id,
    effective_date_range: a.effective_date_range,
    source: a.source,
  }));
  return edit({
    run_data: { id: KEY, season_settings_id: SEASON },
    assignments,
    unlock: [],
    closes: [],
    exceptions: [{ ...EXCEPTION }],
    base_fingerprint: fp,
    enact: {
      enact_key: KEY,
      run_id: KEY,
      season_settings_id: SEASON,
      base_fingerprint: fp,
      cause: {
        kind: 'blackout',
        id: BLACKOUT,
        loss: {
          from: '2026-10-20',
          until: '2026-10-26',
          surface_ids: [F1],
          start_minutes: 1050,
          end_minutes: 1170,
          reason: 'maintenance',
        },
        stored: { ...STORED },
      },
      series: {
        assignment_id: S,
        team_id: U(21),
        window: { from: '2026-10-20', until: '2026-10-26' },
      },
      decision: {
        kind: 'relocate',
        to: { surface_id: F2, weekday: 'THU', start_minutes: 1080, duration_minutes: 90 },
        tbd_reason: null,
      },
      prompt: { rows: [], published_practices_affected: 1, accepted: true },
      unlock: [],
      writes: { closes: [], new_rows: [], exceptions: 1 },
    },
  });
}

const call = (db, p) => handlePracticeEnactRpc(db, 'enact_practice_recommendation', p, ctx);
const snapshot = (db) =>
  JSON.stringify([db.practice_assignments, db.practice_exceptions, db.audit_log]);

describe('the mock writer enacts a saved blackout as one exception on S (11d-2)', () => {
  it('writes exactly one exception on S, changes no row, and audits cause.stored as read', () => {
    const db = world();
    const rowsBefore = JSON.stringify(db.practice_assignments);
    const out = call(db, params(db));
    expect(out.error).toBeNull();
    expect(out.data).toMatchObject({
      enact_audited: true,
      idempotent: false,
      closed: [],
      unlocked: [],
    });
    expect(JSON.stringify(db.practice_assignments)).toBe(rowsBefore);
    expect(db.practice_exceptions).toHaveLength(1);
    expect(db.practice_exceptions[0]).toMatchObject({ ...EXCEPTION, withdrawn_at: null });
    const audits = db.audit_log.filter((a) => a.action === 'practice.recommendation_enacted');
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata.cause.stored).toEqual(STORED);
    expect(db.audit_log.filter((a) => a.action === 'practice.unlock_accepted')).toHaveLength(0);
    // The same key again is idempotent and writes nothing.
    const before = snapshot(db);
    const again = call(db, params(db));
    expect(again.error).toBeNull();
    expect(again.data.idempotent).toBe(true);
    expect(snapshot(db)).toBe(before);
  });

  it('refuses an unsaved blackout, and one stored differently in each of its seven columns', () => {
    const missing = world();
    missing.field_blackouts = [];
    expect(call(missing, params(missing)).error).toMatchObject({
      code: '22023',
      message: expect.stringContaining('is not saved'),
    });
    const changes = [
      { field_id: F2 },
      { field_id: null, location_id: LOC },
      { blackout_from: '2026-10-19' },
      { blackout_until: '2026-10-27' },
      { start_minutes: null, end_minutes: null },
      { end_minutes: 1140 },
      { reason: 'weather' },
    ];
    let refused = 0;
    for (const change of changes) {
      const db = world();
      Object.assign(db.field_blackouts[0], change);
      const before = snapshot(db);
      const out = call(db, params(db));
      expect(out.error, JSON.stringify(change)).toMatchObject({
        code: '22023',
        message: expect.stringContaining('changed'),
      });
      expect(snapshot(db)).toBe(before);
      refused += 1;
    }
    // Meta-assertion: every stored column was changed once, from the seed.
    expect(refused).toBe(Object.keys(STORED).length);
  });

  it('refuses surface_ids other than the blackout’s ground, and a location blackout missing a field', () => {
    const db = world();
    const wrong = call(
      db,
      params(db, (p) => {
        p.enact.cause.loss.surface_ids = [F2];
        return p;
      })
    );
    expect(wrong.error?.message).toContain('loss.surface_ids');
    const site = world();
    Object.assign(site.field_blackouts[0], { field_id: null, location_id: LOC });
    const siteParams = (surfaces) =>
      params(site, (p) => {
        p.enact.cause.stored = { ...STORED, field_id: null, location_id: LOC };
        p.enact.cause.loss.surface_ids = surfaces;
        return p;
      });
    expect(call(site, siteParams([F1])).error?.message).toContain('loss.surface_ids');
    expect(call(site, siteParams([F2, F1])).error).toBeNull();
  });

  it('refuses a write that is not exactly the one declared exception, and writes nothing', () => {
    /** @type {Array<[string, (p: any) => any]>} */
    const cases = [
      ['a close of S', (p) => ({ ...p, closes: [{ assignment_id: S, last_day: '2026-10-19' }] })],
      ['an unlock of S', (p) => ({ ...p, unlock: [{ assignment_id: S, reason: 'x' }] })],
      [
        'a new row',
        (p) => ({
          ...p,
          assignments: [
            ...p.assignments,
            {
              team_id: U(21),
              practice_slot_id: THU2,
              effective_date_range: '[2026-10-20,2026-10-26]',
              assigned_via: 'recommendation',
            },
          ],
        }),
      ],
      [
        'two exceptions',
        (p) => ({
          ...p,
          exceptions: [p.exceptions[0], { ...p.exceptions[0], window: '[2026-11-03,2026-11-03]' }],
        }),
      ],
      [
        'another window',
        (p) => ({ ...p, exceptions: [{ ...p.exceptions[0], window: '[2026-10-20,2026-10-27]' }] }),
      ],
      ['another cause', (p) => ({ ...p, exceptions: [{ ...p.exceptions[0], cause_id: U(99) }] })],
      [
        'a slot of another shape',
        (p) => ({ ...p, exceptions: [{ ...p.exceptions[0], practice_slot_id: WED1 }] }),
      ],
      [
        'a TIME TBD for a relocation',
        (p) => ({
          ...p,
          exceptions: [
            {
              ...p.exceptions[0],
              kind: 'time_tbd',
              practice_slot_id: null,
              tbd_reason: 'contended',
            },
          ],
        }),
      ],
      [
        'a re-home decision',
        (p) => ({ ...p, enact: { ...p.enact, decision: { ...p.enact.decision, kind: 'rehome' } } }),
      ],
      [
        'an unticked prompt',
        (p) => ({ ...p, enact: { ...p.enact, prompt: { ...p.enact.prompt, accepted: false } } }),
      ],
    ];
    for (const [name, edit] of cases) {
      const db = world();
      const before = snapshot(db);
      const out = call(db, edit(params(db)));
      expect(out.error?.code, name).toBe('22023');
      expect(snapshot(db), name).toBe(before);
    }
    expect(cases).toHaveLength(10);
  });

  it('enacts a TIME TBD with the decision’s reason', () => {
    const db = world();
    const out = call(
      db,
      params(db, (p) => {
        p.exceptions = [
          { ...EXCEPTION, kind: 'time_tbd', practice_slot_id: null, tbd_reason: 'contended' },
        ];
        p.enact.decision = { kind: 'time_tbd', to: null, tbd_reason: 'contended' };
        return p;
      })
    );
    expect(out.error).toBeNull();
    expect(db.practice_exceptions).toEqual([
      expect.objectContaining({
        assignment_id: S,
        kind: 'time_tbd',
        tbd_reason: 'contended',
        practice_slot_id: null,
      }),
    ]);
  });
});
