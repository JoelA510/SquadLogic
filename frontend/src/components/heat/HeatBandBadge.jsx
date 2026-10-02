import React from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';

/**
 * A U.S. Soccer Recognize to Recover alert band. The band's name is always
 * printed; tone is a second cue, never the only one (WCAG 1.4.1).
 */
const TONE = {
  Green: { tone: 'success' },
  Yellow: { tone: 'warning' },
  Orange: { tone: 'warning', className: 'badge-strong' },
  Red: { tone: 'danger' },
  Black: { tone: 'neutral', className: 'badge-inverse' },
};

export default function HeatBandBadge({ band }) {
  const t = TONE[band] ?? { tone: 'neutral' };
  return (
    <Badge tone={/** @type {any} */ (t.tone)} className={t.className ?? ''} dot>
      {band}
    </Badge>
  );
}

HeatBandBadge.propTypes = {
  band: PropTypes.oneOf(['Green', 'Yellow', 'Orange', 'Red', 'Black']).isRequired,
};
