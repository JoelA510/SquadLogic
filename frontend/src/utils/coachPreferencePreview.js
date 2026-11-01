/**
 * Practice preference rules in the UI: display vocabulary, the backend-missing check, and the
 * approval-time re-judge (Phase D C1; originally Phase 8.6 PR 3b, PR 2).
 *
 * **The re-judge composes core; it does not restate it.** Accepting a requested must (or adding
 * one) shows which of the team's CURRENT practice series it would make unsatisfiable. The rule that
 * decides that lives in `@squadlogic/core/practice/coachPreferences.js` (`resolveCoachPreferences` +
 * `judgeCoachPreferenceCandidate`) and the team's current coaches come from
 * `@squadlogic/core/people/assignmentHistory.js` (`coachesOfTeamOn`). This file only enumerates
 * inputs and reads verdicts.
 *
 * **The team is the rule's own** (a rule is for one team), and its current series are read from the
 * practice rows. Each series is judged as a candidate against every rule in force for the team
 * (a pending must in force as prefer included), with the proposed must in place of its own earlier
 * level.
 */

import {
  CoachPreferencePlacementSchema,
  CoachPreferenceRuleSchema,
  judgeCoachPreferenceCandidate,
  resolveCoachPreferences,
} from '@squadlogic/core/practice/coachPreferences.js';
import { coachesOfTeamOn } from '@squadlogic/core/people/assignmentHistory.js';
import { PRACTICE_REASON } from '@squadlogic/core/practice/reasonCodes.js';

export const DIMENSION_LABEL = Object.freeze({
  weekday: 'Weekday',
  start_time: 'Start time',
  venue: 'Venue',
});

export const LEVEL_LABEL = Object.freeze({
  must: 'Must',
  prefer: 'Prefer',
});

export const DECISION_LABEL = Object.freeze({
  pending: 'Pending must',
  accepted: 'Accepted as must',
  kept_prefer: 'Kept as prefer',
});

export const WEEKDAY_OPTIONS = Object.freeze([
  { code: 'MON', label: 'Monday' },
  { code: 'TUE', label: 'Tuesday' },
  { code: 'WED', label: 'Wednesday' },
  { code: 'THU', label: 'Thursday' },
  { code: 'FRI', label: 'Friday' },
  { code: 'SAT', label: 'Saturday' },
  { code: 'SUN', label: 'Sunday' },
]);

/** @param {number} minutes */
export function minutesToClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * `HH:MM` or `HH:MM:SS` to minutes past midnight; null for anything else.
 * @param {unknown} clock
 */
export function clockToMinutes(clock) {
  if (typeof clock !== 'string') return null;
  const match = clock.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * A stored value as a reader sees it.
 * @param {string} dimension
 * @param {unknown} value
 * @param {Map<string, string>} [locationNames]
 */
export function formatPreferenceValue(dimension, value, locationNames = new Map()) {
  if (value === null || value === undefined) return 'Current series';
  if (dimension === 'weekday') {
    return WEEKDAY_OPTIONS.find((option) => option.code === value)?.label ?? String(value);
  }
  if (dimension === 'start_time' && typeof value === 'number') return minutesToClock(value);
  if (dimension === 'venue') return locationNames.get(String(value)) ?? `Unknown venue (${value})`;
  return String(value);
}

/**
 * True when the error says the preferences table or one of its RPCs does not
 * exist: the migration has not reached this database. PostgREST reports a
 * missing table as PGRST205 (schema cache) or Postgres 42P01, and a missing
 * function as PGRST202 or 42883.
 *
 * @param {{ code?: string, message?: string } | null | undefined} error
 */
export function isPreferencesBackendMissing(error) {
  if (!error) return false;
  return ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(String(error.code ?? ''));
}

/** Today as a local `YYYY-MM-DD`, the form `team_coach_assignments` windows use. */
export function localIsoDate(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Whether a `practice_assignments` row is still in force on `date`: its
 * `effective_date_range` upper bound has not passed. A row with no range, or a
 * range this cannot read, counts as current, so it is judged rather than
 * silently left out.
 *
 * @param {{ effective_date_range?: string | null }} row
 * @param {string} date
 */
export function practiceRowIsCurrent(row, date) {
  const range = row?.effective_date_range;
  if (typeof range !== 'string') return true;
  const match = range.match(/^[[(]\s*([^,]*),\s*([^\])]*)([\])])$/);
  if (!match) return true;
  const upper = match[2].trim().replace(/"/g, '');
  if (upper === '' || upper === 'infinity') return true;
  return match[3] === ')' ? date < upper : date <= upper;
}

/**
 * The placement a `practice_assignments` row (with its slot embedded as
 * `slot`, and the slot's field as `field`) holds, in the shape core judges.
 *
 * @param {any} row
 * @returns {{ placement: { weekday: string, startMinutes: number, locationId: string } | null, problem: string | null }}
 */
export function placementOfPracticeRow(row) {
  const slot = row?.slot ?? null;
  if (!slot) return { placement: null, problem: 'no practice slot (TIME TBD)' };
  const candidate = {
    weekday: typeof slot.day_of_week === 'string' ? slot.day_of_week.toUpperCase() : null,
    startMinutes: clockToMinutes(slot.start_time),
    locationId: slot.field?.location_id ?? null,
  };
  const parsed = CoachPreferencePlacementSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      placement: null,
      problem: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }
  return { placement: parsed.data, problem: null };
}

