// @vitest-environment node
/**
 * The division practice settings a practice file proposes (`packages/core/src/practiceImport/mapping.js`
 * `proposeDivisionSettings`; plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11.5, decision 26;
 * PR 9 task J2).
 *
 * What this holds:
 *
 *   - **`practices_per_week` is the most common count of rows per team, and a tie proposes nothing.**
 *     A division whose teams split evenly between one and two practices has no modal count, and a
 *     guess between them is the decision nobody made (lesson 86).
 *   - **`practice_minutes` is the slot length when every placement of the division has one length, else
 *     `any`.**
 *   - **Teams are counted by what they resolve to, not by how the file spelled them**: a label with
 *     stray whitespace is one team with two rows, not two teams with one each (which would propose
 *     one a week for a division of two-a-week teams).
 *   - **A proposal sits beside the stored value, and is applied only for a ticked division.** A division
 *     at one a week with no length is the column default and cannot be told from "unset", so the
 *     proposal says what is stored and whether it differs, and leaves the asking to the screen.
 *   - Only placements count: an open slot, a hold, a refused row and a skipped row are nobody's practice.
 *
 * Statically out of reach, and so not claimed: how a proposal reaches `admin_upsert_division_settings`
 * (PR 10's first design task; this module returns the values and a selector, no signature), and how
 * `any` is written there.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRACTICE_IMPORT_LIMITS } from '../packages/core/src/practiceImport/reasonCodes.js';
import {
  divisionSettingsToApply,
  practiceDivisionDecisionKey,
  practiceTeamDecisionKey,
  proposeDivisionSettings,
  proposePracticeMapping,
  resolvePracticeRows,
} from '../packages/core/src/practiceImport/mapping.js';
import { readPracticeAliases } from '../packages/core/src/practiceImport/aliases.js';
import { parsePracticeRows } from '../packages/core/src/practiceImport/parseRows.js';
import { acceptAllProposals, loadPracticeFixture } from './helpers/practiceFixtureLoad.js';

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
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const row = (over = {}) => ({
  Team: 'T1',
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

const league = (over = {}) => ({
  divisions: [
    { id: 'div:boys', name: 'U10 Boys', practicesPerWeek: 1, practiceMinutes: null },
    { id: 'div:girls', name: 'U10 Girls', practicesPerWeek: 2, practiceMinutes: 60 },
  ],
  teams: [
    ...['T1', 'T2', 'T3', 'T4', 'T5'].map((name) => ({
      id: `team:${name}`,
      name,
      divisionId: 'div:boys',
    })),
    ...['G1', 'G2'].map((name) => ({ id: `team:${name}`, name, divisionId: 'div:girls' })),
  ],
  locations: [{ id: 'loc:a', name: 'Venue A' }],
  fields: [{ id: 'field:a1', locationId: 'loc:a', name: 'Field 1' }],
  subunits: [
    { id: 'sub:a', fieldId: 'field:a1', name: 'A' },
    { id: 'sub:b', fieldId: 'field:a1', name: 'B' },
  ],
  ...over,
});

/**
 * One row per (team, k): each practice of each team in its own cell so that nothing overlaps.
 * `plan` is `{ T1: 2, T2: 1 }`: practices per team. `minutes` is the slot length (60 by default).
 *
 * @param {Record<string, number>} plan
 * @param {{ division?: string, minutes?: (team: string, k: number) => number, extra?: Array<Record<string, string>> }} [options]
 */
