// 8.6 3b PR 11a: enacting ONE practice repair recommendation, the core half
// (`docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1 steps 3a, 6-8, §2, §5; §6
// witnesses 1, 2, 9, 13 and the core arm of 24).
//
// Every subject set is enumerated from the PRE-ENACT snapshot rows
// (`displacedFromRows`), never from a repair's output, and every fixture ends
// on a meta-assertion with its own vacuity plant. Plants that must turn this
// file red, each shown in the PR body:
//
// - 1: `judgeEnact` returns `stands: true` unconditionally;
// - 2: `judgeEnact` compares `to` only, not `objective.counts`;
// - 9: `buildEnactPayload` copies `unlockRequired` into `unlock` without the answer;
// - 13: the record's `declined` holds only S's own declines;
// - 24 (Plant B): `retirementCommitOf` reads `loss.field.effective_to`, not the fresh row;
// - the new row emits `assigned_via: 'repair'`;
// - a tier-2 entry is built from the repair result (it sits in `timeTbd`).
//
// Synthetic rows only (`tests/helpers/practiceEnactWorld.js`).
import { describe, expect, it } from 'vitest';

import {
  PRACTICE_ENACT_REFUSAL,
  PRACTICE_ENACT_STALE,
  PRACTICE_REPAIR_PAYLOAD_REFUSAL,
  PracticeEnactRecordSchema,
  buildEnactPayload,
  buildEnactRecord,
  buildPracticeRepairInput,
  buildPracticeRepairPayload,
  createRecommendationState,
  declineRecommendation,
  judgeEnact,
  rebaseRecommendationState,
  repairPracticeLoss,
  retirementCommitOf,
} from '../packages/core/src/practice/index.js';
import {
  D,
  ENACT_KEY,
  F1,
  F2,
  F3,
  FINGERPRINT,
  RETIREMENT,
  SEASON,
  assignment,
  coach,
  displacedFromRows,
  fieldsWith,
  requireExamined,
  rowsOf,
  slot,
  uuid,
} from './helpers/practiceEnactWorld.js';

/* -- worlds ---------------------------------------------------------------- */

/** Two series on F1 (Mon and Wed 17:00); F2 offers both days at 17:00 and 18:00. */
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

/**
 * One series on F1 (Tue 17:00). Its venue's only other shape (F2 Tue 18:00)
 * is held by a frozen team, so tier 1 leaves it TIME TBD and tier 2
 * recommends F3 Tue 18:00, across venues. `coaches` may make the frozen
 * team share a coach with it.
 */
const cross = (coaches = []) =>
  rowsOf({
    slots: [
      slot(511, F1, 'tue', '17:00', '18:00'),
      slot(512, F3, 'tue', '18:00', '19:00'),
      slot(513, F2, 'tue', '18:00', '19:00'),
    ],
    assignments: [assignment(611, 311, 511), assignment(613, 313, 513)],
    coaches,
  });

/** @param {any} rows @param {any} [loss] @param {string | null} [baseFingerprint] */
const adapt = (rows, loss = RETIREMENT, baseFingerprint = FINGERPRINT) =>
  buildPracticeRepairInput({ ...rows, loss, ...(baseFingerprint ? { baseFingerprint } : {}) });
const ACCEPT = Object.freeze({ accepted: true, enactKey: ENACT_KEY });
const recOf = (state, id) => state.recommendations.find((r) => r.assignmentId === id);

/** The whole core flow on one fresh read: gate, re-base, re-judge, payload. */
function enactOn(freshRows, state, id, ...answered) {
  // An explicit `undefined` answer is an answer (none given), not the default.
  const answer = answered.length > 0 ? answered[0] : ACCEPT;
  const loss = RETIREMENT;
  const adapted = adapt(freshRows, loss);
  const commit = retirementCommitOf(freshRows, loss);
  const rebased = rebaseRecommendationState(state, adapted.input);
  const judged = judgeEnact(rebased, id, recOf(state, id));
  return {
    adapted,
    commit,
    rebased,
    judged,
    ...buildEnactPayload(adapted, judged, answer, commit),
  };
}

/* -- meta-assertions -------------------------------------------------------- */

