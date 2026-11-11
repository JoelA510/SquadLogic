// @vitest-environment node
/**
 * "Changes since publication" (task G4 of PR 7, schedule expansion; plan 5.6): a view, not a store. For every game:
 * originally (the chosen baseline's rows), now (the saved schedule), why (the audit rows of `get_schedule_audit_log`).
 *
 * The identity facts this file is built around (lesson 95, verified): `persist_game_schedule` upserts a game on the
 * TUPLE (home, away, slot, week), and the baseline is the master export's rows, which carry no game id at all. So the
 * view keys every game with `gameKey` (the matchup tuple, and it stays the key even if an identity layer gives a
 * moved game its id, because a baseline cannot be keyed by an id it never stored) and says a game moved to another
 * slot or week is one game removed and one game new. It never claims the two are the same game.
 *
 * What this file holds:
 * - the rows are enumerated from the baseline rows AND the saved rows together, never from the changed ones, so a
 *   cancelled game (no "now") is listed (plant: the enumeration starts from the changed rows);
 * - the counts reconcile: baseline games = unchanged + changed + removed, and saved games = unchanged + changed + new;
 * - a moved game is a removed game and a new game; the same two teams are shown, not linked;
 * - a TIME TBD game is in the view on both sides (then and now), with its week;
 * - the reasons are the audit rows that name the game's tuple in their before-image, from the baseline's recording
 *   on, so the old record's history belongs to the removed game and the new game has none;
 * - what cannot be read is counted and named, never dropped: a baseline row that cannot be paired, an audit list that
 *   may be cut;
 * - the baseline rows are the real producer's output (`generateScheduleExports`), not a hand-written copy.
 */
import { describe, expect, it } from 'vitest';

import {
  CHANGE_KIND,
  CHANGE_LABEL,
  CHANGES_COLUMNS,
  buildChangesSincePublication,
  changesCsv,
} from '../packages/core/src/reports/changesSincePublication.js';
import { generateScheduleExports } from '../packages/core/src/outputGeneration.js';
import { gameKey, tbdGameKey } from '../packages/core/src/reports/gameKey.js';
import { parseGameTbdNote, scheduleTbdNote } from '../packages/core/src/scheduleTbd.js';
import {
  FIELDS,
  SLOTS,
  TEAMS,
  TZ,
  VENUES,
  baselineRows,
  overrideRow,
  exportGames,
  savedGames,
  tbdGames,
} from './helpers/reportsWorld.js';

const RECORDED_AT = '2026-10-02T12:00:00+00:00';
const AFTER = '2026-10-05T12:00:00+00:00';
const BEFORE = '2026-09-30T12:00:00+00:00';

const input = (extra = {}) => ({
  baseline: {
    rows: baselineRows(savedGames()),
    recordedAt: RECORDED_AT,
    version: 3,
    label: 'Week 1 files',
  },
  savedGames: savedGames(),
  tbdGames: tbdGames(),
  teams: TEAMS,
  fields: FIELDS,
  venues: VENUES,
  slots: SLOTS,
  timeZone: TZ,
  auditRows: [],
  auditLimit: 500,
  ...extra,
});
const view = (extra = {}) => buildChangesSincePublication(input(extra));
const kinds = (result) => result.rows.map((row) => row.kind);

/** A saved game as a later save would leave it: another slot and week (under another id here, which no report reads). */
const moved = (id, slotId, weekIndex, start, end, extra = {}) => ({
  ...savedGames().find((g) => g.id === id),
  id: `${id}-moved`,
  slotId,
  gameSlotId: slotId,
  weekIndex,
  start,
  end,
  ...extra,
});

