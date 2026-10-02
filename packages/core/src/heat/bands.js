/**
 * U.S. Soccer Recognize to Recover heat alert bands (WBGT, F).
 *
 * Source: U.S. Soccer Heat Guidelines poster, linked from
 * https://www.recognizetorecover.org/environmental (verified 2026-10-02).
 * The poster's own ranges are written to 0.1 F with gaps (Category 1: Green
 * <76.1, Yellow 76.3-81.0, Orange 81.1-84.1, Red 84.2-86.1, Black >86.2). Each
 * band here is closed at its upper bound, which closes those gaps, and a WBGT
 * is banded **after** rounding to 0.1 F so the displayed number and its band can
 * never disagree (approved deviation from the reference, which banded the
 * unrounded value).
 *
 * Category 2 Black: the poster's table says >89.8 and its text says >89.9.
 * The stricter 89.8 is used.
 *
 * @module heat/bands
 */

export const HEAT_CATEGORIES = Object.freeze([1, 2, 3]);
export const DEFAULT_HEAT_CATEGORY = 1;

/**
 * Upper bound (inclusive) of each band; anything above Red is Black.
 *
 * @type {Readonly<Record<1|2|3, ReadonlyArray<readonly [string, number]>>>}
 */
export const HEAT_BANDS = /** @type {any} */ (
  Object.freeze({
    1: Object.freeze([
      ['Green', 76.1],
      ['Yellow', 81.0],
      ['Orange', 84.1],
      ['Red', 86.2],
    ]),
    2: Object.freeze([
      ['Green', 79.8],
      ['Yellow', 84.6],
      ['Orange', 87.7],
      // Poster table >89.8 vs text >89.9: the stricter 89.8 is used.
      ['Red', 89.8],
    ]),
    3: Object.freeze([
      ['Green', 82.1],
      ['Yellow', 87.0],
      ['Orange', 90.0],
      ['Red', 92.0],
    ]),
  })
);

export const BAND_NAMES = Object.freeze(['Green', 'Yellow', 'Orange', 'Red', 'Black']);

/**
 * @param {unknown} category
 * @returns {asserts category is 1|2|3}
 */
function assertCategory(category) {
  if (category !== 1 && category !== 2 && category !== 3) {
    throw new RangeError(`US Soccer heat category must be 1, 2 or 3, got ${String(category)}`);
  }
}

/**
 * Round the way Python's `round(x, digits)` does: by the exact binary value,
 * exact ties to even. A tie needs an exactly representable half (e.g. 80.25 at
 * one decimal, 64.5 at none); anything else rounds by its true value, which is
 * what `toFixed` does.
 *
 * @param {number} x
 * @param {number} [digits=0]
 */
export function roundHalfEven(x, digits = 0) {
  if (!Number.isFinite(x)) throw new RangeError(`roundHalfEven needs a finite number, got ${x}`);
  const exact = x.toFixed(60);
  const point = exact.indexOf('.');
  const tail = exact.slice(point + 1 + digits);
  if (/^50*$/.test(tail)) {
    const scale = 10 ** digits;
    const scaled = Math.floor(x * scale);
    return (scaled % 2 === 0 ? scaled : scaled + 1) / scale;
  }
  return Number(x.toFixed(digits));
}

/**
 * The alert band for a WBGT, banded on the value rounded to 0.1 F.
 *
 * @param {number} wbgtF
 * @param {1|2|3} category
 * @returns {'Green'|'Yellow'|'Orange'|'Red'|'Black'}
 */
export function heatBand(wbgtF, category) {
  assertCategory(category);
  const shown = roundHalfEven(wbgtF, 1);
  for (const [name, upper] of HEAT_BANDS[category]) {
    if (shown <= upper) return /** @type {any} */ (name);
  }
  return 'Black';
}

/**
 * The WBGT targets the air-temperature triggers solve for: the first value of
 * Red (Orange's upper bound + 0.1) and the Red/Black boundary.
 *
 * @param {1|2|3} category
 * @returns {{ red: number, black: number }}
 */
export function triggerTargets(category) {
  assertCategory(category);
  const bands = HEAT_BANDS[category];
  // The reference's expression, float error included (84.1 + 0.1 = 84.19999...).
  return { red: bands[2][1] + 0.1, black: bands[3][1] };
}
