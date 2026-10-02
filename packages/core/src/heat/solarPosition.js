/**
 * Solar position: the NREL Solar Position Algorithm (Reda & Andreas 2004),
 * ported from pvlib's `spa.py` (the `nrel_numpy` path the Python heat
 * reference reaches through `Location.get_solarposition`).
 *
 * Only the zenith outputs are computed -- the heat model reads the apparent
 * zenith and nothing else -- but every intermediate is pvlib's, in pvlib's
 * order, so a parity failure can be bisected term by term.
 *
 * The periodic-term tables are generated from pvlib (`spaTables.js`), never
 * hand-typed.
 *
 * This is deliberately not `timing/solar.js`. That module computes sunset with
 * NOAA's spreadsheet equations under its own operator ruling; this one has to
 * match pvlib to the fourth decimal of a degree at low sun, which the NOAA
 * equations and their refraction model do not. Neither imports the other.
 *
 * @module heat/solarPosition
 */

import {
  B0,
  B1,
  L0,
  L1,
  L2,
  L3,
  L4,
  L5,
  NUTATION_ABCD,
  NUTATION_Y,
  R0,
  R1,
  R2,
  R3,
  R4,
} from './spaTables.js';

/** pvlib's default `atmos_refract`: refraction at sunrise/sunset, degrees. */
const ATMOS_REFRACT = 0.5667;
/** pvlib's default ambient temperature for refraction, degrees C. */
export const SPA_DEFAULT_TEMPERATURE_C = 12;

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
/** Python's `%`: the result takes the divisor's sign. */
const mod = (a, n) => ((a % n) + n) % n;

/**
 * @param {ReadonlyArray<ReadonlyArray<number>>} table
 * @param {number} x
 */
function sumMultCosAddMult(table, x) {
  let s = 0;
  for (const row of table) s += row[0] * Math.cos(row[1] + row[2] * x);
  return s;
}

/**
 * TT - UT, seconds. pvlib's `spa_python` signature defaults `delta_t=67.0`, and
 * `get_solarposition` (the reference's path) never overrides it, so the
 * reference runs on 67.0 s, not on pvlib's `calculate_deltat` polynomial. The
 * difference is ~0.0001 degree of zenith in 2026; parity wins.
 */
export const PVLIB_DEFAULT_DELTA_T = 67.0;

/**
 * Air pressure at an altitude, Pa: pvlib `atmosphere.alt2pres`.
 *
 * @param {number} altitudeM
 */
export function altitudeToPressurePa(altitudeM) {
  return 100 * ((44331.514 - altitudeM) / 11880.516) ** (1 / 0.1902632);
}

/**
 * @typedef {Object} SolarPositionInput
 * @property {number} epochMs - the instant, ms since the Unix epoch (UTC)
 * @property {number} latitude - degrees north
 * @property {number} longitude - degrees east
 * @property {number} elevationM - observer elevation, metres
 * @property {number} pressurePa - local pressure, Pa (pvlib passes alt2pres(elevation))
 * @property {number} [temperatureC] - defaults to pvlib's 12 C
 * @property {number} [deltaT] - seconds; defaults to {@link PVLIB_DEFAULT_DELTA_T}
 */

/**
 * Topocentric zenith angles, degrees.
 *
 * @param {SolarPositionInput} input
 * @returns {{ zenith: number, apparentZenith: number }}
 */
