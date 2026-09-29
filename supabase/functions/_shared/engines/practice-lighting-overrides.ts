/**
 * Approved portable-lighting overrides, loaded server-side for one
 * auto-scheduler run (8.9 D14 PR C; plan "Override design", W23-W28).
 *
 * ## Where they come from
 *
 * `practice_lighting_overrides` (`20261003000000_practice_lighting_overrides.sql`),
 * read by {@link loadLightingOverrides} AS THE CALLER through RLS
 * (`createUserClient`), paged, never with the service role and never from the
 * request body (W25): nothing here takes a body. A body that claims lighting,
 * or carries a `lightingOverrides` key, is read by nobody.
 *
 * **A failed read refuses the run (W26).** An error on any page is
 * `LIGHTING_OVERRIDES_UNREADABLE`, never an empty list: an empty list would
 * run as if no override existed, which is exactly the silent outcome a
 * refusal exists to prevent. A row the reader cannot parse refuses the run the
 * same way (core's converter throws on one; so does this twin).
 *
 * **A partial read fails safe, so it does not refuse.** RLS lets an org admin
 * read every row and a coach only the rows on slots they coach, so a coach's
 * run can see a subset. Unlike a coach PREFERENCE (a constraint, where a
 * missing row lets the run break a promise -- hence that loader's
 * service-role count and its 403), an override only ever REMOVES a
 * restriction: a row the caller cannot see leaves its dates judged against
 * sunset as if unlit, and truncated to TIME TBD where they are past it. The
 * run can therefore come out stricter than the data allows, never looser --
 * no practice is ever kept past sunset because of an override the caller did
 * not see. `tests/autoSchedulerDaylight.test.js` holds this direction (a
 * subset of the rows exempts a subset of the dates).
 *
 * ## The twins (W27)
 *
 * {@link approvedLightingOverridesFromRows} and {@link lightingOverrideCovers}
 * are the Deno twins of core `practice/lightingOverrides.js` and
 * `practice/daylight.js`'s cover predicate: the same row contract (the table's
 * `status`/`kind` vocabulary, a canonical `[from,end)` window, only
 * `approved` exempting anything) and the same inclusive `[from, until]`
 * reading. `tests/lightingOverrideDrift.test.js` runs both arms over one
 * enumerated product and holds the committed digest; `lighting-overrides_test.ts`
 * holds this twin to that digest under Deno, in both host zones.
 *
 * Import-free apart from its siblings, so Vitest can execute it directly.
 */
import { LOCK_PAGE_SIZE, readAllPages, type QueryResult } from './practice-lock.ts';

/** Core `PRACTICE_LIGHTING_OVERRIDE_STATUS`, spelled identically (the drift test compares). */
export const LIGHTING_OVERRIDE_STATUS = Object.freeze({
  REQUESTED: 'requested',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
} as const);

/** Core `PRACTICE_LIGHTING_OVERRIDE_KIND`: the table's one kind. */
export const LIGHTING_OVERRIDE_KIND = 'portable-lighting';

/** An approved window on one slot, both dates INCLUSIVE (core's `lightingOverrides` input). */
export interface LightingOverride {
  slotId: string;
  from: string;
  until: string;
}

const CANONICAL_WINDOW = /^\[\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}\)$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES: readonly string[] = Object.values(LIGHTING_OVERRIDE_STATUS);