describe('enact :: the fixtures exercise data (meta-assertions and their vacuity plants)', () => {
  it('each world displaces series, enumerated from its rows', () => {
    expect(requireExamined(displacedFromRows(main(), F1).length, 'displaced series')).toBe(2);
    expect(requireExamined(displacedFromRows(cross(), F1).length, 'displaced series')).toBe(1);
    // And the repair agrees with the rows, counted independently.
    expect(
      createRecommendationState(adapt(main()).input)
        .recommendations.map((r) => r.assignmentId)
        .sort()
    ).toEqual(displacedFromRows(main(), F1));
  });

  it('the meta-assertion goes red when the loss is moved off every series', () => {
    // F3 holds no series in either world: the retirement moved there displaces nothing.
    for (const rows of [main(), cross()]) {
      expect(() => requireExamined(displacedFromRows(rows, F3).length, 'x')).toThrow(
        'examined no x'
      );
    }
  });
});

/* -- witness 1: never write a shape other than the one shown ---------------- */

describe('enact :: 1, a changed world is stale and sends nothing', () => {
  it('a frozen row landing on the shown shape makes every series stale, with no payload', () => {
    const state = createRecommendationState(adapt(main()).input);
    const subjects = displacedFromRows(main(), F1);
    for (const id of subjects) {
      const shown = recOf(state, id);
      // The control: on an unchanged read the same enact stands and is sent.
      expect(enactOn(main(), state, id).payload).not.toBeNull();
      // Someone else's row now holds X from before D to the season's end.
      const slotOfX = MAIN_SLOTS.find(
        (s) =>
          s.field_id === shown.to.surfaceId &&
          s.day_of_week.toUpperCase() === shown.to.weekday &&
          Number(s.start_time.slice(0, 2)) * 60 === shown.to.startMinutes
      );
      const fresh = main({
        assignments: [...MAIN_ROWS, assignment(699, 399, Number(slotOfX.id.slice(-3)))],
      });
      const out = enactOn(fresh, state, id);
      expect(out.judged.stands).toBe(false);
      expect(out.judged.why).toBe(PRACTICE_ENACT_STALE.NOT_A_CANDIDATE);
      expect(out.refusal).toBe(PRACTICE_ENACT_REFUSAL.STALE);
      expect(out.payload).toBeNull();
    }
    expect(requireExamined(subjects.length, 'series')).toBe(2);
  });

  it('a shape S declined, or one past the change budget left, is stale', () => {
    const state = createRecommendationState(adapt(main()).input);
    const shown = recOf(state, uuid(601));
    const declined = declineRecommendation(state, uuid(601));
    expect(judgeEnact(declined, uuid(601), shown).why).toBe(PRACTICE_ENACT_STALE.DECLINED);
    // A time-changing shape judged on a state whose budget is spent (a real
    // repair input with `changeBudget: 0`, as the panel may pass).
    const moved = recOf(declined, uuid(601));
    expect(moved.objective.counts.changedGame).toBe(1);
    const spent = createRecommendationState(
      buildPracticeRepairInput({ ...main(), loss: RETIREMENT, options: { changeBudget: 0 } }).input
    );
    expect(judgeEnact(spent, uuid(601), moved).why).toBe(PRACTICE_ENACT_STALE.OVER_BUDGET);
  });

  it('a payload is never built from a read other than the one judged', () => {
    const state = createRecommendationState(adapt(main()).input);
    const judged = judgeEnact(state, uuid(601), recOf(state, uuid(601)));
    expect(() =>
      buildEnactPayload(adapt(main()), judged, ACCEPT, retirementCommitOf(main(), RETIREMENT))
    ).toThrow('another read');
  });

  it('an already-enacted or no-longer-displaced series is stale', () => {
    const state = createRecommendationState(adapt(main()).input);
    const shown = recOf(state, uuid(601));
    expect(judgeEnact({ ...state, enacted: [uuid(601)] }, uuid(601), shown).why).toBe(
      PRACTICE_ENACT_STALE.ENACTED
    );
    const gone = main({ assignments: [MAIN_ROWS[1]] });
    const rebased = createRecommendationState(adapt(gone).input);
    expect(judgeEnact(rebased, uuid(601), shown).why).toBe(PRACTICE_ENACT_STALE.NOT_DISPLACED);
  });
});

