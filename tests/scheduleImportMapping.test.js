// @vitest-environment node
/**
 * The schedule import's mapping step (`packages/core/src/scheduleImport/mapping.js`, plan
 * `docs/changes/2026-11-03-schedule-expansion.md` sections 4.5 and 4.6; PR 4 task D2).
 *
 * The file names teams, divisions, venues and fields the organization may not have. The step
 * proposes by one rule and never guesses:
 *
 *   - **One normaliser, and it removes no word.** `normaliseExternalLabel` (`externalImport/
 *     mapping.js`) trims, collapses spaces and folds case. Two invented labels that differ by a word
 *     (`Park Back`, `Park Front`) stay two; a label that is a prefix of another (`Park`) matches
 *     neither. A deliberately wrong resolver, written below, merges them: that is the control that
 *     shows the assertion can fail.
 *   - **Only an exact, single match is proposed.** A label equal to two records is `ambiguous` and
 *     is never mapped for the admin; a label equal to none proposes nothing. Both leave their rows
 *     `unknown-*` until the admin decides.
 *   - **A team is judged inside its division** (names are unique per division, not per
 *     organization), a field inside its venue.
 *   - **Outside opponents** (decision 5): the admin says a label is an outside club; a label
 *     that is an own team's name in that division is `label-is-own-team`, never an outside club.
 *   - **Skipped is not refused**: the admin's skip is listed apart from the importer's refusals.
 *   - **What will be created is listed, and counts only what a surviving row uses.**
 *
 * Statically out of reach, and so not claimed: that the browser step and `map_game_import_job`
 * (PR 5) agree about every id; PR 5's tests hold that.
 */

import { describe, expect, it } from 'vitest';
import { normaliseExternalLabel } from '../packages/core/src/externalImport/mapping.js';
import {
  divisionDecisionKey,
  fieldDecisionKey,
  proposeScheduleMapping,
  resolveScheduleRows,
  scheduleLabelKey,
  teamDecisionKey,
  venueDecisionKey,
} from '../packages/core/src/scheduleImport/mapping.js';
import { auditResolvedRows } from '../packages/core/src/scheduleImport/audit.js';
import { parseScheduleRows } from '../packages/core/src/scheduleImport/parseRows.js';
import { loadScheduleFixture, outsideDecisionsFor } from './helpers/scheduleFixtureLoad.js';

const SEASON = { timeZone: 'America/Los_Angeles', startDate: '2026-09-07', endDate: '2027-03-31' };
const HEADERS = [
  'Game ID',
  'Date',
  'Start Time',
  'End Time',
  'Venue',
  'Field',
  'Division',
  'Home Team',
  'Away Team',
  'Week',
];
let counter = 0;
/** A parsed-valid row; each call gets its own start time so no two are the same game. */
const fileRow = (over = {}) => {
  counter += 1;
  const start = 8 * 60 + counter * 5;
  const hhmm = (m) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return {
    'Game ID': `G-${counter}`,
    Date: '2026-09-12',
    'Start Time': hhmm(start),
    'End Time': hhmm(start + 55),
    Venue: 'Venue A',
    Field: 'Field 1',
    Division: 'U10 Boys',
    'Home Team': 'Lions',
    'Away Team': 'Tigers',
    Week: '1',
    ...over,
  };
};
const parsed = (rows) => parseScheduleRows({ headers: HEADERS, rows, season: SEASON }).rows;

const baseLeague = (over = {}) => ({
  divisions: [
    { id: 'd10', name: 'U10 Boys' },
    { id: 'd12', name: 'U12 Boys' },
  ],
  teams: [
    { id: 't-lions-10', name: 'Lions', divisionId: 'd10', isExternal: false },
    { id: 't-tigers-10', name: 'Tigers', divisionId: 'd10', isExternal: false },
    { id: 't-lions-12', name: 'Lions', divisionId: 'd12', isExternal: false },
  ],
  venues: [
    { id: 'v-a', name: 'Venue A' },
    { id: 'v-b', name: 'Venue B' },
  ],
  fields: [
    { id: 'f-a1', venueId: 'v-a', name: 'Field 1' },
    { id: 'f-a2', venueId: 'v-a', name: 'Field 2' },
    { id: 'f-b1', venueId: 'v-b', name: 'Field 1' },
  ],
  ...over,
});
const resolve = (rows, league = baseLeague(), decisions = {}) =>
  resolveScheduleRows({ rows: parsed(rows), league, decisions });
const propose = (rows, league = baseLeague(), decisions = {}) =>
  proposeScheduleMapping({ rows: parsed(rows), league, decisions });
const first = (rows, league, decisions) => resolve(rows, league, decisions).rows[0];

