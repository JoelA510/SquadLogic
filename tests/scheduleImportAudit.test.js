// @vitest-environment node
/**
 * The schedule import's conflict audit (`packages/core/src/scheduleImport/audit.js`, plan
 * `docs/changes/2026-11-03-schedule-expansion.md` section 4.4; PR 4 task D2).
 *
 * Owner's rule: conflicts in an imported schedule are ACCEPTED AND FLAGGED, never rejected. The
 * audit is how they are flagged, and it asks the Games page's own question (`evaluateGameSchedule`,
 * so the preview and the page cannot disagree about what a clash is). What it adds is the part the
 * page never had to say: **what was not looked at.**
 *
 *   - **The planted counts, from three places.** The fixture's generator records its plants, a
 *     separate all-pairs sweep (`tests/helpers/scheduleSweep.js`) recounts them from the CSV, and
 *     the audit, run through the real parse and mapping, must report the same numbers and name the
 *     same games.
 *   - **The control.** The pre-plant copy of the same fixture reports none, so the audit was able to
 *     report nothing; a result of zero is meaningful.
 *   - **A team with no coach is "not judged", never "clear"** (declared is not enforced): coach
 *     overlap is judged only for the teams that have a coach, the count is stated, and a schedule
 *     with no coaches assigned reads `not-judged`, not "0 coach clashes".
 *   - **Both sides of a game are looked at.** The fixture's coach clashes sit on an away side; a
 *     team that only ever visits is still on the schedule.
 *   - **Outside clubs** are one team row per (division, label), a merge of real teams, so being in
 *     two games at once or always visiting is legal for them (plan 4.6); an own team doing either is
 *     flagged, which is the control for that.
 *
 * Statically out of reach, and so not claimed: shared space and travel time between fields, which
 * the audit says in its own words that it did not check (plan finding 8).
 */

import { describe, expect, it } from 'vitest';
import { evaluateGameSchedule } from '../packages/core/src/gameMetrics.js';
import { auditResolvedRows, auditSchedule } from '../packages/core/src/scheduleImport/audit.js';
import {
  proposeScheduleMapping,
  resolveScheduleRows,
} from '../packages/core/src/scheduleImport/mapping.js';
import { parseScheduleRows } from '../packages/core/src/scheduleImport/parseRows.js';
import {
  PLANT_COUNTS,
  buildScheduleFixture,
  FIXTURE_SEASON,
} from '../scripts/build-schedule-fixture.mjs';
import { reportOf } from './helpers/scheduleReport.js';
import { leagueOf, outsideDecisionsFor, readCsvText } from './helpers/scheduleFixtureLoad.js';
import { coachMap, sweep } from './helpers/scheduleSweep.js';

const CHECKED = 'Checked: team overlap, coach overlap, same-field overlap, hosting balance.';
const NOT_CHECKED = 'Not checked: shared space, travel time between fields.';
const ZERO = {
  'field-overlap': 0,
  'coach-conflict': 0,
  'team-double-booked': 0,
  'home-away-imbalance': 0,
};

/**
 * The fixture through the real pipeline: parse, mapping (the 43 outside labels decided), audit.
 * @param {boolean} plants
 * @param {(team: any) => any} [editTeam] changes a league team (to take its coaches away, say)
 */
function pipeline(plants, editTeam = (t) => t) {
  const built = buildScheduleFixture({ plants });
  const schedule = readCsvText(built.files['schedule.csv']);
  const teamsCsv = readCsvText(built.files['teams.csv']);
  const venuesCsv = readCsvText(built.files['venues.csv']);
  const league = leagueOf(teamsCsv, venuesCsv);
  league.teams = league.teams.map(editTeam);
  const parsed = parseScheduleRows({
    headers: schedule.headers,
    rows: schedule.rows,
    season: FIXTURE_SEASON,
  });
  const proposal = proposeScheduleMapping({ rows: parsed.rows, league });
  const resolved = resolveScheduleRows({
    rows: parsed.rows,
    league,
    decisions: outsideDecisionsFor(proposal),
  });
  const audit = auditResolvedRows({ league, rows: resolved.rows });
  return { built, schedule, teamsCsv, league, parsed, resolved, audit };
}

const planted = pipeline(true);
const control = pipeline(false);

