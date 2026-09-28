import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  LEVEL_LABEL,
  formatPreferenceValue,
  previewMustKeep,
} from '../../utils/coachPreferencePreview.js';

/**
 * The approval-time re-judge (plan §4): which of the coach's teams' CURRENT
 * practice series the decision's `must_keep` would make unsatisfiable. The
 * verdict is `previewMustKeep`, which composes the core rule; this only
 * renders it, and always says "None" explicitly rather than showing nothing.
 */
export default function MustKeepPreview({ proposal, context, date }) {
  const { approvedRows, rosterRows, practiceRows, teamNames, locationNames, loadError } = context;

  const outcome = useMemo(() => {
    if (loadError) return { error: loadError.message || 'the team and practice data did not load' };
    try {
      return {
        preview: previewMustKeep({ proposal, approvedRows, rosterRows, practiceRows, date }),
      };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }, [proposal, approvedRows, rosterRows, practiceRows, date, loadError]);

  const teamName = (teamId) => teamNames.get(teamId) ?? `Team ${teamId}`;
  const describe = (placement) =>
    `${formatPreferenceValue('weekday', placement.weekday)} ${formatPreferenceValue(
      'start_time',
      placement.startMinutes
    )} at ${formatPreferenceValue('venue', placement.locationId, locationNames)}`;

  let body;
  if (outcome.error) {
    body = (
      <p role="alert" className="text-sm m-0">
        Could not re-judge this decision: {outcome.error}. Review the coach&apos;s current series
        before approving.
      </p>
    );
  } else if (!outcome.preview.applies) {
    body = (
      <p className="text-sm m-0">
        Only a must-keep preference can make a current series unsatisfiable. This decision is{' '}
        {LEVEL_LABEL[proposal.level] || proposal.level}, so none is.
      </p>
    );
  } else {
    const { preview } = outcome;
    body = (
      <>
        {preview.teamIds.length === 0 && (
          <p className="text-sm m-0">
            This coach has no current team assignment, so no team&apos;s series is affected.
          </p>
        )}
        {preview.noReference && (
          <p className="text-sm m-0">
            No specific value: the preference keeps each team&apos;s current series.
          </p>
        )}
        <p className="text-sm font-semibold m-0" id="must-keep-preview-list-label">
          Current series this would make unsatisfiable:
        </p>
        {preview.unsatisfiable.length === 0 ? (
          <p className="text-sm m-0" data-testid="preview-none">
            None
          </p>
        ) : (
          <ul aria-labelledby="must-keep-preview-list-label" className="m-0 pl-5 text-sm">
            {preview.unsatisfiable.map((entry) => (
              <li
                key={entry.assignmentId}
                data-testid="unsatisfiable-series"
                data-assignment-id={entry.assignmentId}
              >
                {teamName(entry.teamId)}: {describe(entry.placement)}
                {entry.alreadyUnsatisfiable && ' (already unsatisfiable before this decision)'}
              </li>
            ))}
          </ul>
        )}
        {preview.unjudged.length > 0 && (
          <div className="text-sm">
            <p className="m-0 font-semibold">Not judged (no readable placement):</p>
            <ul className="m-0 pl-5">
              {preview.unjudged.map((entry) => (
                <li key={entry.assignmentId} data-testid="unjudged-series">
                  {teamName(entry.teamId)}: {entry.problem}
                </li>
              ))}
            </ul>
          </div>
        )}
        {preview.teamsWithoutSeries.length > 0 && (
          <p className="text-sm m-0">
            Teams with no current practice series:{' '}
            {preview.teamsWithoutSeries.map(teamName).join(', ')}.
          </p>
        )}
        {preview.conflicts.map((conflict) => (
          <p key={conflict.teamId} className="text-sm m-0">
            {teamName(conflict.teamId)}: {conflict.message}.
          </p>
        ))}
      </>
    );
  }

  return (
    <section
      aria-labelledby="must-keep-preview-heading"
      aria-live="polite"
      className="card"
      data-testid="must-keep-preview"
    >
      <div className="card-head">
        <h3 id="must-keep-preview-heading">Re-judged at approval</h3>
      </div>
      <div className="card-body flex flex-col gap-2">{body}</div>
    </section>
  );
}

MustKeepPreview.propTypes = {
  proposal: PropTypes.shape({
    coachId: PropTypes.string.isRequired,
    dimension: PropTypes.string.isRequired,
    level: PropTypes.string.isRequired,
    value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  }).isRequired,
  context: PropTypes.shape({
    approvedRows: PropTypes.array.isRequired,
    rosterRows: PropTypes.array.isRequired,
    practiceRows: PropTypes.array.isRequired,
    teamNames: PropTypes.instanceOf(Map).isRequired,
    locationNames: PropTypes.instanceOf(Map).isRequired,
    loadError: PropTypes.object,
  }).isRequired,
  date: PropTypes.string.isRequired,
};
