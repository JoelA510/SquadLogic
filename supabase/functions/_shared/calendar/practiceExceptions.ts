/**
 * The Deno twin of core `utils/practiceExceptions.js` (8.6 3b PR 12a,
 * `docs/PHASE_8_6_PR12_READERS_PLAN.md` §3, §5): one team's stored practice
 * rows plus the exceptions read for them, in; dated practices, undated TIME
 * TBD entries and findings, out.
 *
 * **Import-free on purpose.** The Edge runtime cannot import the core package,
 * so the rules, the `daterange` reading and the day arithmetic are restated
 * here. `tests/practiceExceptionsDrift.test.js` (Vitest) runs this file and
 * core over an enumerated product and holds both to the committed digest
 * `_shared/tests/practice-exceptions-product.digest.json`;
 * `_shared/tests/practice-exceptions_test.ts` holds this file to the same
 * digest in Deno, under two host zones (`scripts/deno-mirror-tests.sh`).
 *
 * The rules are core's and are documented there; the comments below only
 * name which rule a block restates. **No `Date` is constructed** (GAP-30):
 * wall dates in, wall dates out.
 *
 * Not yet imported by `icsFeed.ts`: the feed adopts it in PR 12b.
 *
 * @module _shared/calendar/practiceExceptions
 */

/** `day_of_week` enum, indexed from Sunday (core `DAY_OF_WEEK_ENUM`). */
const DAY_OF_WEEK_ENUM: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_LITERAL = /^([[(])([^,]*),([^,]*)([\])])$/;

/** Core `PRACTICE_OCCURRENCE_REFUSAL`, and the feed's codes of the same names. */
export const PRACTICE_OCCURRENCE_REFUSAL = Object.freeze({
  SLOT_MISSING: 'PRACTICE_SLOT_MISSING',
  RANGE_UNREADABLE: 'PRACTICE_RANGE_UNREADABLE',
  DAY_UNREADABLE: 'PRACTICE_DAY_UNREADABLE',
});

/** The `kind` CHECK of `practice_exceptions`. */
export const PRACTICE_EXCEPTION_KIND = Object.freeze({
  RELOCATED: 'relocated',
  TIME_TBD: 'time_tbd',
});

/** The `tbd_reason` CHECK (core `PRACTICE_EXCEPTION_TBD_REASONS`). */
export const PRACTICE_EXCEPTION_TBD_REASONS: readonly string[] = Object.freeze([
  'no-legal-slot-at-venue',
  'contended',
  'change-budget',
  'objective-preferred-tbd',
  'coach-preference',
  'declined',
  'past-sunset',
  'sunset-unknown',
]);

/** Core `PRACTICE_EXCEPTION_CODE`. */
export const PRACTICE_EXCEPTION_CODE = Object.freeze({
  WINDOW_OPEN: 'PRACTICE_EXCEPTION_WINDOW_OPEN',
  WINDOW_UNREADABLE: 'PRACTICE_EXCEPTION_WINDOW_UNREADABLE',
  CONFLICT: 'PRACTICE_EXCEPTION_CONFLICT',
  UNREADABLE: 'PRACTICE_EXCEPTION_UNREADABLE',
  ROW_UNREAD: 'PRACTICE_EXCEPTION_ROW_UNREAD',
  TBD_SHADOWED: 'PRACTICE_TBD_SHADOWED',
  ROW_REFUSED: 'PRACTICE_EXCEPTION_ROW_REFUSED',
  RELOCATION_UNMATCHED: 'PRACTICE_EXCEPTION_RELOCATION_UNMATCHED',
});

// A PostgREST row: its fields are read, never trusted, by the rules below.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

export interface PracticeExceptionsResult {
  occurrences: Rec[];
  undated: Array<{ assignmentId: unknown; exceptionId: unknown; code: string }>;
  findings: Array<{ code: string; assignmentId: unknown; exceptionId: unknown; date?: string }>;
  meta: {
    rowsRead: number;
    exceptionsRead: number;
    exceptionsLive: number;
    exceptionsWithdrawn: number;
    exceptionsApplied: number;
    datesSuppressed: number;
  };
}

/** Days since 1970-01-01 of a `YYYY-MM-DD` (core `facility/eligibility.js` `isoDayNumber`). */
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

/** The inverse (core `isoDateOfDayNumber`). */
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