/** Game ids (G-0001) of the games a list of audit flags names. */
const gameIdsOf = (run, flags) =>
  new Set(
    flags.flatMap((f) =>
      f.games.map((g) => run.schedule.rows[Number(g.key.slice(4)) - 1]['Game ID'])
    )
  );

describe('schedule audit: the fixture’s planted clashes, counted three ways', () => {
  it('reports the plants the generator recorded, the sweep recounted, and the report agrees', () => {
    const counts = planted.audit.counts;
    expect(counts).toEqual({
      'field-overlap': PLANT_COUNTS.sameFieldOverlaps,
      'coach-conflict': PLANT_COUNTS.coachClashes,
      'team-double-booked': 0,
      'home-away-imbalance': PLANT_COUNTS.hostingImbalances,
    });
    // the independent sweep, from the CSV text alone
    const found = sweep(planted.schedule.rows, coachMap(planted.teamsCsv.rows));
    expect(found.fieldClashes).toHaveLength(counts['field-overlap']);
    expect(found.coachClashes).toHaveLength(counts['coach-conflict']);
    expect(found.teamClashes).toHaveLength(counts['team-double-booked']);
    expect(found.imbalanced).toHaveLength(counts['home-away-imbalance']);
    // and the Games page's own report, asked directly, in the legacy team shape
    const direct = reportOf(planted.schedule.rows, planted.teamsCsv.rows).byType;
    for (const type of Object.keys(ZERO)) expect(counts[type]).toBe(direct[type] ?? 0);
  });

  it('names the same games the generator planted and the sweep flagged', () => {
    const byType = (type) => planted.audit.flags.filter((f) => f.type === type);
    expect(gameIdsOf(planted, byType('field-overlap'))).toEqual(
      new Set(planted.built.plants.sameFieldOverlaps.gameIds)
    );
    expect(gameIdsOf(planted, byType('coach-conflict'))).toEqual(
      new Set(planted.built.plants.coachClashes.gameIds)
    );
    const found = sweep(planted.schedule.rows, coachMap(planted.teamsCsv.rows));
    const sweepCoachGames = new Set(
      found.coachClashes.flatMap((c) => c.hits.flat().map((h) => h.id))
    );
    expect(gameIdsOf(planted, byType('coach-conflict'))).toEqual(sweepCoachGames);
    expect(byType('home-away-imbalance')).toHaveLength(PLANT_COUNTS.hostingImbalances);
  });

  it('looks at the away side: every planted coach clash names its away game, with its role', () => {
    const clashes = planted.audit.flags.filter((f) => f.type === 'coach-conflict');
    expect(clashes).toHaveLength(PLANT_COUNTS.coachClashes);
    for (const clash of clashes) {
      expect(clash.games).toHaveLength(2);
      for (const g of clash.games) expect(['home', 'away']).toContain(g.role);
      // the generator moves the coach's AWAY-side game onto the other team's game
      expect(clash.games.some((g) => g.role === 'away')).toBe(true);
    }
  });

  it('says what it could not judge: the planted game with no time', () => {
    const blank = planted.built.plants.blankTimes.gameIds[0];
    expect(planted.audit.coverage.gamesNotJudged).toHaveLength(1);
    const [only] = planted.audit.coverage.gamesNotJudged;
    expect(planted.schedule.rows[Number(only.key.slice(4)) - 1]['Game ID']).toBe(blank);
    expect(only.reason).toBe('no-time');
    expect(planted.audit.coverage.gamesAudited).toBe(573);
    expect(planted.audit.checks.teamOverlap).toBe('partly-judged'); // none found, one game unchecked
    expect(planted.audit.checks.fieldOverlap).toBe('flagged');
    expect(planted.audit.checks.coachOverlap).toBe('flagged');
    expect(planted.audit.checks.hostingBalance).toBe('flagged');
  });
});

