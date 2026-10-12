/**
 * Witness 22 (docs/PHASE_8_6_PR11_ENACT_PLAN.md §6, 8.6 3b PR 11b): the Edge's
 * enact record schema and core's agree.
 *
 * The Edge twin is a factory over the caller's zod
 * (`supabase/functions/_shared/practice-enact-record.ts`), so this builds the
 * VERY schema `practice-persistence` builds, with npm zod, and compares it to
 * core `PracticeEnactRecordSchema` two ways:
 *   1. structurally: every key, at every depth, its type, strictness, enum
 *      values, literals and checks (regex sources, bounds) -- canonical trees
 *      compared whole;
 *   2. behaviourally, under zod 4 AND zod 3 (the Deno Edge's major): a valid
 *      record all accept, and a mutation product over
 *      every path of it (removed, nulled, re-typed, an extra key beside it),
 *      judged identically by both arms.
 * The `practiceWriterV3` source-pin precedent, made executable.
 *
 * 3b PR 11d-2 (witness B15, docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md §5):
 * the record is a union of one arm per `cause.kind`. The tree walks every arm
 * and every refinement, and the product runs over a valid record of EACH
 * arm, so a key added to one arm of one side only ("add `stored` to one arm
 * only") is a tree difference and a verdict difference.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';

import {
  PRACTICE_CHAIN_STOP,
  PRACTICE_ENACT_FINGERPRINT_COVERS,
  PracticeEnactRecordSchema,
} from '../packages/core/src/practice/index.js';
import {
  PRACTICE_ENACT_CHAIN_STOPS,
  PRACTICE_ENACT_FINGERPRINT_COVERS as EDGE_COVERS,
  buildPracticeEnactRecordSchema,
} from '../supabase/functions/_shared/practice-enact-record.ts';

const edge = buildPracticeEnactRecordSchema(/** @type {any} */ (z));
// The same factory under zod v3, the major the Deno Edge imports (3.22.4).
const edgeV3 = buildPracticeEnactRecordSchema(/** @type {any} */ (z3));

/** A canonical tree of a zod 4 schema: what a drift in either arm changes. */
function tree(schema) {
  const def = schema._zod.def;
  const checks = (def.checks ?? []).map((check) => {
    const { pattern, ...rest } = check._zod.def;
    return JSON.parse(JSON.stringify({ ...rest, pattern: pattern?.source }));
  });
  switch (def.type) {
    case 'object':
      return {
        object: Object.fromEntries(
          Object.keys(def.shape)
            .sort()
            .map((key) => [key, tree(def.shape[key])])
        ),
        strict: def.catchall?._zod.def.type === 'never',
        // A `.refine` is a check on the object (both-or-neither minutes, one scope).
        checks,
      };
    case 'union':
      return { union: def.options.map(tree) };
    case 'nullable':
      return { nullable: tree(def.innerType) };
    case 'array':
      return { array: tree(def.element), checks };
    case 'enum':
      return { enum: Object.values(def.entries).sort() };
    case 'literal':
      return { literal: [...def.values] };
    case 'record':
      return { record: [tree(def.keyType), tree(def.valueType)] };
    default:
      return { type: def.type, checks };
  }
}

/** Every key path in the tree, for the meta-assertion. */
function paths(node, prefix = '') {
  if (node.object) {
    return Object.entries(node.object).flatMap(([key, child]) => [
      `${prefix}${key}`,
      ...paths(child, `${prefix}${key}.`),
    ]);
  }
  if (node.nullable) return paths(node.nullable, prefix);
  if (node.array) return paths(node.array, `${prefix}[].`);
  if (node.union) return node.union.flatMap((arm, i) => paths(arm, `${prefix}|${i}|`));
  return [];
}

