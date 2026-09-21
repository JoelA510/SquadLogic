/**
 * The season-2026 practice grid, as a practice plan.
 *
 * Takes the **already-parsed** grid records
 * (`loadSeason2026Practice().practiceSlots`) as an argument, so this module
 * never learns where the corpus lives or how it is read — the same contract
 * `facility/adapters/season2026PracticeGeometry.js` keeps. The arrow points
 * fixtures → practice, never back.
 *
 * ## The one judgement this adapter makes, and the one it refuses
 *
 * **It makes:** a grid row is a *(slot, assignment)* pair, not a slot. Rows
 * sharing ground, weekday, start, duration and revision are one slot that
 * several teams hold — which is what `practice_slots.capacity` is for, and
 * what `practice_slots` having no team column already implies.
 *
 * **It refuses:** to date the revisions.
 * `fixtures/season-2026/practice/README.md` §4 — "Seven revisions of the plan
 * coexist with no statement of which is current… `source_sheet` is retained
 * per row rather than resolved, because the source does not say." Every slot
 * built here therefore has a **null validity range**, and
 * `buildPracticeSlotSet()` reports one `PRACTICE_REVISION_UNDATED` per
 * revision plus `PRACTICE_REVISION_ORDER_UNKNOWN`. A plan that materialises to
 * nothing and says why is the honest reading; inventing August-to-November for
 * all seven would make the corpus's central open question disappear into a
 * default.
 *
 * @module practice/adapters/season2026PracticeGrid
 */

import {
  PRACTICE_SURFACE_RESOLUTION,
  resolvePracticeSurface,
} from '../../facility/practiceSurfaces.js';

/**
 * Turn parsed `practice_grid.csv` records into slots and assignments.
 *
 * ## Ground is resolved, never spelled
 *
 * The grid's venue spelling is **not** a facility-graph id and must not be
 * turned into one by string formatting. `season2026PracticeGeometry.js:191-202`
 * says so outright — the grid writes `Maplewood` where the graph venue is the
 * game corpus's `Maplewood Back` — and `facility/practiceSurfaces.js` exists
 * for exactly this lookup, naming that case in its own module doc. An earlier
 * draft of this adapter built ids with `season2026PracticeSurfaceId()` and
 * produced 14 distinct surface ids the graph does not hold, covering 252 of
 * the 457 rows, with no finding raised: an id that resolves to nothing, which
 * every downstream occupancy and closure check would have silently declined to
 * decide on.
 *
 * So the triple goes through {@link resolvePracticeSurface}, and the answer's
 * status is carried on the slot. Rows that do not resolve are **kept** — the
 * corpus README's own principle, so the count stays honest — and
 * `buildPracticeSlotSet()` raises `PRACTICE_SLOT_SURFACE_UNRESOLVED` for each.
 * The loader separately reports the 28 `(unresolved)` venue rows as
 * `PRACTICE_VENUE_UNRESOLVED`; that is the *sheet* being unreadable, this is
 * the *graph* not holding the ground, and they are different facts.
 *
 * @param {ReadonlyArray<Object>} records - `loadSeason2026Practice().practiceSlots`
 * @param {import('../../facility/types.js').FacilityGraph} graph - the practice-layer graph
 * @param {import('../../facility/types.js').VenueComplexMap} complexMap
 * @returns {{ slots: Array<Object>, assignments: Array<Object>, source: string }}
 */
export function toSeason2026PracticePlan(records, graph, complexMap) {
  if (!Array.isArray(records)) {
    throw new TypeError('toSeason2026PracticePlan requires the parsed practice_grid records');
  }
  if (!graph || !complexMap) {
    throw new TypeError(
      'toSeason2026PracticePlan requires the practice facility graph and venue-complex map; ' +
        'grid venue spellings are not surface ids and must be resolved, not formatted'
    );
  }

  /** group key -> slot */
  const slotsByKey = new Map();
  /** @type {Array<Object>} */
  const assignments = [];

  for (const record of records) {
    const resolution = resolvePracticeSurface(graph, complexMap, {
      venue: record.venue,
      field: record.field,
      subunit: record.subunit,
    });
    // On `resolved` there is exactly one id. On anything else the first id (or
    // a legible marker when there are none) keeps the slot addressable while
    // the status says not to trust it.
    const surfaceId =
      resolution.status === PRACTICE_SURFACE_RESOLUTION.RESOLVED
        ? resolution.surfaceIds[0]
        : (resolution.surfaceIds[0] ??
          `unresolved::${record.venue}/${record.field}${record.subunit ? `/${record.subunit}` : ''}`);
    // Revision is part of the identity: two revisions describing the same
    // window are two versions of the plan, and merging them would delete the
    // structure §4 of the README is about.
    const key = [
      surfaceId,
      record.weekday,
      record.startMinutes,
      record.durationMinutes,
      record.sourceSheet,
    ].join('\u0000');

    let slot = slotsByKey.get(key);
    if (!slot) {
      slot = {
        id: `s2026-practice::${slotsByKey.size}`,
        surfaceId,
        weekday: record.weekday,
        startMinutes: record.startMinutes,
        durationMinutes: record.durationMinutes,
        // Null, and stated as a decision rather than a default. See above.
        validFrom: null,
        validUntil: null,
        capacity: 0,
        revisionId: record.sourceSheet,
        label: `${record.venue} ${record.field}${record.subunit ? ` ${record.subunit}` : ''}`,
        surfaceResolution: resolution.status,
      };
      slotsByKey.set(key, slot);
    }
    slot.capacity += 1;

    assignments.push({
      // The parser's row id, which is unique per row; a `slot::team` id would
      // collide the day one team appears twice in one window.
      id: record.id,
      slotId: slot.id,
      teamId: record.teamCode,
      effectiveFrom: null,
      effectiveUntil: null,
    });
  }

  return {
    slots: [...slotsByKey.values()],
    assignments,
    source: 'fixtures/season-2026/practice/practice_grid.csv',
  };
}