describe('schedule audit: the control reports none', () => {
  it('finds nothing in the pre-plant copy of the same fixture, and judged all of it', () => {
    expect(control.audit.counts).toEqual(ZERO);
    expect(control.audit.flags).toEqual([]);
    expect(control.audit.warnings).toEqual([]);
    expect(control.audit.coverage.gamesAudited).toBe(574);
    expect(control.audit.coverage.gamesNotJudged).toEqual([]);
    expect(control.audit.checks).toEqual({
      teamOverlap: 'clear',
      coachOverlap: 'clear',
      fieldOverlap: 'clear',
      hostingBalance: 'clear',
    });
    // the sweep agrees, so "none" is not an artefact of the audit
    const found = sweep(control.schedule.rows, coachMap(control.teamsCsv.rows));
    expect(found.fieldClashes.length + found.coachClashes.length + found.imbalanced.length).toBe(0);
    expect(found.examined.games).toBe(574);
  });

  it('states its coverage in words, with the count of teams a coach check could judge', () => {
    const coach =
      'Coach overlap was judged only for the teams that have a coach assigned (132 of 132 teams).';
    const outside = '43 outside teams are not judged for team overlap or hosting balance.';
    expect(control.audit.sentence).toBe(`${CHECKED} ${NOT_CHECKED} ${coach} ${outside}`);
    expect(planted.audit.sentence).toBe(
      `${CHECKED} ${NOT_CHECKED} ${coach} ${outside} 1 game with no time was not checked.`
    );
    expect(control.audit.coverage.checked).toEqual([
      'team overlap',
      'coach overlap',
      'same-field overlap',
      'hosting balance',
    ]);
    expect(control.audit.coverage.notChecked).toEqual([
      'shared space',
      'travel time between fields',
    ]);
  });

  it('counts the outside clubs apart from the 132 own teams', () => {
    expect(control.audit.coverage.teams).toMatchObject({
      own: 132,
      outside: 43,
      coachJudged: 132,
      coachNotJudged: [],
    });
    expect(control.audit.coverage.teams.onSchedule).toBe(132 + 43);
    expect(control.audit.coverage.teams.withoutGames).toEqual([]);
  });
});

