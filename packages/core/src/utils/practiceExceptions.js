/**
 * Applying saved `practice_exceptions` to one team's stored practice rows
 * (8.6 3b PR 12a, `docs/PHASE_8_6_PR12_READERS_PLAN.md` §3).
 *
 * A practice row expands by its own `effective_date_range`
 * ({@link practiceOccurrenceDates}, unchanged). A live exception then changes
 * the dates inside its own window: `time_tbd` turns them into dated TIME TBD
 * entries, `relocated` moves them to another slot. Every reader that turns
 * stored rows into dated practices (the portal, the feed, the RSVP check) is
 * meant to go through this one function -- PR 12b, 12c and 12d adopt it. **This
 * PR adopts it nowhere**, so on its own it changes nothing a family sees.
 *
 * ## The rules (plan §3, operator answers §10)
 *
 * 1. Series first: each row by its own range; a row refusal stays one undated
 *    TIME TBD with the existing code.
 * 2. Only live exceptions apply, and **this function filters them itself**,
 *    whatever the caller selected (the lighting-override contract,
 *    `practice/lightingOverrides.js`). Live is `withdrawn_at == null`, the
 *    predicate of the table's EXCLUDE constraint and of the lock load. An
 *    exception with no `withdrawn_at` key at all cannot be judged live or
 *    withdrawn, so it is read as unreadable (rule 6b), never applied as timed.
 * 3. Windows are read by {@link practiceRangeBounds} and, for an unbounded
 *    upper, its lower half {@link practiceRangeLowerBound}: no third parser.
 * 4. `time_tbd` over W: every date of the row's slot weekday in W is a dated
 *    TIME TBD whose `code` is the `tbd_reason`. **Never clipped** to the row's
 *    range (Q9), so a tail window `[D, until]` after a row ending `D-1` shows.
 * 5. `relocated` over W: the row's series dates in W are removed; the
 *    relocated slot's weekday dates in **W ∩ the row's range** are added
 *    (clipped, Q9). A missing relocated slot or unreadable day turns the
 *    removed dates into dated TIME TBD with the existing refusal code.
 * 6. A window never shows a timed practice unless it reads. Lower bound reads
 *    but the whole does not (open or unreadable upper): every date from the
 *    lower bound on is suppressed and one undated entry is emitted --
 *    `WINDOW_OPEN` when the upper bound is absent, `WINDOW_UNREADABLE` when it
 *    is present and does not read (the wording must not say "no end date" of
 *    a corrupt one). Lower bound does not read: the whole row is undated
 *    `WINDOW_UNREADABLE`.
 *    6b (not in the plan's list, declared in the PR): an exception whose
 *    `kind` or `tbd_reason` is outside the table's CHECK, or which carries no
 *    `withdrawn_at`, turns the row's series dates in its window into dated
 *    TIME TBD `UNREADABLE`.
 * 7. Overlapping live windows on one row (the EXCLUDE constraint forbids
 *    them; this does not trust it): every date in the overlap is TIME TBD
 *    `CONFLICT`. Reported, never thrown -- the feed must not 500.
 * 8. An exception naming a row not in `rows` (or naming no row) is a partial
 *    read: finding `ROW_UNREAD`, never applied. One on a row the series
 *    refused (rule 1) is finding `ROW_REFUSED`. So `meta.exceptionsLive` is
 *    always `exceptionsApplied` + `ROW_UNREAD` + `ROW_REFUSED` findings.
 *    A relocation that adds fewer dates than it removes (the new weekday of
 *    the window's last week falls outside it) is shown as written, with
 *    finding `RELOCATION_UNMATCHED`: the reader does not invent a date the
 *    writer did not record.
 * 9. A dated TIME TBD on a date another row of the team has a timed practice:
 *    both are kept, finding `PRACTICE_TBD_SHADOWED` (Q10).
 *
 * ## The date contract (GAP-30)
 *
 * Wall dates only, `YYYY-MM-DD` in and out, and **no `Date` is constructed**
 * (`practiceOccurrences.js`). Instants are composed by the reader afterwards,
 * on the season clock, with the relocated slot's times.
 *
 * The Edge runtime cannot import this package, so
 * `supabase/functions/_shared/calendar/practiceExceptions.ts` restates it with
 * no imports. `tests/practiceExceptionsDrift.test.js` holds the two to the same
 * outcome over an enumerated product and a committed digest.
 *
 * @module utils/practiceExceptions
 */

import {
  DAY_OF_WEEK_ENUM,
  PRACTICE_OCCURRENCE_REFUSAL,
  practiceOccurrenceDates,
  practiceRangeBounds,
  practiceRangeLowerBound,
} from './practiceOccurrences.js';

/** The `kind` CHECK of `practice_exceptions` (20260929000000). */
export const PRACTICE_EXCEPTION_KIND = Object.freeze({
  RELOCATED: 'relocated',
  TIME_TBD: 'time_tbd',
});

