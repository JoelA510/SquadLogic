/**
 * 8.9 D14 PR B: the `practice_lighting_overrides` row schema, and the one
 * conversion from a stored row to PR A's `lightingOverrides` input.
 *
 * The database half (RPCs, RLS, the exclusion constraint, audit) is proven by
 * `docs/sql/20261003000000_smoke.sql` under the DB harness; this file pins the
 * JS side to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRACTICE_LIGHTING_OVERRIDE_KIND,
  PRACTICE_LIGHTING_OVERRIDE_STATUS,
  PracticeLightingOverrideRowSchema,
  PracticeLightingOverrideSchema,
  approvedLightingOverridesFromRows,
  lightingOverrideCovers,
} from '../packages/core/src/practice/index.js';

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20261003000000_practice_lighting_overrides.sql'),
  'utf8'
);

const SLOT_A = '00000000-0000-4000-8000-00000000000a';
const SLOT_B = '00000000-0000-4000-8000-00000000000b';

function row(id, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    practice_slot_id: SLOT_A,
    window: '[2026-10-01,2026-10-16)',
    kind: 'portable-lighting',
    status: 'approved',
    ...overrides,
  };
}

describe('practice lighting override vocabulary matches the table', () => {
  it('pins the status list to the migration CHECK, exactly', () => {
    const match = MIGRATION.match(/CHECK \(status IN \(([^)]*)\)\)/);
    // A regex that matched nothing would compare [] with [] below.
    expect(match).not.toBeNull();
    const inSql = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(inSql.length).toBeGreaterThan(0);
    expect(inSql).toEqual(Object.values(PRACTICE_LIGHTING_OVERRIDE_STATUS).sort());
  });

  it('pins the kind to the migration CHECK', () => {
    const match = MIGRATION.match(/CHECK \(kind = '([^']+)'\)/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(PRACTICE_LIGHTING_OVERRIDE_KIND);
  });

  it('stores the RPCs inclusive dates as a closed range, which the reader reopens', () => {
    // Both writers that take dates build the window the same way; the reader
    // below undoes exactly this, so a writer switching to '[)' would shift
    // every override by a day.
    expect(MIGRATION.match(/daterange\(p_from, p_until, '\[\]'\)/g)).toHaveLength(2);
    expect(MIGRATION).not.toMatch(/daterange\(p_from, p_until, '\[\)'\)/);
  });
});

describe('approvedLightingOverridesFromRows', () => {
  it('turns an approved row into the inclusive PR A input', () => {
    const [override] = approvedLightingOverridesFromRows([row(1)]);
    expect(override).toEqual({ slotId: SLOT_A, from: '2026-10-01', until: '2026-10-15' });
    expect(PracticeLightingOverrideSchema.safeParse(override).success).toBe(true);
  });

  it('reopens an exclusive end across a month and a year boundary', () => {
    const out = approvedLightingOverridesFromRows([
      row(1, { window: '[2026-10-25,2026-11-01)' }),
      row(2, { window: '[2026-12-28,2027-01-01)', practice_slot_id: SLOT_B }),
      row(3, { window: '[2026-11-20,2026-11-21)' }),
    ]);
    expect(out).toEqual([
      { slotId: SLOT_A, from: '2026-10-25', until: '2026-10-31' },
      { slotId: SLOT_B, from: '2026-12-28', until: '2026-12-31' },
      { slotId: SLOT_A, from: '2026-11-20', until: '2026-11-20' },
    ]);
  });

  it('W24: only approved rows exempt, whatever the caller selected', () => {
    const rows = [
      row(1, { status: 'requested' }),
      row(2, { status: 'approved', window: '[2026-10-20,2026-10-23)' }),
      row(3, { status: 'rejected' }),
      row(4, { status: 'withdrawn' }),
    ];
    // Meta-assertion: the input carries every status, so the filter below had
    // something of each kind to keep or drop.
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set(Object.values(PRACTICE_LIGHTING_OVERRIDE_STATUS))
    );
    const out = approvedLightingOverridesFromRows(rows);
    expect(out).toEqual([{ slotId: SLOT_A, from: '2026-10-20', until: '2026-10-22' }]);

    const covers = lightingOverrideCovers(out);
    expect(covers(SLOT_A, '2026-10-20')).toBe(true);
    // The requested, rejected and withdrawn rows' dates are not exempt.
    expect(covers(SLOT_A, '2026-10-01')).toBe(false);
    expect(covers(SLOT_A, '2026-10-15')).toBe(false);
  });

  it('feeds PR A: covers from..until inclusive, not the stored exclusive end', () => {
    const covers = lightingOverrideCovers(approvedLightingOverridesFromRows([row(1)]));
    expect(covers(SLOT_A, '2026-10-01')).toBe(true);
    expect(covers(SLOT_A, '2026-10-15')).toBe(true);
    expect(covers(SLOT_A, '2026-10-16')).toBe(false);
    expect(covers(SLOT_A, '2026-09-30')).toBe(false);
    expect(covers(SLOT_B, '2026-10-05')).toBe(false);
  });

  it('refuses a row the table could not have produced', () => {
    for (const bad of [
      row(1, { window: '[2026-10-01,2026-10-15]' }),
      row(2, { window: '[2026-10-01,)' }),
      row(3, { window: 'empty' }),
      row(4, { kind: 'floodlights' }),
      row(5, { status: 'superseded' }),
      row(6, { practice_slot_id: '' }),
    ]) {
      expect(() => approvedLightingOverridesFromRows([bad])).toThrow();
    }
    expect(() => approvedLightingOverridesFromRows(null)).toThrow(TypeError);
    expect(PracticeLightingOverrideRowSchema.safeParse(row(7)).success).toBe(true);
  });
});
