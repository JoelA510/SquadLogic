import React from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import { DECISION_LABEL, isPreferencesBackendMissing } from '../../utils/coachPreferencePreview.js';

const DECISION_TONE = {
  pending: 'warning',
  accepted: 'success',
  kept_prefer: 'neutral',
};

/** Where a rule stands: a requested must pending, accepted, or kept as prefer. */
export function DecisionBadge({ decision }) {
  return (
    <Badge tone={DECISION_TONE[decision] || 'neutral'}>
      {DECISION_LABEL[decision] || decision}
    </Badge>
  );
}

DecisionBadge.propTypes = { decision: PropTypes.string.isRequired };

/**
 * The load-failure banner. A missing migration is named as such, so an empty
 * table is never mistaken for "no preferences".
 */
export function PreferencesLoadError({ error }) {
  if (!error) return null;
  const detail = error.message ? ` (${error.message})` : '';
  const message = isPreferencesBackendMissing(error)
    ? `Practice preference rules are not available on this database yet: the coach_practice_preferences migration has not been applied. Nothing can be added or decided until it is${detail}.`
    : `Could not load practice preference rules${detail}.`;
  return <DataErrorBanner message={message} />;
}

PreferencesLoadError.propTypes = {
  error: PropTypes.shape({ message: PropTypes.string, code: PropTypes.string }),
};
