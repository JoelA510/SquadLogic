/**
 * Wet Bulb Globe Temperature: the Liljegren et al. (2008) model and the turf /
 * grass surface treatment, ported from the Python reference
 * (`scripts/heat/reference/cvsc_wbgt.py`).
 *
 * Constants and control flow are the reference's, verbatim, including the
 * reference code's low-sun zenith clamps and its GHI cap. Do not "improve" a
 * constant here without regenerating `tests/fixtures/heat/heatReference.json`
 * and stating the effect on the golden values.
 *
 * Temperatures inside the model are kelvin; the public functions take and
 * return Fahrenheit, wind in mph, GHI in W/m2, zenith in radians, pressure in
 * hPa, matching the reference's signatures.
 *
 * Failures throw {@link HeatError} with a stable `code`; the forecast
 * composer turns them into a visible refused row, never a dropped one.
 *
 * @module heat/wbgt
 */

import { HEAT_REASON, HeatError } from './reasonCodes.js';

const STEFANB = 5.6696e-8;
const CP = 1003.5;
const M_AIR = 28.97;
const M_H2O = 18.015;
const R_AIR = 8314.34 / M_AIR;
const PR = CP / (CP + 1.25 * R_AIR);
const RATIO = (CP * M_AIR) / M_H2O;
const EMIS_WICK = 0.95;
const ALB_WICK = 0.4;
const D_WICK = 0.007;
const L_WICK = 0.0254;
const EMIS_GLOBE = 0.95;
const ALB_GLOBE = 0.05;
const D_GLOBE = 0.0508;
const EMIS_SFC = 0.999;
const SOLAR_CONST = 1367.0;
const MIN_SPEED = 0.13;
const CZA_MIN = 0.00873;
const CONVERGENCE = 0.02;
const MAX_ITER = 500;

export const GRASS_ALBEDO = 0.23;
export const TURF_ALBEDO = 0.1;
/** Air above turf vs regional (Grundstein & Cooper 2020: ~0.8 C). */
export const TURF_AIR_OFFSET_F = 1.5;
/** Drier air above turf (same study: ~1 C lower dewpoint). */
export const TURF_DEW_OFFSET_F = -1.8;
/** Share of absorbed sun going into infill/pad storage, by local hour. */
const TURF_STORAGE = Object.freeze({ 6: 0.6, 7: 0.6, 8: 0.5, 9: 0.4, 10: 0.3, 11: 0.25 });
const TURF_STORAGE_DEFAULT = 0.1;

export const SURFACES = Object.freeze(['grass', 'turf']);

/** @param {number} f */
export const fToK = (f) => ((f - 32) * 5) / 9 + 273.15;
/** @param {number} k */
export const kToF = (k) => ((k - 273.15) * 9) / 5 + 32;

/** @param {number} tk */
function esat(tk) {
  const y = (tk - 273.15) / (tk - 32.18);
  return 1.004 * 6.1121 * Math.exp(17.502 * y);
}

/** @param {number} tk */
function viscosity(tk) {
  const omega = ((tk / 97.0 - 2.9) / 0.4) * -0.034 + 1.048;
  return (2.6693e-6 * Math.sqrt(M_AIR * tk)) / (3.617 ** 2 * omega);
}

/** @param {number} tk */
const thermalCond = (tk) => (CP + 1.25 * R_AIR) * viscosity(tk);

/**
 * @param {number} tk
 * @param {number} p - hPa
 */
function diffusivity(tk, p) {
  const pcrit13 = (36.4 * 218.0) ** (1 / 3);
  const tcrit512 = (132.0 * 647.3) ** (5 / 12);
  const tcrit12 = Math.sqrt(132.0 * 647.3);
  const mmix = Math.sqrt(1 / M_AIR + 1 / M_H2O);
  return ((3.64e-4 * (tk / tcrit12) ** 2.334 * pcrit13 * tcrit512 * mmix) / (p / 1013.25)) * 1e-4;
}

/**
 * @param {number} tk
 * @param {number} rh - fraction
 */
const emisAtm = (tk, rh) => 0.575 * (rh * esat(tk)) ** 0.143;
/** @param {number} tk */
const hEvap = (tk) => ((313.15 - tk) / 30.0) * -71100.0 + 2.4073e6;

function hSphere(tk, p, u) {
  const re = (Math.max(u, MIN_SPEED) * ((p * 100) / (R_AIR * tk)) * D_GLOBE) / viscosity(tk);
  return ((2.0 + 0.6 * Math.sqrt(re) * PR ** 0.3333) * thermalCond(tk)) / D_GLOBE;
}

function hCylinder(tk, p, u) {
  const re = (Math.max(u, MIN_SPEED) * ((p * 100) / (R_AIR * tk)) * D_WICK) / viscosity(tk);
  return (0.281 * re ** 0.6 * PR ** 0.44 * thermalCond(tk)) / D_WICK;
}

