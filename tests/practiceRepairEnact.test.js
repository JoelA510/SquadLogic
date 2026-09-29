// 8.6 3b PR 11c: the client half of enacting ONE practice repair
// recommendation (`frontend/src/utils/practiceRepairEnact.js`), the client
// `persistPracticeEnact`, and the mock client's twin of the wrapper RPC.
//
// docs/PHASE_8_6_PR11_ENACT_PLAN.md §6 witnesses 3, 4, 12, the client arm of
// 24, and the stale and "never retried" rules of §4. Every subject set is
// enumerated from the PRE-ENACT snapshot (`displacedFromRows` over the rows
// the fake client serves), never from what the flow returned.
//
// Synthetic rows only.
import { describe, it, expect, vi, afterEach } from 'vitest';

// The client module's own session read; every other call here takes the
// fake client explicitly.
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
  },
}));

import {
  ENACT_GATE,
  ENACT_PREVIEW_TEXT,
  enactGateOf,
  enactPlanOf,
  enactPracticeRecommendation,
  enactPromptOf,
} from '../frontend/src/utils/practiceRepairEnact.js';
import { openPracticeRepair } from '../frontend/src/utils/practiceRepairPanel.js';
import { loadPracticeRepairSnapshot } from '../frontend/src/hooks/usePracticeRepairSnapshot.js';
import {
  PRACTICE_SCHEDULE_STALE,
  persistPracticeEnact,
} from '../frontend/src/utils/practicePersistenceClient.js';
import { mockPracticeFingerprint } from '../frontend/src/lib/mockPracticeEnact.js';
import {
  D,
  F1,
  F2,
  RETIREMENT,
  SEASON,
  assignment,
  displacedFromRows,
  fieldsWith,
  requireExamined,
  rowsOf,
  slot,
  uuid,
} from './helpers/practiceEnactWorld.js';
import {
  ORG,
  enactDbOf,
  fakeClientOf,
  practiceRowsOf,
  sendThroughMock,
} from './helpers/practiceEnactDb.js';

const MAIN_SLOTS = [
  slot(501, F1, 'mon', '17:00', '18:00'),
  slot(502, F1, 'wed', '17:00', '18:00'),
  slot(503, F2, 'mon', '17:00', '18:00'),
  slot(504, F2, 'wed', '17:00', '18:00'),
  slot(505, F2, 'mon', '18:00', '19:00'),
  slot(506, F2, 'wed', '18:00', '19:00'),
];
const MAIN_ROWS = [assignment(601, 301, 501), assignment(602, 302, 502)];
const main = (extra = {}) => rowsOf({ slots: MAIN_SLOTS, assignments: MAIN_ROWS, ...extra });

/** The panel's session on the rows it opened with, and a call that enacts `id` on `db`. */
async function session(db, loss = RETIREMENT) {
  const log = [];
  const client = fakeClientOf(db, log);
  const read = await loadPracticeRepairSnapshot(client, {
    organizationId: ORG,
    seasonSettingsId: SEASON,
  });
  if (read.ok !== true) throw new Error('the fixture did not read');
  const opened = openPracticeRepair(read.rows, loss, { timeZone: null });
  const shownOf = (id) => opened.state.recommendations.find((r) => r.assignmentId === id);
  const promptOf = (id) =>
    enactPromptOf(opened.adapted, read.rows, enactPlanOf(opened.adapted, shownOf(id)));
  const enact = (id, send, overrides = /** @type {any} */ ({})) =>
    enactPracticeRecommendation({
      client,
      send,
      organizationId: ORG,
      seasonSettingsId: SEASON,
      loss,
      timeZone: null,
      state: opened.state,
      shown: shownOf(id),
      answer: { accepted: true },
      enactKey: uuid(990000 + Number(id.slice(-3))),
      ...overrides,
      // Built only when not given (a blackout has no one-entry split plan).
      shownPrompt: 'shownPrompt' in overrides ? overrides.shownPrompt : promptOf(id),
    });
  return { log, client, read, opened, enact, shownOf, promptOf };
}

/** `send` as the Edge would: the mock twin of the wrapper RPC, counted. */
const sendVia = (client) => vi.fn(sendThroughMock(client));

describe('enact UI :: the fixture exercises data', () => {
  it('displaces both series of F1, enumerated from the rows alone', () => {
    expect(requireExamined(displacedFromRows(main(), F1).length, 'displaced series')).toBe(2);
    // The vacuity plant: a retirement of ground nothing uses displaces nothing.
    expect(displacedFromRows(main(), uuid(299)).length).toBe(0);
    expect(() => requireExamined(0, 'displaced series')).toThrow('examined no');
  });
});

