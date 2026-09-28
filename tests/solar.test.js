/**
 * The computed sunset (8.9 PR 1), held to the season-2026 corpus.
 *
 * ## The golden test carries no coordinates
 *
 * `fixtures/season-2026/sunsets.csv` names no place. The coordinates this test
 * compares against are **fitted at test time** from the 11 rows before the
 * 2026-11-01 fall-back and never written down (decision D3): the best fit lands
 * on a real, specific-looking place, it is degenerate along a ridge, and its
 * longitude depends on the zone assumed. The corpus names no zone either; its
 * `DST ends 11/01` note implies the US rule, and `America/New_York` is the zone
 * `tests/gameSchedulingSeasonClock.test.js` already reads it in.
 *
 * The search is coarse to fine -- 1 degree, then 0.1 degree around the coarse
 * best -- inside a box derived from the zone rather than typed: the zone's
 * standard meridian (its winter offset at 4 minutes a degree) plus or minus half
 * a zone's width, and latitudes 0-60. The box names a time zone, not a place.
 *
 * ## What each check is shown to catch
 *
 * The fit absorbs anything that shifts every sunset alike, so it is not asked to
 * witness everything. Each plant named in the PR is paired with the check that
 * goes red for it:
 *
 * - the two corrected rows reverted -> the out-of-sample check;
 * - the zenith changed to a geometric 90 -> the polar-boundary check, because a
 *   fit would soak a near-uniform four-minute shift into its longitude;
 * - a hardcoded UTC-5 -> the fixed-offset comparison, and the in-sample fit,
 *   which cannot reach the 15 degrees it would need to compensate;
 * - a clamped hour angle -> the polar nulls.
 */
import { describe, it, expect } from 'vitest';

import { loadSunsets } from '@squadlogic/core/fixtures/index.js';
import {
  TIMING_REASON,
  TIMING_SEVERITY,
  resolveZonedInstant,
  sunsetEnforcementMinutes,
  sunsetOnDate,
} from '@squadlogic/core/timing/index.js';

const SEASON_ZONE = 'America/New_York';

/**
 * Operator ruling 2026-09-24: the two rows after the fall-back, as they stood
 * before it and as it set them.
 */
const PRE_RULING_MINUTES = Object.freeze({
  '2026-11-07': 16 * 60 + 44,
  '2026-11-14': 16 * 60 + 35,
});
const RULED_MINUTES = Object.freeze({ '2026-11-07': 16 * 60 + 49, '2026-11-14': 16 * 60 + 41 });

const IN_SAMPLE_TOLERANCE_MINUTES = 1.1;
const OUT_OF_SAMPLE_TOLERANCE_MINUTES = 1;

/**
 * The zone's UTC offset at noon on a date, read the way `solar.js` reads it.
 *
 * @param {string} date
 * @param {string} [timeZone]
 * @returns {number}
 */
