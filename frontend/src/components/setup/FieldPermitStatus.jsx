import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import { permitStatusText, permitStatusTone } from '../../utils/permitText.js';

/**
 * What a field's card says about its permit: the current permit and when it expires, or that the
 * field has none. Text beside an icon, never colour alone. A retired or inactive field says nothing
 * (it does not need one). A permit blocks nothing: this is a reminder.
 *
 * @param {object} props
 * @param {string} props.fieldId
 * @param {boolean} props.needsPermit - the field is live and no current permit with a file covers it
 * @param {any|null} props.current - the covering permit with the latest end date among the current ones
 * @param {number} props.coveringCount - permits that name the field or its venue, of any status
 */
export default function FieldPermitStatus({ fieldId, needsPermit, current, coveringCount }) {
  if (needsPermit) {
    return (
      <div data-testid={`field-permit-${fieldId}`} className="mb-3">
        <Badge tone="warning">
          <AlertTriangle size={13} aria-hidden="true" /> No current permit
        </Badge>
        {coveringCount > 0 && (
          <span className="text-xs text-text-secondary" style={{ marginLeft: 8 }}>
            {coveringCount === 1 ? 'The permit on record is' : 'The permits on record are'} expired,
            not yet valid, or have no file.
          </span>
        )}
      </div>
    );
  }
  if (!current) return null;
  const Icon = current.status === 'expiring' ? Clock : CheckCircle2;
  return (
    <div data-testid={`field-permit-${fieldId}`} className="mb-3">
      <Badge
        tone={permitStatusTone(current.status)}
        title={`${current.issuer}${current.permit_number ? ` #${current.permit_number}` : ''}`}
      >
        <Icon size={13} aria-hidden="true" /> Permit: {permitStatusText(current)}
      </Badge>
    </div>
  );
}

FieldPermitStatus.propTypes = {
  fieldId: PropTypes.string.isRequired,
  needsPermit: PropTypes.bool.isRequired,
  current: PropTypes.object,
  coveringCount: PropTypes.number.isRequired,
};