/* -- witness 2: a compromise change is stale (approved-option) -------------- */

describe('enact :: 2, a fresh coach overlap on a cross-venue recommendation is stale', () => {
  it('same `to`, changed counts: stale, nothing sent', () => {
    const state = createRecommendationState(adapt(cross()).input);
    const shown = recOf(state, uuid(611));
    expect(shown.tier).toBe('cross-venue');
    expect(shown.origin).toBe('approved-option');
    const fresh = cross([coach(401, 311), coach(401, 313)]);
    const out = enactOn(fresh, state, uuid(611));
    expect(out.judged.fresh.to).toEqual(shown.to);
    expect(out.judged.differences).toEqual(['coachOverlaps', 'objective']);
    expect(out.judged.stands).toBe(false);
    expect(out.refusal).toBe(PRACTICE_ENACT_REFUSAL.STALE);
    expect(out.payload).toBeNull();
  });
});

/* -- witness 9: unlock only what the prompt accepted ------------------------ */

describe('enact :: 9, unlock only what the prompt accepted', () => {
  it('no answer, or an unticked one, gives `unlock: []` and no payload, per series', () => {
    const state = createRecommendationState(adapt(main()).input);
    const subjects = displacedFromRows(main(), F1);
    for (const id of subjects) {
      for (const answer of [undefined, null, { accepted: false, enactKey: ENACT_KEY }]) {
        const out = enactOn(main(), state, id, answer);
        expect(out.unlock).toEqual([]);
        expect(out.payload).toBeNull();
        expect(out.refusal).toBe(PRACTICE_ENACT_REFUSAL.UNLOCK_NOT_ACCEPTED);
      }
      const out = enactOn(main(), state, id);
      expect(out.plan.unlockRequired.map((r) => r.assignment_id)).toEqual([id]);
      // The generated reason: ids and the date only (operator answer Q4).
      expect(out.payload.repair.unlock).toEqual([
        { assignment_id: id, reason: `enact ${ENACT_KEY}: retirement of field ${F1} from ${D}` },
      ]);
    }
    expect(requireExamined(subjects.length, 'series')).toBe(2);
  });

  it('an accepted answer without a uuid enactKey is refused loudly', () => {
    const state = createRecommendationState(adapt(main()).input);
    expect(() => enactOn(main(), state, uuid(601), { accepted: true, enactKey: 'Bob' })).toThrow(
      'enactKey'
    );
  });
});

/* -- the one-entry write ---------------------------------------------------- */