const U = (n) => `e1100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHAPE = { surface_id: U(2), weekday: 'THU', start_minutes: 1080, duration_minutes: 90 };
/** A record as core buildEnactRecord emits it; synthetic ids only. */
const VALID = {
  schema_version: 1,
  enact_key: U(1),
  run_id: U(1),
  season_settings_id: U(3),
  cause: {
    kind: 'retirement',
    id: U(4),
    loss: {
      from: '2026-10-15',
      until: null,
      surface_ids: [U(4)],
      start_minutes: null,
      end_minutes: null,
      reason: 'retirement',
    },
    stored_effective_to: '2026-10-14',
  },
  series: {
    assignment_id: U(5),
    team_id: U(6),
    from: { ...SHAPE, surface_id: U(4), weekday: 'TUE' },
    window: { from: '2026-10-15', until: '2026-11-30' },
  },
  decision: {
    kind: 'rehome',
    to: SHAPE,
    tier: 'same-venue',
    origin: null,
    tbd_reason: null,
    objective: { total: 1, counts: { changedWeekday: 1 } },
    coach_overlaps: [U(7)],
    coach_days_worsened: 0,
  },
  rejudge: { stands: true, shown_counts: { changedWeekday: 1 } },
  declined: [{ assignment_id: U(8), to: SHAPE }],
  chains: [{ kind: 'decline', assignment_id: U(8), hops: 2, stopped_by: 'no-gain' }],
  local: true,
  enacted_before: [U(9)],
  prompt: {
    rows: [
      {
        assignment_id: U(5),
        assigned_via: 'auto',
        effect: 'closed',
        range_after: '[2026-09-01,2026-10-15)',
      },
    ],
    published_practices_affected: 7,
    accepted: true,
  },
  unlock: [
    { assignment_id: U(5), reason: `enact ${U(1)}: retirement of field ${U(4)} from 2026-10-15` },
  ],
  writes: {
    closes: [{ assignment_id: U(5), last_day: '2026-10-14' }],
    new_rows: [
      { team_id: U(6), practice_slot_id: U(10), effective_date_range: '[2026-10-15,2026-11-30]' },
    ],
    exceptions: 0,
  },
  base_fingerprint: 'a'.repeat(32),
  result_fingerprint: null,
  fingerprint_covers: 'practice_assignments+practice_exceptions',
  solver: {
    strategy: 'exact',
    proven_optimal: true,
    daylight_supplied: true,
    closures_supplied: true,
  },
};

/**
 * A blackout record as core buildEnactRecord emits it (3b PR 11d-2): one
 * relocation on S over its window, a partial-day loss, nothing unlocked,
 * closed or created. Synthetic ids only.
 */
const VALID_BLACKOUT = {
  ...structuredClone(VALID),
  cause: {
    kind: 'blackout',
    id: U(11),
    loss: {
      from: '2026-10-19',
      until: '2026-10-25',
      surface_ids: [U(4)],
      start_minutes: 1050,
      end_minutes: 1110,
      reason: 'maintenance',
    },
    stored: {
      field_id: U(4),
      location_id: null,
      blackout_from: '2026-10-19',
      blackout_until: '2026-10-25',
      start_minutes: 1050,
      end_minutes: 1110,
      reason: 'maintenance',
    },
  },
  series: {
    assignment_id: U(5),
    team_id: U(6),
    from: { ...SHAPE, surface_id: U(4), weekday: 'TUE' },
    window: { from: '2026-10-19', until: '2026-10-25' },
  },
  decision: { ...structuredClone(VALID.decision), kind: 'relocate' },
  prompt: {
    rows: [
      {
        assignment_id: U(5),
        assigned_via: 'auto',
        effect: 'temporarily moved',
        range_after: null,
        window: '[2026-10-19,2026-10-25]',
      },
    ],
    published_practices_affected: 1,
    accepted: true,
  },
  unlock: [],
  writes: { closes: [], new_rows: [], exceptions: 1 },
};

/** Every (path, value) leaf and object of VALID, with its parent and key. */
function* nodes(value, path = []) {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      yield { path: [...path, key], value: child };
      yield* nodes(child, [...path, key]);
    }
  }
}

function mutate(path, fn, base = VALID) {
  const copy = structuredClone(base);
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key];
  fn(parent, path[path.length - 1]);
  return copy;
}

describe('the enact record schemas agree (witness 22)', () => {
  it('core and the Edge twin have the same canonical tree, key for key and enum for enum', () => {
    const coreTree = tree(PracticeEnactRecordSchema);
    const edgeTree = tree(edge);
    // Meta-assertion: the walk reached every level of both arms of the plan
    // §5 record, and both arms carry the same 19 top-level keys (the
    // wrapper's `c_keys`).
    expect(coreTree.union).toHaveLength(2);
    const [retirement, blackout] = coreTree.union.map((arm) => paths(arm));
    expect(retirement.length).toBeGreaterThanOrEqual(80);
    expect(retirement).toContain('cause.stored_effective_to');
    expect(retirement).toContain('chains.[].stopped_by');
    expect(retirement).toContain('writes.new_rows.[].effective_date_range');
    expect(blackout.length).toBeGreaterThanOrEqual(80);
    expect(blackout).toContain('cause.stored.blackout_until');
    expect(blackout).toContain('prompt.rows.[].window');
    expect(blackout).not.toContain('cause.stored_effective_to');
    for (const arm of coreTree.union) expect(Object.keys(arm.object)).toHaveLength(19);
    expect(Object.keys(coreTree.union[1].object)).toEqual(Object.keys(coreTree.union[0].object));
    // The refinements are reached too: two on stored, one on loss.
    expect(coreTree.union[1].object.cause.object.stored.checks).toHaveLength(2);
    expect(coreTree.union[1].object.cause.object.loss.checks).toHaveLength(1);
    expect(edgeTree).toEqual(coreTree);
  });

  it('the twin constants are core values', () => {
    expect([...PRACTICE_ENACT_CHAIN_STOPS].sort()).toEqual(
      Object.values(PRACTICE_CHAIN_STOP).sort()
    );
    expect(EDGE_COVERS).toBe(PRACTICE_ENACT_FINGERPRINT_COVERS);
  });

  for (const [arm, base, minimum] of /** @type {const} */ ([
    ['retirement', VALID, 400],
    ['blackout', VALID_BLACKOUT, 380],
  ])) {
    it(`both accept the valid ${arm} record, and judge every mutation of it alike`, () => {
      expect(PracticeEnactRecordSchema.safeParse(base).success).toBe(true);
      expect(edge.safeParse(base).success).toBe(true);
      expect(edgeV3.safeParse(base).success).toBe(true);
      /** @type {Array<[string, any]>} */
      const cases = [];
      for (const { path } of nodes(base)) {
        const at = path.join('.');
        cases.push([`${at} removed`, mutate(path, (p, k) => delete p[k], base)]);
        cases.push([`${at} null`, mutate(path, (p, k) => (p[k] = null), base)]);
        cases.push([`${at} as a string`, mutate(path, (p, k) => (p[k] = 'x'), base)]);
        cases.push([`${at} as a number`, mutate(path, (p, k) => (p[k] = -1), base)]);
        if (!Array.isArray(path.slice(0, -1).reduce((o, k) => o[k], base))) {
          cases.push([`extra key beside ${at}`, mutate(path, (p) => (p.extra_key = 1), base)]);
        }
      }
      let accepted = 0;
      let refused = 0;
      for (const [name, record] of cases) {
        const coreOk = PracticeEnactRecordSchema.safeParse(record).success;
        expect(edge.safeParse(record).success, name).toBe(coreOk);
        expect(edgeV3.safeParse(record).success, `${name} (zod v3)`).toBe(coreOk);
        if (coreOk) accepted += 1;
        else refused += 1;
      }
      // Meta-assertion: the product exercised both verdicts, over every path.
      expect(cases.length).toBeGreaterThan(minimum);
      expect(refused).toBeGreaterThan(300);
      expect(accepted).toBeGreaterThan(5);
    });
  }

  it('neither arm admits the other arm’s shape: rehome, a stored date, minutes or an unlock', () => {
    const swap = (base, edit) => {
      const copy = structuredClone(base);
      edit(copy);
      return copy;
    };
    const unlock = VALID.unlock[0];
    /** @type {Array<[string, any]>} */
    const cases = [
      ['a blackout that re-homes', swap(VALID_BLACKOUT, (r) => (r.decision.kind = 'rehome'))],
      ['a retirement that relocates', swap(VALID, (r) => (r.decision.kind = 'relocate'))],
      [
        'a blackout with stored_effective_to',
        swap(VALID_BLACKOUT, (r) => (r.cause.stored_effective_to = '2026-10-18')),
      ],
      ['a blackout that unlocks', swap(VALID_BLACKOUT, (r) => (r.unlock = [unlock]))],
      ['a blackout with two exceptions', swap(VALID_BLACKOUT, (r) => (r.writes.exceptions = 2))],
      [
        'a blackout with half a pair of minutes',
        swap(VALID_BLACKOUT, (r) => (r.cause.loss.end_minutes = null)),
      ],
      [
        'a blackout stored with minutes out of order',
        swap(VALID_BLACKOUT, (r) => (r.cause.stored.end_minutes = 1000)),
      ],
      [
        'a blackout stored with both scopes',
        swap(VALID_BLACKOUT, (r) => (r.cause.stored.location_id = U(12))),
      ],
      [
        'a blackout stored with no scope',
        swap(VALID_BLACKOUT, (r) => (r.cause.stored.field_id = null)),
      ],
      [
        'a retirement with minutes',
        swap(VALID, (r) => Object.assign(r.cause.loss, { start_minutes: 1, end_minutes: 2 })),
      ],
    ];
    for (const [name, record] of cases) {
      expect(PracticeEnactRecordSchema.safeParse(record).success, name).toBe(false);
      expect(edge.safeParse(record).success, name).toBe(false);
      expect(edgeV3.safeParse(record).success, `${name} (zod v3)`).toBe(false);
    }
    // The all-day and the location-scoped blackout are admitted by all three.
    const allDay = swap(VALID_BLACKOUT, (r) => {
      Object.assign(r.cause.loss, { start_minutes: null, end_minutes: null });
      Object.assign(r.cause.stored, {
        start_minutes: null,
        end_minutes: null,
        field_id: null,
        location_id: U(12),
      });
    });
    for (const schema of [PracticeEnactRecordSchema, edge, edgeV3]) {
      expect(schema.safeParse(allDay).success).toBe(true);
    }
    expect(cases).toHaveLength(10);
  });
});