describe('gameKey: the one place a game is identified', () => {
  it('is the tuple (home, away, slot, week), and nothing else', () => {
    const a = gameKey({ homeTeamId: 'T-1', awayTeamId: 't-2', slotId: 's-1', weekIndex: 1 });
    expect(a).toBe(
      gameKey({ homeTeamId: 't-1', awayTeamId: 'T-2', slotId: 'S-1', weekIndex: '1' })
    );
    for (const change of [
      { homeTeamId: 't-3' },
      { awayTeamId: 't-3' },
      { slotId: 's-2' },
      { weekIndex: 2 },
    ]) {
      expect(
        gameKey({ homeTeamId: 't-1', awayTeamId: 't-2', slotId: 's-1', weekIndex: 1, ...change })
      ).not.toBe(a);
    }
    // The id of the row is not part of it: a moved game has a new id and the key says what moved.
    expect(
      gameKey({ id: 'row-1', homeTeamId: 't-1', awayTeamId: 't-2', slotId: 's-1', weekIndex: 1 })
    ).toBe(
      gameKey({ id: 'row-2', homeTeamId: 't-1', awayTeamId: 't-2', slotId: 's-1', weekIndex: 1 })
    );
  });

  it('is null when a part is missing: a key with a hole matches nothing', () => {
    const whole = { homeTeamId: 't-1', awayTeamId: 't-2', slotId: 's-1', weekIndex: 1 };
    for (const part of Object.keys(whole)) {
      expect(gameKey({ ...whole, [part]: null })).toBeNull();
      expect(gameKey({ ...whole, [part]: '' })).toBeNull();
    }
    expect(gameKey({ ...whole, weekIndex: 0 })).toBeNull();
    expect(gameKey(null)).toBeNull();
  });

  it('keys a game with no slot by its teams and week, apart from every placed game', () => {
    const tbd = tbdGameKey({ homeTeamId: 't-1', awayTeamId: 't-3', weekIndex: 2 });
    expect(tbd).not.toBeNull();
    expect(tbd).not.toBe(
      gameKey({ homeTeamId: 't-1', awayTeamId: 't-3', slotId: 's-3', weekIndex: 2 })
    );
    expect(tbdGameKey({ homeTeamId: 't-1', awayTeamId: 't-3', weekIndex: null })).toBeNull();
  });
});

describe('parseGameTbdNote: the week and the words the master export prints for a TIME TBD game', () => {
  it('reads back the note that scheduleTbdNote writes, for every week and every reason', () => {
    const reasons = {
      'no-slot-available': 'no game slot was free for it',
      'duplicate-matchup': 'a team already plays that week',
      'coach-scheduling-conflict': "a coach's other games leave no free time",
    };
    for (const weekIndex of [1, 2, 9, 12, 255]) {
      for (const [reason, why] of Object.entries(reasons)) {
        const note = scheduleTbdNote({
          kind: 'game',
          homeTeamId: 'a',
          awayTeamId: 'b',
          weekIndex,
          reason,
        });
        expect(parseGameTbdNote(note)).toEqual({ weekIndex, why });
      }
    }
  });

  it('gives nothing for a note it did not write', () => {
    for (const note of [
      'Practice not scheduled: no slot',
      'Game not scheduled (week x): y.',
      '',
      null,
      undefined,
      4,
    ]) {
      expect(parseGameTbdNote(note)).toBeNull();
    }
  });
});

describe('nothing has changed', () => {
  it('lists nothing and counts every game as unchanged', () => {
    const result = view();
    expect(result.rows).toEqual([]);
    expect(result.counts).toMatchObject({
      baselineGames: 6,
      savedGames: 6,
      unchanged: 6,
      changed: 0,
      removed: 0,
      added: 0,
      baselineTbd: 1,
      nowTbd: 1,
      tbdCleared: 0,
      tbdNew: 0,
      baselineUnreadable: 0,
    });
    expect(result.baseline).toMatchObject({ version: 3, label: 'Week 1 files' });
  });
});

describe('a cancelled game is listed', () => {
  it('shows a game that is in the baseline and not in the saved schedule, with no "now"', () => {
    const result = view({ savedGames: savedGames({ g3: null }) });
    expect(kinds(result)).toEqual([CHANGE_KIND.REMOVED]);
    const [row] = result.rows;
    expect(row).toMatchObject({
      home: 'Synthetic Meteors',
      away: 'Synthetic Rockets',
      division: 'U10',
      now: null,
    });
    expect(row.originally).toBe('Sat 2026-10-10 09:00 to 10:00, North Park - Field A1');
    expect(result.counts).toMatchObject({
      baselineGames: 6,
      savedGames: 5,
      unchanged: 5,
      removed: 1,
    });
  });

  it('lists every cancelled game, the first and the last as well as one in the middle', () => {
    const result = view({ savedGames: savedGames({ g1: null, g4: null, g6: null }) });
    expect(result.rows.map((r) => r.originally.slice(4, 14)).sort()).toEqual([
      '2026-10-03',
      '2026-10-10',
      '2026-10-17',
    ]);
    expect(result.counts.removed).toBe(3);
  });

  it('lists every game when the whole saved schedule is gone, and says nothing is saved', () => {
    const result = view({ savedGames: [] });
    expect(result.counts).toMatchObject({
      baselineGames: 6,
      savedGames: 0,
      removed: 6,
      unchanged: 0,
    });
    expect(kinds(result).every((k) => k === CHANGE_KIND.REMOVED)).toBe(true);
  });
});

