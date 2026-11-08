/**
 * The mock's in-place save and held predicate (`frontend/src/lib/mockGameIdentity.js`) held to a test oracle
 * (`tests/helpers/gameIdentityRefusal.js`, which is not shipped code) and to core's `isHeld`
 * (`packages/core/src/gameIdentity.js`) by ONE table of inputs that reaches every outcome (LESSONS_LEARNED #77; the
 * shape of `tests/mockGamePublished.test.js`). The mock and the oracle are written independently on purpose: a test that
 * imported one into the other would compare a function with itself.
 *
 * Plan `docs/changes/2026-11-06-games-table-source-of-truth.md`, I1 to I3, task A4. The database's own table is
 * `supabase/tests/game_identity.sql` (CI); this file proves the two other implementations say what it says.
 *
 * What each row of the table does:
 *   - the helper's answer (`gameIdentityRefusal`) and the mock's (`mockPersistGameSchedule`) must be the same refusal,
 *     SQLSTATE and DETAIL included, or both none;
 *   - a refusal leaves the mock's database exactly as it was, and an acceptance leaves what the database leaves: the
 *     named games keep their ids and the row count only grows by the games sent without one.
 * The meta-assertions: the table reaches every outcome (a table that reached half of them would compare half), and the
 * comparison can fail (a deliberately wrong answer is shown to be a mismatch).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHeld } from '../packages/core/src/gameIdentity.js';
import { gameIdentityRefusal } from './helpers/gameIdentityRefusal.js';
import {
  mockGameHeldIds,
  mockGameIsHeld,
  mockPersistGameSchedule,
} from '../frontend/src/lib/mockGameIdentity.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const SEASON = '00000000-0000-4000-8000-0000000000a5';
const OTHER_SEASON = '00000000-0000-4000-8000-0000000000a6'; // another, active season of the same organization
const DONE = '00000000-0000-4000-8000-0000000000c5';
const DIV = '00000000-0000-4000-8000-0000000000d1';
const DIV_DONE = '00000000-0000-4000-8000-0000000000d2';
const ADMIN = '00000000-0000-4000-8000-0000000000e1';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = [0, 1, 2, 3, 4, 5, 6].map((n) => id(1000 + n)); // T[1]..T[6] play; T[0] unused
const SLOT = Object.fromEntries([1, 2, 3, 4, 5, 6, 8, 9, 10, 11].map((n) => [n, id(2000 + n)]));
const G = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => [n, id(3000 + n)]));
const GP = id(3999); // the other organization's game

const slotRow = (n, week, hour) => ({
  id: SLOT[n],
  organization_id: ORG,
  field_id: id(4000 + (n % 2)),
  division_id: DIV,
  start: `2026-04-${String(4 + (week - 1) * 7).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`,
  end: `2026-04-${String(4 + (week - 1) * 7).padStart(2, '0')}T${String(hour + 1).padStart(2, '0')}:00:00Z`,
  week_index: week,
});

function world() {
  const slots = [
    slotRow(1, 1, 8),
    slotRow(2, 1, 10),
    slotRow(3, 1, 12),
    slotRow(4, 1, 14),
    slotRow(5, 2, 8),
    slotRow(6, 2, 10),
    slotRow(8, 2, 14),
    slotRow(9, 3, 8),
    slotRow(10, 4, 8),
    slotRow(11, 4, 10),
  ];
  const slot = (n) => slots.find((s) => s.id === SLOT[n]);
  const game = (n, home, away, slotNo, extra = {}) => ({
    id: G[n],
    organization_id: ORG,
    run_id: 'run-1',
    game_slot_id: SLOT[slotNo],
    slot_id: SLOT[slotNo],
    field_id: slot(slotNo).field_id,
    home_team_id: T[home],
    away_team_id: T[away],
    division: 'U10',
    week_index: slot(slotNo).week_index,
    start: slot(slotNo).start,
    end: slot(slotNo).end,
    assignment_source: 'auto',
    published: false,
    published_at: null,
    published_by: null,
    season_settings_id: null,
    ...extra,
  });
  return {
    organizations: [{ id: ORG }, { id: OTHER }],
    season_settings: [
      { id: SEASON, organization_id: ORG, status: 'active' },
      { id: OTHER_SEASON, organization_id: ORG, status: 'active' },
      { id: DONE, organization_id: ORG, status: 'completed' },
    ],
    divisions: [
      { id: DIV, organization_id: ORG, season_settings_id: SEASON, name: 'U10' },
      { id: DIV_DONE, organization_id: ORG, season_settings_id: DONE, name: 'U8' },
    ],
    teams: [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({
        id: T[n],
        organization_id: ORG,
        division_id: DIV,
        name: `T${n}`,
      })),
      { id: id(1007), organization_id: ORG, division_id: DIV_DONE, name: 'T7' },
      { id: id(1008), organization_id: ORG, division_id: DIV_DONE, name: 'T8' },
    ],
    game_slots: slots,
    scheduler_runs: [],
    game_assignments: [
      game(1, 1, 2, 1, { published: true, published_at: '2026-10-01T00:00:00Z' }), // T1>T2, Published
      game(2, 3, 4, 2),
      game(3, 1, 3, 5),
      game(4, 2, 4, 6),
      game(5, 5, 6, 3),
      game(6, 6, 5, 8),
      game(7, 5, 6, 4),
      // An older row, hidden (no run), where G4 may be told to go: T2>T4 at slot 8, week 2.
      game(8, 2, 4, 8, { run_id: null }),
      // Games with a stored season: 10 and 12 belong to ANOTHER season of the organization, 11 to the save's own. None is
      // Published and none is in the page's whole schedule (ALL); a case names them on purpose.
      game(10, 3, 5, 10, { season_settings_id: OTHER_SEASON }), // T3>T5, slot 10, week 4
      game(11, 2, 5, 11, { season_settings_id: SEASON }), // T2>T5, slot 11, week 4
      game(12, 1, 6, 11, { season_settings_id: OTHER_SEASON }), // T1>T6, slot 11, week 4
      // A game of the completed season.
      {
        ...game(9, 1, 2, 1),
        home_team_id: id(1007),
        away_team_id: id(1008),
        division: 'U8',
        game_slot_id: SLOT[9],
        slot_id: SLOT[9],
        week_index: 3,
      },
      // The other organization's.
      {
        ...game(1, 1, 2, 1),
        id: GP,
        organization_id: OTHER,
        home_team_id: id(1090),
        away_team_id: id(1091),
        game_slot_id: id(2090),
        slot_id: id(2090),
      },
    ],
    __slot: slot,
  };
}

/**
 * A payload item for a stored game, with its id, optionally moved to a slot or with the sides swapped.
 *
 * @param {any} db
 * @param {number} n
 * @param {{ to?: number, flip?: boolean, drop?: string[] }} [options]
 * @returns {Record<string, any>}
 */
