/**
 * Sunset, computed: the NOAA solar-position equations, read onto the season's
 * wall clock.
 *
 * ## The ruling
 *
 * Operator ruling 2026-09-24, "use the best available data/formula": sunset is
 * computed with the equations of NOAA's solar calculator spreadsheet and its web
 * twin, solcalc, at the standard sunset zenith of 90.833 degrees (the 0.833 is
 * refraction at the horizon plus the sun's apparent radius). Nothing is fetched
 * at runtime and nothing geocodes: the caller hands the coordinates in.
 *
 * **Nothing in production calls this yet.** The daylight provider that turns a
 * venue's coordinates into a per-date limit is 8.9 PR 4; until it lands, the
 * date-keyed `sunsets.csv` table is the only sunset any evaluator reads.
 * `tests/unwiredLayerImporters.test.js` pins that, so the first production
 * caller fails the pin and the PR adding it has to edit the pin and this note.
 *
 * ## The clock
 *
 * The UTC offset is the IANA zone's **on that date**, read through
 * {@link resolveZonedInstant}. This module adopts that function's contract
 * whole: it never throws on its input, and a refusal is `minutes: null` plus a finding whose
 * `code` is the contract -- the season clock's own codes for an unreadable date
 * or a missing or unknown zone, and the two sunset codes in `reasonCodes.js`.
 * No daylight-saving rule is written here and the host's zone is never read, so
 * the 2026-11-01 fall-back reaches this file from the zone, not from a table.
 *
 * The offset is read at 12:00 wall time on `date`. IANA zones change offset
 * overnight, so that is the offset in force at sunset; a zone that changed
 * between noon and sunset would be misread by the size of the change. Stated
 * rather than guarded, because no zone does it.
 *
 * ## The answer
 *
 * `minutes` is **fractional** minutes past local midnight of `date`, on the
 * season's wall clock. It is the sunset of the solar day whose noon falls
 * nearest 12:00 on that clock, so a zone far from its meridian (across the date
 * line) still gets the evening of `date` rather than of a neighbouring day, and
 * a sub-arctic summer sunset after midnight reads past 1440 rather than wrapping
 * to the morning. Enforcement rounds it with {@link sunsetEnforcementMinutes}.
 *
 * `Date` is never constructed here (`timing/index.js`, held by
 * `tests/sourceHygiene.test.js`); `Date.UTC` reads explicit fields and is the
 * only date function used.
 *
 * @module timing/solar
 */

import { TIMING_REASON, makeTimingFinding } from './reasonCodes.js';
import { resolveZonedInstant } from './seasonClock.js';

/**
 * The sunset zenith in degrees: the geometric 90 plus 0.833 for refraction and
 * the sun's semi-diameter. NOAA's value. `tests/solar.test.js` fails if it is
 * changed to 90.
 */
export const SUNSET_ZENITH_DEGREES = 90.833;

/**
 * How many times the solar equations are evaluated per sunset. The first pass
 * is at local solar noon; every later pass is at the sunset instant the one
 * before produced, which is solcalc's refinement run once more.
 */
const SUNSET_EVALUATIONS = 3;

const MINUTES_PER_DAY = 1440;
const MS_PER_DAY = 86_400_000;
/** Julian day of the Unix epoch, 1970-01-01T00:00Z. */
const JULIAN_DAY_OF_UNIX_EPOCH = 2440587.5;
/** Julian day of J2000.0, 2000-01-01T12:00Z. */
const JULIAN_DAY_OF_J2000 = 2451545;
const DAYS_PER_JULIAN_CENTURY = 36525;

/** The offset suffix `resolveZonedInstant()` always writes: `-05:00`, `+00:00`. */
const OFFSET_SUFFIX = /([+-])(\d{2}):(\d{2})$/;

/**
 * Offsets already read, keyed by the trimmed zone and date. A fit or a season
 * asks for the same few hundred dates many times, and each read costs several
 * `Intl.DateTimeFormat` calls. One entry per distinct zone and date that
 * resolved -- a season is a few hundred -- never evicted. Only string inputs
 * are keyed and only successful reads kept, so anything else goes through
 * `resolveZonedInstant()` and its refusal every time.
 *
 * @type {Map<string, number>}
 */
const offsetCache = new Map();

