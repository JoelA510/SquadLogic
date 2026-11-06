/**
 * Loads `fixtures/schedule-2026/` the way the importer receives it: a header row and rows of text
 * from a CSV parser (the browser uses `papaparse`; so does this), the league as the importer's
 * mapping step sees it (`teams.csv` and `venues.csv` become divisions, teams with coaches,
 * venues and fields with ids), and the season the files are judged against.
 *
 * The ids are made up here (`team:U05B Team 01`) and mean nothing to the product; they stand in for
 * the uuids a database would give the same rows. Shared by the parse, mapping and audit suites so
 * the three read one league.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { FIXTURE_SEASON, SCHEDULE_FIXTURE_DIR } from '../../scripts/build-schedule-fixture.mjs';

/**
 * @param {string} text
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */
export function readCsvText(text) {
  const { data, meta, errors } = Papa.parse(text, { header: true, skipEmptyLines: true });
  if (errors.length > 0) throw new Error(`csv: ${JSON.stringify(errors[0])}`);
  return { headers: meta.fields ?? [], rows: /** @type {Record<string, string>[]} */ (data) };
}

/** @param {string} file @param {string} [dir] */
export function readFixtureFile(file, dir = SCHEDULE_FIXTURE_DIR) {
  return readCsvText(readFileSync(path.join(dir, file), 'utf8'));
}

/**
 * The league a fixture's `teams.csv` and `venues.csv` describe.
 *
 * @param {{ rows: Record<string, string>[] }} teamsCsv
 * @param {{ rows: Record<string, string>[] }} venuesCsv
 */
export function leagueOf(teamsCsv, venuesCsv) {
  const divisionNames = [...new Set(teamsCsv.rows.map((t) => t.Division))];
  const venueNames = [...new Set(venuesCsv.rows.map((v) => v.Venue))];
  return {
    divisions: divisionNames.map((name) => ({ id: `div:${name}`, name })),
    teams: teamsCsv.rows.map((t) => ({
      id: `team:${t.Team}`,
      name: t.Team,
      divisionId: `div:${t.Division}`,
      isExternal: false,
      coachIds: [t['Coach 1'], t['Coach 2'], t['Coach 3']]
        .filter((name) => name !== '')
        .map((name) => `coach:${name}`),
    })),
    venues: venueNames.map((name) => ({ id: `venue:${name}`, name })),
    fields: venuesCsv.rows.map((v) => ({
      id: `field:${v.Venue}|${v.Field}`,
      venueId: `venue:${v.Venue}`,
      name: v.Field,
    })),
  };
}

/** The shipped fixture, parsed once per import of this module. */
export function loadScheduleFixture() {
  const schedule = readFixtureFile('schedule.csv');
  const invalid = readFixtureFile('schedule-invalid.csv');
  const teams = readFixtureFile('teams.csv');
  const venues = readFixtureFile('venues.csv');
  return {
    schedule,
    invalid,
    teams,
    venues,
    league: leagueOf(teams, venues),
    season: FIXTURE_SEASON,
  };
}

/**
 * The admin's decisions for a fixture's proposals, as the fixture's story needs them: every team
 * label no own team carries is an outside club (the importer never decides that itself), and
 * nothing else is decided (a label that matches exactly one record maps on its own).
 *
 * @param {{ teams: Array<{ key: string, status: string }> }} proposal
 */
export function outsideDecisionsFor(proposal) {
  /** @type {Record<string, { action: 'outside' }>} */
  const teams = {};
  for (const entry of proposal.teams)
    if (entry.status === 'none') teams[entry.key] = { action: 'outside' };
  return { teams };
}
