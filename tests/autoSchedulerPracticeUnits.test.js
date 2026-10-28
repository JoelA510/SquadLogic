// @vitest-environment node
/**
 * Phase D PR B (plan `docs/changes/2026-10-27-phase-d-scheduling.md`, B2): the auto-scheduler
 * places practice UNITS, not teams.
 *
 * A division says how many practices a week its teams get (`practicesPerWeek`) and how long each is
 * (`practiceMinutes`). A team that is short of practices has a unit for each, on a different weekday
 * and in a slot of exactly that length; what cannot be placed comes back unplaced, one entry per
 * missing practice, with a reason. A division at one a week with no length runs exactly as before
 * (`tests/autoSchedulerDatedSweep.test.js` holds the corpus; the first test here holds the
 * equivalence on this file's fixture).
 *
 * These execute the Edge Function's own solver and planner. Every subject set is enumerated from the
 * roster and the fixture's slots, never from the solver's output.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import {
  NOT_ENOUGH_DAYS_REASON,
  PRACTICE_LENGTH_REASON,
  NO_LIVE_DATE_REASON,
  practiceUnitsFor,
  runPracticeOptimizer,
  unitIdOf,
} from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  checkHardConstraints,
  practiceLengthRefuses,
  prepareTeam,
} from '../supabase/functions/_shared/engines/practice-coaches.js';
import {
  classifyTeamsForRun,
  planTeamsForRun,
} from '../supabase/functions/_shared/engines/practice-lock.js';
import {
  DEFAULT_PRACTICE_SETTINGS,
  applyPracticeSettings,
  loadTeamPracticeSettings,
  parseTeamPracticeSettings,
} from '../supabase/functions/_shared/engines/practice-division-settings.js';
import { toDaylightSlot } from '../supabase/functions/_shared/engines/practice-daylight.js';
import { seasonLongDating } from './fixtures/solverDatedCases.js';
import {
  PRACTICE_UNPLACED_REASON,
  describeUnplacedReason,
} from '../packages/core/src/practiceUnplacedReasons.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const CONFIG = { timeBudgetMs: 20000, maxIterations: 200, seed: 7 };

/**
 * A weekly slot: `day` (0 = Monday 2026-09-07), start hour and length in minutes, in UTC. Every
 * slot runs from its own first occurrence to the end of November.
 */
function slot(id, day, startHour, minutes = 60, capacity = 1) {
  const start = new Date(Date.UTC(2026, 8, 7 + day, startHour, 0, 0));
  return { id, day: DAYS[day], start, end: new Date(start.getTime() + minutes * 60_000), capacity };
}

const dating = (slots) =>
  seasonLongDating(slots, toDaylightSlot, {
    timeZone: 'UTC',
    until: '2026-11-30',
    liveFrom: '2026-09-01',
  });

/** A team of division U10, with the practice settings the Edge function would load. */
const team = (id, coach, settings = {}) => ({
  ...prepareTeam({ id, division: 'U10', coachId: coach }),
  ...settings,
});

/**
 * @param {{ teams: any[], slots: any[], locked?: any[], unitsNeeded?: Record<string, number>, placeable?: string[] }} args
 */
async function run({ teams, slots, locked = [], unitsNeeded, placeable }) {
  return runPracticeOptimizer({
    teams,
    slots,
    locked,
    placeableTeamIds: placeable ?? teams.map((t) => t.id),
    ...(unitsNeeded ? { unitsNeeded } : {}),
    dating: dating(slots),
    config: CONFIG,
  });
}

/** The weekday of a placement, from the slot it names. */
const weekdayOf = (slots, placement) => slots.find((s) => s.id === placement.slotId).day;

const strip = (r) => JSON.stringify({ ...r, elapsedMs: 0 });