/**
 * A rule row (`coach_practice_preferences`) as core reads a rule.
 * @param {any} row
 */
export function ruleOfRow(row) {
  return CoachPreferenceRuleSchema.parse({
    id: String(row.id),
    coachId: String(row.coach_id),
    teamId: String(row.team_id),
    level: row.level,
    weekdays: row.weekdays ?? null,
    startMinutes: row.start_minutes ?? null,
    venueIds: row.venue_ids ?? null,
    keepWeekday: row.keep_weekday === true,
    keepStart: row.keep_start === true,
    keepVenue: row.keep_venue === true,
    coachPriority: row.coach_priority ?? null,
    effectiveFrom: row.effective_from ?? null,
    effectiveTo: row.effective_to ?? null,
  });
}

/**
 * A rule as a reader sees it: the conditions joined by " · ", several values as "A or B".
 * @param {any} row
 * @param {Map<string, string>} [locationNames]
 */
export function describeRule(row, locationNames = new Map()) {
  const list = (values, dimension) =>
    values.map((value) => formatPreferenceValue(dimension, value, locationNames)).join(' or ');
  const parts = [];
  if (row.weekdays) parts.push(list(row.weekdays, 'weekday'));
  else if (row.keep_weekday) parts.push('keep the current day');
  if (row.start_minutes) parts.push(list(row.start_minutes, 'start_time'));
  else if (row.keep_start) parts.push('keep the current start time');
  if (row.venue_ids) parts.push(list(row.venue_ids, 'venue'));
  else if (row.keep_venue) parts.push('keep the current venue');
  return parts.join(' · ');
}

/**
 * Re-judge a requested must at the moment an admin accepts it (or adds one): which of the team's
 * current practice series it would make unsatisfiable.
 *
 * @param {Object} input
 * @param {any} input.proposal - the rule as it would be in force, in core's shape (level `must`);
 *   its `id` names a rule already in force (replaced by this one), or is new
 * @param {any[]} input.ruleRows - `coach_practice_preferences` rows; only `in_force` ones are read
 * @param {any[]} input.rosterRows - `team_coach_assignments` rows (the roster)
 * @param {any[]} input.practiceRows - `practice_assignments` rows with `slot` embedded
 * @param {string} input.date - `YYYY-MM-DD`
 */
export function previewMustKeep({ proposal, ruleRows, rosterRows, practiceRows, date }) {
  const empty = {
    applies: false,
    noReference: false,
    teamIds: [],
    unsatisfiable: [],
    unjudged: [],
    teamsWithoutSeries: [],
    conflicts: [],
  };
  if (proposal.level !== 'must') return empty;

  const proposed = CoachPreferenceRuleSchema.parse(proposal);
  const teamId = proposed.teamId;
  const result = { ...empty, applies: true, teamIds: [teamId] };

  // The team's roster on the day, never the rule rows.
  const { lead, assistants } = coachesOfTeamOn(rosterRows, teamId, date);
  const coachIds = [...new Set([...lead, ...assistants])];
  const inForce = ruleRows
    .filter((row) => row.status === 'in_force' && String(row.team_id) === teamId)
    .map(ruleOfRow);
  const after = [...inForce.filter((rule) => rule.id !== proposed.id), proposed];

  const series = practiceRows.filter(
    (row) => String(row.team_id) === teamId && practiceRowIsCurrent(row, date)
  );
  if (series.length === 0) result.teamsWithoutSeries.push(teamId);
  const placements = [];
  for (const row of series) {
    const { placement, problem } = placementOfPracticeRow(row);
    if (!placement) result.unjudged.push({ teamId, assignmentId: String(row.id), problem });
    else placements.push({ row, placement });
  }
  const resolve = (rules) =>
    resolveCoachPreferences({
      teamId,
      coachIds,
      rules,
      current: placements.map((entry) => entry.placement),
      date,
    });
  const resolution = resolve(after);
  const before = resolve(inForce);

  for (const finding of /** @type {any[]} */ (resolution.findings)) {
    if (
      finding.code === PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE &&
      finding.details?.ruleId === proposed.id
    ) {
      result.noReference = true;
    } else if (
      finding.code === PRACTICE_REASON.COACH_PREFERENCE_CONFLICT &&
      finding.details?.ruleIds?.includes(proposed.id)
    ) {
      result.conflicts.push({ teamId, message: finding.message });
    }
  }
  for (const { row, placement } of placements) {
    const verdict = judgeCoachPreferenceCandidate(resolution, placement);
    if (verdict.violatedRules.includes(proposed.id)) {
      result.unsatisfiable.push({
        teamId,
        assignmentId: String(row.id),
        placement,
        alreadyUnsatisfiable: judgeCoachPreferenceCandidate(before, placement).mustKeepViolated,
      });
    }
  }
  return result;
}
