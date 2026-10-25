import { summarizeTeamSizeOutcome } from '@squadlogic/core/teamSizeOutcome.js';
import { isRosterPlayerRow } from './teamReviewPersistence.js';

/**
 * The Teams page's team-size outcome (Phase B4, docs/changes/2026-10-22-phase-b-teaming.md):
 * the core outcome (`summarizeTeamSizeOutcome`) of a staged or synced run's `results`, with each
 * team's size read from the run's current rows when it has them, so a manual roster edit shows.
 * Coach rows are not players (`isRosterPlayerRow`, the persistence module's role rule).
 */

/**
 * @param {any} results - a team run's `results` (`buildTeamReviewSnapshot`'s shape)
 */
export function summarizeTeamSizeReview(results) {
  if (!results || typeof results !== 'object') return null;
  const rows = Array.isArray(results.team_players) ? results.team_players : [];
  /** @type {Map<string, number> | null} */
  let rosterSizeByTeamId = null;
  if (rows.length > 0) {
    rosterSizeByTeamId = new Map();
    // One team per player, the first row's, as the placement review reads the rows
    // (`placementReview.js`), so a duplicate row never counts a player twice.
    const seen = new Set();
    for (const row of rows) {
      if (!isRosterPlayerRow(row)) continue;
      const playerId = String(row?.player_id);
      if (seen.has(playerId)) continue;
      seen.add(playerId);
      const teamId = String(row?.team_id);
      rosterSizeByTeamId.set(teamId, (rosterSizeByTeamId.get(teamId) ?? 0) + 1);
    }
  }
  return summarizeTeamSizeOutcome(results, { rosterSizeByTeamId });
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * One sentence for the page's polite live region, or '' when no team is outside its limits and
 * nobody was left without room. A division that was not checked is said to be so.
 * @param {ReturnType<typeof summarizeTeamSizeOutcome>} summary
 */
export function teamSizeAnnouncement(summary) {
  if (!summary) return '';
  let underMin = 0;
  let overMax = 0;
  let noRoom = 0;
  let unchecked = 0;
  for (const division of summary.divisions) {
    underMin += division.underMin?.length ?? 0;
    overMax += division.overMax?.length ?? 0;
    noRoom += division.notPlacedForCapacity.length;
    if (division.teamCount > 0 && (division.underMin === null || division.overMax === null)) {
      unchecked += 1;
    }
  }
  const parts = [];
  if (underMin > 0) parts.push(`${count(underMin, 'team', 'teams')} under the minimum roster`);
  if (overMax > 0) parts.push(`${count(overMax, 'team', 'teams')} over the maximum roster`);
  if (noRoom > 0) parts.push(`${count(noRoom, 'player', 'players')} not placed for lack of room`);
  if (unchecked > 0) {
    parts.push(`${count(unchecked, 'division', 'divisions')} not checked against the limits`);
  }
  return parts.length > 0 ? `Team sizes: ${parts.join('; ')}.` : '';
}
