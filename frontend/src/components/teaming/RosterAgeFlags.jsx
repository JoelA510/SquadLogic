import React from 'react';
import PropTypes from 'prop-types';
import { flagSummary } from '../../utils/seatNotes.js';

/**
 * Who is playing up or down on the rosters the editor shows: a list of its own, not part of the red
 * conflict banner, because a play-up or play-down is a flag for the admin and not an error (play-down
 * plan, 2026-11-03, PR 2, decision 6). Words, never a colour or an icon alone; the app approves or
 * refuses nothing. `flags` is `rosterAgeFlags`' answer, or null while the season's divisions are not
 * loaded: no band is known then, and the list says it has not checked rather than that nobody plays up.
 *
 * @param {{ flags: ReturnType<import('../../utils/rosterAgeFlags.js').rosterAgeFlags> | null }} props
 */
export default function RosterAgeFlags({ flags }) {
  const none =
    flags !== null &&
    flags.counts.playingUp + flags.counts.playingDown + flags.counts.notChecked === 0;
  return (
    <section
      aria-labelledby="roster-age-flags-heading"
      data-testid="roster-age-flags"
      className="bg-bg-surface border border-border-subtle rounded-xl p-4 mb-6"
    >
      <h3 id="roster-age-flags-heading" className="font-bold text-text-primary">
        Play-up and play-down on these rosters
      </h3>
      {flags === null ? (
        <p className="mt-1 text-sm text-text-secondary">
          Not checked yet: the season&apos;s divisions are not loaded.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-text-secondary">
            {none
              ? 'None: nobody on these rosters plays up or down.'
              : `${flagSummary({ ...flags.counts, askedToPlayUp: 0, movedIn: 0, checked: true })}. These are flags: nothing here is approved or refused.`}
          </p>
          {flags.entries.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-sm text-text-secondary">
              {flags.entries.map((entry) => (
                <li key={entry.playerId} data-roster-flag={entry.playerId}>
                  <span className="font-medium text-text-primary">{entry.label}:</span>{' '}
                  {entry.detail}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

RosterAgeFlags.propTypes = {
  flags: PropTypes.shape({
    counts: PropTypes.shape({
      playingUp: PropTypes.number.isRequired,
      playingDown: PropTypes.number.isRequired,
      notChecked: PropTypes.number.isRequired,
    }).isRequired,
    entries: PropTypes.arrayOf(
      PropTypes.shape({
        playerId: PropTypes.string.isRequired,
        label: PropTypes.string.isRequired,
        detail: PropTypes.string.isRequired,
      })
    ).isRequired,
  }),
};