describe('a division at one practice a week runs as it did before', () => {
  it('naming one unit per team (or none) is the same run, byte for byte', async () => {
    const slots = [slot('mon', 0, 17), slot('tue', 1, 17), slot('wed', 2, 17), slot('thu', 3, 17)];
    const teams = ['a', 'b', 'c'].map((id) => team(id, `c-${id}`));
    const plain = await run({ teams, slots });
    const named = await run({ teams, slots, unitsNeeded: { a: 1, b: 1, c: 1 } });
    // Settings the Edge function would attach, at their defaults, change nothing either.
    const defaulted = await run({
      teams: applyPracticeSettings(teams, new Map()).teams,
      slots,
      unitsNeeded: { a: 1, b: 1, c: 1 },
    });
    assert.equal(plain.placements.length, 3);
    assert.equal(strip(named), strip(plain));
    assert.equal(strip(defaulted), strip(plain));
    // Nothing in the output names a unit: a unit that is its team's id says nothing extra.
    assert.ok(plain.placements.every((p) => !('unitId' in p)));
    assert.deepEqual(DEFAULT_PRACTICE_SETTINGS, { practicesPerWeek: 1, practiceMinutes: null });
  });

  it('a unit that is the team id is the whole mapping at one a week', () => {
    assert.deepEqual(practiceUnitsFor(['a', 'b']), [
      { unitId: 'a', teamId: 'a' },
      { unitId: 'b', teamId: 'b' },
    ]);
    assert.deepEqual(practiceUnitsFor(['a', 'b'], { a: 2, b: 0 }), [
      { unitId: 'a#1', teamId: 'a' },
      { unitId: 'a#2', teamId: 'a' },
    ]);
    assert.deepEqual(practiceUnitsFor(['a'], { a: 1 }), [{ unitId: 'a', teamId: 'a' }]);
    assert.throws(() => practiceUnitsFor(['a'], { a: -1 }), /needs -1 practice units/);
  });
});

describe('two practices a week land on two different weekdays', () => {
  it('a division at 2 with five open weekdays places 2 per team on 2 weekdays', async () => {
    const slots = DAYS.flatMap((_, d) => [16, 17, 18].map((h) => slot(`s-${d}-${h}`, d, h)));
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const teams = ids.map((id) =>
      team(id, `c-${id}`, { practicesPerWeek: 2, practiceMinutes: 60 })
    );
    const result = await run({
      teams,
      slots,
      unitsNeeded: Object.fromEntries(ids.map((id) => [id, 2])),
    });
    assert.deepEqual(result.unassigned, []);
    for (const id of ids) {
      const mine = result.placements.filter((p) => p.teamId === id);
      assert.equal(mine.length, 2, `${id} was given ${mine.length} practices`);
      assert.deepEqual(
        mine.map(unitIdOf).sort(),
        [`${id}#1`, `${id}#2`],
        `${id}'s units are not both placed`
      );
      assert.equal(
        new Set(mine.map((p) => weekdayOf(slots, p))).size,
        2,
        `${id} practises twice on one weekday`
      );
      // Each unit has its own judged range, keyed by the unit, never the team.
      for (const p of mine) assert.ok(result.placementRanges[unitIdOf(p)], unitIdOf(p));
    }
    assert.equal(result.placements.length, 12);
  });

  it('the second practice skips another slot on the first one’s weekday', async () => {
    // Order matters: the greedy seed takes the first legal slot, so without the rule unit 2 would
    // take the second Monday slot.
    const slots = [slot('mon-a', 0, 16), slot('mon-b', 0, 18), slot('tue-a', 1, 16)];
    const t = team('t', 'c-t', { practicesPerWeek: 2 });
    const result = await run({ teams: [t], slots, unitsNeeded: { t: 2 } });
    assert.deepEqual(result.placements.map((p) => [unitIdOf(p), p.slotId]).sort(), [
      ['t#1', 'mon-a'],
      ['t#2', 'tue-a'],
    ]);
  });

  it('a team holding 1 of 2 rows gets 1 unit, and the new one avoids the weekday it holds', async () => {
    // The team holds Tuesday 17:00; a second Tuesday slot comes first in the order.
    const slots = [slot('tue-b', 1, 19), slot('wed', 2, 17), slot('tue-a', 1, 17)];
    const t = team('t', 'c-t', { practicesPerWeek: 2 });
    const locked = [
      {
        assignmentId: 'row',
        teamId: 't',
        slotId: 'tue-a',
        effectiveDateRange: '[2026-09-01,2026-12-01)',
      },
    ];
    const plan = planTeamsForRun(
      ['t'],
      [{ id: 'row', teamId: 't', slotId: 'tue-a', effectiveDateRange: null, assignedVia: 'auto' }],
      [],
      new Map([['t', 2]])
    );
    assert.deepEqual(plan.unitsNeeded, { t: 1 });
    const result = await run({ teams: [t], slots, locked, unitsNeeded: plan.unitsNeeded });
    assert.deepEqual(
      result.placements.map((p) => [p.teamId, p.slotId, 'unitId' in p]),
      [['t', 'wed', false]],
      'the new practice took Tuesday again, or the team was not given the one it was short of'
    );
    assert.deepEqual(result.unassigned, []);
  });

  it('the hill climb is not blind to a missing second practice: coverage counts practices', async () => {
    // One team wanting 2 with one weekday available: 1 of 2 placed scores 0.75, not 1.
    const slots = [slot('mon-a', 0, 16), slot('mon-b', 0, 17)];
    const t = team('t', 'c-t', { practicesPerWeek: 2 });
    const short = await run({ teams: [t], slots, unitsNeeded: { t: 2 } });
    assert.equal(short.placements.length, 1);
    assert.equal(short.bestScore, 0.75);
    // The same team given both practices scores a perfect 1.
    const open = await run({
      teams: [t],
      slots: [...slots, slot('tue-a', 1, 16)],
      unitsNeeded: { t: 2 },
    });
    assert.equal(open.placements.length, 2);
    assert.equal(open.bestScore, 1);
  });
});

