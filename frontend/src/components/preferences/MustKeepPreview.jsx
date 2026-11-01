import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  LEVEL_LABEL,
  formatPreferenceValue,
  previewMustKeep,
} from '../../utils/coachPreferencePreview.js';

/**
 * The acceptance-time re-judge (plan §4): which of the team's CURRENT practice series the
 * rule, as a must, would make unsatisfiable. The verdict is `previewMustKeep`, which composes the
 * core rule; this only renders it, and always says "None" explicitly rather than showing nothing.
 */
export default function MustKeepPreview({ proposal, context, date }) {
  const { ruleRows, rosterRows, practiceRows, teamNames, locationNames, loadError } = context;

  const outcome = useMemo(() => {
    if (loadError) return { error: loadError.message || 'the team and practice data did not load' };
    try {
      return {
        preview: previewMustKeep({ proposal, ruleRows, rosterRows, practiceRows, date }),
      };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }, [proposal, ruleRows, rosterRows, practiceRows, date, loadError]);

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
        Only a must can make a current series unsatisfiable. This rule is{' '}
        {LEVEL_LABEL[proposal.level] || proposal.level}, so none is.
      </p>
    );
  } else {
    const { preview } = outcome;
    body = (
      <>
        {preview.noReference && (
          <p className="text-sm m-0">
            Keep-current with no practice to keep it from: this condition does nothing yet.
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
        <h3 id="must-keep-preview-heading">Re-judged as a must</h3>
      </div>
      <div className="card-body flex flex-col gap-2">{body}</div>
    </section>
  );
}

MustKeepPreview.propTypes = {
  proposal: PropTypes.shape({
    id: PropTypes.string.isRequired,
    coachId: PropTypes.string.isRequired,
    teamId: PropTypes.string.isRequired,
    level: PropTypes.string.isRequired,
  }).isRequired,
  context: PropTypes.shape({
    ruleRows: PropTypes.array.isRequired,
    rosterRows: PropTypes.array.isRequired,
    practiceRows: PropTypes.array.isRequired,
    teamNames: PropTypes.instanceOf(Map).isRequired,
    locationNames: PropTypes.instanceOf(Map).isRequired,
    loadError: PropTypes.object,
  }).isRequired,
  date: PropTypes.string.isRequired,
};
