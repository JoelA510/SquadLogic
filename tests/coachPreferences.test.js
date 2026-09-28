/**
 * Coach practice preferences (8.6 PR 3b, PR 1; plan §4 and the §6 witness
 * "Strictest wins").
 *
 * **Enumerated, not sampled.** For each dimension: every coach count from 0 to
 * 3, every combination of the three levels across those coaches, and every
 * combination of values -- the candidate's own (match), two distinct others
 * (mismatch), or none -- in both reference modes (the team's current series,
 * or the preference value). Each case is judged against an oracle written from
 * the plan's words that shares no code with the module, and each enumeration
 * asserts its own size, so a loop that shrank cannot pass.
 *
 * Plants that must turn this file red (shown in the PR body): strictest-wins
 * replaced by the first coach's setting; `must_keep` counted as a breach
 * instead of filtering.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  COACH_PREFERENCE_DIMENSION,
  COACH_PREFERENCE_LEVEL,
  CoachPreferenceInputSchema,
  CoachPreferenceSchema,
  PRACTICE_REASON,
  PracticeWeekdaySchema,
  judgeCoachPreferenceCandidate,
  resolveCoachPreferences,
  strictestCoachPreferenceLevel,
} from '@squadlogic/core/practice/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIMENSIONS = Object.values(COACH_PREFERENCE_DIMENSION);
const LEVELS = Object.values(COACH_PREFERENCE_LEVEL);
const COACHES = ['coach-1', 'coach-2', 'coach-3'];

/** Synthetic location ids: lowercase canonical uuids naming no real place. */
const location = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The candidate every case judges, and per dimension two values that differ from it. */
const CANDIDATE = Object.freeze({ weekday: 'TUE', startMinutes: 1020, locationId: location(1) });
const VALUES = Object.freeze({
  weekday: { match: 'TUE', otherA: 'WED', otherB: 'THU' },
  start_time: { match: 1020, otherA: 1080, otherB: 960 },
  venue: { match: location(1), otherA: location(2), otherB: location(3) },
});
/** The placement key each dimension is read from: the module's public contract. */
const KEY = Object.freeze({ weekday: 'weekday', start_time: 'startMinutes', venue: 'locationId' });

/** Every length-n tuple over `options`. */
function tuples(options, n) {
  let out = [[]];
  for (let i = 0; i < n; i += 1) {
    out = out.flatMap((tuple) => options.map((option) => [...tuple, option]));
  }
  return out;
}

/**
 * The oracle, from the plan's words: a preference with nothing to keep does
 * nothing; the strictest level held wins; every coach holding it must be kept.
 */
function oracle(entries, candidateValue) {
  const live = entries.filter((entry) => entry.level !== 'dont_care' && entry.reference !== null);
  let top = 'dont_care';
  if (live.some((entry) => entry.level === 'prefer_keep')) top = 'prefer_keep';
  if (live.some((entry) => entry.level === 'must_keep')) top = 'must_keep';
  const held = live.filter((entry) => entry.level === top);
  const kept = held.every((entry) => entry.reference === candidateValue);
  return {
    level: top,
    mustKeepViolated: top === 'must_keep' && !kept,
    preferKeepBreaches: top === 'prefer_keep' && !kept ? 1 : 0,
    unsatisfiable: top === 'must_keep' && new Set(held.map((entry) => entry.reference)).size > 1,
    // Derived from the inputs: the strictest level held with more than one value.
    conflict:
      new Set(held.map((entry) => entry.reference)).size > 1
        ? {
            dimension: undefined,
            level: top,
            coachIds: held.map((entry) => entry.coachId).sort(),
            references: [...new Set(held.map((entry) => entry.reference))].map(String).sort(),
          }
        : null,
    unsatisfiableAgreesWithFinding: true,
    noReference: entries.filter((entry) => entry.level !== 'dont_care' && entry.reference === null)
      .length,
    othersInert: true,
  };
}

