/**
 * Loads `fixtures/practice-schedule-2026/` the way the practice importer receives it: a header row and
 * rows of text from a CSV parser (the browser uses `papaparse`; so does this), and the league as the
 * mapping step sees it (`teams.csv`, `surfaces.csv` and `divisions.csv` become divisions with their
 * stored practice settings, teams, locations, fields and subunits with ids). The ids are made up here
 * and mean nothing to the product; they stand in for the uuids a database would give the same rows.
 * Shared by the parse, mapping and settings suites so they read one league.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PRACTICE_FIXTURE_DIR,
  PRACTICE_FIXTURE_SEASON,
  PRACTICE_INVALID_SEASON,
} from '../../scripts/build-practice-fixture.mjs';
import { readCsvText } from './scheduleFixtureLoad.js';

/** @param {string} file @param {string} [dir] */
export function readPracticeFile(file, dir = PRACTICE_FIXTURE_DIR) {
  return readCsvText(readFileSync(path.join(dir, file), 'utf8'));
}

/**
 * @param {{ rows: Record<string, string>[] }} teamsCsv
 * @param {{ rows: Record<string, string>[] }} surfacesCsv
 * @param {{ rows: Record<string, string>[] }} divisionsCsv
 */
export function practiceLeagueOf(teamsCsv, surfacesCsv, divisionsCsv) {
  const locations = [...new Set(surfacesCsv.rows.map((s) => s.Location))];
  const fields = [...new Set(surfacesCsv.rows.map((s) => JSON.stringify([s.Location, s.Field])))];
  return {
    divisions: divisionsCsv.rows.map((d) => ({
      id: `div:${d.Division}`,
      name: d.Division,
      practicesPerWeek: Number(d['Practices Per Week']),
      practiceMinutes: Number(d['Practice Minutes']),
    })),
    teams: teamsCsv.rows.map((t) => ({
      id: `team:${t.Team}`,
      name: t.Team,
      divisionId: `div:${t.Division}`,
      isExternal: false,
    })),
    locations: locations.map((name) => ({ id: `loc:${name}`, name })),
    fields: fields.map((f) => {
      const [location, name] = JSON.parse(f);
      return { id: `field:${location}/${name}`, locationId: `loc:${location}`, name };
    }),
    subunits: surfacesCsv.rows.map((s) => ({
      id: `sub:${s.Location}/${s.Field}/${s.Subunit}`,
      fieldId: `field:${s.Location}/${s.Field}`,
      name: s.Subunit,
    })),
  };
}

/** The shipped fixture, parsed once per import of this module. */
export function loadPracticeFixture() {
  const schedule = readPracticeFile('practice-schedule.csv');
  const invalid = readPracticeFile('practice-invalid.csv');
  const aliases = readPracticeFile('aliases.csv');
  const teams = readPracticeFile('teams.csv');
  const surfaces = readPracticeFile('surfaces.csv');
  const divisions = readPracticeFile('divisions.csv');
  return {
    schedule,
    invalid,
    aliases,
    teams,
    surfaces,
    divisions,
    league: practiceLeagueOf(teams, surfaces, divisions),
    season: PRACTICE_FIXTURE_SEASON,
    invalidSeason: PRACTICE_INVALID_SEASON,
  };
}

/**
 * The admin's decisions that accept every proposal the entries show, until nothing is left to accept:
 * each entry with no effective decision and one proposed record becomes a `map` decision carrying the
 * source it came from. A field's proposals depend on its location being decided, so this runs the
 * proposal again after each round. The importer never does this itself (decision 30: none is applied
 * without the admin); this is the admin, in a test.
 *
 * @param {(decisions: Record<string, Record<string, unknown>>) => Record<string, Array<any>>} propose
 *   the mapping step's entries for a set of decisions
 * @returns {Record<string, Record<string, unknown>>}
 */
export function acceptAllProposals(propose) {
  /** @type {Record<string, Record<string, unknown>>} */
  const decisions = { divisions: {}, locations: {}, fields: {}, subunits: {}, teams: {} };
  for (let round = 0; round < 6; round += 1) {
    const proposal = propose(decisions);
    let added = 0;
    for (const group of Object.keys(decisions)) {
      for (const entry of proposal[group]) {
        if (entry.effective || !entry.proposed || entry.conflict) continue;
        const source = entry.proposals.map((p) => p.source).find((s) => s !== 'exact') ?? 'admin';
        decisions[group][entry.key] = { action: 'map', id: entry.proposed.id, source };
        added += 1;
      }
    }
    if (added === 0) return decisions;
  }
  throw new Error('acceptAllProposals: proposals kept appearing');
}
