/**
 * Must rules that cannot be met together, and what accepting a file's musts at once would do
 * (Phase D C2). Like `previewMustKeep`, this composes core and does not restate it: the verdicts are
 * `resolveCoachPreferences` (which finds a conflict: rules of one level whose sets for one dimension
 * share no value) and `judgeCoachPreferenceCandidate` (which practices a must would break), the very
 * functions the auto-scheduler's gate and the repair read. This file only enumerates teams and
 * inputs.
 *
 * **The teams examined come from the rules and the roster, never from the verdicts.** A conflict
 * found is a team that has rules in force; a team is not left out because nothing was found about it
 * (the Phase 2 review's lesson: a check that derives its universe from what a break corrupts compares
 * a set with itself). A rule row core cannot read is reported in `unreadable` with its reason and its
 * team is still examined without it, never skipped silently.
 */

import {
  judgeCoachPreferenceCandidate,
  resolveCoachPreferences,
} from '@squadlogic/core/practice/coachPreferences.js';
import { coachesOfTeamOn } from '@squadlogic/core/people/assignmentHistory.js';
import { PRACTICE_REASON } from '@squadlogic/core/practice/reasonCodes.js';
import {
  placementOfPracticeRow,
  practiceRowIsCurrent,
  ruleOfRow,
} from './coachPreferencePreview.js';

/**
 * @typedef {Object} MustConflict
 * @property {string} teamId
 * @property {string} dimension - weekday, start_time or venue
 * @property {string[]} ruleIds - the must rules that have no value in common
 * @property {string[]} coachIds
 * @property {string} message - core's sentence
 */

/**
 * The rules of one team in core's shape, with any row core cannot read set aside and reported.
 * @param {any[]} rows
 * @param {string} teamId
 */
function rulesOfTeam(rows, teamId) {
  const rules = [];
  const unreadable = [];
  for (const row of rows) {
    if (row.status !== 'in_force' || String(row.team_id) !== teamId) continue;
    try {
      rules.push(ruleOfRow(row));
    } catch (err) {
      unreadable.push({ ruleId: String(row.id), teamId, message: err?.message || String(err) });
    }
  }
  return { rules, unreadable };
}

/**
 * One team's resolution on `date`, over the rules given.
 * @param {Object} input
 * @param {string} input.teamId
 * @param {any[]} input.rosterRows
 * @param {any[]} input.practiceRows
 * @param {string} input.date
 */
function resolveTeam({ teamId, rosterRows, practiceRows, date }) {
  const { lead, assistants } = coachesOfTeamOn(rosterRows, teamId, date);
  const coachIds = [...new Set([...lead, ...assistants])];
  const placements = [];
  for (const row of practiceRows) {
    if (String(row.team_id) !== teamId || !practiceRowIsCurrent(row, date)) continue;
    const { placement } = placementOfPracticeRow(row);
    if (placement) placements.push({ row, placement });
  }
  const resolve = (ruleSet) =>
    resolveCoachPreferences({
      teamId,
      coachIds,
      rules: ruleSet,
      current: placements.map((entry) => entry.placement),
      date,
    });
  return { resolve, placements };
}

/** @param {any} finding */
const isMustConflict = (finding) =>
  finding.code === PRACTICE_REASON.COACH_PREFERENCE_CONFLICT && finding.details?.level === 'must';

/**
 * Every must conflict among the rules in force, per team.
 *
 * @param {Object} input
 * @param {any[]} input.ruleRows - `coach_practice_preferences` rows (only `in_force` ones are read)
 * @param {any[]} input.rosterRows - `team_coach_assignments` rows
 * @param {any[]} input.practiceRows - `practice_assignments` rows with their slot embedded
 * @param {string} input.date - `YYYY-MM-DD`, the day judged (the auto-scheduler's run date)
 * @returns {{ teamsExamined: string[], conflicts: MustConflict[],
 *   unreadable: Array<{ ruleId: string, teamId: string, message: string }> }}
 */
