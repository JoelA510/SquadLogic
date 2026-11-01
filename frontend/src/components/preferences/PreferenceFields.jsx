import React from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';
import DataErrorBanner from '../ui/DataErrorBanner.jsx';
import {
  DECISION_LABEL,
  LEVEL_LABEL,
  WEEKDAY_OPTIONS,
  clockToMinutes,
  isPreferencesBackendMissing,
  minutesToClock,
} from '../../utils/coachPreferencePreview.js';

const LEVELS = ['prefer', 'must'];
const DECISION_TONE = {
  pending: 'warning',
  accepted: 'success',
  kept_prefer: 'neutral',
};

/** Level picker: prefer or must, no free text. */
export function LevelSelect({ id, value, onChange, disabled = false }) {
  return (
    <div className="field">
      <label htmlFor={id}>Level</label>
      <select
        id={id}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {LEVELS.map((level) => (
          <option key={level} value={level}>
            {LEVEL_LABEL[level]}
          </option>
        ))}
      </select>
    </div>
  );
}

LevelSelect.propTypes = {
  id: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};

/**
 * The value control for one dimension: a weekday code, a start time (shown as
 * a clock, stored as minutes past midnight) or one of the org's locations. The
 * empty choice is `null`: "keep the current series".
 */
export function PreferenceValueField({
  id,
  dimension,
  value,
  onChange,
  locations,
  disabled = false,
}) {
  const noneLabel = 'Keep the current series (no specific value)';
  let control;
  if (dimension === 'weekday') {
    control = (
      <select
        id={id}
        className="select"
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{noneLabel}</option>
        {WEEKDAY_OPTIONS.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (dimension === 'start_time') {
    control = (
      <input
        id={id}
        type="time"
        className="input"
        value={typeof value === 'number' ? minutesToClock(value) : ''}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(clockToMinutes(event.target.value))}
      />
    );
  } else {
    control = (
      <select
        id={id}
        className="select"
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{noneLabel}</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>{dimension === 'venue' ? 'Venue (location)' : 'Value'}</label>
      {control}
      {dimension === 'start_time' && (
        <p id={`${id}-hint`} className="text-xs text-text-muted m-0">
          Leave empty to keep the current series&apos; start time.
        </p>
      )}
    </div>
  );
}

PreferenceValueField.propTypes = {
  id: PropTypes.string.isRequired,
  dimension: PropTypes.oneOf(['weekday', 'start_time', 'venue']).isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onChange: PropTypes.func.isRequired,
  locations: PropTypes.arrayOf(
    PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string })
  ).isRequired,
  disabled: PropTypes.bool,
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