describe('a practice takes a slot of exactly the division’s length', () => {
  it('a 60-minute division never takes a 45-minute slot', async () => {
    const slots = [slot('mon-45', 0, 16, 45), slot('tue-45', 1, 16, 45), slot('wed-60', 2, 16, 60)];
    const ids = ['a', 'b'];
    const teams = ids.map((id) =>
      team(id, `c-${id}`, { practicesPerWeek: 1, practiceMinutes: 60 })
    );
    const result = await run({ teams, slots, unitsNeeded: { a: 1, b: 1 } });
    // Capacity 1: one team gets the only 60-minute slot, the other is told why.
    assert.deepEqual(
      result.placements.map((p) => p.slotId),
      ['wed-60']
    );
    assert.equal(result.unassigned.length, 1);
    assert.equal(result.unassigned[0].reason, 'no-slot-available');
  });

  it('with no slot of the length at all, every unit is practice-length', async () => {
    const slots = [slot('mon', 0, 16, 60), slot('tue', 1, 16, 60)];
    const t = team('t', 'c-t', { practicesPerWeek: 2, practiceMinutes: 90 });
    const result = await run({ teams: [t], slots, unitsNeeded: { t: 2 } });
    assert.deepEqual(result.placements, []);
    assert.deepEqual(
      result.unassigned.map((u) => [u.teamId, u.unitId, u.reason]),
      [
        ['t', 't#1', PRACTICE_LENGTH_REASON],
        ['t', 't#2', PRACTICE_LENGTH_REASON],
      ]
    );
  });

  it('the length rule is the one the writer keeps, on the dated reading', () => {
    const sixty = { id: 's', span: { first: 20700, last: 20760 }, startSec: 57600, endSec: 61200 };
    assert.equal(practiceLengthRefuses({ practiceMinutes: 60 }, sixty), false);
    assert.equal(practiceLengthRefuses({ practiceMinutes: 45 }, sixty), true);
    assert.equal(practiceLengthRefuses({ practiceMinutes: null }, sixty), false);
    assert.equal(practiceLengthRefuses({}, sixty), false);
    const noHolds = checkHardConstraints(
      { id: 't', coachIds: [], practiceMinutes: 45 },
      sixty,
      new Map(),
      new Map(),
      new Map([['s', 1]])
    );
    assert.equal(noHolds, false);
  });
});

