// @vitest-environment node
/**
 * Probable moves on a re-import (`packages/core/src/practiceImport/probableMoves.js`; plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.11.6, decision 24 and the owner's change 4,
 * 2026-11-06; PR 9 task J2).
 *
 * A re-import is purely additive: it changes nothing and deletes nothing. The preview lists the
 * rows "in the schedule, not in this file" (they stay) and the rows "new in this file", and where they
 * belong to the SAME TEAM it shows them as a probable move. What this holds:
 *
 *   - **The pairing is at team level, never row to row.** "Team X: N rows leaving, M arriving". A swap
 *     of two days gives one pair for the team, never a 1:1 matching that would be arbitrary (two
 *     leaving rows and two arriving rows have two ways to be matched, and neither is the file's word).
 *   - **The new rows of a probable move arrive UNTICKED.** The admin ticks to add, so a move does not
 *     silently leave a team over its count; the leaving rows stay, because an import never deletes.
 *     Rows of a team that is not moving (new only) are ticked as usual.
 *   - **A team with rows on one side only is not paired.**
 *   - N need not equal M. Over-counts are flagged by the database (decision 20), not decided here.
 *   - The function reads two lists a dry run returns and nothing else: it is pure, it does not mutate
 *     its input, and a list that cannot be a dry run's (a row on both sides, a row twice, no team) is
 *     a defect in the caller and throws.
 *
 * Statically out of reach, and so not claimed: how an unticked row reaches `apply_practice_import_job`
 * (PR 10's first design task; the plan fixes the behaviour and no signature), and that the database's
 * dry run returns these row shapes (it does not exist yet).
 */

import { describe, expect, it } from 'vitest';
import {
  pairProbableMoves,
  selectedArrivals,
} from '../packages/core/src/practiceImport/probableMoves.js';

/** A saved or new practice row as a dry run would list it. */
const r = (rowKey, teamId, day, extra = {}) => ({
  rowKey,
  teamId,
  teamLabel: teamId.toUpperCase(),
  day,
  startTime: '16:00',
  endTime: '17:00',
  fieldLabel: 'Field 1',
  ...extra,
});

const freeze = (list) => list.map((x) => Object.freeze({ ...x }));

