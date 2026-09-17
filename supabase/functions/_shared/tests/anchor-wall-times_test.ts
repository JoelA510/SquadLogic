/**
 * The request boundary where wall times become instants (LIVE-7), and the one
 * server-side read of the season's clock.
 *
 * These two modules are what LIVE-7's fix actually rests on, and they are the
 * parts with no other coverage: the season clock itself has the vector table,
 * and `scoring-engine.ts` has `practice-coaches_test.ts`. GAP-30's lesson was
 * that twelve positive controls all aimed at the composer left the reporting
 * layer shipping a 66 KB paragraph -- "choosing what to break is the
 * judgement". So these aim at the anchor pass and the query shape, not at the
 * arithmetic.
 *
 * `readSeasonTimezone` is exercised against a recording fake rather than a
 * database. That is not a weaker test of the thing that matters: the defect it
 * exists to prevent is a WRONG QUERY -- `.single()` erroring on an organization
 * with two seasons and falling through to a hardcoded zone -- and a fake is how
 * you assert the query, where a live row only asserts the answer for whatever
 * data you happened to seed.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.203.0/assert/mod.ts';
import { anchorWallTimes, describeAnchorFailure, toInstant } from '../timing/anchorWallTimes.ts';
import {
  readSeasonTimezone,
  type SeasonSettingsQuery,
  type SeasonSettingsReader,
} from '../timing/seasonSettings.ts';

const NY = 'America/New_York';

// ---------------------------------------------------------------------------
// toInstant — what counts as an instant on the edge
// ---------------------------------------------------------------------------

Deno.test('toInstant - refuses exactly what packages/core InstantSchema refuses', () => {
  // A zone-carrying string, a Date and an epoch number are instants.
  assertEquals(
    toInstant('2026-11-07T16:44:00-05:00').date?.toISOString(),
    '2026-11-07T21:44:00.000Z'
  );
  assertEquals(toInstant('2026-11-07T21:44:00Z').date?.toISOString(), '2026-11-07T21:44:00.000Z');
  assertEquals(toInstant(new Date(0)).date?.getTime(), 0);
  assertEquals(toInstant(0).date?.getTime(), 0);

  // A naive wall date-time is NOT, even though `new Date()` would happily
  // read it in the host's zone. That read is the whole defect.
  assertEquals(toInstant('2026-11-07T16:44:00').date, null);
  assertEquals(toInstant('2026-11-07T16:44:00').code, 'SEASON_TIMEZONE_MISSING');
  // The Postgres `timestamp without time zone` spelling is just as zone-less.
  assertEquals(toInstant('2026-11-07 16:44:00').date, null);
  // And neither is a bare calendar date: `new Date('2026-11-07')` is spec'd as
  // UTC midnight, so it does not fail -- it silently acquires a zone.
  assertEquals(toInstant('2026-11-07').date, null);

  // Garbage is garbage.
  assertEquals(toInstant('').code, 'WALL_TIME_UNREADABLE');
  assertEquals(toInstant('not a time').code, 'WALL_TIME_UNREADABLE');
  assertEquals(toInstant(new Date('nope')).code, 'WALL_TIME_UNREADABLE');
  assertEquals(toInstant(Number.NaN).code, 'WALL_TIME_UNREADABLE');
  assertEquals(toInstant(null).code, 'WALL_TIME_UNREADABLE');
});

// ---------------------------------------------------------------------------
// anchorWallTimes — the pass itself
// ---------------------------------------------------------------------------

const slot = (id: string, start: unknown, end: unknown) => ({ id, start, end, capacity: 1 });

Deno.test('anchorWallTimes - composes a naive wall reading on the season clock', () => {
  const result = anchorWallTimes(
    [slot('s1', '2026-11-07T16:44:00', '2026-11-07T18:14:00')],
    NY,
    'slots'
  );
  assertEquals(result.blocking.length, 0);
  assertEquals(result.rows.length, 1);
  assertEquals(result.rows[0].start.toISOString(), '2026-11-07T21:44:00.000Z');
  assertEquals(result.rows[0].end.toISOString(), '2026-11-07T23:14:00.000Z');
});

Deno.test('anchorWallTimes - the host zone is not an input', () => {
  // The control that matters: the CI job runs this file under TZ=UTC and
  // TZ=America/Los_Angeles, and the expectation above is an absolute instant.
  // Here we prove the naive value genuinely WOULD move, so the assertion is
  // not vacuous under either host.
  const hostRead = new Date('2026-11-07T16:44:00').toISOString();
  const composed = anchorWallTimes(
    [slot('s1', '2026-11-07T16:44:00', '2026-11-07T18:14:00')],
    NY,
    'slots'
  ).rows[0].start.toISOString();
  assertEquals(composed, '2026-11-07T21:44:00.000Z');
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  console.log(`[anchor] host ${hostZone}: new Date(naive) = ${hostRead}; composed = ${composed}`);
});

Deno.test('anchorWallTimes - an instant already on the wire passes through untouched', () => {
  const result = anchorWallTimes(
    [slot('s1', '2026-11-07T21:44:00Z', new Date('2026-11-07T23:14:00Z'))],
    NY,
    'slots'
  );
  assertEquals(result.blocking.length, 0);
  assertEquals(result.rows[0].start.toISOString(), '2026-11-07T21:44:00.000Z');
  assertEquals(result.rows[0].end.toISOString(), '2026-11-07T23:14:00.000Z');
});

Deno.test('anchorWallTimes - no season timezone refuses every naive row, by name', () => {
  const result = anchorWallTimes(
    [
      slot('s1', '2026-11-07T16:44:00', '2026-11-07T18:14:00'),
      slot('s2', '2026-11-08T16:44:00', '2026-11-08T18:14:00'),
    ],
    null,
    'slots'
  );
  assertEquals(result.rows.length, 0);
  assertEquals(result.blocking.length, 4); // start and end of each row
  assertEquals(new Set(result.blocking.map((f) => f.code)).size, 1);
  assertEquals(result.blocking[0].code, 'SEASON_TIMEZONE_MISSING');
  assertEquals(result.blocking[0].path, 'slots[0].start');
  assertEquals(result.blocking[0].id, 's1');
});

Deno.test('anchorWallTimes - a spring-forward slot refuses; its neighbours do not', () => {
  // Per row, never per request: one unplaceable slot must not cost the other
  // four hundred. This is the case the whole `rows`/`blocking` split exists for.
  const result = anchorWallTimes(
    [
      slot('gap', '2026-03-08T02:30:00', '2026-03-08T04:00:00'),
      slot('fine', '2026-03-08T09:00:00', '2026-03-08T10:30:00'),
    ],
    NY,
    'slots'
  );
  assertEquals(
    result.rows.map((r) => r.id),
    ['fine']
  );
  assertEquals(result.blocking[0].code, 'WALL_TIME_NONEXISTENT');
  assertEquals(result.blocking[0].id, 'gap');
});

Deno.test('anchorWallTimes - an ambiguous wall time is REPORTED, and still placed', () => {
  // WALL_TIME_AMBIGUOUS is informational: an instant is composed (the first of
  // the two occurrences) and the finding rides along. A pass that swallowed it
  // would look identical on `rows` alone, which is why this asserts both.
  const result = anchorWallTimes(
    [slot('fallback', '2026-11-01T01:30:00', '2026-11-01T03:00:00')],
    NY,
    'slots'
  );
  assertEquals(result.blocking.length, 0);
  assertEquals(result.rows.length, 1);
  // 01:30 EDT, the FIRST occurrence: 05:30Z, not 06:30Z.
  assertEquals(result.rows[0].start.toISOString(), '2026-11-01T05:30:00.000Z');
  assertEquals(
    result.findings.map((f) => f.code),
    ['WALL_TIME_AMBIGUOUS']
  );
});

Deno.test('anchorWallTimes - a bare calendar date is refused, not read as UTC midnight', () => {
  const result = anchorWallTimes([slot('s1', '2026-11-07', '2026-11-08')], NY, 'slots');
  assertEquals(result.rows.length, 0);
  assertEquals(result.blocking[0].code, 'SEASON_TIMEZONE_MISSING');
});

Deno.test('describeAnchorFailure - collapses by code and caps the detail', () => {
  // A season with no timezone makes every slot unplaceable, so this IS the
  // normal shape of the failure. The GAP-30 review found the equivalent
  // reporting layer emitting one line per slot and 66,797 characters.
  const rows = Array.from({ length: 400 }, (_, i) =>
    slot(
      `s${i}`,
      `2026-11-${String((i % 28) + 1).padStart(2, '0')}T16:44:00`,
      `2026-11-${String((i % 28) + 1).padStart(2, '0')}T18:14:00`
    )
  );
  const result = anchorWallTimes(rows, null, 'slots');
  assertEquals(result.blocking.length, 800);

  const failure = describeAnchorFailure(result.blocking);
  assertEquals(failure.code, 'SEASON_TIMEZONE_MISSING');
  assertEquals(failure.byCode, { SEASON_TIMEZONE_MISSING: 800 });
  assertEquals(failure.findings.length, 20, 'the detail array must be capped');
  assert(
    failure.error.length < 300,
    `the error sentence grew with the season: ${failure.error.length}`
  );
  assertStringIncludes(failure.error, 'no timezone set');
});

// ---------------------------------------------------------------------------
// readSeasonTimezone — the query, not the answer
// ---------------------------------------------------------------------------

interface RecordedCall {
  table: string | null;
  columns: string | null;
  eq: Array<[string, string]>;
  order: Array<[string, { ascending: boolean }]>;
  limit: number | null;
}

/** A recording stand-in for the PostgREST builder. */
function fakeReader(answer: {
  data: { timezone?: unknown } | null;
  error: { message?: string } | null;
}): { reader: SeasonSettingsReader; calls: RecordedCall } {
  const calls: RecordedCall = { table: null, columns: null, eq: [], order: [], limit: null };
  const query: SeasonSettingsQuery = {
    eq(column, value) {
      calls.eq.push([column, value]);
      return query;
    },
    order(column, options) {
      calls.order.push([column, options]);
      return query;
    },
    limit(count) {
      calls.limit = count;
      return query;
    },
    maybeSingle() {
      return Promise.resolve(answer);
    },
  };
  const reader: SeasonSettingsReader = {
    from(table) {
      calls.table = table;
      return {
        select(columns) {
          calls.columns = columns;
          return query;
        },
      };
    },
  };
  return { reader, calls };
}

