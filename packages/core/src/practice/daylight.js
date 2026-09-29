/**
 * Practice daylight: no unlit practice runs past sunset.
 *
 * ## The rule
 *
 * Operator ruling 2026-09-27: "teams don't practice after sunset at unlit
 * fields, and the right margin is sunset." Every **materialised** practice
 * occurrence on unlit ground must end at or before `floor(sunset)` less
 * {@link PRACTICE_SUNSET_MARGIN_MINUTES}, which is **0**: the civil twilight
 * after sunset is the teardown window, not practice time. Decision D1 makes it
 * hard, D2 makes the limit the `floor` of sunset, D6 makes the margin this one
 * named constant (no season column; its Deno twin arrives with the Edge
 * post-pass and is pinned equal to it by the drift test). Games keep their own
 * 15-minute margin in `availability/`; nothing here touches them.
 *
 * - **Lit ground is exempt.** Lighting resolves through `resolveLighting()`,
 *   the field-then-ancestor-then-venue chain the game path uses. A lit field's
 *   *lights-off* time is a lighting bound, not a daylight one, and this
 *   evaluator does **not** enforce it for practices: declared, not enforced.
 *   Such occurrences are counted in `litOccurrencesWithLightsOff` so the gap
 *   is visible rather than read as a pass (no corpus field states one; GAP-05).
 * - **Undeclared lighting is unlit** (D5), exactly as `kickoff.js` carries it:
 *   the conservative bound, with the gap counted.
 * - **No sunset is never "allowed".** A venue with no table record for the
 *   date and no coordinates gets `SUNSET_UNKNOWN` (cause
 *   `venue-coordinates-missing`), is counted in `daylightUnknownOccurrences`
 *   and is listed as unknown -- neither flagged nor allowed.
 *
 * ## What it examines, and how a caller proves it did
 *
 * The input is the occurrences `materialisePracticeOccurrences()` produced, so
 * a practice is judged on the date it actually happens, overrides applied.
 * The evaluator enumerates **its input**; it cannot know what the input should
 * have held. That is the caller's meta-assertion, and the counters are there
 * for it: `practicesExamined` (team-practices: one team, one date) and
 * `unlitPracticeOccurrencesExamined` must be compared against a universe
 * derived from the roster and the slot x date expansion, never from this
 * result (`tests/practiceDaylight.test.js`, W4/W5).
 *
 * ## Where it is enforced
 *
 * In **core evaluation only** -- the `practice-daylight` claim in the season's
 * constraint registry says so. The core `practiceScheduling.js` and
 * `autoScheduler.js` do not call it; the live practice scheduler is the Deno
 * auto-scheduler, whose daylight post-pass (8.9 PR 6,
 * `supabase/functions/_shared/engines/practice-daylight.ts`) applies this rule
 * to the placements a run produces, with the Deno twin of the margin below.
 *
 * Every violation carries an attribution of kind `sunset` with the numbers
 * (end, sunset, margin, limit, overrun, source) for 8.10's explanations.
 *
 * @module practice/daylight
 */

import { z } from 'zod';

import { getSurface } from '../facility/facilityGraph.js';
import { resolveLighting, sunsetForVenue } from '../availability/calendar.js';
import {
  AVAILABILITY_CONSTRAINT,
  AVAILABILITY_REASON,
  deriveAvailabilityStatus,
  makeAvailabilityFinding,
} from '../availability/reasonCodes.js';
import { PracticeLightingOverrideSchema } from './schemas.js';

/**
 * Minutes before sunset an unlit practice must be over: **0**, by operator
 * ruling 2026-09-27. A practice ending exactly at `floor(sunset)` is legal; one
 * minute later is not (`tests/practiceDaylight.test.js`, W15).
 */
export const PRACTICE_SUNSET_MARGIN_MINUTES = 0;

/** The registry claim this evaluator's violations are governed by. */
export const PRACTICE_DAYLIGHT_CONSTRAINT_ID = 'practice-daylight';

/**
 * The one reading of portable-lighting overrides (8.9 D14): a predicate
 * `(slotId, date) => boolean`, true when an override on that slot covers the
 * date, `[from, until]` inclusive. `durationPhases.js` and `repair.js` read
 * overrides through this, so a window means one thing everywhere.
 *
 * @param {ReadonlyArray<{ slotId: string, from: string, until: string }>|undefined} lightingOverrides
 * @returns {(slotId: string, date: string) => boolean}
 */
