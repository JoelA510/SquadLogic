/**
 * PR 1 task A3 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md): the pure helper for the
 * Published switch, `@squadlogic/core/gamePublished.js`, held to the migration it is the twin of.
 *
 * The database is the authority. Every list and limit the helper repeats (the reasons, the scope kinds, the guarded
 * columns, the 2,400 and 200 and 100) is read back out of `20261119010000_game_published.sql` and required equal, and
 * every code the schema can report must be a DETAIL the switch writes: a helper that drifted from the SQL would
 * refuse what the database accepts, or the reverse, and say nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  GAME_PUBLISH_MAX_IDS,
  GAME_PUBLISH_NOTE_MAX,
  GAME_PUBLISH_REASON_CODES,
  GAME_PUBLISH_REASONS,
  GAME_PUBLISH_SCOPE_KINDS,
  GAME_PUBLISH_SCOPE_VALUE_MAX,
  PUBLISHED_GUARDED_FIELDS,
  changedPublishedFields,
  changesPublishedPlacement,
  parseGamePublishedOmitted,
  publishedOmissions,
  setGamesPublishedRefusal,
  splitGameIds,
} from '@squadlogic/core/gamePublished.js';
import { GRID_OVERRIDE_REASONS } from '../frontend/src/utils/gridOverridePrompt.js';

const MIGRATION = readFileSync(
  path.join(process.cwd(), 'supabase/migrations/20261119010000_game_published.sql'),
  'utf8'
);
const sqlList = (name) => {
  const match = new RegExp(`${name} constant text\\[\\] := ARRAY\\[([^\\]]+)\\]`).exec(MIGRATION);
  expect(match, `${name} is in the migration`).not.toBeNull();
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe("the lists and limits are the migration's", () => {
  it('reasons: the same five codes, in the same order', () => {
    expect(GAME_PUBLISH_REASON_CODES).toEqual(sqlList('c_reasons'));
    expect(new Set(GAME_PUBLISH_REASON_CODES).size).toBe(GAME_PUBLISH_REASON_CODES.length);
    expect(GAME_PUBLISH_REASONS.every((reason) => reason.label.trim() !== '')).toBe(true);
  });

  it('the four reasons it shares with the grid override prompt are equal to it, label and code', () => {
    const shared = GAME_PUBLISH_REASONS.filter((reason) => reason.code !== 'published-in-error');
    expect(shared).toEqual(GRID_OVERRIDE_REASONS.map((reason) => ({ ...reason })));
    expect(GRID_OVERRIDE_REASONS).toHaveLength(4);
  });

  it('scope kinds, the id cap, the note and scope value lengths', () => {
    expect(GAME_PUBLISH_SCOPE_KINDS).toEqual(sqlList('c_kinds'));
    expect(MIGRATION).toContain(`c_max_ids constant integer := ${GAME_PUBLISH_MAX_IDS};`);
    expect(GAME_PUBLISH_MAX_IDS).toBe(2400);
    expect(MIGRATION).toContain(`char_length(v_note) > ${GAME_PUBLISH_NOTE_MAX}`);
    expect(MIGRATION).toContain(
      `char_length(COALESCE(p_scope ->> 'value', '')) > ${GAME_PUBLISH_SCOPE_VALUE_MAX}`
    );
  });

  it("the guarded columns are the trigger's, in its order", () => {
    const guard = /IF \(NEW\.game_slot_id([^)]*)\)\s+IS NOT DISTINCT FROM/.exec(MIGRATION);
    expect(guard).not.toBeNull();
    const columns = [
      'game_slot_id',
      ...[...guard[1].matchAll(/NEW\.("?\w+"?)/g)].map((m) => m[1].replace(/"/g, '')),
    ];
    expect(PUBLISHED_GUARDED_FIELDS).toEqual(columns);
    // The old-row side names the same columns.
    const oldSide = /\(OLD\.game_slot_id([^)]*)\) THEN/.exec(MIGRATION);
    expect([
      'game_slot_id',
      ...[...oldSide[1].matchAll(/OLD\.("?\w+"?)/g)].map((m) => m[1].replace(/"/g, '')),
    ]).toEqual(columns);
  });

  it('every code the schema reports is a DETAIL the switch writes', () => {
    const reachable = new Set();
    const inputs = [
      { organizationId: 'o', assignmentIds: [], published: true },
      { organizationId: 'o', assignmentIds: [null], published: true },
      {
        organizationId: 'o',
        assignmentIds: Array.from({ length: 2401 }, (_, i) => `id${i}`),
        published: true,
      },
      { organizationId: 'o', assignmentIds: ['a'], published: null },
      { organizationId: 'o', assignmentIds: ['a'], published: true, reasonCode: 'other' },
      { organizationId: 'o', assignmentIds: ['a'], published: false },
      { organizationId: 'o', assignmentIds: ['a'], published: false, reasonCode: 'because' },
      {
        organizationId: 'o',
        assignmentIds: ['a'],
        published: false,
        reasonCode: 'other',
        note: 'n'.repeat(201),
      },
      { organizationId: 'o', assignmentIds: ['a'], published: true, scope: { kind: 'nowhere' } },
    ];
    for (const input of inputs) reachable.add(setGamesPublishedRefusal(input));
    expect([...reachable].sort()).toEqual(
      [
        'ids_invalid',
        'ids_required',
        'note_too_long',
        'published_required',
        'reason_only_when_off',
        'reason_required',
        'reason_unknown',
        'scope_invalid',
        'too_many_ids',
      ].sort()
    );
    for (const code of reachable) expect(MIGRATION, code).toContain(`DETAIL = '${code}'`);
  });
});

describe('changedPublishedFields / changesPublishedPlacement', () => {
  const base = {
    game_slot_id: 's1',
    slot_id: 's1',
    field_id: 'f1',
    home_team_id: 'h',
    away_team_id: 'a',
    week_index: 1,
    start: '2026-04-04T08:00:00Z',
    end: '2026-04-04T09:00:00Z',
    run_id: 'r1',
    assignment_source: 'auto',
    division: 'U10',
  };
  const changes = {
    game_slot_id: 's2',
    slot_id: 's2',
    field_id: 'f2',
    home_team_id: 'x',
    away_team_id: 'x',
    week_index: 2,
    start: '2026-04-04T08:30:00Z',
    end: '2026-04-04T09:30:00Z',
  };

  it('reports each guarded field alone, and nothing for the columns that are not a placement', () => {
    for (const field of PUBLISHED_GUARDED_FIELDS) {
      expect(changedPublishedFields(base, { ...base, [field]: changes[field] })).toEqual([field]);
      expect(changesPublishedPlacement(base, { ...base, [field]: changes[field] })).toBe(true);
    }
    for (const change of [
      { run_id: 'r2' },
      { assignment_source: 'manual' },
      { division: 'U10 (renamed)' },
      { updated_at: 'now' },
      { published: false },
    ]) {
      expect(changedPublishedFields(base, { ...base, ...change })).toEqual([]);
    }
  });

  it('an unchanged value is not a change, in either spelling or any offset', () => {
    expect(changedPublishedFields(base, { ...base })).toEqual([]);
    expect(
      changedPublishedFields(base, {
        gameSlotId: 's1',
        slotId: 's1',
        fieldId: 'F1',
        homeTeamId: 'H',
        awayTeamId: 'a',
        weekIndex: 1,
        kickoff: '2026-04-04T08:00:00+00:00',
        end: '2026-04-04T10:00:00+01:00',
      })
    ).toEqual([]);
  });

  it('a time with no zone designator is UTC, as the database reads it, whatever the runtime zone', () => {
    // The database pins TimeZone to UTC; Date.parse alone would read the zone-less string in local time, so the
    // answer would change with the machine (run once under TZ=Pacific/Auckland and TZ=America/Los_Angeles).
    expect(changedPublishedFields(base, { ...base, start: '2026-04-04T08:00:00' })).toEqual([]);
    expect(changedPublishedFields(base, { ...base, start: '2026-04-04 08:00:00' })).toEqual([]);
    expect(changedPublishedFields(base, { ...base, start: '2026-04-04T08:00:00+00' })).toEqual([]);
    expect(changedPublishedFields(base, { ...base, start: '2026-04-04T09:00:00' })).toEqual([
      'start',
    ]);
    expect(changedPublishedFields(base, { ...base, end: '2026-04-04T09:00:00-07:00' })).toEqual([
      'end',
    ]);
  });

  it('losing a value is a change', () => {
    expect(changedPublishedFields(base, { ...base, field_id: null })).toEqual(['field_id']);
    expect(changedPublishedFields({ ...base, field_id: null }, base)).toEqual(['field_id']);
  });
});

describe('splitGameIds', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `id-${i}`);

  it('keeps a list at the cap in one call and splits above it', () => {
    expect(splitGameIds([])).toEqual([]);
    expect(splitGameIds(ids(1))).toEqual([['id-0']]);
    expect(splitGameIds(ids(2400)).map((call) => call.length)).toEqual([2400]);
    expect(splitGameIds(ids(2401)).map((call) => call.length)).toEqual([2400, 1]);
    expect(splitGameIds(ids(5000)).map((call) => call.length)).toEqual([2400, 2400, 200]);
    expect(splitGameIds(ids(5), 2)).toEqual([['id-0', 'id-1'], ['id-2', 'id-3'], ['id-4']]);
  });

  it('drops a repeated id (any case), first sight wins, and keeps the order', () => {
    expect(splitGameIds(['b', 'A', 'a', 'b', 'c'])).toEqual([['b', 'A', 'c']]);
  });

  it('refuses what is not an id, and a call size the database would refuse', () => {
    expect(() => splitGameIds(['a', ''])).toThrow(TypeError);
    expect(() => splitGameIds(/** @type {any} */ (['a', 7]))).toThrow(TypeError);
    expect(() => splitGameIds(['a'], 0)).toThrow(RangeError);
    expect(() => splitGameIds(['a'], 2401)).toThrow(RangeError);
  });
});

