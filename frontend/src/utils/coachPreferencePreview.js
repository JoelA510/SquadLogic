/**
 * Coach practice preferences in the UI: display vocabulary, the backend-missing
 * check, and the approval-time re-judge (Phase 8.6 PR 3b, PR 2).
 *
 * **The re-judge composes core; it does not restate it.** Plan §4 has the
 * approval dialog show which of the coach's teams' CURRENT practice series a
 * new `must_keep` would make unsatisfiable. The rule that decides that lives in
 * `@squadlogic/core/practice/coachPreferences.js` (`resolveCoachPreferences` +
 * `judgeCoachPreferenceCandidate`) and the team's current coaches come from
 * `@squadlogic/core/people/assignmentHistory.js` (`coachesOfTeamOn`). This file
 * only enumerates inputs and reads verdicts.
 *
 * **Teams are enumerated from the roster** (`team_coach_assignments` rows
 * current on the day), never from the preference rows: a coach's first request
 * has no approved preference yet, so a preference-derived team list would be
 * empty and the preview would read "none" over a real conflict.
 *
 * **Why `series: null`.** Resolved against the series itself, a `must_keep`
 * keeps whatever the series already is, so every current series would pass
 * trivially. The question at approval is "does this series keep the value being
 * approved", so the value is the reference and each current series is judged
 * as a candidate against it.
 */

import {
  COACH_PREFERENCE_LEVEL,
  CoachPreferencePlacementSchema,
  CoachPreferenceSchema,
  judgeCoachPreferenceCandidate,
  resolveCoachPreferences,
} from '@squadlogic/core/practice/coachPreferences.js';
import { assignmentRowCovers, coachesOfTeamOn } from '@squadlogic/core/people/assignmentHistory.js';
import { PRACTICE_REASON } from '@squadlogic/core/practice/reasonCodes.js';

export const DIMENSION_LABEL = Object.freeze({
  weekday: 'Weekday',
  start_time: 'Start time',
  venue: 'Venue',
});

export const LEVEL_LABEL = Object.freeze({
  must_keep: 'Must keep',
  prefer_keep: 'Prefer to keep',
  dont_care: "Don't care",
});

export const STATUS_LABEL = Object.freeze({
  requested: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Superseded',
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
 * Re-judge a decision at approval time.
 *
 * @param {Object} input
 * @param {{ coachId: string, dimension: string, level: string, value: unknown }} input.proposal -
 *   the preference as it would be in force after the decision
 * @param {any[]} input.approvedRows - `coach_practice_preferences` rows; only `approved` ones are read
 * @param {any[]} input.rosterRows - `team_coach_assignments` rows (the roster)
 * @param {any[]} input.practiceRows - `practice_assignments` rows with `slot` embedded
 * @param {string} input.date - `YYYY-MM-DD`
 */
export function previewMustKeep({ proposal, approvedRows, rosterRows, practiceRows, date }) {
  const coachId = String(proposal.coachId);
  const empty = {
    applies: false,
    noReference: false,
    teamIds: [],
    unsatisfiable: [],
    unjudged: [],
    teamsWithoutSeries: [],
    conflicts: [],
  };
  if (proposal.level !== COACH_PREFERENCE_LEVEL.MUST_KEEP) return empty;

  const proposed = CoachPreferenceSchema.parse({
    coachId,
    dimension: proposal.dimension,
    level: proposal.level,
    value: proposal.value ?? null,
  });

  // The roster, never the preferences: see the header.
  const teamIds = [
    ...new Set(
      rosterRows
        .filter((row) => String(row.coach_id) === coachId && assignmentRowCovers(row, date))
        .map((row) => String(row.team_id))
    ),
  ].sort();

  const result = { ...empty, applies: true, teamIds };
  for (const teamId of teamIds) {
    const { lead, assistants } = coachesOfTeamOn(rosterRows, teamId, date);
    const coachIds = [...new Set([...lead, ...assistants])];
    const onTeam = new Set(coachIds);
    const inForce = approvedRows
      .filter((row) => row.status === 'approved' && onTeam.has(String(row.coach_id)))
      .map((row) => ({
        coachId: String(row.coach_id),
        dimension: row.dimension,
        level: row.level,
        value: row.value ?? null,
      }));
    const replaced = (pref) => pref.coachId === coachId && pref.dimension === proposal.dimension;
    // After the decision: the proposal replaces this coach's approved row on the
    // dimension (the RPC supersedes it). Before: what is in force today, so a
    // series a co-coach's must_keep already breaks is not blamed on this one.
    const preferences = [...inForce.filter((pref) => !replaced(pref)), proposed];
    const resolution = resolveCoachPreferences({ coachIds, preferences, series: null });
    const before = resolveCoachPreferences({ coachIds, preferences: inForce, series: null });
    for (const finding of resolution.findings) {
      if (finding.details?.dimension !== proposal.dimension) continue;
      if (
        finding.code === PRACTICE_REASON.COACH_PREFERENCE_NO_REFERENCE &&
        String(finding.details?.coachId) === coachId
      ) {
        result.noReference = true;
      } else if (finding.code === PRACTICE_REASON.COACH_PREFERENCE_CONFLICT) {
        result.conflicts.push({ teamId, message: finding.message });
      }
    }

    const series = practiceRows.filter(
      (row) => String(row.team_id) === teamId && practiceRowIsCurrent(row, date)
    );
    if (series.length === 0) result.teamsWithoutSeries.push(teamId);
    for (const row of series) {
      const { placement, problem } = placementOfPracticeRow(row);
      if (!placement) {
        result.unjudged.push({ teamId, assignmentId: String(row.id), problem });
        continue;
      }
      const verdict = judgeCoachPreferenceCandidate(resolution, placement);
      if (verdict.violatedDimensions.includes(proposal.dimension)) {
        const already = judgeCoachPreferenceCandidate(before, placement).violatedDimensions;
        result.unsatisfiable.push({
          teamId,
          assignmentId: String(row.id),
          placement,
          alreadyUnsatisfiable: already.includes(proposal.dimension),
        });
      }
    }
  }
  return result;
}
