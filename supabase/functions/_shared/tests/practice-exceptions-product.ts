/**
 * The enumerated product both practice-exception arms are run over (8.6 3b
 * PR 12a, plan §5, W9): core `utils/practiceExceptions.js` and the Deno twin
 * `_shared/calendar/practiceExceptions.ts`.
 *
 * The product is kind x window position x withdrawn x relocated slot x one or
 * two live windows x one row or a row with a successor, over two ranges that
 * each cross a DST change. Positions are relative to the row's own range:
 * before it, overlapping its start, inside, the whole range, reaching its end,
 * a tail after it, an open upper and an unreadable lower. Kinds include one
 * outside the table's CHECK and withdrawn includes a missing key, on purpose:
 * the arms must read unreachable spellings identically too.
 *
 * `tests/practiceExceptionsDrift.test.js` (Vitest) and
 * `practice-exceptions_test.ts` (Deno, both host zones) both import this
 * file. Synthetic ids and names only.
 */

/** `YYYY-MM-DD` plus `days`, on the calendar (UTC arithmetic, no host zone). */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A canonical `[first, last + 1)` daterange literal from inclusive dates. */
const literal = (first: string, last: string) => `[${first},${shift(last, 1)})`;

const ROW = 'pa-0001';
const NEXT_ROW = 'pa-0002';

const slot = (day: string, start: string, ground: string) => ({
  day_of_week: day,
  start_time: start,
  end_time: '19:00:00',
  field: { name: ground, location: { name: 'Synthetic Park' } },
});
const ROW_SLOT = slot('tue', '17:30:00', 'Field 1');

/** Inclusive `[first, last]` row ranges; each crosses a DST change. */
export const RANGES: ReadonlyArray<readonly [string, string]> = [
  ['2026-10-19', '2026-11-16'], // autumn: crosses 2026-11-01
  ['2027-03-01', '2027-03-22'], // spring: crosses 2027-03-14
];

export const WINDOW_POSITIONS: ReadonlyArray<string> = [
  'before',
  'overlap-start',
  'inside',
  'whole',
  'reaching-end',
  'tail',
  'open-upper',
  'unreadable',
];

function windowAt(position: string, [first, last]: readonly [string, string]): string {
  switch (position) {
    case 'before':
      return literal(shift(first, -21), shift(first, -8));
    case 'overlap-start':
      return literal(shift(first, -7), shift(first, 7));
    case 'inside':
      return literal(shift(first, 7), shift(first, 14));
    case 'whole':
      return literal(first, last);
    case 'reaching-end':
      return literal(shift(first, 14), last);
    case 'tail':
      return literal(shift(last, 1), shift(last, 21));
    case 'open-upper':
      return `[${shift(first, 7)},)`;
    default:
      return `(,${shift(first, 7)})`;
  }
}

export const KINDS: readonly string[] = ['relocated', 'time_tbd', 'cancelled'];

export const RELOCATED_SLOTS: ReadonlyArray<readonly [string, unknown]> = [
  ['same-weekday', slot('tue', '18:00:00', 'Field 2')],
  ['other-weekday', slot('thu', '16:00:00', 'Field 3')],
  ['slot-missing', null],
  ['day-unreadable', slot('funday', '16:00:00', 'Field 3')],
];

export const WITHDRAWN: readonly string[] = ['live', 'withdrawn', 'key-absent'];
export const MULTIPLICITY: readonly number[] = [1, 2];
export const ROWSETS: readonly string[] = ['one-row', 'with-successor'];

function exception(
  id: string,
  window: string,
  kind: string,
  relocated: unknown,
  withdrawn: string
): Record<string, unknown> {
  const e: Record<string, unknown> = {
    id,
    assignment_id: ROW,
    window,
    kind,
    practice_slot_id: kind === 'relocated' ? 'ps-relocated' : null,
    tbd_reason: kind === 'relocated' ? null : 'past-sunset',
    cause_kind: kind === 'relocated' ? 'blackout' : 'daylight',
    slot: kind === 'relocated' ? relocated : null,
  };
  if (withdrawn === 'live') e.withdrawn_at = null;
  if (withdrawn === 'withdrawn') e.withdrawn_at = '2026-10-01T12:00:00Z';
  return e;
}

function rowsFor(range: readonly [string, string], rowset: string) {
  const rows: Record<string, unknown>[] = [
    { id: ROW, effective_date_range: literal(range[0], range[1]), slot: ROW_SLOT },
  ];
  if (rowset === 'with-successor') {
    rows.push({
      id: NEXT_ROW,
      effective_date_range: literal(shift(range[1], 1), shift(range[1], 29)),
      slot: slot('tue', '17:00:00', 'Field 4'),
    });
  }
  return rows;
}