describe('publishedOmissions', () => {
  const game = (id, home, away, slot, week, published = false) => ({
    id,
    home_team_id: home,
    away_team_id: away,
    game_slot_id: slot,
    week_index: week,
    published,
  });
  const saved = [
    game('g3', 'h3', 'a3', 's3', 1, true),
    game('g1', 'h1', 'a1', 's1', 1, true),
    game('g2', 'h2', 'a2', 's2', 1, false),
  ];

  it('lists the Published games the payload does not carry, in id order', () => {
    expect(publishedOmissions(saved, []).map((row) => row.id)).toEqual(['g1', 'g3']);
    expect(
      publishedOmissions(saved, [
        { home_team_id: 'h1', away_team_id: 'a1', game_slot_id: 's1', week_index: 1 },
      ]).map((row) => row.id)
    ).toEqual(['g3']);
  });

  it('a game named by its id is carried wherever it is sent (20261120010000); one named only elsewhere is not', () => {
    // g1 is sent by id to another slot and week: present (the guard then judges the move, as the database does).
    const byId = [
      { id: 'g1', home_team_id: 'h1', away_team_id: 'a1', game_slot_id: 'sX', week_index: 9 },
    ];
    expect(publishedOmissions(saved, byId).map((row) => row.id)).toEqual(['g3']);
    // The same place without the id is another tuple: g1 is still omitted.
    const byPlaceOnly = [
      { home_team_id: 'h1', away_team_id: 'a1', game_slot_id: 'sX', week_index: 9 },
    ];
    expect(publishedOmissions(saved, byPlaceOnly).map((row) => row.id)).toEqual(['g1', 'g3']);
    // An id compares without regard to case, as a uuid does; an empty or non-string id carries nothing.
    expect(
      publishedOmissions(saved, [{ id: 'G1' }, { id: '' }, { id: 7 }]).map((row) => row.id)
    ).toEqual(['g3']);
  });

  it('an unpublished game left out is not an omission', () => {
    const carried = [saved[0], saved[1]].map((row) => ({ ...row }));
    expect(publishedOmissions(saved, carried)).toEqual([]);
  });

  it('reads the payload in either spelling, and a slot under its other name', () => {
    expect(
      publishedOmissions(saved, [
        { homeTeamId: 'h1', awayTeamId: 'a1', gameSlotId: 's1', weekIndex: 1 },
        { home_team_id: 'H3', away_team_id: 'A3', slot_id: 's3', week_index: 1 },
      ])
    ).toEqual([]);
  });

  it('a game moved to another slot or week is another key, so the original is omitted', () => {
    const moved = [
      { home_team_id: 'h1', away_team_id: 'a1', game_slot_id: 's9', week_index: 1 },
      { home_team_id: 'h3', away_team_id: 'a3', game_slot_id: 's3', week_index: 2 },
    ];
    expect(publishedOmissions(saved, moved).map((row) => row.id)).toEqual(['g1', 'g3']);
  });

  it('a Published game whose key is incomplete is not an omission: no save can carry it, as in the database', () => {
    // The database excludes such a game from the check (a NULL part matches nothing, so every season-less save
    // would be refused for it for good); the guard trigger still holds it in place.
    const broken = [{ ...game('g9', 'h9', 'a9', null, 1, true) }];
    expect(publishedOmissions(broken, [])).toEqual([]);
    expect(
      publishedOmissions(broken, [
        { home_team_id: 'h9', away_team_id: 'a9', game_slot_id: null, week_index: 1 },
      ])
    ).toEqual([]);
    // Beside a complete one, only the complete one is listed.
    expect(publishedOmissions([...broken, ...saved], []).map((row) => row.id)).toEqual([
      'g1',
      'g3',
    ]);
  });

  it('nothing Published, or nothing saved, is nothing omitted', () => {
    expect(publishedOmissions([game('g', 'h', 'a', 's', 1, false)], [])).toEqual([]);
    expect(publishedOmissions([], [])).toEqual([]);
    expect(publishedOmissions(undefined, undefined)).toEqual([]);
  });
});