describe('enact UI :: 4, the fingerprint is read before any row', () => {
  it('logs the fingerprint RPC first, then every table', async () => {
    const { log } = await session(enactDbOf(main()));
    expect(log[0]).toBe('rpc:practice_schedule_fingerprint');
    expect(log.slice(1).length).toBeGreaterThanOrEqual(9);
    expect(log.slice(1).every((entry) => !entry.startsWith('rpc:'))).toBe(true);
  });

  it('fails the whole snapshot when the fingerprint is unreadable', async () => {
    const db = enactDbOf(main());
    const client = fakeClientOf(db, []);
    const broken = {
      ...client,
      rpc: () => Promise.resolve({ data: null, error: { message: 'no' } }),
    };
    const read = await loadPracticeRepairSnapshot(broken, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
    });
    expect(read.ok).toBe(false);
  });
});

describe('enact UI :: 3, the re-judge runs on a FRESH read', () => {
  it('sends the base fingerprint of the read made at Confirm, not the one the panel opened on', async () => {
    const db = enactDbOf(main());
    const s = await session(db);
    // Between open and Confirm, another admin's save touches a row: the
    // fingerprint changes, the recommendation does not.
    const openedPrint = mockPracticeFingerprint(db, SEASON);
    db.practice_assignments.find((a) => a.id === uuid(602)).source = 'manual';
    const freshPrint = mockPracticeFingerprint(db, SEASON);
    expect(freshPrint).not.toBe(openedPrint);
    const send = sendVia(s.client);
    const out = await s.enact(uuid(601), send);
    expect(out.status).toBe('enacted');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].payload.repair.baseFingerprint).toBe(freshPrint);
    expect(send.mock.calls[0][0].enact.base_fingerprint).toBe(freshPrint);
  });
});