function item(db, n, { to, flip, drop = [] } = {}) {
  const row = db.game_assignments.find((g) => g.id === G[n]);
  const moved = to ? db.__slot(to) : null;
  const base = {
    id: row.id,
    home_team_id: flip ? row.away_team_id : row.home_team_id,
    away_team_id: flip ? row.home_team_id : row.away_team_id,
    game_slot_id: moved ? moved.id : row.game_slot_id,
    field_id: moved ? moved.field_id : row.field_id,
    week_index: moved ? moved.week_index : row.week_index,
    start: moved ? moved.start : row.start,
    end: moved ? moved.end : row.end,
    source: row.assignment_source,
  };
  for (const key of drop) delete base[key];
  return base;
}
const WITHOUT_ID = { drop: ['id'] };
const ALL = [1, 2, 3, 4, 5, 6, 7];

const RUN = {
  organization_id: ORG,
  season_settings_id: SEASON,
  run_type: 'game',
  status: 'completed',
};
const ctx = {
  currentUserId: ADMIN,
  isOrgAdmin: (org) => org === ORG,
  now: new Date('2026-11-07T00:00:00Z'),
};

/** The same save with no season named (only the organization): it skips the season check. */
const SEASONLESS = { organization_id: ORG, run_type: 'game', status: 'completed' };

/**
 * One row per outcome: [label, payload, expected outcome, run]. `expected` is '' for an accepted save, else
 * `sqlstate detail`. The payloads read the world, so they are functions of it. `run` is the save's run data (default
 * {@link RUN}, which names the season).
 */