/** Core `practiceRangeBounds`. */
export function practiceRangeBounds(range: unknown): { first: string; last: string } | null {
  const match = RANGE_LITERAL.exec(String(range ?? '').trim());
  if (match === null) return null;
  const lower = match[2].trim();
  const upper = match[3].trim();
  if (!ISO_DATE.test(lower) || !ISO_DATE.test(upper)) return null;
  const first = isoDayNumber(lower) + (match[1] === '[' ? 0 : 1);
  const last = isoDayNumber(upper) - (match[4] === ']' ? 0 : 1);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return null;
  return { first: isoDateOfDayNumber(first), last: isoDateOfDayNumber(last) };
}

/** Core `practiceRangeLowerBound`. */
export function practiceRangeLowerBound(
  range: unknown
): { first: string; upperUnbounded: boolean } | null {
  const match = RANGE_LITERAL.exec(String(range ?? '').trim());
  if (match === null) return null;
  const lower = match[2].trim();
  if (!ISO_DATE.test(lower)) return null;
  const first = isoDayNumber(lower) + (match[1] === '[' ? 0 : 1);
  if (!Number.isFinite(first)) return null;
  const upper = match[3].trim().toLowerCase();
  return { first: isoDateOfDayNumber(first), upperUnbounded: upper === '' || upper === 'infinity' };
}

/** Core `practiceOccurrenceDates`. */
function practiceOccurrenceDates(
  range: unknown,
  dayOfWeek: unknown
): { dates: string[]; refusal: string | null } {
  const bounds = practiceRangeBounds(range);
  if (bounds === null) return { dates: [], refusal: PRACTICE_OCCURRENCE_REFUSAL.RANGE_UNREADABLE };
  const index = DAY_OF_WEEK_ENUM.indexOf(String(dayOfWeek ?? '').toLowerCase());
  if (index < 0) return { dates: [], refusal: PRACTICE_OCCURRENCE_REFUSAL.DAY_UNREADABLE };
  let n = isoDayNumber(bounds.first);
  // Day 0 (1970-01-01) is a Thursday, index 4.
  while ((((n + 4) % 7) + 7) % 7 !== index) n += 1;
  const dates: string[] = [];
  const lastDay = isoDayNumber(bounds.last);
  for (; n <= lastDay; n += 7) dates.push(isoDateOfDayNumber(n));
  return { dates, refusal: null };
}

const isRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const dayReads = (day: unknown): boolean =>
  DAY_OF_WEEK_ENUM.includes(String(day ?? '').toLowerCase());
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const key = (value: unknown): string => String(value ?? '');

function weekdayDates(day: unknown, first: string, last: string): string[] {
  if (first > last) return [];
  return practiceOccurrenceDates(`[${first},${last}]`, day).dates;
}

interface Claim {
  exceptionId: unknown;
  causeKind: unknown;
  unreadableWindow: boolean;
  first: string;
  last: string | null;
  effect: 'open' | 'tbd' | 'relocated';
  code?: string;
  slot?: Rec;
  dates: string[];
}

function readClaim(exception: Rec, bounds: { first: string; last: string }, rowDay: unknown) {
  const exceptionId = exception.id ?? null;
  const causeKind = exception.cause_kind ?? null;
  const whole = practiceRangeBounds(exception.window);
  const lower = whole ? null : practiceRangeLowerBound(exception.window);
  if (whole === null && lower === null) {
    return { exceptionId, causeKind, unreadableWindow: true } as const;
  }
  const first = whole ? whole.first : (lower as { first: string }).first;
  const last = whole ? whole.last : null;
  const claim = { exceptionId, causeKind, unreadableWindow: false, first, last };
  if (last === null) {
    const code = (lower as { upperUnbounded: boolean }).upperUnbounded
      ? PRACTICE_EXCEPTION_CODE.WINDOW_OPEN
      : PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE;
    return { ...claim, effect: 'open', code, dates: [] } as Claim;
  }

  const kind = exception.kind;
  const readable =
    'withdrawn_at' in exception &&
    (kind === PRACTICE_EXCEPTION_KIND.RELOCATED ||
      (kind === PRACTICE_EXCEPTION_KIND.TIME_TBD &&
        PRACTICE_EXCEPTION_TBD_REASONS.includes(exception.tbd_reason)));
  if (!readable) {
    return {
      ...claim,
      effect: 'tbd',
      code: PRACTICE_EXCEPTION_CODE.UNREADABLE,
      dates: [],
    } as Claim;
  }
  if (kind === PRACTICE_EXCEPTION_KIND.TIME_TBD) {
    // Rule 4: not clipped to the row's range.
    return {
      ...claim,
      effect: 'tbd',
      code: exception.tbd_reason,
      dates: weekdayDates(rowDay, first, last),
    } as Claim;
  }
  const slot = exception.slot;
  if (!isRecord(slot)) {
    return {
      ...claim,
      effect: 'tbd',
      code: PRACTICE_OCCURRENCE_REFUSAL.SLOT_MISSING,
      dates: [],
    } as Claim;
  }
  if (!dayReads(slot.day_of_week)) {
    return {
      ...claim,
      effect: 'tbd',
      code: PRACTICE_OCCURRENCE_REFUSAL.DAY_UNREADABLE,
      dates: [],
    } as Claim;
  }
  // Rule 5: clipped to the row's range.
  const from = first > bounds.first ? first : bounds.first;
  const until = last < bounds.last ? last : bounds.last;
  return {
    ...claim,
    effect: 'relocated',
    slot,
    dates: weekdayDates(slot.day_of_week, from, until),
  } as Claim;
}

