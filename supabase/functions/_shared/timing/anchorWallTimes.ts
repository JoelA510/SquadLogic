/**
 * The boundary where a request's wall times become instants (LIVE-7).
 *
 * ## What this replaces
 *
 * `auto-scheduler/index.ts` did `new Date(s.start)` on values
 * `PracticeSchedulingPage` had built as `` `${date}T${time}` `` -- a naive wall
 * reading. That is the **host's** zone, and the Supabase edge runtime is UTC,
 * so every practice instant was a function of where the code ran rather than of
 * the season. The season's clock was in the request body the whole time, in a
 * field the function never mentioned.
 *
 * ## The contract
 *
 * One pass per request, before anything reads a `start`:
 *
 * - A value that already carries a zone (`Z` or `+HH:MM`), a `Date`, or an
 *   epoch number is an **instant** and is taken as-is.
 * - A naive `YYYY-MM-DDTHH:MM[:SS]` string is a **wall reading** and is
 *   composed on the season's clock.
 * - A bare `YYYY-MM-DD` is refused, exactly as `packages/core`'s
 *   `InstantSchema` refuses it: `new Date('2026-11-07')` is spec'd as UTC
 *   midnight, so it does not fail, it silently acquires a zone nobody chose.
 * - A naive value with **no season zone** is refused with
 *   `SEASON_TIMEZONE_MISSING`. A season with no timezone refuses rather than
 *   guessing -- the established ruling.
 *
 * Nothing is dropped silently: every refusal comes back as a finding naming the
 * row and the reason code, and the handlers turn a blocking finding into a 422
 * the operator can act on.
 *
 * ## Why this is not a Zod schema
 *
 * Because composing needs a sibling field. `packages/core`'s `InstantSchema`
 * can refuse a naive string outright, since core has no season zone at hand
 * when it validates. The edge does -- it reads it from `season_settings` -- so
 * refusing outright would throw away a value it can place correctly. This runs
 * before validation and hands the schema instants, which is the same contract
 * arrived at from the other side: **nothing zone-less reaches an evaluator.**
 *
 * @module _shared/timing/anchorWallTimes
 */

import {
  TIMING_REASON,
  anchorToSeasonClock,
  isBlockingFinding,
  isZonelessTimestamp,
  type TimingFinding,
} from './seasonClock.ts';

/** A finding, plus which row of the request produced it. */
export interface AnchorFinding extends TimingFinding {
  /** `slots[3]`, `games[12]` — the request path, so an operator can find it. */
  path: string;
  /** The row's own id when it has one. */
  id: string | null;
}

export interface AnchorResult<T> {
  /** The rows whose start and end both became instants. */
  rows: T[];
  /** Every finding raised, blocking or not. */
  findings: AnchorFinding[];
  /** The subset that means a row was refused. */
  blocking: AnchorFinding[];
}

/**
 * Turn one already-anchored value into a `Date`, refusing what
 * `packages/core`'s `InstantSchema` refuses.
 *
 * Exported because "declared is not enforced" otherwise: this is the single
 * predicate that says what counts as an instant on the edge, and a test can
 * point at it.
 */
export function toInstant(value: unknown): { date: Date | null; code: string | null } {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { date: null, code: TIMING_REASON.WALL_TIME_UNREADABLE }
      : { date: value, code: null };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { date: new Date(value), code: null }
      : { date: null, code: TIMING_REASON.WALL_TIME_UNREADABLE };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return { date: null, code: TIMING_REASON.WALL_TIME_UNREADABLE };
  }
  // A naive date-time should already have been composed by the caller; a bare
  // `YYYY-MM-DD` never is, because it is not a wall *reading*. Either way a
  // zone-less value must not become an instant here.
  if (isZonelessTimestamp(value)) {
    return { date: null, code: TIMING_REASON.SEASON_TIMEZONE_MISSING };
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? { date: null, code: TIMING_REASON.WALL_TIME_UNREADABLE }
    : { date: parsed, code: null };
}

const MESSAGE_FOR: Record<string, string> = {
  [TIMING_REASON.SEASON_TIMEZONE_MISSING]:
    "carries a wall time with no season timezone to place it on; set the season's timezone before scheduling",
  [TIMING_REASON.WALL_TIME_UNREADABLE]: 'carries a start or end that is not a readable time',
};

/**
 * Anchor the `start`/`end` pair on every row of a collection.
 *
 * @param rows the request's rows, untouched (a new array is returned)
 * @param timeZone the season's IANA zone, or `null` when it has none
 * @param label `slots` / `games` — used to build the finding path
 */
export function anchorWallTimes<T extends { id?: unknown; start: unknown; end: unknown }>(
  rows: readonly T[],
  timeZone: string | null,
  label: string
): AnchorResult<T & { start: Date; end: Date }> {
  const out: Array<T & { start: Date; end: Date }> = [];
  const findings: AnchorFinding[] = [];

  rows.forEach((row, index) => {
    const path = `${label}[${index}]`;
    const id = row?.id === undefined || row?.id === null ? null : String(row.id);

    /** @returns the composed Date, or null having pushed a finding. */
    const place = (value: unknown, which: 'start' | 'end'): Date | null => {
      const anchored = anchorToSeasonClock(value, timeZone);
      const blocking = anchored.findings.find(isBlockingFinding);
      if (blocking) {
        findings.push({ ...blocking, path: `${path}.${which}`, id });
        return null;
      }
      // A non-blocking finding (an ambiguous wall time resolved to its first
      // occurrence) is reported, not swallowed: the instant is real, and the
      // operator still wants to know a fall-back hour was involved.
      for (const finding of anchored.findings) {
        findings.push({ ...finding, path: `${path}.${which}`, id });
      }
      const { date, code } = toInstant(anchored.iso);
      if (date === null) {
        findings.push({
          code: (code ?? TIMING_REASON.WALL_TIME_UNREADABLE) as TimingFinding['code'],
          message: `${path}.${which} ${MESSAGE_FOR[code ?? ''] ?? 'could not be placed on the season clock'}`,
          details: { path: `${path}.${which}`, id, value: String(value) },
          path: `${path}.${which}`,
          id,
        });
        return null;
      }
      return date;
    };

    const start = place(row.start, 'start');
    const end = place(row.end, 'end');
    if (start === null || end === null) return;
    out.push({ ...row, start, end });
  });

  return { rows: out, findings, blocking: findings.filter(isBlockingFinding) };
}

/**
 * The response body a handler returns when a request could not be placed.
 *
 * Bucketed by reason **code**, never by message: every message the clock builds
 * embeds that row's own date and time, so a season with no timezone would
 * otherwise produce one line per slot. The per-row detail stays on `findings`,
 * where a caller that wants it can read it.
 */
export function describeAnchorFailure(blocking: AnchorFinding[]): {
  error: string;
  code: string;
  byCode: Record<string, number>;
  findings: AnchorFinding[];
} {
  const byCode: Record<string, number> = {};
  for (const finding of blocking) byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
  const dominant =
    Object.entries(byCode).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
    TIMING_REASON.WALL_TIME_UNREADABLE;
  return {
    error:
      dominant === TIMING_REASON.SEASON_TIMEZONE_MISSING
        ? 'This season has no timezone set, so its practice times cannot be placed on a clock. An admin can set it in Settings then Season.'
        : `${blocking.length} scheduled time(s) could not be placed on the season clock.`,
    code: dominant,
    byCode,
    // Capped: a 400-slot season must not return a 400-entry array to a browser
    // that only renders the first line of it.
    findings: blocking.slice(0, 20),
  };
}
