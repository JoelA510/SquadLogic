import {
  PRACTICE_UNPLACED_REASON,
  describeUnplacedReason,
} from '@squadlogic/core/practiceUnplacedReasons.js';

/** Reasons a division's own settings cause: shown for a team at one practice a week too. */
const SETTINGS_REASONS = new Set([
  PRACTICE_UNPLACED_REASON.PRACTICE_LENGTH,
  PRACTICE_UNPLACED_REASON.NOT_ENOUGH_DAYS,
]);

/**
 * The teams whose division wants several practices a week, each with how many it has and why the
 * rest are missing (Phase D PR B). The subject set is the function's `practices.teams`, built from
 * the roster and each division's count, never from the placements, so a team given one of its two
 * practices is listed with the missing one's reason instead of vanishing from the report.
 *
 * @param {{ practices?: { teams?: Array<Object> }|null, unassigned?: Array<Object> }|null|undefined} result
 * @param {Record<string, string>} teamNames
 * @returns {Array<{ teamId: string, name: string, have: number, target: number, reasons: string[] }>}
 */
export function practiceLines(result, teamNames) {
  const reasonsByTeam = new Map();
  const settingsOnly = new Map();
  for (const entry of result?.unassigned ?? []) {
    const reason = describeUnplacedReason(entry?.reason);
    // `target` is set on the entries of a team whose division wants several practices a week.
    if (entry?.target > 1) {
      const list = reasonsByTeam.get(entry.teamId) ?? [];
      list.push(reason);
      reasonsByTeam.set(entry.teamId, list);
    } else if (SETTINGS_REASONS.has(entry?.reason)) {
      // A team at one practice a week is not in `practices.teams`, but a length no slot matches
      // is the division's setting at work: say so instead of a bare "Unassigned".
      settingsOnly.set(entry.teamId, [reason]);
    }
  }
  const lines = (result?.practices?.teams ?? []).map((team) => ({
    teamId: team.teamId,
    name: teamNames?.[team.teamId] ?? team.teamId,
    have: team.held + team.placed,
    target: team.target,
    reasons: [...new Set(reasonsByTeam.get(team.teamId) ?? [])],
  }));
  const listed = new Set(lines.map((line) => line.teamId));
  for (const [teamId, reasons] of [...settingsOnly].sort(([a], [b]) => a.localeCompare(b))) {
    if (listed.has(teamId)) continue;
    lines.push({ teamId, name: teamNames?.[teamId] ?? teamId, have: 0, target: 1, reasons });
  }
  return lines;
}
