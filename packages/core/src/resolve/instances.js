/**
 * **Which breach is this?** Per-instance identity for placement findings and
 * rule-engine violations, and the one place that decides whether a breach the
 * published schedule carried is still the same breach once a game stands
 * somewhere else.
 *
 * ## Why counts per code were not enough
 *
 * Until 8.6 PR 2 every "is this new?" question in `resolve/` compared counts
 * per code: a game's blocking findings at a candidate slot against the counts
 * its published slot carried, and the rule engine's violations per code across
 * the whole schedule. Both miss the same thing. Two measured cases, both on the
 * corpus's busiest venue-date with two clashes stacked into the baseline:
 *
 * - **A swapped instance nets to zero.** A request that swaps the movable
 *   halves of two accepted clashes leaves every game at `OCCUPIED_SAME_SURFACE:
 *   1` — each now clashing with a *different* opponent — and the run came back
 *   `allowed` with no finding, `verify` included. The same swap on a clean
 *   baseline dislodged and re-placed both games.
 * - **Acceptance travelled with the game.** A game dislodged off an accepted
 *   clash was re-placed **into** a clash on a different field, because the
 *   count it carried at its published slot was honoured at every slot. The
 *   clean-baseline control put the same game on a clean slot 100 minutes later.
 *
 * Both are latent on the published season, where only the four `Scrimmage`
 * rows carry anything blocking, and both fire on a venue withdrawal — the event
 * 8.6 exists for — where every stranded game carries a closure.
 *
 * ## The rule
 *
 * An exception the published schedule carried was accepted **for that game on
 * that slot**. So:
 *
 * - at the game's published slot, an instance is accepted when the baseline
 *   carried *that instance*: the same code **and the same counterpart games**;
 * - anywhere else, only an instance whose code {@link FINDING_LOCUS travels
 *   with the game} is accepted — a format with no size row is unsized wherever
 *   it is played, and refusing it everywhere would take the four scrimmages off
 *   the board the first time anything displaced them.
 *
 * @module resolve/instances
 */

import { AVAILABILITY_REASON } from '../availability/reasonCodes.js';
import { FACILITY_REASON } from '../facility/reasonCodes.js';
import { TIMING_REASON } from '../timing/reasonCodes.js';

/** Where a finding's truth lives. */
export const FINDING_LOCUS = Object.freeze({
  /** True of the game wherever it stands: its format, or the season itself. */
  CARRIED: 'carried',
  /** True of where the game stands and who stands beside it. */
  PLACED: 'placed',
});

/**
 * The registries `checkKickoffAvailability()` draws every finding code from —
 * the universe the locus table must cover. `tests/perViolationKeying.test.js`
 * fails if any code in them is unclassified, so a code added to one of these
 * registries cannot reach the gate without somebody deciding its locus.
 */
export const PLACEMENT_REASON_REGISTRIES = Object.freeze({
  FACILITY_REASON,
  AVAILABILITY_REASON,
  TIMING_REASON,
});

/**
 * Codes whose truth does not depend on the slot. Deliberately short.
 *
 * **When unsure, a code is PLACED.** The two ways of being wrong are not
 * symmetric: a placed code misfiled as carried reopens the blind spot this
 * module closes, silently; a carried code misfiled as placed refuses that game
 * every slot but its own, and the placer then reports it TIME TBD **with a
 * reason** — loud, attributable, and caught by the season fixture.
 */
/** @type {ReadonlyArray<string>} */
const CARRIED_CODES = Object.freeze([
  // The format has no row in the size-rank table (GAP-14's four scrimmages).
  FACILITY_REASON.SIZE_UNKNOWN_FORMAT,
  // Facts about the format's timing row, identical at every slot.
  TIMING_REASON.FORMAT_TIMING_UNDEFINED,
  TIMING_REASON.FORMAT_TIMING_DUPLICATE,
  TIMING_REASON.OCCUPANCY_DERIVATION_DISAGREES,
  TIMING_REASON.BLOCK_SHORTER_THAN_OCCUPANCY,
  TIMING_REASON.HALFTIME_IS_RANGE,
  TIMING_REASON.HALFTIME_UNDECLARED,
  TIMING_REASON.WARMUP_DURATION_UNSPECIFIED,
  // The season has no clock; every slot of every game carries it equally.
  TIMING_REASON.SEASON_TIMEZONE_MISSING,
  TIMING_REASON.SEASON_TIMEZONE_UNKNOWN,
]);

// A carried code that is not in its registry would be `undefined` here and
// classify nothing, silently. Refused at load instead.
for (const code of CARRIED_CODES) {
  if (typeof code !== 'string') {
    throw new Error('resolve/instances: a CARRIED_CODES entry names no registry code');
  }
}

/**
 * Every code in {@link PLACEMENT_REASON_REGISTRIES}, classified.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FINDING_LOCUS_BY_CODE = Object.freeze(
  Object.fromEntries(
    Object.values(PLACEMENT_REASON_REGISTRIES)
      .flatMap((registry) => Object.values(registry))
      .map((code) => [
        code,
        CARRIED_CODES.includes(code) ? FINDING_LOCUS.CARRIED : FINDING_LOCUS.PLACED,
      ])
  )
);

/**
 * The locus of one code. A code outside the universe is PLACED, for the reason
 * {@link CARRIED_CODES} gives; the test that enumerates the universe is what
 * stops that default being reached by a code anyone meant to classify.
 *
 * @param {string} code
 * @returns {string}
 */
