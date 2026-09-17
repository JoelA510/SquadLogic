/**
 * The season clock, Deno/TS arm.
 *
 * ## Why this file is a second implementation, and what stops it drifting
 *
 * `packages/core/src/timing/seasonClock.js` is the canonical season clock: the
 * one place a naive wall reading becomes an instant, with the zone as a
 * parameter. Edge Functions cannot import it. They are Deno modules bundled
 * from `supabase/` by `supabase functions deploy`, and a relative import
 * climbing out to `packages/core/` leaves that root; the module also pulls in
 * `timing/reasonCodes.js` -> `facility/reasonCodes.js`, so "just import it"
 * means dragging a slice of the domain package across a bundler boundary that
 * is exercised only by the production deploy job. `_shared/engines/` already
 * mirrors `packages/core` for exactly this reason.
 *
 * A mirror is this repository's most recurrent defect family (LIVE-1, LIVE-2,
 * LIVE-3, LIVE-7 -- a fix applied to one arm and not its sibling), so this one
 * ships with the drift check the others lacked:
 * `_shared/timing/seasonClock.vectors.json` is a table of
 * (date, wall time, IANA zone) -> expected instant, and **both** arms are run
 * against it -- this one from `_shared/tests/season-clock_test.ts` under Deno,
 * the JS one from `tests/seasonClockVectors.test.js` under Vitest. A vector
 * table only one side reads is not a cross-check; each side asserts the same
 * expected strings, so either arm drifting turns that arm red.
 *
 * ## The rules, restated rather than inherited
 *
 * Identical to the JS arm, and the vector table is what proves it:
 *
 * - **Ambiguous** (a fall-back repeats an hour): resolve to the **first**
 *   occurrence and report {@link TIMING_REASON.WALL_TIME_AMBIGUOUS}.
 * - **Non-existent** (a spring-forward skips an hour): **refuse** with
 *   {@link TIMING_REASON.WALL_TIME_NONEXISTENT}. Nothing in the data says which
 *   of the two readings a shift could produce was meant.
 * - **No zone**: refuse with {@link TIMING_REASON.SEASON_TIMEZONE_MISSING}. A
 *   season with no timezone refuses rather than guessing; the hardcoded
 *   `America/New_York` this replaced in `calendar-feed` was the bug, not the
 *   safety net.
 * - **`24:00:00`** is midnight ending the day and composes. Postgres `time`
 *   stores it and `game_slots_time_check` permits a 22:00 -> 24:00 slot.
 * - Never throws. {@link requireZonedInstant} is the wrapper for call sites
 *   that must stop.
 *
 * @module _shared/timing/seasonClock
 */

/** `YYYY-MM-DD`. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.sss` -- Postgres `time` renders the middle one. */
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
/**
 * The separator between a date and a wall time. `T` is the ISO spelling; a
 * single space is what Postgres renders a `timestamp without time zone` as, and
 * a value in that spelling is exactly as zone-less as the ISO one.
 */
const DATE_TIME_SEPARATOR = '[T ]';
/** A bare `YYYY-MM-DD` with no clock of any kind. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * Every reason this clock can give. `code` is the contract and `message` is
 * decoration -- the same rule the core reason registry states. The five codes
 * are spelled identically to `packages/core/src/timing/reasonCodes.js` so a
 * finding crossing the wire means the same thing on both sides.
 */
export const TIMING_REASON = Object.freeze({
  SEASON_TIMEZONE_MISSING: 'SEASON_TIMEZONE_MISSING',
  SEASON_TIMEZONE_UNKNOWN: 'SEASON_TIMEZONE_UNKNOWN',
  WALL_TIME_UNREADABLE: 'WALL_TIME_UNREADABLE',
  WALL_TIME_NONEXISTENT: 'WALL_TIME_NONEXISTENT',
  WALL_TIME_AMBIGUOUS: 'WALL_TIME_AMBIGUOUS',
} as const);