export function lightingOverrideCovers(lightingOverrides) {
  const overrides = z.array(PracticeLightingOverrideSchema).parse(lightingOverrides ?? []);
  /** @type {Map<string, Array<{ from: string, until: string }>>} */
  const bySlot = new Map();
  for (const { slotId, from, until } of overrides) {
    const list = bySlot.get(slotId) ?? [];
    list.push({ from, until });
    bySlot.set(slotId, list);
  }
  return (slotId, date) =>
    (bySlot.get(slotId) ?? []).some((window) => window.from <= date && date <= window.until);
}

/**
 * @typedef {Object} PracticeDaylightMeta
 * @property {number} occurrencesExamined - every occurrence handed in
 * @property {number} practicesExamined - team-practices: the sum of each
 *   occurrence's `teamIds.length`
 * @property {number} unlitPracticeOccurrencesExamined - unlit or undeclared
 * @property {number} undeclaredLightingOccurrences - of those, lighting `null`
 * @property {number} unknownSurfaceOccurrences - of those, ground the graph
 *   does not hold (lighting cannot be read, so it is carried as undeclared)
 * @property {number} litPracticeOccurrencesExempt
 * @property {number} litOccurrencesWithLightsOff - of the exempt, those whose
 *   field states a lights-off time this evaluator does not check
 * @property {number} lightingOverrideOccurrencesExempt - unlit occurrences a
 *   portable-lighting override covers (8.9 D14): not judged, never unknown, and
 *   never folded into the lit counter. Not in
 *   `unlitPracticeOccurrencesExamined`: unlit ground = examined + this
 * @property {number} lightingOverridesUnused - overrides that exempted no
 *   occurrence of this input (a slot or window it does not hold): reported,
 *   not refused, since the input is a window of the season, not the plan
 * @property {number} daylightUnknownOccurrences
 * @property {number} practiceOccurrencesPastSunset
 * @property {number} practiceOccurrencesWithinDaylight
 */

/**
 * @typedef {Object} PracticeDaylightVerdict
 * @property {string} occurrenceId
 * @property {string} slotId
 * @property {string} surfaceId
 * @property {string|null} venueId
 * @property {string} date
 * @property {number} startMinutes
 * @property {number} endMinutes
 * @property {ReadonlyArray<string>} teamIds
 * @property {boolean|null} lit
 * @property {number|null} sunsetMinutes - the enforcement minute
 * @property {number|null} limitMinutes
 * @property {'table'|'computed'|'unknown'} sunsetSource
 */

/**
 * Judge every materialised practice occurrence against daylight.
 *
 * @param {Object} input
 * @param {ReadonlyArray<import('./types.js').PracticeOccurrence>} input.occurrences
 * @param {import('../facility/types.js').FacilityGraph} input.graph
 * @param {import('../availability/types.js').AvailabilityCalendar} input.calendar - the
 *   daylight provider: its table, its per-venue coordinates and its zone
 * @param {ReadonlyArray<{ slotId: string, from: string, until: string }>} [input.lightingOverrides] -
 *   approved portable-lighting windows (8.9 D14), matched on `occurrence.slotId`
 * @returns {{
 *   flagged: Array<PracticeDaylightVerdict & { overrunMinutes: number, attribution: Object }>,
 *   unknown: PracticeDaylightVerdict[],
 *   allowed: string[],
 *   exempt: string[],
 *   findings: import('../availability/types.js').AvailabilityFinding[],
 *   status: string,
 *   marginMinutes: number,
 *   meta: PracticeDaylightMeta,
 * }}
 */