/** @type {Array<[string, (db: any) => Array<Record<string, any>>, string, Record<string, any>?]>} */
const CASES = [
  ["the page's whole schedule, carried by id", (db) => ALL.map((n) => item(db, n)), ''],
  [
    'a game moved to another slot and week by its id',
    (db) => ALL.map((n) => (n === 2 ? item(db, 2, { to: 9 }) : item(db, n))),
    '',
  ],
  [
    'a game flipped by its id',
    (db) => ALL.map((n) => (n === 3 ? item(db, 3, { flip: true }) : item(db, n))),
    '',
  ],
  [
    'two games of one pair that swap places',
    (db) =>
      ALL.map((n) =>
        n === 5 ? item(db, 5, { to: 4 }) : n === 7 ? item(db, 7, { to: 3 }) : item(db, n)
      ),
    '',
  ],
  [
    'a game sent without its id, moved: upserted on the tuple',
    (db) => ALL.map((n) => (n === 2 ? item(db, 2, { to: 9, ...WITHOUT_ID }) : item(db, n))),
    '',
  ],
  [
    'an id that is not a uuid',
    (db) => ALL.map((n) => (n === 2 ? { ...item(db, 2), id: 'review-9-abc' } : item(db, n))),
    '22023 game_identity_invalid',
  ],
  [
    'an id that is a number',
    (db) => ALL.map((n) => (n === 2 ? { ...item(db, 2), id: 42 } : item(db, n))),
    '22023 game_identity_invalid',
  ],
  [
    'a game named twice',
    (db) => [...ALL.map((n) => item(db, n)), item(db, 2, { to: 9 })],
    '22023 game_identity_repeated',
  ],
  [
    'an id that does not exist',
    (db) => ALL.map((n) => (n === 2 ? { ...item(db, 2), id: id(9) } : item(db, n))),
    '23503 game_not_found',
  ],
  [
    "another organization's id (the same refusal)",
    (db) => ALL.map((n) => (n === 2 ? { ...item(db, 2), id: GP } : item(db, n))),
    '23503 game_not_found',
  ],
  [
    'a game of another season named by its id: refused, the game named',
    (db) => [...ALL.map((n) => item(db, n)), item(db, 10)],
    `22023 game_identity_season ids=${G[10]}`,
  ],
  [
    'two games of other seasons: the first by id is named',
    (db) => [...ALL.map((n) => item(db, n)), item(db, 12), item(db, 10)],
    `22023 game_identity_season ids=${G[10]}`,
  ],
  [
    'a game of another season, moved by its id: still refused (it would be rewritten into this season)',
    (db) => [...ALL.map((n) => item(db, n)), item(db, 10, { to: 9 })],
    `22023 game_identity_season ids=${G[10]}`,
  ],
  [
    "a game of the save's own season named by its id: accepted",
    (db) => [...ALL.map((n) => item(db, n)), item(db, 11)],
    '',
  ],
  [
    'a game with no stored season (saved before the column) named by its id: accepted',
    (db) => ALL.map((n) => item(db, n)),
    '',
  ],
  [
    // What it proves: the database compares uuid VALUES (the run's season is cast to uuid, the stored one is a uuid
    // column), so the same season spelled in capitals by the caller is the same season and is accepted. The mock holds
    // ids as text and must fold case to say the same; a comparison on the raw strings would refuse game 11 here.
    "the save's own season spelled in capitals: the same season, so a game stored in it is accepted",
    (db) => [...ALL.map((n) => item(db, n)), item(db, 11)],
    '',
    { ...RUN, season_settings_id: SEASON.toUpperCase() },
  ],
  [
    'a save that names no season skips the check: a game of another season is accepted',
    (db) => [...ALL.map((n) => item(db, n)), item(db, 10)],
    '',
    SEASONLESS,
  ],
  [
    'the season is checked after the id exists: an unknown id wins over a game of another season',
    (db) => [
      ...ALL.map((n) => (n === 2 ? { ...item(db, 2), id: id(9) } : item(db, n))),
      item(db, 10),
    ],
    '23503 game_not_found',
  ],
  [
    'the season is checked before the clash: a game of another season wins over a game moved onto an older row',
    (db) => [...ALL.map((n) => (n === 4 ? item(db, 4, { to: 8 }) : item(db, n))), item(db, 10)],
    `22023 game_identity_season ids=${G[10]}`,
  ],
  [
    'a game moved onto an older hidden row of the same pair',
    (db) => ALL.map((n) => (n === 4 ? item(db, 4, { to: 8 }) : item(db, n))),
    `22023 game_identity_conflict ids=${G[4]},${G[8]}`,
  ],
  [
    'a game moved onto an older hidden row AND onto the place of a new game of the same save: the stored row is named, the new game is not',
    // The clashes are (X, H) and (X, no second game). The database orders them by first id, then second id NULLS LAST, so the
    // one that names two games comes first; a sentinel that sorted "no second game" first would answer `ids=X` alone.
    (db) => [
      ...ALL.map((n) => (n === 4 ? item(db, 4, { to: 8 }) : item(db, n))),
      { ...item(db, 4, { to: 8 }), id: undefined },
    ],
    `22023 game_identity_conflict ids=${G[4]},${G[8]}`,
  ],
  [
    'two games of one pair sent to one place',
    (db) =>
      ALL.map((n) =>
        n === 5 ? item(db, 5, { to: 9 }) : n === 7 ? item(db, 7, { to: 9 }) : item(db, n)
      ),
    `22023 game_identity_conflict ids=${G[5]},${G[7]}`,
  ],
  [
    'a game moved onto the place of a new game of the same save',
    (db) => [
      ...ALL.map((n) => (n === 4 ? item(db, 4, { to: 9 }) : item(db, n))),
      { ...item(db, 4, { to: 9 }), id: undefined },
    ],
    `22023 game_identity_conflict ids=${G[4]}`,
  ],
  [
    'a Published game left out by id and by tuple',
    (db) => ALL.filter((n) => n !== 1).map((n) => item(db, n)),
    `22023 game_published_omitted count=1 ids=${G[1]}`,
  ],
  [
    'a Published game named without its id at the place it is: carried by its tuple',
    (db) => ALL.map((n) => (n === 1 ? item(db, 1, WITHOUT_ID) : item(db, n))),
    '',
  ],
  [
    'a Published game named by its id at another place: present, then refused as a move',
    (db) => ALL.map((n) => (n === 1 ? item(db, 1, { to: 9 }) : item(db, n))),
    '22023 game_published',
  ],
  [
    'a Published game named at another place without its id: another tuple, so an omission',
    (db) => ALL.map((n) => (n === 1 ? item(db, 1, { to: 9, ...WITHOUT_ID }) : item(db, n))),
    `22023 game_published_omitted count=1 ids=${G[1]}`,
  ],
  [
    'a Published game flipped by its id',
    (db) => ALL.map((n) => (n === 1 ? item(db, 1, { flip: true }) : item(db, n))),
    '22023 game_published',
  ],
];

