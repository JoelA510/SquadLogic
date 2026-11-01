/**
 * Practice preference rules (Phase D C1; originally 8.6 PR 3b, PR 1; plan
 * `docs/changes/2026-10-26-coach-preference-rules.md`, "Revised 2026-10-27").
 *
 * **Enumerated, not sampled.** Every single rule -- a level and, per dimension, no condition, a
 * set holding the candidate's value, a set that does not, both, or keep-current against a
 * team that holds the candidate's value, another value, or no practice -- is judged against all
 * eight candidates that match or miss each dimension; every pair of one-condition rules, from
 * one coach and from two, likewise. Each case is judged against an oracle written from the
 * plan's words that shares no code with the module, and each enumeration asserts its own size
 * from arithmetic, so a loop that shrank cannot pass. The named cases below it are the plan's
 * examples, one by one.
 *
 * Plants that must turn this file red (shown in the PR body): any-of replaced by all-of; a
 * breach counted per failed condition instead of per unmet rule.
 */
import { describe, expect, it } from 'vitest';

import {
  CoachPreferenceRuleSchema,
  PRACTICE_REASON,
  isInertResolution,
  judgeCoachPreferenceCandidate,
  resolveCoachPreferences,
  ruleInWindow,
} from '@squadlogic/core/practice/index.js';

const location = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DIMENSIONS = ['weekday', 'start_time', 'venue'];
const KEY = { weekday: 'weekday', start_time: 'startMinutes', venue: 'locationId' };
const FIELD = { weekday: 'weekdays', start_time: 'startMinutes', venue: 'venueIds' };
const KEEP = { weekday: 'keepWeekday', start_time: 'keepStart', venue: 'keepVenue' };
const VALUES = {
  weekday: ['TUE', 'THU', 'WED'],
  start_time: [1020, 1080, 960],
  venue: [location(1), location(2), location(3)],
};
const DAY = '2026-11-10';
const CANDIDATE_BASE = { weekday: 'TUE', startMinutes: 1020, locationId: location(1) };

/** The candidate with, per dimension, the value index 0 (the rule's) or 1 (another). */
const candidateFor = (mask) => ({
  weekday: VALUES.weekday[mask[0]],
  startMinutes: VALUES.start_time[mask[1]],
  locationId: VALUES.venue[mask[2]],
});
const MASKS = [0, 1].flatMap((a) => [0, 1].flatMap((b) => [0, 1].map((c) => [a, b, c])));

/** What the team's saved practice holds, per series kind. */
const SERIES = {
  hit: [{ ...CANDIDATE_BASE }],
  other: [{ weekday: 'WED', startMinutes: 960, locationId: location(3) }],
  none: [],
};

const rule = (over = {}) => ({
  id: 'r1',
  coachId: 'c1',
  teamId: 'team-1',
  level: 'must',
  ...over,
});
const input = (rules, over = {}) => ({
  teamId: 'team-1',
  coachIds: ['c1', 'c2'],
  rules,
  current: [],
  date: DAY,
  ...over,
});
const judge = (rules, candidate, over = {}) => {
  const resolution = resolveCoachPreferences(input(rules, over));
  return { resolution, verdict: judgeCoachPreferenceCandidate(resolution, candidate) };
};

/**
 * The oracle, from the plan's words. A rule applies when it is for the team, asked by one of the
 * team's coaches, and in window; it is met when every condition it can check holds; a
 * keep-current condition checks against what the team's practices hold, and checks nothing when
 * they hold nothing. A must that is not met violates; a prefer that is not met is one breach.
 */
function oracle(rules, { coachIds, current, date, candidate }) {
  const violated = [];
  const breached = [];
  let inert = 0;
  for (const r of rules) {
    if (r.teamId !== 'team-1' || !coachIds.includes(r.coachId)) continue;
    if (r.effectiveFrom && date < r.effectiveFrom) continue;
    if (r.effectiveTo && date > r.effectiveTo) continue;
    let met = true;
    let checked = 0;
    for (const dimension of DIMENSIONS) {
      const key = KEY[dimension];
      let allowed = null;
      if (r[FIELD[dimension]]) allowed = r[FIELD[dimension]];
      else if (r[KEEP[dimension]]) allowed = [...new Set(current.map((p) => p[key]))];
      if (allowed === null || allowed.length === 0) continue;
      checked += 1;
      if (!allowed.includes(candidate[key])) met = false;
    }
    if (checked === 0) inert += 1;
    if (!met) (r.level === 'must' ? violated : breached).push(r.id);
  }
  return { violated, breached, inert };
}