describe('what cannot be placed comes back unplaced with its reason', () => {
  it('slots on one weekday only give not-enough-days for the practice that has no second day', async () => {
    const slots = [slot('mon-a', 0, 16), slot('mon-b', 0, 17), slot('mon-c', 0, 18)];
    const t = team('t', 'c-t', { practicesPerWeek: 2 });
    const result = await run({ teams: [t], slots, unitsNeeded: { t: 2 } });
    assert.equal(result.placements.length, 1);
    assert.deepEqual(
      result.unassigned.map((u) => [u.unitId, u.reason]),
      [['t#2', NOT_ENOUGH_DAYS_REASON]]
    );
  });

  it('a division at one a week keeps the search’s own reason when no slot is left', async () => {
    const slots = [slot('mon', 0, 16)];
    const teams = [team('a', 'c-a'), team('b', 'c-b')];
    const result = await run({ teams, slots });
    assert.deepEqual(
      result.unassigned.map((u) => [u.teamId, u.reason]),
      [['b', 'no-slot-available']]
    );
    assert.ok(result.unassigned.every((u) => !('unitId' in u)));
  });

  it('with no slot dated from today every unit is no-live-date, whatever it needed', async () => {
    const slots = [slot('mon', 0, 16)];
    const t = team('t', 'c-t', { practicesPerWeek: 2 });
    const result = await runPracticeOptimizer({
      teams: [t],
      slots,
      locked: [],
      placeableTeamIds: ['t'],
      unitsNeeded: { t: 2 },
      dating: { ...dating(slots), liveFrom: '2027-06-01' },
      config: CONFIG,
    });
    assert.deepEqual(
      result.unassigned.map((u) => [u.unitId, u.reason]),
      [
        ['t#1', NO_LIVE_DATE_REASON],
        ['t#2', NO_LIVE_DATE_REASON],
      ]
    );
  });

  it('every reason the solver gives is core’s, in words an admin can read', () => {
    assert.equal(PRACTICE_LENGTH_REASON, PRACTICE_UNPLACED_REASON.PRACTICE_LENGTH);
    assert.equal(NOT_ENOUGH_DAYS_REASON, PRACTICE_UNPLACED_REASON.NOT_ENOUGH_DAYS);
    assert.equal(NO_LIVE_DATE_REASON, PRACTICE_UNPLACED_REASON.NO_LIVE_DATE);
    for (const reason of Object.values(PRACTICE_UNPLACED_REASON)) {
      assert.notEqual(describeUnplacedReason(reason), reason, `${reason} has no words`);
    }
    assert.equal(describeUnplacedReason('something-new'), 'something-new');
  });
});