const asOutcome = (refusal) => (refusal ? `${refusal.sqlstate} ${refusal.detail}` : '');

describe('the mock save and the test oracle say the same thing, over one table that reaches every outcome', () => {
  it.each(CASES)('%s', (_label, payload, expected, run = RUN) => {
    const db = world();
    const items = payload(db).map((row) => JSON.parse(JSON.stringify(row)));
    const before = JSON.stringify(db.game_assignments);
    const helper = gameIdentityRefusal({
      stored: db.game_assignments,
      payload: items,
      organizationId: ORG,
      seasonId: run.season_settings_id ?? null,
    });
    const mock = mockPersistGameSchedule(db, run, items, ctx);
    expect(asOutcome(helper)).toBe(expected);
    const mockOutcome = mock.error ? `${mock.error.code} ${mock.error.details}` : '';
    expect(mockOutcome).toBe(expected);
    if (expected !== '') {
      // A refusal writes nothing: the games and the runs are exactly as they were.
      expect(JSON.stringify(db.game_assignments)).toBe(before);
      expect(db.scheduler_runs).toEqual([]);
    }
  });

  it('the table reaches every outcome it claims to (a table that reached half would compare half)', () => {
    const reached = new Set(
      CASES.map(([, payload, , run = RUN]) => {
        const db = world();
        return asOutcome(
          gameIdentityRefusal({
            stored: db.game_assignments,
            payload: payload(db).map((row) => JSON.parse(JSON.stringify(row))),
            organizationId: ORG,
            seasonId: run.season_settings_id ?? null,
          })
        )
          .replace(/ ids=.*$/, '')
          .replace(/ count=.*$/, '');
      })
    );
    expect([...reached].sort()).toEqual(
      [
        '',
        '22023 game_identity_conflict',
        '22023 game_identity_invalid',
        '22023 game_identity_repeated',
        '22023 game_identity_season',
        '22023 game_published',
        '22023 game_published_omitted',
        '23503 game_not_found',
      ].sort()
    );
  });

  it('the comparison can fail: a wrong answer is a mismatch', () => {
    const db = world();
    const items = ALL.map((n) => (n === 4 ? item(db, 4, { to: 8 }) : item(db, n)));
    const helper = gameIdentityRefusal({
      stored: db.game_assignments,
      payload: items,
      organizationId: ORG,
    });
    expect(asOutcome(helper)).not.toBe('22023 game_identity_conflict ids=wrong');
    expect(asOutcome(helper)).not.toBe('');
  });
});

