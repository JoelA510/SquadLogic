import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { TEAM_GENERATION } from '@squadlogic/core/constants.js';
import { summarizeTeamSizeReview } from '../../utils/teamSizeReview.js';

/** Why there was no room, in words (the capacity reasons of `overflowByDivision[].reason`). */
const NO_ROOM_REASONS = {
  [TEAM_GENERATION.REASON_InsufficientCapacity]: 'the teams were full',
  [TEAM_GENERATION.REASON_CoachCapacity]: "no room on their coach's team",
  [TEAM_GENERATION.REASON_BuddyTargetCapacity]: "no room on their buddy's team",
};

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const teamList = (teams) =>
  teams
    .map((team) => `${team.teamName} (${count(team.playerCount, 'player', 'players')})`)
    .join(', ');

function limitsText({ minRosterSize, maxRosterSize }) {
  if (minRosterSize !== null && maxRosterSize !== null) {
    return `Rosters of ${minRosterSize} to ${maxRosterSize} players.`;
  }
  if (maxRosterSize !== null) return `Rosters of at most ${maxRosterSize} players.`;
  return '';
}

/** The warnings of one division, each a sentence. */
function divisionWarnings(outcome) {
  const warnings = [];
  if (outcome.underMin?.length > 0) {
    warnings.push(
      `${count(outcome.underMin.length, 'team', 'teams')} under the minimum of ${outcome.minRosterSize}: ${teamList(outcome.underMin)}.`
    );
  }
  if (outcome.overMax?.length > 0) {
    warnings.push(
      `${count(outcome.overMax.length, 'team', 'teams')} over the maximum of ${outcome.maxRosterSize}: ${teamList(outcome.overMax)}.`
    );
  }
  if (outcome.notPlacedForCapacity.length > 0) {
    const byReason = new Map();
    for (const entry of outcome.notPlacedForCapacity) {
      byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
    }
    const why = [...byReason]
      .map(([reason, n]) => `${n}: ${NO_ROOM_REASONS[reason] ?? reason}`)
      .join('; ');
    warnings.push(
      `${count(outcome.notPlacedForCapacity.length, 'player', 'players')} not placed for lack of room (${why}). Each is listed under "Not placed" in Players to review.`
    );
  }
  if (outcome.teamCount > 0 && !outcome.rostersKnown && outcome.underMin === null) {
    warnings.push(
      outcome.overMax === null
        ? 'This run does not hold its rosters, so team sizes were not checked against the limits.'
        : 'This run does not hold its rosters, so short teams were not checked.'
    );
  } else if (outcome.teamCount > 0 && outcome.underMin === null && outcome.overMax === null) {
    warnings.push(
      'This run did not record its roster limits, so team sizes were not checked against them.'
    );
  } else if (outcome.teamCount > 0 && outcome.underMin === null) {
    warnings.push('This run did not record its minimum roster, so short teams were not checked.');
  } else if (outcome.teamCount > 0 && outcome.overMax === null) {
    warnings.push('This run did not record its maximum roster, so full teams were not checked.');
  }
  return warnings;
}

/**
 * The outcome of a team run against its roster limits (Phase B4): per division, the counts (teams,
 * players placed, the limits) and, beside them, a warning for each team under the minimum or
 * over the maximum and for the players not placed for lack of room. Read from the run's
 * `results`, so a staged or synced run shows it after a reload, and from its current rows, so a
 * manual roster edit shows. Who was not placed is listed one by one in "Players to review" (B3);
 * this says how many and why, not again who. A run that did not record its limits says it was
 * not checked rather than that every team fits.
 */
export default function TeamSizeOutcomeList({ results }) {
  const summary = useMemo(() => summarizeTeamSizeReview(results), [results]);
  if (!summary) return null;

  return (
    <section
      className="bg-bg-surface border border-border-subtle rounded-xl p-6"
      aria-labelledby="team-size-outcome-heading"
    >
      <h3 id="team-size-outcome-heading" className="text-xl font-bold text-text-primary mb-2">
        Team sizes
      </h3>
      <div className="space-y-4">
        {summary.divisions.map((outcome) => {
          const warnings = divisionWarnings(outcome);
          const limits = limitsText(outcome);
          return (
            <div key={outcome.division} className="space-y-2">
              <p className="text-sm text-text-secondary">
                {outcome.division}: {count(outcome.teamCount, 'team', 'teams')}
                {outcome.playersPlaced === null
                  ? '.'
                  : `, ${count(outcome.playersPlaced, 'player', 'players')} placed.`}
                {limits ? ` ${limits}` : ''}
              </p>
              {warnings.length > 0 ? (
                <ul
                  className="space-y-1 rounded-lg border border-status-warning/30 bg-status-warning-bg p-3 text-sm text-status-warning-text list-disc pl-8"
                  aria-label={`${outcome.division} team-size warnings`}
                >
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : (
                outcome.teamCount > 0 && (
                  <p className="text-sm text-text-secondary">
                    Every team is within the roster limits, and nobody was left without room.
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

TeamSizeOutcomeList.propTypes = {
  results: PropTypes.shape({
    teamsByDivision: PropTypes.object,
    overflowByDivision: PropTypes.object,
    rosterBalanceByDivision: PropTypes.object,
    changeDiagnosticsByDivision: PropTypes.object,
    team_players: PropTypes.arrayOf(PropTypes.object),
  }),
};
