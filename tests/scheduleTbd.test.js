/**
 * The TIME TBD list's vocabulary and boundaries (Phase D, E; `packages/core/src/scheduleTbd.js`).
 *
 * The reasons are spelled in three places: core's lists, the table's CHECK in migration
 * `20261107010000_schedule_tbd.sql`, and the game writer's list of reasons it accepts. Each is
 * compared to core's in both directions, so a reason added in one fails here until the others
 * have it. The Zod schemas are the boundaries: the RPC's rows coming in, and the entries the game
 * page sends to be recorded.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import { PRACTICE_UNPLACED_REASON } from '../packages/core/src/practiceUnplacedReasons.js';
import {
  NOT_SCHEDULED_YET,
  SCHEDULE_TBD_GAME_REASONS,
  SCHEDULE_TBD_PRACTICE_REASONS,
  describeScheduleTbdReason,
  parseGameUnscheduled,
  scheduleTbdItemsFromRows,
  scheduleTbdNote,
} from '../packages/core/src/scheduleTbd.js';
import { scheduleGames } from '../packages/core/src/gameScheduling.js';

const read = (file) => readFileSync(path.join(process.cwd(), file), 'utf8');
const MIGRATION = read('supabase/migrations/20261107010000_schedule_tbd.sql');
const REVERT = read('docs/sql/20261107010000_revert.sql');

/** The quoted words of the first `IN ( ... )` list after a marker. */
function listAfter(text, marker) {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `${marker} was not found`);
  const open = text.indexOf('IN (', at);
  const close = text.indexOf(')', open);
  return [...text.slice(open, close).matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
}

describe('the reasons: core and the SQL say the same things', () => {
  it('the table CHECK lists exactly the practice reasons and exactly the game reasons', () => {
    assert.deepEqual(
      listAfter(MIGRATION, "(kind = 'practice' AND reason IN ").sort(),
      [...SCHEDULE_TBD_PRACTICE_REASONS].sort()
    );
    assert.deepEqual(
      listAfter(MIGRATION, "OR (kind = 'game' AND reason IN ").sort(),
      [...SCHEDULE_TBD_GAME_REASONS].sort()
    );
  });

  it('the game writer accepts exactly the game reasons', () => {
    const writer = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.persist_game_schedule'));
    const at = writer.indexOf('u.reason NOT IN (');
    assert.ok(at > 0, "the game writer's reason list was not found");
    const words = [...writer.slice(at, writer.indexOf(')', at)).matchAll(/'([a-z-]+)'/g)].map(
      (m) => m[1]
    );
    assert.deepEqual(words.sort(), [...SCHEDULE_TBD_GAME_REASONS].sort());
  });

  it("the practice writer labels a row only with the auto-scheduler's own reasons (never not-scheduled-yet from a run)", () => {
    const writer = MIGRATION.slice(MIGRATION.indexOf('FUNCTION public.persist_practice_schedule'));
    const at = writer.indexOf("e.value->>'reason' IN (") + "e.value->>'reason' ".length;
    const words = [...writer.slice(at, writer.indexOf(')', at)).matchAll(/'([a-z-]+)'/g)].map(
      (m) => m[1]
    );
    assert.deepEqual(words.sort(), Object.values(PRACTICE_UNPLACED_REASON).sort());
    assert.deepEqual(
      [...SCHEDULE_TBD_PRACTICE_REASONS].sort(),
      [...Object.values(PRACTICE_UNPLACED_REASON), NOT_SCHEDULED_YET].sort()
    );
  });

  it('every game reason is one scheduleGames() can give', () => {
    const source = read('packages/core/src/gameScheduling.js');
    for (const reason of SCHEDULE_TBD_GAME_REASONS) {
      assert.ok(source.includes(`'${reason}'`), `scheduleGames never spells ${reason}`);
    }
    // And the other way: every reason the scheduler spells is recordable.
    const spelled = [
      ...source.matchAll(/reason: '([a-z-]+)'/g),
      ...source.matchAll(/encounteredConflict \? '([a-z-]+)' : '([a-z-]+)'/g),
    ].flatMap((match) => match.slice(1));
    assert.ok(spelled.length >= 6, "the pattern found the scheduler's reasons");
    for (const reason of spelled) {
      assert.ok(SCHEDULE_TBD_GAME_REASONS.includes(reason), `${reason} is not recordable`);
    }
  });

  it('every reason has words an admin can read', () => {
    for (const reason of SCHEDULE_TBD_PRACTICE_REASONS) {
      const words = describeScheduleTbdReason('practice', reason);
      assert.ok(words.length > 10 && words !== reason, `no words for practice reason ${reason}`);
    }
    for (const reason of SCHEDULE_TBD_GAME_REASONS) {
      const words = describeScheduleTbdReason('game', reason);
      assert.ok(words.length > 10 && words !== reason, `no words for game reason ${reason}`);
    }
    assert.equal(describeScheduleTbdReason('game', 'a-new-one'), 'a-new-one');
  });
});