Deno.test('readSeasonTimezone - newest season for the org, never .single()', () => {
  // `.single()` errors when an organization has more than one season_settings
  // row, and in calendar-feed that error was swallowed into `settings: null`
  // and fell through to a hardcoded America/New_York. The query shape IS the
  // fix, so the query shape is what is asserted.
  const { reader, calls } = fakeReader({ data: { timezone: 'America/Chicago' }, error: null });
  return readSeasonTimezone(reader, 'org-1').then((result) => {
    assertEquals(result, { timezone: 'America/Chicago', errored: false, message: null });
    assertEquals(calls.table, 'season_settings');
    assertStringIncludes(calls.columns ?? '', 'timezone');
    assertEquals(calls.eq, [['organization_id', 'org-1']]);
    assertEquals(calls.order, [['created_at', { ascending: false }]]);
    assertEquals(calls.limit, 1);
  });
});

Deno.test('readSeasonTimezone - a named season is STILL scoped by organization', () => {
  // An id arriving in a request body is not a capability, and this runs under
  // the service role. Dropping the organization filter here would be an IDOR.
  const { reader, calls } = fakeReader({ data: { timezone: 'Europe/London' }, error: null });
  return readSeasonTimezone(reader, 'org-1', 'season-9').then(() => {
    assertEquals(calls.eq, [
      ['organization_id', 'org-1'],
      ['id', 'season-9'],
    ]);
    // No ordering when a specific season is named — there is nothing to rank.
    assertEquals(calls.order, []);
    assertEquals(calls.limit, 1);
  });
});