export type TimingReason = (typeof TIMING_REASON)[keyof typeof TIMING_REASON];

/**
 * `WALL_TIME_AMBIGUOUS` is informational -- an instant IS composed, the first
 * of the two occurrences. Every other code means no instant exists.
 * Mirrors `TIMING_REASON_SEVERITY` in the core registry for these five codes.
 */
export const TIMING_REASON_BLOCKING: Readonly<Record<string, boolean>> = Object.freeze({
  [TIMING_REASON.SEASON_TIMEZONE_MISSING]: true,
  [TIMING_REASON.SEASON_TIMEZONE_UNKNOWN]: true,
  [TIMING_REASON.WALL_TIME_UNREADABLE]: true,
  [TIMING_REASON.WALL_TIME_NONEXISTENT]: true,
  [TIMING_REASON.WALL_TIME_AMBIGUOUS]: false,
});

export interface TimingFinding {
  code: TimingReason;
  message: string;
  details: Record<string, unknown>;
}

function makeTimingFinding(
  code: TimingReason,
  message: string,
  details: Record<string, unknown> = {}
): TimingFinding {
  return { code, message, details };
}

/** Is this finding one that means no instant was composed? */
export function isBlockingFinding(finding: TimingFinding): boolean {
  return TIMING_REASON_BLOCKING[finding.code] !== false;
}

/**
 * Is this string a naive (zone-less) `YYYY-MM-DDTHH:MM[:SS]` date-time?
 */