describe('enact UI :: stale is loud, and the write is never retried', () => {
  it('a writer 409 is shown as stale after a fresh re-judge, with ONE send', async () => {
    const db = enactDbOf(main());
    const s = await session(db);
    const send = vi.fn(async () => ({
      status: 'stale',
      code: PRACTICE_SCHEDULE_STALE,
      message: 'changed',
    }));
    const before = practiceRowsOf(db);
    const reads = () => s.log.filter((e) => e === 'rpc:practice_schedule_fingerprint').length;
    const readsBefore = reads();
    const out = await s.enact(uuid(601), send);
    expect(out.status).toBe('stale');
    expect(out.why).toBe('writer-stale');
    expect(out.stillStands).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    // Re-judged on a fresh read after the 409 (two reads: Confirm's and the re-judge).
    expect(reads() - readsBefore).toBe(2);
    expect(practiceRowsOf(db)).toBe(before);
  });

  it('a changed recommendation sends nothing and says what it is now', async () => {
    const db = enactDbOf(main());
    const s = await session(db);
    const shown = s.shownOf(uuid(601));
    expect(shown.to).not.toBeNull();
    // Another team now holds the shown slot.
    const held = MAIN_SLOTS.find(
      (sl) =>
        sl.field_id === shown.to.surfaceId &&
        sl.day_of_week.toUpperCase() === shown.to.weekday &&
        sl.start_time === `${String(shown.to.startMinutes / 60).padStart(2, '0')}:00`
    );
    expect(held).toBeDefined();
    db.practice_assignments.push({
      ...assignment(699, 399, Number(held.id.slice(-3))),
      organization_id: ORG,
      assigned_via: 'auto',
    });
    db.teams.push({
      id: uuid(399),
      organization_id: ORG,
      division_id: db.divisions[0].id,
      name: 'Team 399',
    });
    const send = vi.fn();
    const out = await s.enact(uuid(601), send);
    expect(out.status).toBe('stale');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('enact UI :: 24 (client arm), an uncommitted retirement sends nothing', () => {
  it('refuses on the FRESH field row, while the loss prop claims a date', async () => {
    const db = enactDbOf(main({ fields: fieldsWith(null) }));
    const s = await session(db);
    const subjects = displacedFromRows(main(), F1);
    for (const id of subjects) {
      const send = vi.fn();
      const out = await s.enact(id, send);
      expect(RETIREMENT.field.effective_to).not.toBeNull();
      expect(out).toMatchObject({ status: 'refused', refusal: 'retirement-uncommitted' });
      expect(send).not.toHaveBeenCalled();
    }
    expect(requireExamined(subjects.length, 'series')).toBe(2);
  });

  it('refuses a retirement saved with another date', async () => {
    const db = enactDbOf(main({ fields: fieldsWith('2026-10-20') }));
    const s = await session(db);
    const send = vi.fn();
    const out = await s.enact(uuid(601), send);
    expect(out).toMatchObject({ status: 'refused', refusal: 'retirement-changed' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('enact UI :: 12, no blackout write in PR 11', () => {
  it('every blackout series-window gives no send, even with the button forced enabled', async () => {
    const loss = {
      kind: 'blackout',
      blackout: {
        id: uuid(701),
        field_id: F1,
        location_id: null,
        blackout_from: D,
        blackout_until: '2026-10-31',
        start_minutes: null,
        end_minutes: null,
        reason: 'maintenance',
      },
    };
    const db = enactDbOf(main({ fields: fieldsWith(null) }));
    const s = await session(db, loss);
    const subjects = displacedFromRows(main(), F1, D);
    for (const id of subjects) {
      const send = vi.fn();
      const out = await s.enact(id, send, { shownPrompt: { record: null } });
      expect(out.status).toBe('refused');
      expect(send).not.toHaveBeenCalled();
      // The button is disabled with the save refusal as its reason (Q1).
      const gate = enactGateOf({
        isAdmin: true,
        preview: false,
        rows: s.read.rows,
        loss,
        refusals: [
          { why: 'window-inside-row', text: 'the window lies inside its practice series' },
        ],
      });
      expect(gate).toMatchObject({ enabled: false, why: ENACT_GATE.BLACKOUT });
      expect(gate.text).toContain('the window lies inside its practice series');
    }
    expect(requireExamined(subjects.length, 'series-window')).toBe(2);
  });
});

describe('enact UI :: the gate on the rows the panel opened with', () => {
  it('disables every enact in the preview, and for a non-admin, with a visible reason', async () => {
    const committed = await session(enactDbOf(main()));
    const base = {
      isAdmin: true,
      preview: false,
      rows: committed.read.rows,
      loss: RETIREMENT,
      refusals: [],
    };
    expect(enactGateOf(base).enabled).toBe(true);
    expect(enactGateOf({ ...base, preview: true })).toEqual({
      enabled: false,
      why: ENACT_GATE.PREVIEW,
      text: ENACT_PREVIEW_TEXT,
    });
    expect(enactGateOf({ ...base, isAdmin: false }).why).toBe(ENACT_GATE.NOT_ADMIN);
    const uncommitted = await session(enactDbOf(main({ fields: fieldsWith(null) })));
    expect(enactGateOf({ ...base, rows: uncommitted.read.rows }).text).toBe(ENACT_PREVIEW_TEXT);
  });
});

describe('enact UI :: after success the season is read again and re-based', () => {
  it('enacts S, locks its new row, and releases nothing that still fits', async () => {
    const db = enactDbOf(main());
    const s = await session(db);
    const send = sendVia(s.client);
    const out = await s.enact(uuid(601), send);
    expect(out.status).toBe('enacted');
    expect(out.view.state.enacted).toEqual([uuid(601)]);
    expect(out.view.state.recommendations.map((r) => r.assignmentId)).toEqual([uuid(602)]);
    const added = db.practice_assignments.filter((a) => a.assigned_via === 'recommendation');
    expect(added).toHaveLength(1);
    expect(added[0].team_id).toBe(uuid(301));
    expect(db.practice_assignments.find((a) => a.id === uuid(601)).effective_date_range).toBe(
      '[2026-09-01,2026-10-14]'
    );
    const audit = db.audit_log.filter((r) => r.action === 'practice.recommendation_enacted');
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.cause.id).toBe(F1);
    // The same key again is idempotent: no second write set.
    const snapshot = practiceRowsOf(db);
    // The same body again: its base is stale now, and the key still wins.
    const body = send.mock.calls[0][0];
    const again = await s.client.rpc('enact_practice_recommendation', {
      run_data: { id: audit[0].metadata.enact_key, season_settings_id: SEASON },
      assignments: body.payload.assignmentRows,
      unlock: body.payload.repair.unlock,
      closes: body.payload.repair.closes,
      exceptions: body.payload.repair.exceptions,
      base_fingerprint: body.payload.repair.baseFingerprint,
      enact: body.enact,
    });
    expect(again.data.idempotent).toBe(true);
    expect(practiceRowsOf(db)).toBe(snapshot);
  });
});

describe('enact UI :: the mock twin of the wrapper RPC', () => {
  it('refuses a coach (42501), a blind call (22023) and a stale base (40001), writing nothing', async () => {
    const db = enactDbOf(main());
    const s = await session(db);
    const send = vi.fn(async (_body) => ({ status: 'success' }));
    await s.enact(uuid(601), send);
    const body = /** @type {any} */ (send.mock.calls[0][0]);
    const call = (over = {}) =>
      s.client.rpc('enact_practice_recommendation', {
        run_data: { id: body.runMetadata.runId, season_settings_id: SEASON },
        assignments: body.payload.assignmentRows,
        unlock: body.payload.repair.unlock,
        closes: body.payload.repair.closes,
        exceptions: body.payload.repair.exceptions,
        base_fingerprint: body.payload.repair.baseFingerprint,
        enact: body.enact,
        ...over,
      });
    const before = practiceRowsOf(db);
    expect((await call({ base_fingerprint: null })).error.code).toBe('22023');
    expect((await call({ unlock: [] })).error.message).toContain('is locked');
    db.practice_assignments[1].source = 'manual';
    expect((await call()).error.code).toBe('40001');
    db.practice_assignments[1].source = 'auto';
    db.fields.find((f) => f.id === F1).effective_to = null;
    expect((await call()).error.message).toContain('not committed');
    db.fields.find((f) => f.id === F1).effective_to = '2026-10-14';
    db.organization_members[0].role = 'coach';
    expect((await call()).error.code).toBe('42501');
    expect(practiceRowsOf(db)).toBe(before);
    expect(db.audit_log).toEqual([]);
  });
});

describe('enact UI :: persistPracticeEnact', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a 409 PRACTICE_SCHEDULE_STALE as stale after ONE request, and never retries', async () => {
    const spy = vi.fn(async (_url, _init) => ({
      ok: false,
      status: 409,
      json: async () => ({ status: 'stale', code: PRACTICE_SCHEDULE_STALE, message: 'changed' }),
    }));
    vi.stubGlobal('fetch', spy);
    try {
      const out = await persistPracticeEnact(
        {
          payload: { assignmentRows: [], repair: { unlock: [] } },
          enact: { enact_key: uuid(9) },
          runMetadata: { runId: uuid(9), seasonSettingsId: SEASON },
        },
        { mock: false }
      );
      expect(out).toEqual({ status: 'stale', code: PRACTICE_SCHEDULE_STALE, message: 'changed' });
      expect(spy).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(/** @type {any} */ (spy.mock.calls[0][1]).body);
      expect(sent.runMetadata.runId).toBe(uuid(9));
      expect(sent.enact.enact_key).toBe(uuid(9));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses to send under a run id that is not the enact key', async () => {
    await expect(
      persistPracticeEnact(
        /** @type {any} */ ({
          payload: {},
          enact: { enact_key: uuid(9) },
          runMetadata: { runId: uuid(8) },
        }),
        { mock: false }
      )
    ).rejects.toThrow('own enact key');
  });
});

describe('enact UI :: an outcome after the send is never reported as "nothing was sent"', () => {
  it('a written enact whose re-read fails is `enacted-unread`, carrying what it wrote', async () => {
    const db = enactDbOf(main());
    const s = await session(db);
    const base = s.client.rpc;
    let prints = 0;
    s.client.rpc = (name, params) => {
      if (name === 'practice_schedule_fingerprint' && (prints += 1) === 2) {
        return Promise.resolve({ data: null, error: { message: 'connection reset' } });
      }
      return base(name, params);
    };
    // Read #1 (Confirm) passes; the send lands; read #2 (after) fails.
    const out = await s.enact(uuid(601), vi.fn(sendThroughMock(s.client)));
    expect(out.status).toBe('enacted-unread');
    expect(out.written.new_rows).toHaveLength(1);
    expect(db.practice_assignments.filter((a) => a.assigned_via === 'recommendation')).toHaveLength(
      1
    );
  });

  it('a send that throws reports `sent: true`; a failed read before it reports `sent: false`', async () => {
    const s = await session(enactDbOf(main()));
    const thrown = await s.enact(
      uuid(601),
      vi.fn(async () => Promise.reject(new Error('offline')))
    );
    expect(thrown).toMatchObject({ status: 'error', sent: true, message: 'offline' });
    s.client.rpc = () => Promise.resolve({ data: null, error: { message: 'down' } });
    const unread = await s.enact(uuid(601), vi.fn());
    expect(unread).toMatchObject({ status: 'error', sent: false });
  });
});
