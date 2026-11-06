/**
 * What the Games page's own report (`evaluateGameSchedule`) says about a schedule CSV: the rows
 * become assignments on the season clock, own teams carry their coaches, and each outside
 * (division, label) is a team with none, as the importer stores it. Games without a time are left
 * out, as the page leaves out a game it has not placed.
 *
 * Kept apart from `scheduleSweep.js`, which is deliberately independent of the product; this
 * is the product's own answer, the thing the sweep is compared with.
 */

import { evaluateGameSchedule } from '../../packages/core/src/gameMetrics.js';
import { resolveZonedInstant } from '../../packages/core/src/timing/seasonClock.js';
import { FIXTURE_SEASON } from '../../scripts/build-schedule-fixture.mjs';

/**
 * What the Games page's own report says about a schedule: the CSV becomes assignments on the
 * season clock, own teams carry their coaches, and each outside (division, label) is a team with
 * none, as the importer will store it.
 */
export function reportOf(scheduleRows, teamRows) {
  const coachIdOf = (name) => `coach|${name}`;
  const teams = teamRows.map((t) => ({
    id: t.Team,
    division: t.Division,
    coachId: coachIdOf(t['Coach 1']),
    assistantCoachIds: [t['Coach 2'], t['Coach 3']].filter((c) => c !== '').map(coachIdOf),
  }));
  const own = new Set(teams.map((t) => t.id));
  const idOf = (r, label) => (own.has(label) ? label : `outside|${r.Division}|${label}`);
  const assignments = [];
  for (const r of scheduleRows) {
    if (r['Start Time'] === '' || r['End Time'] === '') continue;
    for (const label of [r['Home Team'], r['Away Team']]) {
      const id = idOf(r, label);
      if (!own.has(label) && !teams.some((t) => t.id === id))
        teams.push({ id, division: r.Division });
    }
    assignments.push({
      weekIndex: Number(r.Week),
      division: r.Division,
      slotId: r['Game ID'],
      id: r['Game ID'],
      start: resolveZonedInstant({
        date: r.Date,
        time: r['Start Time'],
        timeZone: FIXTURE_SEASON.timeZone,
      }).iso,
      end: resolveZonedInstant({
        date: r.Date,
        time: r['End Time'],
        timeZone: FIXTURE_SEASON.timeZone,
      }).iso,
      homeTeamId: idOf(r, r['Home Team']),
      awayTeamId: idOf(r, r['Away Team']),
      fieldId: `${r.Venue}|${r.Field}`,
    });
  }
  const { warnings } = evaluateGameSchedule({ assignments, teams });
  /** @type {Record<string, number>} */
  const byType = {};
  for (const w of warnings) byType[w.type] = (byType[w.type] ?? 0) + 1;
  return { byType, warnings, gameCount: assignments.length };
}
