/**
 * The practice repair recommendation panel's model (8.6 3b plan §7, PR 10):
 * database rows and a loss in; one view row per displaced series-window out.
 *
 * The chain is the approved one, reused and never restated: the PR 9 adapter
 * (`buildPracticeRepairInput`) turns rows into the repair's input, the repair
 * (`repairPracticeLoss`) computes the findings and the recommendations, and
 * `practice/recommendations.js` holds the decline / undo state.
 *
 * **Read-only.** Nothing here writes. `buildPracticeRepairPayload` is called
 * only to say, per window, whether a save of the current recommendations
 * would be refused and why (3b PR 9: every blackout window is refused until
 * PR 12). The payload itself is dropped on the floor: enacting is PR 11.
 *
 * **Daylight.** The adapter takes a sunset table and the venues'
 * coordinates. No sunset table is stored, so the table passed is empty and
 * the calendar's provider computes each venue's sunset from its OWN stored
 * coordinates with the core solar module (`sunsetForVenue()` ->
 * `timing/solar.js`, D10 precedence step 2). A single date-keyed table
 * computed from one venue would override every other venue's sunset, so none
 * is built. Nothing is geocoded or fetched. With no venue coordinates at all,
 * or no season time zone, no calendar is passed, and the repair's own
 * `PRACTICE_REPAIR_DAYLIGHT_UNCHECKED` finding says so on the panel.
 *
 * **Lighting overrides** (8.9 D14): none passed; their table is D14 PR B.
 * The adapter's `declared.lightingOverrides` note is shown instead.
 *
 * @module utils/practiceRepairPanel
 */

import {
  PRACTICE_REPAIR_PAYLOAD_REFUSAL,
  PRACTICE_TBD_REASON,
  buildPracticeRepairInput,
  buildPracticeRepairPayload,
  createRecommendationState,
  declineRecommendation,
  repairPracticeLoss,
  undoDecline,
} from '@squadlogic/core/practice/index.js';

/** Plain words for every TIME TBD reason the repair gives. */
export const TBD_REASON_TEXT = Object.freeze({
  [PRACTICE_TBD_REASON.NO_LEGAL_SLOT_AT_VENUE]: 'no free, legal slot of its length at its venue',
  [PRACTICE_TBD_REASON.CONTENDED]: 'its legal slots all went to other displaced practices',
  [PRACTICE_TBD_REASON.CHANGE_BUDGET]: 'placing it would exceed the change budget',
  [PRACTICE_TBD_REASON.OBJECTIVE_PREFERRED_TBD]:
    'the scoring priced every free slot at or above leaving it unplaced',
  [PRACTICE_TBD_REASON.COACH_PREFERENCE]: "every legal slot breaks a coach's must-keep preference",
  [PRACTICE_TBD_REASON.DECLINED]: 'its recommendation was declined and nothing else is free',
  [PRACTICE_TBD_REASON.PAST_SUNSET]: 'every free slot would run past sunset on unlit ground',
  [PRACTICE_TBD_REASON.SUNSET_UNKNOWN]:
    'the sunset is unknown on some date (no coordinates), so no unlit slot could be judged',
});

/** Plain words for every reason a save of a window would be refused. */
export const SAVE_REFUSAL_TEXT = Object.freeze({
  [PRACTICE_REPAIR_PAYLOAD_REFUSAL.MID_RANGE_WINDOW]:
    'the window ends before its practice series does, and schedules cannot show a temporary change yet',
  [PRACTICE_REPAIR_PAYLOAD_REFUSAL.WINDOW_INSIDE_ROW]:
    'the window lies inside its practice series, and schedules cannot show a temporary change yet',
  [PRACTICE_REPAIR_PAYLOAD_REFUSAL.NO_SLOT_FOR_SHAPE]:
    'no practice slot of that ground, day and time is valid over the whole window',
  [PRACTICE_REPAIR_PAYLOAD_REFUSAL.ROW_NOT_CLOSABLE]:
    'the series starts on or after the retirement, so it cannot be closed before it',
});

const WEEKDAY_TEXT = Object.freeze({
  MON: 'Mon',
  TUE: 'Tue',
  WED: 'Wed',
  THU: 'Thu',
  FRI: 'Fri',
  SAT: 'Sat',
  SUN: 'Sun',
});

/** @param {number} minutes */
function clock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** A shape's identity: the repair's own `shapeKey` fields, in its order. */
export function shapeIdentity(shape) {
  return `${shape.surfaceId}|${shape.weekday}|${shape.startMinutes}|${shape.durationMinutes}`;
}

/** `numeric` may arrive as a string from PostgREST; the adapter's own reading. */
function hasCoordinates(location) {
  const n = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
  const lat = n(location.latitude);
  const lon = n(location.longitude);
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    typeof lon === 'number' &&
    Number.isFinite(lon)
  );
}

/**
 * Whether a daylight calendar can be passed, and why not when it cannot.
 *
 * @param {Array<Record<string, any>>} locations
 * @param {string|null|undefined} timeZone - the season's IANA zone
 */
export function daylightPlanFor(locations, timeZone) {
  const withCoordinates = locations.filter(hasCoordinates).length;
  if (!timeZone) {
    return { daylight: null, why: 'the season has no time zone', withCoordinates };
  }
  if (withCoordinates === 0) {
    return { daylight: null, why: 'no venue has coordinates', withCoordinates };
  }
  return { daylight: { timeZone, sunsets: [] }, why: null, withCoordinates };
}

/**
 * Run the adapter and the repair, and start the decline state. Throws what
 * the adapter or the repair throws (an unreadable snapshot row, a non-uuid
 * location, ...): the caller shows it and no recommendation.
 *
 * @param {Record<string, any[]>} rows - `loadPracticeRepairSnapshot()` rows
 * @param {Object} loss - the adapter's `{kind:'retirement', field}` or `{kind:'blackout', blackout}`
 * @param {{ timeZone?: string|null }} [options]
 */
