// 8.6 3b PR 11d-3: enacting a blackout recommendation, the client half
// (`frontend/src/utils/practiceRepairEnact.js`) and the enact counts
// (`frontend/src/utils/practiceEnactCount.js`).
//
// docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md §5 witnesses B8 (client: the
// gate on the panel's rows and on the fresh read), B13 (client: the dialog's
// count) and B14 (the un-retire count ignores blackout enacts), plus the Q11
// blackout count and the Q4 write shape (one exception, no unlock). Every
// subject set is enumerated from the SEEDED rows (`displacedFromRows`, the
// stored blackout's own columns, the seeded audit rows), never from what the
// flow returned.
//
// Synthetic rows only.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
  },
}));

import {
  ENACT_BLACKOUT_PREVIEW_TEXT,
  ENACT_GATE,
  ENACT_REFUSAL_TEXT,
  enactGateOf,
  enactPlanOf,
  enactPracticeRecommendation,
  enactPromptOf,
  enactedRowsOf,
} from '../frontend/src/utils/practiceRepairEnact.js';
import { namesOf, openPracticeRepair } from '../frontend/src/utils/practiceRepairPanel.js';
import { loadPracticeRepairSnapshot } from '../frontend/src/hooks/usePracticeRepairSnapshot.js';
import {
  countSeriesEnactedOff,
  countSeriesEnactedOffBlackout,
} from '../frontend/src/utils/practiceEnactCount.js';
import { PRACTICE_ENACT_REFUSAL } from '../packages/core/src/practice/index.js';
import {
  F1,
  F2,
  LOC_A,
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

const SLOTS = [
  slot(501, F1, 'mon', '17:00', '18:00'),
  slot(502, F1, 'wed', '17:00', '18:00'),
  slot(503, F2, 'mon', '17:00', '18:00'),
  slot(504, F2, 'wed', '17:00', '18:00'),
  // A length no other slot offers: its series goes TIME TBD.
  slot(505, F1, 'mon', '18:00', '19:30'),
];
const ROWS = [assignment(601, 301, 501), assignment(602, 302, 502), assignment(603, 303, 505)];
const RANGE_LAST = '2026-11-30'; // RANGE is [2026-09-01,2026-12-01)

/** The stored blackout, in `field_blackouts` columns: two weeks on F1, all day. */
const STORED = Object.freeze({
  id: uuid(701),
  field_id: F1,
  location_id: null,
  blackout_from: '2026-10-19',
  blackout_until: '2026-11-01',
  start_minutes: null,
  end_minutes: null,
  reason: 'maintenance',
});
const LOSS = { kind: 'blackout', blackout: { ...STORED } };

/** The view row the loader reads (`field_closures`), and the table row the mock gate reads. */
function viewRowOf(stored) {
  return {
    id: stored.id,
    source: 'field_blackouts',
    closes_field_id: stored.field_id,
    closes_location_id: stored.location_id,
    blackout_from: stored.blackout_from,
    blackout_until: stored.blackout_until,
    start_minutes: stored.start_minutes,
    end_minutes: stored.end_minutes,
    reason: stored.reason,
  };
}

/** The season with the blackout SAVED as `stored` (or not saved at all: `null`). */
function seeded(stored = STORED) {
  const rows = rowsOf({ slots: SLOTS, assignments: ROWS, fields: fieldsWith(null) });
  rows.fieldClosures = stored ? [viewRowOf(stored)] : [];
  const db = enactDbOf(rows);
  db.field_blackouts = stored ? [{ ...stored, organization_id: ORG }] : [];
  return { rows, db };
}

/** Weekday occurrences in [from, until], day by day (independent of the core expander). */
function occurrences(from, until, day) {
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += 864e5) {
    if (names[new Date(t).getUTCDay()] === day) n += 1;
  }
  return n;
}

/** The series the blackout displaces, from the rows alone: on F1, a weekday inside the window. */
function displacedByBlackout(rows) {
  return displacedFromRows(rows, F1, STORED.blackout_from).filter((id) => {
    const row = ROWS.find((r) => r.id === id);
    const day = SLOTS.find((s) => s.id === row.practice_slot_id).day_of_week;
    return occurrences(STORED.blackout_from, STORED.blackout_until, day) > 0;
  });
}

