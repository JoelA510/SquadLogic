/**
 * Pure parsers for the `fixtures/season-2026/` regression corpus.
 *
 * Every function here takes a **string** (or an already-parsed JSON value) and
 * returns plain data. Nothing in this module touches the filesystem, so the
 * parsers can be unit-tested on inline strings. The filesystem side lives in
 * `season2026Loader.js`.
 *
 * Design rule for this corpus (see `fixtures/season-2026/README.md`):
 * **preserve, do not flatten.** Rows the current domain model cannot represent
 * are classified with an explicit row kind and carried through with their raw
 * source row attached, never dropped and never coerced. Each place where the
 * domain model falls short carries a `TODO(GAP-nn)` pointing at
 * `docs/MODEL_GAPS.md`.
 *
 * @module fixtures/season2026Parsers
 */

import Papa from 'papaparse';

import { season2026ParityRow } from '../publication/adapters/season2026Publication.js';
import { PARITY_FIELD_ORDER, parityRowKey } from '../publication/rows.js';

/**
 * The placeholder token the source CSVs use for "no opponent" / "not applicable".
 * It appears in `Away` for Minis sessions, unnamed league slots and the single
 * field reservation.
 */
export const PLACEHOLDER_TOKEN = '-';

/** Tokens the permit sheet uses for "no permit at all on this date". */
const NO_VALUE_TOKENS = new Set(['', '-', '—', '–', 'n/a', 'N/A']);

/**
 * Row kinds used to classify every schedule row without dropping any of them.
 *
 * @readonly
 * @enum {string}
 */
export const SEASON_2026_ROW_KIND = {
  /** A published recreational match with two named teams. */
  REC_GAME: 'rec_game',
  /** A Minis (U5 intro) session: always Home, `Away` is the placeholder token. */
  MINIS_SESSION: 'minis_session',
  /** A reserved league slot whose teams were still TBD ("Select Game 7"). */
  LEAGUE_PLACEHOLDER: 'league_placeholder',
  /** An externally-published seeding fixture (may face a non-member club). */
  EXTERNAL_FIXTURE: 'external_fixture',
  /** A scrimmage between two named teams. */
  SCRIMMAGE: 'scrimmage',
  /** A field reservation that is not a game at all ("Scrimmage - teams TBD"). */
  RESERVATION: 'reservation',
};

/** Formats that make up the recreational (published) layer of the season. */
export const REC_FORMATS = Object.freeze(['Minis', '4v4', '5v5', '7v7', '9v9']);

/** Matches the unnamed league slot labels, e.g. `Select Game 10`. */
const UNNAMED_SLOT_RE = /^Select Game \d+$/;

/** Matches labels that announce themselves as not-yet-decided. */
const TBD_LABEL_RE = /\bTBD\b/i;

const WEEKDAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/* -------------------------------------------------------------------------- */
/* Primitive value parsers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Is this cell one of the "no value" tokens used across the corpus?
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isBlankToken(value) {
  return NO_VALUE_TOKENS.has(String(value ?? '').trim());
}

/**
 * Parse the corpus' `MM/DD/YYYY` dates into an ISO calendar date.
 *
 * @param {string} value - e.g. `08/22/2026`
 * @returns {string} ISO date, e.g. `2026-08-22`
 */
export function parseFixtureDate(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new TypeError(`unparseable fixture date: ${JSON.stringify(value)}`);
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Parse a 12-hour wall-clock time into minutes past midnight.
 *
 * Returns `null` for the "no value" tokens (the 09/19 Summit HS row uses an
 * em dash for both open and close to mean "no permit").
 *
 * @param {string} value - e.g. `12:30 PM`
 * @returns {number|null} minutes past midnight, e.g. `750`
 */
export function parseClockMinutes(value) {
  if (isBlankToken(value)) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/);
  if (!match) throw new TypeError(`unparseable clock time: ${JSON.stringify(value)}`);
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  const isPm = match[3].toLowerCase() === 'p';
  if (hour12 < 1 || hour12 > 12 || minute > 59) {
    throw new RangeError(`out-of-range clock time: ${JSON.stringify(value)}`);
  }
  const hour24 = (hour12 % 12) + (isPm ? 12 : 0);
  return hour24 * 60 + minute;
}