describe('schedule audit: a team with no coach is not judged, never clear', () => {
  const withoutCoaches = (ids) => (t) => (ids.has(t.id) ? { ...t, coachIds: [] } : t);

  it('lists the coachless teams and does not call the coach check clear', () => {
    const some = new Set(planted.league.teams.slice(0, 5).map((t) => t.id));
    const run = pipeline(false, withoutCoaches(some));
    expect(run.audit.counts['coach-conflict']).toBe(0);
    expect(run.audit.coverage.teams.coachJudged).toBe(127);
    expect(run.audit.coverage.teams.coachNotJudged.map((t) => t.teamId).sort()).toEqual(
      [...some].sort()
    );
    for (const t of run.audit.coverage.teams.coachNotJudged) expect(t.reason).toBe('no-coach');
    expect(run.audit.checks.coachOverlap).toBe('partly-judged');
    expect(run.audit.checks.coachOverlap).not.toBe('clear');
    expect(run.audit.sentence).toContain('(127 of 132 teams)');
    // the other checks are untouched by it
    expect(run.audit.checks.teamOverlap).toBe('clear');
  });

  it('a schedule with no coaches at all reads not-judged, not "0 coach clashes"', () => {
    const all = new Set(planted.league.teams.map((t) => t.id));
    const run = pipeline(true, withoutCoaches(all));
    expect(run.audit.counts['coach-conflict']).toBe(0);
    expect(run.audit.coverage.teams.coachJudged).toBe(0);
    expect(run.audit.coverage.teams.coachNotJudged).toHaveLength(132);
    expect(run.audit.checks.coachOverlap).toBe('not-judged');
    expect(run.audit.sentence).toContain('(0 of 132 teams)');
    // the planted clashes of the other kinds are still found
    expect(run.audit.counts['field-overlap']).toBe(PLANT_COUNTS.sameFieldOverlaps);
  });

  it('the planted coach clashes vanish when their teams lose their coaches, and the audit says why', () => {
    const clashTeams = new Set(
      planted.audit.flags
        .filter((f) => f.type === 'coach-conflict')
        .flatMap((f) => f.games.map((g) => g.teamId))
    );
    expect(clashTeams.size).toBeGreaterThanOrEqual(PLANT_COUNTS.coachClashes);
    const run = pipeline(true, withoutCoaches(new Set([...clashTeams].map((id) => id))));
    expect(run.audit.counts['coach-conflict']).toBe(0);
    expect(run.audit.checks.coachOverlap).toBe('partly-judged');
    const unjudged = new Set(run.audit.coverage.teams.coachNotJudged.map((t) => t.teamId));
    for (const id of clashTeams) expect(unjudged.has(id)).toBe(true);
  });

  it('a coachless team that only ever visits is still on the schedule and still not judged', () => {
    const on = (day) => `2026-09-${day}T09:00:00-07:00`;
    const to = (day) => `2026-09-${day}T10:00:00-07:00`;
    const result = auditSchedule({
      games: [
        {
          key: 'g1',
          weekIndex: 1,
          division: 'D',
          fieldId: 'f1',
          start: on('12'),
          end: to('12'),
          homeTeamId: 'y',
          awayTeamId: 'x',
        },
        {
          key: 'g2',
          weekIndex: 2,
          division: 'D',
          fieldId: 'f1',
          start: on('19'),
          end: to('19'),
          homeTeamId: 'z',
          awayTeamId: 'x',
        },
      ],
      teams: [
        { id: 'x', division: 'D', coachIds: [] },
        { id: 'y', division: 'D', coachIds: ['c1'] },
        { id: 'z', division: 'D', coachIds: ['c2'] },
      ],
    });
    expect(result.coverage.teams.onSchedule).toBe(3);
    expect(result.coverage.teams.coachJudged).toBe(2);
    expect(result.coverage.teams.coachNotJudged).toEqual([{ teamId: 'x', reason: 'no-coach' }]);
    expect(result.checks.coachOverlap).toBe('partly-judged');
    // x visits both times, so the hosting check does flag x (the only thing found)
    expect(result.counts).toEqual({ ...ZERO, 'home-away-imbalance': 1 });
    expect(result.flags.map((f) => f.subjectId)).toEqual(['x']);
  });

  it('a coach on a team with no timed game is not judged either, for a different reason', () => {
    const result = auditSchedule({
      games: [
        {
          key: 'g1',
          weekIndex: 1,
          division: 'D',
          fieldId: null,
          start: null,
          end: null,
          homeTeamId: 'y',
          awayTeamId: 'x',
        },
      ],
      teams: [
        { id: 'x', division: 'D', coachIds: ['c1'] },
        { id: 'y', division: 'D', coachIds: ['c2'] },
      ],
    });
    expect(result.coverage.gamesNotJudged).toEqual([{ key: 'g1', reason: 'no-time' }]);
    expect(result.coverage.teams.coachJudged).toBe(0);
    expect(result.coverage.teams.coachNotJudged.map((t) => t.reason)).toEqual([
      'no-timed-game',
      'no-timed-game',
    ]);
    expect(result.checks.coachOverlap).toBe('not-judged');
    expect(result.checks.teamOverlap).toBe('not-judged');
  });

  it('lists a rostered team that has no game at all, instead of counting it as fine', () => {
    const result = auditSchedule({
      games: [
        {
          key: 'g1',
          weekIndex: 1,
          division: 'D',
          fieldId: 'f1',
          start: '2026-09-12T09:00:00-07:00',
          end: '2026-09-12T10:00:00-07:00',
          homeTeamId: 'a',
          awayTeamId: 'b',
        },
      ],
      teams: [
        { id: 'a', division: 'D', coachIds: ['c1'] },
        { id: 'b', division: 'D', coachIds: ['c2'] },
        { id: 'lonely', division: 'D', coachIds: ['c3'] },
      ],
    });
    expect(result.coverage.teams.withoutGames).toEqual(['lonely']);
    expect(result.coverage.teams.onSchedule).toBe(2);
  });
});