/** @param {number} degrees */
const toRadians = (degrees) => (degrees * Math.PI) / 180;
/** @param {number} radians */
const toDegrees = (radians) => (radians * 180) / Math.PI;

/**
 * @typedef {Object} SunsetOnDate
 * @property {number|null} minutes - fractional minutes past local midnight of
 *   `date` on the season's wall clock; `null` exactly when `code` is set.
 * @property {string|null} code - `null` for a sunset; otherwise the refusal's
 *   reason code, the same value as `findings[0].code`.
 * @property {Array<import('./types.js').TimingFinding>} findings - empty for a
 *   sunset; the one refusal otherwise.
 */

/**
 * The sun's declination and the equation of time at a Julian day: the NOAA
 * spreadsheet's columns, in its order.
 *
 * @param {number} julianDay
 * @returns {{ declination: number, equationOfTime: number }} declination in
 *   radians, equation of time in minutes.
 */
function solarPosition(julianDay) {
  const t = (julianDay - JULIAN_DAY_OF_J2000) / DAYS_PER_JULIAN_CENTURY;
  const meanLongitude = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const meanAnomaly = toRadians(357.52911 + t * (35999.05029 - 0.0001537 * t));
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const equationOfCenter =
    Math.sin(meanAnomaly) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly) * 0.000289;
  const omega = toRadians(125.04 - 1934.136 * t);
  const apparentLongitude = toRadians(
    meanLongitude + equationOfCenter - 0.00569 - 0.00478 * Math.sin(omega)
  );
  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = toRadians(meanObliquity + 0.00256 * Math.cos(omega));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));
  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = toRadians(meanLongitude);
  const equationOfTime =
    4 *
    toDegrees(
      y * Math.sin(2 * l0) -
        2 * eccentricity * Math.sin(meanAnomaly) +
        4 * eccentricity * y * Math.sin(meanAnomaly) * Math.cos(2 * l0) -
        0.5 * y * y * Math.sin(4 * l0) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly)
    );
  return { declination, equationOfTime };
}

/**
 * The zone's UTC offset on `date`, in minutes, or the season clock's refusal.
 *
 * @param {string} date
 * @param {string|null|undefined} timeZone
 * @returns {{ offsetMinutes: number|null, findings: Array<import('./types.js').TimingFinding> }}
 */
function offsetOn(date, timeZone) {
  // Keyed on strings only, trimmed as `resolveZonedInstant()` trims them, so a
  // value that merely stringifies like a date can never hit an entry and skip
  // the validation that call performs.
  const key =
    typeof date === 'string' && typeof timeZone === 'string'
      ? `${timeZone.trim()}|${date.trim()}`
      : null;
  const cached = key === null ? undefined : offsetCache.get(key);
  if (cached !== undefined) return { offsetMinutes: cached, findings: [] };
  const { iso, findings } = resolveZonedInstant({
    date,
    time: '12:00',
    timeZone,
    label: 'sunset date',
  });
  if (iso === null) return { offsetMinutes: null, findings };
  const match = OFFSET_SUFFIX.exec(iso);
  // `resolveZonedInstant()` documents the offset form as its output, never `Z`.
  // A break there is this package's defect, not the caller's input, so it is
  // named here rather than dressed up as a refusal.
  if (!match) throw new Error(`resolveZonedInstant() returned no offset: ${iso}`);
  const offsetMinutes = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  if (key !== null) offsetCache.set(key, offsetMinutes);
  return { offsetMinutes, findings: [] };
}

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {value is number}
 */
function isDegreesWithin(value, limit) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

/**
 * @param {Array<import('./types.js').TimingFinding>} findings - exactly one
 * @returns {SunsetOnDate}
 */
function refused(findings) {
  return { minutes: null, code: findings[0].code, findings };
}

/**
 * Sunset on a date at a place, on the season's wall clock.
 *
 * **Never throws on its input.** See the module note for the clock, the day chosen and what
 * `null` means.
 *
 * @param {Object} input
 * @param {string} input.date - `YYYY-MM-DD`, the season-local calendar date.
 * @param {number} input.latitude - degrees, north positive, within [-90, 90].
 * @param {number} input.longitude - degrees, **east positive**, within
 *   [-180, 180].
 * @param {string|null} [input.timeZone] - an IANA zone name; today always
 *   `season_settings.timezone`.
 * @returns {SunsetOnDate}
 */