describe("which clash is first: the database's byte order, not a locale's collation", () => {
  // Two stored games stand where game 2 is sent: the save names the first of them by the order the database sorts uuids in
  // (bytewise; for the lower-case uuid text the database produces, the same as comparing the strings by code unit). A
  // locale collation orders `_` before `-` where code units order `-` (45) before `_` (95), so a mock that sorted its
  // second ids with `localeCompare` would name the other game. The ids are not uuids on purpose: a collation and a code
  // unit comparison cannot disagree on two canonical lower-case uuids, so only ids like these can tell the two apart. The
  // case is the table's idea of a tie, which the real unique index would not let two stored games make; it is here to pin
  // the comparison, not a state the database reaches.
  const standIn = (db, rowId) => {
    const base = db.game_assignments.find((g) => g.id === G[2]);
    db.game_assignments.push({
      ...base,
      id: rowId,
      game_slot_id: SLOT[9],
      slot_id: SLOT[9],
      week_index: 3,
    });
  };

  it('the mock names the same second game as the oracle: the lower code unit first', () => {
    const db = world();
    standIn(db, 'a_1');
    standIn(db, 'a-2');
    const items = ALL.map((n) => (n === 2 ? item(db, 2, { to: 9 }) : item(db, n)));
    const expected = `22023 game_identity_conflict ids=${G[2]},a-2`;
    expect(
      asOutcome(
        gameIdentityRefusal({ stored: db.game_assignments, payload: items, organizationId: ORG })
      )
    ).toBe(expected);
    const mock = mockPersistGameSchedule(db, RUN, items, ctx);
    expect(`${mock.error.code} ${mock.error.details}`).toBe(expected);
    // The collation and the code units do disagree on these two ids (the case can tell them apart).
    expect('a_1'.localeCompare('a-2')).toBeLessThan(0);
    expect('a_1' < 'a-2').toBe(false);
  });

  it('the mock source holds no raw noncharacter and no locale comparison (an escape stands for the last place)', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'frontend/src/lib/mockGameIdentity.js'),
      'utf8'
    );
    expect(source).not.toMatch(/[\uFFFE\uFFFF]/u);
    expect(source).not.toMatch(/localeCompare/);
  });
});