describe('a moved game is one removed and one new, and is not called the same game', () => {
  const MOVE = moved('g1', 's-7', 3, '2026-10-17T15:00:00+00:00', '2026-10-17T16:00:00+00:00', {
    fieldId: 'f-a2',
  });
  const movedView = () => view({ savedGames: [...savedGames({ g1: null }), MOVE] });

  it('shows the old record as no longer saved and the new place as a new game', () => {
    const result = movedView();
    expect(kinds(result).sort()).toEqual([CHANGE_KIND.ADDED, CHANGE_KIND.REMOVED].sort());
    const removed = result.rows.find((r) => r.kind === CHANGE_KIND.REMOVED);
    const added = result.rows.find((r) => r.kind === CHANGE_KIND.ADDED);
    expect(removed.originally).toBe('Sat 2026-10-03 09:00 to 10:00, North Park - Field A1');
    expect(removed.now).toBeNull();
    expect(added.originally).toBeNull();
    expect(added.now).toBe('Sat 2026-10-17 11:00 to 12:00, North Park - Field A2');
    expect(result.counts).toMatchObject({
      baselineGames: 6,
      savedGames: 6,
      unchanged: 5,
      removed: 1,
      added: 1,
      changed: 0,
    });
  });

  it('names the same two teams beside each, without linking them', () => {
    const result = movedView();
    const removed = result.rows.find((r) => r.kind === CHANGE_KIND.REMOVED);
    const added = result.rows.find((r) => r.kind === CHANGE_KIND.ADDED);
    expect(removed.sameTeamsNew).toEqual([added.now]);
    expect(added.sameTeamsOld).toEqual([removed.originally]);
    // Nothing in the result says they are one game: no shared id, no "moved to".
    expect(JSON.stringify(result.rows)).not.toMatch(/moved to|same game|g1-moved|"id"/i);
  });

  it('says what a removed game and a new game may mean, in the app’s own words', () => {
    const { notes } = movedView();
    const text = notes.join(' ');
    expect(text).toMatch(
      /A baseline records each game's teams, slot and week, not which game is which, so a game moved to another time slot or week appears here twice/
    );
    // Said for the baseline, which is true with or without an identity layer: not about how the save writes a row.
    expect(text).not.toMatch(/saved as a new game|writes no id|new row/i);
    expect(text).toMatch(/does not link/i);
    expect(text).toMatch(/does not record whether/i);
  });
});

describe('a game changed in place', () => {
  it('shows the same teams, slot and week with a different time or field', () => {
    const later = savedGames({
      g2: { start: '2026-10-03T14:00:00+00:00', end: '2026-10-03T15:00:00+00:00', fieldId: 'f-c1' },
    });
    const result = view({ savedGames: later });
    expect(kinds(result)).toEqual([CHANGE_KIND.CHANGED]);
    expect(result.rows[0]).toMatchObject({
      originally: 'Sat 2026-10-03 09:30 to 10:30, Main Park - Field B1',
      now: 'Sat 2026-10-03 10:00 to 11:00, Main Park - Field C1',
    });
    expect(result.counts).toMatchObject({ unchanged: 5, changed: 1, removed: 0, added: 0 });
  });

  it('does not call a game changed because its Published flag or note moved', () => {
    const published = savedGames({
      g1: { published: true, notes: 'ok' },
      g2: { assignmentSource: 'manual' },
    });
    expect(view({ savedGames: published }).rows).toEqual([]);
  });
});