export function evaluatePracticeDaylight({ occurrences, graph, calendar, lightingOverrides }) {
  const windows = z.array(PracticeLightingOverrideSchema).parse(lightingOverrides ?? []);
  const overridden = lightingOverrideCovers(windows);
  if (!Array.isArray(occurrences)) {
    throw new TypeError('evaluatePracticeDaylight requires the materialised occurrences');
  }
  if (!graph || !calendar) {
    throw new TypeError('evaluatePracticeDaylight requires the facility graph and the calendar');
  }

  /** @type {PracticeDaylightMeta} */
  const meta = {
    occurrencesExamined: 0,
    practicesExamined: 0,
    unlitPracticeOccurrencesExamined: 0,
    undeclaredLightingOccurrences: 0,
    unknownSurfaceOccurrences: 0,
    litPracticeOccurrencesExempt: 0,
    litOccurrencesWithLightsOff: 0,
    lightingOverrideOccurrencesExempt: 0,
    lightingOverridesUnused: 0,
    daylightUnknownOccurrences: 0,
    practiceOccurrencesPastSunset: 0,
    practiceOccurrencesWithinDaylight: 0,
  };
  const flagged = [];
  /** @type {PracticeDaylightVerdict[]} */
  const unknown = [];
  /** @type {string[]} */
  const allowed = [];
  /** @type {string[]} */
  const exempt = [];
  /** @type {import('./types.js').PracticeOccurrence[]} */
  const exemptOn = [];
  /** @type {import('../availability/types.js').AvailabilityFinding[]} */
  const findings = [];

  for (const occurrence of occurrences) {
    meta.occurrencesExamined += 1;
    meta.practicesExamined += occurrence.teamIds.length;

    const surface = getSurface(graph, occurrence.surfaceId);
    const venueId = surface?.venueId ?? null;
    const lighting = surface ? resolveLighting(graph, calendar, occurrence.surfaceId) : null;
    const lit = lighting ? lighting.lit : null;
    if (lit === true) {
      meta.litPracticeOccurrencesExempt += 1;
      if (lighting?.lightsOffMinutes != null) meta.litOccurrencesWithLightsOff += 1;
      continue;
    }
    // Portable lighting (D14): not judged, so no sunset is asked for and none
    // can be unknown. Counted apart from lit ground, never folded into it.
    if (overridden(occurrence.slotId, occurrence.date)) {
      meta.lightingOverrideOccurrencesExempt += 1;
      exempt.push(occurrence.id);
      exemptOn.push(occurrence);
      continue;
    }
    meta.unlitPracticeOccurrencesExamined += 1;
    if (lit === null) meta.undeclaredLightingOccurrences += 1;
    if (!surface) meta.unknownSurfaceOccurrences += 1;

    const context = {
      occurrenceId: occurrence.id,
      slotId: occurrence.slotId,
      surfaceId: occurrence.surfaceId,
    };
    const daylight = sunsetForVenue(calendar, { venueId, date: occurrence.date });
    for (const finding of daylight.findings) {
      findings.push(
        makeAvailabilityFinding(finding.code, finding.message, { ...finding.details, ...context })
      );
    }

    const limitMinutes =
      daylight.sunsetMinutes === null
        ? null
        : daylight.sunsetMinutes - PRACTICE_SUNSET_MARGIN_MINUTES;
    /** @type {PracticeDaylightVerdict} */
    const verdict = {
      occurrenceId: occurrence.id,
      slotId: occurrence.slotId,
      surfaceId: occurrence.surfaceId,
      venueId,
      date: occurrence.date,
      startMinutes: occurrence.startMinutes,
      endMinutes: occurrence.endMinutes,
      teamIds: occurrence.teamIds,
      lit,
      sunsetMinutes: daylight.sunsetMinutes,
      limitMinutes,
      sunsetSource: daylight.source,
    };

    if (limitMinutes === null) {
      meta.daylightUnknownOccurrences += 1;
      unknown.push(verdict);
      continue;
    }
    if (occurrence.endMinutes <= limitMinutes) {
      meta.practiceOccurrencesWithinDaylight += 1;
      allowed.push(occurrence.id);
      continue;
    }

    const overrunMinutes = occurrence.endMinutes - limitMinutes;
    meta.practiceOccurrencesPastSunset += 1;
    const numbers = {
      endMinutes: occurrence.endMinutes,
      sunsetMinutes: /** @type {number} */ (daylight.sunsetMinutes),
      marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
      limitMinutes,
      overrunMinutes,
      sunsetSource: daylight.source,
    };
    flagged.push({
      ...verdict,
      overrunMinutes,
      attribution: {
        kind: AVAILABILITY_CONSTRAINT.SUNSET,
        constraintId: PRACTICE_DAYLIGHT_CONSTRAINT_ID,
        code: AVAILABILITY_REASON.PRACTICE_PAST_SUNSET,
        ...numbers,
      },
    });
    findings.push(
      makeAvailabilityFinding(
        AVAILABILITY_REASON.PRACTICE_PAST_SUNSET,
        `${occurrence.date}: the practice on ${occurrence.surfaceId} ends at minute ${occurrence.endMinutes}, ${overrunMinutes} min past sunset (minute ${daylight.sunsetMinutes}, ${daylight.source}) on ${lit === null ? 'undeclared' : 'unlit'} ground`,
        { ...context, venueId, date: occurrence.date, lit, ...numbers }
      )
    );
  }

  // An override that exempted nothing here (a slot or a window this input does
  // not hold) is counted, never silently unread.
  meta.lightingOverridesUnused = windows.filter(
    (window) =>
      !exemptOn.some(
        (occurrence) =>
          occurrence.slotId === window.slotId &&
          window.from <= occurrence.date &&
          occurrence.date <= window.until
      )
  ).length;

  return {
    flagged,
    unknown,
    allowed,
    exempt,
    findings,
    status: deriveAvailabilityStatus(findings),
    marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES,
    meta,
  };
}
