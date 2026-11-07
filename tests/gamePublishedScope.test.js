/**
 * PR 3 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.4 and 3.6, tasks C1 and C2): the pure
 * half of the Games page's Published controls. What state a saved game is in, how many of each, and which games a bulk
 * scope names.
 *
 * The rule that matters most here is the subject set: a scope is enumerated from the SAVED set, never from a filtered
 * view of it (lesson 92: say what the number is a count of; and the Phase 2 lesson: never derive a check's subject set
 * from the data a break would corrupt). Every function takes the saved games and none takes a view; the page-level
 * test (tests/gamePublishedBulk.test.jsx) holds the other half, that the page hands them the saved set.
 */
import { describe, expect, it } from 'vitest';
import {
  PUBLISHED_FILTERS,
  PUBLISHED_STATE_WORDS,
  dateKeyInZone,
  dateLabel,
  describePublishedCounts,
  describeScope,
  filterByPublishedState,
  publishedCounts,
  publishedStateOf,
  resolveScope,
  scopeOptions,
} from '../frontend/src/utils/gamePublishedScope.js';
import { GAME_PUBLISH_MAX_IDS } from '../packages/core/src/gamePublished.js';

const TZ = 'America/Los_Angeles';
const game = (id, extra = {}) => ({
  id,
  division: 'U10 Boys',
  start: '2026-10-03T16:00:00Z',
  fieldId: 'f-north',
  published: false,
  persisted: true,
  ...extra,
});

/** A league that reaches every state, three divisions, two dates (one across the zone's midnight) and two venues. */
const SAVED = [
  game('p1', { published: true, publishedAt: '2026-10-01T00:00:00Z' }),
  game('p2', { published: true, publishedAt: '2026-10-01T00:00:00Z', division: 'U12 Girls' }),
  game('p3', {
    published: true,
    publishedAt: '2026-10-01T00:00:00Z',
    start: '2026-10-11T01:30:00Z',
    fieldId: 'f-south',
  }),
  game('c1', { publishedAt: '2026-10-01T00:00:00Z', division: 'U12 Girls', fieldId: 'f-south' }),
  game('n1', { start: '2026-10-11T01:30:00Z' }),
  game('n2', { division: 'U8 Coed', fieldId: 'f-south' }),
];
const VENUES = { 'f-north': 'North Park', 'f-south': 'South Park' };
const context = { timezone: TZ, venueOf: (g) => VENUES[g.fieldId] ?? null };

describe('the state of a saved game', () => {
  it('reaches all four states', () => {
    expect(publishedStateOf(game('a', { published: true }))).toBe('published');
    expect(publishedStateOf(game('a', { publishedAt: '2026-10-01T00:00:00Z' }))).toBe(
      'changes-allowed'
    );
    expect(publishedStateOf(game('a'))).toBe('not-published');
    expect(publishedStateOf(game('a', { persisted: false }))).toBe('unsaved');
  });

  it('Published wins over a kept published_at; changes allowed is off after having been on', () => {
    expect(
      publishedStateOf(game('a', { published: true, publishedAt: '2026-10-01T00:00:00Z' }))
    ).toBe('published');
    expect(publishedStateOf(game('a', { published: false, publishedAt: null }))).toBe(
      'not-published'
    );
  });

  it('reads the snake spelling of a row straight from the database', () => {
    expect(
      publishedStateOf({ id: 'a', published: false, published_at: '2026-10-01T00:00:00Z' })
    ).toBe('changes-allowed');
  });

  it('a row with no id, or none at all, is unsaved: there is nothing to publish', () => {
    expect(publishedStateOf({ published: true })).toBe('unsaved');
    expect(publishedStateOf(null)).toBe('unsaved');
    expect(publishedStateOf(undefined)).toBe('unsaved');
  });

  it('a database before the migration has no column: every game reads as not published', () => {
    expect(publishedStateOf({ id: 'a' })).toBe('not-published');
  });

  it('says each state in words, and the words are the ones the plan names', () => {
    expect(PUBLISHED_STATE_WORDS).toEqual({
      unsaved: 'Apply the schedule first',
      published: 'Published',
      'changes-allowed': 'Changes allowed',
      'not-published': 'Not published',
    });
  });
});

describe('the counts and the persistent line', () => {
  it('counts each state over the saved games', () => {
    expect(publishedCounts(SAVED)).toEqual({
      total: 6,
      published: 3,
      changesAllowed: 1,
      notPublished: 3,
    });
  });

  it('says what the numbers are a count of', () => {
    expect(describePublishedCounts(publishedCounts(SAVED))).toBe(
      '3 of 6 saved games Published, 1 with changes allowed'
    );
    expect(describePublishedCounts({ total: 1, published: 1, changesAllowed: 0 })).toBe(
      '1 of 1 saved game Published, 0 with changes allowed'
    );
    expect(describePublishedCounts(publishedCounts([]))).toBe(
      '0 of 0 saved games Published, 0 with changes allowed'
    );
  });
});