describe('setGamesPublishedRefusal', () => {
  const ok = {
    organizationId: 'o',
    assignmentIds: ['a', 'b'],
    published: false,
    reasonCode: 'field-change',
    note: 'Field closed',
  };

  it('accepts a well-formed payload, every reason, a 200-character note and the cap', () => {
    expect(setGamesPublishedRefusal(ok)).toBeNull();
    for (const code of GAME_PUBLISH_REASON_CODES)
      expect(setGamesPublishedRefusal({ ...ok, reasonCode: code })).toBeNull();
    expect(setGamesPublishedRefusal({ ...ok, note: 'n'.repeat(200) })).toBeNull();
    expect(setGamesPublishedRefusal({ ...ok, note: '😀'.repeat(200) })).toBeNull();
    expect(
      setGamesPublishedRefusal({
        ...ok,
        assignmentIds: Array.from({ length: 2400 }, (_, i) => `g${i}`),
      })
    ).toBeNull();
    expect(
      setGamesPublishedRefusal({ organizationId: 'o', assignmentIds: ['a'], published: true })
    ).toBeNull();
    expect(
      setGamesPublishedRefusal({
        organizationId: 'o',
        assignmentIds: ['a'],
        published: true,
        reasonCode: ' ',
        note: '',
      })
    ).toBeNull();
    expect(setGamesPublishedRefusal({ ...ok, scope: { kind: 'venue', value: 'Park' } })).toBeNull();
    expect(setGamesPublishedRefusal({ ...ok, scope: { kind: 'all', value: null } })).toBeNull();
    // Trimmed of space, tab, CR and LF, as the database trims; not of other Unicode spaces.
    expect(setGamesPublishedRefusal({ ...ok, reasonCode: '\tother\n' })).toBeNull();
    expect(setGamesPublishedRefusal({ ...ok, note: '\n' + 'n'.repeat(200) + ' \r' })).toBeNull();
    expect(
      setGamesPublishedRefusal({
        organizationId: 'o',
        assignmentIds: ['a'],
        published: true,
        note: '\n',
      })
    ).toBeNull();
  });

  it("reports the database's code for each thing wrong, in its order", () => {
    expect(setGamesPublishedRefusal({ ...ok, assignmentIds: [] })).toBe('ids_required');
    expect(setGamesPublishedRefusal({ ...ok, assignmentIds: undefined })).toBe('ids_required');
    expect(setGamesPublishedRefusal({ ...ok, assignmentIds: ['a', null] })).toBe('ids_invalid');
    expect(
      setGamesPublishedRefusal({
        ...ok,
        assignmentIds: Array.from({ length: 2401 }, (_, i) => `g${i}`),
      })
    ).toBe('too_many_ids');
    expect(setGamesPublishedRefusal({ ...ok, published: undefined })).toBe('published_required');
    expect(setGamesPublishedRefusal({ ...ok, published: 'yes' })).toBe('published_required');
    expect(setGamesPublishedRefusal({ ...ok, reasonCode: undefined })).toBe('reason_required');
    expect(setGamesPublishedRefusal({ ...ok, reasonCode: '  ' })).toBe('reason_required');
    expect(setGamesPublishedRefusal({ ...ok, reasonCode: 'because' })).toBe('reason_unknown');
    expect(setGamesPublishedRefusal({ ...ok, reasonCode: 'other\u00a0' })).toBe('reason_unknown');
    expect(
      setGamesPublishedRefusal({
        organizationId: 'o',
        assignmentIds: ['a'],
        published: true,
        note: '\u00a0',
      })
    ).toBe('reason_only_when_off');
    expect(setGamesPublishedRefusal({ ...ok, note: 'n'.repeat(201) })).toBe('note_too_long');
    expect(setGamesPublishedRefusal({ ...ok, published: true })).toBe('reason_only_when_off');
    expect(setGamesPublishedRefusal({ ...ok, published: true, reasonCode: undefined })).toBe(
      'reason_only_when_off'
    );
    expect(setGamesPublishedRefusal({ ...ok, scope: { kind: 'nowhere' } })).toBe('scope_invalid');
    expect(setGamesPublishedRefusal({ ...ok, scope: { kind: 'all', extra: 1 } })).toBe(
      'scope_invalid'
    );
    expect(setGamesPublishedRefusal({ ...ok, scope: { kind: 'all', value: 7 } })).toBe(
      'scope_invalid'
    );
    expect(
      setGamesPublishedRefusal({ ...ok, scope: { kind: 'all', value: 'v'.repeat(101) } })
    ).toBe('scope_invalid');
    // ids come first: a payload wrong in two ways reports the first the database checks.
    expect(setGamesPublishedRefusal({ ...ok, assignmentIds: [], reasonCode: undefined })).toBe(
      'ids_required'
    );
  });

  it('counts a repeated id once, as the database does', () => {
    expect(setGamesPublishedRefusal({ ...ok, assignmentIds: ['a', 'A', 'a'] })).toBeNull();
    const many = Array.from({ length: 2400 }, (_, i) => `g${i}`);
    expect(setGamesPublishedRefusal({ ...ok, assignmentIds: [...many, ...many] })).toBeNull();
  });
});

describe('parseGamePublishedOmitted', () => {
  it('reads the detail the save writes, and nothing else', () => {
    expect(parseGamePublishedOmitted('game_published_omitted count=2 ids=a1,B2')).toEqual({
      count: 2,
      ids: ['a1', 'B2'],
    });
    expect(parseGamePublishedOmitted('game_published_omitted count=0 ids=')).toEqual({
      count: 0,
      ids: [],
    });
    for (const text of [
      'game_published',
      'game_published_omitted',
      'season_completed',
      '',
      null,
      undefined,
      'game_published_omitted count=x ids=',
    ]) {
      expect(parseGamePublishedOmitted(text)).toBeNull();
    }
  });
});