function offsetMinutesOn(date, timeZone = SEASON_ZONE) {
  const { iso } = resolveZonedInstant({ date, time: '12:00', timeZone });
  const match = /([+-])(\d{2}):(\d{2})$/.exec(String(iso));
  if (!match) throw new Error(`no offset for ${date} in ${timeZone}`);
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

const sunsets = loadSunsets();
const inSample = sunsets.filter((row) => !Object.hasOwn(RULED_MINUTES, row.date));
const outOfSample = sunsets.filter((row) => Object.hasOwn(RULED_MINUTES, row.date));

const SEASON_YEAR = sunsets[0].date.slice(0, 4);
/** Degrees: the zone's winter offset, at four minutes of clock per degree. */
const STANDARD_MERIDIAN = offsetMinutesOn(`${SEASON_YEAR}-01-15`) / 4;
const LONGITUDE_HALF_WIDTH = 7.5;
const LATITUDE_RANGE = Object.freeze([0, 60]);

/**
 * @param {ReadonlyArray<{ date: string, sunsetMinutes: number }>} rows
 * @param {number} latitude
 * @param {number} longitude
 * @returns {number} the largest |computed - corpus| over the rows, or Infinity
 *   when any row has no sunset there.
 */
function worstResidual(rows, latitude, longitude) {
  let worst = 0;
  for (const row of rows) {
    const { minutes } = sunsetOnDate({
      date: row.date,
      latitude,
      longitude,
      timeZone: SEASON_ZONE,
    });
    if (minutes === null) return Infinity;
    worst = Math.max(worst, Math.abs(minutes - row.sunsetMinutes));
  }
  return worst;
}

/**
 * Minimax fit, coarse (1 degree) then fine (0.1 degree around the coarse best).
 *
 * @param {ReadonlyArray<{ date: string, sunsetMinutes: number }>} rows
 */
function fitCoordinates(rows) {
  let best = { latitude: NaN, longitude: NaN, worst: Infinity };
  let candidates = 0;
  /** @param {number} latitude @param {number} longitude */
  const consider = (latitude, longitude) => {
    candidates += 1;
    const worst = worstResidual(rows, latitude, longitude);
    if (worst < best.worst) best = { latitude, longitude, worst };
  };
  const [latFrom, latTo] = LATITUDE_RANGE;
  const halfSteps = Math.floor(LONGITUDE_HALF_WIDTH);
  for (let latitude = latFrom; latitude <= latTo; latitude += 1) {
    for (let step = -halfSteps; step <= halfSteps; step += 1) {
      consider(latitude, STANDARD_MERIDIAN + step);
    }
  }
  const coarse = best;
  for (let i = -10; i <= 10; i += 1) {
    for (let j = -10; j <= 10; j += 1) {
      consider(coarse.latitude + i / 10, coarse.longitude + j / 10);
    }
  }
  return { ...best, coarseWorst: coarse.worst, candidates };
}

/** @type {ReturnType<typeof fitCoordinates> | null} */
let fitted = null;
/** Fitted on first use, inside a test, so the per-test timeout bounds it. */
function fit() {
  fitted ??= fitCoordinates(inSample);
  return fitted;
}

/** @param {string} date */
function predicted(date) {
  const { latitude, longitude } = fit();
  const { minutes } = sunsetOnDate({ date, latitude, longitude, timeZone: SEASON_ZONE });
  if (minutes === null) throw new Error(`no computed sunset on ${date}`);
  return minutes;
}

describe('solar :: the corpus the golden test reads', () => {
  it('splits 13 rows into the 11 before the fall-back and the 2 the ruling corrected, by the zone', () => {
    expect(sunsets).toHaveLength(13);
    expect(inSample).toHaveLength(11);
    expect(outOfSample.map((row) => row.date)).toEqual(Object.keys(RULED_MINUTES));
    // The split is by date, so check it against the zone: every in-sample row is
    // on one offset, every corrected row on another, an hour apart. A post-DST
    // row that slipped into the sample would make the first set two offsets.
    const inOffsets = new Set(inSample.map((row) => offsetMinutesOn(row.date)));
    const outOffsets = new Set(outOfSample.map((row) => offsetMinutesOn(row.date)));
    expect(inOffsets.size).toBe(1);
    expect(outOffsets.size).toBe(1);
    expect([...inOffsets][0] - [...outOffsets][0]).toBe(60);
    expect(STANDARD_MERIDIAN * 4).toBe([...outOffsets][0]);
  });

  it('carries the values operator ruling 2026-09-24 set', () => {
    for (const row of outOfSample) {
      expect(row.sunsetMinutes, row.date).toBe(RULED_MINUTES[row.date]);
      expect(row.note, row.date).toBe('DST ends 11/01');
    }
  });
});

describe('solar :: golden test -- NOAA against the corpus, coordinates fitted at test time', () => {
  it('fits all 11 pre-fall-back rows within 1.1 minutes, from inside the search box', () => {
    const { latitude, longitude, worst, coarseWorst, candidates } = fit();
    // The search examined the whole box and refined inside it.
    const coarseCandidates =
      (LATITUDE_RANGE[1] - LATITUDE_RANGE[0] + 1) * (2 * Math.floor(LONGITUDE_HALF_WIDTH) + 1);
    expect(candidates).toBe(coarseCandidates + 21 * 21);
    expect(worst).toBeLessThanOrEqual(coarseWorst);
    // An optimum on the edge of the box means the box chose it, not the data.
    expect(latitude).toBeGreaterThan(LATITUDE_RANGE[0] + 1);
    expect(latitude).toBeLessThan(LATITUDE_RANGE[1] - 1);
    expect(Math.abs(longitude - STANDARD_MERIDIAN)).toBeLessThan(LONGITUDE_HALF_WIDTH - 1);

    const residuals = inSample.map((row) => predicted(row.date) - row.sunsetMinutes);
    expect(residuals).toHaveLength(11);
    for (const [index, residual] of residuals.entries()) {
      expect(Math.abs(residual), inSample[index].date).toBeLessThanOrEqual(
        IN_SAMPLE_TOLERANCE_MINUTES
      );
    }
    expect(Math.max(...residuals.map(Math.abs))).toBeCloseTo(worst, 9);
  });

  it('predicts both corrected rows within a minute, out of sample', () => {
    // The fit is degenerate along a ridge, so this prediction moves with the
    // search grid: a 0.02-degree grid fits the 11 rows slightly better and puts
    // both dates ~0.7 minutes later, which would take 11/14 past this tolerance.
    // The 1-degree/0.1-degree grid is the approved method, and this check
    // separates the ruling from the pre-ruling values (5-6 minutes off), not
    // from a neighbouring minute.
    for (const row of outOfSample) {
      expect(Math.abs(predicted(row.date) - row.sunsetMinutes), row.date).toBeLessThanOrEqual(
        OUT_OF_SAMPLE_TOLERANCE_MINUTES
      );
    }
  });

  it('negative control: the pre-ruling 4:44 and 4:35 sit more than a minute from the same prediction', () => {
    const entries = Object.entries(PRE_RULING_MINUTES);
    expect(entries).toHaveLength(2);
    for (const [date, minutes] of entries) {
      expect(Math.abs(predicted(date) - minutes), date).toBeGreaterThan(
        OUT_OF_SAMPLE_TOLERANCE_MINUTES
      );
    }
  });
});

describe('solar :: no sunset is null, never clamped', () => {
  it.each([
    ['2026-06-21', 80, 'midnight-sun'],
    ['2026-12-21', 80, 'polar-night'],
    ['2026-06-21', -80, 'polar-night'],
  ])('%s at latitude %d: %s', (date, latitude, cause) => {
    const result = sunsetOnDate({ date, latitude, longitude: 0, timeZone: 'UTC' });
    expect(result.minutes).toBeNull();
    expect(result.code).toBe(TIMING_REASON.SUNSET_UNDEFINED_AT_LATITUDE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: TIMING_REASON.SUNSET_UNDEFINED_AT_LATITUDE,
      severity: TIMING_SEVERITY.BLOCKING,
      details: { date, latitude: String(latitude), cause },
    });
    expect(sunsetEnforcementMinutes(result)).toBeNull();
  });

  it('the zenith is refraction-corrected: midnight sun reaches 66N, and the sun still sets at 67N at midwinter', () => {
    // The Arctic Circle is about 66.56N. The 0.833 degrees of the NOAA zenith
    // keep the sun visible ~0.8 degrees further round both solstices, so at 66N
    // in June it never sets and at 67N in December it still rises and sets. A
    // geometric 90-degree zenith gets both wrong, and no fit can absorb it.
    const june = sunsetOnDate({ date: '2026-06-21', latitude: 66, longitude: 0, timeZone: 'UTC' });
    expect(june.code).toBe(TIMING_REASON.SUNSET_UNDEFINED_AT_LATITUDE);
    expect(june.findings[0].details.cause).toBe('midnight-sun');
    const december = sunsetOnDate({
      date: '2026-12-21',
      latitude: 67,
      longitude: 0,
      timeZone: 'UTC',
    });
    expect(december.code).toBeNull();
    expect(december.minutes).toBeGreaterThan(12 * 60);
    expect(december.minutes).toBeLessThan(13 * 60);
  });
});