describe('schedule audit: outside clubs are merged teams', () => {
  const at = (day, h) => `2026-09-${day}T${h}:00:00-07:00`;
  const g = (key, week, day, h, field, home, away) => ({
    key,
    weekIndex: week,
    division: 'D',
    fieldId: field,
    start: at(day, h),
    end: at(day, String(Number(h) + 1).padStart(2, '0')),
    homeTeamId: home,
    awayTeamId: away,
  });
  // The visitor plays two games at once (two real teams under one label) and only ever visits.
  const games = [
    g('g1', 1, '12', '09', 'f1', 'o1', 'visitor'),
    g('g2', 1, '12', '09', 'f2', 'o2', 'visitor'),
    g('g3', 2, '19', '09', 'f1', 'o3', 'visitor'),
    g('g4', 3, '26', '09', 'f1', 'o4', 'visitor'),
    g('g5', 4, '03', '10', 'f1', 'o5', 'visitor'),
  ];
  const own = ['o1', 'o2', 'o3', 'o4', 'o5'].map((id) => ({
    id,
    division: 'D',
    coachIds: [`c-${id}`],
  }));

  it('does not flag an outside team for overlap or for always visiting', () => {
    const result = auditSchedule({
      games,
      teams: [...own, { id: 'visitor', division: 'D', coachIds: [], isExternal: true }],
    });
    expect(result.counts['team-double-booked']).toBe(0);
    expect(result.counts['home-away-imbalance']).toBe(0);
    expect(result.warnings.map((w) => w.type)).toEqual([]);
    expect(result.coverage.teams).toMatchObject({ own: 5, outside: 1, onSchedule: 6 });
    expect(result.sentence).toContain('1 outside team');
  });

  it('flags the same shape for an own team, so the exemption is the only difference', () => {
    const result = auditSchedule({
      games,
      teams: [...own, { id: 'visitor', division: 'D', coachIds: ['cv'] }],
    });
    expect(result.counts['team-double-booked']).toBe(1);
    expect(result.counts['home-away-imbalance']).toBe(1);
    const flagged = result.flags.filter((f) => f.type === 'team-double-booked');
    expect(flagged[0].subjectId).toBe('visitor');
  });

  it('still flags a field clash and a coach clash that involve an outside team’s game', () => {
    const clash = auditSchedule({
      games: [
        g('a', 1, '12', '09', 'f1', 'o1', 'visitor'),
        g('b', 1, '12', '09', 'f1', 'o2', 'visitor2'),
      ],
      teams: [
        ...own,
        { id: 'visitor', division: 'D', coachIds: [], isExternal: true },
        { id: 'visitor2', division: 'D', coachIds: [], isExternal: true },
      ],
    });
    expect(clash.counts['field-overlap']).toBe(1);
  });
});

