// @vitest-environment node
/**
 * The practice import's mapping, alias file and slot step (`packages/core/src/practiceImport/mapping.js`,
 * `aliases.js`, `slotKey.js`; plan `docs/changes/2026-11-03-schedule-expansion.md` sections 4.11.3 and
 * 4.11.5; PR 9 task J2).
 *
 * What this holds:
 *
 *   - **One normaliser, no word dropped.** The label key is the schedule import's (and so
 *     `externalImport`'s): trim, collapse whitespace, fold case. `Park` is neither `Park Back` nor
 *     `Park Front`. Exactly one match is proposed (and in effect); more than one, or none, is never
 *     mapped on the admin's behalf.
 *   - **Proposals, in order, none applied without the admin** (decision 30): the exact label, an
 *     optional alias file, the previous import's mapping. Where two disagree BOTH are shown and none is
 *     chosen: an alias never wins over an exact match, and never loses to one silently either.
 *   - **A team is judged inside its division, a field inside its location, a subunit inside its field.**
 *     An outside club (`is_external`) is never a practice team.
 *   - **Created records are coalesced** by parent identity and final name (a created team under two
 *     labels is one team), and every composite key is a JSON tuple, never a delimited string.
 *   - **A slot is a ground, a weekday, a start and a date**: two halves of a field are two slots; a
 *     whole field clashes with each half; back to back is allowed; the first slot in the file wins.
 *   - **A team on two halves is not merged into a whole-field row.** It is two rows, two slots and a flag.
 *
 * Statically out of reach, and so not claimed: that the database finds, creates and judges the same
 * slots (PR 10 reads stored slots, which this module never sees), and that the owner's real alias tab
 * has the columns the fixture's has (plan finding 17: it could not be tied to the grid).
 */

import { describe, expect, it } from 'vitest';
import {
  practiceDivisionDecisionKey,
  practiceFieldDecisionKey,
  practiceLocationDecisionKey,
  practiceSubunitDecisionKey,
  practiceTeamDecisionKey,
  proposePracticeMapping,
  resolvePracticeRows,
} from '../packages/core/src/practiceImport/mapping.js';
import { readPracticeAliases } from '../packages/core/src/practiceImport/aliases.js';
import { parsePracticeRows } from '../packages/core/src/practiceImport/parseRows.js';
import {
  practiceLabelKey,
  practiceSlotKey,
  practiceSlotsOverlap,
} from '../packages/core/src/practiceImport/slotKey.js';
import { scheduleLabelKey } from '../packages/core/src/scheduleImport/mapping.js';
import { acceptAllProposals, loadPracticeFixture } from './helpers/practiceFixtureLoad.js';
import { readCsvText } from './helpers/scheduleFixtureLoad.js';

const SEASON = { startDate: '2026-09-07', endDate: '2026-11-20' };
const HEADERS = [
  'Team',
  'Division',
  'Day',
  'Start',
  'End',
  'Location',
  'Field',
  'Subunit',
  'Valid From',
  'Valid Until',
  'Capacity',
  'Use',
];
const row = (over = {}) => ({
  Team: 'Sharks',
  Division: 'U10 Boys',
  Day: 'Mon',
  Start: '16:00',
  End: '17:00',
  Location: 'Venue A',
  Field: 'Field 1',
  Subunit: 'A',
  'Valid From': '',
  'Valid Until': '',
  Capacity: '',
  Use: '',
  ...over,
});
/** @param {Array<Record<string, string>>} rows the parse's rows for these cells */
const parsed = (rows) => parsePracticeRows({ headers: HEADERS, rows, season: SEASON }).rows;

const league = (over = {}) => ({
  divisions: [
    { id: 'div:boys', name: 'U10 Boys' },
    { id: 'div:girls', name: 'U10 Girls' },
  ],
  teams: [
    { id: 'team:sharks-boys', name: 'Sharks', divisionId: 'div:boys' },
    { id: 'team:sharks-girls', name: 'Sharks', divisionId: 'div:girls' },
    { id: 'team:lions-boys', name: 'Lions', divisionId: 'div:boys' },
    { id: 'team:visiting', name: 'Visiting', divisionId: 'div:boys', isExternal: true },
  ],
  locations: [
    { id: 'loc:a', name: 'Venue A' },
    { id: 'loc:b', name: 'Venue B' },
    { id: 'loc:back', name: 'Park Back' },
    { id: 'loc:front', name: 'Park Front' },
  ],
  fields: [
    { id: 'field:a1', locationId: 'loc:a', name: 'Field 1' },
    { id: 'field:a2', locationId: 'loc:a', name: 'Field 2' },
    { id: 'field:b1', locationId: 'loc:b', name: 'Field 1' },
  ],
  subunits: [
    { id: 'sub:a1a', fieldId: 'field:a1', name: 'A' },
    { id: 'sub:a1b', fieldId: 'field:a1', name: 'B' },
    { id: 'sub:b1a', fieldId: 'field:b1', name: 'A' },
  ],
  ...over,
});

const entryOf = (group, key) => group.find((e) => e.key === key);

/* -------------------------------------------------------------------------- */

