/**
 * The season clock: the one place a wall time becomes an instant.
 *
 * ## Why this module exists
 *
 * `game_slots` stores `slot_date date` + `start_time time` — a naive wall
 * reading with no zone attached. `game_assignments.start` is a `timestamptz` —
 * an absolute instant. Something has to bridge the two, and until this module
 * existed the bridge was `new Date('2026-11-07T16:44:00')` in whatever process
 * happened to run it. That reads the string in the **host's** zone, so the same
 * 4:44 PM slot persisted as three different instants eight hours apart
 * depending on which timezone the admin's browser sat in. It looked correct to
 * everyone whose browser matched the season, which is why it survived.
 *
 * ## The `Date` carve-out
 *
 * `timing/index.js` states that the package constructs no `Date`. This file is
 * the single documented exception, and the exception is the point: the domain
 * keeps wall times as `YYYY-MM-DD` plus minutes-past-midnight, and `Date` is
 * confined to the inside of this boundary. Nothing else in `packages/core` may
 * turn a naive wall string into an instant.
 *
 * ## The zone is a parameter, not a lookup
 *
 * Callers pass `timeZone` in. Today every caller reads it from
 * `season_settings.timezone` — the season has one clock, not the venue. This
 * module does not know that and must not: were a per-venue override ever
 * ruled in, it would be a different argument at the call site and no change
 * here.
 *
 * ## The two DST rules, stated rather than inherited
 *
 * - **Ambiguous** (a fall-back repeats an hour, e.g. `America/New_York`
 *   2026-11-01 01:30): resolve to the **first occurrence** — the offset in
 *   force before the transition, 05:30Z rather than 06:30Z — and report
 *   {@link TIMING_REASON.WALL_TIME_AMBIGUOUS}.
 * - **Non-existent** (a spring-forward skips an hour, e.g.
 *   `America/New_York` 2026-03-08 02:30): **refuse**. No instant is composed
 *   and {@link TIMING_REASON.WALL_TIME_NONEXISTENT} is reported. The two
 *   readings a shift could produce are an hour apart and nothing in the data
 *   says which was meant.
 *
 * Both rules are asserted by name and date in `tests/seasonClock.test.js`.
 * A youth league does schedule Sunday-morning games on those two dates.
 *
 * @module timing/seasonClock
 */

import { TIMING_REASON, makeTimingFinding } from './reasonCodes.js';

/** `YYYY-MM-DD`. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `HH:MM`, `HH:MM:SS`, or `HH:MM:SS.sss` — Postgres `time` renders the middle one. */
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * Does this string already carry a zone (a trailing `Z` or `±HH:MM` offset)?
 *
 * Exported because the display layer needs the same question answered the same
 * way: a value that already carries an offset is an instant and must be left
 * alone, and a naive one is a wall reading that needs a clock. Two independent
 * answers to "is this naive?" is exactly the drift CLAUDE.md warns about.
 *
 * @param {unknown} value
 * @returns {boolean} `true` only for a date-time **string** with an explicit zone.
 */