async function session(db, loss = LOSS) {
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
  const enact = (id, send, overrides = {}) =>
    enactPracticeRecommendation({
      client,
      send,
      organizationId: ORG,
      seasonSettingsId: SEASON,
      loss,
      timeZone: null,
      state: opened.state,
      shown: shownOf(id),
      shownPrompt: promptOf(id),
      answer: { accepted: true },
      enactKey: uuid(990000 + Number(id.slice(-3))),
      ...overrides,
    });
  return { log, client, read, opened, enact, shownOf, promptOf };
}

describe('blackout enact UI :: the fixture exercises data', () => {
  it('displaces all three F1 series in the window, enumerated from the rows alone', () => {
    const { rows } = seeded();
    expect(requireExamined(displacedByBlackout(rows).length, 'displaced series')).toBe(3);
    // The meta-plant: the same blackout moved off every series displaces nothing.
    expect(displacedFromRows(rows, uuid(299), STORED.blackout_from)).toEqual([]);
    expect(() => requireExamined(0, 'displaced series')).toThrow('examined no');
  });

  it('opens with both a relocation and a TIME TBD among the recommendations', async () => {
    const s = await session(seeded().db);
    const kinds = new Set(s.opened.state.recommendations.map((r) => (r.to ? 'move' : 'tbd')));
    expect([...kinds].sort()).toEqual(['move', 'tbd']);
  });
});

describe('blackout enact UI :: B8 (client), only a saved blackout, as saved, is enacted', () => {
  const gateOf = (rows, loss = LOSS, preview = false) =>
    enactGateOf({ isAdmin: true, preview, rows, loss, refusals: [] });

  it('enables Enact on the stored row unchanged (the control)', async () => {
    const s = await session(seeded().db);
    expect(gateOf(s.read.rows)).toEqual({ enabled: true, why: null, text: null });
  });

  it('disables every Enact in the editor preview, even when the draft equals the stored row', async () => {
    const s = await session(seeded().db);
    expect(gateOf(s.read.rows, LOSS, true)).toEqual({
      enabled: false,
      why: ENACT_GATE.PREVIEW,
      text: ENACT_BLACKOUT_PREVIEW_TEXT,
    });
  });

  it('refuses the draft id, and a blackout the fresh read does not hold, as not saved', async () => {
    const saved = await session(seeded().db);
    const draft = { kind: 'blackout', blackout: { ...STORED, id: 'draft' } };
    expect(gateOf(saved.read.rows, draft)).toMatchObject({
      enabled: false,
      why: ENACT_GATE.PREVIEW,
      text: ENACT_BLACKOUT_PREVIEW_TEXT,
    });
    const unsaved = await session(seeded(null).db);
    expect(gateOf(unsaved.read.rows)).toMatchObject({ enabled: false, why: ENACT_GATE.PREVIEW });
  });

  // Every stored column, enumerated from the stored row itself (not from the gate).
  const CHANGES = {
    field_id: F2,
    location_id: LOC_A,
    blackout_from: '2026-10-20',
    blackout_until: '2026-10-31',
    start_minutes: 1020,
    end_minutes: 1140,
    reason: 'weather',
  };
  it('names every stored column that can change', () => {
    const columns = Object.keys(STORED).filter((k) => k !== 'id');
    expect(Object.keys(CHANGES).sort()).toEqual(columns.sort());
    expect(requireExamined(columns.length, 'stored column')).toBe(7);
  });
  for (const [column, value] of Object.entries(CHANGES)) {
    it(`disables Enact when the stored ${column} differs from what was shown`, async () => {
      const s = await session(seeded({ ...STORED, [column]: value }).db);
      const gate = gateOf(s.read.rows);
      expect(gate).toEqual({
        enabled: false,
        why: ENACT_GATE.BLACKOUT_CHANGED,
        text: ENACT_REFUSAL_TEXT[PRACTICE_ENACT_REFUSAL.BLACKOUT_CHANGED],
      });
    });
  }

  it('re-checks on the fresh read at Confirm: an edit after the panel opened sends nothing', async () => {
    const { db } = seeded();
    const s = await session(db);
    const subjects = displacedByBlackout(s.read.rows);
    for (const id of subjects) {
      db.field_closures[0].blackout_until = '2026-10-31';
      const send = vi.fn();
      const before = practiceRowsOf(db);
      const out = await s.enact(id, send);
      expect(out).toMatchObject({
        status: 'refused',
        refusal: PRACTICE_ENACT_REFUSAL.BLACKOUT_CHANGED,
      });
      expect(send).not.toHaveBeenCalled();
      expect(practiceRowsOf(db)).toBe(before);
      db.field_closures[0].blackout_until = STORED.blackout_until;
    }
    expect(requireExamined(subjects.length, 'series-window')).toBe(3);
  });
});