export function findingLocusOf(code) {
  return FINDING_LOCUS_BY_CODE[code] ?? FINDING_LOCUS.PLACED;
}

/**
 * The keys the facility model names another booking under. The one list:
 * `legality.js` derives `counterpartGameIds` through {@link findingCounterparts}
 * too. `attribution/claims.js` reads two more (`bookingId`, `boundByBookingIds`)
 * for its own purpose; adopting them here would change which games `dislodge`
 * treats as parties, which is not this module's call to make silently.
 */
const COUNTERPART_KEYS = Object.freeze(['bookingAId', 'bookingBId', 'otherBookingId']);

/**
 * The games a finding names besides the one being placed, sorted.
 *
 * @param {{ details?: Record<string, unknown> }} finding
 * @param {ReadonlySet<string>} self - ids that are the placed game itself
 * @returns {string[]}
 */
export function findingCounterparts(finding, self) {
  const details = /** @type {Record<string, unknown>} */ (finding.details ?? {});
  /** @type {Set<string>} */
  const ids = new Set();
  for (const key of COUNTERPART_KEYS) {
    const value = details[key];
    if (typeof value === 'string' && !self.has(value)) ids.add(value);
  }
  return [...ids].sort();
}

/**
 * One placement finding's identity: its code, and the games it is *with*.
 *
 * @param {{ code: string, details?: Record<string, unknown> }} finding
 * @param {ReadonlySet<string>} self
 * @returns {string}
 */
export function findingInstanceKey(finding, self) {
  const counterparts = findingCounterparts(finding, self);
  return counterparts.length === 0 ? finding.code : `${finding.code}|${counterparts.join(',')}`;
}

/**
 * The code an instance key was built from.
 *
 * @param {string} key
 * @returns {string}
 */
export function codeOfInstance(key) {
  const bar = key.indexOf('|');
  return bar === -1 ? key : key.slice(0, bar);
}

/**
 * What the published schedule's record accepts **at this slot**.
 *
 * @param {{ slotKey: string, instances: Readonly<Record<string, number>> }|undefined} record -
 *   the game's published slot and the instances it carried there
 * @param {string} candidateSlotKey
 * @returns {Record<string, number>}
 */
export function acceptedAtSlot(record, candidateSlotKey) {
  if (record === undefined) return {};
  if (record.slotKey === candidateSlotKey) return { ...record.instances };
  /** @type {Record<string, number>} */
  const accepted = {};
  for (const [key, count] of Object.entries(record.instances)) {
    if (findingLocusOf(codeOfInstance(key)) === FINDING_LOCUS.CARRIED) accepted[key] = count;
  }
  return accepted;
}

/**
 * The codes of every instance that occurs **more often** than accepted,
 * de-duplicated and sorted — the shape every caller already reports in.
 *
 * @param {Readonly<Record<string, number>>} now
 * @param {Readonly<Record<string, number>>} accepted
 * @returns {string[]}
 */
export function grownCodes(now, accepted) {
  return [...new Set(grownInstances(now, accepted).map(codeOfInstance))].sort();
}

/**
 * The instance keys that occur more often than accepted, sorted.
 *
 * @param {Readonly<Record<string, number>>} now
 * @param {Readonly<Record<string, number>>} accepted
 * @returns {string[]}
 */
export function grownInstances(now, accepted) {
  return Object.entries(now)
    .filter(([key, count]) => count > (accepted[key] ?? 0))
    .map(([key]) => key)
    .sort();
}

/**
 * The counterpart games an instance key names, if any.
 *
 * @param {string} key
 * @returns {string[]}
 */
export function counterpartsOfInstance(key) {
  const bar = key.indexOf('|');
  return bar === -1 ? [] : key.slice(bar + 1).split(',');
}

/**
 * One rule-engine violation's identity: **who**, never where.
 *
 * The rule, the code, the subject (every rule engine subject is built from
 * game, person, team or division identities) and the other bookings the
 * violation names in its details — the counterpart of a same-ground clash sits
 * in `bookingBId`, not in the entities, because the rule engine attaches the
 * finding to one half of the pair only. Not the entities: they carry the
 * game's surface, venue and date, so any game that moved would turn every
 * violation it already carried into a "new" one. Where a game stands is the
 * gate's question, answered per slot in {@link acceptedAtSlot}; `verify` asks
 * whether the schedule now breaks something about somebody it did not before.
 *
 * @param {{ ruleId?: string, code: string, subjectId?: string, details?: Record<string, unknown> }} violation
 * @returns {string}
 */
export function violationInstanceKey(violation) {
  const counterparts = findingCounterparts(violation, new Set());
  return [
    violation.ruleId ?? '',
    violation.code,
    violation.subjectId ?? '',
    counterparts.join(','),
  ].join('|');
}
