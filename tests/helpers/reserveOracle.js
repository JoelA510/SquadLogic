/**
 * An independent reading of how many reserve slots a day holds, for tests.
 *
 * **Why it exists.** Since the owner's decision of 2026-11-02 ("Yes to legal-with-a-warning for
 * kickoffs after sunset, because some orgs have portable lighting or other workarounds.") the
 * daylight limit does not stop a slot: a kickoff that ends inside the sunset margin is legal and
 * carries a warning. What stops a day's slots is the permit (its blackout, its open and its
 * close) and a lights-off time. This module states that, from the permit rows and the format's
 * timing, and never from the report it is checked against.
 *
 * It deliberately does **not** call `checkKickoffAvailability()`, `latestLegalKickoff()` or
 * `buildReserveCapacityReport()`; it shares only `resolvePermitWindow()` and `resolveLighting()`,
 * which resolve the permit and lighting records and are not what the relabel changed.
 *
 * The grid is the capacity report's own contract (`reserve/capacity.js`): the first candidate is
 * the later of the earliest kickoff and the permit's open, then one every `cadenceMinutes`, up to
 * `latestKickoffMinutes`, ending at the first kickoff whose game would end after the permit close
 * (or the lights-off time), or at once on a date with no permit.
 */

import { resolveLighting, resolvePermitWindow } from '@squadlogic/core/availability/index.js';

/**
 * @param {Object} spec
 * @param {Object} spec.graph
 * @param {Object} spec.calendar
 * @param {string} spec.surfaceId
 * @param {string} spec.date
 * @param {number} spec.occupancyMinutes - the format's scheduled occupancy
 * @param {number} spec.earliestKickoffMinutes
 * @param {number} spec.cadenceMinutes
 * @param {number} [spec.latestKickoffMinutes]
 * @returns {number[]} the kickoff minutes that are legal (sunset aside)
 */
export function expectedReserveKickoffs(spec) {
  const {
    graph,
    calendar,
    surfaceId,
    date,
    occupancyMinutes,
    earliestKickoffMinutes,
    cadenceMinutes,
    latestKickoffMinutes = 24 * 60,
  } = spec;
  const surface = graph.surfaces[surfaceId];
  const window = resolvePermitWindow(calendar, { venueId: surface.venueId, date }).window;
  const lighting = resolveLighting(graph, calendar, surfaceId);

  /** @type {number[]} */
  const kickoffs = [];
  const open = window && window.hasPermit && window.openMinutes !== null ? window.openMinutes : 0;
  for (
    let kickoff = Math.max(earliestKickoffMinutes, open);
    kickoff <= latestKickoffMinutes;
    kickoff += cadenceMinutes
  ) {
    const end = kickoff + occupancyMinutes;
    if (window && !window.hasPermit) break;
    if (window && window.closeMinutes !== null && end > window.closeMinutes) break;
    if (
      lighting.lit === true &&
      lighting.lightsOffMinutes !== null &&
      end > lighting.lightsOffMinutes
    )
      break;
    kickoffs.push(kickoff);
  }
  return kickoffs;
}