/** What the module said about one case, in the oracle's shape. */
function observe(resolution, verdict, dimension) {
  const entry = resolution.dimensions.find((candidate) => candidate.dimension === dimension);
  return {
    level: entry.level,
    mustKeepViolated: verdict.mustKeepViolated,
    preferKeepBreaches: verdict.preferKeepBreaches,
    unsatisfiable: entry.unsatisfiable,
    noReference: resolution.findings.filter(
      (finding) => finding.code === PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE
    ).length,
    othersInert: resolution.dimensions
      .filter((other) => other.dimension !== dimension)
      .every((other) => other.level === 'dont_care' && other.references.length === 0),
    conflict: conflictOf(resolution, dimension),
    // For must_keep the flag and the finding are one fact, stated twice.
    unsatisfiableAgreesWithFinding:
      entry.level !== 'must_keep' ||
      entry.unsatisfiable === (conflictOf(resolution, dimension) !== null),
  };
}

/** The one conflict finding, normalised; every conflict finding must name this dimension. */
function conflictOf(resolution, dimension) {
  const found = resolution.findings.filter(
    (finding) => finding.code === PRACTICE_REASON.COACH_PREFERENCE_CONFLICT
  );
  if (found.length === 0) return null;
  if (found.length > 1) return { tooMany: found.length };
  const { details } = found[0];
  return {
    dimension: details.dimension === dimension ? undefined : details.dimension,
    level: details.level,
    coachIds: [...details.coachIds].sort(),
    references: details.references.map(String).sort(),
  };
}

function tally(seen, verdict, expected) {
  seen.cases += 1;
  if (verdict.mustKeepViolated) seen.violated += 1;
  if (verdict.preferKeepBreaches > 0) seen.breached += 1;
  if (!verdict.mustKeepViolated && verdict.preferKeepBreaches === 0) seen.clean += 1;
  if (expected.unsatisfiable) seen.unsatisfiable += 1;
  if (expected.noReference > 0) seen.noReference += 1;
  if (expected.conflict) seen.conflict += 1;
}