/**
 * Cap GHI at 0.85 x top-of-atmosphere; direct-beam fraction from clearness.
 *
 * @param {number} ghi
 * @param {number} cza - cosine of the zenith angle
 * @returns {[number, number]} [ghi, fdir]
 */
export function normalizeSolar(ghi, cza) {
  if (cza <= 0 || ghi <= 0) return [ghi, 0.0];
  if (cza < CZA_MIN) return [ghi, 0.0];
  const toa = SOLAR_CONST * cza;
  const s = Math.min(ghi / toa, 0.85);
  return [s * toa, Math.max(Math.min(Math.exp(3 - 1.34 * s - 1.65 / s), 0.9), 0.0)];
}

/**
 * The reference code's low-sun clamps.
 *
 * @param {number} zen - radians
 * @param {number} ghi
 * @returns {[number, number]} [zen, ghi]
 */
export function clampZenith(zen, ghi) {
  let z = Math.max(zen, 1e-10);
  let g = ghi;
  if (g > 0 && z > 1.57) z = 1.57;
  if (g > 15 && z > 1.54) z = 1.54;
  if (g > 900 && z > 1.52) z = 1.52;
  if (g < 10 && z >= 1.57) g = 0.0;
  return [z, g];
}

const STABILITY_TABLE = [
  [1, 1, 2, 4],
  [1, 2, 3, 4],
  [2, 2, 3, 4],
  [3, 3, 4, 4],
  [3, 4, 4, 4],
];
const STABILITY_EXPONENT = [0.15, 0.15, 0.2, 0.25, 0.3, 0.3];

/**
 * Pasquill class from speed + insolation, urban power law 10 m -> 2 m.
 *
 * @param {number} u10 - m/s at 10 m
 * @param {number} ghi
 */
export function wind2m(u10, ghi) {
  let cls;
  if (ghi > 0) {
    const j = ghi >= 925 ? 0 : ghi >= 675 ? 1 : ghi >= 175 ? 2 : 3;
    const i = u10 >= 6 ? 4 : u10 >= 5 ? 3 : u10 >= 3 ? 2 : u10 >= 2 ? 1 : 0;
    cls = STABILITY_TABLE[i][j];
  } else {
    cls = 5;
  }
  const p = STABILITY_EXPONENT[cls - 1];
  return Math.max(u10 * 0.2 ** p, MIN_SPEED);
}

/**
 * @param {(x: number) => number} fn
 * @param {number} start
 * @param {string} what
 */
function iterate(fn, start, what) {
  let prev = start;
  for (let n = 0; n < MAX_ITER; n += 1) {
    const next = fn(prev);
    if (Math.abs(next - prev) < CONVERGENCE) return next;
    prev = 0.9 * prev + 0.1 * next;
  }
  throw new HeatError(HEAT_REASON.MODEL_DID_NOT_CONVERGE, `WBGT ${what} did not converge`);
}

/**
 * Liljegren natural wet bulb, globe, and WBGT. All temperatures kelvin.
 *
 * @returns {{ tnwb: number, tg: number, wbgt: number }}
 */
export function liljegren(ta, rh, p, u2, ghiIn, zenIn, tsfc, albSfc) {
  const [zen, ghiClamped] = clampZenith(zenIn, ghiIn);
  const cza = Math.cos(zen);
  const [ghi, fdir] = normalizeSolar(ghiClamped, cza);
  const ea = emisAtm(ta, rh);
  const eair = rh * esat(ta);
  const lwEnv = 0.5 * (ea * ta ** 4 + EMIS_SFC * tsfc ** 4);

  const globe = (tg) => {
    const tref = 0.5 * (tg + ta);
    const h = hSphere(tref, p, u2);
    let radTerm = 0.0;
    if (ghi > 0) {
      radTerm =
        (ghi / (2 * STEFANB * EMIS_GLOBE)) *
        (1 - ALB_GLOBE) *
        (fdir * (1 / (2 * cza) - 1) + 1 + albSfc);
    }
    const val = lwEnv - (h / (STEFANB * EMIS_GLOBE)) * (tg - ta) + radTerm;
    if (val <= 0) {
      throw new HeatError(
        HEAT_REASON.MODEL_NON_PHYSICAL,
        'globe temperature iteration went non-physical'
      );
    }
    return val ** 0.25;
  };

  const wick = (tw) => {
    const tref = 0.5 * (tw + ta);
    const h = hCylinder(tref, p, u2);
    let fatm = STEFANB * EMIS_WICK * (lwEnv - tw ** 4);
    if (ghi > 0) {
      fatm +=
        (1 - ALB_WICK) *
        ghi *
        ((1 - fdir) * (1 + (0.25 * D_WICK) / L_WICK) +
          fdir * (Math.tan(zen) / Math.PI + (0.25 * D_WICK) / L_WICK) +
          albSfc);
    }
    const ew = esat(tw);
    const sc = viscosity(tref) / (((p * 100) / (R_AIR * tref)) * diffusivity(tref, p));
    return ta - (((hEvap(tref) / RATIO) * (ew - eair)) / (p - ew)) * (PR / sc) ** 0.56 + fatm / h;
  };

  const tg = iterate(globe, ta, 'globe temperature');
  const tw = iterate(wick, ta - 10, 'natural wet bulb');
  return { tnwb: tw, tg, wbgt: 0.7 * tw + 0.2 * tg + 0.1 * ta };
}