describe('the plan: how many practices each team is short of, from the roster', () => {
  const rows = [
    { id: 'r1', teamId: 'held-all', slotId: 's', effectiveDateRange: null, assignedVia: 'auto' },
    { id: 'r2', teamId: 'held-all', slotId: 's2', effectiveDateRange: null, assignedVia: 'auto' },
    { id: 'r3', teamId: 'held-one', slotId: 's', effectiveDateRange: null, assignedVia: 'auto' },
    { id: 'r4', teamId: 'over', slotId: 's', effectiveDateRange: null, assignedVia: 'auto' },
    { id: 'r5', teamId: 'over', slotId: 's2', effectiveDateRange: null, assignedVia: 'auto' },
    { id: 'r6', teamId: 'tbd', slotId: 's', effectiveDateRange: null, assignedVia: 'auto' },
  ];
  const roster = ['held-all', 'held-one', 'over', 'fresh', 'none-wanted', 'tbd', 'fresh-three'];
  const targets = new Map([
    ['held-all', 2],
    ['held-one', 2],
    ['over', 1],
    ['none-wanted', 0],
    ['tbd', 2],
    ['fresh-three', 3],
  ]);

  it('each roster team lands in exactly one list, and the counts come from the division', () => {
    const plan = planTeamsForRun(roster, rows, ['tbd'], targets);
    assert.deepEqual(plan.placeable.sort(), ['fresh', 'fresh-three', 'held-one']);
    assert.deepEqual(plan.locked.sort(), ['held-all', 'over']);
    assert.deepEqual(plan.timeTbd, ['tbd']);
    assert.deepEqual(plan.noPractices, ['none-wanted']);
    assert.deepEqual(plan.unitsNeeded, { 'held-one': 1, fresh: 1, 'fresh-three': 3 });
    // The subject set is the roster: every team is in exactly one of the four lists.
    const lists = [plan.placeable, plan.locked, plan.timeTbd, plan.noPractices].flat();
    assert.deepEqual([...lists].sort(), [...roster].sort());
    // The count lowered below saved rows keeps the rows and says so (decision 10).
    assert.deepEqual(plan.overTarget, [{ teamId: 'over', target: 1, held: 2 }]);
    assert.equal(plan.targets['none-wanted'], 0);
    assert.equal(plan.held['held-all'], 2);
  });

  it('a division at one a week is classifyTeamsForRun exactly', () => {
    const one = rows.filter((r) => r.teamId !== 'over');
    const ids = ['held-all', 'held-one', 'fresh', 'tbd'];
    const classic = classifyTeamsForRun(ids, one, ['tbd']);
    // Rows count whatever their dates, so two rows at one a week is still "locked".
    const plan = planTeamsForRun(ids, one, ['tbd']);
    assert.deepEqual(
      { placeable: plan.placeable, locked: plan.locked, timeTbd: plan.timeTbd },
      classic
    );
    assert.deepEqual(plan.noPractices, []);
    assert.deepEqual(plan.unitsNeeded, { fresh: 1 });
  });

  it('a division at 0 a week places nothing and reports nothing', async () => {
    const slots = [slot('mon', 0, 16), slot('tue', 1, 16)];
    const plan = planTeamsForRun(['z'], [], [], new Map([['z', 0]]));
    assert.deepEqual(plan.placeable, []);
    assert.deepEqual(plan.noPractices, ['z']);
    const result = await run({
      teams: [team('z', 'c-z', { practicesPerWeek: 0 })],
      slots,
      placeable: plan.placeable,
      unitsNeeded: plan.unitsNeeded,
    });
    assert.deepEqual(result.placements, []);
    assert.deepEqual(result.unassigned, []);
  });
});