describe('solar :: the offset is the zone’s, on that date', () => {
  const at = (date, timeZone) =>
    sunsetOnDate({ date, latitude: 35, longitude: -70, timeZone }).minutes;

  it.each([
    ['2026-03-07', 0],
    ['2026-03-08', 60],
    ['2026-07-01', 60],
    ['2026-10-31', 60],
    ['2026-11-01', 0],
    ['2026-12-01', 0],
  ])('%s: America/New_York reads %d minutes later than fixed UTC-5', (date, difference) => {
    // `Etc/GMT+5` is UTC-5 all year (POSIX signs are inverted). Same place, same
    // instant: the two clocks differ by exactly the daylight-saving hour, and only
    // on the dates the zone itself says. A hardcoded offset makes every row 0.
    expect(offsetMinutesOn(date, 'Etc/GMT+5')).toBe(-300);
    expect(at(date, SEASON_ZONE) - at(date, 'Etc/GMT+5')).toBeCloseTo(difference, 9);
  });

  it('gives the evening of the asked date on the far side of the date line', () => {
    // Pacific/Kiritimati (UTC+14) runs exactly 24 hours ahead of Pacific/Honolulu
    // (UTC-10). The evening of 06-02 on one clock is the evening of 06-01 on the
    // other, so the two answers are the same wall minutes, and an evening.
    const kiritimati = sunsetOnDate({
      date: '2026-06-02',
      latitude: 10,
      longitude: -150,
      timeZone: 'Pacific/Kiritimati',
    });
    const honolulu = sunsetOnDate({
      date: '2026-06-01',
      latitude: 10,
      longitude: -150,
      timeZone: 'Pacific/Honolulu',
    });
    expect(offsetMinutesOn('2026-06-02', 'Pacific/Kiritimati')).toBe(14 * 60);
    expect(kiritimati.minutes).toBeCloseTo(/** @type {number} */ (honolulu.minutes), 9);
    expect(kiritimati.minutes).toBeGreaterThan(17 * 60);
    expect(kiritimati.minutes).toBeLessThan(20 * 60);
  });
});