/** A resolver that "helpfully" drops a decorative word: the failure the normaliser exists to avoid. */
const stripDecoration = (label) =>
  normaliseExternalLabel(label)
    .replace(/\b(back|front|upper|lower)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('schedule mapping: one normaliser, and it removes no word', () => {
  it('is exactly trim, collapse and case-fold, by the shared normaliser', () => {
    for (const label of [
      'Venue A',
      '  venue   a ',
      'VENUE\tA',
      'Field 1 (Back)',
      'Park Back',
      'a',
    ]) {
      expect(scheduleLabelKey(label)).toBe(normaliseExternalLabel(label));
    }
    expect(scheduleLabelKey(undefined)).toBe('');
    expect(scheduleLabelKey(null)).toBe('');
    expect(scheduleLabelKey('   ')).toBe('');
  });

  it('keeps every word, parenthesis and digit of a label', () => {
    for (const label of [
      'Park Back',
      'Park Front',
      'Park Back Field 2',
      'Field 1 (Back)',
      'Visiting Club AE',
      'U05B  Team   01',
    ]) {
      const words = label.trim().split(/\s+/);
      expect(scheduleLabelKey(label).split(' ')).toEqual(words.map((w) => w.toLowerCase()));
    }
    expect(scheduleLabelKey('Field 1 (Back)')).not.toBe(scheduleLabelKey('Field 1'));
  });

  it('keeps two labels that differ by a word apart (Park Back, Park Front)', () => {
    expect(scheduleLabelKey('Park Back')).not.toBe(scheduleLabelKey('Park Front'));
    expect(scheduleLabelKey('Park')).not.toBe(scheduleLabelKey('Park Back'));
    // the control: a resolver that strips the decorative word merges them
    expect(stripDecoration('Park Back')).toBe(stripDecoration('Park Front'));
    expect(stripDecoration('Park Back')).toBe(stripDecoration('Park'));
  });

  it('maps Park Back and Park Front to their own venues, and Park to neither', () => {
    const league = baseLeague({
      venues: [
        { id: 'v-back', name: 'Park Back' },
        { id: 'v-front', name: 'Park Front' },
      ],
      fields: [
        { id: 'f-back-1', venueId: 'v-back', name: 'Field 1' },
        { id: 'f-front-1', venueId: 'v-front', name: 'Field 1' },
      ],
    });
    const rows = [
      fileRow({ Venue: 'Park Back' }),
      fileRow({ Venue: ' park   FRONT ' }),
      fileRow({ Venue: 'Park' }),
    ];
    const out = resolve(rows, league).rows;
    expect(out[0].ids.field).toBe('f-back-1');
    expect(out[1].ids.field).toBe('f-front-1');
    expect(out[2].status).toBe('refused');
    expect(out[2].reason).toBe('unknown-venue');
    const venues = propose(rows, league).venues;
    expect(venues.map((v) => [v.label, v.status, v.proposed?.id ?? null])).toEqual([
      ['Park', 'none', null],
      ['Park Back', 'match', 'v-back'],
      ['park   FRONT', 'match', 'v-front'],
    ]);
  });
});

describe('schedule mapping: only an exact, single match is proposed', () => {
  it('matches a team exactly, ignoring case and spacing, and maps it without being asked', () => {
    const out = resolve([fileRow({ 'Home Team': '  lions ', 'Away Team': 'TIGERS' })]).rows[0];
    expect(out.status).toBe('ok');
    expect(out.ids).toMatchObject({ home: 't-lions-10', away: 't-tigers-10', field: 'f-a1' });
    const entry = propose([fileRow({ 'Home Team': '  lions ' })]).teams.find(
      (t) => JSON.parse(t.key)[1] === 'lions'
    );
    expect(entry.status).toBe('match');
    expect(entry.proposed).toEqual({ action: 'map', id: 't-lions-10' });
    expect(entry.effective).toEqual(entry.proposed);
    expect(entry.decision).toBeNull();
  });

  it('never maps an ambiguous label: two teams with one normalised name stay unmapped', () => {
    const league = baseLeague({
      teams: [
        { id: 't-1', name: 'Team A', divisionId: 'd10' },
        { id: 't-2', name: 'team  a', divisionId: 'd10' },
        { id: 't-3', name: 'Tigers', divisionId: 'd10' },
      ],
    });
    const rows = [fileRow({ 'Home Team': 'TEAM A', 'Away Team': 'Tigers' })];
    const entry = propose(rows, league).teams.find((t) => t.label === 'TEAM A');
    expect(entry.status).toBe('ambiguous');
    expect(entry.candidates.map((c) => c.id).sort()).toEqual(['t-1', 't-2']);
    expect(entry.proposed).toBeNull();
    expect(entry.effective).toBeNull();
    const out = resolve(rows, league).rows[0];
    expect(out.status).toBe('refused');
    expect(out.reason).toBe('unknown-team');
    expect(out.ids).toBeNull();
    // the admin picks one, and only then does the row resolve
    const decided = resolve(rows, league, {
      teams: { [teamDecisionKey('U10 Boys', 'TEAM A')]: { action: 'map', id: 't-2' } },
    }).rows[0];
    expect(decided.status).toBe('ok');
    expect(decided.ids.home).toBe('t-2');
  });

  it('never maps an ambiguous venue or division either', () => {
    const league = baseLeague({
      venues: [
        { id: 'v-1', name: 'Venue A' },
        { id: 'v-2', name: 'venue a' },
      ],
      divisions: [
        { id: 'd-1', name: 'U10 Boys' },
        { id: 'd-2', name: 'u10  boys' },
      ],
      teams: [],
      fields: [],
    });
    const p = propose([fileRow()], league);
    expect(p.venues[0].status).toBe('ambiguous');
    expect(p.divisions[0].status).toBe('ambiguous');
    const out = first([fileRow()], league);
    expect(out.reason).toBe('unknown-division'); // the first thing it cannot resolve
  });

  it('judges a team inside its division: the same name in two divisions is two teams', () => {
    const rows = [
      fileRow({ Division: 'U10 Boys', 'Home Team': 'Lions', 'Away Team': 'Tigers' }),
      fileRow({ Division: 'U12 Boys', 'Home Team': 'Lions', 'Away Team': 'Lions' }),
    ];
    const out = resolve(rows).rows;
    expect(out[0].ids.home).toBe('t-lions-10');
    expect(out[1].reason).toBe('same-team'); // both labels are the one U12 team
    const u12 = first([fileRow({ Division: 'U12 Boys', 'Home Team': 'Lions' })]);
    expect(u12.status).toBe('refused'); // "Tigers" is a U10 team, not a U12 team
    expect(u12.reason).toBe('unknown-team');
    const lions = resolve([
      fileRow({ Division: 'U12 Boys', 'Home Team': 'Lions', 'Away Team': 'X' }),
    ]);
    expect(lions.rows[0].reason).toBe('unknown-team'); // X is unknown; Lions alone resolved to U12's
    const entry = propose([fileRow({ Division: 'U12 Boys', 'Home Team': 'Lions' })]).teams.find(
      (t) => t.label === 'Lions'
    );
    expect(entry.proposed).toEqual({ action: 'map', id: 't-lions-12' });
  });

  it('judges a field inside its venue: Field 1 at Venue A is not Field 1 at Venue B', () => {
    const out = resolve([
      fileRow({ Venue: 'Venue B', Field: 'Field 1' }),
      fileRow({ Field: 'Field 1' }),
    ]).rows;
    expect(out[0].ids.field).toBe('f-b1');
    expect(out[1].ids.field).toBe('f-a1');
    const noSuch = first([fileRow({ Venue: 'Venue B', Field: 'Field 2' })]);
    expect(noSuch.reason).toBe('unknown-field');
  });

  it('proposes nothing for a label that matches nothing, and lists what the admin may do', () => {
    const p = propose([fileRow({ 'Home Team': 'Unlisted', Division: 'U99', Venue: 'Venue Z' })]);
    expect(p.divisions[0]).toMatchObject({ status: 'none', proposed: null, effective: null });
    expect(p.divisions[0].options).toEqual(['map', 'create', 'skip']);
    expect(p.venues[0].options).toEqual(['map', 'create', 'skip']);
    const t = propose([fileRow({ 'Home Team': 'Unlisted' })]).teams.find(
      (e) => e.label === 'Unlisted'
    );
    expect(t).toMatchObject({ status: 'none', proposed: null });
    expect(t.options).toEqual(['map', 'create', 'outside', 'skip']);
  });

  it('never proposes for a blank label, and refuses the rows that carry one', () => {
    const rows = [fileRow({ 'Home Team': '' }), fileRow({ Division: '' }), fileRow({ Venue: '' })];
    const p = propose(rows);
    expect(p.teams.every((t) => t.label !== '')).toBe(true);
    expect(p.divisions.every((d) => d.label !== '')).toBe(true);
    // Venue '' with a field is not a TIME TBD row (the field is filled): unknown-venue
    const out = resolve(rows).rows;
    expect(out.map((r) => r.reason)).toEqual(['unknown-team', 'unknown-division', 'unknown-venue']);
    for (const r of out) expect(r.message).toMatch(/[a-z]{4}/);
  });

  it('judges a TIME TBD row for its division and teams only: no venue or field is asked of it', () => {
    const rows = [
      fileRow({ 'Start Time': '', 'End Time': '', Venue: 'Venue Z', Field: 'Field 9' }),
    ];
    const p = propose(rows);
    expect(p.venues).toEqual([]);
    expect(p.fields).toEqual([]);
    const out = resolve(rows).rows[0];
    expect(out.status).toBe('tbd');
    expect(out.ids.home).toBe('t-lions-10');
    expect(out.ids.field).toBeNull();
  });
});

describe('schedule mapping: what the admin decides', () => {
  it('maps a label to a record the admin picks, and refuses a record that is not in the league', () => {
    const rows = [fileRow({ Venue: 'The Park', Field: 'Field 1' })];
    const decided = first(rows, baseLeague(), {
      venues: { [venueDecisionKey('The Park')]: { action: 'map', id: 'v-b' } },
    });
    expect(decided.status).toBe('ok');
    expect(decided.ids.field).toBe('f-b1');
    // an id the league does not hold is never trusted
    const forged = first(rows, baseLeague(), {
      venues: { [venueDecisionKey('The Park')]: { action: 'map', id: 'v-nope' } },
    });
    expect(forged.status).toBe('refused');
    expect(forged.reason).toBe('unknown-venue');
    // nor a team from another division
    const wrongDivision = first([fileRow({ 'Home Team': 'Sharks' })], baseLeague(), {
      teams: { [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'map', id: 't-lions-12' } },
    });
    expect(wrongDivision.reason).toBe('unknown-team');
  });

  it('creates a division, a venue and a field on the admin’s word, with ids that are not the league’s', () => {
    const rows = [
      fileRow({
        Division: 'U14 Boys',
        Venue: 'Venue Q',
        Field: 'Field 7',
        'Home Team': 'Sharks',
        'Away Team': 'Rays',
      }),
    ];
    const decisions = {
      divisions: { [divisionDecisionKey('U14 Boys')]: { action: 'create' } },
      venues: { [venueDecisionKey('Venue Q')]: { action: 'create' } },
      fields: { [fieldDecisionKey('Venue Q', 'Field 7')]: { action: 'create' } },
      teams: {
        [teamDecisionKey('U14 Boys', 'Sharks')]: { action: 'create' },
        [teamDecisionKey('U14 Boys', 'Rays')]: { action: 'create' },
      },
    };
    const out = resolve(rows, baseLeague(), decisions);
    const r = out.rows[0];
    expect(r.status).toBe('ok');
    expect(r.ids.division).toMatch(/^new:division:/);
    expect(r.ids.field).toMatch(/^new:field:/);
    expect(r.ids.home).toMatch(/^new:team:/);
    expect(new Set(Object.values(r.ids)).size).toBe(4);
    // each creation carries its placeholder id and the id of the parent it lives under
    const divisionId = out.rows[0].ids.division;
    const venue = out.creations.venues[0];
    expect(out.creations.divisions).toEqual([
      { id: divisionId, key: 'u14 boys', name: 'U14 Boys' },
    ]);
    expect(out.creations.venues).toEqual([{ id: venue.id, key: 'venue q', name: 'Venue Q' }]);
    expect(out.creations.fields).toEqual([
      { id: r.ids.field, venueId: venue.id, key: 'field 7', name: 'Field 7' },
    ]);
    expect(out.creations.teamShells.every((t) => t.divisionId === divisionId)).toBe(true);
    expect(out.creations.teamShells.map((t) => t.name)).toEqual(['Rays', 'Sharks']);
  });

  it('uses a created record\u2019s name when the decision gives one, and ignores a name that is not text', () => {
    const rows = [fileRow({ 'Home Team': 'Sharks' })];
    const named = resolve(rows, baseLeague(), {
      teams: {
        [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'create', name: '  Sharks FC ' },
      },
    });
    expect(named.creations.teamShells.map((t) => t.name)).toEqual(['Sharks FC']);
    for (const bad of ['', '   ', 7, { x: 1 }, null]) {
      const out = resolve(rows, baseLeague(), {
        teams: { [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'create', name: bad } },
      });
      expect(out.creations.teamShells.map((t) => t.name)).toEqual(['Sharks']);
    }
  });

  it('a field in a created venue can only be created (the venue has none yet)', () => {
    const rows = [fileRow({ Venue: 'Venue Q', Field: 'Field 1' })];
    const noField = first(rows, baseLeague(), {
      venues: { [venueDecisionKey('Venue Q')]: { action: 'create' } },
    });
    expect(noField.reason).toBe('unknown-field');
    const proposal = propose(rows, baseLeague(), {
      venues: { [venueDecisionKey('Venue Q')]: { action: 'create' } },
    });
    expect(proposal.fields[0]).toMatchObject({ status: 'none', proposed: null });
  });

  it('skips the rows of a label the admin skips, and lists them apart from the refusals', () => {
    const rows = [fileRow({ 'Home Team': 'Sharks' }), fileRow(), fileRow({ Division: 'U99' })];
    const out = resolve(rows, baseLeague(), {
      teams: { [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'skip' } },
    });
    expect(out.rows.map((r) => r.status)).toEqual(['skipped', 'ok', 'refused']);
    expect(out.rows[0].reason).toBeNull();
    expect(out.rows[0].skippedBecause).toEqual({ kind: 'team', label: 'Sharks' });
    expect(out.counts).toMatchObject({ rows: 3, ok: 1, skipped: 1, refused: 1 });
  });

  it('records an outside club as an outside team of the division, one per (division, label)', () => {
    const rows = [
      fileRow({ 'Away Team': 'Visiting Club A' }),
      fileRow({ 'Away Team': 'visiting club a' }),
      fileRow({ Division: 'U12 Boys', 'Home Team': 'Visiting Club A', 'Away Team': 'Lions' }),
    ];
    const decisions = {
      teams: {
        [teamDecisionKey('U10 Boys', 'Visiting Club A')]: { action: 'outside' },
        [teamDecisionKey('U12 Boys', 'Visiting Club A')]: { action: 'outside' },
      },
    };
    const out = resolve(rows, baseLeague(), decisions);
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(out.rows[0].ids.away).toBe(out.rows[1].ids.away); // one team, however typed
    expect(out.rows[0].ids.away).not.toBe(out.rows[2].ids.home); // another division, another row
    expect(out.rows[0].ids.away).toMatch(/^new:outside:/);
    expect(out.creations.outsideTeams).toHaveLength(2);
    expect(out.creations.teamShells).toEqual([]);
  });

  it('refuses an outside label that is an own team’s name in the division (label-is-own-team)', () => {
    const rows = [fileRow({ 'Away Team': 'tigers' })];
    const decisions = { teams: { [teamDecisionKey('U10 Boys', 'tigers')]: { action: 'outside' } } };
    const r = first(rows, baseLeague(), decisions);
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('label-is-own-team');
    expect(r.message).toContain('tigers');
    // the same label in a division where no own team has it is an outside club
    const other = first(
      [fileRow({ Division: 'U12 Boys', 'Home Team': 'Lions', 'Away Team': 'Tigers' })],
      baseLeague(),
      {
        teams: { [teamDecisionKey('U12 Boys', 'Tigers')]: { action: 'outside' } },
      }
    );
    expect(other.status).toBe('ok');
  });

  it('finds an outside team that already exists, and uses it rather than creating one', () => {
    const league = baseLeague({
      teams: [
        ...baseLeague().teams,
        { id: 't-visit-a', name: 'Visiting Club A', divisionId: 'd10', isExternal: true },
      ],
    });
    const rows = [fileRow({ 'Away Team': 'visiting club a' })];
    const p = propose(rows, league).teams.find((t) => t.label === 'visiting club a');
    expect(p).toMatchObject({ status: 'match', proposed: { action: 'map', id: 't-visit-a' } });
    const out = resolve(rows, league);
    expect(out.rows[0].ids.away).toBe('t-visit-a');
    expect(out.creations.outsideTeams).toEqual([]);
    // an admin who says "outside" for it gets the same team, not a second one
    const decided = resolve(rows, league, {
      teams: { [teamDecisionKey('U10 Boys', 'visiting club a')]: { action: 'outside' } },
    });
    expect(decided.rows[0].ids.away).toBe('t-visit-a');
    expect(decided.rows[0].status).toBe('ok');
  });

  it('refuses a game between two outside clubs: neither team is one of yours', () => {
    const rows = [fileRow({ 'Home Team': 'Club X', 'Away Team': 'Club Y' })];
    const decisions = {
      teams: {
        [teamDecisionKey('U10 Boys', 'Club X')]: { action: 'outside' },
        [teamDecisionKey('U10 Boys', 'Club Y')]: { action: 'outside' },
      },
    };
    const r = first(rows, baseLeague(), decisions);
    expect(r.status).toBe('refused');
    expect(r.reason).toBe('unknown-team');
    expect(r.message).toMatch(/neither/i);
  });

  it('refuses a game whose two labels the admin mapped onto one team (same-team)', () => {
    const rows = [fileRow({ 'Home Team': 'Lions', 'Away Team': 'The Lions' })];
    const r = first(rows, baseLeague(), {
      teams: { [teamDecisionKey('U10 Boys', 'The Lions')]: { action: 'map', id: 't-lions-10' } },
    });
    expect(r.reason).toBe('same-team');
  });

  it('lists the repeat of a game the admin made by mapping two labels onto one team (duplicate-row)', () => {
    const base = fileRow({ 'Home Team': 'Lions', 'Away Team': 'Tigers', 'Game ID': 'A' });
    const again = { ...base, 'Game ID': 'B', 'Home Team': 'The Lions' };
    const out = resolve([base, again], baseLeague(), {
      teams: { [teamDecisionKey('U10 Boys', 'The Lions')]: { action: 'map', id: 't-lions-10' } },
    });
    expect(out.rows.map((r) => [r.status, r.reason])).toEqual([
      ['ok', null],
      ['refused', 'duplicate-row'],
    ]);
    // without that decision they are two games with one team unknown: not a duplicate
    const apart = resolve([base, again]);
    expect(apart.rows[1].reason).toBe('unknown-team');
  });

  it('passes a row the parse refused straight through, with its reason', () => {
    const out = resolve([fileRow({ Date: 'soon' }), fileRow()]);
    expect(out.rows[0]).toMatchObject({ status: 'refused', reason: 'bad-date', ids: null });
    expect(out.rows[1].status).toBe('ok');
    expect(out.counts.byReason).toEqual({ 'bad-date': 1 });
  });
});

describe('schedule mapping: what will be created is listed, and only what a surviving row uses', () => {
  it('counts a created record once however many rows use it, and nothing from a refused or skipped row', () => {
    const rows = [
      fileRow({ 'Home Team': 'Sharks' }),
      fileRow({ 'Home Team': 'sharks', Field: 'Field 1' }),
      fileRow({ 'Home Team': 'Rays', Date: 'soon' }), // refused at parse: creates nothing
      fileRow({ 'Home Team': 'Orcas' }), // skipped
      fileRow({ 'Home Team': 'Eels', Venue: 'Venue Z', Field: 'Field 1' }), // venue unknown: refused
    ];
    const decisions = {
      teams: {
        [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'create' },
        [teamDecisionKey('U10 Boys', 'Rays')]: { action: 'create' },
        [teamDecisionKey('U10 Boys', 'Orcas')]: { action: 'skip' },
        [teamDecisionKey('U10 Boys', 'Eels')]: { action: 'create' },
      },
    };
    const out = resolve(rows, baseLeague(), decisions);
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'ok', 'refused', 'skipped', 'refused']);
    expect(out.creations.teamShells.map((t) => t.name)).toEqual(['Sharks']);
    expect(out.creations.divisions).toEqual([]);
    expect(out.creations.venues).toEqual([]);
    expect(out.creations.fields).toEqual([]);
    expect(out.creations.outsideTeams).toEqual([]);
  });

  it('does not modify its inputs', () => {
    const rows = parsed([fileRow(), fileRow({ 'Home Team': 'Sharks' })]);
    const league = baseLeague();
    const decisions = { teams: { [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'create' } } };
    const deepFreeze = (o) => {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        Object.values(o).forEach(deepFreeze);
      }
      return o;
    };
    deepFreeze(rows);
    deepFreeze(league);
    deepFreeze(decisions);
    const a = resolveScheduleRows({ rows, league, decisions });
    const b = resolveScheduleRows({ rows, league, decisions });
    expect(a).toEqual(b);
    expect(() => proposeScheduleMapping({ rows, league, decisions })).not.toThrow();
  });

  it('rejects input that is not what it says', () => {
    // @ts-expect-error -- deliberately not an array
    expect(() => resolveScheduleRows({ rows: 'x', league: baseLeague() })).toThrow(TypeError);
    expect(() => resolveScheduleRows({ rows: [], league: null })).toThrow(TypeError);
    // @ts-expect-error -- deliberately a league missing its lists
    expect(() => proposeScheduleMapping({ rows: [], league: { teams: [] } })).toThrow(TypeError);
  });
});

