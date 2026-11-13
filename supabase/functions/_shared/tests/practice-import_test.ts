/**
 * The practice schedule import, in the runtime it is deployed to (plan `docs/changes/2026-11-03-schedule-expansion.md`
 * 4.11; PR 11, task L1). `tests/practiceImportEdgeParity.test.js` (Vitest) builds the vector table from core and holds
 * `../practice-import.ts` equal to core over it and over the shipped fixtures; this file asks the Deno build the same
 * vectors.
 *
 * `scripts/deno-mirror-tests.sh` runs every file here under `TZ=UTC` and `TZ=America/Los_Angeles`: a practice row has
 * no instant, so a parse that read the host zone would differ between the two runs. Placeholder values only.
 */

import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { sanitizeImportText } from '../import-rows.ts';
import { PRACTICE_IMPORT_LIMITS, stagePracticeFile } from '../practice-import.ts';
import table from './fixtures/practice-import.vectors.json' with { type: 'json' };

interface Vector {
  name: string;
  headers: string[];
  rows: Array<Record<string, string>> | { repeat: Record<string, string>; count: number };
  season: { startDate: string | null; endDate: string | null };
  dates: { validFrom?: string | null; validUntil?: string | null } | null;
  expected: unknown;
}
const VECTORS = (table as { vectors: Vector[] }).vectors;

const rowsOf = (v: Vector): Array<Record<string, string>> =>
  Array.isArray(v.rows)
    ? v.rows
    : Array.from({ length: v.rows.count }, () => ({
        ...(v.rows as { repeat: Record<string, string> }).repeat,
      }));

const stage = (v: Vector) =>
  JSON.parse(
    JSON.stringify(
      stagePracticeFile({
        headers: v.headers,
        rows: rowsOf(v),
        season: v.season,
        dates: v.dates,
        clean: sanitizeImportText,
      })
    )
  );

Deno.test('the table is not empty (a table that examined nothing would pass)', () => {
  assert(VECTORS.length >= 18);
  assert(VECTORS.some((v) => v.name === 'too many rows'));
});

for (const v of VECTORS) {
  Deno.test(`the Deno build stages what core stages: ${v.name}`, () => {
    assertEquals(stage(v), v.expected);
  });
}

Deno.test('the whole cap stages in one request, and one row more is refused', () => {
  const tooMany = VECTORS.find((v) => v.name === 'too many rows');
  assert(tooMany);
  assertEquals(rowsOf(tooMany).length, PRACTICE_IMPORT_LIMITS.MAX_ROWS + 1);
  assertEquals(stage(tooMany).refusal.code, 'too-many-rows');
});

Deno.test('a confirm-step date that is not a date is the caller’s defect, thrown', () => {
  assertThrows(
    () =>
      stagePracticeFile({
        headers: ['Day', 'Start', 'End', 'Location', 'Field'],
        rows: [{ Day: 'Mon', Start: '16:00', End: '17:00', Location: 'Venue A', Field: 'Field 1' }],
        season: { startDate: '2026-09-07', endDate: '2027-03-31' },
        dates: { validFrom: '2026-02-31' },
        clean: sanitizeImportText,
      }),
    TypeError
  );
});