describe('coach preferences :: strictest wins, enumerated', () => {
  it('value mode: every dimension x 0-3 coaches x every level and value combination', () => {
    const choicesPerCoach = ['match', 'otherA', 'otherB', null];
    const seen = {
      cases: 0,
      violated: 0,
      breached: 0,
      clean: 0,
      unsatisfiable: 0,
      noReference: 0,
      conflict: 0,
    };
    for (const dimension of DIMENSIONS) {
      for (let n = 0; n <= 3; n += 1) {
        for (const levels of tuples(LEVELS, n)) {
          for (const choices of tuples(choicesPerCoach, n)) {
            const preferences = levels.map((level, i) => ({
              coachId: COACHES[i],
              dimension,
              level,
              value: choices[i] === null ? null : VALUES[dimension][choices[i]],
            }));
            const resolution = resolveCoachPreferences({
              coachIds: COACHES.slice(0, n),
              preferences,
            });
            const verdict = judgeCoachPreferenceCandidate(resolution, CANDIDATE);
            const expected = oracle(
              preferences.map((p) => ({ coachId: p.coachId, level: p.level, reference: p.value })),
              CANDIDATE[KEY[dimension]]
            );
            // The case rides in the comparison, so a red names what broke.
            expect({
              dimension,
              levels,
              choices,
              ...observe(resolution, verdict, dimension),
            }).toEqual({ dimension, levels, choices, ...expected });
            tally(seen, verdict, expected);
          }
        }
      }
    }
    // 3 dimensions x the sum over n of (3 levels x 4 values)^n.
    expect(seen.cases).toBe(3 * (1 + 12 + 144 + 1728));
    // Every verdict class was exercised, so the oracle cannot agree vacuously.
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(0);
  });

  it('series mode: a value is its own reference, and only a null value keeps the series (operator ruling 2026-09-28)', () => {
    const choicesPerCoach = ['match', 'otherB', null];
    const seen = {
      cases: 0,
      violated: 0,
      breached: 0,
      clean: 0,
      unsatisfiable: 0,
      noReference: 0,
      conflict: 0,
    };
    for (const dimension of DIMENSIONS) {
      for (const seriesKept of [true, false]) {
        const seriesValue = seriesKept ? VALUES[dimension].match : VALUES[dimension].otherA;
        const series = { ...CANDIDATE, [KEY[dimension]]: seriesValue };
        for (let n = 0; n <= 3; n += 1) {
          for (const levels of tuples(LEVELS, n)) {
            for (const choices of tuples(choicesPerCoach, n)) {
              const preferences = levels.map((level, i) => ({
                coachId: COACHES[i],
                dimension,
                level,
                value: choices[i] === null ? null : VALUES[dimension][choices[i]],
              }));
              const resolution = resolveCoachPreferences({
                coachIds: COACHES.slice(0, n),
                preferences,
                series,
              });
              const verdict = judgeCoachPreferenceCandidate(resolution, CANDIDATE);
              const expected = oracle(
                preferences.map((p) => ({
                  coachId: p.coachId,
                  level: p.level,
                  reference: p.value === null ? seriesValue : p.value,
                })),
                CANDIDATE[KEY[dimension]]
              );
              expect({
                dimension,
                seriesKept,
                levels,
                choices,
                ...observe(resolution, verdict, dimension),
              }).toEqual({ dimension, seriesKept, levels, choices, ...expected });
              tally(seen, verdict, expected);
            }
          }
        }
      }
    }
    expect(seen.cases).toBe(3 * 2 * (1 + 9 + 81 + 729));
    // A series means a null value always has a reference; values that differ
    // from each other, or from the series, conflict as in value mode.
    expect(seen.noReference).toBe(0);
    for (const key of ['violated', 'breached', 'clean', 'unsatisfiable', 'conflict']) {
      expect(seen[key]).toBeGreaterThan(0);
    }
  });

  it('strictestCoachPreferenceLevel: every tuple of up to three levels', () => {
    let cases = 0;
    for (let n = 0; n <= 3; n += 1) {
      for (const levels of tuples(LEVELS, n)) {
        const expected = oracle(
          levels.map((level) => ({ level, reference: 'x' })),
          'x'
        ).level;
        expect({ levels, strictest: strictestCoachPreferenceLevel(levels) }).toEqual({
          levels,
          strictest: expected,
        });
        cases += 1;
      }
    }
    expect(cases).toBe(1 + 3 + 9 + 27);
    expect(() => strictestCoachPreferenceLevel(['constructor'])).toThrow(RangeError);
  });

  it('counts one breach per prefer_keep dimension, across all three at once', () => {
    let cases = 0;
    const settings = LEVELS.flatMap((level) => [true, false].map((kept) => ({ level, kept })));
    for (const combo of tuples(settings, 3)) {
      const preferences = DIMENSIONS.map((dimension, i) => ({
        coachId: 'coach-1',
        dimension,
        level: combo[i].level,
        value: combo[i].kept ? VALUES[dimension].match : VALUES[dimension].otherA,
      }));
      const verdict = judgeCoachPreferenceCandidate(
        resolveCoachPreferences({ coachIds: ['coach-1'], preferences }),
        CANDIDATE
      );
      expect(verdict.mustKeepViolated).toBe(
        combo.some((setting) => setting.level === 'must_keep' && !setting.kept)
      );
      expect(verdict.preferKeepBreaches).toBe(
        combo.filter((setting) => setting.level === 'prefer_keep' && !setting.kept).length
      );
      cases += 1;
    }
    expect(cases).toBe(6 ** 3);
  });
});

describe('coach preferences :: no preferences, no effect', () => {
  const CANDIDATES = PracticeWeekdaySchema.options.flatMap((weekday) =>
    [0, 540, 1439].flatMap((startMinutes) =>
      [location(1), location(2)].map((locationId) => ({ weekday, startMinutes, locationId }))
    )
  );

  it.each([
    ['an empty input', { coachIds: [], preferences: [] }],
    ['coaches holding nothing', { coachIds: COACHES, preferences: [] }],
    [
      'only dont_care',
      {
        coachIds: COACHES,
        preferences: DIMENSIONS.map((dimension) => ({
          coachId: 'coach-1',
          dimension,
          level: 'dont_care',
        })),
      },
    ],
    [
      'a must_keep held by a coach not on the team',
      {
        coachIds: ['coach-1'],
        preferences: [
          { coachId: 'coach-9', dimension: 'weekday', level: 'must_keep', value: 'WED' },
        ],
      },
    ],
  ])('%s: zero breaches, nothing filtered, no finding', (_label, input) => {
    const resolution = resolveCoachPreferences(input);
    expect(resolution.findings).toEqual([]);
    expect(
      resolution.dimensions.map((entry) => [entry.dimension, entry.level, entry.references])
    ).toEqual(DIMENSIONS.map((dimension) => [dimension, 'dont_care', []]));
    const verdicts = CANDIDATES.map((candidate) =>
      judgeCoachPreferenceCandidate(resolution, candidate)
    );
    expect(verdicts.filter((v) => v.mustKeepViolated || v.preferKeepBreaches !== 0)).toEqual([]);
    expect(CANDIDATES.filter((_candidate, i) => !verdicts[i].mustKeepViolated)).toEqual(CANDIDATES);
    // The filter above saw every candidate: 7 weekdays x 3 starts x 2 venues.
    expect(CANDIDATES).toHaveLength(42);
  });

  it('the control: one must_keep does filter the same candidates', () => {
    const resolution = resolveCoachPreferences({
      coachIds: ['coach-1'],
      preferences: [{ coachId: 'coach-1', dimension: 'weekday', level: 'must_keep', value: 'TUE' }],
    });
    const kept = CANDIDATES.filter(
      (candidate) => !judgeCoachPreferenceCandidate(resolution, candidate).mustKeepViolated
    );
    expect(kept).toHaveLength(6);
    expect(kept.every((candidate) => candidate.weekday === 'TUE')).toBe(true);
  });
});