describe('schedule mapping: a composite key is a tuple, never a delimited string (Codex P2)', () => {
  it('keeps the decision keys of colliding pairs apart', () => {
    expect(teamDecisionKey('U10|Boys', 'Lions')).not.toBe(teamDecisionKey('U10', 'Boys|Lions'));
    expect(fieldDecisionKey('A|B', 'C')).not.toBe(fieldDecisionKey('A', 'B|C'));
    // and the key is still built from the normalised labels
    expect(teamDecisionKey('  U10  BOYS ', 'lions')).toBe(teamDecisionKey('U10 Boys', 'Lions'));
    expect(fieldDecisionKey(' Venue  A', 'FIELD 1')).toBe(fieldDecisionKey('venue a', 'Field 1'));
  });

  it('resolves division U10|Boys / team Lions and division U10 / team Boys|Lions to their own teams', () => {
    const league = baseLeague({
      divisions: [
        { id: 'd-pipe', name: 'U10|Boys' },
        { id: 'd-plain', name: 'U10' },
      ],
      teams: [
        { id: 't-lions', name: 'Lions', divisionId: 'd-pipe' },
        { id: 't-tigers-pipe', name: 'Tigers', divisionId: 'd-pipe' },
        { id: 't-boys-lions', name: 'Boys|Lions', divisionId: 'd-plain' },
        { id: 't-tigers-plain', name: 'Tigers', divisionId: 'd-plain' },
      ],
    });
    const rows = [
      fileRow({ Division: 'U10|Boys', 'Home Team': 'Lions', 'Away Team': 'Tigers' }),
      fileRow({ Division: 'U10', 'Home Team': 'Boys|Lions', 'Away Team': 'Tigers' }),
    ];
    const out = resolve(rows, league).rows;
    expect(out.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(out[0].ids).toMatchObject({
      division: 'd-pipe',
      home: 't-lions',
      away: 't-tigers-pipe',
    });
    expect(out[1].ids).toMatchObject({
      division: 'd-plain',
      home: 't-boys-lions',
      away: 't-tigers-plain',
    });
    // two entries, not one, and each matched inside its own division
    const entries = propose(rows, league).teams.filter((t) => t.label !== 'Tigers');
    expect(entries.map((e) => [e.label, e.proposed?.id])).toEqual(
      expect.arrayContaining([
        ['Lions', 't-lions'],
        ['Boys|Lions', 't-boys-lions'],
      ])
    );
  });

  it('resolves venue A|B / field C and venue A / field B|C to their own fields', () => {
    const league = baseLeague({
      venues: [
        { id: 'v-ab', name: 'A|B' },
        { id: 'v-a', name: 'A' },
      ],
      fields: [
        { id: 'f-ab-c', venueId: 'v-ab', name: 'C' },
        { id: 'f-a-bc', venueId: 'v-a', name: 'B|C' },
      ],
    });
    const out = resolve(
      [fileRow({ Venue: 'A|B', Field: 'C' }), fileRow({ Venue: 'A', Field: 'B|C' })],
      league
    ).rows;
    expect(out.map((r) => r.ids?.field)).toEqual(['f-ab-c', 'f-a-bc']);
  });

  it('keeps a decision for one colliding pair from applying to the other', () => {
    const rows = [
      fileRow({ Division: 'U10|Boys', 'Home Team': 'Sharks' }),
      fileRow({ Division: 'U10', 'Home Team': 'Boys|Sharks' }),
    ];
    const league = baseLeague({
      divisions: [
        { id: 'd-pipe', name: 'U10|Boys' },
        { id: 'd-plain', name: 'U10' },
      ],
      teams: [
        { id: 't-tigers-pipe', name: 'Tigers', divisionId: 'd-pipe' },
        { id: 't-tigers-plain', name: 'Tigers', divisionId: 'd-plain' },
      ],
    });
    const out = resolve(rows, league, {
      teams: { [teamDecisionKey('U10|Boys', 'Sharks')]: { action: 'create' } },
    }).rows;
    expect(out[0].status).toBe('ok'); // the pair that was decided
    expect(out[1].status).toBe('refused'); // the pair that only shares a joined string
    expect(out[1].reason).toBe('unknown-team');
  });

  it('does not let a scope id and a name run together in the league index (sibling: the NUL join)', () => {
    // scope "a" + name "b\u0000c" and scope "a\u0000b" + name "c" are one string if joined by NUL
    const league = baseLeague({
      divisions: [
        { id: 'a', name: 'D1' },
        { id: 'a\u0000b', name: 'D2' },
      ],
      teams: [
        { id: 't-1', name: 'b\u0000c', divisionId: 'a' },
        { id: 't-2', name: 'c', divisionId: 'a\u0000b' },
        { id: 't-3', name: 'Tigers', divisionId: 'a\u0000b' },
      ],
    });
    const p = propose(
      [fileRow({ Division: 'D2', 'Home Team': 'c', 'Away Team': 'Tigers' })],
      league
    );
    const entry = p.teams.find((t) => t.label === 'c');
    expect(entry.status).toBe('match');
    expect(entry.candidates.map((c) => c.id)).toEqual(['t-2']);
  });

  it('does not call two different games one because their ids run together (sibling: the duplicate key)', () => {
    const league = baseLeague({
      teams: [
        { id: 'x|y', name: 'T1', divisionId: 'd10' },
        { id: 'z', name: 'T2', divisionId: 'd10' },
        { id: 'x', name: 'T3', divisionId: 'd10' },
        { id: 'y|z', name: 'T4', divisionId: 'd10' },
      ],
    });
    const sameSlot = { 'Start Time': '09:00', 'End Time': '10:00', Date: '2026-09-12' };
    const out = resolve(
      [
        fileRow({ ...sameSlot, 'Home Team': 'T1', 'Away Team': 'T2' }),
        fileRow({ ...sameSlot, 'Home Team': 'T3', 'Away Team': 'T4' }),
      ],
      league
    ).rows;
    expect(out.map((r) => [r.status, r.reason])).toEqual([
      ['ok', null],
      ['ok', null],
    ]);
  });
});

describe('schedule mapping: records the import creates are one record per parent and name (Codex P2)', () => {
  // Two labels the admin maps onto the one existing division, and a team created under each.
  const twoLabels = (over = {}) => ({
    divisions: { [divisionDecisionKey('U10B')]: { action: 'map', id: 'd10' } },
    teams: {
      [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'create' },
      [teamDecisionKey('U10B', 'Sharks')]: { action: 'create' },
    },
    ...over,
  });
  const overlapping = [
    fileRow({
      Division: 'U10 Boys',
      'Home Team': 'Sharks',
      'Away Team': 'Tigers',
      Field: 'Field 1',
      'Start Time': '09:00',
      'End Time': '10:00',
    }),
    fileRow({
      Division: 'U10B',
      'Home Team': 'Sharks',
      'Away Team': 'Lions',
      Field: 'Field 2',
      'Start Time': '09:00',
      'End Time': '10:00',
    }),
  ];

  it('gives one placeholder id and one creation to a team created under two labels of one division', () => {
    const out = resolve(overlapping, baseLeague(), twoLabels());
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(out.rows[0].ids.division).toBe('d10');
    expect(out.rows[1].ids.division).toBe('d10');
    expect(out.rows[0].ids.home).toBe(out.rows[1].ids.home);
    expect(out.rows[0].ids.home).toMatch(/^new:team:/);
    expect(out.creations.teamShells).toHaveLength(1);
    expect(out.creations.teamShells[0]).toMatchObject({ divisionId: 'd10', name: 'Sharks' });
  });

  it('so the audit sees the one team in two places at once', () => {
    const league = baseLeague();
    const out = resolve(overlapping, league, twoLabels());
    const audited = auditResolvedRows({ league, rows: out.rows });
    expect(audited.counts['team-double-booked']).toBe(1);
    expect(audited.checks.teamOverlap).toBe('flagged');
    expect(audited.coverage.teams.own).toBe(3); // Sharks, Tigers, Lions: Sharks counted once
  });

  it('coalesces on the final name, not the typed label: a name given to the decision decides', () => {
    const decisions = {
      divisions: { [divisionDecisionKey('U10B')]: { action: 'map', id: 'd10' } },
      teams: {
        [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'create', name: 'Sharks FC' },
        [teamDecisionKey('U10B', 'Shark Team')]: { action: 'create', name: ' sharks  fc ' },
      },
    };
    const rows = [
      overlapping[0],
      { ...overlapping[1], awayLabel: 'Lions', homeLabel: 'Shark Team' },
    ];
    const out = resolveScheduleRows({
      rows: parsed([
        fileRow({ ...overlapping[0], Division: 'U10 Boys' }),
        fileRow({ Division: 'U10B', 'Home Team': 'Shark Team', 'Away Team': 'Lions' }),
      ]),
      league: baseLeague(),
      decisions,
    });
    void rows;
    expect(out.rows[0].ids.home).toBe(out.rows[1].ids.home);
    expect(out.creations.teamShells.map((t) => t.name)).toEqual(['Sharks FC']);
  });

  it('keeps a team created in another division a different team', () => {
    const decisions = twoLabels({
      divisions: { [divisionDecisionKey('U12 Boys')]: { action: 'map', id: 'd12' } },
      teams: {
        [teamDecisionKey('U10 Boys', 'Sharks')]: { action: 'create' },
        [teamDecisionKey('U12 Boys', 'Sharks')]: { action: 'create' },
      },
    });
    const out = resolve(
      [
        fileRow({ Division: 'U10 Boys', 'Home Team': 'Sharks', 'Away Team': 'Tigers' }),
        fileRow({ Division: 'U12 Boys', 'Home Team': 'Sharks', 'Away Team': 'Lions' }),
      ],
      baseLeague(),
      decisions
    );
    expect(out.rows[0].ids.home).not.toBe(out.rows[1].ids.home);
    expect(out.creations.teamShells.map((t) => t.divisionId).sort()).toEqual(['d10', 'd12']);
  });

  it('coalesces an outside club the same way (sibling: outside creation)', () => {
    const decisions = {
      divisions: { [divisionDecisionKey('U10B')]: { action: 'map', id: 'd10' } },
      teams: {
        [teamDecisionKey('U10 Boys', 'Visiting Club A')]: { action: 'outside' },
        [teamDecisionKey('U10B', 'visiting club a')]: { action: 'outside' },
      },
    };
    const out = resolve(
      [
        fileRow({ Division: 'U10 Boys', 'Home Team': 'Lions', 'Away Team': 'Visiting Club A' }),
        fileRow({ Division: 'U10B', 'Home Team': 'Tigers', 'Away Team': 'visiting club a' }),
      ],
      baseLeague(),
      decisions
    );
    expect(out.rows[0].ids.away).toBe(out.rows[1].ids.away);
    expect(out.creations.outsideTeams).toHaveLength(1);
    expect(out.creations.outsideTeams[0]).toMatchObject({ divisionId: 'd10' });
  });

  it('coalesces created divisions, venues and fields by final name too (sibling)', () => {
    const decisions = {
      divisions: {
        [divisionDecisionKey('U14 Boys')]: { action: 'create' },
        [divisionDecisionKey('U14B')]: { action: 'create', name: 'U14 Boys' },
      },
      venues: {
        [venueDecisionKey('Venue Q')]: { action: 'create' },
        [venueDecisionKey('Q')]: { action: 'create', name: 'venue q' },
      },
      fields: {
        [fieldDecisionKey('Venue Q', 'Field 7')]: { action: 'create' },
        [fieldDecisionKey('Q', 'F7')]: { action: 'create', name: 'field 7' },
      },
      teams: {
        [teamDecisionKey('U14 Boys', 'Sharks')]: { action: 'create' },
        [teamDecisionKey('U14B', 'Sharks')]: { action: 'create' },
        [teamDecisionKey('U14 Boys', 'Rays')]: { action: 'create' },
        [teamDecisionKey('U14B', 'Eels')]: { action: 'create' },
      },
    };
    const out = resolve(
      [
        fileRow({
          Division: 'U14 Boys',
          Venue: 'Venue Q',
          Field: 'Field 7',
          'Home Team': 'Sharks',
          'Away Team': 'Rays',
        }),
        fileRow({
          Division: 'U14B',
          Venue: 'Q',
          Field: 'F7',
          'Home Team': 'Sharks',
          'Away Team': 'Eels',
        }),
      ],
      baseLeague(),
      decisions
    );
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(out.rows[0].ids.division).toBe(out.rows[1].ids.division);
    expect(out.rows[0].ids.field).toBe(out.rows[1].ids.field);
    expect(out.rows[0].ids.home).toBe(out.rows[1].ids.home);
    expect(out.creations.divisions).toHaveLength(1);
    expect(out.creations.venues).toHaveLength(1);
    expect(out.creations.fields).toHaveLength(1);
    expect(out.creations.teamShells.map((t) => t.name).sort()).toEqual(['Eels', 'Rays', 'Sharks']);
  });
});

describe('schedule mapping: review round: TBD repeats, decisions that cannot be read, names that exist', () => {
  it('does not call two TIME TBD games one because their Field labels are not asked about', () => {
    const tbd = { 'Start Time': '', 'End Time': '', 'Game ID': '' };
    const out = resolve([
      fileRow({ ...tbd, 'Game ID': 'A', Field: 'Field 1' }),
      fileRow({ ...tbd, 'Game ID': 'B', Field: 'Field 2' }),
    ]).rows;
    expect(out.map((r) => [r.status, r.reason])).toEqual([
      ['tbd', null],
      ['tbd', null],
    ]);
    // two TBD rows of one Game ID that differ only in an unread field are the same game
    const same = resolve([
      fileRow({ ...tbd, 'Game ID': 'A', Venue: 'Venue A' }),
      fileRow({ ...tbd, 'Game ID': 'A', Venue: 'Venue B' }),
    ]).rows;
    expect(same.map((r) => r.reason)).toEqual([null, 'duplicate-row']);
  });

  it('keeps a decision it cannot read from falling back to the proposal, and says so', () => {
    const rows = [fileRow({ 'Home Team': 'Lions' })];
    for (const bad of [
      { action: 'skp' },
      { action: 'outside' },
      { action: 'map' /* no id */ },
      'skip',
    ]) {
      const decisions = { divisions: { [divisionDecisionKey('U10 Boys')]: bad } };
      const entry = propose(rows, baseLeague(), decisions).divisions[0];
      expect(entry.status).toBe('match'); // the proposal exists...
      expect(entry.problem).toBe('invalid-decision'); // a map with no id is unreadable too
      expect(entry.effective).toBeNull(); // ...and is NOT used in place of what was decided
      const out = resolve(rows, baseLeague(), decisions).rows[0];
      expect(out.status).toBe('refused');
      expect(out.reason).toBe('unknown-division');
      expect(out.message).toMatch(/decision/i);
    }
    // an outside decision is valid on a team, so the control is accepted
    const ok = resolve(rows, baseLeague(), {
      divisions: { [divisionDecisionKey('U10 Boys')]: { action: 'map', id: 'd10' } },
    }).rows[0];
    expect(ok.status).toBe('ok');
  });

  it('refuses to create a record whose name is already taken under the same parent', () => {
    const cases = [
      [
        'team',
        { teams: { [teamDecisionKey('U10 Boys', 'Cubs')]: { action: 'create', name: 'lions' } } },
        'unknown-team',
        { 'Home Team': 'Cubs' },
      ],
      [
        'division',
        { divisions: { [divisionDecisionKey('U10B')]: { action: 'create', name: ' u10  boys ' } } },
        'unknown-division',
        { Division: 'U10B' },
      ],
      [
        'venue',
        { venues: { [venueDecisionKey('The Park')]: { action: 'create', name: 'venue a' } } },
        'unknown-venue',
        { Venue: 'The Park' },
      ],
      [
        'field',
        { fields: { [fieldDecisionKey('Venue A', 'F1')]: { action: 'create', name: 'field 1' } } },
        'unknown-field',
        { Field: 'F1' },
      ],
    ];
    for (const [kind, decisions, reason, over] of cases) {
      const out = resolve([fileRow(over)], baseLeague(), decisions);
      expect([kind, out.rows[0].status, out.rows[0].reason]).toEqual([kind, 'refused', reason]);
      expect(out.rows[0].message).toMatch(/already exists/);
      expect(out.creations.teamShells).toEqual([]);
      expect(out.creations.divisions).toEqual([]);
    }
    // a new name in the same place is fine, and so is the same name under another parent
    const fine = resolve([fileRow({ 'Home Team': 'Cubs' })], baseLeague(), {
      teams: { [teamDecisionKey('U10 Boys', 'Cubs')]: { action: 'create', name: 'Lions' } },
    });
    expect(fine.rows[0].reason).toBe('unknown-team'); // U10 has a Lions: refused
    const other = resolve(
      [fileRow({ Division: 'U14 Boys', 'Home Team': 'Cubs', 'Away Team': 'Rays' })],
      baseLeague({ divisions: [...baseLeague().divisions, { id: 'd14', name: 'U14 Boys' }] }),
      {
        teams: {
          [teamDecisionKey('U14 Boys', 'Cubs')]: { action: 'create', name: 'Lions' },
          [teamDecisionKey('U14 Boys', 'Rays')]: { action: 'create' },
        },
      }
    );
    expect(other.rows[0].status).toBe('ok'); // d14 has no Lions
  });
});

describe('schedule mapping: the fixture', () => {
  const fixture = loadScheduleFixture();
  const result = parseScheduleRows({
    headers: fixture.schedule.headers,
    rows: fixture.schedule.rows,
    season: fixture.season,
  });
  const proposal = proposeScheduleMapping({ rows: result.rows, league: fixture.league });

  it('maps all 20 divisions, 7 venues, 26 fields and 132 own teams on its own, exactly', () => {
    expect(proposal.divisions).toHaveLength(20);
    expect(proposal.venues).toHaveLength(7);
    expect(proposal.fields).toHaveLength(26);
    for (const e of [...proposal.divisions, ...proposal.venues, ...proposal.fields])
      expect(e.status).toBe('match');
    const matched = proposal.teams.filter((t) => t.status === 'match');
    expect(matched).toHaveLength(132);
    // each match is the team of that name in that division, by the league's own ids
    for (const e of matched) {
      const team = fixture.league.teams.find((t) => t.id === e.proposed.id);
      expect(scheduleLabelKey(team.name)).toBe(JSON.parse(e.key)[1]);
    }
  });

  it('proposes nothing for the 43 (division, outside label) pairs: the admin decides an outside club', () => {
    const none = proposal.teams.filter((t) => t.status === 'none');
    expect(none).toHaveLength(43);
    for (const e of none) {
      expect(e.proposed).toBeNull();
      expect(e.effective).toBeNull();
      expect(e.label).toMatch(/^Visiting Club [A-Z]{1,2}$/);
      expect(e.rowCount).toBe(1);
    }
    expect(new Set(none.map((e) => e.label)).size).toBe(31);
  });

  it('leaves those 43 games refused until decided, then resolves all 574 (573 placed, 1 TIME TBD)', () => {
    const undecided = resolveScheduleRows({ rows: result.rows, league: fixture.league });
    expect(undecided.counts.byReason).toEqual({ 'unknown-team': 43 });
    const decided = resolveScheduleRows({
      rows: result.rows,
      league: fixture.league,
      decisions: outsideDecisionsFor(proposal),
    });
    expect(decided.counts).toMatchObject({ rows: 574, ok: 573, tbd: 1, refused: 0, skipped: 0 });
    expect(decided.creations.outsideTeams).toHaveLength(43);
    expect(decided.creations.teamShells).toEqual([]);
    expect(decided.creations.divisions).toEqual([]);
    expect(decided.creations.venues).toEqual([]);
    expect(decided.creations.fields).toEqual([]);
    // every placed game names a field the league has and two teams
    const fieldIds = new Set(fixture.league.fields.map((f) => f.id));
    for (const r of decided.rows) {
      if (r.status === 'ok') expect(fieldIds.has(r.ids.field)).toBe(true);
      expect(r.ids.home).not.toBe(r.ids.away);
    }
  });

  it('is deterministic: the same input twice is the same answer, entries in a fixed order', () => {
    const again = proposeScheduleMapping({ rows: result.rows, league: fixture.league });
    expect(again).toEqual(proposal);
    const keys = proposal.teams.map((t) => t.key);
    expect(keys).toEqual([...keys].sort());
  });
});