describe('the settings come from the store, validated', () => {
  const rowsOf = (division) => [{ id: 'team-1', divisions: division }];

  it('reads the count and the length of each team’s division', () => {
    const loaded = parseTeamPracticeSettings([
      { id: 'a', divisions: { practices_per_week: 2, practice_minutes: 60 } },
      { id: 'b', divisions: [{ practices_per_week: 0, practice_minutes: null }] },
    ]);
    assert.equal(loaded.ok, true);
    assert.deepEqual(
      [...loaded.byTeam],
      [
        ['a', { practicesPerWeek: 2, practiceMinutes: 60 }],
        ['b', { practicesPerWeek: 0, practiceMinutes: null }],
      ]
    );
  });

  it('refuses a division the table would not hold, naming the team, instead of running it', () => {
    for (const bad of [
      { practices_per_week: 8, practice_minutes: null },
      { practices_per_week: -1, practice_minutes: null },
      { practices_per_week: 1.5, practice_minutes: null },
      { practices_per_week: '2', practice_minutes: null },
      { practices_per_week: 1, practice_minutes: 14 },
      { practices_per_week: 1, practice_minutes: 241 },
      { practices_per_week: null, practice_minutes: null },
    ]) {
      const loaded = parseTeamPracticeSettings(rowsOf(bad));
      assert.equal(loaded.ok, false, JSON.stringify(bad));
      assert.equal(loaded.code, 'DIVISION_PRACTICE_SETTINGS_UNREADABLE');
      assert.match(loaded.message, /team team-1/);
    }
    assert.equal(parseTeamPracticeSettings([{ id: 'x', divisions: null }]).ok, false);
  });

  it('a team the read did not return runs at the defaults and is counted', () => {
    const applied = applyPracticeSettings(
      [{ id: 'a' }, { id: 'b' }],
      new Map([['a', { practicesPerWeek: 3, practiceMinutes: 90 }]])
    );
    assert.deepEqual(applied.teams, [
      { id: 'a', practicesPerWeek: 3, practiceMinutes: 90 },
      { id: 'b', practicesPerWeek: 1, practiceMinutes: null },
    ]);
    assert.deepEqual(applied.withoutSettings, ['b']);
  });

  it('is read as the caller, page by page, season by season, and a failed read refuses', async () => {
    const calls = [];
    const client = {
      from(table) {
        const call = { table, filters: [], ranges: [] };
        calls.push(call);
        const q = {
          select(cols) {
            call.select = cols;
            return q;
          },
          eq(col, val) {
            call.filters.push([col, val]);
            return q;
          },
          order() {
            return q;
          },
          range(from, to) {
            call.ranges.push([from, to]);
            const all = [
              { id: 'a', divisions: { practices_per_week: 2, practice_minutes: 60 } },
              { id: 'b', divisions: { practices_per_week: 1, practice_minutes: null } },
            ];
            return Promise.resolve(
              calls.length > 3
                ? { data: null, error: { message: 'boom' } }
                : { data: all.slice(from, to + 1), error: null }
            );
          },
        };
        return q;
      },
    };
    const loaded = await loadTeamPracticeSettings(client, {
      organizationId: 'org',
      seasonSettingsId: 'season',
      pageSize: 1,
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.byTeam.size, 2);
    assert.equal(calls[0].table, 'teams');
    assert.match(
      calls[0].select,
      /divisions!inner\(season_settings_id, practices_per_week, practice_minutes\)/
    );
    assert.deepEqual(calls[0].filters, [
      ['organization_id', 'org'],
      ['divisions.season_settings_id', 'season'],
    ]);
    // Page by page: a row, a row, then the empty page that ends the read.
    assert.ok(calls.length >= 3);
    const failing = await loadTeamPracticeSettings(
      {
        from: () => ({
          select: () => ({
            eq: function () {
              return this;
            },
            order: function () {
              return this;
            },
            range: () => Promise.resolve({ data: null, error: { message: 'down' } }),
          }),
        }),
      },
      { organizationId: 'org', seasonSettingsId: 'season' }
    );
    assert.equal(failing.ok, false);
    assert.equal(failing.code, 'DIVISION_PRACTICE_SETTINGS_UNREADABLE');
  });
});

describe('auto-scheduler/index.ts wiring (source pin)', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'supabase/functions/auto-scheduler/index.ts'),
    'utf8'
  );

  it('reads the settings as the caller and refuses a failed read before the plan and the solver', () => {
    assert.match(
      source,
      /loadTeamPracticeSettings\(\s*createUserClient\(req, supabaseUrl, anonKey\),\s*\{ organizationId: input\.organizationId, seasonSettingsId \}/
    );
    const guard = source.indexOf('if (!practiceSettings.ok) {');
    const plan = source.indexOf('planTeamsForRun(');
    const solve = source.indexOf('await runPracticeOptimizer(');
    assert.ok(guard >= 0 && plan > guard && solve > plan, 'the refusal does not precede the plan');
    assert.match(
      source.slice(guard, guard + 1500),
      /return jsonResponse\([\s\S]*?code: practiceSettings\.code,[\s\S]*?503/
    );
  });

  it('plans from the store’s counts, hands the solver the units, and never reads the body’s', () => {
    assert.match(
      source,
      /new Map\(withSettings\.teams\.map\(\(t\) => \[t\.id, t\.practicesPerWeek\]\)\)/
    );
    assert.match(source, /unitsNeeded: classification\.unitsNeeded,/);
    assert.doesNotMatch(source, /(?:input|body|parseResult\.data)\.[A-Za-z.]*practicesPerWeek/);
    assert.doesNotMatch(source, /(?:input|body)\.teams\.[a-z]*\([^)]*practice(?:sPerWeek|Minutes)/);
  });

  it('answers the shortfall per team and the over-target teams, from the plan’s roster', () => {
    assert.match(
      source,
      /practices: \{ teams: practiceTeams, overTarget: classification\.overTarget \},/
    );
    assert.match(source, /Object\.keys\(classification\.targets\)/);
  });
});