describe('the list filter', () => {
  it('keeps the games of one state, and "all" keeps every one', () => {
    const ids = (filter) => filterByPublishedState(SAVED, filter).map((g) => g.id);
    expect(ids('all')).toEqual(['p1', 'p2', 'p3', 'c1', 'n1', 'n2']);
    expect(ids('published')).toEqual(['p1', 'p2', 'p3']);
    expect(ids('changes-allowed')).toEqual(['c1']);
    expect(ids('not-published')).toEqual(['n1', 'n2']);
    expect(PUBLISHED_FILTERS.map((f) => f.id)).toEqual([
      'all',
      'published',
      'changes-allowed',
      'not-published',
    ]);
  });

  it('an unknown filter id shows everything rather than nothing', () => {
    expect(filterByPublishedState(SAVED, 'nonsense')).toHaveLength(6);
  });
});

describe('a date is a date on the season’s clock', () => {
  it('16:00Z is the same day in Los Angeles, 01:30Z the next day is the evening before', () => {
    expect(dateKeyInZone('2026-10-03T16:00:00Z', TZ)).toBe('2026-10-03');
    expect(dateKeyInZone('2026-10-11T01:30:00Z', TZ)).toBe('2026-10-10');
    expect(dateKeyInZone('2026-10-11T01:30:00Z', 'UTC')).toBe('2026-10-11');
  });

  it('is null for an instant that does not read, a missing zone or a zone that does not exist', () => {
    expect(dateKeyInZone('not a time', TZ)).toBeNull();
    expect(dateKeyInZone('2026-10-03T16:00:00Z', null)).toBeNull();
    expect(dateKeyInZone('2026-10-03T16:00:00Z', 'Mars/Olympus')).toBeNull();
    expect(dateKeyInZone(null, TZ)).toBeNull();
  });

  it('labels a date with fixed text, not the browser’s locale', () => {
    expect(dateLabel('2026-10-03')).toBe('Sat 2026-10-03');
    expect(dateLabel('garbage')).toBe('garbage');
  });
});

describe('the pickers are enumerated from the saved set', () => {
  it('lists every division, date and venue a saved game has, with how many games each holds', () => {
    expect(scopeOptions(SAVED, context)).toEqual({
      division: [
        { value: 'U10 Boys', count: 3 },
        { value: 'U12 Girls', count: 2 },
        { value: 'U8 Coed', count: 1 },
      ],
      // 16:00Z is 09:00 on the 3rd in Los Angeles; 01:30Z is 18:30 on the 10th.
      date: [
        { value: '2026-10-03', count: 4 },
        { value: '2026-10-10', count: 2 },
      ],
      venue: [
        { value: 'North Park', count: 3 },
        { value: 'South Park', count: 3 },
      ],
    });
  });

  it('a game with no division, no readable time or no venue is left out of that picker and stays in "all"', () => {
    const odd = [
      game('x1', { division: null }),
      game('x2', { start: null }),
      game('x3', { fieldId: 'f-gone' }),
    ];
    const options = scopeOptions(odd, context);
    expect(options.division.map((o) => o.count)).toEqual([2]);
    expect(options.date.map((o) => o.count)).toEqual([2]);
    expect(options.venue.map((o) => o.count)).toEqual([2]);
    expect(resolveScope(odd, { kind: 'all' }, 'publish', context).ids.sort()).toEqual([
      'x1',
      'x2',
      'x3',
    ]);
  });

  it('with no season clock, no date is offered (a date on the wrong clock is worse than none)', () => {
    expect(scopeOptions(SAVED, { venueOf: context.venueOf }).date).toEqual([]);
  });
});