describe("blackout enact UI :: B13 (client), the dialog's count is true", () => {
  it('counts each series dates in the window, computed by hand, never [D, until]', async () => {
    const { rows, db } = seeded();
    const s = await session(db);
    const subjects = displacedByBlackout(rows);
    for (const id of subjects) {
      const row = ROWS.find((r) => r.id === id);
      const day = SLOTS.find((x) => x.id === row.practice_slot_id).day_of_week;
      const expected = occurrences(STORED.blackout_from, STORED.blackout_until, day);
      const prompt = s.promptOf(id);
      expect(prompt.record.published_practices_affected).toBe(expected);
      // The retirement bound would count from the window to the row's end.
      expect(occurrences(STORED.blackout_from, RANGE_LAST, day)).toBeGreaterThan(expected);
      // One prompt row: S itself, keeping its range, over its own window.
      expect(prompt.record.rows).toEqual([
        {
          assignment_id: id,
          assigned_via: 'auto',
          effect: s.shownOf(id).to ? 'temporarily moved' : 'temporarily TIME TBD',
          range_after: null,
          window: `[${STORED.blackout_from},${STORED.blackout_until}]`,
        },
      ]);
    }
    expect(requireExamined(subjects.length, 'series-window')).toBe(3);
  });

  it("states a relocation's two counts from the readers' own helper (G1, Q6)", async () => {
    const s = await session(seeded().db);
    const moves = s.opened.state.recommendations.filter((r) => r.to !== null);
    for (const rec of moves) {
      const { relocation } = s.promptOf(rec.assignmentId);
      const day = rec.from.weekday.toLowerCase();
      const n = occurrences(STORED.blackout_from, STORED.blackout_until, day);
      expect(relocation).toEqual({
        from: { weekday: day, count: n },
        to: {
          weekday: rec.to.weekday.toLowerCase(),
          count: occurrences(
            STORED.blackout_from,
            STORED.blackout_until,
            rec.to.weekday.toLowerCase()
          ),
        },
      });
    }
    expect(requireExamined(moves.length, 'relocation')).toBe(2);
  });
});

describe('blackout enact UI :: Q4, one exception on S, nothing unlocked, read again', () => {
  it('enacts each kind once: one exception, no unlock, no row changed, S no longer displaced', async () => {
    const { rows, db } = seeded();
    const s = await session(db);
    const subjects = displacedByBlackout(rows);
    const kinds = new Set();
    for (const id of subjects) {
      const fresh = await session(db);
      const shown = fresh.shownOf(id);
      if (!shown) continue; // enacted earlier in this loop: proven below.
      const send = vi.fn(sendThroughMock(fresh.client));
      const rowsBefore = practiceRowsOf(db);
      const out = await fresh.enact(id, send);
      expect(out.status).toBe('enacted');
      expect(send).toHaveBeenCalledTimes(1);
      const body = send.mock.calls[0][0];
      expect(body.payload.repair.unlock).toEqual([]);
      expect(body.payload.repair.closes).toEqual([]);
      expect(body.payload.repair.exceptions).toHaveLength(1);
      expect(body.enact.cause).toMatchObject({ kind: 'blackout', id: STORED.id });
      expect(body.enact.prompt.accepted).toBe(true);
      // No row changed: the exception is the whole write.
      expect(practiceRowsOf(db)).toBe(rowsBefore);
      const written = db.practice_exceptions.filter((e) => e.assignment_id === id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        cause_kind: 'blackout',
        cause_id: STORED.id,
        withdrawn_at: null,
        team_id: ROWS.find((r) => r.id === id).team_id,
        kind: shown.to ? 'relocated' : 'time_tbd',
      });
      kinds.add(written[0].kind);
      expect(out.view.state.enacted).toContain(id);
      expect(out.view.state.recommendations.map((r) => r.assignmentId)).not.toContain(id);
      const [shownRow] = enactedRowsOf(
        out.view.rows,
        [
          {
            assignmentId: id,
            teamId: shown.teamId,
            written: out.written,
            cause: { kind: 'blackout', id: STORED.id },
          },
        ],
        namesOf(out.view.rows)
      );
      expect(shownRow.temporary).toHaveLength(1);
      expect(shownRow.missing).toBe(0);
    }
    expect([...kinds].sort()).toEqual(['relocated', 'time_tbd']);
    expect(db.audit_log.filter((r) => r.action === 'practice.unlock_accepted')).toEqual([]);
    expect(db.audit_log.filter((r) => r.action === 'practice.recommendation_enacted')).toHaveLength(
      requireExamined(subjects.length, 'series-window')
    );
    // `s` (opened before any enact) is untouched: nothing was written from it.
    expect(s.log[0]).toBe('rpc:practice_schedule_fingerprint');
  });

  it('an unticked prompt sends nothing', async () => {
    const s = await session(seeded().db);
    const [id] = displacedByBlackout(s.read.rows);
    const send = vi.fn();
    const out = await s.enact(id, send, { answer: { accepted: false } });
    expect(out).toMatchObject({
      status: 'refused',
      refusal: PRACTICE_ENACT_REFUSAL.PROMPT_NOT_ACCEPTED,
    });
    expect(send).not.toHaveBeenCalled();
  });
});

