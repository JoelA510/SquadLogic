/**
 * The practice-exception twin in the runtime it deploys to (8.6 3b PR 12a,
 * plan §5, W9/W10).
 *
 * Runs `_shared/calendar/practiceExceptions.ts` over the enumerated product
 * (`practice-exceptions-product.ts`) and holds its outcome digest to
 * `practice-exceptions-product.digest.json` -- the digest of CORE's outcomes,
 * written by `tests/practiceExceptionsDrift.test.js`. `scripts/deno-mirror-tests.sh`
 * runs this file under UTC and America/Los_Angeles, so a twin that read a wall
 * date through a host-zone `Date` would match the digest in one zone only.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { applyPracticeExceptions } from '../calendar/practiceExceptions.ts';
import { enumerateCases, projectCase } from './practice-exceptions-product.ts';
import digest from './practice-exceptions-product.digest.json' with { type: 'json' };

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test(
  "practice exceptions - the twin reproduces core's outcome digest over the full product",
  async () => {
    const cases = enumerateCases();
    // Meta-assertion: the digest records how many cases core was run on, so a
    // shrunken product cannot match the digest of a smaller one by accident.
    assertEquals(cases.length, digest.cases);
    const outcomes = cases.map((c) => projectCase(applyPracticeExceptions as never, c));
    assertEquals(await sha256(JSON.stringify(outcomes)), digest.sha256);
  }
);

Deno.test('practice exceptions - a tail TIME TBD window shows its dates (the §2 defect)', () => {
  const out = applyPracticeExceptions({
    rows: [
      {
        id: 'pa-1',
        effective_date_range: '[2026-10-19,2026-11-03)',
        slot: { day_of_week: 'mon', start_time: '17:00:00', end_time: '18:00:00' },
      },
    ],
    exceptions: [
      {
        id: 'pe-1',
        assignment_id: 'pa-1',
        window: '[2026-11-03,2026-11-23)',
        kind: 'time_tbd',
        tbd_reason: 'past-sunset',
        cause_kind: 'daylight',
        withdrawn_at: null,
      },
    ],
  });
  // The row ends 2026-11-02; the window's Mondays are Nov 9 and Nov 16, and
  // cross the DST change without shifting a day in either host zone.
  assertEquals(
    out.occurrences.map((o) => `${o.date}:${o.kind}`),
    [
      '2026-10-19:series',
      '2026-10-26:series',
      '2026-11-02:series',
      '2026-11-09:time_tbd',
      '2026-11-16:time_tbd',
    ]
  );
  assert(out.occurrences.every((o) => o.kind !== 'time_tbd' || o.code === 'past-sunset'));
});

Deno.test('practice exceptions - a withdrawn exception is never applied', () => {
  const out = applyPracticeExceptions({
    rows: [
      {
        id: 'pa-1',
        effective_date_range: '[2026-10-19,2026-11-03)',
        slot: { day_of_week: 'mon', start_time: '17:00:00', end_time: '18:00:00' },
      },
    ],
    exceptions: [
      {
        id: 'pe-1',
        assignment_id: 'pa-1',
        window: '[2026-10-19,2026-11-03)',
        kind: 'time_tbd',
        tbd_reason: 'past-sunset',
        withdrawn_at: '2026-10-01T00:00:00Z',
      },
    ],
  });
  assertEquals(out.meta.exceptionsWithdrawn, 1);
  assertEquals(
    out.occurrences.map((o) => o.kind),
    ['series', 'series', 'series']
  );
});