/**
 * Render minutes past midnight as a zero-padded 24-hour `HH:MM`.
 *
 * Values past midnight are **not** wrapped — a 24h+ result means a game was
 * scheduled to run past midnight and the caller should notice.
 *
 * @param {number|null} minutes
 * @returns {string|null}
 */
export function formatClockMinutes(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Combine an ISO date with minutes past midnight into a **naive** local
 * datetime string (no offset, no `Z`).
 *
 * **Stays naive, and GAP-30 closing does not change that.** The composer now
 * exists — `timing/seasonClock.js` turns a wall time into an instant against a
 * season's zone — but the arrow points fixtures -> timing and never back, so
 * this parser has no zone to pass it and must not invent one. The corpus is
 * wall-clock only and two of its dates fall after DST ends. A caller that holds
 * the season's timezone composes these; nothing here does.
 *
 * @param {string} isoDate - e.g. `2026-11-07`
 * @param {number|null} minutes
 * @returns {string|null} e.g. `2026-11-07T16:44:00`
 */
export function toNaiveIso(isoDate, minutes) {
  if (minutes === null || minutes === undefined) return null;
  return `${isoDate}T${formatClockMinutes(minutes)}:00`;
}

/**
 * Weekday code (`SAT`, `SUN`, …) for an ISO calendar date.
 *
 * Uses `Date.UTC` so the answer never depends on the host timezone.
 *
 * @param {string} isoDate
 * @returns {string}
 */
export function weekdayCode(isoDate) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAY_CODES[index];
}

/**
 * Parse an integer-or-range cell such as `35`, `85-90 (schedule as 90)`,
 * `5-10` or `30 (in block)`.
 *
 * @param {string} value
 * @returns {{ min: number, max: number, scheduled: number, note: string|null, raw: string }|null}
 */
export function parseMinutesRange(value) {
  const raw = String(value ?? '').trim();
  if (isBlankToken(raw)) return null;

  const noteMatch = raw.match(/\(([^)]*)\)/);
  const note = noteMatch ? noteMatch[1].trim() : null;
  const body = raw.replace(/\([^)]*\)/g, '').trim();

  const rangeMatch = body.match(/^(\d+)\s*-\s*(\d+)$/);
  const singleMatch = body.match(/^(\d+)$/);
  if (!rangeMatch && !singleMatch) {
    throw new TypeError(`unparseable minutes value: ${JSON.stringify(value)}`);
  }

  const min = Number(rangeMatch ? rangeMatch[1] : singleMatch[1]);
  const max = Number(rangeMatch ? rangeMatch[2] : singleMatch[1]);

  // "schedule as N" is the corpus' explicit worst-case instruction (incident 7).
  const scheduledMatch = note && note.match(/schedule as (\d+)/i);
  const scheduled = scheduledMatch ? Number(scheduledMatch[1]) : max;

  return { min, max, scheduled, note, raw };
}

/* -------------------------------------------------------------------------- */
/* CSV plumbing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse a CSV string with the same PapaParse configuration the app's import
 * pipeline uses (`header: true`, `skipEmptyLines: true`).
 *
 * @param {string} text
 * @param {string} label - source file name, used in error messages.
 * @returns {Array<Record<string, string>>}
 */
export function parseCsv(text, label = 'csv') {
  const result = Papa.parse(String(text), { header: true, skipEmptyLines: true });
  const fatal = (result.errors ?? []).filter((error) => error.type !== 'FieldMismatch');
  if (fatal.length > 0) {
    throw new Error(`${label}: ${fatal[0].message} (row ${fatal[0].row})`);
  }
  return /** @type {Array<Record<string, string>>} */ (result.data);
}

export const trim = (value) => String(value ?? '').trim();