export function isNaiveDateTime(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}${DATE_TIME_SEPARATOR}\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?$`
  ).test(value.trim());
}

/**
 * Is this string a moment with **no zone attached at all** -- either a naive
 * wall date-time, or a bare calendar date?
 *
 * The two are refused together wherever a `timestamptz` is downstream:
 * `new Date('2026-11-07')` is spec'd as UTC midnight, so a date-only string
 * does not fail, it silently acquires a zone nobody chose.
 * {@link anchorToSeasonClock} still leaves the date-only form alone, because a
 * date with no clock is not a wall *reading* -- there is nothing to compose.
 */
export function isZonelessTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return isNaiveDateTime(value) || DATE_ONLY_PATTERN.test(value.trim());
}

/** Split a naive `YYYY-MM-DDTHH:MM[:SS]` string into its date and time halves. */
function splitNaiveDateTime(value: string): { date: string; time: string } {
  const trimmed = String(value).trim();
  const at = trimmed.search(/[T ]/);
  return { date: trimmed.slice(0, at), time: trimmed.slice(at + 1) };
}

/**
 * Parse a wall time into **seconds** past midnight.
 *
 * Seconds rather than minutes because `game_slots.start_time` is a Postgres
 * `time`, which carries them. A number is taken as the domain representation --
 * minutes past midnight.
 *
 * `24:00[:00]` is the only hour-24 value that names an instant; `24:30` does
 * not and is refused.
 */
function wallSecondsOf(time: unknown): number | null {
  if (typeof time === 'number') {
    return Number.isFinite(time) && time >= 0 && time <= 1440 ? Math.trunc(time) * 60 : null;
  }
  if (typeof time !== 'string') return null;
  const match = TIME_PATTERN.exec(time.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = match[3] ? Number.parseInt(match[3], 10) : 0;
  if (hours > 24 || minutes > 59 || seconds > 59) return null;
  if (hours === 24 && (minutes > 0 || seconds > 0)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * One `Intl.DateTimeFormat` per zone. Constructing one is expensive and a
 * calendar feed composes hundreds of slots through the same zone.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (formatterCache.has(timeZone)) return formatterCache.get(timeZone) ?? null;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    formatter = null;
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * The wall-clock reading of an instant in a zone, expressed as the epoch value
 * those same wall fields would have if they were UTC.
 *
 * The pseudo-UTC encoding is what makes the offset a plain subtraction:
 * `wallMsIn(z, t) - t` is the zone's offset at `t`, in milliseconds.
 */
function wallMsIn(formatter: Intl.DateTimeFormat, epochMs: number): number {
  const fields: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    fields[part.type] = part.value;
  }
  let hour = Number(fields.hour);
  // Some ICU builds render midnight as `24` under `hour12: false`.
  if (hour === 24) hour = 0;
  return Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    hour,
    Number(fields.minute),
    Number(fields.second)
  );
}

/**
 * Render an instant as an ISO string carrying the zone's offset.
 *
 * The offset form (`2026-11-07T16:44:00-05:00`) rather than the `Z` form is
 * deliberate and matches the JS arm: it parses to the identical instant, and it
 * keeps the season's own wall reading legible in the stored value.
 */
function toOffsetIso(epochMs: number, offsetMs: number): string {
  const offsetMinutes = Math.round(offsetMs / MS_PER_MINUTE);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mm = String(absolute % 60).padStart(2, '0');
  const local = new Date(epochMs + offsetMs).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

export interface ResolveZonedInstantInput {
  date: unknown;
  time: unknown;
  timeZone?: string | null;
  label?: string;
}

export interface ResolveZonedInstantResult {
  iso: string | null;
  findings: TimingFinding[];
}

/**
 * Turn a season-local wall time into an absolute instant.
 *
 * **Never throws.** A caller that cannot proceed gets `iso: null` and a finding
 * saying why. Malformed input is a finding too, and that is not politeness:
 * these values arrive from the database, and Postgres `time` legally stores
 * `24:00:00`, so the unreadable case is reachable from data nobody typed wrong.
 */
export function resolveZonedInstant({
  date,
  time,
  timeZone,
  label = 'wall time',
}: ResolveZonedInstantInput): ResolveZonedInstantResult {
  const findings: TimingFinding[] = [];

  const dateMatch = typeof date === 'string' ? DATE_PATTERN.exec(date.trim()) : null;
  const seconds = wallSecondsOf(time);
  // A day that does not exist is not a shape error, so the pattern alone cannot
  // see it: `Date.UTC` rolls `2026-02-30` forward to March 2nd silently.
  // Reading the fields back is the only way to catch it.
  const calendarIsReal =
    dateMatch !== null &&
    (() => {
      const year = Number.parseInt(dateMatch[1], 10);
      const month = Number.parseInt(dateMatch[2], 10);
      const day = Number.parseInt(dateMatch[3], 10);
      const probe = new Date(Date.UTC(year, month - 1, day));
      return (
        probe.getUTCFullYear() === year &&
        probe.getUTCMonth() === month - 1 &&
        probe.getUTCDate() === day
      );
    })();

  if (!dateMatch || !calendarIsReal || seconds === null) {
    findings.push(
      makeTimingFinding(
        TIMING_REASON.WALL_TIME_UNREADABLE,
        `${label} is not a readable wall time: ${String(date)} ${String(time)}`,
        { label, date: String(date), time: String(time) }
      )
    );
    return { iso: null, findings };
  }

  if (typeof timeZone !== 'string' || !timeZone.trim()) {
    findings.push(
      makeTimingFinding(
        TIMING_REASON.SEASON_TIMEZONE_MISSING,
        `${label} ${date} ${String(time)} has no season timezone to place it on; set the season's timezone before scheduling`,
        { label, date: String(date), time: String(time) }
      )
    );
    return { iso: null, findings };
  }

  const formatter = formatterFor(timeZone.trim());
  if (!formatter) {
    findings.push(
      makeTimingFinding(
        TIMING_REASON.SEASON_TIMEZONE_UNKNOWN,
        `${label} ${date} ${String(time)} names a timezone this runtime does not know: "${timeZone}"`,
        { label, date: String(date), time: String(time), timeZone: String(timeZone) }
      )
    );
    return { iso: null, findings };
  }

  // The requested wall fields, encoded as pseudo-UTC (see `wallMsIn`).
  const wallMs =
    Date.UTC(
      Number.parseInt(dateMatch[1], 10),
      Number.parseInt(dateMatch[2], 10) - 1,
      Number.parseInt(dateMatch[3], 10)
    ) +
    seconds * MS_PER_SECOND;

  // Probe the offset a day either side of the target as well as at the target
  // itself. Probing only at the target finds one offset even across a
  // transition, which would make a genuinely ambiguous time look unique.
  const candidates: Array<{ epochMs: number; offsetMs: number }> = [];
  for (const probe of [wallMs - MS_PER_DAY, wallMs, wallMs + MS_PER_DAY]) {
    const offsetMs = wallMsIn(formatter, probe) - probe;
    const candidate = wallMs - offsetMs;
    // A candidate is real only if the zone actually reads it back as the wall
    // time that was asked for. In a spring-forward gap none of them do.
    if (wallMsIn(formatter, candidate) !== wallMs) continue;
    if (candidates.some((existing) => existing.epochMs === candidate)) continue;
    candidates.push({ epochMs: candidate, offsetMs });
  }

  if (candidates.length === 0) {
    findings.push(
      makeTimingFinding(
        TIMING_REASON.WALL_TIME_NONEXISTENT,
        `${label} ${date} ${String(time)} does not exist in ${timeZone}: daylight saving skips that hour`,
        { label, date: String(date), time: String(time), timeZone: String(timeZone) }
      )
    );
    return { iso: null, findings };
  }

  candidates.sort((a, b) => a.epochMs - b.epochMs);
  const chosen = candidates[0];

  if (candidates.length > 1) {
    findings.push(
      makeTimingFinding(
        TIMING_REASON.WALL_TIME_AMBIGUOUS,
        `${label} ${date} ${String(time)} occurs twice in ${timeZone}; taking the first occurrence`,
        {
          label,
          date: String(date),
          time: String(time),
          timeZone: String(timeZone),
          occurrences: candidates.length,
          chosenOffsetMinutes: Math.round(chosen.offsetMs / MS_PER_MINUTE),
          discardedOffsetMinutes: Math.round(candidates[1].offsetMs / MS_PER_MINUTE),
        }
      )
    );
  }

  return { iso: toOffsetIso(chosen.epochMs, chosen.offsetMs), findings };
}