describe('the counts reconcile over a league with every kind of change', () => {
  it('baseline games = unchanged + changed + removed, saved games = unchanged + changed + new', () => {
    const saved = [
      ...savedGames({ g1: null, g3: null, g4: null }),
      moved('g1', 's-7', 3, '2026-10-17T15:00:00+00:00', '2026-10-17T16:00:00+00:00'),
    ];
    saved.find((g) => g.id === 'g2').start = '2026-10-03T15:00:00+00:00';
    saved.find((g) => g.id === 'g2').end = '2026-10-03T16:00:00+00:00';
    const result = view({ savedGames: saved });
    const c = result.counts;
    expect(c.baselineGames).toBe(c.unchanged + c.changed + c.removed);
    expect(c.savedGames).toBe(c.unchanged + c.changed + c.added);
    expect([c.unchanged, c.changed, c.removed, c.added]).toEqual([2, 1, 3, 1]);
    // And every number that is not zero is on a row the page lists.
    expect(result.rows).toHaveLength(c.changed + c.removed + c.added);
  });
});

describe('TIME TBD games, then and now', () => {
  it('lists a game that was on the TIME TBD list and has been placed: cleared from the list, new as a game', () => {
    const placed = {
      ...savedGames()[0],
      id: 'g-placed',
      homeTeamId: 't-1',
      awayTeamId: 't-3',
      weekIndex: 2,
      slotId: 's-9',
      gameSlotId: 's-9',
      start: '2026-10-10T15:00:00+00:00',
      end: '2026-10-10T16:00:00+00:00',
    };
    const result = view({
      savedGames: [...savedGames(), placed],
      tbdGames: [],
      slots: [...SLOTS, { id: 's-9', weekIndex: 2 }],
    });
    expect(kinds(result).sort()).toEqual([CHANGE_KIND.ADDED, CHANGE_KIND.TBD_CLEARED].sort());
    const cleared = result.rows.find((r) => r.kind === CHANGE_KIND.TBD_CLEARED);
    expect(cleared).toMatchObject({
      home: 'Synthetic Comets',
      away: 'Synthetic Meteors',
      originally: 'TIME TBD (week 2): no game slot was free for it',
      now: null,
    });
    expect(cleared.sameTeamsNew).toEqual(['Sat 2026-10-10 11:00 to 12:00, North Park - Field A1']);
    expect(result.counts).toMatchObject({
      baselineTbd: 1,
      nowTbd: 0,
      tbdCleared: 1,
      tbdNew: 0,
      added: 1,
    });
  });

  it('lists a game that was placed and is now on the TIME TBD list', () => {
    const result = view({
      savedGames: savedGames({ g3: null }),
      tbdGames: [
        ...tbdGames(),
        { homeTeamId: 't-3', awayTeamId: 't-2', weekIndex: 2, reason: 'coach-scheduling-conflict' },
      ],
    });
    expect(kinds(result).sort()).toEqual([CHANGE_KIND.REMOVED, CHANGE_KIND.TBD_NEW].sort());
    const fresh = result.rows.find((r) => r.kind === CHANGE_KIND.TBD_NEW);
    expect(fresh).toMatchObject({
      originally: null,
      now: "TIME TBD (week 2): a coach's other games leave no free time",
    });
    expect(result.counts).toMatchObject({ baselineTbd: 1, nowTbd: 2, tbdNew: 1 });
  });

  it('R7: a TIME TBD game whose DATE changed since the publication is a change, and is listed', () => {
    // The baseline's TIME TBD rows carry the date in their note (`Game not scheduled (week N, on DATE): ...`), as the
    // master export writes one for a game an import gave a date.
    const withDate = (date) =>
      baselineRows(savedGames()).map((row) =>
        row.Start === 'TIME TBD'
          ? { ...row, Notes: row.Notes.replace(/\(week (\d+)\)/, `(week $1, on ${date})`) }
          : row
      );
    const baseline = (rows) => ({
      rows,
      recordedAt: RECORDED_AT,
      version: 3,
      label: 'Week 1 files',
    });
    const now = (date) => tbdGames().map((g) => (date ? { ...g, gameDate: date } : g));
    // CONTROL: the same date then and now is no change
    expect(
      view({ baseline: baseline(withDate('2026-10-17')), tbdGames: now('2026-10-17') }).rows
    ).toEqual([]);
    // the date moved
    const moved = view({ baseline: baseline(withDate('2026-10-17')), tbdGames: now('2026-10-24') });
    expect(kinds(moved)).toEqual([CHANGE_KIND.TBD_DATE_CHANGED]);
    expect(moved.rows[0]).toMatchObject({
      label: 'TIME TBD game: date changed',
      originally: 'TIME TBD (week 2, on 2026-10-17): no game slot was free for it',
      now: 'TIME TBD (week 2, on 2026-10-24): no game slot was free for it',
    });
    expect(moved.counts).toMatchObject({ tbdDateChanged: 1, tbdUnchanged: 0 });
    // a date given to a game that had none, and a date taken away, are changes too
    expect(kinds(view({ tbdGames: now('2026-10-24') }))).toEqual([CHANGE_KIND.TBD_DATE_CHANGED]);
    expect(kinds(view({ baseline: baseline(withDate('2026-10-17')) }))).toEqual([
      CHANGE_KIND.TBD_DATE_CHANGED,
    ]);
  });

  it('does not list a game that is still on the TIME TBD list', () => {
    expect(view().rows).toEqual([]);
    // Even with another reason: it is still not scheduled.
    const reworded = tbdGames().map((g) => ({ ...g, reason: 'duplicate-matchup' }));
    expect(view({ tbdGames: reworded }).rows).toEqual([]);
  });
});