describe('enact :: the write covers S alone, marked and moved', () => {
  it('writes one new row, `assigned_via = recommendation`, and closes S at D-1', () => {
    const state = createRecommendationState(adapt(main()).input);
    for (const id of displacedFromRows(main(), F1)) {
      const out = enactOn(main(), state, id);
      const team = MAIN_ROWS.find((r) => r.id === id).team_id;
      const added = out.payload.assignmentRows.filter((r) => r.assigned_via !== undefined);
      expect(added).toEqual([expect.objectContaining({ team_id: team })]);
      expect(added[0].assigned_via).toBe('recommendation');
      expect(out.payload.repair.closes).toEqual([{ assignment_id: id, last_day: '2026-10-14' }]);
      expect(out.payload.repair.exceptions).toEqual([]);
      expect(out.payload.repair.baseFingerprint).toBe(FINGERPRINT);
      // Every other snapshot row is re-sent unchanged.
      const other = MAIN_ROWS.find((r) => r.id !== id);
      expect(out.payload.assignmentRows).toContainEqual({
        team_id: other.team_id,
        practice_slot_id: other.practice_slot_id,
        effective_date_range: other.effective_date_range,
        source: other.source,
      });
    }
    // The panel's refusal preview keeps `repair` (the builder's default).
    const adapted = adapt(main());
    const preview = buildPracticeRepairPayload(adapted, repairPracticeLoss(adapted.input));
    expect(
      preview.plan.assignmentRows.filter((r) => r.assigned_via).map((r) => r.assigned_via)
    ).toEqual(['repair', 'repair']);
  });

  it('writes a tier-2 recommendation as the MOVE, although the repair holds it in `timeTbd`', () => {
    const adapted = adapt(cross());
    const result = repairPracticeLoss(adapted.input);
    expect(result.timeTbd.map((e) => e.assignmentId)).toEqual([uuid(611)]);
    expect(result.rehomed).toEqual([]);
    const state = createRecommendationState(adapted.input);
    const out = enactOn(cross(), state, uuid(611));
    expect(out.payload.repair.exceptions).toEqual([]);
    expect(out.payload.assignmentRows.filter((r) => r.assigned_via)).toEqual([
      {
        team_id: uuid(311),
        practice_slot_id: uuid(512),
        effective_date_range: '[2026-10-15,2026-11-30]',
        source: 'auto',
        assigned_via: 'recommendation',
      },
    ]);
  });

  it('refuses a blackout, with a null payload, for every displaced series-window (Q1)', () => {
    const loss = {
      kind: 'blackout',
      blackout: {
        id: uuid(701),
        field_id: F1,
        location_id: null,
        blackout_from: '2026-10-15',
        blackout_until: '2026-10-31',
        start_minutes: null,
        end_minutes: null,
        reason: 'maintenance',
      },
    };
    const rows = main({ fields: fieldsWith(null) });
    const adapted = adapt(rows, loss);
    const state = createRecommendationState(adapted.input);
    const subjects = displacedFromRows(rows, F1, '2026-10-15');
    for (const id of subjects) {
      const commit = retirementCommitOf(rows, loss);
      expect(commit.refusal).toBe(PRACTICE_ENACT_REFUSAL.BLACKOUT_NOT_ENACTABLE);
      const judged = judgeEnact(state, id, recOf(state, id));
      expect(judged.stands).toBe(true);
      // Even with a forged committed gate, the payload is refused.
      const forged = {
        committed: true,
        refusal: null,
        fieldId: F1,
        stored: '2026-10-14',
        claimed: '2026-10-14',
      };
      for (const gate of [commit, forged]) {
        const out = buildEnactPayload(adapted, judged, ACCEPT, gate);
        expect(out.refusal).toBe(PRACTICE_ENACT_REFUSAL.BLACKOUT_NOT_ENACTABLE);
        expect(out.payload).toBeNull();
      }
    }
    expect(requireExamined(subjects.length, 'series-window')).toBe(2);
  });

  it('refuses a blind enact (no base fingerprint) and an adapter refusal', () => {
    const blind = adapt(main(), RETIREMENT, null);
    const state = createRecommendationState(blind.input);
    const judged = judgeEnact(state, uuid(601), recOf(state, uuid(601)));
    const out = buildEnactPayload(blind, judged, ACCEPT, retirementCommitOf(main(), RETIREMENT));
    expect(out.refusal).toBe(PRACTICE_ENACT_REFUSAL.NO_BASE_FINGERPRINT);
    expect(out.payload).toBeNull();

    // A row starting after D with nowhere to go: its TIME TBD cannot be closed away.
    const late = rowsOf({
      slots: [slot(521, F1, 'thu', '17:00', '18:00')],
      assignments: [assignment(621, 321, 521, '[2026-10-20,2026-12-01)')],
    });
    const lateState = createRecommendationState(adapt(late).input);
    const lateOut = enactOn(late, lateState, uuid(621));
    expect(lateOut.refusal).toBe(PRACTICE_ENACT_REFUSAL.PAYLOAD_REFUSED);
    expect(lateOut.refused.map((r) => r.why)).toEqual([
      PRACTICE_REPAIR_PAYLOAD_REFUSAL.ROW_NOT_CLOSABLE,
    ]);
    expect(lateOut.payload).toBeNull();
  });
});

/* -- witness 24, core arm: the commit gate reads the FRESH row --------------- */

