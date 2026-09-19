/**
 * **One ordering rule for every document a persistence seam writes.**
 *
 * Three packages declare a `serialise*()` / `read*()` document pair —
 * `fieldAdmin/serialise.js`, `externalImport/mapping.js` and
 * `publication/serialise.js` — and until 2026-09-19 two of them disagreed about
 * record order: `fieldAdmin` sorted by id and documented byte-stability as a
 * rule, `externalImport` preserved the caller's insertion order. Two logically
 * identical registries therefore produced two different documents in one
 * package and one document in the other.
 *
 * That difference is harmless while nothing stores either, and stops being
 * harmless the moment something does. **A table is a set.** "Has this registry
 * changed since we stored it?" answered by comparing documents would report a
 * registry read back in a different order as an edit — a false difference
 * reported by the machinery that exists to find true ones, which is incident
 * 1's shape.
 *
 * ## Why code-unit order and not `localeCompare`
 *
 * The contract is *byte stability across runs*, and `localeCompare` varies with
 * the runtime's default locale and ICU build — notably in how it weights `#`,
 * `_`, `.`, `/` and `-`, which every id in these registries is full of
 * (`field_constraints.csv#10` against `#2`;
 * `season-2026/external/alder-back-pitch-2`). A declared ordering has to be one
 * the machine cannot have an opinion about, so this compares code units and
 * nothing else.
 *
 * Non-ASCII ids sort by code unit too, which is deliberate: the rule is *a
 * total order two runs agree on*, not *the order a person would file them in*.
 * A document is not a reading order.
 *
 * ## What this module does not claim
 *
 * Not every document's records are a set. `publication/serialise.js`
 * deliberately does **not** sort: a publication snapshot's rows carry no id,
 * and their order is inside {@link import('./publication/snapshot.js').publicationDigest},
 * so re-ordering them changes the artifact's digest by design. That module
 * states the exemption and the reason in its own header rather than importing
 * this one and quietly not using it.
 *
 * @module documentOrder
 */

/**
 * Compare two ids in code-unit order. Total, and locale-independent.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number} -1, 0 or 1
 */
export function compareIdsCodeUnit(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * A copy of `records`, ordered by `id` in code-unit order.
 *
 * Copies rather than sorts in place: every registry in this repository is
 * frozen, and a serialiser that reordered its input would be mutating the thing
 * it is meant to be taking a faithful copy of.
 *
 * Records sharing an id keep their relative order (`Array.prototype.sort` is
 * stable), so a duplicate id is left for the caller's own duplicate check to
 * report rather than silently rearranged here.
 *
 * @template {{ id?: unknown }} T
 * @param {ReadonlyArray<T>} records
 * @returns {T[]}
 */
export function sortRecordsById(records) {
  return [...records].sort((a, b) => compareIdsCodeUnit(String(a.id), String(b.id)));
}