describe('a scope names ids from the saved set', () => {
  const ids = (scope, want) => resolveScope(SAVED, scope, want, context).ids.sort();

  it('Publish names the games of the scope that are not Published, changes allowed included', () => {
    expect(ids({ kind: 'all' }, 'publish')).toEqual(['c1', 'n1', 'n2']);
    expect(ids({ kind: 'division', value: 'U12 Girls' }, 'publish')).toEqual(['c1']);
    expect(ids({ kind: 'date', value: '2026-10-10' }, 'publish')).toEqual(['n1']);
    expect(ids({ kind: 'venue', value: 'South Park' }, 'publish')).toEqual(['c1', 'n2']);
  });

  it('Allow changes names the games of the scope that are Published, and no others', () => {
    expect(ids({ kind: 'all' }, 'allow-changes')).toEqual(['p1', 'p2', 'p3']);
    expect(ids({ kind: 'division', value: 'U10 Boys' }, 'allow-changes')).toEqual(['p1', 'p3']);
    expect(ids({ kind: 'date', value: '2026-10-03' }, 'allow-changes')).toEqual(['p1', 'p2']);
    expect(ids({ kind: 'venue', value: 'South Park' }, 'allow-changes')).toEqual(['p3']);
  });

  it('reports how many games the scope holds and how many the call acts on', () => {
    const resolved = resolveScope(
      SAVED,
      { kind: 'division', value: 'U12 Girls' },
      'publish',
      context
    );
    expect(resolved.inScope).toBe(2);
    expect(resolved.eligible).toBe(1);
    expect(resolved.calls).toBe(1);
    expect(resolved.scope).toEqual({ kind: 'division', value: 'U12 Girls' });
  });

  it('a division, date or venue with no value names nothing (never "everything")', () => {
    for (const kind of ['division', 'date', 'venue']) {
      expect(resolveScope(SAVED, { kind }, 'publish', context).ids).toEqual([]);
      expect(resolveScope(SAVED, { kind, value: '' }, 'publish', context).ids).toEqual([]);
    }
  });

  it('a value no saved game has names nothing', () => {
    expect(ids({ kind: 'division', value: 'U99 Nobody' }, 'publish')).toEqual([]);
  });

  it('a game with no row yet is never named, whichever way', () => {
    const withStaged = [...SAVED, game('review-1', { persisted: false })];
    expect(resolveScope(withStaged, { kind: 'all' }, 'publish', context).ids).not.toContain(
      'review-1'
    );
    expect(resolveScope(withStaged, { kind: 'all' }, 'publish', context).inScope).toBe(6);
  });

  it('is computed from the games it is given: a smaller list names fewer (so the page must hand it the saved set)', () => {
    const onlyPublished = SAVED.filter((g) => g.published);
    expect(resolveScope(onlyPublished, { kind: 'all' }, 'publish', context).ids).toEqual([]);
    expect(resolveScope(SAVED, { kind: 'all' }, 'publish', context).ids).toHaveLength(3);
  });

  it('records the scope the audit row keeps: "all" with no value, a value cut to 100 characters', () => {
    expect(
      resolveScope(SAVED, { kind: 'all', value: 'ignored' }, 'publish', context).scope
    ).toEqual({
      kind: 'all',
    });
    const long = 'V'.repeat(150);
    const longVenue = [game('v1', { fieldId: 'f-long' })];
    const resolved = resolveScope(longVenue, { kind: 'venue', value: long }, 'publish', {
      ...context,
      venueOf: () => long,
    });
    expect(resolved.scope.value).toHaveLength(100);
    expect(resolved.ids).toEqual(['v1']);
  });

  it('a long list is split into calls of at most 2,400, and says how many', () => {
    const many = Array.from({ length: GAME_PUBLISH_MAX_IDS + 1 }, (_, i) => game(`g${i}`));
    const resolved = resolveScope(many, { kind: 'all' }, 'publish', context);
    expect(resolved.eligible).toBe(2401);
    expect(resolved.calls).toBe(2);
    const exact = resolveScope(
      many.slice(0, GAME_PUBLISH_MAX_IDS),
      { kind: 'all' },
      'publish',
      context
    );
    expect(exact.calls).toBe(1);
    expect(resolveScope([], { kind: 'all' }, 'publish', context).calls).toBe(0);
  });

  it('meta: the table above reaches every outcome (a case that reached nothing would compare empty lists)', () => {
    /** @type {Array<[string, 'publish' | 'allow-changes']>} */
    const table = [
      ['all', 'publish'],
      ['all', 'allow-changes'],
      ['division', 'publish'],
      ['date', 'allow-changes'],
      ['venue', 'publish'],
    ];
    const reached = table.map(([kind, want]) => {
      const value = {
        all: undefined,
        division: 'U12 Girls',
        date: '2026-10-03',
        venue: 'South Park',
      }[kind];
      return resolveScope(SAVED, { kind, value }, want, context).eligible;
    });
    expect(reached.every((count) => count > 0)).toBe(true);
  });
});

describe('a scope in words', () => {
  it('says what was chosen', () => {
    expect(describeScope({ kind: 'all' })).toBe('all saved games');
    expect(describeScope({ kind: 'division', value: 'U10 Boys' })).toBe('division U10 Boys');
    expect(describeScope({ kind: 'date', value: '2026-10-03' })).toBe('date 2026-10-03');
    expect(describeScope({ kind: 'venue', value: 'North Park' })).toBe('venue North Park');
    expect(describeScope({ kind: 'selection' })).toBe('selected games');
    expect(describeScope({ kind: 'selection', value: 'Exports panel' })).toBe(
      'selected games (Exports panel)'
    );
  });
});
