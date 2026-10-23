import React from 'react';
import PropTypes from 'prop-types';

/** Why a request linked nobody, in words (codes from `resolveBuddyRequests` and the pipeline). */
const UNRESOLVED_REASONS = {
  ambiguous: 'More than one player in this program has that name.',
  'cross-division': 'The name matches a player in another division.',
  'not-found': 'No player in this program has that name or registration ID.',
  unparsed: "The request could not be read as one player's first and last name.",
  self: 'The request names the player themself.',
  'buddy-coach-conflict': "The two buddies each anchor a different head coach's team.",
  'buddy-code-unmatched': 'The buddy code was entered by only one player, or could not be paired.',
  'duplicate-buddy-code': 'The buddy code is shared by more than two players.',
  'cross-division-buddy': 'The buddy is in another division.',
};

const RULE_LABELS = {
  mutual: 'Mutual requests only',
  one_way_best_effort: 'One-way requests, best effort',
};

function placedText(entry) {
  if (!entry.together) return 'Not placed together.';
  return entry.teamName ? `Placed together on ${entry.teamName}.` : 'Placed together.';
}

function oneWayText(entry) {
  if (entry.honoured) return `Honoured best effort. ${placedText(entry)}`;
  if (entry.reason === 'named-player-listed-another-buddy') {
    return `Not honoured: ${entry.targetName} listed a buddy of their own.`;
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
 * (`summarizeBuddyRequests`), so a staged or synced run shows it after a reload. Nothing here is
 * linked by the page; a wrong request is fixed on the player's record.
 */
export default function BuddyRequestsList({ buddyRequestsByDivision }) {
  const divisions = Object.entries(buddyRequestsByDivision || {});
  if (divisions.length === 0) return null;

  return (
    <section
      className="bg-bg-surface border border-border-subtle rounded-xl p-6"
      aria-labelledby="buddy-requests-heading"
    >
      <h3 id="buddy-requests-heading" className="text-xl font-bold text-text-primary mb-2">
        Buddy requests
      </h3>
      {divisions.map(([division, summary]) => {
        const paired = summary?.paired || [];
        const oneWay = summary?.oneWay || [];
        const unresolved = summary?.unresolved || [];
        const headingId = `buddy-requests-${division}`.replace(/[^A-Za-z0-9_-]/g, '-');
        return (
          <div key={division} className="space-y-4">
            <p className="text-sm text-text-secondary" id={headingId}>
              {division}: {paired.length} paired, {oneWay.length} one-way, {unresolved.length}{' '}
              unresolved. Rule: {RULE_LABELS[summary?.rule] || RULE_LABELS.mutual}.
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
                      {entry.playerName} asked for {entry.targetName}. {oneWayText(entry)}
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
  buddyRequestsByDivision: PropTypes.objectOf(
    PropTypes.shape({
      rule: PropTypes.string,
      paired: PropTypes.arrayOf(PropTypes.object),
      oneWay: PropTypes.arrayOf(PropTypes.object),
      unresolved: PropTypes.arrayOf(PropTypes.object),
    })
  ),
};
