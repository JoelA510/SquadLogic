import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { TEAM_GENERATION } from '@squadlogic/core/constants.js';
import { BUDDY_RULE_CHOICES } from '../../constants/featureFlags.js';
import { notPlacedById } from '../../utils/placementReview.js';

/** Why a request linked nobody, in words (codes from `resolveBuddyRequests` and the pipeline). */
const UNRESOLVED_REASONS = {
  ambiguous: 'More than one player in this division has that name.',
  'cross-division': 'The name matches a player in another division.',
  'not-found': 'No player in this division has that name or registration ID.',
  unparsed: "The request could not be read as one player's first and last name.",
  self: 'The request names the player themself.',
  'buddy-coach-conflict': "The two buddies each anchor a different head coach's team.",
  'buddy-played-apart':
    'The two buddies play in different divisions: a play-up or play-down put one in their own age division.',
  'buddy-code-unmatched': 'The buddy code was entered by only one player, or could not be paired.',
  'duplicate-buddy-code': 'The buddy code is shared by more than two players.',
  'cross-division-buddy': 'The buddy is in another division.',
};

const ruleLabel = (rule) =>
  BUDDY_RULE_CHOICES.find((choice) => choice.value === rule)?.label ?? `Unknown rule (${rule})`;

/**
 * Where each player is now, from the run's `team_players` and `teams` (a manual roster edit
 * rewrites both), so "placed together" follows the roster rather than the moment of generation.
 * Null when the run carries no rows, and the summary's own placement stands.
 */
function currentPlacement(results) {
  const rows = results?.team_players;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const teamOf = new Map(rows.map((row) => [String(row.player_id), String(row.team_id)]));
  const teamNames = new Map(
    (results?.teams || []).map((team) => [String(team.id), team.name || String(team.id)])
  );
  return (a, b) => {
    const teamId = teamOf.get(String(a));
    const together = teamId !== undefined && teamId === teamOf.get(String(b));
    return { together, teamName: together ? teamNames.get(teamId) || null : null };
  };
}

/**
 * Why a pair is apart when one of them is on no team (Phase B3): a buddy whose eligibility is
 * blocked is not placed, and the other is placed alone (`buddy-not-placed`). Null when the run
 * records neither as not placed (`notPlacedById`, which leaves out anyone its rows seat).
 */
function apartBecause(ids, notPlaced) {
  const missing = ids.map(String).filter((id) => notPlaced.has(id));
  if (missing.length === 0) return null;
  return missing
    .map((id) => {
      const { name, reason } = /** @type {{ name: string, reason: string }} */ (notPlaced.get(id));
      return reason === TEAM_GENERATION.REASON_EligibilityBlocked
        ? `${name} is not eligible for this division and is not placed`
        : `${name} is not placed`;
    })
    .join('; ');
}

function placedText(entry) {
  const placed = !entry.together
    ? entry.apartBecause
      ? `Not placed together: ${entry.apartBecause}.`
      : 'Not placed together.'
    : entry.teamName
      ? `Placed together on ${entry.teamName}.`
      : 'Placed together.';
  return entry.matchedByReciprocity
    ? `${placed} Matched because they name each other: another player has the same name.`
    : placed;
}

function oneWayText(entry) {
  if (entry.honoured) return `Honoured best effort. ${placedText(entry)}`;
  if (entry.reason === 'named-player-listed-another-buddy') {
    return `Not honoured: ${entry.targetName} listed a buddy of their own.`;
  }
  if (entry.reason === 'requester-has-another-buddy') {
    return `Not honoured: ${entry.playerName} is already paired by a buddy code.`;
  }
  return 'Not honoured: the league pairs mutual requests only.';
}

function candidatesText(candidates) {
  if (!candidates || candidates.length === 0) return null;
  const names = candidates.map((candidate) =>
    candidate.division ? `${candidate.name} (${candidate.division})` : candidate.name
  );
  return `Possible matches: ${names.join(', ')}.`;
}