describe('why: the audit rows that name the game', () => {
  const g1 = savedGames()[0];
  const gone = { savedGames: savedGames({ g1: null }) };

  it('gives the removed game the reasons recorded for its tuple since the baseline, newest first', () => {
    const result = view({
      ...gone,
      auditRows: [
        overrideRow({
          id: 'a-2',
          gameId: 'old-id',
          game: g1,
          createdAt: AFTER,
          reasonCode: 'coach-request',
          note: 'Asked for a later start',
          actor: 'Synthetic Admin',
        }),
        overrideRow({
          id: 'a-1',
          gameId: 'old-id',
          game: g1,
          createdAt: '2026-10-04T12:00:00+00:00',
          reasonCode: 'field-change',
        }),
      ],
    });
    expect(result.rows[0].why.map((w) => [w.reason, w.note, w.who])).toEqual([
      ['Coach request', 'Asked for a later start', 'Synthetic Admin'],
      ['Field change', null, 'Synthetic Admin'],
    ]);
    expect(result.rows[0].why[0].when).toBe(AFTER);
  });

  it('ignores an override from before the baseline was recorded: the baseline already holds its result', () => {
    const result = view({
      ...gone,
      auditRows: [overrideRow({ id: 'a-0', gameId: 'old-id', game: g1, createdAt: BEFORE })],
    });
    expect(result.rows[0].why).toEqual([]);
  });

  it('matches by the tuple, so a new game that happens to share nothing with the old record has no history', () => {
    const move = moved('g1', 's-7', 3, '2026-10-17T15:00:00+00:00', '2026-10-17T16:00:00+00:00');
    const result = view({
      savedGames: [...savedGames({ g1: null }), move],
      auditRows: [overrideRow({ id: 'a-1', gameId: 'old-id', game: g1, createdAt: AFTER })],
    });
    const removed = result.rows.find((r) => r.kind === CHANGE_KIND.REMOVED);
    const added = result.rows.find((r) => r.kind === CHANGE_KIND.ADDED);
    expect(removed.why).toHaveLength(1);
    expect(added.why).toEqual([]);
    expect(added.whyNote).toMatch(/new game.*no history/i);
  });

  it('counts an override on a game that did not change, instead of leaving it unmentioned', () => {
    const g4 = savedGames()[3];
    const result = view({
      auditRows: [overrideRow({ id: 'a-1', gameId: 'ga-4', game: g4, createdAt: AFTER })],
    });
    expect(result.rows).toEqual([]);
    expect(result.counts.allowedWithoutChange).toBe(1);
  });

  it('counts audit rows it cannot key, and rows of other actions, apart', () => {
    const noBefore = {
      ...overrideRow({ id: 'a-1', gameId: 'x', game: g1, createdAt: AFTER }),
      metadata: { reason_code: 'other' },
    };
    const call = {
      id: 'a-2',
      created_at: AFTER,
      action: 'game.published_set',
      resource_type: 'game_assignment',
      resource_id: null,
      metadata: { published: true, count: 3 },
      actor_name: 'Synthetic Admin',
    };
    const result = view({ ...gone, auditRows: [noBefore, call] });
    expect(result.counts.auditUnkeyed).toBe(1);
    expect(result.rows[0].why).toEqual([]);
  });

  it('says when the audit list may be cut, and only then', () => {
    const rows = (n, from) =>
      Array.from({ length: n }, (_, i) =>
        overrideRow({
          id: `a-${i}`,
          gameId: 'x',
          game: g1,
          createdAt: `2026-10-${String(from - i).padStart(2, '0')}T12:00:00+00:00`,
        })
      );
    const full = view({ ...gone, auditRows: rows(5, 20), auditLimit: 5 });
    expect(full.auditMayBeCut).toBe(true);
    expect(full.notes.join(' ')).toMatch(/cut at 5 rows/i);
    expect(view({ ...gone, auditRows: rows(4, 20), auditLimit: 5 }).auditMayBeCut).toBe(false);
    // The oldest row returned is from before the baseline: everything since it was recorded was read.
    const reachedBack = [
      ...rows(4, 20),
      overrideRow({ id: 'old', gameId: 'x', game: g1, createdAt: BEFORE }),
    ];
    expect(view({ ...gone, auditRows: reachedBack, auditLimit: 5 }).auditMayBeCut).toBe(false);
  });
});