/* -------------------------------------------------------------------------- */
/* game_formats.csv                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Season2026Format
 * @property {string} format - `Minis` | `4v4` | `5v5` | `7v7` | `9v9` | `11v11`
 * @property {string} program - human label, e.g. `Select (U14-U19)`
 * @property {number|null} halves
 * @property {number|null} halfMinutes
 * @property {{min:number,max:number}|null} halftimeMinutes
 * @property {{min:number,max:number,scheduled:number,note:string|null,raw:string}} occupancyMinutes
 * @property {number} blockMinutes
 * @property {{minutes:number,note:string|null}|null} turnoverPreferred
 * @property {number|null} turnoverMinMinutes
 * @property {Record<string,string>} raw
 */

/**
 * Parse `game_formats.csv`.
 *
 * TODO(GAP-09/GAP-10/GAP-11): occupancy, play time, halftime range, block and
 * turnover have no home in the current domain model — `GameSlot`/`Assignment`
 * carry a single start/end pair. They are kept here in fixture-native shape.
 *
 * @param {string} text
 * @returns {Season2026Format[]}
 */
export function parseGameFormats(text) {
  return parseCsv(text, 'game_formats.csv').map((row) => {
    const halftime = parseMinutesRange(row['Halftime min']);
    const halves = parseMinutesRange(row['Halves']);
    const halfMinutes = parseMinutesRange(row['Half min']);
    const occupancy = parseMinutesRange(row['Occupancy min']);
    const block = parseMinutesRange(row['Block min']);
    const turnoverPreferred = parseMinutesRange(row['Turnover preferred']);
    const turnoverMin = parseMinutesRange(row['Turnover min']);

    if (!occupancy) throw new Error(`game_formats.csv: missing occupancy for ${row['Format']}`);
    if (!block) throw new Error(`game_formats.csv: missing block for ${row['Format']}`);

    return {
      format: trim(row['Format']),
      program: trim(row['Program']),
      halves: halves ? halves.max : null,
      halfMinutes: halfMinutes ? halfMinutes.max : null,
      halftimeMinutes: halftime ? { min: halftime.min, max: halftime.max } : null,
      occupancyMinutes: occupancy,
      blockMinutes: block.max,
      turnoverPreferred: turnoverPreferred
        ? { minutes: turnoverPreferred.max, note: turnoverPreferred.note }
        : null,
      turnoverMinMinutes: turnoverMin ? turnoverMin.max : null,
      raw: row,
    };
  });
}

/**
 * Index formats by name for O(1) lookup.
 *
 * @param {Season2026Format[]} formats
 * @returns {Record<string, Season2026Format>}
 */
export function indexFormats(formats) {
  const byName = /** @type {Record<string, Season2026Format>} */ ({});
  for (const format of formats) byName[format.format] = format;
  return byName;
}

/**
 * The number of minutes a game of this format occupies its field.
 *
 * Returns `null` when the corpus has no timing row for the format at all —
 * TODO(GAP-14): `Scrimmage` rows appear in `combined_schedule.csv` but have no
 * `game_formats.csv` entry, so their footprint is genuinely unknown. We surface
 * `null` rather than inventing a duration.
 *
 * @param {Record<string, Season2026Format>} formatsByName
 * @param {string} formatName
 * @returns {number|null}
 */
export function scheduledOccupancyMinutes(formatsByName, formatName) {
  const format = formatsByName[trim(formatName)];
  if (!format) return null;
  return format.occupancyMinutes.scheduled;
}

/* -------------------------------------------------------------------------- */
/* facility_permits.csv                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Season2026Permit
 * @property {string} venue
 * @property {string} scope - raw scope text, e.g. `SAT default`, `SUN 08/23 only`
 * @property {'weekday-default'|'date-exception'} scopeKind
 * @property {string|null} weekday - `SAT` / `SUN`
 * @property {string|null} monthDay - `08/23` for date-scoped rows
 * @property {string|null} date - resolved ISO date when a season year is known
 * @property {boolean} hasPermit - false for the explicit "NO PERMIT" row
 * @property {number|null} openMinutes
 * @property {number|null} closeMinutes
 * @property {boolean|null} lit - `null` when the geometry states nothing
 * @property {string} notes
 * @property {Record<string,string>} raw
 */