export function sunsetOnDate({ date, latitude, longitude, timeZone }) {
  const clock = offsetOn(date, timeZone);
  if (clock.offsetMinutes === null) return refused(clock.findings);
  if (!isDegreesWithin(latitude, 90) || !isDegreesWithin(longitude, 180)) {
    return refused([
      makeTimingFinding(
        TIMING_REASON.SUNSET_COORDINATES_UNREADABLE,
        `sunset on ${date} needs a latitude within [-90, 90] and a longitude within [-180, 180]`,
        {
          date: String(date),
          timeZone: String(timeZone),
          latitude: String(latitude),
          longitude: String(longitude),
        }
      ),
    ]);
  }

  // `resolveZonedInstant()` accepted the date, so it is `YYYY-MM-DD` and real.
  const [year, month, day] = date.trim().split('-').map(Number);
  // Which solar day: the one whose noon (UTC minute 720 - 4 * longitude) lands
  // nearest 12:00 on this zone's clock. Zero wherever a zone roughly follows its
  // meridian; -1 or +1 only for a zone on the far side of the date line.
  const dayShift = Math.round((4 * longitude - clock.offsetMinutes) / MINUTES_PER_DAY);
  const julianMidnight =
    Date.UTC(year, month - 1, day) / MS_PER_DAY + JULIAN_DAY_OF_UNIX_EPOCH + dayShift;
  const latitudeRadians = toRadians(latitude);
  const cosZenith = Math.cos(toRadians(SUNSET_ZENITH_DEGREES));

  // UTC minutes after `julianMidnight`; the first pass is at local solar noon.
  let utcMinutes = 720 - 4 * longitude;
  let cosHourAngle = NaN;
  for (let pass = 0; pass < SUNSET_EVALUATIONS; pass += 1) {
    const { declination, equationOfTime } = solarPosition(
      julianMidnight + utcMinutes / MINUTES_PER_DAY
    );
    cosHourAngle =
      cosZenith / (Math.cos(latitudeRadians) * Math.cos(declination)) -
      Math.tan(latitudeRadians) * Math.tan(declination);
    // Where the next pass looks. Outside [-1, 1] the sun misses the zenith at
    // this pass's declination, so the next pass looks at solar midnight
    // (midnight sun) or solar noon (polar night), the nearest it comes; on a
    // boundary day the declination there can still carry it across. The bound
    // only picks an instant: the answer is decided below, unclamped.
    const hourAngle = toDegrees(Math.acos(Math.max(-1, Math.min(1, cosHourAngle))));
    utcMinutes = 720 - 4 * (longitude - hourAngle) - equationOfTime;
  }
  // Outside [-1, 1] at the last evaluation instant, the sun does not reach the
  // zenith that day: no sunset, and never a clamped one.
  if (!(Math.abs(cosHourAngle) <= 1)) {
    const cause = cosHourAngle > 1 ? 'polar-night' : 'midnight-sun';
    return refused([
      makeTimingFinding(
        TIMING_REASON.SUNSET_UNDEFINED_AT_LATITUDE,
        `there is no sunset on ${date} at latitude ${latitude}: ${cause}`,
        {
          date: String(date),
          timeZone: String(timeZone),
          latitude: String(latitude),
          cause,
        }
      ),
    ]);
  }

  return {
    minutes: utcMinutes + MINUTES_PER_DAY * dayShift + clock.offsetMinutes,
    code: null,
    findings: [],
  };
}

/**
 * The minute a sunset limit is enforced at: the `floor` of the computed sunset
 * (decision D2), the earlier minute. A limit rounded early can refuse one legal
 * minute; one rounded late would allow an illegal one.
 *
 * No sunset stays `null` -- it is not a late sunset, and a caller reading it as
 * a number would be inventing one.
 *
 * @param {{ minutes: number|null }} sunset - a {@link sunsetOnDate} result
 * @returns {number|null}
 */
export function sunsetEnforcementMinutes(sunset) {
  const minutes = sunset?.minutes;
  return typeof minutes === 'number' && Number.isFinite(minutes) ? Math.floor(minutes) : null;
}