describe('what cannot be read is counted and named', () => {
  it('counts a baseline game row it cannot pair with the other side, and keeps it out of the counts it would distort', () => {
    const rows = baselineRows(savedGames());
    // Take the away side of the first game away: the home row has no partner.
    const lonely = rows.filter(
      (r) =>
        !(
          r['Event Type'] === 'Game' &&
          r.Role === 'Away' &&
          r['Team Name'] === 'Synthetic Rockets' &&
          r.Opponent === 'Synthetic Comets'
        )
    );
    const result = view({
      baseline: { rows: lonely, recordedAt: RECORDED_AT, version: 3, label: 'x' },
    });
    expect(result.counts.baselineUnreadable).toBe(1);
    expect(result.unreadable[0]).toMatchObject({
      team: 'Synthetic Comets',
      opponent: 'Synthetic Rockets',
    });
    expect(result.counts.baselineGames).toBe(5);
    expect(result.notes.join(' ')).toMatch(/could not be read from the baseline/i);
    // The saved game it stood for has no partner now, so the view cannot be read as a verdict.
    expect(result.sound).toBe(false);
    expect(view().sound).toBe(true);
  });

  it('does not pair across two games that read the same, and names both', () => {
    const rows = baselineRows(savedGames());
    const twin = rows.filter((r) => r['Event Type'] === 'Game' && r.Slot === 's-1');
    const result = view({
      baseline: { rows: [...rows, ...twin], recordedAt: RECORDED_AT, version: 3, label: 'x' },
    });
    expect(result.counts.baselineUnreadable).toBe(2);
  });

  it('pairs a game between two divisions, and tells apart two games of one name and one slot by their division', () => {
    // A cross-division game: the Home row (U10) and the Away row (U12) carry their own division.
    const teams = [
      ...TEAMS,
      { id: 't-7', name: 'Synthetic Meteors', divisionId: 'd-12', division: 'U12' },
    ];
    const games = [
      ...savedGames(),
      // Same slot, same time, same field, same two names, two divisions: Meteors (U10) v Rockets (U10) is g3's pair
      // of names, and Meteors (U12) v Rockets (U12) is a second game with those names.
      {
        ...savedGames()[2],
        id: 'g-twin',
        homeTeamId: 't-7',
        awayTeamId: 't-8',
        division: 'U12',
      },
      {
        ...savedGames()[0],
        id: 'g-cross',
        homeTeamId: 't-1',
        awayTeamId: 't-4',
        slotId: 's-7',
        gameSlotId: 's-7',
        weekIndex: 3,
        start: '2026-10-17T17:00:00+00:00',
        end: '2026-10-17T18:00:00+00:00',
      },
    ];
    const registry = [
      ...teams,
      { id: 't-8', name: 'Synthetic Rockets', divisionId: 'd-12', division: 'U12' },
    ];
    const rows = generateScheduleExports({
      teams: registry.map(({ id, name, division }) => ({ id, name, division })),
      gameAssignments: exportGames(games),
      tbdItems: [],
    }).master.rows;
    const result = view({
      baseline: { rows, recordedAt: RECORDED_AT, version: 3, label: 'x' },
      savedGames: games,
      teams: registry,
      slots: [...SLOTS],
      tbdGames: [],
    });
    expect(result.counts).toMatchObject({
      baselineGames: 8,
      savedGames: 8,
      unchanged: 8,
      baselineUnreadable: 0,
    });
    expect(result.sound).toBe(true);
  });

  it('reads a slot’s week from the saved games when the registry lacks it, and lists a game whose slot is gone', () => {
    const noS3 = SLOTS.filter((s) => s.id !== 's-3');
    expect(view({ slots: noS3 }).counts).toMatchObject({ unchanged: 6, removed: 0, added: 0 });
    // Cancelled as well: its week is known nowhere, so it cannot be matched, and it is still listed.
    const gone = view({ slots: noS3, savedGames: savedGames({ g3: null }) });
    expect(gone.counts).toMatchObject({ baselineGames: 6, unchanged: 5, removed: 1, added: 0 });
    expect(gone.rows[0].kind).toBe(CHANGE_KIND.REMOVED);
  });

  it('keeps the week a saved game names when the registry’s week for the slot is null, so an unchanged game is unchanged', () => {
    // `game_slots.week_index` can be null (the Games page reads such a slot as week 1). A null must not overwrite
    // the week the saved game carries: Number(null) is 0, a week no key can have, and the game would read as
    // removed and new while the comparison called itself sound.
    const nullWeek = SLOTS.map((slot) => (slot.id === 's-3' ? { ...slot, weekIndex: null } : slot));
    const result = view({ slots: nullWeek });
    expect(result.counts).toMatchObject({
      unchanged: 6,
      removed: 0,
      added: 0,
      baselineUnreadable: 0,
    });
    expect(result.rows).toEqual([]);
    expect(result.sound).toBe(true);
    // The same for a week that is not a positive whole number: only a real week overrides.
    for (const bad of [0, -2, 1.5, Number.NaN, '', undefined]) {
      const odd = SLOTS.map((slot) => (slot.id === 's-3' ? { ...slot, weekIndex: bad } : slot));
      expect(view({ slots: odd }).counts, String(bad)).toMatchObject({
        unchanged: 6,
        removed: 0,
        added: 0,
      });
    }
    // And a real week in the registry still wins over a saved game's (the registry is the slot's own record).
    const agree = SLOTS.map((slot) => (slot.id === 's-3' ? { ...slot, weekIndex: 2 } : slot));
    expect(view({ slots: agree }).counts).toMatchObject({ unchanged: 6 });
  });

  it('refuses a baseline with no rows or no recording time', () => {
    expect(() =>
      view({ baseline: { rows: [], recordedAt: RECORDED_AT, version: 1, label: 'x' } })
    ).toThrow(/baseline/i);
    expect(() =>
      view({
        baseline: { rows: baselineRows(savedGames()), recordedAt: null, version: 1, label: 'x' },
      })
    ).toThrow(/recorded/i);
    expect(() => view({ timeZone: null })).toThrow(/time zone/i);
  });
});

describe('the file', () => {
  it('has a column for the change, the teams, then and now and why, and no contact', () => {
    expect(CHANGES_COLUMNS).toEqual([
      'Change',
      'Division',
      'Home',
      'Away',
      'Originally',
      'Now',
      'Why',
    ]);
    const saved = savedGames({ g3: null });
    const g3 = savedGames().find((g) => g.id === 'g3');
    const result = view({
      savedGames: saved,
      auditRows: [
        overrideRow({
          id: 'a-1',
          gameId: 'x',
          game: g3,
          createdAt: AFTER,
          reasonCode: 'coach-request',
          note: 'Coach asked',
        }),
      ],
    });
    const lines = changesCsv(result).split('\n');
    expect(lines[0]).toBe(CHANGES_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(CHANGE_LABEL[CHANGE_KIND.REMOVED]);
    expect(lines[1]).toContain('Coach request');
    // The note is free text and a file leaves the app: the reason and who and when are in the file, the note is not.
    expect(lines[1]).not.toContain('Coach asked');
    expect(lines[1]).toContain('Synthetic Admin');
    expect(changesCsv(result)).not.toMatch(/e-?mail|phone|@/i);
  });
});