/**
 * The `tbd_reason` CHECK (20261002000000). A mirror, not an import of core
 * `PRACTICE_TBD_REASON`: that lives in `practice/`, which a live reader may
 * not import (`tests/unwiredLayerImporters.test.js`). Pinned equal to it, and
 * to the Edge persistence enum, by `tests/practiceExceptions.test.js`.
 */
export const PRACTICE_EXCEPTION_TBD_REASONS = Object.freeze([
  'no-legal-slot-at-venue',
  'contended',
  'change-budget',
  'objective-preferred-tbd',
  'coach-preference',
  'declined',
  'past-sunset',
  'sunset-unknown',
]);

/** The codes this module adds. The TIME TBD ones are worded in `PRACTICE_TBD_CAUSES`. */
export const PRACTICE_EXCEPTION_CODE = Object.freeze({
  WINDOW_OPEN: 'PRACTICE_EXCEPTION_WINDOW_OPEN',
  WINDOW_UNREADABLE: 'PRACTICE_EXCEPTION_WINDOW_UNREADABLE',
  CONFLICT: 'PRACTICE_EXCEPTION_CONFLICT',
  UNREADABLE: 'PRACTICE_EXCEPTION_UNREADABLE',
  ROW_UNREAD: 'PRACTICE_EXCEPTION_ROW_UNREAD',
  TBD_SHADOWED: 'PRACTICE_TBD_SHADOWED',
  /** Findings only: a live exception on a row the series itself refused. */
  ROW_REFUSED: 'PRACTICE_EXCEPTION_ROW_REFUSED',
  /** Findings only: a relocation that adds fewer dates than it removes. */
  RELOCATION_UNMATCHED: 'PRACTICE_EXCEPTION_RELOCATION_UNMATCHED',
});

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read exactly as `practiceOccurrenceDates` reads a day: lowercased, not trimmed. */
const dayReads = (day) => DAY_OF_WEEK_ENUM.includes(String(day ?? '').toLowerCase());

/** Plain code-unit order, the same in every runtime (no locale). */
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const key = (value) => String(value ?? '');

/**
 * Every date on `day` in the inclusive `[first, last]`, through the series
 * expander itself so there is one weekday walk. `[]` when the span is empty.
 */
function weekdayDates(day, first, last) {
  if (first > last) return [];
  return practiceOccurrenceDates({ range: `[${first},${last}]`, dayOfWeek: day }).dates;
}

/**
 * @typedef {{
 *   exceptionId: any, causeKind: any, unreadableWindow: boolean,
 *   first?: string, last?: string | null, effect?: 'open' | 'tbd' | 'relocated',
 *   code?: string, slot?: Record<string, any>, dates?: string[],
 * }} Claim
 */

/**
 * One live exception, read against its row.
 *
 * @param {Record<string, any>} exception
 * @param {{ first: string, last: string }} bounds - the row's own range
 * @param {unknown} rowDay - the row's slot `day_of_week`
 * @returns {Claim}
 */
function readClaim(exception, bounds, rowDay) {
  const exceptionId = exception.id ?? null;
  const causeKind = exception.cause_kind ?? null;
  const whole = practiceRangeBounds(exception.window);
  const lower = whole ? null : practiceRangeLowerBound(exception.window);
  if (whole === null && lower === null) return { exceptionId, causeKind, unreadableWindow: true };
  const first = whole ? whole.first : lower.first;
  const last = whole ? whole.last : null;
  const claim = { exceptionId, causeKind, unreadableWindow: false, first, last };
  if (last === null) {
    // Suppressed from `first` on either way; only the wording differs.
    const code = lower.upperUnbounded
      ? PRACTICE_EXCEPTION_CODE.WINDOW_OPEN
      : PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE;
    return { ...claim, effect: 'open', code, dates: [] };
  }

  const kind = exception.kind;
  const readable =
    'withdrawn_at' in exception &&
    (kind === PRACTICE_EXCEPTION_KIND.RELOCATED ||
      (kind === PRACTICE_EXCEPTION_KIND.TIME_TBD &&
        PRACTICE_EXCEPTION_TBD_REASONS.includes(exception.tbd_reason)));
  if (!readable) {
    return { ...claim, effect: 'tbd', code: PRACTICE_EXCEPTION_CODE.UNREADABLE, dates: [] };
  }
  if (kind === PRACTICE_EXCEPTION_KIND.TIME_TBD) {
    // Rule 4: the row's weekday over W itself, not clipped to the range.
    return {
      ...claim,
      effect: 'tbd',
      code: exception.tbd_reason,
      dates: weekdayDates(rowDay, first, last),
    };
  }
  const slot = exception.slot;
  if (!isRecord(slot)) {
    return { ...claim, effect: 'tbd', code: PRACTICE_OCCURRENCE_REFUSAL.SLOT_MISSING, dates: [] };
  }
  if (!dayReads(slot.day_of_week)) {
    return { ...claim, effect: 'tbd', code: PRACTICE_OCCURRENCE_REFUSAL.DAY_UNREADABLE, dates: [] };
  }
  // Rule 5: the relocated slot's weekday over W ∩ the row's range.
  const from = first > bounds.first ? first : bounds.first;
  const until = last < bounds.last ? last : bounds.last;
  return {
    ...claim,
    effect: 'relocated',
    slot,
    dates: weekdayDates(slot.day_of_week, from, until),
  };
}

