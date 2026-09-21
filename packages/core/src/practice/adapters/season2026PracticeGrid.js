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

import { season2026PracticeSurfaceId } from '../../facility/adapters/season2026PracticeGeometry.js';

/**
 * Turn parsed `practice_grid.csv` records into slots and assignments.
 *
 * Unresolved-venue rows (the corpus's 28, whose section heading is not machine
 * readable) are **kept**, under a surface id built from the `(unresolved)`
 * token, for the reason the corpus README gives for keeping them at all: so
 * the count stays honest. The loader already reports each one as
 * `PRACTICE_VENUE_UNRESOLVED`; re-reporting here would double-count a fact.
 *
 * @param {ReadonlyArray<Object>} records - `loadSeason2026Practice().practiceSlots`
 * @returns {{ slots: Array<Object>, assignments: Array<Object>, source: string }}
 */
export function toSeason2026PracticePlan(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('toSeason2026PracticePlan requires the parsed practice_grid records');
  }

  /** group key -> slot */
  const slotsByKey = new Map();
  /** @type {Array<Object>} */
  const assignments = [];

  for (const record of records) {
    const surfaceId = season2026PracticeSurfaceId(record.venue, record.field, record.subunit);
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
