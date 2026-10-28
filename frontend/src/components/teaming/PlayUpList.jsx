import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { summarizePlayUpReview } from '../../utils/playUpReview.js';

const anchorId = (division, part) => `play-up-${division}-${part}`.replace(/[^A-Za-z0-9_-]/g, '-');

/** What the run did with the player, in words. */
function placementText(entry) {
  const registered = entry.registeredDivisionName || entry.registeredDivision || 'their division';
  const played = entry.playedDivisionName || entry.playedDivision || registered;
  switch (entry.kind) {
    case 'play-up':
      return entry.requested
        ? `Plays in ${played}, the older division they registered for.`
        : `Registered in ${registered} but plays in ${played} (no play-up request).`;
    case 'play-down':
      return `Registered in ${registered} but plays in ${played}.`;
    case 'requested-own-division':
      return `Requested a play-up but is registered in ${registered}, their own division. Move them by hand if the club agrees.`;
    case 'requested-age-unknown':
      return `Requested a play-up, but their natural age is unknown, so nothing is checked. Plays in ${registered}.`;
    case 'no-division':
      return `Not placed: no suitable division in this import (the same gender or co-ed) holds a player of natural age ${entry.naturalAge}.`;
    default:
      return `Plays in ${played}.`;
  }
}

function requestText(entry) {
  if (entry.requested) return 'Requested';
  return entry.kind === 'play-up' ? 'Not requested' : 'Not applicable';
}

function coachText(entry) {
  if (!entry.coachId) return 'No';
  const who = entry.coachName ? `Coach ${entry.coachName}` : 'A coach';
  const where = entry.playedDivisionName || entry.playedDivision;
  return where ? `Yes: ${who}, team in ${where}` : `Yes: ${who}`;
}

function buddyText(entry) {
  if (!entry.buddyId) return 'None';
  const name = entry.buddyName || 'A buddy';
  if (entry.buddyInPlayedDivision) {
    return `${name}, in ${entry.playedDivisionName || entry.playedDivision}`;
  }
  const elsewhere = entry.buddyDivisionName || entry.buddyDivision;
  return elsewhere ? `${name}, plays in ${elsewhere}` : `${name}, not in this division`;
}

const coachPossessive = (name) => (name ? `Coach ${name}'s child` : "a coach's child");

/**
 * The Play-up section of a team run: every play-up (requested or not), every play-down, anyone
 * no division can hold, and each waitlisted player a coach's child's buddy took off the
 * waitlist. The facts are the admin's to weigh against the club's own rules; the app approves or
 * refuses nothing. Read from the run's `results`, so a staged or synced run shows it after a
 * reload. Announced by the page's polite live region, once per generation, not here.
 */
export default function PlayUpList({ results }) {
  const summary = useMemo(() => summarizePlayUpReview(results), [results]);
  if (!summary) return null;
  const { totals } = summary;
  return (
    <section
      className="bg-bg-surface border border-border-subtle rounded-xl p-6"
      aria-labelledby="play-up-heading"
    >
      <h3 id="play-up-heading" className="text-xl font-bold text-text-primary mb-2">
        Play-up
      </h3>
      <p className="text-sm text-text-secondary mb-4">
        {`${totals.playUps} play-up${totals.playUps === 1 ? '' : 's'} (${totals.requested} requested, ${totals.unrequested} not), ${totals.playDowns} play-down${totals.playDowns === 1 ? '' : 's'}${
          totals.takenOffWaitlist > 0 ? `, ${totals.takenOffWaitlist} taken off the waitlist` : ''
        }. Nothing here is approved or refused: players play in their own age division unless a play-up was requested. Check each against your club's rules.`}
      </p>
      <div className="space-y-6">
        {summary.divisions.map(({ division, divisionName, entries, takenOffWaitlist }) => (
          <div key={division} className="space-y-3">
            {entries.length > 0 && (
              <div
                className="overflow-x-auto"
                role="region"
                aria-labelledby={anchorId(division, 'table')}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard
                tabIndex={0}
              >
                <table className="w-full text-sm text-left">
                  <caption
                    id={anchorId(division, 'table')}
                    className="text-left font-semibold text-text-primary mb-1"
                  >
                    {`${divisionName}: play-ups and play-downs`}
                  </caption>
                  <thead>
                    <tr className="text-text-primary">
                      {[
                        'Player',
                        'Natural age',
                        'Play-up request',
                        'A parent coaches',
                        'A buddy is in the division',
                        'What the run did',
                      ].map((heading) => (
                        <th key={heading} scope="col" className="font-semibold py-1 pr-4 align-top">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-text-secondary">
                    {entries.map((entry) => (
                      <tr key={entry.playerId} className="border-t border-border-subtle">
                        <th
                          scope="row"
                          className="font-medium text-text-primary py-1 pr-4 align-top"
                        >
                          {entry.name}
                        </th>
                        <td className="py-1 pr-4 align-top">{entry.naturalAge ?? 'Unknown'}</td>
                        <td className="py-1 pr-4 align-top">{requestText(entry)}</td>
                        <td className="py-1 pr-4 align-top">{coachText(entry)}</td>
                        <td className="py-1 pr-4 align-top">{buddyText(entry)}</td>
                        <td className="py-1 pr-4 align-top">{placementText(entry)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {takenOffWaitlist.length > 0 && (
              <section aria-labelledby={anchorId(division, 'waitlist')}>
                <h4 id={anchorId(division, 'waitlist')} className="font-semibold text-text-primary">
                  {`${divisionName}: taken off the waitlist`}
                </h4>
                <ul className="text-sm text-text-secondary list-disc pl-5">
                  {takenOffWaitlist.map((entry) => (
                    <li key={entry.playerId}>
                      <span className="font-medium text-text-primary">{entry.name}</span>. Taken off
                      the waitlist: buddy of {entry.childName}, {coachPossessive(entry.coachName)}.
                      Placed on the coach&apos;s team with them; becomes active when the teams are
                      saved.
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

PlayUpList.propTypes = {
  results: PropTypes.shape({
    playUpByDivision: PropTypes.object,
    waitlistExceptionsByDivision: PropTypes.object,
    coachNamesById: PropTypes.objectOf(PropTypes.string),
  }),
};
