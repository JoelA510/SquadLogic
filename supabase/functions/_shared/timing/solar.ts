/**
 * Sunset, computed, Deno/TS arm: the NOAA solar-position equations, read onto
 * the season's wall clock.
 *
 * ## Why this file is a second implementation, and what stops it drifting
 *
 * `packages/core/src/timing/solar.js` is the canonical sunset. Edge Functions
 * cannot import it, for the reason `seasonClock.ts` gives at its head, so this
 * is the same algorithm **line for line**: the same inputs, the same outputs,
 * the same two reason codes, the same zenith, the same three evaluations and
 * the same `floor` enforcement helper. A reader diffing the two bodies should
 * find only type annotations.
 *
 * Two controls hold the arms together, because a mirror is this repository's
 * most recurrent defect family (LIVE-1, LIVE-2, LIVE-3, LIVE-7):
 *
 * - `tests/solarDrift.test.js` imports **both** arms under Vitest and demands
 *   exact equality over a grid of latitudes, longitudes, every day of 2026 and
 *   four zones, plus polar nulls. Exact, not within a tolerance: the arms run
 *   the same operations in the same order on the same engine, so any
 *   difference at all is a divergence.
 * - `_shared/timing/solar.vectors.json` is generated from core and read by
 *   `tests/solarVectors.test.js` (core reproduces it, so it cannot go stale)
 *   and `_shared/tests/solar_test.ts` (this arm reproduces it **under Deno**,
 *   under two host zones, via `scripts/deno-mirror-tests.sh`).
 *
 * ## The clock
 *
 * The UTC offset comes from this directory's {@link resolveZonedInstant}, the
 * Edge season clock, and its contract is adopted whole: never throw on input;
 * a refusal is `minutes: null` plus the one finding whose `code` says why. No
 * daylight-saving rule is written here, the host's zone is never read, and no
 * `Date` is constructed: `Date.UTC` reads explicit fields and is the only date
 * function used.
 *
 * ## Codes
 *
 * The Edge season clock's `TIMING_REASON` holds its five codes and no others,
 * so the two sunset codes are declared here as {@link SOLAR_REASON}, spelled
 * identically to `packages/core/src/timing/reasonCodes.js` (the drift test
 * compares the strings). Both are blocking there; both mean `minutes: null`
 * here.
 *
 * **One production caller:** the auto-scheduler's daylight post-pass,
 * `_shared/engines/practice-daylight.ts` (8.9 PR 6).
 * `tests/unwiredLayerImporters.test.js` pins its importers, so the next caller
 * fails that pin.
 *
 * @module _shared/timing/solar
 */

import { resolveZonedInstant, type TimingFinding } from './seasonClock.ts';

/** The two sunset refusals, spelled as the core registry spells them. */
export const SOLAR_REASON = Object.freeze({
  SUNSET_UNDEFINED_AT_LATITUDE: 'SUNSET_UNDEFINED_AT_LATITUDE',
  SUNSET_COORDINATES_UNREADABLE: 'SUNSET_COORDINATES_UNREADABLE',
} as const);

export type SolarReason = (typeof SOLAR_REASON)[keyof typeof SOLAR_REASON];

/** A season-clock refusal passed through, or one of the two sunset refusals. */
export interface SolarFinding {
  code: TimingFinding['code'] | SolarReason;
  message: string;
  details: Record<string, unknown>;
}

function makeSolarFinding(
  code: SolarReason,
  message: string,
  details: Record<string, unknown> = {}
): SolarFinding {
  return { code, message, details };
}

/**
 * The sunset zenith in degrees: the geometric 90 plus 0.833 for refraction and
 * the sun's semi-diameter. NOAA's value, and core's.
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
 * Offsets already read, keyed by the trimmed zone and date. The same cache as
 * core's, with the same rule: only string inputs are keyed and only successful
 * reads kept, so anything else goes through `resolveZonedInstant()` and its
 * refusal every time.
 */
const offsetCache = new Map<string, number>();

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

export interface SunsetOnDate {
  /** Fractional minutes past local midnight of `date`; `null` exactly when `code` is set. */
  minutes: number | null;
  /** `null` for a sunset; otherwise the refusal's code, the same as `findings[0].code`. */
  code: string | null;
  /** Empty for a sunset; the one refusal otherwise. */
  findings: SolarFinding[];
}

export interface SunsetOnDateInput {
  /** `YYYY-MM-DD`, the season-local calendar date. */
  date: unknown;
  /** Degrees, north positive, within [-90, 90]. */
  latitude: unknown;
  /** Degrees, **east positive**, within [-180, 180]. */
  longitude: unknown;
  /** An IANA zone name; today always `season_settings.timezone`. */
  timeZone?: string | null;
}

/**
 * The sun's declination (radians) and the equation of time (minutes) at a
 * Julian day: the NOAA spreadsheet's columns, in its order.
 */
function solarPosition(julianDay: number): { declination: number; equationOfTime: number } {
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

/** The zone's UTC offset on `date`, in minutes, or the season clock's refusal. */
function offsetOn(
  date: unknown,
  timeZone: string | null | undefined
): { offsetMinutes: number | null; findings: SolarFinding[] } {
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
  // A break there is this module's defect, not the caller's input, so it is
  // named here rather than dressed up as a refusal.
  if (!match) throw new Error(`resolveZonedInstant() returned no offset: ${iso}`);
  const offsetMinutes = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  if (key !== null) offsetCache.set(key, offsetMinutes);
  return { offsetMinutes, findings: [] };
}

function isDegreesWithin(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

/** `findings` holds exactly one refusal. */
function refused(findings: SolarFinding[]): SunsetOnDate {
  return { minutes: null, code: findings[0].code, findings };
}

/**
 * Sunset on a date at a place, on the season's wall clock.
 *
 * **Never throws on its input.** See `packages/core/src/timing/solar.js` for
 * the clock, the day chosen and what `null` means; this arm answers the same.
 */
export function sunsetOnDate({
  date,
  latitude,
  longitude,
  timeZone,
}: SunsetOnDateInput): SunsetOnDate {
  const clock = offsetOn(date, timeZone);
  if (clock.offsetMinutes === null) return refused(clock.findings);
  if (!isDegreesWithin(latitude, 90) || !isDegreesWithin(longitude, 180)) {
    return refused([
      makeSolarFinding(
        SOLAR_REASON.SUNSET_COORDINATES_UNREADABLE,
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
  const [year, month, day] = (date as string).trim().split('-').map(Number);
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
      makeSolarFinding(
        SOLAR_REASON.SUNSET_UNDEFINED_AT_LATITUDE,
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
 */
export function sunsetEnforcementMinutes(
  sunset: { minutes: number | null } | null | undefined
): number | null {
  const minutes = sunset?.minutes;
  return typeof minutes === 'number' && Number.isFinite(minutes) ? Math.floor(minutes) : null;
}
