/**
 * "May this game stand here?" — asked entirely through Phase 1.3 and Phase 2.1.
 *
 * Nothing in this file decides anything. `checkKickoffAvailability()` answers
 * occupancy, permit, lighting, daylight, size, lining and equipment, and hands
 * back its four constraints ordered by tightness; the constraint registry
 * re-severities what came back, so hardness stays data (GAP-12). A second copy
 * of any of that here would be free to disagree with the first.
 *
 * **The bound of this module's remit, stated plainly.** Legality here means
 * *facility legality*. Turnover floors, round-robin completeness, home/away
 * balance and coach travel are the standing rule engine's, and `resolve/`
 * reports them through its `verify` stage rather than repairing them. Prompt
 * 4.2's objective weighs them — a candidate slot carrying a compromise costs
 * more than a clean one — but **this** function is still the only thing that
 * decides what is *legal*, and a change that leaves a schedule facility-legal
 * and turnover-short is reported as exactly that.
 *
 * @module resolve/legality
 */

import { applyRegistrySeverity, effectiveSeverityTable } from '../constraints/severity.js';
import { CONSTRAINT_SEVERITY, CONSTRAINT_STATUS } from '../constraints/reasonCodes.js';
import { checkKickoffAvailability } from '../availability/kickoff.js';
import { getSurface } from '../facility/facilityGraph.js';
import { findingInstanceKey } from './instances.js';

/** The id `checkKickoffAvailability()` gives the candidate it invents. */
const PROBE_BOOKING_ID = '__availability_probe__';

/**
 * The bookings standing on a date, as the facility model wants them.
 *
 * @param {import('./types.js').ResolveState} state
 * @param {string} date
 * @param {string} exceptGameId
 * @returns {Array<import('../facility/types.js').FacilityBooking>}
 */
export function bookingsOn(state, date, exceptGameId) {
  /** @type {Array<import('../facility/types.js').FacilityBooking>} */
  const bookings = [];
  for (const gameId of state.gameIds) {
    if (gameId === exceptGameId) continue;
    const game = state.games[gameId];
    if (!game || game.date !== date) continue;
    bookings.push({
      id: game.id,
      surfaceId: game.surfaceId,
      date: game.date,
      startMinutes: game.startMinutes,
      endMinutes: game.endMinutes,
      format: game.format,
      label: `${game.homeLabel} v ${game.awayLabel}`,
    });
  }
  return bookings;
}

/**
 * Is this game legal on this slot, given everything else currently placed?
 *
 * @param {{ graph: import('../facility/types.js').FacilityGraph, table: import('../timing/types.js').FormatTimingTable, calendar: import('../availability/types.js').AvailabilityCalendar, registry: import('../constraints/types.js').ConstraintRegistry }} engines
 * @param {import('./types.js').ResolveState} state
 * @param {string} gameId
 * @param {import('./types.js').Slot} slot
 * @returns {{ legal: boolean, status: string, findings: Array<Object>, blockingCodes: string[], blockingCodeCounts: Record<string, number>, blockingInstanceCounts: Record<string, number>, findingInstances: Record<string, { severity: string, count: number }>, counterpartGameIds: string[], availability: Object, registryFindings: Array<Object> }}
 */
