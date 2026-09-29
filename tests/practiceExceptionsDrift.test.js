/**
 * Cross-arm drift check (8.6 3b PR 12a, plan §5, W9): core
 * `utils/practiceExceptions.js` against its import-free Deno twin
 * `_shared/calendar/practiceExceptions.ts`.
 *
 * Both arms run over the full enumerated product
 * (`_shared/tests/practice-exceptions-product.ts`), compared value by value
 * here and as a digest against `practice-exceptions-product.digest.json`, which
 * the Deno test (`practice-exceptions_test.ts`, run by
 * `scripts/deno-mirror-tests.sh` under two host zones) holds the twin to in the
 * runtime it deploys to. The `lightingOverrideDrift` precedent.
 *
 * This file runs in America/Los_Angeles on purpose (the
 * `practiceOccurrences.test.js` precedent): an arm that read a wall date
 * through a host-zone `Date` would pass at UTC and fail here.
 */

process.env.TZ = 'America/Los_Angeles';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PRACTICE_EXCEPTION_CODE as CORE_CODE,
  PRACTICE_EXCEPTION_KIND as CORE_KIND,
  PRACTICE_EXCEPTION_TBD_REASONS as CORE_REASONS,
  applyPracticeExceptions as coreApply,
} from '@squadlogic/core/utils/practiceExceptions.js';
import {
  PRACTICE_EXCEPTION_CODE as TWIN_CODE,
  PRACTICE_EXCEPTION_KIND as TWIN_KIND,
  PRACTICE_EXCEPTION_TBD_REASONS as TWIN_REASONS,
  applyPracticeExceptions as twinApply,
} from '../supabase/functions/_shared/calendar/practiceExceptions.ts';
import {
  KINDS,
  MULTIPLICITY,
  RANGES,
  RELOCATED_SLOTS,
  ROWSETS,
  WINDOW_POSITIONS,
  WITHDRAWN,
  enumerateCases,
  projectCase,
} from '../supabase/functions/_shared/tests/practice-exceptions-product.ts';

const digest = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      'supabase/functions/_shared/tests/practice-exceptions-product.digest.json'
    ),
    'utf8'
  )
);

const CASES = enumerateCases();
const core = CASES.map((c) => projectCase(coreApply, c));
const twin = CASES.map((c) => projectCase(twinApply, c));
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * The product's size, from the plan's own arithmetic -- NOT from the
 * enumerator, which is what a shrunken product would corrupt. Per range and
 * row set: one zero-exception case, plus 8 positions x 3 kinds x 4 relocated
 * slots x 3 withdrawn spellings x 2 multiplicities. Then 8 extras.
 */
const EXPECTED_CASES = 2 * 2 * (1 + 8 * 3 * 4 * 3 * 2) + 8;

/** @param {any} o */
const valueOf = (o) => /** @type {any} */ (o).value;

describe('the practice-exception arms agree over the full product (W9)', () => {
  it('the product is the full product, and exercises every branch it claims to', () => {
    expect(CASES).toHaveLength(EXPECTED_CASES);
    expect(
      [RANGES, ROWSETS, WINDOW_POSITIONS, KINDS, RELOCATED_SLOTS, WITHDRAWN, MULTIPLICITY].map(
        (a) => a.length
      )
    ).toEqual([2, 2, 8, 3, 4, 3, 2]);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);

    // Every kind of output the helper can produce appears somewhere in core's
    // outcomes, so the digest is over a product that reaches each branch.
    const values = core.filter((o) => 'value' in o).map(valueOf);
    const kinds = new Set(values.flatMap((v) => v.occurrences.map((o) => o.kind)));
    expect([...kinds].sort()).toEqual(['relocated', 'series', 'time_tbd']);
    const codes = new Set(
      values.flatMap((v) => [
        ...v.occurrences.filter((o) => o.kind === 'time_tbd').map((o) => o.code),
        ...v.undated.map((u) => u.code),
        ...v.findings.map((f) => f.code),
      ])
    );
    for (const code of [
      ...Object.values(CORE_CODE),
      'past-sunset',
      'PRACTICE_SLOT_MISSING',
      'PRACTICE_DAY_UNREADABLE',
      'PRACTICE_RANGE_UNREADABLE',
    ]) {
      expect(codes.has(code), code).toBe(true);
    }
    expect(values.some((v) => v.meta.exceptionsWithdrawn > 0)).toBe(true);
    expect(values.some((v) => v.meta.datesSuppressed > 0)).toBe(true);
    expect(core.filter((o) => 'refused' in o)).toHaveLength(2);
  });

  it('the twin equals core on every case, value by value', () => {
    let compared = 0;
    core.forEach((outcome, i) => {
      expect(twin[i], CASES[i].id).toEqual(outcome);
      compared += 1;
    });
    expect(compared).toBe(EXPECTED_CASES);
  });

  it("the committed digest is core's, and the twin's matches it", () => {
    expect(digest.cases).toBe(EXPECTED_CASES);
    expect(sha256(core)).toBe(digest.sha256);
    expect(sha256(twin)).toBe(digest.sha256);
  });

  it("the twin's vocabulary is core's", () => {
    expect(TWIN_CODE).toEqual(CORE_CODE);
    expect(TWIN_KIND).toEqual(CORE_KIND);
    expect(TWIN_REASONS).toEqual(CORE_REASONS);
  });
});