describe('probable moves: paired at team level', () => {
  it('pairs the rows a team is leaving with the rows it is arriving at: one move, N and M', () => {
    const result = pairProbableMoves({
      leaving: freeze([r('s1', 'sharks', 'mon')]),
      arriving: freeze([r('f1', 'sharks', 'tue')]),
    });
    expect(result.moves).toHaveLength(1);
    const [move] = result.moves;
    expect(move).toMatchObject({
      teamId: 'sharks',
      teamLabel: 'SHARKS',
      leavingCount: 1,
      arrivingCount: 1,
      summary: 'team SHARKS: 1 row leaving, 1 arriving',
    });
    expect(move.leaving.map((x) => x.rowKey)).toEqual(['s1']);
    expect(move.arriving.map((x) => x.rowKey)).toEqual(['f1']);
    expect([result.leavingOnly, result.arrivingOnly]).toEqual([[], []]);
  });

  it('the swap case: two days exchanged are ONE team-level pair, never a 1:1 matching', () => {
    // In the schedule: Monday on Field A, Wednesday on Field B. In the file: Monday on Field B,
    // Wednesday on Field A. Matched row to row there are two readings (Mon->Mon and Wed->Wed, or
    // Mon->Wed and Wed->Mon) and nothing in the data picks one.
    const result = pairProbableMoves({
      leaving: freeze([
        r('s-mon-a', 'sharks', 'mon', { fieldLabel: 'Field A' }),
        r('s-wed-b', 'sharks', 'wed', { fieldLabel: 'Field B' }),
      ]),
      arriving: freeze([
        r('f-mon-b', 'sharks', 'mon', { fieldLabel: 'Field B' }),
        r('f-wed-a', 'sharks', 'wed', { fieldLabel: 'Field A' }),
      ]),
    });
    expect(result.moves).toHaveLength(1);
    const [move] = result.moves;
    expect(move.summary).toBe('team SHARKS: 2 rows leaving, 2 arriving');
    expect(move.leaving.map((x) => x.rowKey)).toEqual(['s-mon-a', 's-wed-b']);
    expect(move.arriving.map((x) => x.rowKey)).toEqual(['f-mon-b', 'f-wed-a']);
    // no row is paired with a row: there is no field that says which leaving row an arriving one replaces
    expect(Object.keys(move).sort()).toEqual(
      [
        'arriving',
        'arrivingCount',
        'defaultTicked',
        'holdsIfAllTicked',
        'leaving',
        'leavingCount',
        'summary',
        'teamId',
        'teamLabel',
      ].sort()
    );
    expect(JSON.stringify(result)).not.toMatch(/pairs?"|replaces|matchedTo/);
  });

  it('keeps the new rows of a probable move UNTICKED by default, and ticks the rest', () => {
    const result = pairProbableMoves({
      leaving: freeze([r('s1', 'sharks', 'mon')]),
      arriving: freeze([
        r('f1', 'sharks', 'tue'),
        r('n1', 'lions', 'wed'),
        r('n2', 'lions', 'fri'),
      ]),
    });
    expect(result.moves[0].defaultTicked).toBe(false);
    expect(result.arrivals.map((x) => [x.rowKey, x.probableMove, x.defaultTicked])).toEqual([
      ['f1', true, false],
      ['n1', false, true],
      ['n2', false, true],
    ]);
  });

  it('pairs a team with N leaving and M arriving when N is not M, and says how many it would hold', () => {
    const more = pairProbableMoves({
      leaving: freeze([
        r('s1', 'sharks', 'mon'),
        r('s2', 'sharks', 'wed'),
        r('s3', 'sharks', 'fri'),
      ]),
      arriving: freeze([r('f1', 'sharks', 'tue')]),
    });
    expect(more.moves[0]).toMatchObject({
      leavingCount: 3,
      arrivingCount: 1,
      summary: 'team SHARKS: 3 rows leaving, 1 arriving',
      holdsIfAllTicked: 4, // the leaving rows stay: an import never deletes
    });
    const fewer = pairProbableMoves({
      leaving: freeze([r('s1', 'sharks', 'mon')]),
      arriving: freeze([
        r('f1', 'sharks', 'tue'),
        r('f2', 'sharks', 'thu'),
        r('f3', 'sharks', 'fri'),
      ]),
    });
    expect(fewer.moves[0]).toMatchObject({
      leavingCount: 1,
      arrivingCount: 3,
      summary: 'team SHARKS: 1 row leaving, 3 arriving',
      holdsIfAllTicked: 4,
    });
    expect(fewer.moves[0].defaultTicked).toBe(false);
    expect(fewer.arrivals.every((x) => x.defaultTicked === false)).toBe(true);
  });

  it('does not pair a team with rows on one side only', () => {
    const result = pairProbableMoves({
      leaving: freeze([r('s1', 'sharks', 'mon'), r('c1', 'cubs', 'tue')]),
      arriving: freeze([r('f1', 'sharks', 'wed'), r('n1', 'lions', 'thu')]),
    });
    expect(result.moves.map((m) => m.teamId)).toEqual(['sharks']);
    expect(result.leavingOnly.map((t) => [t.teamId, t.rows.map((x) => x.rowKey)])).toEqual([
      ['cubs', ['c1']],
    ]);
    expect(result.arrivingOnly.map((t) => [t.teamId, t.rows.map((x) => x.rowKey)])).toEqual([
      ['lions', ['n1']],
    ]);
    // a team that is only arriving is not a move: its row is an ordinary new row, ticked
    expect(result.arrivals.find((x) => x.rowKey === 'n1')).toMatchObject({
      probableMove: false,
      defaultTicked: true,
    });
  });

  it('pairs by team id, not by label: two teams that share a name are two teams', () => {
    const result = pairProbableMoves({
      leaving: freeze([r('s1', 'a', 'mon', { teamLabel: 'Sharks' })]),
      arriving: freeze([r('f1', 'b', 'tue', { teamLabel: 'Sharks' })]),
    });
    expect(result.moves).toEqual([]);
    expect(result.leavingOnly).toHaveLength(1);
    expect(result.arrivingOnly).toHaveLength(1);
  });

  it('keeps ids that contain delimiters apart', () => {
    const result = pairProbableMoves({
      leaving: freeze([r('s1', 'a|b', 'mon'), r('s2', 'a', 'tue')]),
      arriving: freeze([r('f1', 'a', 'wed'), r('f2', 'b', 'thu')]),
    });
    expect(result.moves.map((m) => m.teamId)).toEqual(['a']);
    expect(result.leavingOnly.map((t) => t.teamId)).toEqual(['a|b']);
    expect(result.arrivingOnly.map((t) => t.teamId)).toEqual(['b']);
  });

  it('is the same whichever order the lists come in; rows keep their own order', () => {
    const leaving = [r('s1', 'zebra', 'mon'), r('s2', 'ant', 'tue'), r('s3', 'ant', 'wed')];
    const arriving = [r('f1', 'ant', 'thu'), r('f2', 'zebra', 'fri'), r('f3', 'ant', 'fri')];
    const a = pairProbableMoves({ leaving: freeze(leaving), arriving: freeze(arriving) });
    const b = pairProbableMoves({
      leaving: freeze([...leaving].reverse()),
      arriving: freeze([...arriving].reverse()),
    });
    expect(a.moves.map((m) => m.teamId)).toEqual(['ant', 'zebra']); // by team id, not by arrival
    expect(b.moves.map((m) => m.teamId)).toEqual(['ant', 'zebra']);
    expect(a.moves[0].leaving.map((x) => x.rowKey)).toEqual(['s2', 's3']);
    expect(b.moves[0].leaving.map((x) => x.rowKey)).toEqual(['s3', 's2']);
  });

  it('does not change what it was given', () => {
    const leaving = freeze([r('s1', 'sharks', 'mon')]);
    const arriving = freeze([r('f1', 'sharks', 'tue')]);
    const before = JSON.stringify({ leaving, arriving });
    pairProbableMoves({ leaving: Object.freeze(leaving), arriving: Object.freeze(arriving) });
    expect(JSON.stringify({ leaving, arriving })).toBe(before);
  });

  it('has nothing to say about two empty lists, and one empty list is not a move', () => {
    expect(pairProbableMoves({ leaving: [], arriving: [] })).toEqual({
      moves: [],
      leavingOnly: [],
      arrivingOnly: [],
      arrivals: [],
    });
    const onlyNew = pairProbableMoves({
      leaving: [],
      arriving: freeze([r('f1', 'sharks', 'tue')]),
    });
    expect(onlyNew.moves).toEqual([]);
    expect(onlyNew.arrivals[0]).toMatchObject({ defaultTicked: true, probableMove: false });
  });
});

// Calls with arguments of the wrong type are the point of the refusal tests below.
const pairLoose = /** @type {(...args: any[]) => any} */ (pairProbableMoves);
const selectLoose = /** @type {(...args: any[]) => any} */ (selectedArrivals);

describe('probable moves: the admin ticks to add', () => {
  const result = pairProbableMoves({
    leaving: freeze([r('s1', 'sharks', 'mon'), r('s2', 'sharks', 'wed')]),
    arriving: freeze([
      r('f1', 'sharks', 'tue'),
      r('f2', 'sharks', 'thu'),
      r('n1', 'lions', 'wed'),
      r('n2', 'lions', 'fri'),
    ]),
  });
  const keys = (list) => list.map((x) => x.rowKey);

  it('applies the defaults when nothing is ticked: the move’s rows stay out, the others go in', () => {
    expect(keys(selectedArrivals(result))).toEqual(['n1', 'n2']);
    expect(keys(selectedArrivals(result, {}))).toEqual(['n1', 'n2']);
  });

  it('adds a move’s row when the admin ticks it, and drops an ordinary one when they untick it', () => {
    expect(keys(selectedArrivals(result, { f1: true }))).toEqual(['f1', 'n1', 'n2']);
    expect(keys(selectedArrivals(result, { f1: true, f2: true }))).toEqual([
      'f1',
      'f2',
      'n1',
      'n2',
    ]);
    expect(keys(selectedArrivals(result, { n1: false }))).toEqual(['n2']);
    expect(keys(selectedArrivals(result, { f1: true, n1: false, n2: false }))).toEqual(['f1']);
  });

  it('refuses a tick it cannot place or read, rather than skip it', () => {
    expect(() => selectedArrivals(result, { nope: true })).toThrow(/nope/);
    expect(() => selectLoose(result, { f1: 'yes' })).toThrow(/boolean/);
    expect(() => selectLoose(result, { f1: 1 })).toThrow(/boolean/);
    expect(() => selectLoose(result, null)).toThrow(TypeError);
  });
});

describe('probable moves: input that a dry run cannot return', () => {
  const ok = () => freeze([r('a', 't1', 'mon')]);

  it('is refused, naming the defect', () => {
    expect(() => pairLoose({ leaving: ok(), arriving: undefined })).toThrow(TypeError);
    expect(() => pairLoose({ leaving: 'rows', arriving: [] })).toThrow(TypeError);
    expect(() => pairLoose({ leaving: [{ rowKey: 'a' }], arriving: [] })).toThrow(/teamId/);
    expect(() => pairLoose({ leaving: [{ teamId: 't1' }], arriving: [] })).toThrow(/rowKey/);
    expect(() => pairLoose({ leaving: [{ rowKey: 'a', teamId: '' }], arriving: [] })).toThrow(
      /teamId/
    );
    expect(() => pairLoose({ leaving: [null], arriving: [] })).toThrow(TypeError);
  });

  it('refuses a row listed twice, and a row on both sides', () => {
    expect(() => pairProbableMoves({ leaving: [...ok(), ...ok()], arriving: [] })).toThrow(/twice/);
    expect(() => pairProbableMoves({ leaving: [], arriving: [...ok(), ...ok()] })).toThrow(/twice/);
    expect(() => pairProbableMoves({ leaving: ok(), arriving: ok() })).toThrow(/both/);
  });
});