function fileFor(plan, { division = 'U10 Boys', minutes = () => 60, extra = [] } = {}) {
  let cell = 0;
  const rows = [];
  for (const [team, n] of Object.entries(plan)) {
    for (let k = 0; k < n; k += 1) {
      const m = minutes(team, k);
      const start = 16 * 60 + (cell % 4) * 120;
      const hhmm = (t) =>
        `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      rows.push(
        row({
          Team: team,
          Division: division,
          Day: DAYS[Math.floor(cell / 4) % 5],
          Start: hhmm(start),
          End: hhmm(start + m),
        })
      );
      cell += 1;
    }
  }
  return [...rows, ...extra];
}

const propose = (rows, lg = league(), decisions) => {
  const parsed = parsePracticeRows({ headers: HEADERS, rows, season: SEASON }).rows;
  const resolved = resolvePracticeRows({ rows: parsed, league: lg, decisions });
  return { resolved, settings: proposeDivisionSettings({ rows: resolved.rows, league: lg }) };
};
const boys = (settings) => settings.find((d) => d.label === 'U10 Boys');

/* -------------------------------------------------------------------------- */

describe('practice import settings: practices a week', () => {
  it('proposes the most common count of rows per team', () => {
    const { settings } = propose(fileFor({ T1: 2, T2: 2, T3: 2, T4: 1, T5: 3 }));
    const d = boys(settings);
    expect(d.practicesPerWeek).toMatchObject({
      proposed: 2,
      tie: false,
      histogram: { 1: 1, 2: 3, 3: 1 },
    });
    expect([d.teams, d.rows]).toEqual([5, 10]);
  });

  it('proposes one a week when most teams have one, whatever the stored value says', () => {
    const { settings } = propose(fileFor({ T1: 1, T2: 1, T3: 1, T4: 2 }), league());
    expect(boys(settings).practicesPerWeek.proposed).toBe(1);
  });

  it('proposes nothing on a tie, and says there was one', () => {
    const { settings } = propose(fileFor({ T1: 1, T2: 1, T3: 2, T4: 2 }));
    expect(boys(settings).practicesPerWeek).toMatchObject({
      proposed: null,
      tie: true,
      tied: [1, 2],
      histogram: { 1: 2, 2: 2 },
    });
    // three counts in a three-way tie, and a tie for the top only
    const three = propose(fileFor({ T1: 1, T2: 2, T3: 3 }));
    expect(boys(three.settings).practicesPerWeek).toMatchObject({
      proposed: null,
      tied: [1, 2, 3],
    });
    const top = propose(fileFor({ T1: 1, T2: 2, T3: 2, T4: 3, T5: 3 }));
    expect(boys(top.settings).practicesPerWeek).toMatchObject({ proposed: null, tied: [2, 3] });
  });

  it('is never a tie of one team: a single team proposes its own count', () => {
    expect(boys(propose(fileFor({ T1: 3 })).settings).practicesPerWeek.proposed).toBe(3);
  });

  it('counts teams by what they resolve to, so stray whitespace does not split a team', () => {
    // 'T1 ' and 'T1' are one team with two rows. Read as two teams they have one row each, and the
    // division of two-a-week teams would be proposed at one a week.
    const rows = [
      row({ Team: 'T1 ', Day: 'Mon' }),
      row({ Team: 'T1', Day: 'Wed' }),
      row({ Team: 'T2', Day: 'Tue' }),
      row({ Team: ' t2', Day: 'Thu' }),
    ];
    const { settings, resolved } = propose(rows);
    expect(resolved.rows.map((r) => r.ids.team)).toEqual([
      'team:T1',
      'team:T1',
      'team:T2',
      'team:T2',
    ]);
    expect(boys(settings).practicesPerWeek).toMatchObject({ proposed: 2, histogram: { 2: 2 } });
    expect(boys(settings).teams).toBe(2);
  });

  it('counts a division by what it resolves to, not by the label the file wrote', () => {
    const rows = [
      row({ Team: 'T1', Division: 'U10 Boys', Day: 'Mon' }),
      row({ Team: 'T1', Division: ' u10  boys ', Day: 'Wed' }),
    ];
    const { settings } = propose(rows);
    expect(settings).toHaveLength(1);
    expect(settings[0].practicesPerWeek.proposed).toBe(2);
  });

  it('counts only placements: not an open slot, a hold, a refused row or a skipped one', () => {
    const rows = [
      ...fileFor({ T1: 2, T2: 2 }),
      row({ Team: '', Division: '', Day: 'Fri', Start: '16:00', End: '17:00' }), // open
      row({ Team: '', Division: '', Day: 'Fri', Start: '17:00', End: '18:00', Use: 'hold' }),
      row({ Team: 'T3', Day: 'Funday' }), // refused at the parse
      row({ Team: 'T4', Day: 'Sat', Location: 'Venue Z' }), // skipped below
    ];
    const decisions = { locations: { 'venue z': { action: 'skip' } } };
    const { settings, resolved } = propose(rows, league(), decisions);
    expect(resolved.counts).toMatchObject({ refused: 1, skipped: 1, holds: 1, open: 1 });
    expect(boys(settings)).toMatchObject({ teams: 2, rows: 4 });
    expect(boys(settings).practicesPerWeek.proposed).toBe(2);
  });

  it('proposes for a division it has no placement in? No: a division with no placements is not listed', () => {
    const { settings } = propose([row({ Team: '', Division: '' })]);
    expect(settings).toEqual([]);
  });

  it('lists each division of the file once, in a stable order, and keeps them apart', () => {
    const rows = [
      ...fileFor({ T1: 2, T2: 2 }),
      ...fileFor({ G1: 1, G2: 1 }, { division: 'U10 Girls' }).map((r) => ({
        ...r,
        Location: 'Venue A',
        Field: 'Field 1',
        Subunit: 'B',
      })),
    ];
    const { settings } = propose(rows);
    expect(settings.map((d) => d.label)).toEqual(['U10 Boys', 'U10 Girls']);
    expect(settings.map((d) => d.practicesPerWeek.proposed)).toEqual([2, 1]);
    // the same result in the other order of rows
    const reversed = propose([...rows].reverse()).settings;
    expect(reversed.map((d) => d.label)).toEqual(['U10 Boys', 'U10 Girls']);
  });
});

describe('practice import settings: the practice length', () => {
  const lengths = (minutes) =>
    boys(
      propose(
        fileFor({ T1: 2, T2: 2 }, { minutes: (team, k) => minutes[(team === 'T1' ? 0 : 2) + k] })
      ).settings
    ).practiceMinutes;

  it('is the length when every placement has one', () => {
    expect(lengths([60, 60, 60, 60])).toMatchObject({ proposed: 60, lengths: [60] });
    expect(lengths([45, 45, 45, 45])).toMatchObject({ proposed: 45, lengths: [45] });
  });

  it('is "any" when the lengths differ, and lists them', () => {
    expect(lengths([60, 60, 60, 45])).toMatchObject({ proposed: 'any', lengths: [45, 60] });
    expect(lengths([45, 60, 75, 90])).toMatchObject({ proposed: 'any', lengths: [45, 60, 75, 90] });
  });

  it('reads a length from the cell’s start and end, in minutes', () => {
    const rows = [
      row({ Start: '4:00 PM', End: '5:15 PM' }),
      row({ Day: 'Wed', Start: '16:00', End: '17:15' }),
    ];
    expect(boys(propose(rows).settings).practiceMinutes).toMatchObject({
      proposed: 75,
      lengths: [75],
    });
  });

  it('ignores the length of an open slot: it is supply, not a practice', () => {
    const rows = [
      ...fileFor({ T1: 2 }),
      row({ Team: '', Division: '', Day: 'Fri', Start: '16:00', End: '16:30' }),
    ];
    expect(boys(propose(rows).settings).practiceMinutes.proposed).toBe(60);
  });
});

describe('practice import settings: beside the stored values, and applied only when ticked', () => {
  it('carries what is stored, and whether the proposal differs from it', () => {
    const { settings } = propose(fileFor({ T1: 2, T2: 2 }));
    const d = boys(settings);
    expect(d.divisionId).toBe('div:boys');
    expect(d.isNew).toBe(false);
    expect(d.practicesPerWeek).toMatchObject({ proposed: 2, stored: 1, differs: true });
    expect(d.practiceMinutes).toMatchObject({ proposed: 60, stored: null, differs: true });
    // a division already at what the file says differs in nothing
    const girls = propose(
      fileFor({ G1: 2, G2: 2 }, { division: 'U10 Girls' }).map((r) => ({ ...r, Subunit: 'B' }))
    ).settings[0];
    expect(girls.practicesPerWeek).toMatchObject({ proposed: 2, stored: 2, differs: false });
    expect(girls.practiceMinutes).toMatchObject({ proposed: 60, stored: 60, differs: false });
  });

  it('differs from nothing when it proposes nothing: a tie is not a change', () => {
    const d = boys(propose(fileFor({ T1: 1, T2: 2 })).settings);
    expect(d.practicesPerWeek).toMatchObject({ proposed: null, differs: false });
  });

  it('marks a division the import would create: nothing is stored for it', () => {
    const rows = fileFor({ T1: 2, T2: 2 }, { division: 'U12 Boys' });
    const decisions = {
      divisions: { [practiceDivisionDecisionKey('U12 Boys')]: { action: 'create' } },
      teams: {
        [practiceTeamDecisionKey('U12 Boys', 'T1')]: { action: 'create' },
        [practiceTeamDecisionKey('U12 Boys', 'T2')]: { action: 'create' },
      },
    };
    const { settings } = propose(rows, league(), decisions);
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ isNew: true, label: 'U12 Boys' });
    expect(settings[0].divisionId).toMatch(/^new:division:/);
    expect(settings[0].practicesPerWeek).toMatchObject({ proposed: 2, stored: null });
  });

  it('applies a proposal only for a ticked division, and only the values it proposes', () => {
    const { settings } = propose([
      ...fileFor({ T1: 2, T2: 2 }),
      ...fileFor(
        { G1: 1, G2: 2 },
        { division: 'U10 Girls', minutes: (team, k) => (k === 0 ? 60 : 45) }
      ).map((r) => ({
        ...r,
        Subunit: 'B',
      })),
    ]);
    expect(divisionSettingsToApply(settings, [])).toEqual([]); // nothing ticked, nothing applied
    expect(divisionSettingsToApply(settings, ['div:boys'])).toEqual([
      { divisionId: 'div:boys', isNew: false, practicesPerWeek: 2, practiceMinutes: 60 },
    ]);
    // the girls tie at one and two a week: no count is proposed, so none is applied; their lengths differ
    expect(divisionSettingsToApply(settings, ['div:girls'])).toEqual([
      { divisionId: 'div:girls', isNew: false, practiceMinutes: 'any' },
    ]);
    expect(
      divisionSettingsToApply(settings, new Set(['div:girls', 'div:boys'])).map((p) => p.divisionId)
    ).toEqual(['div:boys', 'div:girls']);
    // a division whose proposal is what is stored has nothing to apply, ticked or not
    const same = propose(
      fileFor({ G1: 2, G2: 2 }, { division: 'U10 Girls' }).map((r) => ({ ...r, Subunit: 'B' }))
    ).settings;
    expect(divisionSettingsToApply(same, ['div:girls'])).toEqual([]);
    // a tick for a division the file never named is a defect in the caller, not something to skip
    expect(() => divisionSettingsToApply(settings, ['div:nowhere'])).toThrow(/div:nowhere/);
  });
});

describe('practice import settings: a value the database would refuse is withheld, not emitted (Codex P2)', () => {
  // admin_upsert_division_settings: 0 to 7 practices a week; a practice length of 15 to 240 minutes
  // (0 for any) - `20261105010000`, lines 1573-1580.
  const lengthOf = (m) => boxed(fileFor({ T1: 2, T2: 2 }, { minutes: () => m }));
  const boxed = (rows) => propose(rows).settings;

  it('takes its ranges from the RPC’s own text, so a change there fails here', () => {
    const sql = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'supabase/migrations/20261105010000_practices_per_division.sql'
      ),
      'utf8'
    );
    const week = /v_ppw NOT BETWEEN (\d+) AND (\d+)/.exec(sql);
    const minutes = /v_min NOT BETWEEN (\d+) AND (\d+)/.exec(sql);
    expect(week).not.toBeNull(); // the scan found the RPC's checks
    expect(minutes).not.toBeNull();
    expect([Number(week[1]), Number(week[2])]).toEqual([
      PRACTICE_IMPORT_LIMITS.MIN_PRACTICES_PER_WEEK,
      PRACTICE_IMPORT_LIMITS.MAX_PRACTICES_PER_WEEK,
    ]);
    expect([Number(minutes[1]), Number(minutes[2])]).toEqual([
      PRACTICE_IMPORT_LIMITS.MIN_PRACTICE_MINUTES,
      PRACTICE_IMPORT_LIMITS.MAX_PRACTICE_MINUTES,
    ]);
  });

  it('does not emit a length outside 15 to 240, and says what it withheld', () => {
    const settings = lengthOf(10);
    expect(boys(settings).practiceMinutes).toMatchObject({ proposed: 10, storable: false });
    const patch = divisionSettingsToApply(settings, ['div:boys']);
    expect(patch).toEqual([
      {
        divisionId: 'div:boys',
        isNew: false,
        practicesPerWeek: 2, // the count is storable and still applied
        withheld: [
          { setting: 'practiceMinutes', proposed: 10, why: 'out-of-range', min: 15, max: 240 },
        ],
      },
    ]);
    expect(JSON.stringify(patch)).not.toMatch(/"practiceMinutes":10/);
  });

  it('keeps a division with only an unstorable value in the answer, so the screen can say so', () => {
    const rows = fileFor({ T1: 2, T2: 2 }, { minutes: () => 10 });
    const lg = league({
      divisions: [
        { id: 'div:boys', name: 'U10 Boys', practicesPerWeek: 2, practiceMinutes: 60 },
        { id: 'div:girls', name: 'U10 Girls', practicesPerWeek: 2, practiceMinutes: 60 },
      ],
    });
    const settings = propose(rows, lg).settings;
    expect(divisionSettingsToApply(settings, ['div:boys'])).toEqual([
      {
        divisionId: 'div:boys',
        isNew: false,
        withheld: [
          { setting: 'practiceMinutes', proposed: 10, why: 'out-of-range', min: 15, max: 240 },
        ],
      },
    ]);
  });

  it('stores 15 and 240, refuses 14 and 241, and always stores "any"', () => {
    const stored = (m) => boys(lengthOf(m)).practiceMinutes.storable;
    expect([stored(15), stored(240), stored(14), stored(241)]).toEqual([true, true, false, false]);
    const mixed = boys(
      boxed(fileFor({ T1: 2, T2: 2 }, { minutes: (team, k) => (k === 0 ? 10 : 60) }))
    ).practiceMinutes;
    expect([mixed.proposed, mixed.storable]).toEqual(['any', true]);
    // a length that is storable carries no `withheld`
    expect(divisionSettingsToApply(lengthOf(15), ['div:boys'])[0]).not.toHaveProperty('withheld');
    expect(divisionSettingsToApply(lengthOf(240), ['div:boys'])[0].practiceMinutes).toBe(240);
  });

  it('applies the same rule to practices a week: 0 to 7', () => {
    const seven = boys(boxed(fileFor({ T1: 7, T2: 7 }))).practicesPerWeek;
    expect([seven.proposed, seven.storable]).toEqual([7, true]);
    const eight = boxed(fileFor({ T1: 8, T2: 8 }));
    expect(boys(eight).practicesPerWeek).toMatchObject({ proposed: 8, storable: false });
    const patch = divisionSettingsToApply(eight, ['div:boys']);
    expect(patch).toEqual([
      {
        divisionId: 'div:boys',
        isNew: false,
        practiceMinutes: 60,
        withheld: [
          { setting: 'practicesPerWeek', proposed: 8, why: 'out-of-range', min: 0, max: 7 },
        ],
      },
    ]);
    // a tie proposes nothing, and a proposal of nothing is not "unstorable"
    const tie = boys(boxed(fileFor({ T1: 1, T2: 2 }))).practicesPerWeek;
    expect([tie.proposed, tie.storable]).toEqual([null, true]);
  });
});

describe('practice import settings: the fixture', () => {
  const fixture = loadPracticeFixture();
  const lg = fixture.league;
  const file = parsePracticeRows({
    headers: fixture.schedule.headers,
    rows: fixture.schedule.rows,
    season: fixture.season,
  });
  const aliases = readPracticeAliases({ ...fixture.aliases, league: lg }).aliases;

  it('proposes two a week and the division’s own length for all 20 divisions, 29 short teams notwithstanding', () => {
    const decisions = acceptAllProposals((d) =>
      proposePracticeMapping({ rows: file.rows, league: lg, aliases, decisions: d })
    );
    const resolved = resolvePracticeRows({ rows: file.rows, league: lg, aliases, decisions });
    const settings = proposeDivisionSettings({ rows: resolved.rows, league: lg });
    expect(settings).toHaveLength(20);
    for (const d of settings) {
      expect([d.label, d.practicesPerWeek.stored, d.practicesPerWeek.proposed]).toEqual([
        d.label,
        2,
        2,
      ]);
      expect([d.label, d.practiceMinutes.proposed]).toEqual([d.label, d.practiceMinutes.stored]);
      expect([d.practicesPerWeek.differs, d.practiceMinutes.differs]).toEqual([false, false]);
    }
    // the settings carry the 29 short teams: 132 teams in all, and the rows are the placements
    expect(settings.reduce((n, d) => n + d.teams, 0)).toBe(132);
    expect(settings.reduce((n, d) => n + d.rows, 0)).toBe(236);
    // nothing to apply for a league whose settings already say what the file does
    expect(
      divisionSettingsToApply(
        settings,
        settings.map((d) => d.divisionId)
      )
    ).toEqual([]);
  });
});
