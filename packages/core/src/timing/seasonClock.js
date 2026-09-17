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
 * turn a **zone-less** string into an instant: `SlotSchema`, `AssignmentSchema`
 * and `normalizeTimestamp()` all refuse one outright — a naive wall date-time
 * *and* a bare `YYYY-MM-DD`, which `new Date()` reads as UTC midnight and which
 * therefore used to slip past a sentence that named only the first. The
 * predicate all three read is {@link isZonelessTimestamp}, which states why the
 * two cases are refused together and why {@link anchorToSeasonClock} still
 * leaves the date-only one alone. `tests/sourceHygiene.test.js` holds the line
 * inside `timing/`.
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
/**
 * The separator between a date and a wall time.
 *
 * `T` is the ISO spelling; a single space is what Postgres renders a
 * `timestamp without time zone` as, and a value in that spelling is exactly as
 * zone-less as the ISO one. Accepting only `T` classified
 * `'2026-11-07 16:44:00'` as *not* naive, which let it through to a host-zone
 * parse -- the one answer this module exists to give, given wrong.
 */
const DATE_TIME_SEPARATOR = '[T ]';

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * Is this string a naive (zone-less) `YYYY-MM-DDTHH:MM[:SS]` date-time?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNaiveDateTime(value) {
  if (typeof value !== 'string') return false;
  return new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}${DATE_TIME_SEPARATOR}\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?$`
  ).test(value.trim());
}

/** A bare `YYYY-MM-DD` with no clock of any kind. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this string a moment with **no zone attached at all** — either a naive
 * wall date-time, or a bare calendar date?
 *
 * ## Why this is a second predicate rather than a wider `isNaiveDateTime`
 *
 * The two callers want different answers about `'2026-11-07'`, and both are
 * right:
 *
 * - {@link anchorToSeasonClock} must leave it alone. A date with no clock is
 *   not a wall *reading*; there is nothing to compose and
 *   {@link splitNaiveDateTime} would hand `resolveZonedInstant` an empty time.
 *   Its own contract says so by name.
 * - `InstantSchema` and `normalizeTimestamp()` must refuse it. Both stand in
 *   front of a `timestamptz`, and `new Date('2026-11-07')` is spec'd as UTC
 *   midnight -- so the value did not fail, it silently acquired a zone nobody
 *   chose. For a season on `America/Los_Angeles` that instant is 5 PM on the
 *   **previous day** locally: not the host-dependent spread GAP-30 was about,
 *   but the same class of answer, confidently wrong and impossible to see.
 *   A slot or an assignment has no reading in which a start time of "some
 *   moment on the 7th" is the value that was meant.
 *
 * Until this existed, the module header's claim that those schemas "refuse
 * [a zone-less value] outright" was true of `'2026-11-07T00:00'` and false of
 * `'2026-11-07'`, which is the narrower half of the same hole.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isZonelessTimestamp(value) {
  if (typeof value !== 'string') return false;
  return isNaiveDateTime(value) || DATE_ONLY_PATTERN.test(value.trim());
}

/**
 * Split a naive `YYYY-MM-DDTHH:MM[:SS]` string into its date and time halves.
 *
 * Deliberately **not** exported. `publication/rows.js` already exports a
 * `splitNaiveDateTime` with a different return shape (`{ date, startMinutes }`),
 * and two functions of the same name reachable from two barrels is a caller
 * destructuring `undefined` under `strict: false`. The one public entry point
 * for a naive value is {@link anchorToSeasonClock}.
 *
 * @param {string} value
 * @returns {{ date: string, time: string }}
 */
function splitNaiveDateTime(value) {
  const trimmed = String(value).trim();
  const at = trimmed.search(/[T ]/);
  return { date: trimmed.slice(0, at), time: trimmed.slice(at + 1) };
}

/**
 * Parse a wall time into **seconds** past midnight.
 *
 * Seconds rather than minutes because `game_slots.start_time` is a Postgres
 * `time`, which carries them: reading `16:44:30` and composing `16:44:00` would
 * shift a slot by up to 59 seconds and then evaluate `end > start` against the
 * shifted values. The field is honoured rather than validated-and-dropped.
 *
 * A number is taken as the domain representation -- minutes past midnight -- so
 * a caller holding that does not have to render it to a string first.
 *
 * ## `24:00:00` is midnight *ending* the day, and it composes
 *
 * Postgres's `time` legally stores `24:00:00`, and `game_slots_time_check
 * (end_time > start_time)` permits a `22:00` -> `24:00` slot, so an end time of
 * midnight is data nobody typed wrong. `new Date('2026-07-04T24:00:00')`
 * composed it as the next day's midnight, and refusing it here would be a
 * regression dressed as strictness.
 *
 * It is the *only* hour-24 value that means anything: `24:30` names no instant,
 * so it still refuses. The day roll needs no special case downstream -- the
 * pseudo-UTC arithmetic in {@link resolveZonedInstant} carries
 * `Date.UTC(y, m, d) + 86400s` into the next day's midnight, which the zone
 * reads back as exactly that, so the candidate check matches normally. That
 * includes a `24:00` on a DST boundary, which lands on the post-transition
 * offset because that is the offset in force at the instant it names.
 *
 * @param {string|number} time
 * @returns {number|null} seconds past midnight (0 to 86400), or `null` if
 *   unreadable.
 */
function wallSecondsOf(time) {
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
 * **Never throws.** A caller that cannot proceed gets `iso: null` and a finding
 * saying why, exactly as `formatTimingOrUnknown()` returns an explicit unknown
 * rather than inventing a plausible number. Malformed input -- a date that is
 * not `YYYY-MM-DD`, a clock the day does not contain -- is a finding too, and
 * that is not politeness: these values arrive from the database and are read on
 * a React render path. Postgres's `time` legally stores `24:00:00`, so the
 * unreadable case is reachable from data nobody typed wrong, and a throw there
 * would take a panel down where the old code printed "unspecified time".
 * {@link requireZonedInstant} is the wrapper for call sites that must stop.
 *
 * @param {Object} input
 * @param {string} input.date - `YYYY-MM-DD`, the season-local calendar date.
 *   A day the calendar does not contain (`2026-02-30`, `2026-13-45`) is
 *   {@link TIMING_REASON.WALL_TIME_UNREADABLE}, not a silently rolled-over
 *   instant.
 * @param {string|number} input.time - `HH:MM[:SS]` or minutes past midnight.
 *   `24:00[:00]` (and `1440`) is midnight ending the day and composes to the
 *   next day's start; `24:30` names no instant and is refused.
 * @param {string|null} [input.timeZone] - an IANA zone name. Today
 *   always `season_settings.timezone`; see the module note on why this module
 *   does not read it itself.
 * @param {string} [input.label] - what the caller calls this value, for the
 *   human-readable half of a finding. Never parsed.
 * @returns {{ iso: string|null, findings: Array<import('./types.js').TimingFinding> }}
 */
export function resolveZonedInstant({ date, time, timeZone, label = 'wall time' }) {
  /** @type {Array<import('./types.js').TimingFinding>} */
  const findings = [];

  // A wall reading that is not a wall reading gets its own code rather than
  // sharing SEASON_TIMEZONE_MISSING: an operator cannot act on "the database
  // handed us a time the day does not contain" and "this season has no clock"
  // the same way, and `code` is the contract.
  const dateMatch = typeof date === 'string' ? DATE_PATTERN.exec(date.trim()) : null;
  const seconds = wallSecondsOf(time);
  // A day that does not exist is not a shape error, so the pattern alone cannot
  // see it: `Date.UTC` rolls `2026-02-30` forward to March 2nd and
  // `2026-13-45` to February 2027, silently, and the composer would return a
  // confidently wrong instant -- the exact result this module exists to
  // prevent. Reading the fields back is the only way to catch it.
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
