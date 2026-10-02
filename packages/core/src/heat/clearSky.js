/**
 * Clear-sky irradiance and the cloud reduction the heat reference applies.
 *
 * NWS does not forecast solar radiation, so global horizontal irradiance (GHI)
 * is estimated: clear-sky GHI from the Ineichen-Perez model, reduced for the
 * forecast sky cover by Kasten & Czeplak (1980). Each function is pvlib's, in
 * pvlib's default configuration as `Location.get_clearsky(model='ineichen')`
 * calls it:
 *
 * - extraterrestrial irradiance: `irradiance.get_extra_radiation`, Spencer
 *   method, solar constant 1366.1 W/m2, day of year read in UTC;
 * - relative airmass: Kasten & Young (1989) on the apparent zenith, NaN (here
 *   `null`) above 90 degrees;
 * - absolute airmass: relative x pressure / 101325, pressure from altitude;
 * - Ineichen GHI with `perez_enhancement=False`.
 *
 * The one input pvlib looks up that this port cannot ship at native resolution
 * is the Linke turbidity; see `turbidity.js`.
 *
 * @module heat/clearSky
 */

import { altitudeToPressurePa } from './solarPosition.js';

/** pvlib `get_extra_radiation` default solar constant, W/m2. */
const SOLAR_CONSTANT_EXTRA = 1366.1;

/**
 * Day of year of an instant, read in UTC (pvlib `_pandas_to_doy`).
 *
 * @param {number} epochMs
 * @returns {number} 1-366
 */
export function utcDayOfYear(epochMs) {
  const d = new Date(epochMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return (
    Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000) +
    1
  );
}

/**
 * Extraterrestrial normal irradiance, W/m2 (Spencer 1971 via pvlib).
 *
 * @param {number} dayOfYear
 */
export function extraRadiation(dayOfYear) {
  const b = ((2 * Math.PI) / 365) * (dayOfYear - 1);
  const rOverR0Sqrd =
    1.00011 +
    0.034221 * Math.cos(b) +
    0.00128 * Math.sin(b) +
    0.000719 * Math.cos(2 * b) +
    7.7e-5 * Math.sin(2 * b);
  return SOLAR_CONSTANT_EXTRA * rOverR0Sqrd;
}

/**
 * Kasten & Young (1989) relative airmass. `null` when the sun is below the
 * horizon (pvlib returns NaN there, which its Ineichen maps to zero GHI).
 *
 * @param {number} apparentZenithDeg
 * @returns {number|null}
 */
export function relativeAirmass(apparentZenithDeg) {
  if (!(apparentZenithDeg <= 90)) return null;
  const z = apparentZenithDeg;
  return 1 / (Math.cos((z * Math.PI) / 180) + 0.50572 * (6.07995 + (90 - z)) ** -1.6364);
}

/**
 * Ineichen-Perez clear-sky GHI, W/m2 (pvlib `clearsky.ineichen`, GHI branch).
 *
 * @param {{ apparentZenithDeg: number, airmassAbsolute: number|null,
 *   linkeTurbidity: number, altitudeM: number, dniExtra: number }} input
 */
export function ineichenGhi({
  apparentZenithDeg,
  airmassAbsolute,
  linkeTurbidity,
  altitudeM,
  dniExtra,
}) {
  const cosZenith = Math.max(Math.cos((apparentZenithDeg * Math.PI) / 180), 0);
  if (airmassAbsolute === null || cosZenith === 0) return 0;
  const tl = linkeTurbidity;
  const fh1 = Math.exp(-altitudeM / 8000);
  const fh2 = Math.exp(-altitudeM / 1250);
  const cg1 = 5.09e-5 * altitudeM + 0.868;
  const cg2 = 3.92e-5 * altitudeM + 0.0387;
  const ghi = Math.exp(-cg2 * airmassAbsolute * (fh1 + fh2 * (tl - 1)));
  return cg1 * dniExtra * cosZenith * Math.max(ghi, 0);
}

/**
 * Clear-sky GHI for a site and instant, composed exactly as
 * `Location(lat, lon, altitude=elev).get_clearsky(times, model='ineichen')`.
 *
 * @param {{ epochMs: number, apparentZenithDeg: number, altitudeM: number,
 *   linkeTurbidity: number }} input
 */
export function clearSkyGhi({ epochMs, apparentZenithDeg, altitudeM, linkeTurbidity }) {
  const am = relativeAirmass(apparentZenithDeg);
  const airmassAbsolute = am === null ? null : (am * altitudeToPressurePa(altitudeM)) / 101325;
  return ineichenGhi({
    apparentZenithDeg,
    airmassAbsolute,
    linkeTurbidity,
    altitudeM,
    dniExtra: extraRadiation(utcDayOfYear(epochMs)),
  });
}

/**
 * Kasten & Czeplak (1980) cloud reduction: GHI = GHI_clear x (1 - 0.75 N^3.4),
 * N the sky-cover fraction. The reference's formula, verbatim.
 *
 * @param {number} clearGhi
 * @param {number} skyCoverPct - 0-100
 */
export function cloudReducedGhi(clearGhi, skyCoverPct) {
  if (!(skyCoverPct >= 0 && skyCoverPct <= 100)) {
    throw new RangeError(`sky cover must be 0-100 percent, got ${skyCoverPct}`);
  }
  const n = skyCoverPct / 100;
  return clearGhi * (1 - 0.75 * n ** 3.4);
}