export function checkPlacement(engines, state, gameId, slot) {
  const game = state.baseline[gameId];
  if (!game) throw new Error(`resolve: no baseline game "${gameId}"`);
  const surface = getSurface(engines.graph, slot.surfaceId);
  const teamIds = [game.homeTeamId, game.awayTeamId].filter(
    (id) => typeof id === 'string' && id.length > 0
  );

  const availability = checkKickoffAvailability(
    engines.graph,
    engines.table,
    engines.calendar,
    {
      surfaceId: slot.surfaceId,
      date: slot.date,
      kickoffMinutes: slot.startMinutes,
      format: game.format,
      ignoreBookingIds: [gameId],
    },
    { existingBookings: bookingsOn(state, slot.date, gameId) }
  );

  const severity = effectiveSeverityTable(engines.registry, {
    date: slot.date,
    venueId: surface?.venueId ?? game.venueId,
    surfaceId: slot.surfaceId,
    surfaceLineage: surface ? [...surface.lineage] : [slot.surfaceId],
    ...(game.divisionLabel ? { divisionLabel: game.divisionLabel } : {}),
    // **The sides are a scope the caller already holds.** `ScopeContextSchema`
    // takes an absent field as "the context does not name one", so leaving the
    // teams out made every `team`-scoped record `CONSTRAINT_SCOPE_UNJUDGED` and
    // therefore not applied — while the rule engine narrows per subject with
    // exactly this field (`ruleEngine/engine.js` `subjectScopeContext()`), so
    // one registry gave two verdicts about one game. Derived the same way
    // `resolve/resolve.js` and `resolve/probe.js` derive it for the freeze
    // plan, and omitted rather than sent empty when the row names no side: the
    // corpus's reserved league slots carry TBD teams, and an empty array is a
    // stated "no teams" that would match nothing while claiming to have looked.
    ...(teamIds.length > 0 ? { teamIds } : {}),
  });
  const applied = applyRegistrySeverity(availability.findings, severity);

  const blocking = applied.findings.filter(
    (finding) => finding.severity === CONSTRAINT_SEVERITY.BLOCKING
  );
  /** @type {Set<string>} */
  const counterparts = new Set();
  for (const finding of blocking) {
    const details = /** @type {Record<string, unknown>} */ (finding.details ?? {});
    for (const key of ['bookingAId', 'bookingBId', 'otherBookingId']) {
      const value = details[key];
      if (typeof value !== 'string') continue;
      if (value === PROBE_BOOKING_ID || value === gameId) continue;
      counterparts.add(value);
    }
  }

  // **How many, not just whether.** `blockingCodes` is the de-duplicated set and
  // is what the error message and the registry lookup want; it is not enough to
  // decide whether a candidate slot is worse than the one the schedule arrived
  // with. A game already overlapping one neighbour and offered a slot where it
  // would overlap two carries the same *set* in both places, and a comparison
  // on presence alone reads that as no change. `verify` already compares the
  // rule engine's violations per code by count, and this is the same contract
  // one layer down.
  /** @type {Record<string, number>} */
  const blockingCodeCounts = {};
  for (const finding of blocking) {
    blockingCodeCounts[finding.code] = (blockingCodeCounts[finding.code] ?? 0) + 1;
  }

  // **Which breach, not only how many.** Counts per code cannot tell a game
  // that kept its clash from one that traded it for a clash with somebody
  // else — the count is 1 in both places. Every "is this new?" question in
  // `stages.js` compares these instead; see `resolve/instances.js`.
  const self = new Set([gameId, PROBE_BOOKING_ID]);
  /** @type {Record<string, number>} */
  const blockingInstanceCounts = {};
  /** @type {Record<string, { severity: string, count: number }>} */
  const findingInstances = {};
  for (const finding of applied.findings) {
    if (
      finding.severity !== CONSTRAINT_SEVERITY.BLOCKING &&
      finding.severity !== CONSTRAINT_SEVERITY.COMPROMISE
    ) {
      continue;
    }
    const key = findingInstanceKey(finding, self);
    if (finding.severity === CONSTRAINT_SEVERITY.BLOCKING) {
      blockingInstanceCounts[key] = (blockingInstanceCounts[key] ?? 0) + 1;
    }
    const entry = findingInstances[key];
    if (entry === undefined) findingInstances[key] = { severity: finding.severity, count: 1 };
    else entry.count += 1;
  }

  return {
    legal: applied.status !== CONSTRAINT_STATUS.REJECTED,
    status: applied.status,
    findings: applied.findings,
    blockingCodes: [...new Set(blocking.map((finding) => finding.code))].sort(),
    blockingCodeCounts,
    blockingInstanceCounts,
    findingInstances,
    counterpartGameIds: [...counterparts].sort(),
    availability,
    // **What the seam itself said, carried rather than dropped.**
    // `effectiveSeverityTable()` returns a table *and* a report: which records
    // it could not judge here, which it retyped, and where two of equal
    // specificity disagreed. That report was discarded, so a constraint the
    // lookup could not decide about — a `person`-scoped record, or a `team`-
    // scoped one against a fixture whose sides are still TBD — was silently not
    // applied and nothing anywhere said so.
    //
    // Kept **beside** `findings` rather than merged into it, on purpose.
    // `findings`, `status` and `legal` are this function's answer to "is the
    // game legal on this slot", and they are facility legality re-severitied;
    // a note about how the registry was read is provenance about the reading,
    // not a fact about the ground. Merging it would move `status` for every
    // candidate slot in the solver's hot path on the strength of a remark.
    //
    // **Where it is read, stated because for one round it was read nowhere.**
    // Carrying the report and having no caller look at it is not a middle path
    // between merging and dropping — it is the appearance of one, and the
    // trace reached exactly as many reports as the drop it replaced.
    // `attribution/explain.js` `claimsForPlacement()` now restates every
    // consequential entry as `ATTRIBUTION_CONSTRAINT_UNJUDGED`, so
    // `explainGame()` and `explainKickoffTime()` — one question at a time,
    // holding the game, and able to afford it — carry it into their own
    // `findings` and `status`. `resolve/stages.js` still reads neither field,
    // which is the whole reason the split exists.
    // `tests/sourceHygiene.test.js` fails if that reader ever goes away.
    //
    // `registryStatus` stood here too and is gone: it was
    // `deriveConstraintStatus(severity.findings)` and stated no fact these
    // findings do not, so it was a second inert field beside the first rather
    // than a second half of the report. Deleted rather than given a contrived
    // reader, which would have been the same mistake wearing a check's clothes.
    registryFindings: severity.findings,
  };
}