/** A rule shape: per dimension, a kind of condition. */
function ruleOf(id, coachId, level, kinds) {
  const out = { id, coachId, teamId: 'team-1', level };
  DIMENSIONS.forEach((dimension, i) => {
    const [a, b] = VALUES[dimension];
    const kind = kinds[i];
    if (kind === 'hit') out[FIELD[dimension]] = [a];
    else if (kind === 'miss') out[FIELD[dimension]] = [b];
    else if (kind === 'both') out[FIELD[dimension]] = [a, b];
    else if (kind === 'keep') out[KEEP[dimension]] = true;
  });
  return out;
}

describe('practice preference rules :: enumerated against an oracle', () => {
  it('every single rule x every candidate x what the team holds', () => {
    const kinds = ['none', 'hit', 'miss', 'both', 'keep'];
    const seen = { cases: 0, violated: 0, breached: 0, clean: 0, noReference: 0 };
    for (const level of ['must', 'prefer']) {
      for (let k0 = 0; k0 < 5; k0 += 1) {
        for (let k1 = 0; k1 < 5; k1 += 1) {
          for (let k2 = 0; k2 < 5; k2 += 1) {
            const shape = [kinds[k0], kinds[k1], kinds[k2]];
            if (shape.every((k) => k === 'none')) continue;
            const hasKeep = shape.includes('keep');
            for (const held of hasKeep ? ['hit', 'other', 'none'] : ['none']) {
              for (const mask of MASKS) {
                const r = ruleOf('r1', 'c1', level, shape);
                const candidate = candidateFor(mask);
                const current = SERIES[held];
                const { resolution, verdict } = judge([r], candidate, { current });
                const expected = oracle([r], {
                  coachIds: ['c1', 'c2'],
                  current,
                  date: DAY,
                  candidate,
                });
                // The case rides in the comparison, so a red names what broke.
                expect({
                  level,
                  shape,
                  held,
                  mask,
                  violated: verdict.violatedRules,
                  breached: verdict.breachedRules,
                }).toEqual({
                  level,
                  shape,
                  held,
                  mask,
                  violated: expected.violated,
                  breached: expected.breached,
                });
                expect(verdict.mustKeepViolated).toBe(expected.violated.length > 0);
                expect(verdict.preferKeepBreaches).toBe(expected.breached.length);
                expect(isInertResolution(resolution)).toBe(expected.inert > 0 || false);
                const unreadable = resolution.findings.filter(
                  (f) => f.code === PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE
                ).length;
                const wantUnreadable =
                  shape.filter((k) => k === 'keep').length * (held === 'none' ? 1 : 0);
                expect(unreadable).toBe(wantUnreadable);
                seen.cases += 1;
                if (verdict.mustKeepViolated) seen.violated += 1;
                if (verdict.preferKeepBreaches > 0) seen.breached += 1;
                if (!verdict.mustKeepViolated && verdict.preferKeepBreaches === 0) seen.clean += 1;
                if (unreadable > 0) seen.noReference += 1;
              }
            }
          }
        }
      }
    }
    // 2 levels x (5^3 - 1 shapes) x 8 masks, plus the 2 extra holds for each shape with a keep:
    // shapes with no keep are 4^3 - 1 = 63, with one: 124 - 63 = 61.
    expect(seen.cases).toBe(2 * 8 * (63 + 61 * 3));
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(0);
  });

  it('every pair of one-condition rules x levels x one coach or two x every candidate', () => {
    const shapes = [];
    for (let dimension = 0; dimension < 3; dimension += 1) {
      for (const kind of ['hit', 'miss', 'both']) {
        const kinds = ['none', 'none', 'none'];
        kinds[dimension] = kind;
        shapes.push(kinds);
      }
    }
    let cases = 0;
    let twoBreaches = 0;
    for (const a of shapes) {
      for (const b of shapes) {
        for (const levels of [
          ['must', 'must'],
          ['must', 'prefer'],
          ['prefer', 'must'],
          ['prefer', 'prefer'],
        ]) {
          for (const sameCoach of [true, false]) {
            for (const mask of MASKS) {
              const rules = [
                ruleOf('r1', 'c1', levels[0], a),
                ruleOf('r2', sameCoach ? 'c1' : 'c2', levels[1], b),
              ];
              const candidate = candidateFor(mask);
              const { verdict } = judge(rules, candidate);
              const expected = oracle(rules, {
                coachIds: ['c1', 'c2'],
                current: [],
                date: DAY,
                candidate,
              });
              expect({
                a,
                b,
                levels,
                sameCoach,
                mask,
                v: verdict.violatedRules,
                br: verdict.breachedRules,
              }).toEqual({
                a,
                b,
                levels,
                sameCoach,
                mask,
                v: expected.violated,
                br: expected.breached,
              });
              if (verdict.preferKeepBreaches === 2) twoBreaches += 1;
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(9 * 9 * 4 * 2 * 8);
    // Two rules, from one coach or two, both count: a breach is one per unmet rule.
    expect(twoBreaches).toBeGreaterThan(0);
  });
});

describe('practice preference rules :: the plan, case by case', () => {
  const TUE_5 = { weekday: 'TUE', startMinutes: 1020, locationId: location(1) };
  const THU_5 = { ...TUE_5, weekday: 'THU' };
  const WED_5 = { ...TUE_5, weekday: 'WED' };
  const TUE_6 = { ...TUE_5, startMinutes: 1080 };

  it('several values in one condition mean "any of": {Tue, Thu} is met by a Tuesday or a Thursday', () => {
    const rules = [rule({ weekdays: ['TUE', 'THU'] })];
    expect(judge(rules, TUE_5).verdict.mustKeepViolated).toBe(false);
    expect(judge(rules, THU_5).verdict.mustKeepViolated).toBe(false);
    expect(judge(rules, WED_5).verdict.mustKeepViolated).toBe(true);
  });

  it('the conditions of one rule must all hold: "Tuesday at 5:00" is one rule with two conditions', () => {
    const rules = [rule({ weekdays: ['TUE'], startMinutes: [1020] })];
    expect(judge(rules, TUE_5).verdict.mustKeepViolated).toBe(false);
    expect(judge(rules, TUE_6).verdict.mustKeepViolated).toBe(true);
    expect(judge(rules, WED_5).verdict.mustKeepViolated).toBe(true);
    const prefer = [rule({ level: 'prefer', weekdays: ['TUE'], startMinutes: [1020] })];
    const { verdict } = judge(prefer, { ...WED_5, startMinutes: 960 });
    // Both conditions fail, and it is ONE breach: one per unmet rule.
    expect(verdict.preferKeepBreaches).toBe(1);
    expect(verdict.breachedDimensions).toEqual(['weekday', 'start_time']);
  });

  it("every rule in force applies: nothing supersedes anything, and two coaches' rules both count", () => {
    const rules = [
      rule({ id: 'a', level: 'prefer', weekdays: ['TUE'] }),
      rule({ id: 'b', level: 'prefer', startMinutes: [1080] }),
      rule({ id: 'c', coachId: 'c2', level: 'prefer', weekdays: ['THU'] }),
    ];
    const { verdict } = judge(rules, TUE_5);
    expect(verdict.breachedRules).toEqual(['b', 'c']);
    expect(verdict.preferKeepBreaches).toBe(2);
    expect(judge(rules, { ...THU_5, startMinutes: 1080 }).verdict.breachedRules).toEqual(['a']);
  });

  it('a must filters (mustKeepViolated, naming the rule) and a prefer only counts', () => {
    const { verdict } = judge(
      [rule({ id: 'm', weekdays: ['TUE'] }), rule({ id: 'p', level: 'prefer', weekdays: ['THU'] })],
      WED_5
    );
    expect(verdict.mustKeepViolated).toBe(true);
    expect(verdict.violatedRules).toEqual(['m']);
    expect(verdict.breachedRules).toEqual(['p']);
  });

  it("a rule is for one team: another team's rule, and a coach who is not on the team, ask nothing", () => {
    const rules = [
      rule({ id: 'other-team', teamId: 'team-2', weekdays: ['MON'] }),
      rule({ id: 'off-roster', coachId: 'c9', weekdays: ['MON'] }),
    ];
    const { resolution, verdict } = judge(rules, TUE_5);
    expect(resolution.rules).toEqual([]);
    expect(verdict.mustKeepViolated).toBe(false);
    expect(isInertResolution(resolution)).toBe(true);
  });

  it('a rule applies on the days of its window, both ends included, and a window with no day to judge is refused', () => {
    const windowed = rule({
      weekdays: ['MON'],
      effectiveFrom: '2026-11-10',
      effectiveTo: '2026-11-20',
    });
    expect(judge([windowed], TUE_5, { date: '2026-11-09' }).resolution.rules).toHaveLength(0);
    expect(judge([windowed], TUE_5, { date: '2026-11-10' }).resolution.rules).toHaveLength(1);
    expect(judge([windowed], TUE_5, { date: '2026-11-20' }).resolution.rules).toHaveLength(1);
    expect(judge([windowed], TUE_5, { date: '2026-11-21' }).resolution.rules).toHaveLength(0);
    expect(ruleInWindow(rule({ weekdays: ['MON'] }), null)).toBe(true);
    expect(() => resolveCoachPreferences(input([windowed], { date: null }))).toThrow(
      /no day was given/
    );
    // An open-ended window is a bound on one side only.
    const from = rule({ weekdays: ['MON'], effectiveFrom: '2026-12-01' });
    expect(judge([from], TUE_5).resolution.rules).toHaveLength(0);
  });

  it("keep-current is met by any value the team's practices hold, and does nothing, saying so, with none", () => {
    const keep = [rule({ id: 'k', keepWeekday: true })];
    const held = [{ ...TUE_5 }, { ...THU_5 }];
    expect(judge(keep, TUE_5, { current: held }).verdict.mustKeepViolated).toBe(false);
    expect(judge(keep, THU_5, { current: held }).verdict.mustKeepViolated).toBe(false);
    expect(judge(keep, WED_5, { current: held }).verdict.mustKeepViolated).toBe(true);
    const none = judge(keep, WED_5, { current: [] });
    expect(none.verdict.mustKeepViolated).toBe(false);
    expect(isInertResolution(none.resolution)).toBe(true);
    expect(none.resolution.findings).toHaveLength(1);
    expect(none.resolution.findings[0]).toMatchObject({
      code: PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE,
      details: { ruleId: 'k', coachId: 'c1', dimension: 'weekday', level: 'must' },
    });
  });

  it('a rule with one live condition and one with nothing to keep is judged on the live one', () => {
    const mixed = [rule({ weekdays: ['TUE'], keepVenue: true })];
    const { resolution, verdict } = judge(mixed, WED_5, { current: [] });
    expect(resolution.rules[0].conditions.map((c) => c.dimension)).toEqual(['weekday']);
    expect(verdict.violatedRules).toEqual(['r1']);
    expect(resolution.findings.map((f) => f.details.dimension)).toEqual(['venue']);
  });

  it('conflicts are found before they bite: rules of one level with nothing in common leave no practice', () => {
    const must = judge(
      [rule({ id: 'a', weekdays: ['TUE'] }), rule({ id: 'b', coachId: 'c2', weekdays: ['THU'] })],
      TUE_5
    );
    const conflict = must.resolution.findings.find(
      (f) => f.code === PRACTICE_REASON.COACH_PREFERENCE_CONFLICT
    );
    expect(conflict.details).toEqual({
      dimension: 'weekday',
      level: 'must',
      ruleIds: ['a', 'b'],
      coachIds: ['c1', 'c2'],
    });
    // No candidate meets both, whatever its weekday.
    for (const day of ['TUE', 'THU', 'WED']) {
      expect(
        judge([rule({ id: 'a', weekdays: ['TUE'] }), rule({ id: 'b', weekdays: ['THU'] })], {
          ...TUE_5,
          weekday: day,
        }).verdict.mustKeepViolated
      ).toBe(true);
    }
    // {Tue, Thu} and {Thu} share Thursday: no conflict.
    const shared = judge(
      [rule({ id: 'a', weekdays: ['TUE', 'THU'] }), rule({ id: 'b', weekdays: ['THU'] })],
      THU_5
    );
    expect(shared.resolution.findings).toEqual([]);
    // Prefer rules that cancel each other out are visible too, at their own level.
    const prefer = judge(
      [
        rule({ id: 'a', level: 'prefer', weekdays: ['TUE'] }),
        rule({ id: 'b', level: 'prefer', weekdays: ['THU'] }),
      ],
      TUE_5
    );
    expect(prefer.resolution.findings.map((f) => f.details.level)).toEqual(['prefer']);
    // Three rules, pairwise sharing a value but with none shared by all three, conflict.
    const triple = judge(
      [
        rule({ id: 'a', weekdays: ['TUE', 'THU'] }),
        rule({ id: 'b', weekdays: ['THU', 'WED'] }),
        rule({ id: 'c', weekdays: ['WED', 'TUE'] }),
      ],
      TUE_5
    );
    expect(triple.resolution.findings.map((f) => f.details.ruleIds)).toEqual([['a', 'b', 'c']]);
    // A must and a prefer are not compared with each other.
    const mixed = judge(
      [rule({ id: 'a', weekdays: ['TUE'] }), rule({ id: 'b', level: 'prefer', weekdays: ['THU'] })],
      TUE_5
    );
    expect(mixed.resolution.findings).toEqual([]);
  });

  it('coachPriority is for visibility only: it changes no verdict', () => {
    const plain = judge([rule({ level: 'prefer', weekdays: ['TUE'] })], WED_5).verdict;
    const high = judge(
      [rule({ level: 'prefer', weekdays: ['TUE'], coachPriority: 'high' })],
      WED_5
    ).verdict;
    expect(high).toEqual(plain);
  });
});

describe('practice preference rules :: the contract refuses what the store cannot hold', () => {
  const refused = (over) =>
    CoachPreferenceRuleSchema.safeParse(rule({ weekdays: ['TUE'], ...over })).success === false;

  it('refuses an empty set, a duplicate, an out-of-range value, keep and values together, no condition, a reversed window', () => {
    expect(refused({ weekdays: [] })).toBe(true);
    expect(refused({ weekdays: ['TUE', 'TUE'] })).toBe(true);
    expect(refused({ weekdays: ['TUESDAY'] })).toBe(true);
    expect(refused({ weekdays: null, startMinutes: [1440] })).toBe(true);
    expect(refused({ weekdays: null, venueIds: ['not-a-uuid'] })).toBe(true);
    expect(refused({ keepWeekday: true })).toBe(true);
    expect(refused({ weekdays: null })).toBe(true);
    expect(refused({ effectiveFrom: '2026-11-10', effectiveTo: '2026-11-09' })).toBe(true);
    expect(refused({ coachPriority: 'urgent' })).toBe(true);
    expect(refused({ level: 'must_keep' })).toBe(true);
    expect(refused({})).toBe(false);
  });

  it('is strict: the old dimension and value keys, and a note, are refused', () => {
    expect(refused({ dimension: 'weekday' })).toBe(true);
    expect(refused({ value: 'TUE' })).toBe(true);
    expect(refused({ note: 'prefers Tuesday' })).toBe(true);
  });

  it('refuses a second rule with one id, and a placement that is not a placement', () => {
    expect(() =>
      resolveCoachPreferences(input([rule({ weekdays: ['TUE'] }), rule({ weekdays: ['THU'] })]))
    ).toThrow(/second rule with id r1/);
    expect(() =>
      resolveCoachPreferences(
        input([rule({ weekdays: ['TUE'] })], { current: [{ weekday: 'TUE' }] })
      )
    ).toThrow();
    expect(() =>
      judgeCoachPreferenceCandidate(resolveCoachPreferences(input([])), { weekday: 'TUE' })
    ).toThrow();
  });
});