describe('what an accepted save leaves in the mock', () => {
  /** @param {any} db @param {any[]} items @param {Record<string, any>} [run] */
  const save = (db, items, run = RUN) => mockPersistGameSchedule(db, run, items, ctx);

  it('a move by id keeps the id, adds no row, leaves no row of the pair behind and joins the new run and season', () => {
    const db = world();
    const rows = db.game_assignments.length;
    const result = save(
      db,
      ALL.map((n) => (n === 2 ? item(db, 2, { to: 9 }) : item(db, n)))
    );
    expect(result.error).toBeNull();
    expect(db.game_assignments).toHaveLength(rows);
    const moved = db.game_assignments.find((g) => g.id === G[2]);
    expect(moved).toMatchObject({
      game_slot_id: SLOT[9],
      week_index: 3,
      run_id: result.data,
      season_settings_id: SEASON,
    });
    expect(
      db.game_assignments.filter(
        (g) => [g.home_team_id, g.away_team_id].sort().join() === [T[3], T[4]].sort().join()
      )
    ).toHaveLength(1);
    expect(db.scheduler_runs.map((run) => run.id)).toEqual([result.data]);
  });

  it("a flip keeps the id with the sides swapped, and a swap puts each game at the other's place", () => {
    const db = world();
    expect(
      save(
        db,
        ALL.map((n) => (n === 3 ? item(db, 3, { flip: true }) : item(db, n)))
      ).error
    ).toBeNull();
    expect(db.game_assignments.find((g) => g.id === G[3])).toMatchObject({
      home_team_id: T[3],
      away_team_id: T[1],
    });
    const swapped = save(
      db,
      ALL.map((n) =>
        n === 5 ? item(db, 5, { to: 4 }) : n === 7 ? item(db, 7, { to: 3 }) : item(db, n)
      )
    );
    expect(swapped.error).toBeNull();
    expect(db.game_assignments.find((g) => g.id === G[5]).game_slot_id).toBe(SLOT[4]);
    expect(db.game_assignments.find((g) => g.id === G[7]).game_slot_id).toBe(SLOT[3]);
  });

  it('a game sent without its id that moves is a new row, and the old one stays where it was (as before)', () => {
    const db = world();
    const rows = db.game_assignments.length;
    const result = save(
      db,
      ALL.map((n) => (n === 2 ? item(db, 2, { to: 9, ...WITHOUT_ID }) : item(db, n)))
    );
    expect(result.error).toBeNull();
    expect(db.game_assignments).toHaveLength(rows + 1);
    expect(db.game_assignments.find((g) => g.id === G[2])).toMatchObject({
      game_slot_id: SLOT[2],
      week_index: 1,
    });
  });

  it('a season-less save leaves the stored season alone', () => {
    const db = world();
    expect(
      save(
        db,
        ALL.map((n) => item(db, n))
      ).error
    ).toBeNull();
    expect(db.game_assignments.find((g) => g.id === G[2]).season_settings_id).toBe(SEASON);
    /** @type {Record<string, any>} */
    const noSeason = { organization_id: ORG, run_type: 'game', status: 'completed' };
    expect(
      save(
        db,
        ALL.map((n) => item(db, n)),
        noSeason
      ).error
    ).toBeNull();
    expect(db.game_assignments.find((g) => g.id === G[2]).season_settings_id).toBe(SEASON);
  });

  it('a game of a completed season is refused by name and nothing is written', () => {
    const db = world();
    const before = JSON.stringify(db.game_assignments);
    const done = db.game_assignments.find((g) => g.id === G[9]);
    const result = save(db, [...ALL.map((n) => item(db, n)), { ...done, source: 'auto' }]);
    expect(result.error).toMatchObject({ code: '22023', details: 'season_completed' });
    expect(JSON.stringify(db.game_assignments)).toBe(before);
  });

  it('refuses a caller who is not signed in or not an admin, before it looks at the ids', () => {
    const db = world();
    const items = ALL.map((n) => item(db, n));
    expect(
      mockPersistGameSchedule(db, RUN, items, { ...ctx, currentUserId: null }).error.code
    ).toBe('42501');
    expect(
      mockPersistGameSchedule(db, RUN, items, { ...ctx, isOrgAdmin: () => false }).error.code
    ).toBe('42501');
    const bad = [{ ...item(db, 2), id: 'nope' }];
    expect(
      mockPersistGameSchedule(db, RUN, bad, { ...ctx, isOrgAdmin: () => false }).error.code
    ).toBe('42501');
  });
});

describe('the held predicate: the mock and core isHeld agree', () => {
  const db = world();
  const rows = db.game_assignments;

  it('every stored game is held exactly when the helper says it is, and the set form returns the same games', () => {
    const viaMock = rows
      .filter((row) => mockGameIsHeld(db, row.id))
      .map((row) => row.id)
      .sort();
    const viaHelper = rows
      .filter((row) => isHeld(row))
      .map((row) => row.id)
      .sort();
    expect(viaMock).toEqual(viaHelper);
    expect(viaMock).toEqual([G[1]]);
    expect(
      mockGameHeldIds(
        db,
        rows.map((row) => row.id)
      ).sort()
    ).toEqual(viaHelper);
  });

  it('an unknown id and no id are not held, and never null', () => {
    expect(mockGameIsHeld(db, id(9))).toBe(false);
    expect(mockGameIsHeld(db, null)).toBe(false);
    expect(mockGameIsHeld(db, undefined)).toBe(false);
    expect(mockGameHeldIds(db, [])).toEqual([]);
    expect(mockGameHeldIds(db, [null, id(9)])).toEqual([]);
  });

  it("the mock's row predicate (asked by its guard, cancel and delete team) answers as the helper does", async () => {
    const { isRowHeld } = await import('../frontend/src/lib/mockGamePublished.js');
    for (const row of [
      { published: true },
      { published: false },
      {},
      null,
      undefined,
      { published: 'true' },
      { published: 1 },
    ]) {
      expect(isRowHeld(row), JSON.stringify(row)).toBe(isHeld(row));
    }
  });
});