describe('enact :: 24, refused while the retirement is uncommitted (Q3)', () => {
  it('a fresh field row with no `effective_to` refuses every recommendation, whatever the loss claims', () => {
    const state = createRecommendationState(adapt(main()).input);
    const subjects = displacedFromRows(main(), F1);
    for (const [stored, refusal] of [
      [null, PRACTICE_ENACT_REFUSAL.RETIREMENT_UNCOMMITTED],
      ['2026-10-20', PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED],
    ]) {
      const fresh = main({ fields: fieldsWith(stored) });
      const commit = retirementCommitOf(fresh, RETIREMENT);
      expect(RETIREMENT.field.effective_to).toBe('2026-10-14');
      expect(commit).toMatchObject({ committed: false, refusal, stored });
      for (const id of subjects) {
        const out = enactOn(fresh, state, id);
        expect(out.refusal).toBe(refusal);
        expect(out.payload).toBeNull();
      }
    }
    // A field the fresh read does not hold has nothing stored.
    const missing = retirementCommitOf({ fields: [] }, RETIREMENT);
    expect(missing.refusal).toBe(PRACTICE_ENACT_REFUSAL.RETIREMENT_UNCOMMITTED);
    expect(requireExamined(subjects.length, 'recommendation')).toBe(2);
  });

  it('a gate judged for another date or field does not pass for this loss', () => {
    const state = createRecommendationState(adapt(main()).input);
    const adapted = adapt(main());
    const judged = judgeEnact(state, uuid(601), recOf(state, uuid(601)));
    for (const gate of [
      { committed: true, refusal: null, fieldId: F1, stored: '2026-10-20', claimed: '2026-10-20' },
      { committed: true, refusal: null, fieldId: F2, stored: '2026-10-14', claimed: '2026-10-14' },
    ]) {
      const out = buildEnactPayload(adapted, judged, ACCEPT, gate);
      expect(out.refusal).toBe(PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED);
      expect(out.payload).toBeNull();
    }
  });
});

/* -- a carried TIME TBD takes the fresh read's reason ----------------------- */

describe('enact :: a TIME TBD carried through a re-base says why on the FRESH read', () => {
  it('re-reads a stale reason (the sibling repair contract), and keeps `declined`', () => {
    const rows = (extra = []) => ({
      ...rowsOf({
        slots: [slot(501, F1, 'mon', '17:00', '18:00'), slot(505, F2, 'mon', '18:00', '19:00')],
        assignments: [assignment(601, 301, 501), ...extra],
      }),
      loss: RETIREMENT,
      baseFingerprint: FINGERPRINT,
      options: { changeBudget: 0 },
    });
    const state = createRecommendationState(buildPracticeRepairInput(rows()).input);
    expect(recOf(state, uuid(601)).reason).toBe('change-budget');
    // Someone else now holds Mon 18:00: no legal slot is left at the venue.
    const fresh = buildPracticeRepairInput(rows([assignment(698, 398, 505)])).input;
    const rebased = rebaseRecommendationState(state, fresh);
    expect(recOf(rebased, uuid(601)).reason).toBe(repairPracticeLoss(fresh).timeTbd[0].reason);
    expect(recOf(rebased, uuid(601)).reason).toBe('no-legal-slot-at-venue');
  });
});

/* -- the record never claims an optimum the session does not hold ----------- */

describe('enact :: the record claims proven optimality only for the fresh optimum', () => {
  it('a carried placement that is admissible but no longer optimal is not proven optimal', () => {
    // Opened while a frozen row held F2 Mon 17:00, so T301 was recommended Mon 18:00.
    const opened = main({ assignments: [...MAIN_ROWS, assignment(699, 399, 503)] });
    const state = createRecommendationState(adapt(opened).input);
    const s = uuid(601);
    expect(recOf(state, s).to.startMinutes).toBe(1080);
    // The frozen row is gone on the fresh read: Mon 18:00 is still admissible and
    // kept, with no chain, while the fresh optimum is Mon 17:00.
    const out = enactOn(main(), state, s);
    expect(out.judged.stands).toBe(true);
    expect(out.rebased.chains).toEqual([]);
    const fresh = createRecommendationState(adapt(main()).input);
    expect(recOf(fresh, s).to.startMinutes).toBe(1020);
    const record = buildEnactRecord({
      enactKey: ENACT_KEY,
      seasonSettingsId: SEASON,
      adapted: out.adapted,
      state: out.rebased,
      judged: out.judged,
      commit: out.commit,
      enactment: out,
      prompt: {
        rows: [{ assignment_id: s, assigned_via: 'auto', effect: 'closed', range_after: null }],
        published_practices_affected: 7,
        accepted: true,
      },
    });
    expect(record.local).toBe(false);
    expect(record.solver.proven_optimal).toBe(false);
  });
});

