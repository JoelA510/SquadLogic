/**
 * The lighting-override twin under Deno (8.9 D14 PR C, W27), run by
 * `scripts/deno-mirror-tests.sh` under two host zones.
 *
 * Runs `_shared/engines/practice-lighting-overrides.ts` over the full
 * enumerated product (`lighting-override-product.ts`) in the runtime it
 * deploys to, and holds its outcome digest to
 * `lighting-override-product.digest.json` -- the digest of CORE's outcomes,
 * which `tests/lightingOverrideDrift.test.js` asserts under Vitest alongside a
 * value-by-value comparison of the two arms. Either arm drifting turns one of
 * the two runs red. The reading is calendar arithmetic only, so a host-zone
 * read would show as one zone's digest differing from the other's.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import {
  approvedLightingOverridesFromRows,
  lightingOverrideCovers,
} from '../engines/practice-lighting-overrides.ts';
import {
  enumerateCoverCases,
  enumerateRowCases,
  projectCovers,
  projectRows,
  PROBES,
  SLOT_A,
} from './lighting-override-product.ts';
import digest from './lighting-override-product.digest.json' with { type: 'json' };

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test(
  "lighting overrides - the twin reproduces core's outcome digest over the full product",
  async () => {
    const coverCases = enumerateCoverCases();
    const rowCases = enumerateRowCases();
    // Meta-assertion: the digest records how many cases core was run on, so a
    // shrunken product cannot match a digest of a smaller one by accident.
    assertEquals(coverCases.length + rowCases.length, digest.cases);
    assertEquals(PROBES.length, 48);
    const outcomes = {
      covers: coverCases.map((c) => projectCovers(lightingOverrideCovers, c)),
      rows: rowCases.map((c) =>
        projectRows((rows) => approvedLightingOverridesFromRows(rows as unknown[]), c)
      ),
    };
    assertEquals(await sha256(JSON.stringify(outcomes)), digest.sha256);
  }
);

Deno.test('lighting overrides - a window is inclusive at both ends, and only on its slot', () => {
  const covered = lightingOverrideCovers([
    { slotId: SLOT_A, from: '2026-09-22', until: '2026-10-06' },
  ]);
  assertEquals(
    ['2026-09-21', '2026-09-22', '2026-10-06', '2026-10-07'].map((d) => covered(SLOT_A, d)),
    [false, true, true, false]
  );
  assert(!covered('another-slot', '2026-09-22'));
});

Deno.test('lighting overrides - only approved rows, and [from,end) reopens to inclusive', () => {
  const row = (status: string) => ({
    practice_slot_id: SLOT_A,
    window: '[2026-12-31,2027-01-02)',
    kind: 'portable-lighting',
    status,
  });
  assertEquals(
    approvedLightingOverridesFromRows(['requested', 'approved', 'rejected', 'withdrawn'].map(row)),
    [{ slotId: SLOT_A, from: '2026-12-31', until: '2027-01-01' }]
  );
});