export function carriesZoneOffset(value) {
  if (typeof value !== 'string') return false;
  return /T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

/**
 * Is this string a naive (zone-less) `YYYY-MM-DDTHH:MM[:SS]` date-time?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNaiveDateTime(value) {
  if (typeof value !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(value.trim());
}

/**
 * Split a naive `YYYY-MM-DDTHH:MM[:SS]` string into its date and time halves.
 *
 * @param {string} value
 * @returns {{ date: string, time: string }}
 */
export function splitNaiveDateTime(value) {
  const [date, time] = String(value).trim().split('T');
  return { date, time };
}

/**
 * Parse a wall time into minutes past midnight.
 *
 * Accepts `HH:MM[:SS]` or a non-negative number already in minutes, so a caller
 * holding the domain representation does not have to render it to a string
 * first.
 *
 * @param {string|number} time
 * @returns {number|null} minutes past midnight, or `null` if unreadable.
 */
export function wallMinutesOf(time) {
  if (typeof time === 'number') {
    return Number.isFinite(time) && time >= 0 ? Math.trunc(time) : null;
  }
  if (typeof time !== 'string') return null;
  const match = TIME_PATTERN.exec(time.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = match[3] ? Number.parseInt(match[3], 10) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 60 + minutes;
}

/**
 * One `Intl.DateTimeFormat` per zone. Constructing one is expensive and a
 * season composes thousands of slots through the same zone.
 *
 * @type {Map<string, Intl.DateTimeFormat>}
 */
const formatterCache = new Map();

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat|null} `null` when the runtime rejects the zone.
 */
function formatterFor(timeZone) {
  if (formatterCache.has(timeZone)) return formatterCache.get(timeZone) ?? null;
  let formatter = null;
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
  formatterCache.set(timeZone, /** @type {Intl.DateTimeFormat} */ (formatter));
  return formatter;
}

/**
 * The wall-clock reading of an instant in a zone, expressed as the epoch value
 * those same wall fields would have if they were UTC.
 *
 * The pseudo-UTC encoding is what makes the offset a plain subtraction:
 * `wallMsIn(z, t) - t` is the zone's offset at `t`, in milliseconds.
 *
 * @param {Intl.DateTimeFormat} formatter
 * @param {number} epochMs
 * @returns {number}
 */
function wallMsIn(formatter, epochMs) {
  /** @type {Record<string, string>} */
  const fields = {};
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
 * deliberate: it parses to the identical instant, and it keeps the season's own
 * wall reading legible in the stored value, so a row read back without the
 * season's settings still says what time the game kicks off locally.
 *
 * @param {number} epochMs
 * @param {number} offsetMs
 * @returns {string}
 */
function toOffsetIso(epochMs, offsetMs) {
  const offsetMinutes = Math.round(offsetMs / MS_PER_MINUTE);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mm = String(absolute % 60).padStart(2, '0');
  const local = new Date(epochMs + offsetMs).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

/**
 * Turn a season-local wall time into an absolute instant.
 *
 * Never throws for a domain refusal: a caller that cannot proceed gets
 * `iso: null` and a finding saying why, exactly as
 * `formatTimingOrUnknown()` returns an explicit unknown rather than inventing a
 * plausible number. Malformed input (a date that is not `YYYY-MM-DD`, a time
 * that is not a clock reading) is also a finding, not a throw, because it
 * arrives from the database and one bad row must not take the page down.
 *
 * @param {Object} input
 * @param {string} input.date - `YYYY-MM-DD`, the season-local calendar date.
 * @param {string|number} input.time - `HH:MM[:SS]` or minutes past midnight.
 * @param {string|null|undefined} input.timeZone - an IANA zone name. Today
 *   always `season_settings.timezone`; see the module note on why this module
 *   does not read it itself.
 * @param {string} [input.label] - what the caller calls this value, for the
 *   human-readable half of a finding. Never parsed.
 * @returns {{ iso: string|null, findings: Array<import('./types.js').TimingFinding> }}
 */
export function resolveZonedInstant({ date, time, timeZone, label = 'wall time' }) {
  /** @type {Array<import('./types.js').TimingFinding>} */
  const findings = [];

  // A wall reading that is not a wall reading is malformed input, not a timing
  // decision, so it throws rather than earning a reason code. Inventing a code
  // for it would put "the database handed us garbage" in the same list as "this
  // season has no clock", and an operator cannot act on the two the same way.
  const dateMatch = typeof date === 'string' ? DATE_PATTERN.exec(date.trim()) : null;
  if (!dateMatch) {
    throw new TypeError(`${label} date must be YYYY-MM-DD, received: ${String(date)}`);
  }
  const minutes = wallMinutesOf(time);
  if (minutes === null) {
    throw new TypeError(`${label} must be a clock reading or minutes, received: ${String(time)}`);
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
        TIMING_REASON.SEASON_TIMEZONE_MISSING,
        `${label} ${date} ${String(time)} names an unknown timezone "${timeZone}"`,
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
    minutes * MS_PER_MINUTE;

  // Probe the offset a day either side of the target as well as at the target
  // itself. Probing only at the target finds one offset even across a
  // transition, which would make a genuinely ambiguous time look unique; the
  // flanking probes are what surface both candidates.
  const candidates = [];
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
 * An error carrying the reason code that caused a refusal.
 *
 * `code` is the contract and `message` is decoration, the same rule the reason
 * registries state — a caller branching on this must read `error.code`.
 */
export class SeasonClockError extends Error {
  /**
   * @param {string} message
   * @param {string} code - a {@link TIMING_REASON} value
   * @param {Array<import('./types.js').TimingFinding>} findings
   */
  constructor(message, code, findings) {
    super(message);
    this.name = 'SeasonClockError';
    this.code = code;
    this.findings = findings;
  }
}

/**
 * {@link resolveZonedInstant}, for call sites that cannot carry a finding and
 * must stop instead.
 *
 * Use this only where refusing is the right outcome — persisting a slot with no
 * clock, for instance. Anywhere the caller can show the operator a reason
 * alongside the rest of the data, prefer `resolveZonedInstant`.
 *
 * @param {Parameters<typeof resolveZonedInstant>[0]} input
 * @returns {string} an ISO instant carrying the season's offset.
 * @throws {SeasonClockError} on any blocking refusal.
 */
export function requireZonedInstant(input) {
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
 * alone — those are not wall readings and guessing at them is the habit this
 * module exists to break.
 *
 * This is the seam the display layer uses, so a label and a persisted instant
 * can never disagree about what a naive string means.
 *
 * @param {unknown} value
 * @param {string|null|undefined} timeZone
 * @returns {{ iso: unknown, findings: Array<import('./types.js').TimingFinding> }}
 *   `iso` is the original value when nothing needed composing, and `null` when
 *   composition was required and refused.
 */
export function anchorToSeasonClock(value, timeZone) {
  if (!isNaiveDateTime(value)) {
    return { iso: value, findings: [] };
  }
  const { date, time } = splitNaiveDateTime(/** @type {string} */ (value));
  return resolveZonedInstant({ date, time, timeZone });
}