describe('practice import mapping: one label key, shared with the schedule import', () => {
  it('is the schedule import’s key, input for input', () => {
    for (const label of ['Venue A', ' venue  a ', 'VENUE A', '', null, undefined, 7, 'Park Back']) {
      expect(practiceLabelKey(label)).toBe(scheduleLabelKey(label));
    }
    expect(practiceLabelKey('Venue A')).toBe(practiceLabelKey('  venue   a'));
  });

  it('drops no word: Park, Park Back and Park Front are three labels', () => {
    const keys = ['Park', 'Park Back', 'Park Front'].map(practiceLabelKey);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('practice import mapping: exact matches are proposed, nothing else is', () => {
  const rows = parsed([row()]);
  const proposal = proposePracticeMapping({ rows, league: league() });

  it('maps a label equal to exactly one record, in effect, with its source', () => {
    for (const [group, id] of [
      ['divisions', 'div:boys'],
      ['locations', 'loc:a'],
      ['fields', 'field:a1'],
      ['subunits', 'sub:a1a'],
      ['teams', 'team:sharks-boys'],
    ]) {
      const entry = proposal[group][0];
      expect([group, entry.status, entry.proposed?.id, entry.effective]).toEqual([
        group,
        'match',
        id,
        { action: 'map', id, source: 'exact' },
      ]);
      expect(entry.conflict).toBe(false);
      expect(entry.proposals).toEqual([{ source: 'exact', id }]);
      expect(entry.options).toEqual(['map', 'create', 'skip']);
    }
  });

  it('folds case, spacing and stray whitespace to the same record', () => {
    const odd = parsed([
      row({
        Team: ' sharks ',
        Division: 'u10  BOYS',
        Location: 'venue a',
        Field: 'FIELD 1',
        Subunit: ' a',
      }),
    ]);
    const p = proposePracticeMapping({ rows: odd, league: league() });
    expect(p.teams[0].proposed.id).toBe('team:sharks-boys');
    expect(p.subunits[0].proposed.id).toBe('sub:a1a');
  });

  it('does not map a label that is a word short of a record, or a word over', () => {
    const p = proposePracticeMapping({
      rows: parsed([row({ Location: 'Park' }), row({ Location: 'Park Back', Day: 'Tue' })]),
      league: league(),
    });
    expect(entryOf(p.locations, practiceLocationDecisionKey('Park'))).toMatchObject({
      status: 'none',
      proposed: null,
      effective: null,
    });
    expect(entryOf(p.locations, practiceLocationDecisionKey('Park Back')).proposed.id).toBe(
      'loc:back'
    );
  });

  it('never maps an ambiguous label: two records of one name are both candidates, neither chosen', () => {
    const twice = league({
      locations: [...league().locations, { id: 'loc:a2', name: 'venue a' }],
    });
    const p = proposePracticeMapping({ rows, league: twice });
    const entry = p.locations[0];
    expect([entry.status, entry.proposed, entry.effective]).toEqual(['ambiguous', null, null]);
    expect(entry.candidates.map((c) => c.id).sort()).toEqual(['loc:a', 'loc:a2']);
    const resolved = resolvePracticeRows({ rows, league: twice });
    expect([resolved.rows[0].status, resolved.rows[0].reason]).toEqual([
      'refused',
      'unknown-location',
    ]);
  });

  it('judges a team inside its division, a field inside its location, a subunit inside its field', () => {
    const p = proposePracticeMapping({
      rows: parsed([
        row({ Team: 'Sharks', Division: 'U10 Girls' }),
        row({ Team: 'Lions', Division: 'U10 Girls', Day: 'Tue' }),
        // the ground rows use a team of their own: one label in two divisions is the parse's refusal
        row({ Team: 'Cubs', Location: 'Venue B', Field: 'Field 1', Day: 'Wed' }),
        row({ Team: 'Cubs', Location: 'Venue B', Field: 'Field 2', Day: 'Thu' }),
        row({ Team: 'Cubs', Subunit: 'B', Day: 'Fri' }),
        row({ Team: 'Cubs', Location: 'Venue B', Subunit: 'B', Day: 'Sat' }),
      ]),
      league: league(),
    });
    const team = (division, name) => entryOf(p.teams, practiceTeamDecisionKey(division, name));
    expect(team('U10 Girls', 'Sharks').proposed.id).toBe('team:sharks-girls'); // not the boys' Sharks
    expect(team('U10 Girls', 'Lions').status).toBe('none'); // the Lions are the boys'
    const field = (loc, name) => entryOf(p.fields, practiceFieldDecisionKey(loc, name));
    expect(field('Venue B', 'Field 1').proposed.id).toBe('field:b1');
    expect(field('Venue B', 'Field 2').status).toBe('none');
    const sub = (loc, f, name) => entryOf(p.subunits, practiceSubunitDecisionKey(loc, f, name));
    expect(sub('Venue A', 'Field 1', 'B').proposed.id).toBe('sub:a1b');
    expect(sub('Venue B', 'Field 1', 'B').status).toBe('none'); // Venue B's Field 1 has only an A
  });

  it('never offers an outside club as a practice team', () => {
    const p = proposePracticeMapping({
      rows: parsed([row({ Team: 'Visiting' })]),
      league: league(),
    });
    expect(p.teams[0]).toMatchObject({ status: 'none', candidates: [], proposed: null });
    // …and a decision naming one is not trusted
    const decisions = {
      teams: {
        [practiceTeamDecisionKey('U10 Boys', 'Visiting')]: { action: 'map', id: 'team:visiting' },
      },
    };
    const resolved = resolvePracticeRows({
      rows: parsed([row({ Team: 'Visiting' })]),
      league: league(),
      decisions,
    });
    expect([resolved.rows[0].reason, resolved.rows[0].message]).toEqual([
      'unknown-team',
      expect.stringMatching(/not one of yours/),
    ]);
  });

  it('refuses to create a team onto the name of an outside club in its division (Codex P2)', () => {
    // UNIQUE (division_id, name) covers outside clubs too, though they are never a practice team's
    // candidates: a `create` named like one would meet the constraint in the writer.
    const rows = parsed([row({ Team: 'Visiting' })]);
    const key = practiceTeamDecisionKey('U10 Boys', 'Visiting');
    const created = resolvePracticeRows({
      rows,
      league: league(),
      decisions: { teams: { [key]: { action: 'create' } } },
    });
    expect([created.rows[0].status, created.rows[0].reason]).toEqual(['refused', 'unknown-team']);
    expect(created.rows[0].message).toMatch(/outside club/);
    expect(created.creations.teamShells).toEqual([]);
    // the same by a name chosen for the shell, in other spelling
    const renamed = resolvePracticeRows({
      rows: parsed([row({ Team: 'Cubs' })]),
      league: league(),
      decisions: {
        teams: {
          [practiceTeamDecisionKey('U10 Boys', 'Cubs')]: { action: 'create', name: ' VISITING ' },
        },
      },
    });
    expect(renamed.rows[0].reason).toBe('unknown-team');
    // controls: the outside club is still no candidate, a free name is created, and the same name in
    // another division (which has no outside club of that name) is created too
    const entry = proposePracticeMapping({ rows, league: league() }).teams[0];
    expect([entry.status, entry.candidates]).toEqual(['none', []]);
    const free = resolvePracticeRows({
      rows: parsed([row({ Team: 'Cubs' })]),
      league: league(),
      decisions: { teams: { [practiceTeamDecisionKey('U10 Boys', 'Cubs')]: { action: 'create' } } },
    });
    expect(free.rows[0].status).toBe('placement');
    const elsewhere = resolvePracticeRows({
      rows: parsed([row({ Team: 'Visiting', Division: 'U10 Girls' })]),
      league: league(),
      decisions: {
        teams: { [practiceTeamDecisionKey('U10 Girls', 'Visiting')]: { action: 'create' } },
      },
    });
    expect(elsewhere.rows[0].status).toBe('placement');
    expect(elsewhere.creations.teamShells.map((t) => t.divisionId)).toEqual(['div:girls']);
  });

  it('asks about a division only for a row that has a team, and about ground for no hold', () => {
    const p = proposePracticeMapping({
      rows: parsed([
        row({ Team: '', Division: 'Nowhere Division' }),
        row({ Team: '', Division: '', Use: 'hold', Location: 'Nowhere Venue', Day: 'Tue' }),
      ]),
      league: league(),
    });
    expect(p.divisions).toEqual([]);
    expect(p.teams).toEqual([]);
    expect(p.locations.map((e) => e.label)).toEqual(['Venue A']); // the open row's, not the hold's
  });
});

describe('practice import mapping: the admin’s decisions', () => {
  const one = parsed([
    row({
      Team: 'Cubs',
      Division: 'U10 Boys',
      Location: 'Venue Z',
      Field: 'Field 9',
      Subunit: 'C',
    }),
  ]);
  const key = {
    team: practiceTeamDecisionKey('U10 Boys', 'Cubs'),
    location: practiceLocationDecisionKey('Venue Z'),
    field: practiceFieldDecisionKey('Venue Z', 'Field 9'),
    subunit: practiceSubunitDecisionKey('Venue Z', 'Field 9', 'C'),
  };

  it('leaves an unknown label unresolved, with the reason for the first thing missing', () => {
    const r = resolvePracticeRows({ rows: one, league: league() }).rows[0];
    expect([r.status, r.reason]).toEqual(['refused', 'unknown-location']);
    expect(r.message).toMatch(/Venue Z/);
  });

  it('maps, creates or skips on the admin’s word, and lists what a confirmed import would create', () => {
    const decisions = {
      locations: { [key.location]: { action: 'create' } },
      fields: { [key.field]: { action: 'create', name: 'Main Field' } },
      subunits: { [key.subunit]: { action: 'create' } },
      teams: { [key.team]: { action: 'create' } },
    };
    const out = resolvePracticeRows({ rows: one, league: league(), decisions });
    const r = out.rows[0];
    expect([r.status, r.reason]).toEqual(['placement', null]);
    expect(r.ids.location).toMatch(/^new:location:/);
    expect(r.ids.field).toMatch(/^new:field:/);
    expect(r.ids.subunit).toMatch(/^new:subunit:/);
    expect(r.ids.team).toMatch(/^new:team:/);
    expect(r.ids.division).toBe('div:boys'); // an existing parent keeps its own id
    expect(out.creations.locations.map((x) => x.name)).toEqual(['Venue Z']);
    expect(out.creations.fields.map((x) => [x.name, x.locationId])).toEqual([
      ['Main Field', r.ids.location],
    ]);
    expect(out.creations.subunits.map((x) => [x.name, x.fieldId])).toEqual([['C', r.ids.field]]);
    expect(out.creations.teamShells.map((x) => [x.name, x.divisionId])).toEqual([
      ['Cubs', 'div:boys'],
    ]);
    expect(out.creations.divisions).toEqual([]);
    expect(out.creations.slots).toHaveLength(1);
  });

  it('lists a skipped label’s rows apart from the refused ones', () => {
    const decisions = { locations: { [key.location]: { action: 'skip' } } };
    const out = resolvePracticeRows({ rows: one, league: league(), decisions });
    expect(out.rows[0]).toMatchObject({ status: 'skipped', reason: null });
    expect(out.rows[0].skippedBecause).toEqual({ kind: 'location', label: 'Venue Z' });
    expect(out.counts).toMatchObject({ skipped: 1, refused: 0, placements: 0 });
  });

  it('creates nothing for a row that does not survive', () => {
    const decisions = {
      locations: { [key.location]: { action: 'create' } },
      fields: { [key.field]: { action: 'create' } },
      // the subunit and the team are not decided: the row is refused, so nothing is created for it
    };
    const out = resolvePracticeRows({ rows: one, league: league(), decisions });
    expect(out.rows[0].reason).toBe('unknown-subunit');
    expect(out.creations).toEqual({
      divisions: [],
      locations: [],
      fields: [],
      subunits: [],
      teamShells: [],
      slots: [],
    });
  });

  it('does not trust a decision that cannot be read, and does not fall back to the proposal', () => {
    const ok = parsed([row()]);
    const decisions = {
      teams: { [practiceTeamDecisionKey('U10 Boys', 'Sharks')]: { action: 'maap' } },
    };
    const p = proposePracticeMapping({ rows: ok, league: league(), decisions });
    expect(p.teams[0]).toMatchObject({
      problem: 'invalid-decision',
      effective: null,
      decision: null,
    });
    expect(p.teams[0].proposed.id).toBe('team:sharks-boys'); // still shown, not taken
    const r = resolvePracticeRows({ rows: ok, league: league(), decisions }).rows[0];
    expect([r.reason, r.message]).toEqual([
      'unknown-team',
      expect.stringMatching(/not one this step can read/),
    ]);
    // a map with no id, and a decision that is not an object, are the same
    for (const bad of [{ action: 'map' }, 'map', null, 7]) {
      const q = proposePracticeMapping({
        rows: ok,
        league: league(),
        decisions: { teams: { [practiceTeamDecisionKey('U10 Boys', 'Sharks')]: bad } },
      });
      expect([JSON.stringify(bad), q.teams[0].effective]).toEqual([JSON.stringify(bad), null]);
    }
  });

  it('does not trust a map to a record the league does not hold, or holds in another parent', () => {
    const ok = parsed([row({ Team: 'Cubs' })]);
    for (const id of ['team:nowhere', 'team:sharks-girls']) {
      const decisions = {
        teams: { [practiceTeamDecisionKey('U10 Boys', 'Cubs')]: { action: 'map', id } },
      };
      const r = resolvePracticeRows({ rows: ok, league: league(), decisions }).rows[0];
      expect([id, r.reason, r.message]).toEqual([
        id,
        'unknown-team',
        expect.stringMatching(/not one of yours/),
      ]);
    }
  });

  it('refuses to create what already exists under that name', () => {
    const ok = parsed([row({ Team: 'Cubs' })]);
    const decisions = {
      teams: {
        [practiceTeamDecisionKey('U10 Boys', 'Cubs')]: { action: 'create', name: ' lions ' },
      },
    };
    const r = resolvePracticeRows({ rows: ok, league: league(), decisions }).rows[0];
    expect([r.reason, r.message]).toEqual([
      'unknown-team',
      expect.stringMatching(/already exists/),
    ]);
  });

  it('keeps the source of a decision, and reads anything else as the admin’s own', () => {
    const ok = parsed([row({ Team: 'Cubs' })]);
    const k = practiceTeamDecisionKey('U10 Boys', 'Cubs');
    const effective = (decision) =>
      proposePracticeMapping({
        rows: ok,
        league: league(),
        decisions: { teams: { [k]: decision } },
      }).teams[0].effective;
    expect(effective({ action: 'map', id: 'team:lions-boys', source: 'alias' })).toMatchObject({
      source: 'alias',
    });
    expect(effective({ action: 'map', id: 'team:lions-boys', source: 'previous' })).toMatchObject({
      source: 'previous',
    });
    expect(effective({ action: 'map', id: 'team:lions-boys', source: 'exact' })).toMatchObject({
      source: 'admin',
    });
    expect(effective({ action: 'map', id: 'team:lions-boys', source: 'whatever' })).toMatchObject({
      source: 'admin',
    });
    expect(effective({ action: 'map', id: 'team:lions-boys' })).toMatchObject({ source: 'admin' });
  });
});

describe('practice import mapping: created records are one record per parent and final name', () => {
  const create = { action: 'create' };

  it('coalesces a team created under two labels that fold to one name', () => {
    const rows = parsed([
      row({ Team: 'Cubs', Day: 'Mon' }),
      row({ Team: ' CUBS ', Day: 'Wed' }),
      row({ Team: 'Bears', Day: 'Fri' }),
    ]);
    const decisions = {
      teams: {
        [practiceTeamDecisionKey('U10 Boys', 'Cubs')]: create,
        [practiceTeamDecisionKey('U10 Boys', 'Bears')]: { action: 'create', name: 'Cubs' },
      },
    };
    const out = resolvePracticeRows({ rows, league: league(), decisions });
    expect(new Set(out.rows.map((r) => r.ids.team)).size).toBe(1);
    expect(out.creations.teamShells).toHaveLength(1);
  });

  it('keeps a created team’s identity under a division that is itself created', () => {
    const rows = parsed([
      row({ Team: 'Cubs', Division: 'U12 Boys' }),
      row({ Team: 'Cubs', Division: 'u12 boys', Day: 'Wed' }),
    ]);
    const decisions = {
      divisions: { [practiceDivisionDecisionKey('U12 Boys')]: create },
      teams: { [practiceTeamDecisionKey('U12 Boys', 'Cubs')]: create },
    };
    const out = resolvePracticeRows({ rows, league: league(), decisions });
    expect(out.rows.map((r) => r.status)).toEqual(['placement', 'placement']);
    expect(out.creations.divisions).toHaveLength(1);
    expect(out.creations.teamShells).toHaveLength(1);
    expect(out.creations.teamShells[0].divisionId).toBe(out.creations.divisions[0].id);
  });

  it('keeps two labels that contain a delimiter apart: a composite key is a tuple', () => {
    const rows = parsed([
      row({ Location: 'a|b', Field: 'c', Subunit: '' }),
      row({ Location: 'a', Field: 'b|c', Subunit: '', Day: 'Tue' }),
    ]);
    const decisions = {
      locations: {
        [practiceLocationDecisionKey('a|b')]: create,
        [practiceLocationDecisionKey('a')]: create,
      },
      fields: {
        [practiceFieldDecisionKey('a|b', 'c')]: create,
        [practiceFieldDecisionKey('a', 'b|c')]: create,
      },
    };
    const out = resolvePracticeRows({ rows, league: league(), decisions });
    expect(out.rows.map((r) => r.status)).toEqual(['placement', 'placement']);
    expect(out.creations.locations).toHaveLength(2);
    expect(out.creations.fields).toHaveLength(2);
    expect(out.rows[0].ids.field).not.toBe(out.rows[1].ids.field);
    // the keys the decisions sit under are tuples, so the two never meet
    expect(practiceFieldDecisionKey('a|b', 'c')).not.toBe(practiceFieldDecisionKey('a', 'b|c'));
    expect(JSON.parse(practiceFieldDecisionKey('a|b', 'c'))).toEqual(['a|b', 'c']);
    expect(JSON.parse(practiceSubunitDecisionKey('x', 'y,z', 'w'))).toEqual(['x', 'y,z', 'w']);
  });
});

describe('practice import mapping: an alias file and the previous mapping propose; the admin decides', () => {
  const lg = league();
  const aliasFile = (lines) =>
    readPracticeAliases({
      ...readCsvText(['Alias,Location,Field,Subunit', ...lines].join('\n')),
      league: lg,
    });
  const aliasRows = parsed([row({ Field: 'Pitch 1', Subunit: '' })]);
  const fieldKey = practiceFieldDecisionKey('Venue A', 'Pitch 1');

  it('proposes an alias for a label with no exact match, and applies nothing', () => {
    const { aliases } = aliasFile(['Pitch 1,Venue A,Field 2,']);
    const p = proposePracticeMapping({ rows: aliasRows, league: lg, aliases });
    const entry = entryOf(p.fields, fieldKey);
    expect([
      entry.status,
      entry.proposals,
      entry.proposed?.id,
      entry.effective,
      entry.conflict,
    ]).toEqual(['none', [{ source: 'alias', id: 'field:a2' }], 'field:a2', null, false]);
    const r = resolvePracticeRows({ rows: aliasRows, league: lg, aliases }).rows[0];
    expect([r.status, r.reason]).toEqual(['refused', 'unknown-field']); // not applied without the admin
  });

  it('is applied when the admin accepts it, and the mapping says where it came from', () => {
    const { aliases } = aliasFile(['Pitch 1,Venue A,Field 2,']);
    const decisions = acceptAllProposals((d) =>
      proposePracticeMapping({ rows: aliasRows, league: lg, aliases, decisions: d })
    );
    expect(decisions.fields[fieldKey]).toEqual({ action: 'map', id: 'field:a2', source: 'alias' });
    const r = resolvePracticeRows({ rows: aliasRows, league: lg, aliases, decisions }).rows[0];
    expect([r.status, r.ids.field]).toEqual(['placement', 'field:a2']);
  });

  it('shows both and chooses neither when an alias disagrees with an exact match', () => {
    // 'Field 1' is exactly one field of Venue A; the alias file says 'Field 1' is Field 2
    const rows = parsed([row({ Subunit: '' })]);
    const { aliases } = aliasFile(['Field 1,Venue A,Field 2,']);
    const p = proposePracticeMapping({ rows, league: lg, aliases });
    const entry = entryOf(p.fields, practiceFieldDecisionKey('Venue A', 'Field 1'));
    expect(entry.status).toBe('match');
    expect(entry.conflict).toBe(true);
    expect(entry.proposals).toEqual([
      { source: 'exact', id: 'field:a1' },
      { source: 'alias', id: 'field:a2' },
    ]);
    expect([entry.proposed, entry.effective]).toEqual([null, null]); // neither is chosen
    const r = resolvePracticeRows({ rows, league: lg, aliases }).rows[0];
    expect([r.status, r.reason, r.message]).toEqual([
      'refused',
      'unknown-field',
      expect.stringMatching(/disagree/),
    ]);
    // the admin’s word settles it, whichever way
    const either = (id) =>
      resolvePracticeRows({
        rows,
        league: lg,
        aliases,
        decisions: {
          fields: { [practiceFieldDecisionKey('Venue A', 'Field 1')]: { action: 'map', id } },
        },
      }).rows[0];
    expect(either('field:a2').ids.field).toBe('field:a2');
    expect(either('field:a1').ids.field).toBe('field:a1');
  });

  it('lets an alias that agrees with the exact match stand beside it', () => {
    const rows = parsed([row({ Subunit: '' })]);
    const { aliases } = aliasFile(['Field 1,Venue A,Field 1,']);
    const entry = proposePracticeMapping({ rows, league: lg, aliases }).fields[0];
    expect(entry.proposals.map((x) => x.source)).toEqual(['exact', 'alias']);
    expect([entry.conflict, entry.effective]).toEqual([
      false,
      { action: 'map', id: 'field:a1', source: 'exact' },
    ]);
  });

  it('ignores an alias that names ground in another location, and says so', () => {
    const rows = parsed([row({ Location: 'Venue B', Field: 'Pitch 1', Subunit: '' })]);
    const { aliases } = aliasFile(['Pitch 1,Venue A,Field 2,']);
    const entry = proposePracticeMapping({ rows, league: lg, aliases }).fields[0];
    expect(entry.proposals).toEqual([]);
    expect(entry.ignoredProposals).toEqual([
      { source: 'alias', id: 'field:a2', why: 'other-parent' },
    ]);
  });

  it('proposes an alias for a location and a subunit as well', () => {
    const rows = parsed([row({ Location: 'The Annex', Field: 'Field 1', Subunit: 'North' })]);
    const { aliases } = aliasFile(['The Annex,Venue A,,', 'North,Venue A,Field 1,B']);
    const p = proposePracticeMapping({ rows, league: lg, aliases });
    expect(p.locations[0].proposed?.id).toBe('loc:a');
    expect(p.locations[0].effective).toBeNull();
    // a field and a subunit are judged inside a location, so none is asked about until it is decided
    expect([p.fields, p.subunits]).toEqual([[], []]);
    const decisions = acceptAllProposals((d) =>
      proposePracticeMapping({ rows, league: lg, aliases, decisions: d })
    );
    const done = resolvePracticeRows({ rows, league: lg, aliases, decisions }).rows[0];
    expect([done.status, done.ids.location, done.ids.field, done.ids.subunit]).toEqual([
      'placement',
      'loc:a',
      'field:a1',
      'sub:a1b',
    ]);
  });

  describe('the previous import’s mapping', () => {
    const previousFor = (fields) => ({ fields });

    it('is a proposal only: shown, never applied', () => {
      const previous = previousFor({
        [fieldKey]: { action: 'map', id: 'field:a2', source: 'admin' },
      });
      const entry = proposePracticeMapping({ rows: aliasRows, league: lg, previous }).fields[0];
      expect(entry.proposals).toEqual([{ source: 'previous', id: 'field:a2' }]);
      expect([entry.proposed.id, entry.effective]).toEqual(['field:a2', null]);
      const r = resolvePracticeRows({ rows: aliasRows, league: lg, previous }).rows[0];
      expect([r.status, r.reason]).toEqual(['refused', 'unknown-field']);
    });

    it('shows both when it disagrees with the alias file or with the exact match', () => {
      const { aliases } = aliasFile(['Pitch 1,Venue A,Field 2,']);
      const previous = previousFor({ [fieldKey]: { action: 'map', id: 'field:a1' } });
      const entry = proposePracticeMapping({ rows: aliasRows, league: lg, aliases, previous })
        .fields[0];
      expect(entry.conflict).toBe(true);
      expect(entry.proposals.map((x) => [x.source, x.id])).toEqual([
        ['alias', 'field:a2'],
        ['previous', 'field:a1'],
      ]);
      expect([entry.proposed, entry.effective]).toEqual([null, null]);
      // against an exact match
      const rows = parsed([row({ Subunit: '' })]);
      const exact = proposePracticeMapping({
        rows,
        league: lg,
        previous: previousFor({
          [practiceFieldDecisionKey('Venue A', 'Field 1')]: { action: 'map', id: 'field:a2' },
        }),
      }).fields[0];
      expect([exact.conflict, exact.effective]).toEqual([true, null]);
    });

    it('drops what no longer exists, a skip, and a create: only a map to a live record proposes', () => {
      const stale = proposePracticeMapping({
        rows: aliasRows,
        league: lg,
        previous: previousFor({ [fieldKey]: { action: 'map', id: 'field:deleted' } }),
      }).fields[0];
      expect(stale.proposals).toEqual([]);
      expect(stale.ignoredProposals).toEqual([
        { source: 'previous', id: 'field:deleted', why: 'unknown-id' },
      ]);
      for (const decision of [{ action: 'skip' }, { action: 'create' }]) {
        const e = proposePracticeMapping({
          rows: aliasRows,
          league: lg,
          previous: previousFor({ [fieldKey]: decision }),
        }).fields[0];
        expect([decision.action, e.proposals, e.ignoredProposals]).toEqual([
          decision.action,
          [],
          [],
        ]);
      }
    });
  });
});

describe('practice import mapping: reading an alias file', () => {
  const lg = league();
  const read = (text) => readPracticeAliases({ ...readCsvText(text), league: lg });

  it('reads the three levels into plain, storable objects with the league’s ids', () => {
    const out = read(
      [
        'Alias,Location,Field,Subunit',
        'The Annex,Venue A,,',
        'Pitch 1,Venue A,Field 2,',
        'North,Venue A,Field 1,B',
      ].join('\n')
    );
    expect(out.ok).toBe(true);
    expect(out.aliases).toEqual({
      locations: { [practiceLabelKey('The Annex')]: { locationId: 'loc:a' } },
      fields: { [practiceLabelKey('Pitch 1')]: { locationId: 'loc:a', fieldId: 'field:a2' } },
      subunits: {
        [practiceLabelKey('North')]: {
          locationId: 'loc:a',
          fieldId: 'field:a1',
          subunitId: 'sub:a1b',
        },
      },
    });
    expect(JSON.parse(JSON.stringify(out.aliases))).toEqual(out.aliases);
    expect(out.rows.map((r) => [r.status, r.level])).toEqual([
      ['ok', 'location'],
      ['ok', 'field'],
      ['ok', 'subunit'],
    ]);
  });

  it('lists a row it cannot use with its reason, and reads the rest', () => {
    const out = read(
      [
        'Alias,Location,Field,Subunit',
        ',Venue A,Field 1,', // blank-alias
        'x1,Venue Z,Field 1,', // unknown-location
        'x2,Venue A,Field 9,', // unknown-field
        'x3,Venue A,Field 1,C', // unknown-subunit
        'x4,Venue A,,B', // a Subunit with no Field
        'x5,,Field 1,', // a blank Location
        'ok,Venue A,Field 1,A',
      ].join('\n')
    );
    expect(out.rows.map((r) => r.reason)).toEqual([
      'blank-alias',
      'unknown-location',
      'unknown-field',
      'unknown-subunit',
      'unknown-field',
      'unknown-location',
      null,
    ]);
    expect(out.counts).toEqual({ rows: 7, ok: 1, refused: 6 });
    expect(Object.keys(out.aliases.subunits)).toEqual([practiceLabelKey('ok')]);
  });

  it('refuses both rows of an alias that names two different grounds, and keeps neither', () => {
    const out = read(
      [
        'Alias,Location,Field,Subunit',
        'Pitch,Venue A,Field 1,',
        ' pitch ,Venue A,Field 2,',
        'Other,Venue B,Field 1,',
      ].join('\n')
    );
    expect(out.rows.map((r) => r.reason)).toEqual(['alias-conflict', 'alias-conflict', null]);
    expect(Object.keys(out.aliases.fields)).toEqual([practiceLabelKey('Other')]);
  });

  it('calls the same alias for the same ground twice a duplicate, and keeps the first', () => {
    const out = read(
      ['Alias,Location,Field,Subunit', 'Pitch,Venue A,Field 1,', 'PITCH,Venue A,Field 1,'].join(
        '\n'
      )
    );
    expect(out.rows.map((r) => r.reason)).toEqual([null, 'duplicate-row']);
  });

  it('keeps an alias per level: one label can be a location alias and a field alias', () => {
    const out = read(
      ['Alias,Location,Field,Subunit', 'Annex,Venue A,,', 'Annex,Venue B,Field 1,'].join('\n')
    );
    expect(out.rows.map((r) => r.reason)).toEqual([null, null]);
  });

  it('is safe for a label that is a property name', () => {
    const out = read(
      ['Alias,Location,Field,Subunit', '__proto__,Venue A,Field 1,', 'constructor,Venue B,,'].join(
        '\n'
      )
    );
    expect(Object.keys(out.aliases.fields)).toEqual(['__proto__']);
    expect(Object.keys(out.aliases.locations)).toEqual(['constructor']);
    expect(Object.getPrototypeOf(out.aliases.fields)).toBe(Object.prototype);
    const rows = parsed([row({ Field: '__proto__', Subunit: '' })]);
    const entry = proposePracticeMapping({ rows, league: lg, aliases: out.aliases }).fields[0];
    expect(entry.proposals).toEqual([{ source: 'alias', id: 'field:a1' }]);
    // …and a label nobody aliased does not find Object's own properties
    const none = proposePracticeMapping({
      rows: parsed([row({ Field: 'toString', Subunit: '' })]),
      league: lg,
      aliases: out.aliases,
    }).fields[0];
    expect(none.proposals).toEqual([]);
  });

  it('wants an Alias and a Location column, takes Venue for Location, and drops every other column', () => {
    expect(read('Location,Field\nVenue A,Field 1').refusal).toMatchObject({
      code: 'missing-column',
      column: 'Alias',
    });
    expect(read('Alias,Field\nx,Field 1').refusal).toMatchObject({
      code: 'missing-column',
      column: 'Location',
    });
    // (papaparse renames a repeated header, so a repeat is handed over as the header row)
    expect(
      readPracticeAliases({ headers: ['Alias', 'Alias', 'Location'], rows: [], league: lg }).refusal
    ).toMatchObject({ code: 'duplicate-column', column: 'Alias' });
    expect(
      readPracticeAliases({ headers: ['Alias', 'Location', 'Venue'], rows: [], league: lg }).refusal
    ).toMatchObject({ code: 'duplicate-column', column: 'Location' });
    const venue = read('Alias,Venue,Note\nThe Annex,Venue A,SECRET');
    expect(venue.ok).toBe(true);
    expect(venue.droppedColumns).toEqual(['Note']);
    expect(JSON.stringify(venue)).not.toContain('SECRET');
    // a file with no Field or Subunit column is all location aliases
    expect(Object.keys(venue.aliases.locations)).toEqual([practiceLabelKey('The Annex')]);
  });

  it('takes at most 2,400 rows', () => {
    const lines = ['Alias,Location'];
    for (let i = 0; i < 2401; i += 1) lines.push(`a${i},Venue A`);
    expect(read(lines.join('\n')).refusal).toMatchObject({ code: 'too-many-rows' });
    expect(read(lines.slice(0, 2401).join('\n')).ok).toBe(true);
  });

  it('refuses a location name that two locations share, rather than pick one', () => {
    const twice = league({ locations: [...lg.locations, { id: 'loc:a2', name: 'VENUE A' }] });
    const out = readPracticeAliases({ ...readCsvText('Alias,Location\nx,Venue A'), league: twice });
    expect(out.rows[0]).toMatchObject({ status: 'refused', reason: 'unknown-location' });
    expect(out.rows[0].message).toMatch(/more than one/i);
  });
});

describe('practice import: a slot is a ground, a weekday, a start and a date', () => {
  const lg = league();
  /** @param {Array<Record<string, string>>} rows @param {object} [decisions] */
  const resolve = (rows, decisions) =>
    resolvePracticeRows({ rows: parsed(rows), league: lg, decisions });
  const verdicts = (out) => out.rows.map((r) => [r.status, r.reason]);

  it('keys a slot by (field, subunit or the whole field, weekday, start, valid from) as a tuple', () => {
    const key = (over = {}) =>
      practiceSlotKey({
        field: 'f',
        subunit: 'a',
        day: 'mon',
        startTime: '16:00',
        validFrom: '2026-09-07',
        ...over,
      });
    expect(JSON.parse(key())).toEqual(['f', 'a', 'mon', '16:00', '2026-09-07']);
    expect(JSON.parse(key({ subunit: null }))[1]).toBeNull();
    expect(key({ subunit: null })).not.toBe(key({ subunit: '' })); // the whole field is not a half named ''
    expect(
      new Set([key(), key({ subunit: 'b' }), key({ subunit: null }), key({ day: 'tue' })]).size
    ).toBe(4);
    expect(key({ field: 'a|b', subunit: 'c' })).not.toBe(key({ field: 'a', subunit: 'b|c' }));
  });

  it('puts two teams of one cell in one slot, and counts the placements', () => {
    const out = resolve([row(), row({ Team: 'Lions' })]);
    expect(verdicts(out)).toEqual([
      ['placement', null],
      ['placement', null],
    ]);
    expect(out.creations.slots).toHaveLength(1);
    expect(out.creations.slots[0]).toMatchObject({
      placements: 2,
      rowNumbers: [1, 2],
      capacity: 1,
    });
    expect(out.rows[0].slotKey).toBe(out.rows[1].slotKey);
  });

  it('makes a slot of an open row, and none of a hold', () => {
    const out = resolve([
      row({ Team: '', Division: '' }),
      row({ Team: '', Division: '', Use: 'hold', Day: 'Tue' }),
    ]);
    expect(out.creations.slots.map((s) => s.placements)).toEqual([0]);
    expect(out.holds.map((h) => h.rowNumber)).toEqual([2]);
    expect(out.rows[1].status).toBe('hold');
    expect(out.counts).toMatchObject({ placements: 0, open: 1, holds: 1, slots: 1 });
  });

  it('keeps two halves of a field apart, and does not merge a team on both into a whole-field row', () => {
    // The merged cell of the grid, converted wrongly: one team, two halves, one time.
    const out = resolve([row({ Subunit: 'A' }), row({ Subunit: 'B' })]);
    expect(verdicts(out)).toEqual([
      ['placement', null],
      ['placement', null],
    ]);
    expect(out.creations.slots.map((s) => s.subunitId).sort()).toEqual(['sub:a1a', 'sub:a1b']);
    expect(out.rows.map((r) => r.ids.subunit).sort()).toEqual(['sub:a1a', 'sub:a1b']); // not null, not one row
    expect(out.rows.map((r) => r.subunitLabel)).toEqual(['A', 'B']);
    // …and both rows are flagged, with the hint
    for (const r of out.rows) {
      expect(r.flags.map((f) => f.code)).toEqual(['team-on-both-halves']);
      expect(r.flags[0].message).toMatch(/leave Subunit blank for the whole field/);
    }
    expect(out.rows[0].flags[0].details.withRow).toBe(2);
    expect(out.counts.flags).toEqual({ 'team-on-both-halves': { rows: 2, teams: 1 } });
    // a whole-field row for the same team is the answer, and is one slot
    const whole = resolve([row({ Subunit: '' })]);
    expect(whole.creations.slots[0].subunitId).toBeNull();
    expect(whole.rows[0].flags).toEqual([]);
  });

  it('does not flag two different teams on two halves, or one team on one half at two times', () => {
    const out = resolve([
      row({ Subunit: 'A' }),
      row({ Subunit: 'B', Team: 'Lions' }),
      row({ Subunit: 'B', Start: '17:00', End: '18:00' }),
    ]);
    expect(out.rows.flatMap((r) => r.flags)).toEqual([]);
  });

  it('refuses the later of two slots that overlap on one ground, naming the earlier row', () => {
    // a whole field against a half
    const whole = resolve([
      row({ Subunit: 'A' }),
      row({ Team: 'Lions', Subunit: '', Start: '16:30', End: '17:30' }),
    ]);
    expect(verdicts(whole)).toEqual([
      ['placement', null],
      ['refused', 'slot-overlaps-another'],
    ]);
    expect(whole.rows[1].message).toMatch(/row 1/);
    expect(whole.creations.slots).toHaveLength(1);
    // the other way round: the whole field is first, so the half is the one refused
    const reverse = resolve([
      row({ Subunit: '' }),
      row({ Team: 'Lions', Subunit: 'B', Start: '16:30', End: '17:30' }),
    ]);
    expect(verdicts(reverse)).toEqual([
      ['placement', null],
      ['refused', 'slot-overlaps-another'],
    ]);
    // two overlapping times on one half
    expect(
      resolve([row(), row({ Team: 'Lions', End: '17:30', Start: '16:30' })]).rows[1].reason
    ).toBe('slot-overlaps-another');
  });

  it('allows back to back, two halves at one time, and other fields, weekdays and locations', () => {
    const out = resolve([
      row(),
      row({ Team: 'Lions', Start: '17:00', End: '18:00' }), // back to back
      row({ Team: 'Lions', Subunit: 'B', Day: 'Wed' }), // the other half
      row({ Team: 'Lions', Subunit: 'B' }), // the other half at the same time
      row({ Field: 'Field 2', Subunit: '' }),
      row({ Day: 'Tue' }),
      row({ Location: 'Venue B', Field: 'Field 1', Subunit: 'A' }),
    ]);
    expect(out.rows.map((r) => r.reason)).toEqual(Array(7).fill(null));
  });

  it('judges overlap on resolved ground, not on the labels: two spellings of one field clash', () => {
    const out = resolve([
      row({ Field: 'Field 1' }),
      row({ Field: ' FIELD  1 ', Team: 'Lions', Start: '16:30', End: '17:30' }),
    ]);
    expect(out.rows[1].reason).toBe('slot-overlaps-another');
  });

  it('shares weekdays, not just dates: windows that never share the weekday do not clash', () => {
    const cell = (from, until, team) =>
      row({ Day: 'Wed', Team: team, 'Valid From': from, 'Valid Until': until });
    // 7-8 Sep (Mon-Tue) and 8-9 Sep (Tue-Wed): they share the 8th, a Tuesday, and the Wednesday is the 9th only
    const apart = resolve([
      cell('2026-09-07', '2026-09-08', 'Sharks'),
      cell('2026-09-08', '2026-09-08', 'Lions'),
    ]);
    expect(apart.rows.map((r) => r.reason)).toEqual([null, null]);
    const together = resolve([
      cell('2026-09-07', '2026-09-09', 'Sharks'),
      cell('2026-09-09', '2026-09-16', 'Lions'),
    ]);
    expect(together.rows.map((r) => r.reason)).toEqual([null, 'slot-overlaps-another']);
    // a different valid-from is a different slot, and an overlapping one is still a clash
    const later = resolve([
      cell('2026-09-07', '2026-11-20', 'Sharks'),
      cell('2026-10-05', '2026-11-20', 'Lions'),
    ]);
    expect(later.rows[1].reason).toBe('slot-overlaps-another');
  });

  it('refuses a row that restates its slot with another end, capacity or Valid Until', () => {
    const out = resolve([
      row(),
      row({ Team: 'Lions', End: '17:30' }),
      row({ Team: 'Lions', Capacity: '2' }),
      row({ Team: 'Lions', 'Valid Until': '2026-10-30' }),
    ]);
    expect(out.rows.map((r) => r.reason)).toEqual([
      null,
      'slot-overlaps-another',
      'slot-overlaps-another',
      'slot-overlaps-another',
    ]);
    for (const r of out.rows.slice(1)) expect(r.message).toMatch(/row 1/);
  });

  it('refuses every row of a slot it refuses, including a later row of the same key', () => {
    const out = resolve([
      row(),
      row({ Team: 'Lions', Subunit: '', Start: '16:30', End: '17:30' }),
      row({ Team: 'Sharks', Subunit: '', Start: '16:30', End: '17:30', Division: 'U10 Boys' }),
    ]);
    expect(out.rows.map((r) => r.reason)).toEqual([
      null,
      'slot-overlaps-another',
      'slot-overlaps-another',
    ]);
  });

  it('calls two labels mapped onto one team a duplicate after mapping, and keeps the first', () => {
    const rows = parsed([row({ Team: 'Cubs' }), row({ Team: 'Cubs Red' })]);
    const decisions = {
      teams: {
        [practiceTeamDecisionKey('U10 Boys', 'Cubs')]: { action: 'map', id: 'team:lions-boys' },
        [practiceTeamDecisionKey('U10 Boys', 'Cubs Red')]: { action: 'map', id: 'team:lions-boys' },
      },
    };
    const out = resolvePracticeRows({ rows, league: lg, decisions });
    expect(out.rows.map((r) => [r.status, r.reason])).toEqual([
      ['placement', null],
      ['refused', 'duplicate-row'],
    ]);
    expect(out.rows[1].message).toMatch(/After mapping/);
  });

  it('flags a hold over a slot in the same file, open or used', () => {
    const out = resolve([
      row({ Team: '', Division: '' }), // open
      row({ Team: '', Division: '', Use: 'hold' }), // the same cell
      row({ Team: 'Lions', Subunit: 'B', Day: 'Wed' }), // used
      row({
        Team: '',
        Division: '',
        Use: 'hold',
        Subunit: '',
        Day: 'Wed',
        Start: '16:30',
        End: '17:30',
      }), // whole over a half
      row({ Team: '', Division: '', Use: 'hold', Day: 'Fri' }), // nothing there
    ]);
    expect(out.rows[1].flags.map((f) => f.code)).toEqual(['hold-over-open-slot']);
    expect(out.rows[1].flags[0].details).toMatchObject({ withRow: 1, used: false });
    expect(out.rows[3].flags[0].details).toMatchObject({ withRow: 3, used: true });
    expect(out.rows[4].flags).toEqual([]);
    expect(out.counts.flags['hold-over-open-slot']).toEqual({ rows: 2 });
  });

  it('compares a hold with existing ground that only the hold names (Codex P2)', () => {
    // An open WHOLE-field slot, and a hold on half A: the league has the half, no slot names it.
    const rows = [
      row({ Team: '', Division: '', Subunit: '' }),
      row({ Team: '', Division: '', Use: 'hold', Subunit: 'A', Start: '16:30', End: '17:30' }),
    ];
    const out = resolve(rows);
    expect(out.rows[1].ids).toMatchObject({ field: 'field:a1', subunit: 'sub:a1a', team: null });
    expect(out.rows[1].flags.map((f) => f.code)).toEqual(['hold-over-open-slot']);
    expect(out.rows[1].flags[0].details).toMatchObject({ withRow: 1, used: false });
    // …and a hold still makes no slot, and asks for no mapping
    expect(out.creations.slots).toHaveLength(1);
    expect(out.holds.map((h) => h.rowNumber)).toEqual([2]);
    const asked = proposePracticeMapping({ rows: parsed(rows), league: league() });
    expect(asked.subunits).toEqual([]);
    // controls: a half the league has, held at another time, is resolved and not flagged; a half the
    // league does not have cannot be compared; a half of a field the file does not use is resolved too
    const apart = resolve([
      row({ Team: '', Division: '', Subunit: '' }),
      row({ Team: '', Division: '', Use: 'hold', Subunit: 'A', Start: '18:00', End: '19:00' }),
    ]);
    expect(apart.rows[1].ids).toMatchObject({ subunit: 'sub:a1a' });
    expect(apart.rows[1].flags).toEqual([]);
    const unknown = resolve([
      row({ Team: '', Division: '', Subunit: '' }),
      row({ Team: '', Division: '', Use: 'hold', Subunit: 'Z', Start: '16:30', End: '17:30' }),
    ]);
    expect(unknown.rows[1].ids).toBeNull();
    const otherField = resolve([
      row({ Team: '', Division: '', Subunit: '' }),
      row({ Team: '', Division: '', Use: 'hold', Location: 'Venue B', Subunit: 'A' }),
    ]);
    expect(otherField.rows[1].ids).toMatchObject({
      location: 'loc:b',
      field: 'field:b1',
      subunit: 'sub:b1a',
    });
    expect(otherField.rows[1].flags).toEqual([]);
  });

  it('gives a hold the admin’s own decision when other rows use the same label', () => {
    // 'Venue A' is decided to be Venue B for the open row; the hold that says 'Venue A' follows it.
    const decisions = {
      locations: { [practiceLocationDecisionKey('Venue A')]: { action: 'map', id: 'loc:b' } },
      fields: {
        [practiceFieldDecisionKey('Venue A', 'Field 1')]: { action: 'map', id: 'field:b1' },
      },
    };
    const out = resolvePracticeRows({
      rows: parsed([
        row({ Team: '', Division: '', Subunit: '' }),
        row({ Team: '', Division: '', Use: 'hold', Subunit: 'A', Start: '16:30', End: '17:30' }),
      ]),
      league: league(),
      decisions,
    });
    expect(out.rows[0].ids).toMatchObject({ location: 'loc:b', field: 'field:b1' });
    expect(out.rows[1].ids).toMatchObject({
      location: 'loc:b',
      field: 'field:b1',
      subunit: 'sub:b1a',
    });
    expect(out.rows[1].flags.map((f) => f.code)).toEqual(['hold-over-open-slot']);
  });

  it('does not compare a hold whose ground the file never names for a slot', () => {
    const out = resolve([row({ Team: '', Division: '', Use: 'hold', Location: 'Nowhere Venue' })]);
    expect(out.rows[0].status).toBe('hold');
    expect(out.rows[0].ids).toBeNull();
    expect(out.rows[0].flags).toEqual([]);
  });

  it('counts what it resolved', () => {
    const out = resolve([
      row(),
      row({ Team: '', Division: '', Day: 'Tue' }),
      row({ Team: '', Division: '', Use: 'hold', Day: 'Wed' }),
      row({ Day: 'Funday' }),
      row({ Team: 'Nobody', Day: 'Thu' }),
    ]);
    expect(out.counts).toMatchObject({
      rows: 5,
      placements: 1,
      open: 1,
      holds: 1,
      refused: 2,
      skipped: 0,
      slots: 2,
      byReason: { 'bad-day': 1, 'unknown-team': 1 },
    });
  });
});

describe('practice import: slotKey’s overlap rule is the database’s supply rule', () => {
  const slot = (over = {}) => ({
    fieldId: 'f',
    subunitId: 'a',
    day: 'mon',
    startTime: '16:00',
    endTime: '17:00',
    validFrom: '2026-09-07',
    validUntil: '2026-11-20',
    ...over,
  });
  it('is symmetric, and clashes a whole field with each half only', () => {
    const pairs = [
      [slot(), slot({ startTime: '16:30', endTime: '17:30' }), true],
      [slot(), slot({ startTime: '17:00', endTime: '18:00' }), false], // back to back
      [slot(), slot({ subunitId: 'b' }), false],
      [slot(), slot({ subunitId: null }), true],
      [slot({ subunitId: null }), slot({ subunitId: 'b' }), true],
      [slot(), slot({ fieldId: 'g' }), false],
      [slot(), slot({ day: 'tue' }), false],
      [slot(), slot({ validFrom: '2026-11-21', validUntil: '2026-12-01' }), false],
    ];
    for (const [a, b, clash] of /** @type {Array<[any, any, boolean]>} */ (pairs)) {
      expect([practiceSlotsOverlap(a, b), practiceSlotsOverlap(b, a)]).toEqual([clash, clash]);
    }
  });
});

describe('practice import mapping: the fixture, end to end', () => {
  const fixture = loadPracticeFixture();
  const lg = fixture.league;
  const file = parsePracticeRows({
    headers: fixture.schedule.headers,
    rows: fixture.schedule.rows,
    season: fixture.season,
  });
  const aliasRead = readPracticeAliases({ ...fixture.aliases, league: lg });
  const propose = (decisions, extra = {}) =>
    proposePracticeMapping({
      rows: file.rows,
      league: lg,
      aliases: aliasRead.aliases,
      decisions,
      ...extra,
    });

  it('reads the alias file whole: 21 rows, none refused', () => {
    expect(aliasRead.ok).toBe(true);
    expect(aliasRead.counts).toEqual({ rows: 21, ok: 21, refused: 0 });
  });

  it('without the alias file, the alias spellings are unknown and nothing is guessed', () => {
    const bare = resolvePracticeRows({ rows: file.rows, league: lg });
    expect(bare.counts.refused).toBeGreaterThan(300);
    const reasons = Object.keys(bare.counts.byReason);
    for (const code of ['unknown-field', 'unknown-location', 'unknown-subunit']) {
      expect(reasons).toContain(code);
    }
    expect(
      reasons.filter((c) => !c.startsWith('unknown-') && c !== 'slot-overlaps-another')
    ).toEqual([]);
    // with the alias file but no decisions it is the same: proposals are not applied
    const proposed = resolvePracticeRows({
      rows: file.rows,
      league: lg,
      aliases: aliasRead.aliases,
    });
    expect(proposed.counts).toEqual(bare.counts);
  });

  it('proposes each alias spelling from the file and the 132 teams by their exact names', () => {
    const p = propose({});
    expect(p.teams).toHaveLength(132); // the two stray-whitespace labels folded into their teams
    expect(p.teams.every((e) => e.status === 'match' && e.effective?.source === 'exact')).toBe(
      true
    );
    expect(p.divisions).toHaveLength(20);
    const annex = entryOf(p.locations, practiceLocationDecisionKey('Venue G Annex'));
    expect([annex.status, annex.proposals]).toEqual([
      'none',
      [{ source: 'alias', id: 'loc:Venue G' }],
    ]);
    const pitch = entryOf(p.fields, practiceFieldDecisionKey('Venue C', 'Pitch C1'));
    expect(pitch.proposed.id).toBe('field:Venue C/Field 1');
    expect(pitch.effective).toBeNull();
    // the north/south halves are judged once their field is exact
    const north = entryOf(p.subunits, practiceSubunitDecisionKey('Venue H', 'Field 1', 'H1 North'));
    expect(north.proposals).toEqual([{ source: 'alias', id: 'sub:Venue H/Field 1/A' }]);
  });

  it('resolves every row once the admin accepts the proposals: one refusal, and it is the planted overlap', () => {
    const decisions = acceptAllProposals((d) => propose(d));
    const out = resolvePracticeRows({
      rows: file.rows,
      league: lg,
      aliases: aliasRead.aliases,
      decisions,
    });
    expect(out.counts).toMatchObject({
      rows: 710,
      placements: 236,
      open: 472,
      holds: 1,
      refused: 1,
      skipped: 0,
      byReason: { 'slot-overlaps-another': 1 },
    });
    expect(out.creations).toMatchObject({
      divisions: [],
      locations: [],
      fields: [],
      subunits: [],
      teamShells: [],
    });
    // the slot count, from the CSV: distinct cells of non-hold rows, less the overlapping one refused
    const cells = new Set(
      fixture.schedule.rows
        .filter((r) => r.Use !== 'hold')
        .map((r) => JSON.stringify([r.Location, r.Field, r.Subunit, r.Day, r.Start]))
    );
    expect(out.creations.slots).toHaveLength(cells.size - 1);
    // the one team on two halves, from the plant, is the one flagged
    expect(out.counts.flags['team-on-both-halves']).toEqual({ rows: 2, teams: 1 });
    // 132 teams, each with rows: the stray whitespace made no 133rd
    expect(
      new Set(out.rows.filter((r) => r.status === 'placement').map((r) => r.ids.team)).size
    ).toBe(132);
  });

  it('proposes the previous import’s mapping the same way: shown, not applied', () => {
    const decisions = acceptAllProposals((d) => propose(d));
    const again = proposePracticeMapping({
      rows: file.rows,
      league: lg,
      previous: decisions,
    });
    const pitch = entryOf(again.fields, practiceFieldDecisionKey('Venue C', 'Pitch C1'));
    expect(pitch.proposals).toEqual([{ source: 'previous', id: 'field:Venue C/Field 1' }]);
    expect(pitch.effective).toBeNull();
    const out = resolvePracticeRows({ rows: file.rows, league: lg, previous: decisions });
    expect(out.counts.refused).toBeGreaterThan(300);
  });
});