describe('solar :: refusals follow the season clock’s contract', () => {
  it.each([
    [{ date: '2026-11-07', timeZone: null }, TIMING_REASON.SEASON_TIMEZONE_MISSING],
    [{ date: '2026-11-07', timeZone: 'Americas/New_York' }, TIMING_REASON.SEASON_TIMEZONE_UNKNOWN],
    [{ date: '2026-02-30', timeZone: SEASON_ZONE }, TIMING_REASON.WALL_TIME_UNREADABLE],
    [
      { date: '2026-11-07', timeZone: SEASON_ZONE, latitude: 91 },
      TIMING_REASON.SUNSET_COORDINATES_UNREADABLE,
    ],
    [
      { date: '2026-11-07', timeZone: SEASON_ZONE, longitude: -181 },
      TIMING_REASON.SUNSET_COORDINATES_UNREADABLE,
    ],
    [
      { date: '2026-11-07', timeZone: SEASON_ZONE, latitude: NaN },
      TIMING_REASON.SUNSET_COORDINATES_UNREADABLE,
    ],
    [
      { date: '2026-11-07', timeZone: SEASON_ZONE, latitude: '35' },
      TIMING_REASON.SUNSET_COORDINATES_UNREADABLE,
    ],
  ])('%o -> %s, never a throw', (input, code) => {
    const result = sunsetOnDate(/** @type {any} */ ({ latitude: 35, longitude: -70, ...input }));
    expect(result.minutes).toBeNull();
    expect(result.code).toBe(code);
    expect(result.findings.map((finding) => finding.code)).toEqual([code]);
  });

  it('never lets a warm cache skip validation: a value that only stringifies like one is refused', () => {
    const place = { latitude: 35, longitude: -70 };
    expect(sunsetOnDate({ date: '2026-11-07', timeZone: SEASON_ZONE, ...place }).code).toBeNull();
    const asAny = (input) => sunsetOnDate(/** @type {any} */ ({ ...place, ...input }));
    expect(asAny({ date: ['2026-11-07'], timeZone: SEASON_ZONE }).code).toBe(
      TIMING_REASON.WALL_TIME_UNREADABLE
    );
    expect(asAny({ date: '2026-11-07', timeZone: [SEASON_ZONE] }).code).toBe(
      TIMING_REASON.SEASON_TIMEZONE_MISSING
    );
  });

  it('answers a sunset with no code and no findings', () => {
    const result = sunsetOnDate({
      date: '2026-11-07',
      latitude: 35,
      longitude: -70,
      timeZone: SEASON_ZONE,
    });
    expect(result.code).toBeNull();
    expect(result.findings).toEqual([]);
    expect(Number.isInteger(result.minutes)).toBe(false);
  });
});

describe('solar :: enforcement floors (D2)', () => {
  it('takes the earlier minute, and keeps no-sunset as null', () => {
    expect(sunsetEnforcementMinutes({ minutes: 1008.999 })).toBe(1008);
    expect(sunsetEnforcementMinutes({ minutes: 1009 })).toBe(1009);
    expect(sunsetEnforcementMinutes({ minutes: 1009.001 })).toBe(1009);
    expect(sunsetEnforcementMinutes({ minutes: null })).toBeNull();
    for (const row of outOfSample) {
      const minutes = predicted(row.date);
      const enforced = /** @type {number} */ (sunsetEnforcementMinutes({ minutes }));
      expect(enforced).toBeLessThanOrEqual(minutes);
      expect(minutes - enforced).toBeLessThan(1);
    }
  });
});