describe('the migration is guarded and reversible', () => {
  it('guards the bodies it replaces with the md5s its revert restores', () => {
    for (const [signature, md5] of [
      [
        'persist_practice_schedule(jsonb,jsonb,boolean,jsonb,jsonb,jsonb,jsonb,text)',
        'a63d385e37a7d5e71965ba0fb093b531',
      ],
      ['persist_game_schedule(jsonb,jsonb)', '1a9ad54a5c4f4f3dc71793b53b2e4f61'],
      ['admin_delete_team(uuid)', '4e44a5dec60c5eecae4c4e47644cd610'],
    ]) {
      assert.ok(
        MIGRATION.includes(`"${signature}": "${md5}"`),
        `${signature}: the migration guard`
      );
      assert.ok(
        REVERT.includes(`"${signature}": "${md5}"`),
        `${signature}: the revert's end check`
      );
    }
  });

  it('is written for the next version after the highest on main and has a smoke, a revert and pgTAP', () => {
    for (const file of [
      'docs/sql/20261107010000_smoke.sql',
      'docs/sql/20261107010000_revert.sql',
      'supabase/tests/schedule_tbd.sql',
    ]) {
      assert.ok(read(file).length > 1000, `${file} is missing or empty`);
    }
  });
});

describe('the RPC rows become export items, or an error', () => {
  const practiceRow = {
    id: 'r1',
    kind: 'practice',
    team_id: 't1',
    team_name: 'Blue Bears',
    division_name: 'U8',
    missing_count: 2,
    reason: 'no-slot-available',
    home_team_id: null,
    away_team_id: null,
    week_index: null,
  };
  const gameRow = {
    id: 'r2',
    kind: 'game',
    home_team_id: 't2',
    away_team_id: 't1',
    week_index: 4,
    team_id: null,
    missing_count: null,
    reason: 'duplicate-matchup',
  };

  it('maps a practice row and a game row', () => {
    assert.deepEqual(scheduleTbdItemsFromRows([practiceRow, gameRow]), [
      { kind: 'practice', teamId: 't1', missingCount: 2, reason: 'no-slot-available' },
      {
        kind: 'game',
        homeTeamId: 't2',
        awayTeamId: 't1',
        weekIndex: 4,
        reason: 'duplicate-matchup',
      },
    ]);
    assert.deepEqual(scheduleTbdItemsFromRows([]), []);
  });

  it('refuses what is not a list, and a row that is not an item (an unread list is an error, never an empty one)', () => {
    assert.throws(() => scheduleTbdItemsFromRows(null), /must be an array/);
    assert.throws(() => scheduleTbdItemsFromRows([{ ...practiceRow, team_id: null }]));
    assert.throws(() => scheduleTbdItemsFromRows([{ ...practiceRow, reason: 'unknown-team' }]));
    assert.throws(() => scheduleTbdItemsFromRows([{ ...gameRow, week_index: null }]));
    assert.throws(() => scheduleTbdItemsFromRows([{ ...practiceRow, kind: 'meal' }]));
  });

  it('writes the note for each kind', () => {
    assert.match(
      scheduleTbdNote({
        kind: 'game',
        homeTeamId: 'a',
        awayTeamId: 'b',
        weekIndex: 7,
        reason: 'unknown-team',
      }),
      /week 7/
    );
  });
});

describe('the unscheduled games a save records', () => {
  it('accepts what scheduleGames() returns for a matchup it could not place', () => {
    const result = scheduleGames({
      teams: /** @type {any} */ ([
        { id: 'a', name: 'A', division: 'U8', coachIds: [] },
        { id: 'b', name: 'B', division: 'U8', coachIds: [] },
      ]),
      slots: [],
      roundRobinByDivision: {
        U8: [{ weekIndex: 1, matchups: [{ homeTeamId: 'a', awayTeamId: 'b' }], byes: [] }],
      },
    });
    assert.equal(result.unscheduled.length, 1, 'the scheduler really left a game unplaced');
    const parsed = parseGameUnscheduled(result.unscheduled);
    assert.equal(parsed[0].matchup.homeTeamId, 'a');
    assert.equal(parsed[0].reason, 'no-slot-available');
  });

  it('names the entry that cannot be recorded', () => {
    assert.throws(
      () =>
        parseGameUnscheduled([
          { weekIndex: 1, reason: 'x', matchup: { homeTeamId: 'a', awayTeamId: 'b' } },
        ]),
      /unscheduled\[0\].*reason/
    );
    assert.throws(
      () =>
        parseGameUnscheduled([
          {
            weekIndex: 0,
            reason: 'no-slot-available',
            matchup: { homeTeamId: 'a', awayTeamId: 'b' },
          },
        ]),
      /weekIndex/
    );
    assert.throws(() => parseGameUnscheduled({}), /must be an array/);
    assert.deepEqual(parseGameUnscheduled([]), []);
  });
});