export function solarPosition({
  epochMs,
  latitude,
  longitude,
  elevationM,
  pressurePa,
  temperatureC = SPA_DEFAULT_TEMPERATURE_C,
  deltaT = PVLIB_DEFAULT_DELTA_T,
}) {
  for (const [name, v] of Object.entries({
    epochMs,
    latitude,
    longitude,
    elevationM,
    pressurePa,
  })) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`solarPosition: ${name} must be a finite number, got ${String(v)}`);
    }
  }
  const dt = deltaT;
  const pressure = pressurePa / 100; // millibars, as pvlib does
  const lat = latitude;
  const lon = longitude;
  const elev = elevationM;

  const jd = epochMs / 1000 / 86400 + 2440587.5;
  const jde = jd + dt / 86400;
  const jc = (jd - 2451545) / 36525;
  const jce = (jde - 2451545) / 36525;
  const jme = jce / 10;

  const R =
    (sumMultCosAddMult(R0, jme) +
      sumMultCosAddMult(R1, jme) * jme +
      sumMultCosAddMult(R2, jme) * jme ** 2 +
      sumMultCosAddMult(R3, jme) * jme ** 3 +
      sumMultCosAddMult(R4, jme) * jme ** 4) /
    10 ** 8;
  const lRad =
    (sumMultCosAddMult(L0, jme) +
      sumMultCosAddMult(L1, jme) * jme +
      sumMultCosAddMult(L2, jme) * jme ** 2 +
      sumMultCosAddMult(L3, jme) * jme ** 3 +
      sumMultCosAddMult(L4, jme) * jme ** 4 +
      sumMultCosAddMult(L5, jme) * jme ** 5) /
    10 ** 8;
  const L = mod(deg(lRad), 360);
  const B = deg((sumMultCosAddMult(B0, jme) + sumMultCosAddMult(B1, jme) * jme) / 10 ** 8);
  const Theta = mod(L + 180, 360);
  const beta = -B;

  const x0 = 297.85036 + 445267.11148 * jce - 0.0019142 * jce ** 2 + jce ** 3 / 189474;
  const x1 = 357.52772 + 35999.05034 * jce - 0.0001603 * jce ** 2 - jce ** 3 / 300000;
  const x2 = 134.96298 + 477198.867398 * jce + 0.0086972 * jce ** 2 + jce ** 3 / 56250;
  const x3 = 93.27191 + 483202.017538 * jce - 0.0036825 * jce ** 2 + jce ** 3 / 327270;
  const x4 = 125.04452 - 1934.136261 * jce + 0.0020708 * jce ** 2 + jce ** 3 / 450000;

  let psiSum = 0;
  let epsSum = 0;
  for (let row = 0; row < NUTATION_Y.length; row += 1) {
    const [a, b, c, d] = NUTATION_ABCD[row];
    const Y = NUTATION_Y[row];
    const arg = rad(Y[0] * x0 + Y[1] * x1 + Y[2] * x2 + Y[3] * x3 + Y[4] * x4);
    psiSum += (a + b * jce) * Math.sin(arg);
    epsSum += (c + d * jce) * Math.cos(arg);
  }
  const deltaPsi = psiSum / 36000000;
  const deltaEps = epsSum / 36000000;

  const U = jme / 10;
  const epsilon0 =
    84381.448 -
    4680.93 * U -
    1.55 * U ** 2 +
    1999.25 * U ** 3 -
    51.38 * U ** 4 -
    249.67 * U ** 5 -
    39.05 * U ** 6 +
    7.12 * U ** 7 +
    27.87 * U ** 8 +
    5.79 * U ** 9 +
    2.45 * U ** 10;
  const epsilon = epsilon0 / 3600 + deltaEps;
  const deltaTau = -20.4898 / (3600 * R);
  const lamd = Theta + deltaPsi + deltaTau;
  const v0 = mod(
    280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * jc ** 2 - jc ** 3 / 38710000,
    360
  );
  const v = v0 + deltaPsi * Math.cos(rad(epsilon));

  const epsR = rad(epsilon);
  const lamR = rad(lamd);
  const alpha = mod(
    deg(
      Math.atan2(
        Math.sin(lamR) * Math.cos(epsR) - Math.tan(rad(beta)) * Math.sin(epsR),
        Math.cos(lamR)
      )
    ),
    360
  );
  const delta = deg(
    Math.asin(
      Math.sin(rad(beta)) * Math.cos(epsR) + Math.cos(rad(beta)) * Math.sin(epsR) * Math.sin(lamR)
    )
  );

  const H = mod(v + lon - alpha, 360);
  const xi = 8.794 / (3600 * R);
  const u = Math.atan(0.99664719 * Math.tan(rad(lat)));
  const x = Math.cos(u) + (elev / 6378140) * Math.cos(rad(lat));
  const y = 0.99664719 * Math.sin(u) + (elev / 6378140) * Math.sin(rad(lat));

  const xiR = rad(xi);
  const HR = rad(H);
  const deltaAlpha = deg(
    Math.atan2(
      -x * Math.sin(xiR) * Math.sin(HR),
      Math.cos(rad(delta)) - x * Math.sin(xiR) * Math.cos(HR)
    )
  );
  const deltaPrime = deg(
    Math.atan2(
      (Math.sin(rad(delta)) - y * Math.sin(xiR)) * Math.cos(rad(deltaAlpha)),
      Math.cos(rad(delta)) - x * Math.sin(xiR) * Math.cos(HR)
    )
  );
  const HPrime = H - deltaAlpha;
  const e0 = deg(
    Math.asin(
      Math.sin(rad(lat)) * Math.sin(rad(deltaPrime)) +
        Math.cos(rad(lat)) * Math.cos(rad(deltaPrime)) * Math.cos(rad(HPrime))
    )
  );
  const deltaE =
    e0 >= -1 * (0.26667 + ATMOS_REFRACT)
      ? ((pressure / 1010) * (283 / (273 + temperatureC)) * 1.02) /
        (60 * Math.tan(rad(e0 + 10.3 / (e0 + 5.11))))
      : 0;
  const e = e0 + deltaE;
  return { zenith: 90 - e0, apparentZenith: 90 - e };
}
