import React from 'react';
import PropTypes from 'prop-types';

/**
 * Accessible switch. Styles from `.toggle` in styles/page.css.
 *
 * @param {Object} props
 * @param {boolean} props.checked
 * @param {(next: boolean) => void} props.onChange
 * @param {string} props.label - Accessible name (visually hidden unless showLabel).
 * @param {boolean} [props.disabled]
 * @param {string} [props.describedBy] - Id of the text that says why, or what, this switch is.
 * @param {string} [props.className]
 */
export default function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  describedBy,
  className = '',
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''} ${className}`.trim()}
      onClick={() => onChange(!checked)}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
    >
      <span className="knob" />
    </button>
  );
}

Toggle.propTypes = {
  checked: PropTypes.bool.isRequired,
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string.isRequired,
  disabled: PropTypes.bool,
  describedBy: PropTypes.string,
  className: PropTypes.string,
};