/**
 * Parse `facility_permits.csv`.
 *
 * TODO(GAP-07/GAP-08): there is no venue-availability entity in the domain
 * model, and no representation for a per-venue-per-date exception (Summit HS
 * opens early on 09/12 and has **no permit at all** on 09/19).
 *
 * TODO(GAP-12): the `Notes` column carries a load-bearing rule in free text
 * ("traffic constraint: 20-min turnover HARD" at Orchard Park). It is kept
 * verbatim because there is no constraint record with a hardness and a scope
 * to parse it into.
 *
 * @param {string} text
 * @param {{ seasonYear?: number|string }} [options] - year used to resolve the
 *   date-scoped rows, which carry only `MM/DD`.
 * @returns {Season2026Permit[]}
 */
export function parseFacilityPermits(text, options = {}) {
  const seasonYear = options.seasonYear ?? null;
  return parseCsv(text, 'facility_permits.csv').map((row) => {
    const scope = trim(row['Scope']);
    const weekdayMatch = scope.match(/^([A-Z]{3})\b/);
    const monthDayMatch = scope.match(/(\d{1,2}\/\d{1,2})/);
    const monthDay = monthDayMatch ? monthDayMatch[1] : null;
    const openMinutes = parseClockMinutes(row['Open']);
    const closeMinutes = parseClockMinutes(row['Close']);

    let date = null;
    if (monthDay && seasonYear !== null) {
      const [month, day] = monthDay.split('/');
      date = `${seasonYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    return {
      venue: trim(row['Venue']),
      scope,
      scopeKind: monthDay ? 'date-exception' : 'weekday-default',
      weekday: weekdayMatch ? weekdayMatch[1] : null,
      monthDay,
      date,
      hasPermit: openMinutes !== null && closeMinutes !== null,
      openMinutes,
      closeMinutes,
      lit: /^y/i.test(trim(row['Lit'])),
      notes: trim(row['Notes']),
      raw: row,
    };
  });
}

/**
 * Resolve which permit row governs a venue on a given date.
 *
 * Date-scoped exceptions win over the weekday default. Returns `null` when the
 * corpus has nothing to say about that venue on that weekday.
 *
 * @param {Season2026Permit[]} permits
 * @param {{ venue: string, date: string }} query
 * @returns {Season2026Permit|null}
 */
export function resolvePermit(permits, { venue, date }) {
  const forVenue = permits.filter((permit) => permit.venue === venue);
  const exact = forVenue.find((permit) => permit.date === date);
  if (exact) return exact;
  const weekday = weekdayCode(date);
  return (
    forVenue.find(
      (permit) => permit.scopeKind === 'weekday-default' && permit.weekday === weekday
    ) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* sunsets.csv                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Season2026Sunset
 * @property {string} date - ISO date
 * @property {number} sunsetMinutes
 * @property {string} sunset - `HH:MM`
 * @property {string} note
 */

/**
 * Parse `sunsets.csv`.
 *
 * TODO(GAP-06): nothing in the domain model represents daylight, so the
 * "unlit games must end 15 minutes before sunset" rule has nowhere to live.
 *
 * @param {string} text
 * @returns {Season2026Sunset[]}
 */
export function parseSunsets(text) {
  return parseCsv(text, 'sunsets.csv').map((row) => {
    const date = parseFixtureDate(row['Date']);
    const sunsetMinutes = parseClockMinutes(row['Sunset']);
    if (sunsetMinutes === null) throw new Error(`sunsets.csv: missing sunset for ${date}`);
    return {
      date,
      sunsetMinutes,
      sunset: /** @type {string} */ (formatClockMinutes(sunsetMinutes)),
      note: trim(row['Note']),
    };
  });
}

/**
 * Sunset (minutes past midnight) for an ISO date, or `null` when unknown.
 *
 * @param {Season2026Sunset[]} sunsets
 * @param {string} date
 * @returns {number|null}
 */
export function resolveSunsetMinutes(sunsets, date) {
  return sunsets.find((entry) => entry.date === date)?.sunsetMinutes ?? null;
}

/* -------------------------------------------------------------------------- */
/* facility_geometry.json                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Season2026Field
 * @property {string} id - `<venue>::<field>`
 * @property {string} venue
 * @property {string} name
 * @property {string[]} sizes - formats the field is big enough for
 * @property {string[]} lined - formats actually lined this season
 * @property {string|null} parent
 * @property {string[]} children
 * @property {string|null} note
 */

/**
 * @typedef {Object} Season2026Venue
 * @property {string} name
 * @property {boolean} lit
 * @property {Season2026Field[]} fields
 * @property {Array<[string, string]>} overlapPairs
 * @property {string|null} overlapNote
 * @property {string|null} notes
 */

/**
 * Compose the stable field id used across this fixture.
 *
 * TODO(GAP-01): the domain model has only opaque `fieldId` / `location_id`
 * strings, so venue and field have to be flattened into one key here.
 *
 * @param {string} venue
 * @param {string} field
 * @returns {string}
 */
export function makeFieldId(venue, field) {
  return `${venue}::${field}`;
}

/**
 * Parse `facility_geometry.json`.
 *
 * TODO(GAP-02/GAP-03/GAP-04/GAP-05/GAP-25): parent/child sub-fields, spatial
 * overlap pairs, size-vs-lining eligibility, per-venue lighting and date-scoped
 * equipment all survive only in this fixture-native shape.
 *
 * @param {string|Object} source - JSON text or an already-parsed object.
 * @returns {{ venues: Season2026Venue[], fields: Season2026Field[], equipmentExceptions: Array<Object> }}
 */
export function parseFacilityGeometry(source) {
  const doc = typeof source === 'string' ? JSON.parse(source) : source;
  /** @type {Season2026Venue[]} */
  const venues = [];
  /** @type {Season2026Field[]} */
  const fields = [];

  for (const [venueName, venueDoc] of Object.entries(doc.venues ?? {})) {
    /** @type {Season2026Field[]} */
    const venueFields = [];
    for (const [fieldName, fieldDoc] of Object.entries(venueDoc.fields ?? {})) {
      const field = {
        id: makeFieldId(venueName, fieldName),
        venue: venueName,
        name: fieldName,
        sizes: [...(fieldDoc.sizes ?? [])],
        lined: [...(fieldDoc.lined ?? [])],
        parent: fieldDoc.parent ?? null,
        children: [...(fieldDoc.children ?? [])],
        note: fieldDoc.note ?? null,
      };
      venueFields.push(field);
      fields.push(field);
    }
    venues.push({
      name: venueName,
      // Absent is not `false`: the practice corpus's venues state nothing (GAP-05).
      lit: typeof venueDoc.lit === 'boolean' ? venueDoc.lit : null,
      fields: venueFields,
      overlapPairs: (venueDoc.overlap_pairs ?? []).map((pair) => [pair[0], pair[1]]),
      overlapNote: venueDoc.overlap_note ?? null,
      notes: venueDoc.notes ?? null,
    });
  }

  return {
    venues,
    fields,
    equipmentExceptions: [...(doc.equipment_exceptions ?? [])],
  };
}

/**
 * The field whose identity governs overlap: a sub-field resolves to its parent.
 *
 * The corpus states this explicitly ("Overlap applies to a parent's halves
 * too: a game on 1A conflicts with a concurrent game on 2").
 *
 * @param {Season2026Venue|undefined} venue
 * @param {string} fieldName
 * @returns {string}
 */
export function overlapRootField(venue, fieldName) {
  const field = venue?.fields.find((entry) => entry.name === fieldName);
  return field?.parent ?? fieldName;
}

/**
 * Do two fields at a venue physically overlap (so they can never host
 * concurrent games)? Sub-fields inherit their parent's overlaps.
 *
 * @param {Season2026Venue|undefined} venue
 * @param {string} fieldA
 * @param {string} fieldB
 * @returns {boolean}
 */
export function fieldsOverlap(venue, fieldA, fieldB) {
  if (!venue) return false;
  // The same patch of grass always conflicts with itself.
  if (fieldA === fieldB) return true;
  const rootA = overlapRootField(venue, fieldA);
  const rootB = overlapRootField(venue, fieldB);
  // A parent and one of its own halves are the same ground.
  if (rootA === fieldB || rootB === fieldA) return true;
  // Sibling halves of one parent are deliberately independent.
  if (rootA === rootB) return false;
  return venue.overlapPairs.some(
    ([left, right]) => (left === rootA && right === rootB) || (left === rootB && right === rootA)
  );
}

/* -------------------------------------------------------------------------- */
/* coach_roster.csv                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Season2026CoachAssignment
 * @property {string} teamCode
 * @property {string} firstName
 * @property {string} lastName
 * @property {number} coachSlot - 1 is the team's primary coach
 * @property {string} personKey
 * @property {string} status
 * @property {Record<string,string>} raw
 */

/**
 * Parse `coach_roster.csv` (or `coach_roster_v1.csv` — identical shape).
 *
 * TODO(GAP-20/GAP-23): `Coach Slot` and `Status` have no domain equivalent.
 * `Team` offers `coachId` + `assistantCoachIds[]`, which loses slot ordering,
 * and there is no assignment-status enum anywhere.
 *
 * @param {string} text
 * @returns {Season2026CoachAssignment[]}
 */
export function parseCoachRoster(text) {
  return parseCsv(text, 'coach_roster.csv').map((row) => ({
    teamCode: trim(row['Team Code']),
    firstName: trim(row['Coach First']),
    lastName: trim(row['Coach Last']),
    coachSlot: Number(trim(row['Coach Slot'])),
    personKey: trim(row['Person Key']),
    status: trim(row['Status']),
    raw: row,
  }));
}

/* -------------------------------------------------------------------------- */
/* schedule CSVs                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Classify a schedule row without reference to any other row, so the same rule
 * works on `published_rec_schedule.csv` and `combined_schedule.csv` alike.
 *
 * Deliberately structural (format + placeholder token + label shape) rather
 * than date-based: incident 4 in the fixture README is a checker that misread
 * placeholder labels as team codes.
 *
 * @param {{ format: string, home: string, away: string }} row
 * @returns {string} a {@link SEASON_2026_ROW_KIND} value
 */
export function classifyScheduleRow({ format, home, away }) {
  const formatName = trim(format);
  const homeLabel = trim(home);
  const awayLabel = trim(away);
  const awayIsPlaceholder = awayLabel === PLACEHOLDER_TOKEN;

  if (formatName === 'Minis') return SEASON_2026_ROW_KIND.MINIS_SESSION;
  if (formatName === 'Scrimmage') {
    return awayIsPlaceholder ? SEASON_2026_ROW_KIND.RESERVATION : SEASON_2026_ROW_KIND.SCRIMMAGE;
  }
  if (awayIsPlaceholder) {
    return UNNAMED_SLOT_RE.test(homeLabel) || TBD_LABEL_RE.test(homeLabel)
      ? SEASON_2026_ROW_KIND.LEAGUE_PLACEHOLDER
      : SEASON_2026_ROW_KIND.RESERVATION;
  }
  if (REC_FORMATS.includes(formatName)) return SEASON_2026_ROW_KIND.REC_GAME;
  return SEASON_2026_ROW_KIND.EXTERNAL_FIXTURE;
}

/**
 * @typedef {Object} Season2026Game
 * @property {string} id - stable `<source>#<rowIndex>` identifier
 * @property {string} source - source file name
 * @property {number} rowIndex - zero-based index within the source file
 * @property {string} kind - a {@link SEASON_2026_ROW_KIND} value
 * @property {string} date - ISO date
 * @property {number} kickoffMinutes
 * @property {string} kickoff - `HH:MM`
 * @property {string} venue
 * @property {string} field
 * @property {string} fieldId - `<venue>::<field>`
 * @property {string} format
 * @property {string} division
 * @property {string} homeLabel - raw `Home` cell
 * @property {string} awayLabel - raw `Away` cell
 * @property {string|null} homeTeamId - null when the home side is a placeholder
 * @property {string|null} awayTeamId - null when there is no opponent
 * @property {boolean} homeIsPlaceholder
 * @property {boolean} awayIsPlaceholder
 * @property {number|null} durationMinutes - null when the format has no timing row
 * @property {number|null} endMinutes
 * @property {string} start - naive local ISO datetime
 * @property {string|null} end - naive local ISO datetime, null when unknown
 * @property {string} slotKey - `<date>|<fieldId>|<kickoff>`
 * @property {Record<string,string>} raw
 */

/**
 * Parse a schedule CSV (`published_rec_schedule.csv` / `combined_schedule.csv`).
 *
 * Every source row produces exactly one output record. Nothing is filtered.
 *
 * TODO(GAP-13/GAP-15/GAP-16/GAP-17/GAP-18): `format`, opponent-less sessions,
 * unnamed league slots, non-game field reservations and non-member opponents
 * have no representation in `Event` / `AssignmentSchema`, which require a
 * truthy `awayTeamId` and know nothing about venues or formats.
 *
 * TODO(GAP-32): rows carry a calendar date, not the `weekIndex` the scheduling
 * engine works in. The rec layer skips 09/05 and 10/10 while the Select layer
 * plays on 10/10, so the two cannot be reconciled without a season calendar.
 *
 * @param {string} text
 * @param {{ source?: string, formatsByName?: Record<string, Season2026Format> }} [options]
 * @returns {Season2026Game[]}
 */
export function parseScheduleCsv(text, options = {}) {
  const source = options.source ?? 'schedule.csv';
  const formatsByName = options.formatsByName ?? {};

  return parseCsv(text, source).map((row, rowIndex) => {
    const date = parseFixtureDate(row['Date']);
    const kickoffMinutes = parseClockMinutes(row['Kickoff']);
    if (kickoffMinutes === null) {
      throw new Error(`${source} row ${rowIndex}: missing kickoff time`);
    }
    const venue = trim(row['Venue']);
    const field = trim(row['Field']);
    const format = trim(row['Format']);
    const homeLabel = trim(row['Home']);
    const awayLabel = trim(row['Away']);
    const kind = classifyScheduleRow({ format, home: homeLabel, away: awayLabel });

    const homeIsPlaceholder = UNNAMED_SLOT_RE.test(homeLabel) || TBD_LABEL_RE.test(homeLabel);
    const awayIsPlaceholder = awayLabel === PLACEHOLDER_TOKEN;

    // TODO(GAP-14): unknown for `Scrimmage`, which has no game_formats.csv row.
    // We keep the row and leave the footprint null rather than guessing.
    const durationMinutes = scheduledOccupancyMinutes(formatsByName, format);
    const endMinutes = durationMinutes === null ? null : kickoffMinutes + durationMinutes;
    const fieldId = makeFieldId(venue, field);
    const kickoff = /** @type {string} */ (formatClockMinutes(kickoffMinutes));

    return {
      id: `${source}#${rowIndex}`,
      source,
      rowIndex,
      kind,
      date,
      kickoffMinutes,
      kickoff,
      venue,
      field,
      fieldId,
      format,
      division: trim(row['Division']),
      homeLabel,
      awayLabel,
      homeTeamId: homeIsPlaceholder ? null : homeLabel,
      awayTeamId: awayIsPlaceholder ? null : awayLabel,
      homeIsPlaceholder,
      awayIsPlaceholder,
      durationMinutes,
      endMinutes,
      start: /** @type {string} */ (toNaiveIso(date, kickoffMinutes)),
      end: toNaiveIso(date, endMinutes),
      slotKey: `${date}|${fieldId}|${kickoff}`,
      raw: row,
    };
  });
}

/**
 * The publication-parity key: date, kickoff, venue, field, format, division and
 * both sides. Two rows with the same key are the same published fixture.
 *
 * **The comparator that used to be built on this has moved.**
 * `tests/season2026Fixture.test.js` once counted keys into a map by hand;
 * `packages/core/src/publication/parity.js` `checkParity()` is the production
 * checker now, and this function delegates to that package's single key
 * derivation rather than keeping a second spelling of it. It stays because the
 * corpus's *full* published identity — every parity field at once, rather than
 * the date-plus-both-sides key a parity subject usually runs on — is a useful
 * thing to be able to ask for.
 *
 * The key text changed shape when it moved: the kickoff is now minutes past
 * midnight rather than `HH:MM`, and a trailing empty cell appears for the
 * `participant` field that only per-team artifacts carry. Nothing parses a key,
 * so the only property that matters is that two rows share it exactly when they
 * agree on all eight of the columns a schedule row has.
 *
 * @param {Season2026Game} game
 * @returns {string}
 */
export function publicationKey(game) {
  return parityRowKey(
    season2026ParityRow(game, 'season2026Parsers.publicationKey'),
    PARITY_FIELD_ORDER
  );
}

/* -------------------------------------------------------------------------- */
/* external_fixtures_published.csv                                             */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Season2026ExternalFixture
 * @property {string} date - ISO date
 * @property {number} kickoffMinutes
 * @property {string} kickoff - `HH:MM`
 * @property {string} externalVenueLabel - the external league's own naming
 * @property {string|null} venue - resolved club venue when parseable
 * @property {string|null} field - resolved club field when parseable
 * @property {string} homeLabel
 * @property {string} awayLabel
 * @property {boolean} awayIsExternalClub
 * @property {Record<string,string>} raw
 */

/**
 * Parse `external_fixtures_published.csv` — the external league's published
 * times, which differ from the agreed times in `combined_schedule.csv`.
 *
 * The `Venue (external naming)` column uses the other league's names
 * (`Alder Park (Back Pitch 2)`); we keep the raw label **and** a best-effort
 * resolution, never replacing one with the other.
 *
 * The regex below is **the** external-naming transform and it is deliberately
 * fixture-local: it knows the shape of one file's one column. The production
 * field-name mapping (`publication/parity.js`) matches exact labels rather than
 * patterns, and `publication/adapters/season2026Publication.js`
 * `season2026ExternalVenueMapping()` records *this* split as mapping rules with
 * provenance rather than re-deriving it. One transform, two representations —
 * never two transforms.
 *
 * TODO(GAP-18/GAP-19): there is no external-club entity and no external
 * commitment timeline, so these rows cannot be represented as domain
 * assignments.
 *
 * @param {string} text
 * @returns {Season2026ExternalFixture[]}
 */
export function parseExternalFixtures(text) {
  return parseCsv(text, 'external_fixtures_published.csv').map((row) => {
    const externalVenueLabel = trim(row['Venue (external naming)']);
    const match = externalVenueLabel.match(/^(.*?)\s*\((?:Back\s+)?(.*?)\)$/);
    const kickoffMinutes = parseClockMinutes(row['Time']);
    if (kickoffMinutes === null) {
      throw new Error('external_fixtures_published.csv: missing kickoff time');
    }
    const awayLabel = trim(row['Away']);
    return {
      date: parseFixtureDate(row['Date']),
      kickoffMinutes,
      kickoff: /** @type {string} */ (formatClockMinutes(kickoffMinutes)),
      externalVenueLabel,
      venue: match ? match[1].trim() : null,
      field: match ? match[2].trim() : null,
      homeLabel: trim(row['Home']),
      awayLabel,
      awayIsExternalClub: /\s-\s/.test(awayLabel),
      raw: row,
    };
  });
}