Deno.test('readSeasonTimezone - a null column is a real answer, not an error', () => {
  const { reader } = fakeReader({ data: { timezone: null }, error: null });
  return readSeasonTimezone(reader, 'org-1').then((result) => {
    assertEquals(result.timezone, null);
    assertEquals(result.errored, false, 'a season with no clock is not a failed read');
  });
});

Deno.test('readSeasonTimezone - blank and whitespace are not a timezone', () => {
  const { reader } = fakeReader({ data: { timezone: '   ' }, error: null });
  return readSeasonTimezone(reader, 'org-1').then((result) => assertEquals(result.timezone, null));
});

Deno.test('readSeasonTimezone - a failed read is distinguishable from an empty one', () => {
  // The distinction the caller branches on: `errored` returns 503 and asks the
  // operator to retry; `timezone: null` returns 422 and asks them to set it.
  // Collapsing the two is how a transient outage reads as a misconfigured club.
  const { reader } = fakeReader({ data: null, error: { message: 'boom' } });
  return readSeasonTimezone(reader, 'org-1').then((result) => {
    assertEquals(result, { timezone: null, errored: true, message: 'boom' });
  });
});

Deno.test('readSeasonTimezone - no organization means no query at all', () => {
  const { reader, calls } = fakeReader({ data: { timezone: 'UTC' }, error: null });
  return readSeasonTimezone(reader, null).then((result) => {
    assertEquals(result.timezone, null);
    assertEquals(calls.table, null, 'queried season_settings without an organization');
  });
});