const covers = (claim: Claim, date: string): boolean =>
  date >= claim.first && (claim.last === null || date <= claim.last);
const overlaps = (a: Claim, b: Claim): boolean =>
  (a.last === null || b.first <= a.last) && (b.last === null || a.first <= b.last);

/** Core `applyPracticeExceptions`, restated. */
export function applyPracticeExceptions(input: {
  rows: unknown;
  exceptions: unknown;
}): PracticeExceptionsResult {
  const { rows, exceptions } = input;
  if (!Array.isArray(rows)) throw new TypeError('applyPracticeExceptions requires rows[]');
  if (!Array.isArray(exceptions)) {
    throw new TypeError('applyPracticeExceptions requires exceptions[]');
  }
  const occurrences: Rec[] = [];
  const undated: PracticeExceptionsResult['undated'] = [];
  const findings: PracticeExceptionsResult['findings'] = [];
  const meta = {
    rowsRead: rows.length,
    exceptionsRead: exceptions.length,
    exceptionsLive: 0,
    exceptionsWithdrawn: 0,
    exceptionsApplied: 0,
    datesSuppressed: 0,
  };

  const rowIds = new Set(
    rows
      .filter(isRecord)
      .map((row) => row.id)
      .filter((id) => id != null)
  );
  const liveByRow = new Map<unknown, Rec[]>();
  for (const exception of exceptions) {
    if (!isRecord(exception)) {
      findings.push({
        code: PRACTICE_EXCEPTION_CODE.UNREADABLE,
        assignmentId: null,
        exceptionId: null,
      });
      continue;
    }
    // Rule 2.
    if ('withdrawn_at' in exception && exception.withdrawn_at != null) {
      meta.exceptionsWithdrawn += 1;
      continue;
    }
    meta.exceptionsLive += 1;
    if (exception.assignment_id == null || !rowIds.has(exception.assignment_id)) {
      findings.push({
        code: PRACTICE_EXCEPTION_CODE.ROW_UNREAD,
        assignmentId: exception.assignment_id ?? null,
        exceptionId: exception.id ?? null,
      });
      continue;
    }
    const list = liveByRow.get(exception.assignment_id) ?? [];
    list.push(exception);
    liveByRow.set(exception.assignment_id, list);
  }

  for (const raw of rows) {
    const row: Rec = isRecord(raw) ? raw : {};
    const assignmentId = row.id ?? null;
    const live = row.id == null ? [] : (liveByRow.get(row.id) ?? []);
    // Rule 1, and rule 8's ROW_REFUSED.
    const refuse = (code: string) => {
      undated.push({ assignmentId, exceptionId: null, code });
      for (const e of live) {
        findings.push({
          code: PRACTICE_EXCEPTION_CODE.ROW_REFUSED,
          assignmentId,
          exceptionId: e.id ?? null,
        });
      }
    };
    if (!isRecord(row.slot)) {
      refuse(PRACTICE_OCCURRENCE_REFUSAL.SLOT_MISSING);
      continue;
    }
    const series = practiceOccurrenceDates(row.effective_date_range, row.slot.day_of_week);
    if (series.refusal !== null) {
      refuse(series.refusal);
      continue;
    }
    const bounds = practiceRangeBounds(row.effective_date_range) as { first: string; last: string };
    const read = live.map((e) => readClaim(e, bounds, row.slot.day_of_week));
    meta.exceptionsApplied += read.length;

    // Rule 6, unreadable lower bound.
    const unreadable = read.filter((c) => c.unreadableWindow);
    if (unreadable.length > 0) {
      for (const c of unreadable) {
        const entry = { assignmentId, exceptionId: c.exceptionId };
        undated.push({ ...entry, code: PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE });
        findings.push({ code: PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE, ...entry });
      }
      meta.datesSuppressed += series.dates.length;
      continue;
    }
    const claims = read as Claim[];

    // Rule 6, open upper.
    let openFrom: string | null = null;
    for (const c of claims) {
      if (c.effect !== 'open') continue;
      const entry = { assignmentId, exceptionId: c.exceptionId };
      undated.push({ ...entry, code: c.code as string });
      findings.push({ code: c.code as string, ...entry });
      if (openFrom === null || c.first < openFrom) openFrom = c.first;
    }

    // Rule 8's RELOCATION_UNMATCHED.
    for (const c of claims) {
      if (c.effect !== 'relocated') continue;
      if (c.dates.length < series.dates.filter((d) => covers(c, d)).length) {
        findings.push({
          code: PRACTICE_EXCEPTION_CODE.RELOCATION_UNMATCHED,
          assignmentId,
          exceptionId: c.exceptionId,
        });
      }
    }

    // Rule 7.
    const conflicted = new Set<number>();
    claims.forEach((a, i) =>
      claims.forEach((b, j) => {
        if (j > i && overlaps(a, b)) conflicted.add(i).add(j);
      })
    );
    [...conflicted]
      .sort((x, y) => x - y)
      .forEach((i) =>
        findings.push({
          code: PRACTICE_EXCEPTION_CODE.CONFLICT,
          assignmentId,
          exceptionId: claims[i].exceptionId,
        })
      );

    const seriesSet = new Set(series.dates);
    const candidates = new Set(series.dates);
    for (const c of claims) for (const d of c.dates) candidates.add(d);
    let seriesKept = 0;
    for (const date of [...candidates].sort(order)) {
      if (openFrom !== null && date >= openFrom) continue;
      const inForce = claims.filter((c) => covers(c, date));
      if (inForce.length === 0) {
        occurrences.push({ assignmentId, date, kind: 'series', slot: row.slot });
        seriesKept += 1;
        continue;
      }
      if (inForce.length > 1) {
        occurrences.push({
          assignmentId,
          date,
          kind: 'time_tbd',
          exceptionId: null,
          code: PRACTICE_EXCEPTION_CODE.CONFLICT,
          causeKind: null,
        });
        continue;
      }
      const c = inForce[0];
      if (c.effect === 'relocated') {
        if (!c.dates.includes(date)) continue;
        occurrences.push({
          assignmentId,
          date,
          kind: 'relocated',
          slot: c.slot,
          exceptionId: c.exceptionId,
          replaces: row.slot,
          causeKind: c.causeKind,
        });
        continue;
      }
      if (!seriesSet.has(date) && !c.dates.includes(date)) continue;
      occurrences.push({
        assignmentId,
        date,
        kind: 'time_tbd',
        exceptionId: c.exceptionId,
        code: c.code,
        causeKind: c.causeKind,
      });
    }
    meta.datesSuppressed += series.dates.length - seriesKept;
  }

  // Rule 9.
  const timed = new Map<string, unknown[]>();
  for (const o of occurrences) {
    if (o.kind === 'time_tbd') continue;
    const ids = timed.get(o.date) ?? [];
    ids.push(o.assignmentId);
    timed.set(o.date, ids);
  }
  for (const o of occurrences) {
    if (o.kind !== 'time_tbd') continue;
    if ((timed.get(o.date) ?? []).some((id) => id !== o.assignmentId)) {
      findings.push({
        code: PRACTICE_EXCEPTION_CODE.TBD_SHADOWED,
        assignmentId: o.assignmentId,
        exceptionId: o.exceptionId,
        date: o.date,
      });
    }
  }

  occurrences.sort(
    (a, b) => order(a.date, b.date) || order(key(a.assignmentId), key(b.assignmentId))
  );
  undated.sort(
    (a, b) =>
      order(key(a.assignmentId), key(b.assignmentId)) ||
      order(a.code, b.code) ||
      order(key(a.exceptionId), key(b.exceptionId))
  );
  findings.sort(
    (a, b) =>
      order(a.code, b.code) ||
      order(key(a.assignmentId), key(b.assignmentId)) ||
      order(key(a.exceptionId), key(b.exceptionId)) ||
      order(key(a.date), key(b.date))
  );
  return { occurrences, undated, findings, meta };
}