// Core `facility/eligibility.js`'s civil-calendar day numbers, ported exactly
// so an out-of-range spelling reads the same in both arms.
function isoDayNumber(iso: string): number {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function isoDateOfDayNumber(dayNumber: number): string {
  const shifted = dayNumber + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365
  );
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const civilYear = year + (month <= 2 ? 1 : 0);
  return `${String(civilYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Why a row was refused: the row contract core's schema enforces. */
function rowProblem(row: unknown): string | null {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return 'not an object';
  const r = row as Record<string, unknown>;
  if (typeof r.practice_slot_id !== 'string' || r.practice_slot_id.length === 0) {
    return 'practice_slot_id is not a non-empty string';
  }
  if (typeof r.window !== 'string' || !CANONICAL_WINDOW.test(r.window)) {
    return 'window is not a canonical bounded daterange `[from,end)`';
  }
  if (r.kind !== LIGHTING_OVERRIDE_KIND) return `kind is not '${LIGHTING_OVERRIDE_KIND}'`;
  if (typeof r.status !== 'string' || !STATUSES.includes(r.status)) return 'status is unknown';
  return null;
}

/**
 * `practice_lighting_overrides` rows -> the `lightingOverrides` input, the twin
 * of core `approvedLightingOverridesFromRows`. Every row is checked first (one
 * malformed row throws, whatever its status); then only `approved` rows are
 * kept (W24), whatever the caller selected, and each window's exclusive end
 * becomes the inclusive `until`.
 *
 * @throws {TypeError} when `rows` is not an array
 * @throws {Error} when a row breaks the row contract, or its window reopens to nothing
 */
export function approvedLightingOverridesFromRows(rows: readonly unknown[]): LightingOverride[] {
  if (!Array.isArray(rows)) {
    throw new TypeError('approvedLightingOverridesFromRows requires an array of rows');
  }
  rows.forEach((row, index) => {
    const problem = rowProblem(row);
    if (problem) throw new Error(`practice_lighting_overrides row ${index}: ${problem}`);
  });
  return (rows as Array<Record<string, string>>)
    .filter((row) => row.status === LIGHTING_OVERRIDE_STATUS.APPROVED)
    .map((row) => {
      const [from, end] = row.window.slice(1, -1).split(',');
      const until = isoDateOfDayNumber(isoDayNumber(end) - 1);
      if (!ISO_DATE_PATTERN.test(until) || until < from) {
        throw new Error(`practice_lighting_overrides window ${row.window} holds no date`);
      }
      return { slotId: row.practice_slot_id, from, until };
    });
}

/**
 * The twin of core `lightingOverrideCovers`: `(slotId, date) => boolean`, true
 * when an override on that slot covers the date, `[from, until]` inclusive.
 */
export function lightingOverrideCovers(
  overrides: readonly LightingOverride[] | undefined
): (slotId: string, date: string) => boolean {
  const bySlot = new Map<string, Array<{ from: string; until: string }>>();
  for (const { slotId, from, until } of overrides ?? []) {
    const list = bySlot.get(slotId) ?? [];
    list.push({ from, until });
    bySlot.set(slotId, list);
  }
  return (slotId, date) =>
    (bySlot.get(slotId) ?? []).some((window) => window.from <= date && date <= window.until);
}

// ---------------------------------------------------------------------------
// Loading, as the caller
// ---------------------------------------------------------------------------

interface OverrideQuery {
  eq(column: string, value: unknown): OverrideQuery;
  order(column: string, options?: { ascending?: boolean }): OverrideQuery;
  range(from: number, to: number): PromiseLike<QueryResult>;
}
export interface OverrideReader {
  from(table: string): { select(columns: string): OverrideQuery };
}

export type LightingOverrideLoad =
  | {
      ok: true;
      /** The approved overrides on the run's slots. */
      overrides: LightingOverride[];
      /** Approved rows the caller's read returned, the run's slots or not. */
      rowsLoaded: number;
    }
  | { ok: false; code: 'LIGHTING_OVERRIDES_UNREADABLE'; message: string };

/**
 * The organisation's approved `practice_lighting_overrides`, read through
 * `client` -- the USER-scoped client, so RLS decides -- page by page, and kept
 * for the run's slots. Refuses (never an empty list) when a page fails or a
 * row cannot be read.
 */
export async function loadLightingOverrides(
  client: OverrideReader,
  params: { organizationId: string; slotIds: readonly string[]; pageSize?: number }
): Promise<LightingOverrideLoad> {
  const { organizationId, pageSize = LOCK_PAGE_SIZE } = params;
  const read = await readAllPages(
    () =>
      client
        .from('practice_lighting_overrides')
        .select('practice_slot_id, window, kind, status')
        .eq('organization_id', organizationId)
        .eq('status', LIGHTING_OVERRIDE_STATUS.APPROVED)
        .order('id', { ascending: true }),
    pageSize
  );
  if (read.error) {
    return {
      ok: false,
      code: 'LIGHTING_OVERRIDES_UNREADABLE',
      message: `practice_lighting_overrides: ${read.error}`,
    };
  }
  let approved: LightingOverride[];
  try {
    // The status filter above is the store's; this one is the rule's (W24).
    approved = approvedLightingOverridesFromRows(read.rows);
  } catch (error) {
    return {
      ok: false,
      code: 'LIGHTING_OVERRIDES_UNREADABLE',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const runSlots = new Set(params.slotIds);
  return {
    ok: true,
    overrides: approved.filter((override) => runSlots.has(override.slotId)),
    rowsLoaded: approved.length,
  };
}
