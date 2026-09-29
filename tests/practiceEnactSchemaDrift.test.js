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
      };
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

/** Every (path, value) leaf and object of VALID, with its parent and key. */
function* nodes(value, path = []) {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      yield { path: [...path, key], value: child };
      yield* nodes(child, [...path, key]);
    }
  }
}

function mutate(path, fn) {
  const copy = structuredClone(VALID);
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key];
  fn(parent, path[path.length - 1]);
  return copy;
}

describe('the enact record schemas agree (witness 22)', () => {
  it('core and the Edge twin have the same canonical tree, key for key and enum for enum', () => {
    const coreTree = tree(PracticeEnactRecordSchema);
    const edgeTree = tree(edge);
    // Meta-assertion: the walk reached every level of the plan §5 record.
    const keys = paths(coreTree);
    expect(keys.length).toBeGreaterThanOrEqual(80);
    expect(keys).toContain('cause.stored_effective_to');
    expect(keys).toContain('chains.[].stopped_by');
    expect(keys).toContain('writes.new_rows.[].effective_date_range');
    expect(Object.keys(coreTree.object)).toHaveLength(19);
    expect(edgeTree).toEqual(coreTree);
  });

  it('the twin constants are core values', () => {
    expect([...PRACTICE_ENACT_CHAIN_STOPS].sort()).toEqual(
      Object.values(PRACTICE_CHAIN_STOP).sort()
    );
    expect(EDGE_COVERS).toBe(PRACTICE_ENACT_FINGERPRINT_COVERS);
  });

  it('both accept the valid record, and judge every mutation of it alike', () => {
    expect(PracticeEnactRecordSchema.safeParse(VALID).success).toBe(true);
    expect(edge.safeParse(VALID).success).toBe(true);
    expect(edgeV3.safeParse(VALID).success).toBe(true);
    /** @type {Array<[string, any]>} */
    const cases = [];
    for (const { path } of nodes(VALID)) {
      const at = path.join('.');
      cases.push([`${at} removed`, mutate(path, (p, k) => delete p[k])]);
      cases.push([`${at} null`, mutate(path, (p, k) => (p[k] = null))]);
      cases.push([`${at} as a string`, mutate(path, (p, k) => (p[k] = 'x'))]);
      cases.push([`${at} as a number`, mutate(path, (p, k) => (p[k] = -1))]);
      if (!Array.isArray(path.slice(0, -1).reduce((o, k) => o[k], VALID))) {
        cases.push([`extra key beside ${at}`, mutate(path, (p) => (p.extra_key = 1))]);
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
    expect(cases.length).toBeGreaterThan(400);
    expect(refused).toBeGreaterThan(300);
    expect(accepted).toBeGreaterThan(5);
  });
});