/**
 * The "Buddy requests" list of a team run (Phase B1): paired players, one-way requests and
 * whether they landed together, and each request that linked nobody, with its reason and the
 * candidates an admin can correct it against. Reads the run's `results.buddyRequestsByDivision`
 * (`summarizeBuddyRequests`), so a staged or synced run shows it after a reload, with each
 * pair's placement read from the run's current rows. Nothing here is
 * linked by the page; a wrong request is fixed on the player's record.
 */
export default function BuddyRequestsList({ results }) {
  const notPlaced = useMemo(() => notPlacedById(results), [results]);
  const divisions = Object.entries(results?.buddyRequestsByDivision || {});
  if (divisions.length === 0) return null;
  const placementOf = currentPlacement(results);
  const placed = (entry, a, b) => {
    const now = placementOf ? { ...entry, ...placementOf(a, b) } : entry;
    return now.together ? now : { ...now, apartBecause: apartBecause([a, b], notPlaced) };
  };

  return (
    <section
      className="bg-bg-surface border border-border-subtle rounded-xl p-6"
      aria-labelledby="buddy-requests-heading"
    >
      <h3 id="buddy-requests-heading" className="text-xl font-bold text-text-primary mb-2">
        Buddy requests
      </h3>
      {divisions.map(([division, summary]) => {
        const paired = (summary?.paired || []).map((entry) =>
          placed(entry, entry.playerIds[0], entry.playerIds[1])
        );
        const oneWay = (summary?.oneWay || []).map((entry) =>
          placed(entry, entry.playerId, entry.targetId)
        );
        const unresolved = summary?.unresolved || [];
        const headingId = `buddy-requests-${division}`.replace(/[^A-Za-z0-9_-]/g, '-');
        return (
          <div key={division} className="space-y-4">
            <p className="text-sm text-text-secondary" id={headingId}>
              {division}: {paired.length} paired, {oneWay.length} one-way, {unresolved.length}{' '}
              unresolved. Rule: {ruleLabel(summary?.rule)}.
            </p>
            {paired.length > 0 && (
              <section aria-labelledby={`${headingId}-paired`}>
                <h4 id={`${headingId}-paired`} className="font-semibold text-text-primary">
                  Paired
                </h4>
                <ul className="text-sm text-text-secondary list-disc pl-5">
                  {paired.map((entry) => (
                    <li key={entry.playerIds.join('+')}>
                      {entry.names[0]} and {entry.names[1]}. {placedText(entry)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {oneWay.length > 0 && (
              <section aria-labelledby={`${headingId}-one-way`}>
                <h4 id={`${headingId}-one-way`} className="font-semibold text-text-primary">
                  One-way
                </h4>
                <ul className="text-sm text-text-secondary list-disc pl-5">
                  {oneWay.map((entry) => (
                    <li key={entry.playerId}>
                      {entry.playerName} asked for {entry.targetName}
                      {entry.request && entry.request !== entry.targetName
                        ? ` (“${entry.request}”)`
                        : ''}
                      . {oneWayText(entry)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {unresolved.length > 0 && (
              <section aria-labelledby={`${headingId}-unresolved`}>
                <h4 id={`${headingId}-unresolved`} className="font-semibold text-text-primary">
                  Unresolved
                </h4>
                <ul className="text-sm text-text-secondary list-disc pl-5">
                  {unresolved.map((entry) => (
                    <li key={`${entry.playerId}:${entry.reason}`}>
                      {entry.playerName}
                      {entry.request ? ` asked for “${entry.request}”` : ''}.{' '}
                      {UNRESOLVED_REASONS[entry.reason] || entry.reason}{' '}
                      {candidatesText(entry.candidates)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        );
      })}
    </section>
  );
}

BuddyRequestsList.propTypes = {
  results: PropTypes.shape({
    buddyRequestsByDivision: PropTypes.objectOf(
      PropTypes.shape({
        rule: PropTypes.string,
        paired: PropTypes.arrayOf(PropTypes.object),
        oneWay: PropTypes.arrayOf(PropTypes.object),
        unresolved: PropTypes.arrayOf(PropTypes.object),
      })
    ),
    overflowByDivision: PropTypes.object,
    team_players: PropTypes.arrayOf(PropTypes.object),
    teams: PropTypes.arrayOf(PropTypes.object),
  }),
};