describe('coach preferences :: no free text, and the store agrees', () => {
  const ok = { coachId: 'coach-1', dimension: 'weekday', level: 'prefer_keep', value: 'TUE' };

  it('accepts a well-formed preference and the boundary of every dimension', () => {
    expect(CoachPreferenceSchema.parse(ok)).toEqual(ok);
    for (const value of [0, 1439]) {
      expect(
        CoachPreferenceSchema.safeParse({ ...ok, dimension: 'start_time', value }).success
      ).toBe(true);
    }
    expect(
      CoachPreferenceSchema.safeParse({ ...ok, dimension: 'venue', value: location(7) }).success
    ).toBe(true);
    expect(
      CoachPreferenceSchema.parse({ coachId: 'coach-1', dimension: 'venue', level: 'must_keep' })
        .value
    ).toBeNull();
  });

  it.each([
    ['a free-text key', { ...ok, note: 'call after 6' }],
    ['a status key (a raw row, not an approved preference)', { ...ok, status: 'requested' }],
    ['a free-text dimension', { ...ok, dimension: 'note' }],
    ['a free-text weekday', { ...ok, value: 'Tuesdays after school' }],
    ['minutes past the end of the day', { ...ok, dimension: 'start_time', value: 1440 }],
    ['negative minutes', { ...ok, dimension: 'start_time', value: -1 }],
    ['fractional minutes', { ...ok, dimension: 'start_time', value: 540.5 }],
    ['an unknown level', { ...ok, level: 'maybe' }],
    ['a venue that is not a uuid', { ...ok, dimension: 'venue', value: 'Preference Park' }],
    [
      'an uppercase venue uuid',
      { ...ok, dimension: 'venue', value: 'aaaaaaaa-0000-4000-8000-00000000000a'.toUpperCase() },
    ],
  ])('refuses %s', (_label, preference) => {
    expect(CoachPreferenceSchema.safeParse(preference).success).toBe(false);
  });

  it('refuses two preferences for one coach on one dimension', () => {
    const input = { coachIds: ['coach-1'], preferences: [ok, { ...ok, level: 'must_keep' }] };
    expect(CoachPreferenceInputSchema.safeParse(input).success).toBe(false);
    expect(() => resolveCoachPreferences(input)).toThrow();
  });

  it('holds the same vocabulary and ranges as the migration CHECKs', () => {
    const sql = readFileSync(
      path.join(REPO, 'supabase/migrations/20260927000000_coach_practice_preferences.sql'),
      'utf8'
    );
    const listAfter = (pattern) => {
      const match = pattern.exec(sql);
      expect(match, String(pattern)).not.toBeNull();
      return match[1].split(',').map((item) => item.trim().replace(/'/g, ''));
    };
    expect(listAfter(/CHECK \(dimension IN \(([^)]*)\)\)/)).toEqual(DIMENSIONS);
    expect(listAfter(/CHECK \(level IN \(([^)]*)\)\)/)).toEqual(LEVELS);
    expect(listAfter(/value #>> '\{\}' IN \(([^)]*)\)/).sort()).toEqual(
      [...PracticeWeekdaySchema.options].sort()
    );
    expect(sql).toContain("THEN (value #>> '{}')::integer <= 1439");
    expect(sql).toContain('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
    expect(sql).not.toMatch(/\b(note|reason|comment)\s+text\b/);
  });
});