export interface ExceptionCase {
  id: string;
  input: unknown;
}

export function enumerateCases(): ExceptionCase[] {
  const cases: ExceptionCase[] = [];
  RANGES.forEach((range, r) =>
    ROWSETS.forEach((rowset) => {
      cases.push({
        id: `zero-${r}-${rowset}`,
        input: { rows: rowsFor(range, rowset), exceptions: [] },
      });
      WINDOW_POSITIONS.forEach((position) =>
        KINDS.forEach((kind) =>
          RELOCATED_SLOTS.forEach(([slotName, relocated]) =>
            WITHDRAWN.forEach((withdrawn) =>
              MULTIPLICITY.forEach((count) => {
                const exceptions = [
                  exception('pe-1', windowAt(position, range), kind, relocated, withdrawn),
                ];
                if (count === 2) {
                  // A second live window, always the same: it overlaps some
                  // positions and not others.
                  exceptions.push(
                    exception(
                      'pe-2',
                      literal(shift(range[0], 10), shift(range[0], 24)),
                      'time_tbd',
                      null,
                      'live'
                    )
                  );
                }
                cases.push({
                  id: [r, rowset, position, kind, slotName, withdrawn, count].join('-'),
                  input: { rows: rowsFor(range, rowset), exceptions },
                });
              })
            )
          )
        )
      );
    })
  );
  const range = RANGES[0];
  const live = (window: string) => exception('pe-x', window, 'time_tbd', null, 'live');
  // A partial read: the exception names a row that was not read.
  cases.push({
    id: 'extra-row-unread',
    input: {
      rows: rowsFor(range, 'one-row'),
      exceptions: [{ ...live(literal(range[0], range[1])), assignment_id: 'pa-9999' }],
    },
  });
  // Entries that are not objects.
  cases.push({
    id: 'extra-non-object',
    input: { rows: rowsFor(range, 'one-row'), exceptions: [null, 'x', []] },
  });
  // Rows the series itself refuses, each with a live window.
  for (const [name, row] of [
    ['slot-missing', { id: ROW, effective_date_range: literal(range[0], range[1]), slot: null }],
    ['range-unreadable', { id: ROW, effective_date_range: '[2026-10-19,)', slot: ROW_SLOT }],
    [
      'day-unreadable',
      {
        id: ROW,
        effective_date_range: literal(range[0], range[1]),
        slot: slot('x', '17:00:00', 'Field 1'),
      },
    ],
    ['not-an-object', 7],
  ] as const) {
    cases.push({
      id: `extra-${name}`,
      input: { rows: [row], exceptions: [live(literal(range[0], range[1]))] },
    });
  }
  // A readable lower bound with a corrupt (reversed) upper: suppressed, and
  // worded as unreadable rather than "no end date".
  cases.push({
    id: 'extra-reversed-upper',
    input: {
      rows: rowsFor(range, 'one-row'),
      exceptions: [live(`[${shift(range[0], 7)},${shift(range[0], 1)})`)],
    },
  });
  // An `infinity` upper bound is as open as an absent one.
  cases.push({
    id: 'extra-infinity-upper',
    input: {
      rows: rowsFor(range, 'one-row'),
      exceptions: [live(`[${shift(range[0], 7)},infinity)`)],
    },
  });
  // Tuesdays 1 and 8 days in move to Monday: two removed, one added.
  cases.push({
    id: 'extra-relocation-unmatched',
    input: {
      rows: rowsFor(range, 'one-row'),
      exceptions: [
        exception(
          'pe-x',
          literal(shift(range[0], 1), shift(range[0], 8)),
          'relocated',
          slot('mon', '16:00:00', 'Field 3'),
          'live'
        ),
      ],
    },
  });
  // A row with no id, and an exception naming no row: never matched.
  cases.push({
    id: 'extra-no-ids',
    input: {
      rows: [{ effective_date_range: literal(range[0], range[1]), slot: ROW_SLOT }],
      exceptions: [{ ...live(literal(range[0], range[1])), assignment_id: undefined }],
    },
  });
  // Non-array inputs: both arms refuse.
  cases.push({ id: 'extra-rows-not-array', input: { rows: null, exceptions: [] } });
  cases.push({ id: 'extra-exceptions-not-array', input: { rows: [], exceptions: 'x' } });
  return cases;
}

export type Outcome = { refused: true } | { value: unknown };

export function projectCase(apply: (input: never) => unknown, c: ExceptionCase): Outcome {
  try {
    return { value: apply(c.input as never) };
  } catch {
    return { refused: true };
  }
}