export function findMustConflicts({ ruleRows, rosterRows, practiceRows, date }) {
  const teamIds = [
    ...new Set(
      ruleRows.filter((row) => row.status === 'in_force').map((row) => String(row.team_id))
    ),
  ].sort();
  /** @type {MustConflict[]} */
  const conflicts = [];
  const unreadable = [];
  for (const teamId of teamIds) {
    const { rules, unreadable: bad } = rulesOfTeam(ruleRows, teamId);
    unreadable.push(...bad);
    const { resolve } = resolveTeam({ teamId, rosterRows, practiceRows, date });
    for (const finding of /** @type {any[]} */ (resolve(rules).findings)) {
      if (!isMustConflict(finding)) continue;
      conflicts.push({
        teamId,
        dimension: finding.details.dimension,
        ruleIds: finding.details.ruleIds,
        coachIds: finding.details.coachIds,
        message: finding.message,
      });
    }
  }
  return { teamsExamined: teamIds, conflicts, unreadable };
}

/**
 * What accepting a set of pending musts together would do, judged jointly (each rule's own
 * preview judges it alone, with the others still as prefer): the conflicts it would create among
 * the musts of the teams concerned (the existing musts included), and the current practice series
 * it would make unsatisfiable.
 *
 * @param {Object} input
 * @param {any[]} input.pendingRows - the pending-must rows to accept
 * @param {any[]} input.ruleRows - every rule row of the organization (the pending ones included)
 * @param {any[]} input.rosterRows
 * @param {any[]} input.practiceRows
 * @param {string} input.date
 * @returns {{ count: number, teamIds: string[], conflicts: MustConflict[],
 *   unsatisfiable: Array<{ teamId: string, assignmentId: string, placement: any,
 *     ruleIds: string[], alreadyUnsatisfiable: boolean }>,
 *   unreadable: Array<{ ruleId: string, teamId: string, message: string }> }}
 */
export function acceptAllImpact({ pendingRows, ruleRows, rosterRows, practiceRows, date }) {
  const pendingIds = new Set(pendingRows.map((row) => String(row.id)));
  const teamIds = [...new Set(pendingRows.map((row) => String(row.team_id)))].sort();
  /** @type {MustConflict[]} */
  const conflicts = [];
  const unsatisfiable = [];
  const unreadable = [];
  for (const teamId of teamIds) {
    const { rules, unreadable: bad } = rulesOfTeam(ruleRows, teamId);
    unreadable.push(...bad);
    const after = rules.map((rule) =>
      pendingIds.has(rule.id) ? { ...rule, level: 'must' } : rule
    );
    const { resolve, placements } = resolveTeam({ teamId, rosterRows, practiceRows, date });
    const resolution = resolve(after);
    const before = resolve(rules);
    for (const finding of /** @type {any[]} */ (resolution.findings)) {
      if (!isMustConflict(finding)) continue;
      // Only a conflict one of the accepted rules is part of is this decision's.
      if (!finding.details.ruleIds.some((id) => pendingIds.has(id))) continue;
      conflicts.push({
        teamId,
        dimension: finding.details.dimension,
        ruleIds: finding.details.ruleIds,
        coachIds: finding.details.coachIds,
        message: finding.message,
      });
    }
    for (const { row, placement } of placements) {
      const verdict = judgeCoachPreferenceCandidate(resolution, placement);
      const broken = verdict.violatedRules.filter((id) => pendingIds.has(id));
      if (broken.length === 0) continue;
      unsatisfiable.push({
        teamId,
        assignmentId: String(row.id),
        placement,
        ruleIds: broken,
        alreadyUnsatisfiable: judgeCoachPreferenceCandidate(before, placement).mustKeepViolated,
      });
    }
  }
  return { count: pendingRows.length, teamIds, conflicts, unsatisfiable, unreadable };
}
