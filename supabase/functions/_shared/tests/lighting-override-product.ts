/**
 * The enumerated product both lighting-override arms are run over (8.9 D14
 * PR C, W27): core `practice/lightingOverrides.js` + `practice/daylight.js`'s
 * `lightingOverrideCovers`, and the Deno twin
 * `_shared/engines/practice-lighting-overrides.ts`.
 *
 * Two halves:
 *
 * - **covers**: every override set built from {@link WINDOWS} (none; one on
 *   slot A; two on A; one on A and one on B), each probed on both slots at
 *   every window's four boundaries -- the day before `from`, `from`, `until`,
 *   and the day after `until`. Windows cross a month end, a year end and a
 *   leap day.
 * - **rows**: every single-row combination of slot id x window spelling x
 *   kind x status, plus non-object rows, multi-row inputs and non-array
 *   inputs. Unreachable spellings (an empty window, a non-calendar date, the
 *   year 0000) are included on purpose: the arms must refuse or read them
 *   identically, whatever the table allows.
 *
 * `tests/lightingOverrideDrift.test.js` (Vitest) and `lighting-overrides_test.ts`
 * (Deno, both host zones) both import this file. Synthetic ids only.
 */

export interface OverrideInput {
  slotId: string;
  from: string;
  until: string;
}

export const SLOT_A = '00000000-0000-4000-8000-00000000000a';
export const SLOT_B = '00000000-0000-4000-8000-00000000000b';

/** Inclusive `[from, until]` windows. */
export const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['2026-09-22', '2026-09-22'], // one day
  ['2026-09-22', '2026-10-06'], // three Tuesdays
  ['2026-10-30', '2026-11-02'], // a month end
  ['2026-12-31', '2027-01-01'], // a year end
  ['2028-02-28', '2028-03-01'], // a leap day
  ['2026-11-01', '2026-11-30'], // the month after the DST change
];

/** `YYYY-MM-DD` plus `days`, on the calendar (UTC arithmetic, no host zone). */
function shift(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Every window's four boundaries, on both slots: the same probes for every case. */
export const PROBES: ReadonlyArray<readonly [string, string]> = WINDOWS.flatMap(([from, until]) =>
  [SLOT_A, SLOT_B].flatMap((slot) =>
    [shift(from, -1), from, until, shift(until, 1)].map((date) => [slot, date] as const)
  )
);

export interface CoverCase {
  id: string;
  overrides: OverrideInput[];
}

export function enumerateCoverCases(): CoverCase[] {
  const on = (slotId: string, [from, until]: readonly [string, string]) => ({
    slotId,
    from,
    until,
  });
  const cases: CoverCase[] = [{ id: 'none', overrides: [] }];
  WINDOWS.forEach((w, i) => cases.push({ id: `A${i}`, overrides: [on(SLOT_A, w)] }));
  WINDOWS.forEach((w, i) =>
    WINDOWS.forEach((v, j) => {
      if (j > i) cases.push({ id: `A${i}+A${j}`, overrides: [on(SLOT_A, w), on(SLOT_A, v)] });
    })
  );
  WINDOWS.forEach((w, i) =>
    WINDOWS.forEach((v, j) =>
      cases.push({ id: `A${i}+B${j}`, overrides: [on(SLOT_A, w), on(SLOT_B, v)] })
    )
  );
  return cases;
}

export const ROW_SLOT_IDS: readonly unknown[] = [SLOT_A, '', 42];
export const ROW_WINDOWS: readonly unknown[] = [
  '[2026-09-22,2026-10-07)',
  '[2026-12-31,2027-01-01)',
  '[2028-02-29,2028-03-01)',
  '[2026-02-27,2026-02-30)', // a non-calendar end: both arms read it as a day number
  '[2026-09-22,2026-09-22)', // empty: holds no date
  '[0000-01-01,0000-01-01)', // reopens before the year 0000
  '[2026-09-22,2026-10-07]', // not canonical
  '(2026-09-22,2026-10-07)',
  '[2026-9-22,2026-10-07)',
  '[2026-09-22, 2026-10-07)',
  null,
];
export const ROW_KINDS: readonly unknown[] = ['portable-lighting', 'floodlight', undefined];
export const ROW_STATUSES: readonly unknown[] = [
  'requested',
  'approved',
  'rejected',
  'withdrawn',
  'APPROVED',
  'superseded',
  undefined,
];

export interface RowCase {
  id: string;
  rows: unknown;
}

function row(slot: unknown, window: unknown, kind: unknown, status: unknown) {
  const r: Record<string, unknown> = { id: 'r', organization_id: 'o' };
  if (slot !== undefined) r.practice_slot_id = slot;
  if (window !== undefined) r.window = window;
  if (kind !== undefined) r.kind = kind;
  if (status !== undefined) r.status = status;
  return r;
}

export function enumerateRowCases(): RowCase[] {
  const cases: RowCase[] = [];
  ROW_SLOT_IDS.forEach((s, a) =>
    ROW_WINDOWS.forEach((w, b) =>
      ROW_KINDS.forEach((k, c) =>
        ROW_STATUSES.forEach((t, d) =>
          cases.push({ id: `row-${a}-${b}-${c}-${d}`, rows: [row(s, w, k, t)] })
        )
      )
    )
  );
  const ok = (status: string, slot = SLOT_A, window = '[2026-09-22,2026-10-07)') =>
    row(slot, window, 'portable-lighting', status);
  // Non-object rows.
  [null, 'row', [], 42].forEach((r, i) => cases.push({ id: `shape-${i}`, rows: [r] }));
  // Several rows: order kept, only approved kept, and one bad row refuses all.
  cases.push({ id: 'multi-empty', rows: [] });
  cases.push({
    id: 'multi-mixed',
    rows: [
      ok('approved'),
      ok('requested'),
      ok('approved', SLOT_B, '[2026-11-01,2026-12-01)'),
      ok('withdrawn', SLOT_B),
    ],
  });
  cases.push({
    id: 'multi-bad-rejected',
    rows: [ok('approved'), row(SLOT_A, '[2026-09-22,2026-10-07]', 'portable-lighting', 'rejected')],
  });
  // Not an array at all.
  [null, 'rows', { length: 1, 0: ok('approved') }].forEach((r, i) =>
    cases.push({ id: `input-${i}`, rows: r })
  );
  return cases;
}

export type RowOutcome = { refused: true } | { value: OverrideInput[] };

export function projectRows(convert: (rows: unknown) => OverrideInput[], c: RowCase): RowOutcome {
  try {
    return { value: convert(c.rows) };
  } catch {
    return { refused: true };
  }
}

export function projectCovers(
  covers: (overrides: OverrideInput[]) => (slotId: string, date: string) => boolean,
  c: CoverCase
): boolean[] {
  const covered = covers(c.overrides);
  return PROBES.map(([slot, date]) => covered(slot, date));
}