/**
 * An error carrying the reason code that caused a refusal. `code` is the
 * contract and `message` is decoration.
 */
export class SeasonClockError extends Error {
  readonly code: string;
  readonly findings: TimingFinding[];

  constructor(message: string, code: string, findings: TimingFinding[]) {
    super(message);
    this.name = 'SeasonClockError';
    this.code = code;
    this.findings = findings;
  }
}

/**
 * {@link resolveZonedInstant}, for call sites that cannot carry a finding and
 * must stop instead.
 */
export function requireZonedInstant(input: ResolveZonedInstantInput): string {
  const { iso, findings } = resolveZonedInstant(input);
  if (iso === null) {
    const blocking = findings[0];
    throw new SeasonClockError(blocking.message, blocking.code, findings);
  }
  return iso;
}

/**
 * Re-read a value the season clock may or may not have composed yet.
 *
 * A value that already carries a zone is an instant and comes back untouched.
 * A naive `YYYY-MM-DDTHH:MM` string is a wall reading and is composed against
 * `timeZone`. Anything else (a `Date`, a number, a date-only string) is left
 * alone -- those are not wall readings and guessing at them is the habit this
 * module exists to break.
 *
 * This is the seam the Edge Functions use, so a value the browser composed and
 * a value an API client sent naive can never disagree about what a naive string
 * means.
 */
export function anchorToSeasonClock(
  value: unknown,
  timeZone: string | null | undefined
): { iso: unknown; findings: TimingFinding[] } {
  if (!isNaiveDateTime(value)) {
    return { iso: value, findings: [] };
  }
  const { date, time } = splitNaiveDateTime(value as string);
  return resolveZonedInstant({ date, time, timeZone });
}