const covers = (claim, date) => date >= claim.first && (claim.last === null || date <= claim.last);
const overlaps = (a, b) =>
  (a.last === null || b.first <= a.last) && (b.last === null || a.first <= b.last);

/**
 * Apply one team's live practice exceptions to its practice rows.
 *
 * @param {{
 *   rows: Array<{ id: any, effective_date_range: unknown, slot: Record<string, any> | null }>,
 *   exceptions: Array<Record<string, any>>,
 * }} input - one team's rows and every exception read for them, withdrawn or not
 * @returns {{
 *   occurrences: Array<Record<string, any>>,
 *   undated: Array<{ assignmentId: any, exceptionId: any, code: string }>,
 *   findings: Array<{ code: string, assignmentId: any, exceptionId: any, date?: string }>,
 *   meta: { rowsRead: number, exceptionsRead: number, exceptionsLive: number,
 *     exceptionsWithdrawn: number, exceptionsApplied: number, datesSuppressed: number },
 * }}
 */
export function applyPracticeExceptions({ rows, exceptions }) {
  if (!Array.isArray(rows)) throw new TypeError('applyPracticeExceptions requires rows[]');
  if (!Array.isArray(exceptions)) {
    throw new TypeError('applyPracticeExceptions requires exceptions[]');
  }
  const occurrences = [];
  const undated = [];
  const findings = [];
  const meta = {
    rowsRead: rows.length,
    exceptionsRead: exceptions.length,
    exceptionsLive: 0,
    exceptionsWithdrawn: 0,
    exceptionsApplied: 0,
    datesSuppressed: 0,
  };

  // A row with no id can be named by no exception.
  const rowIds = new Set(
    rows
      .filter(isRecord)
      .map((row) => row.id)
      .filter((id) => id != null)
  );
  /** @type {Map<any, Record<string, any>[]>} */
  const liveByRow = new Map();
  for (const exception of exceptions) {
    if (!isRecord(exception)) {
      findings.push({
        code: PRACTICE_EXCEPTION_CODE.UNREADABLE,
        assignmentId: null,
        exceptionId: null,
      });
      continue;
    }
    // Rule 2: the helper's own filter. A withdrawn exception is counted, never applied.
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
    const row = isRecord(raw) ? raw : {};
    const assignmentId = row.id ?? null;
    const live = row.id == null ? [] : (liveByRow.get(row.id) ?? []);
    // Rule 1: a refused row stays one undated entry; its exceptions are named, not lost.
    const refuse = (code) => {
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
    const series = practiceOccurrenceDates({
      range: row.effective_date_range,
      dayOfWeek: row.slot.day_of_week,
    });
    if (series.refusal !== null) {
      refuse(series.refusal);
      continue;
    }
    const bounds = /** @type {{ first: string, last: string }} */ (
      practiceRangeBounds(row.effective_date_range)
    );
    const claims = live.map((e) => readClaim(e, bounds, row.slot.day_of_week));
    // Read against an expandable row, whatever that reading could show.
    meta.exceptionsApplied += claims.length;

    // Rule 6, unreadable lower bound: the whole row is undated.
    const unreadable = claims.filter((c) => c.unreadableWindow);
    if (unreadable.length > 0) {
      for (const c of unreadable) {
        const entry = { assignmentId, exceptionId: c.exceptionId };
        undated.push({ ...entry, code: PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE });
        findings.push({ code: PRACTICE_EXCEPTION_CODE.WINDOW_UNREADABLE, ...entry });
      }
      meta.datesSuppressed += series.dates.length;
      continue;
    }

    // Rule 6, open upper: suppress from its lower bound on, one undated entry.
    let openFrom = null;
    for (const c of claims) {
      if (c.effect !== 'open') continue;
      const entry = { assignmentId, exceptionId: c.exceptionId };
      undated.push({ ...entry, code: c.code });
      findings.push({ code: c.code, ...entry });
      if (openFrom === null || c.first < openFrom) openFrom = c.first;
    }

    // A relocation that adds fewer dates than it removes (another weekday
    // falling outside the window or the range) is shown as written, and said.
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

    // Rule 7: overlapping live windows, reported once per exception involved.
    const conflicted = new Set();
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
        if (!c.dates.includes(date)) continue; // an original date the move removed
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
      // `tbd`: a time_tbd date, or a series date whose change cannot be shown.
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

  // Rule 9: a TIME TBD date another row of the team still shows as timed.
  const timed = new Map();
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
