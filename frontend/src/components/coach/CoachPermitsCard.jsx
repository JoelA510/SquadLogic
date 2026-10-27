import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, FileText } from 'lucide-react';
import PermitStatusBadge from './PermitStatusBadge.jsx';
import { useFacilityPermits } from '../../hooks/useFacilityPermits.js';
import { coachPermitSummary } from '@squadlogic/core/facility/permits.js';
import { PERMIT_NO_FILE_TEXT, permitScopeText } from '../../utils/permitText.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The counts as one sentence: "1 expired, 1 with no file, 2 expiring within 30 days." */
function concernsText(summary) {
  const parts = [];
  if (summary.expired.length) parts.push(`${summary.expired.length} expired`);
  if (summary.noFile.length) parts.push(`${summary.noFile.length} with no file`);
  if (summary.expiring.length) parts.push(`${summary.expiring.length} expiring within 30 days`);
  if (summary.notYetValid.length) parts.push(`${summary.notYetValid.length} not yet in force`);
  return `Needs attention: ${parts.join(', ')}.`;
}

/**
 * "Field permits" on the coach's home, beside the schedule (plan
 * docs/changes/2026-10-22-phase-c-permits.md, C3; admin focus R6). The permits of the fields their
 * teams use, as the server narrows them (`get_facility_permits`); the card names the ones that
 * need attention, in words (expired, no file, expiring, not yet in force), and links to the page
 * that opens each.
 *
 * **A permit blocks nothing** (owner, 2026-10-26): this is a reminder. A coach whose teams use no
 * field with a permit sees an empty state, and a failed read is said, not thrown.
 */
export default function CoachPermitsCard() {
  const { permits, loading, error } = useFacilityPermits();
  const summary = coachPermitSummary(permits);

  return (
    <section
      className="card"
      aria-labelledby="coach-permits-heading"
      data-testid="coach-permits-card"
    >
      <div className="card-head">
        <FileText size={18} className="permit-card-icon" aria-hidden="true" />
        <h3 id="coach-permits-heading">Field permits</h3>
      </div>
      <div className="card-body" aria-busy={loading}>
        {loading && (
          <p className="muted" role="status">
            Loading your field permits…
          </p>
        )}
        {!loading && error && (
          // A failed read is said politely, as on the admin's Permits section: a permit blocks
          // nothing and the rest of the home works.
          <p className="permit-read-error" role="status" data-testid="coach-permits-error">
            <AlertTriangle size={16} aria-hidden="true" /> {error}
          </p>
        )}
        {!loading && !error && summary.total === 0 && (
          <p className="muted" data-testid="coach-permits-empty">
            No permits are on record for the fields your teams use. If you are asked for one at a
            field, ask your league administrator.
          </p>
        )}
        {!loading && !error && summary.total > 0 && summary.clear && (
          <p data-testid="coach-permits-clear">
            {summary.total === 1
              ? 'The permit for your fields is current.'
              : `All ${plural(summary.total, 'permit')} for your fields are current.`}
          </p>
        )}
        {!loading && !error && !summary.clear && (
          <>
            <p data-testid="coach-permits-concerns">{concernsText(summary)}</p>
            <ul className="permit-attention" data-testid="coach-permits-attention">
              {summary.attention.map((permit) => (
                <li key={permit.id} data-testid="coach-permit-attention">
                  <div className="permit-attention-main">
                    <strong>
                      {permit.issuer}
                      {permit.permit_number ? ` #${permit.permit_number}` : ''}
                    </strong>
                    <PermitStatusBadge permit={permit} />
                    {!permit.file && permit.status !== 'expired' && (
                      <span className="muted">{PERMIT_NO_FILE_TEXT}</span>
                    )}
                    {permit.scopes.length > 0 && (
                      <span className="muted">
                        Covers {permit.scopes.map(permitScopeText).join('; ')}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="permit-card-actions">
          <Link className="btn btn-default permit-touch" to="/permits">
            Show my field permits
          </Link>
        </div>
      </div>
    </section>
  );
}
