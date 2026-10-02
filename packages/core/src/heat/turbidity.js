/**
 * Linke turbidity: the one documented substitution in the heat port.
 *
 * pvlib's Ineichen model looks up a monthly Linke turbidity (TL) climatology
 * (`LinkeTurbidities.h5`, Remund et al. 2003, 1/12 degree, global, 15.6 MB).
 * That cannot ship to a browser. `scripts/heat/generate_heat_reference.py`
 * block-averages it to 0.5 degree over the NWS forecast box (15..72 N,
 * 180..60 W) -- 328,320 bytes -- and this module decodes and reads it.
 *
 * Measured effect (docs/architecture/heat-forecast.md): over CONUS the 0.5
 * degree cell differs from pvlib's native cell by TL 0.025 at the median, 0.18
 * at p95 and 1.7 at the worst (mountain terrain). WBGT moves ~0.8 F per unit of
 * TL at low sun and ~0.1-0.2 F at midday, so p95 error is <= 0.15 F at low sun.
 * At the reference fixture site the table gives 3.224 where pvlib gives 3.2615
 * (Oct 3): ~0.02 F.
 *
 * What is pvlib's, unchanged: values are 20 x TL; the monthly value is taken as
 * the month's middle day and interpolated linearly by UTC day of year, December
 * and January wrapping, leap years using the leap calendar.
 *
 * A point outside the box is refused, never given a neighbour's value.
 *
 * @module heat/turbidity
 */

import { utcDayOfYear } from './clearSky.js';

export const TURBIDITY_TABLE = Object.freeze({
  id: 'linke-turbidity-nws-0p5deg',
  north: 72,
  south: 15,
  west: -180,
  east: -60,
  resolutionDeg: 0.5,
  rows: 114,
  cols: 240,
  months: 12,
});

const BYTES = TURBIDITY_TABLE.rows * TURBIDITY_TABLE.cols * TURBIDITY_TABLE.months;

/**
 * @typedef {Object} TurbidityTable
 * @property {Uint8Array} bytes - month-major [12][rows][cols], 20 x TL
 * @property {typeof TURBIDITY_TABLE} meta
 */

/**
 * Wrap the raw table bytes, refusing a wrong length or a zero cell (TL 0 is not
 * a turbidity; a zero means a truncated or corrupt download).
 *
 * @param {ArrayBuffer|Uint8Array} raw
 * @returns {TurbidityTable}
 */
export function decodeTurbidityTable(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.length !== BYTES) {
    throw new Error(
      `Linke turbidity table is ${bytes.length} bytes; expected ${BYTES} (${TURBIDITY_TABLE.months} x ${TURBIDITY_TABLE.rows} x ${TURBIDITY_TABLE.cols})`
    );
  }
  const zero = bytes.indexOf(0);
  if (zero !== -1) {
    throw new Error(`Linke turbidity table has a zero cell at byte ${zero}; the file is corrupt`);
  }
  return { bytes, meta: TURBIDITY_TABLE };
}

/** pvlib `_calendar_month_middles`, with the Dec/Jan wrap entries. */
function monthMiddles(leap) {
  const mdays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const ydays = leap ? 366 : 365;
  const out = [-31 / 2];
  let cum = 0;
  for (const m of mdays) {
    cum += m;
    out.push(cum - m / 2);
  }
  out.push(ydays + 31 / 2);
  return out;
}

/** numpy.interp for increasing xp. */
function interp(x, xp, fp) {
  if (x <= xp[0]) return fp[0];
  for (let i = 1; i < xp.length; i += 1) {
    if (x <= xp[i]) {
      return fp[i - 1] + ((fp[i] - fp[i - 1]) * (x - xp[i - 1])) / (xp[i] - xp[i - 1]);
    }
  }
  return fp[fp.length - 1];
}

/**
 * Is the point inside the table's box?
 *
 * @param {number} latitude
 * @param {number} longitude
 */
export function turbidityCovers(latitude, longitude) {
  const m = TURBIDITY_TABLE;
  return latitude < m.north && latitude >= m.south && longitude >= m.west && longitude < m.east;
}

/**
 * Daily-interpolated Linke turbidity at a point and instant, or `null` outside
 * the table's box.
 *
 * @param {TurbidityTable} table
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} epochMs
 * @returns {number|null}
 */
export function lookupLinkeTurbidity(table, latitude, longitude, epochMs) {
  if (!turbidityCovers(latitude, longitude)) return null;
  const m = table.meta;
  const row = Math.floor((m.north - latitude) / m.resolutionDeg);
  const col = Math.floor((longitude - m.west) / m.resolutionDeg);
  const monthly = [];
  for (let k = 0; k < m.months; k += 1) {
    monthly.push(table.bytes[k * m.rows * m.cols + row * m.cols + col]);
  }
  const year = new Date(epochMs).getUTCFullYear();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const wrapped = [monthly[11], ...monthly, monthly[0]];
  return interp(utcDayOfYear(epochMs), monthMiddles(leap), wrapped) / 20;
}