/* -- witness 13: the audit records all of Δ --------------------------------- */

describe('enact :: 13, the record carries every declined pair of the session', () => {
  it('declined equals the pairs this test declined, across two series; the record is strict', () => {
    let state = createRecommendationState(adapt(main()).input);
    const declinedByTest = [];
    for (const id of displacedFromRows(main(), F1)) {
      declinedByTest.push({ assignment_id: id, to: recOf(state, id).to });
      state = declineRecommendation(state, id);
    }
    expect(requireExamined(declinedByTest.length, 'decline')).toBe(2);
    const s = uuid(601);
    const out = enactOn(main(), state, s);
    expect(out.payload).not.toBeNull();
    const prompt = {
      rows: [
        {
          assignment_id: s,
          assigned_via: 'auto',
          effect: 'closed',
          range_after: '[2026-09-01,2026-10-14]',
        },
      ],
      published_practices_affected: 7,
      accepted: true,
    };
    const record = buildEnactRecord({
      enactKey: ENACT_KEY,
      seasonSettingsId: SEASON,
      adapted: out.adapted,
      state: out.rebased,
      judged: out.judged,
      commit: out.commit,
      enactment: out,
      prompt,
    });
    const asShape = (to) => ({
      surface_id: to.surfaceId,
      weekday: to.weekday,
      start_minutes: to.startMinutes,
      duration_minutes: to.durationMinutes,
    });
    expect(record.declined).toEqual(
      declinedByTest.map((d) => ({ assignment_id: d.assignment_id, to: asShape(d.to) }))
    );
    expect(record).toMatchObject({
      enact_key: ENACT_KEY,
      run_id: ENACT_KEY,
      cause: { kind: 'retirement', id: F1, stored_effective_to: '2026-10-14' },
      series: { assignment_id: s, window: { from: D, until: '2026-11-30' } },
      decision: { kind: 'rehome', tier: 'same-venue', origin: null },
      local: true,
      unlock: out.payload.repair.unlock,
      base_fingerprint: FINGERPRINT,
      result_fingerprint: null,
    });
    expect(record.chains.map((c) => c.kind)).toEqual(['decline', 'decline']);
    expect(record.writes.closes).toEqual([{ assignment_id: s, last_day: '2026-10-14' }]);
    expect(record.writes.new_rows).toHaveLength(1);
    expect(record.solver.proven_optimal).toBe(false);
    // With no decline on an unchanged read, the record may claim the optimum.
    const plain = createRecommendationState(adapt(main()).input);
    const plainOut = enactOn(main(), plain, s);
    const plainRecord = buildEnactRecord({
      enactKey: ENACT_KEY,
      seasonSettingsId: SEASON,
      adapted: plainOut.adapted,
      state: plainOut.rebased,
      judged: plainOut.judged,
      commit: plainOut.commit,
      enactment: plainOut,
      prompt,
    });
    expect(plainRecord).toMatchObject({ local: false, solver: { proven_optimal: true } });
    // Strict: an extra key, or free text in the unlock reason, is refused.
    expect(() => PracticeEnactRecordSchema.parse({ ...record, note: 'x' })).toThrow();
    expect(() =>
      PracticeEnactRecordSchema.parse({
        ...record,
        unlock: [{ assignment_id: s, reason: 'moved for Coach Smith' }],
      })
    ).toThrow();
    // A prompt that does not list the unlocked rows is not recorded.
    expect(() =>
      buildEnactRecord({
        enactKey: ENACT_KEY,
        seasonSettingsId: SEASON,
        adapted: out.adapted,
        state: out.rebased,
        judged: out.judged,
        commit: out.commit,
        enactment: out,
        prompt: { ...prompt, rows: [] },
      })
    ).toThrow('does not list');
  });
});