export function openPracticeRepair(rows, loss, { timeZone = null } = {}) {
  const daylightPlan = daylightPlanFor(rows.locations ?? [], timeZone);
  const adapted = buildPracticeRepairInput({
    locations: rows.locations,
    fields: rows.fields,
    fieldSubunits: rows.fieldSubunits,
    practiceSlots: rows.practiceSlots,
    practiceAssignments: rows.practiceAssignments,
    teamCoachAssignments: rows.teamCoachAssignments,
    coachPreferences: rows.coachPreferences,
    loss,
    ...(daylightPlan.daylight ? { daylight: daylightPlan.daylight } : {}),
  });
  const result = repairPracticeLoss(adapted.input);
  const state = createRecommendationState(adapted.input);
  return { adapted, result, state, daylightPlan };
}

/** @param {ReturnType<typeof createRecommendationState>} state @param {string} assignmentId */
export function declineIn(state, assignmentId) {
  return declineRecommendation(state, assignmentId);
}

/**
 * @param {ReturnType<typeof createRecommendationState>} state
 * @param {string} assignmentId
 * @param {Object} shape - the declined shape
 */
export function undoIn(state, assignmentId, shape) {
  return undoDecline(state, assignmentId, shape);
}

/**
 * Why a save of the CURRENT recommendations would be refused, per window,
 * from the adapter's own payload builder. The payload is never sent.
 *
 * @param {ReturnType<typeof openPracticeRepair>} opened
 * @param {ReturnType<typeof createRecommendationState>} state
 * @returns {Map<string, Array<{ why: string, window: string }>>}
 */
export function saveRefusalsOf(opened, state) {
  const { result, adapted } = opened;
  const rehomed = [];
  const timeTbd = [];
  for (const rec of state.recommendations) {
    const window = rec.window ?? null;
    if (rec.to) rehomed.push({ assignmentId: rec.assignmentId, to: rec.to, window });
    else timeTbd.push({ assignmentId: rec.assignmentId, reason: rec.reason, window });
  }
  const { refused } = buildPracticeRepairPayload(adapted, {
    representation: result.representation,
    lossDate: result.lossDate,
    rehomed,
    timeTbd,
  });
  /** @type {Map<string, Array<{ why: string, window: string }>>} */
  const byId = new Map();
  for (const entry of refused) {
    const list = byId.get(entry.assignment_id) ?? [];
    list.push({ why: entry.why, window: entry.window });
    byId.set(entry.assignment_id, list);
  }
  return byId;
}

/**
 * Names for surfaces, venues and teams, from the SAME rows the adapter read.
 * Ids are compared lowercased, as the adapter does.
 *
 * @param {Record<string, any[]>} rows
 */
export function namesOf(rows) {
  const lower = (v) => String(v).toLowerCase();
  const venue = new Map((rows.locations ?? []).map((l) => [lower(l.id), l.name || lower(l.id)]));
  const fieldById = new Map((rows.fields ?? []).map((f) => [lower(f.id), f]));
  const surface = new Map();
  for (const f of rows.fields ?? []) {
    surface.set(
      lower(f.id),
      `${f.name || lower(f.id)} (${venue.get(lower(f.location_id)) ?? '?'})`
    );
  }
  for (const s of rows.fieldSubunits ?? []) {
    const f = fieldById.get(lower(s.field_id));
    surface.set(
      lower(s.id),
      `${f?.name ?? '?'} ${s.label || lower(s.id)} (${venue.get(lower(f?.location_id)) ?? '?'})`
    );
  }
  const team = new Map((rows.teams ?? []).map((t) => [lower(t.id), t.name || lower(t.id)]));
  return {
    surface: (id) => surface.get(lower(id)) ?? id,
    team: (id) => team.get(lower(id)) ?? id,
  };
}

/** A shape in words: weekday, time, ground. */
export function describeShape(shape, names) {
  return `${WEEKDAY_TEXT[shape.weekday] ?? shape.weekday} ${clock(shape.startMinutes)} · ${names.surface(shape.surfaceId)}`;
}

/**
 * One view row per recommendation, in the repair's order (assignment id).
 *
 * @param {ReturnType<typeof openPracticeRepair>} opened
 * @param {ReturnType<typeof createRecommendationState>} state
 * @param {ReturnType<typeof namesOf>} names
 */
export function panelRowsOf(opened, state, names) {
  const refusals = saveRefusalsOf(opened, state);
  return state.recommendations.map((rec) => ({
    assignmentId: rec.assignmentId,
    team: names.team(rec.teamId),
    now: describeShape(rec.from, names),
    window: rec.window
      ? `${rec.window.from} to ${rec.window.until}`
      : `${rec.effectiveFrom} to ${rec.effectiveUntil}`,
    to: rec.to ? describeShape(rec.to, names) : null,
    tier: rec.tier,
    reason: rec.to ? null : rec.reason,
    reasonText: rec.to ? null : (TBD_REASON_TEXT[rec.reason] ?? rec.reason),
    refusals: (refusals.get(rec.assignmentId) ?? []).map((r) => ({
      why: r.why,
      text: SAVE_REFUSAL_TEXT[r.why] ?? r.why,
    })),
    declined: state.declined
      .filter((d) => d.assignmentId === rec.assignmentId)
      .map((d) => ({ shape: d.to, key: shapeIdentity(d.to), text: describeShape(d.to, names) })),
    canDecline: Boolean(rec.to) && !state.enacted.includes(rec.assignmentId),
  }));
}
