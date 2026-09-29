/**
 * Cross-arm drift check (8.9 D14 PR C, W27): core's lighting-override reading
 * against the Deno twin `_shared/engines/practice-lighting-overrides.ts`.
 *
 * - `approvedLightingOverridesFromRows` (core `practice/lightingOverrides.js`)
 *   -- the row contract, only `approved` kept, `[from,end)` -> inclusive.
 * - `lightingOverrideCovers` (core `practice/daylight.js`) -- the inclusive
 *   `[from, until]` window on its own slot.
 *
 * Both arms run over the full enumerated product
 * (`_shared/tests/lighting-override-product.ts`), compared value by value here
 * and as a digest against `lighting-override-product.digest.json`, which the
 * Deno test (`lighting-overrides_test.ts`, run by `scripts/deno-mirror-tests.sh`
 * under two host zones) holds the twin to in the runtime it deploys to. The
 * `coachPreferenceDrift` precedent.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRACTICE_LIGHTING_OVERRIDE_KIND,
  PRACTICE_LIGHTING_OVERRIDE_STATUS,
  approvedLightingOverridesFromRows as coreRows,
  lightingOverrideCovers as coreCovers,
} from '@squadlogic/core/practice/index.js';
import {
  LIGHTING_OVERRIDE_KIND,
  LIGHTING_OVERRIDE_STATUS,
  approvedLightingOverridesFromRows as twinRows,
  lightingOverrideCovers as twinCovers,
} from '../supabase/functions/_shared/engines/practice-lighting-overrides.js';
import {
  PROBES,
  ROW_KINDS,
  ROW_SLOT_IDS,
  ROW_STATUSES,
  ROW_WINDOWS,
  WINDOWS,
  enumerateCoverCases,
  enumerateRowCases,
  projectCovers,
  projectRows,
} from '../supabase/functions/_shared/tests/lighting-override-product.js';

const digest = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      'supabase/functions/_shared/tests/lighting-override-product.digest.json'
    ),
    'utf8'
  )
);

const COVER_CASES = enumerateCoverCases();
const ROW_CASES = enumerateRowCases();
/** @param {any} rows @param {any} covers */
const outcomesOf = (rows, covers) => ({
  covers: COVER_CASES.map((c) => projectCovers(covers, c)),
  rows: ROW_CASES.map((c) => projectRows(rows, c)),
});
const core = outcomesOf(coreRows, coreCovers);
const twin = outcomesOf(twinRows, twinCovers);
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The product's size, from the plan's own arithmetic -- NOT from the
 * enumerator, which is what a shrunken product would corrupt.
 * Covers: none + 6 single + C(6,2) pairs on A + 6x6 A/B pairs; probes: 6
 * windows x 2 slots x 4 boundaries. Rows: 3 ids x 11 windows x 3 kinds x 7
 * statuses, + 4 shapes + 3 multi-row + 3 non-arrays.
 */
const EXPECTED_COVER_CASES = 1 + 6 + 15 + 36;
const EXPECTED_PROBES = 6 * 2 * 4;
const EXPECTED_ROW_CASES = 3 * 11 * 3 * 7 + 4 + 3 + 3;

describe('the lighting-override arms agree over the full product (W27)', () => {
  it('the product is the full product, and exercises every branch it claims to', () => {
    expect(COVER_CASES).toHaveLength(EXPECTED_COVER_CASES);
    expect(PROBES).toHaveLength(EXPECTED_PROBES);
    expect(ROW_CASES).toHaveLength(EXPECTED_ROW_CASES);
    expect(WINDOWS).toHaveLength(6);
    expect([ROW_SLOT_IDS, ROW_WINDOWS, ROW_KINDS, ROW_STATUSES].map((a) => a.length)).toEqual([
      3, 11, 3, 7,
    ]);
    expect(new Set([...COVER_CASES, ...ROW_CASES].map((c) => c.id)).size).toBe(
      COVER_CASES.length + ROW_CASES.length
    );
    // Covers: each of the four boundaries comes out both covered and not.
    const byBoundary = [0, 1, 2, 3].map(
      (k) => new Set(core.covers.flatMap((row) => row.filter((_, i) => i % 4 === k)))
    );
    for (const seen of byBoundary) expect([...seen].sort()).toEqual([false, true]);
    // Rows: refusals, empty reads (only non-approved rows) and non-empty reads.
    const rows = /** @type {any[]} */ (core.rows);
    expect(rows.some((o) => o.refused)).toBe(true);
    expect(rows.some((o) => o.value?.length === 0)).toBe(true);
    expect(rows.some((o) => o.value?.length === 1)).toBe(true);
    expect(rows.some((o) => o.value?.length === 2)).toBe(true);
    // A non-calendar end is read, not refused, by both arms; an empty window
    // and one reopening before the year 0000 are refused.
    const single = (w) => ROW_CASES.findIndex((c) => c.id === `row-0-${w}-0-1`);
    expect(rows[single(3)]).toEqual({
      value: [{ slotId: ROW_SLOT_IDS[0], from: '2026-02-27', until: '2026-03-01' }],
    });
    expect(rows[single(4)]).toEqual({ refused: true });
    expect(rows[single(5)]).toEqual({ refused: true });
  });

  it('the twin equals core on every case, value by value', () => {
    let compared = 0;
    core.covers.forEach((outcome, i) => {
      expect(twin.covers[i], COVER_CASES[i].id).toEqual(outcome);
      compared += outcome.length;
    });
    core.rows.forEach((outcome, i) => {
      expect(twin.rows[i], ROW_CASES[i].id).toEqual(outcome);
      compared += 1;
    });
    expect(compared).toBe(EXPECTED_COVER_CASES * EXPECTED_PROBES + EXPECTED_ROW_CASES);
  });

  it("the committed digest is core's, and the twin's matches it", () => {
    expect(digest.cases).toBe(EXPECTED_COVER_CASES + EXPECTED_ROW_CASES);
    expect(sha256(core)).toBe(digest.sha256);
    expect(sha256(twin)).toBe(digest.sha256);
  });

  it("the twin's vocabulary is core's (the table CHECKs)", () => {
    expect(LIGHTING_OVERRIDE_STATUS).toEqual(PRACTICE_LIGHTING_OVERRIDE_STATUS);
    expect(LIGHTING_OVERRIDE_KIND).toBe(PRACTICE_LIGHTING_OVERRIDE_KIND);
  });
});
