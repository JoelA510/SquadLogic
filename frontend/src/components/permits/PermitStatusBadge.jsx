import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import { permitStatusText, permitStatusTone } from '../../utils/permitText.js';

const STATUS_ICON = {
  expired: AlertTriangle,
  expiring: Clock,
  not_yet_valid: Clock,
  valid: CheckCircle2,
};

/**
 * A permit's status: the words ("Expires in 12 days", "Expired 3 days ago") beside an
 * icon, never colour alone.
 *
 * @param {{ permit: { status: string, days_left: number, valid_from: string, valid_to: string } }} props
 */
export default function PermitStatusBadge({ permit }) {
  const Icon = STATUS_ICON[permit.status] ?? Clock;
  return (
    <Badge tone={permitStatusTone(permit.status)}>
      <Icon size={13} aria-hidden="true" /> {permitStatusText(permit)}
    </Badge>
  );
}

PermitStatusBadge.propTypes = {
  permit: PropTypes.shape({
    status: PropTypes.string.isRequired,
    days_left: PropTypes.number,
    valid_from: PropTypes.string,
    valid_to: PropTypes.string,
  }).isRequired,
};