/**
 * Turf surface temperature from a no-evaporation energy balance, kelvin.
 *
 * @param {number} ta
 * @param {number} rh
 * @param {number} ghi
 * @param {number} u2
 * @param {number} hour - local hour 0-23
 */
export function turfSurfaceK(ta, rh, ghi, u2, hour) {
  const lwDown = emisAtm(ta, rh) * STEFANB * ta ** 4;
  const storage = Object.hasOwn(TURF_STORAGE, hour) ? TURF_STORAGE[hour] : TURF_STORAGE_DEFAULT;
  const absorbed = (1 - TURF_ALBEDO) * ghi * (1 - storage) + 0.95 * lwDown;
  const h = 5.7 + 3.8 * u2;
  let lo = ta - 20;
  let hi = ta + 80;
  let ts = 0.5 * (lo + hi);
  for (let n = 0; n < 100; n += 1) {
    ts = 0.5 * (lo + hi);
    if (0.95 * STEFANB * ts ** 4 + h * (ts - ta) > absorbed) {
      hi = ts;
    } else {
      lo = ts;
    }
  }
  return ts;
}

/**
 * Relative humidity (fraction) from air and dewpoint, F.
 *
 * @param {number} tF
 * @param {number} tdF
 */
export function rhFrom(tF, tdF) {
  if (tdF > tF + 0.5) {
    throw new HeatError(
      HEAT_REASON.DEWPOINT_ABOVE_AIR,
      `dewpoint ${tdF.toFixed(1)} F exceeds air temperature ${tF.toFixed(1)} F`
    );
  }
  return Math.min(esat(fToK(tdF)) / esat(fToK(tF)), 1.0);
}

/**
 * WBGT (F) at 1.2-2 m over the given surface for regional forecast inputs.
 *
 * @param {'grass'|'turf'} surface
 * @param {number} tF - regional air temperature, F
 * @param {number} tdF - regional dewpoint, F
 * @param {number} windMph - 10 m wind, mph
 * @param {number} ghi - W/m2
 * @param {number} zen - apparent zenith, radians
 * @param {number} hour - local hour 0-23
 * @param {number} pHpa - station pressure, hPa
 */
export function fieldWbgt(surface, tF, tdF, windMph, ghi, zen, hour, pHpa) {
  if (surface !== 'grass' && surface !== 'turf') {
    throw new HeatError(HEAT_REASON.SURFACE_UNKNOWN, `unknown surface ${JSON.stringify(surface)}`);
  }
  let t = tF;
  let td = tdF;
  if (surface === 'turf') {
    t += TURF_AIR_OFFSET_F;
    td += TURF_DEW_OFFSET_F;
  }
  const ta = fToK(t);
  const rh = rhFrom(t, td);
  const [zc, gc0] = clampZenith(zen, ghi);
  const [gc] = normalizeSolar(gc0, Math.cos(zc));
  const u2 = wind2m(Math.max(windMph, 0.0) * 0.44704, gc);
  let tsfc;
  let alb;
  if (surface === 'turf') {
    tsfc = turfSurfaceK(ta, rh, gc, u2, hour);
    alb = TURF_ALBEDO;
  } else {
    tsfc = ta;
    alb = GRASS_ALBEDO;
  }
  return kToF(liljegren(ta, rh, pHpa, u2, ghi, zen, tsfc, alb).wbgt);
}

/**
 * Regional air temperature (F) at which field WBGT reaches `targetWbgt`, with
 * dewpoint and wind held. `null` when even 125 F does not reach it (the
 * reference's NaN).
 *
 * @returns {number|null}
 */
export function airTrigger(surface, targetWbgt, tdF, windMph, ghi, zen, hour, pHpa) {
  let lo = Math.max(tdF + 1.0, 40.0);
  let hi = 125.0;
  const f = (t) => fieldWbgt(surface, t, tdF, windMph, ghi, zen, hour, pHpa);
  if (f(hi) < targetWbgt) return null;
  if (f(lo) >= targetWbgt) return lo;
  for (let n = 0; n < 50; n += 1) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) >= targetWbgt) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/**
 * Station pressure (hPa) from elevation (m): the reference's barometric
 * formula. Not the same formula as pvlib's `alt2pres` the solar path uses --
 * the reference uses both, so this port does too.
 *
 * @param {number} elevM
 */
export function stationPressureHpa(elevM) {
  return 1013.25 * (1 - 2.25577e-5 * elevM) ** 5.25588;
}