/** An audit row of the org's enact action, as the wrapper writes it. */
const enactRow = (n, cause, assignmentId) => ({
  id: uuid(880000 + n),
  organization_id: ORG,
  action: 'practice.recommendation_enacted',
  metadata: { cause, series: { assignment_id: assignmentId } },
});

describe('blackout enact UI :: B14, the un-retire count ignores blackout enacts', () => {
  it('counts the retirement enact off F1 and never a blackout row whose cause.id is F1', async () => {
    const db = enactDbOf(seeded().rows);
    const retirement = { kind: 'retirement', id: F1, stored_effective_to: '2026-10-14' };
    db.audit_log = [
      enactRow(1, retirement, uuid(601)),
      // A uuid colliding across `fields` and `field_blackouts`: forged on purpose.
      enactRow(2, { kind: 'blackout', id: F1, stored: {} }, uuid(602)),
    ];
    const seededSeries = new Set(
      db.audit_log
        .filter((r) => r.metadata.cause.id === F1)
        .map((r) => r.metadata.series.assignment_id)
    );
    expect(requireExamined(seededSeries.size, 'enact row on F1')).toBe(2);
    const count = (storedEffectiveTo) =>
      countSeriesEnactedOff(fakeClientOf(db, []), {
        organizationId: ORG,
        fieldId: F1,
        storedEffectiveTo,
      });
    expect(await count('2026-10-14')).toEqual({ ok: true, count: 1 });
    // A blackout record has no `stored_effective_to`, so a field passed with
    // none stored (the page sends `effective_to ?? null`) matched it by the
    // date filter alone; only the kind keeps it out.
    expect(await count(null)).toEqual({ ok: true, count: 0 });
  });
});

describe('blackout enact UI :: Q11, series enacted off this blackout', () => {
  it('counts distinct series of blackout enacts of this id only', async () => {
    const db = enactDbOf(seeded().rows);
    db.audit_log = [
      enactRow(1, { kind: 'blackout', id: STORED.id }, uuid(601)),
      enactRow(2, { kind: 'blackout', id: STORED.id }, uuid(602)),
      // The same series twice (a re-enact after a withdrawal): one series.
      enactRow(3, { kind: 'blackout', id: STORED.id }, uuid(602)),
      enactRow(4, { kind: 'blackout', id: uuid(702) }, uuid(603)),
      enactRow(
        5,
        { kind: 'retirement', id: STORED.id, stored_effective_to: '2026-10-14' },
        uuid(603)
      ),
    ];
    const counted = await countSeriesEnactedOffBlackout(fakeClientOf(db, []), {
      organizationId: ORG,
      blackoutId: STORED.id,
    });
    expect(counted).toEqual({ ok: true, count: 2 });
  });

  it('is unreadable, never 0, when the audit log cannot be read or no org is selected', async () => {
    const broken = {
      from: () => {
        const q = {
          select: () => q,
          eq: () => q,
          order: () => q,
          range: () => Promise.reject(new Error('down')),
        };
        return q;
      },
    };
    expect(
      await countSeriesEnactedOffBlackout(broken, { organizationId: ORG, blackoutId: STORED.id })
    ).toMatchObject({ ok: false });
    expect(
      await countSeriesEnactedOffBlackout(broken, { organizationId: null, blackoutId: STORED.id })
    ).toMatchObject({ ok: false });
  });
});