describe('schedule audit: the report it wraps, and what it refuses', () => {
  it('equals the Games page’s report over the same games, type by type (a twin)', () => {
    const direct = reportOf(planted.schedule.rows, planted.teamsCsv.rows);
    expect(direct.gameCount).toBe(573);
    expect(Object.keys(direct.byType).sort()).toEqual([
      'coach-conflict',
      'field-overlap',
      'home-away-imbalance',
    ]);
    for (const type of Object.keys(ZERO))
      expect(planted.audit.counts[type]).toBe(direct.byType[type] ?? 0);
    // and the warnings it carries are the report's own, with the same details
    const viaEvaluator = planted.audit.warnings.map((w) => w.type).sort();
    expect(viaEvaluator).toEqual(direct.warnings.map((w) => w.type).sort());
  });

  it('runs the evaluator it claims to: a count moves when the evaluator’s does', () => {
    // a control for the twin above: change one game so a clash appears, and both move together
    const rows = planted.schedule.rows.map((r) => ({ ...r }));
    const touched = new Set(Object.values(planted.built.plants).flatMap((p) => p.gameIds));
    const free = (r) => r['Start Time'] !== '' && !touched.has(r['Game ID']);
    const victim = rows.find((r) => free(r) && r.Venue === 'Venue C' && r.Field === 'Field 1');
    const other = rows.find(
      (r) =>
        free(r) &&
        r.Date === victim.Date &&
        r['Game ID'] !== victim['Game ID'] &&
        r.Venue !== victim.Venue
    );
    other.Venue = victim.Venue;
    other.Field = victim.Field;
    other['Start Time'] = victim['Start Time'];
    other['End Time'] = victim['End Time'];
    const direct = reportOf(rows, planted.teamsCsv.rows).byType;
    const parsed = parseScheduleRows({
      headers: planted.schedule.headers,
      rows,
      season: FIXTURE_SEASON,
    });
    const proposal = proposeScheduleMapping({ rows: parsed.rows, league: planted.league });
    const resolved = resolveScheduleRows({
      rows: parsed.rows,
      league: planted.league,
      decisions: outsideDecisionsFor(proposal),
    });
    const audited = auditResolvedRows({ league: planted.league, rows: resolved.rows });
    expect(direct['field-overlap']).toBe(PLANT_COUNTS.sameFieldOverlaps + 1);
    expect(audited.counts['field-overlap']).toBe(direct['field-overlap']);
    expect(audited.counts['field-overlap']).not.toBe(planted.audit.counts['field-overlap']);
  });

  it('passes the evaluator’s own unknown-team warning through, and names the team', () => {
    const result = auditSchedule({
      games: [
        {
          key: 'g1',
          weekIndex: 1,
          division: 'D',
          fieldId: 'f1',
          start: '2026-09-12T09:00:00-07:00',
          end: '2026-09-12T10:00:00-07:00',
          homeTeamId: 'a',
          awayTeamId: 'ghost',
        },
      ],
      teams: [{ id: 'a', division: 'D', coachIds: [] }],
    });
    expect(result.warnings.map((w) => w.type)).toContain('unknown-team');
    expect(result.coverage.teams.unknown).toEqual(['ghost']);
  });

  it('refuses input that is not what it says, and a repeated game key', () => {
    const game = {
      key: 'g1',
      weekIndex: 1,
      division: 'D',
      fieldId: 'f1',
      start: '2026-09-12T09:00:00-07:00',
      end: '2026-09-12T10:00:00-07:00',
      homeTeamId: 'a',
      awayTeamId: 'b',
    };
    const teams = [
      { id: 'a', division: 'D', coachIds: [] },
      { id: 'b', division: 'D', coachIds: [] },
    ];
    // @ts-expect-error -- deliberately not an array
    expect(() => auditSchedule({ games: 'x', teams })).toThrow(TypeError);
    // @ts-expect-error -- deliberately not an array
    expect(() => auditSchedule({ games: [game], teams: null })).toThrow(TypeError);
    expect(() => auditSchedule({ games: [{ ...game, key: '' }], teams })).toThrow(/key/);
    expect(() => auditSchedule({ games: [game, { ...game }], teams })).toThrow(/g1/);
    expect(auditSchedule({ games: [], teams }).checks.teamOverlap).toBe('not-judged');
  });

  it('does not modify its inputs', () => {
    const games = [
      {
        key: 'g1',
        weekIndex: 1,
        division: 'D',
        fieldId: 'f1',
        start: '2026-09-12T09:00:00-07:00',
        end: '2026-09-12T10:00:00-07:00',
        homeTeamId: 'a',
        awayTeamId: 'b',
      },
    ];
    const teams = [
      { id: 'a', division: 'D', coachIds: ['c'] },
      { id: 'b', division: 'D', coachIds: [] },
    ];
    const snapshot = JSON.stringify({ games, teams });
    Object.freeze(games[0]);
    Object.freeze(teams[0]);
    auditSchedule({ games, teams });
    expect(JSON.stringify({ games, teams })).toBe(snapshot);
  });

  it('is the same as the evaluator would say on the legacy team shape (coachId and assistants)', () => {
    const at = (h) => `2026-09-12T${h}:00:00-07:00`;
    const games = [
      {
        key: 'g1',
        weekIndex: 1,
        division: 'D',
        fieldId: 'f1',
        start: at('09'),
        end: at('10'),
        homeTeamId: 'a',
        awayTeamId: 'b',
      },
      {
        key: 'g2',
        weekIndex: 1,
        division: 'D',
        fieldId: 'f2',
        start: at('09'),
        end: at('10'),
        homeTeamId: 'c',
        awayTeamId: 'd',
      },
    ];
    const teams = [
      { id: 'a', division: 'D', coachIds: ['k1', 'k2'] },
      { id: 'b', division: 'D', coachIds: [] },
      { id: 'c', division: 'D', coachIds: ['k2'] }, // k2 is a's second coach: a clash
      { id: 'd', division: 'D', coachIds: [] },
    ];
    const ours = auditSchedule({ games, teams });
    const theirs = evaluateGameSchedule({
      assignments: games.map((x) => ({ ...x, slotId: x.key, id: x.key })),
      teams: [
        { id: 'a', name: 'a', division: 'D', coachId: 'k1', assistantCoachIds: ['k2'] },
        { id: 'b', name: 'b', division: 'D' },
        { id: 'c', name: 'c', division: 'D', coachId: 'k2' },
        { id: 'd', name: 'd', division: 'D' },
      ],
    });
    expect(ours.counts['coach-conflict']).toBe(1);
    expect(theirs.warnings.filter((w) => w.type === 'coach-conflict')).toHaveLength(1);
    expect(ours.flags[0].subjectId).toBe('k2');
  });
});
