import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import { PRIORITY_LABEL, describeRule } from '../../utils/coachPreferencePreview.js';
import { groupTitle } from '../../utils/pendingMustGroups.js';

/**
 * The musts waiting for a decision (Phase D C2). A must asked for in a file counts as a prefer
 * until an admin accepts it; each can be accepted (with the impact preview) or kept as prefer, and a
 * file the admin reviewed before importing can be accepted whole with Accept all.
 */
export default function PendingMusts({
  groups,
  coachName,
  teamName,
  locationNames,
  readOnly,
  busyId,
  onAccept,
  onKeepPrefer,
  onAcceptAll,
}) {
  const total = useMemo(() => groups.reduce((sum, group) => sum + group.rows.length, 0), [groups]);

  if (total === 0) {
    return <p className="text-sm text-text-muted m-0">No pending musts.</p>;
  }
  const ruleLabel = (row) =>
    `${coachName(row.coach_id)}'s rule for ${teamName(row.team_id)}: ${describeRule(row, locationNames)}`;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-text-muted m-0">
        A must that was asked for counts as a prefer until you accept it. Sorted by the coach&apos;s
        priority, then oldest first; the priority is for your reading and does not change how the
        scheduler weighs a rule.
      </p>
      {groups.map((group) => {
        const headingId = `pending-group-${group.jobId || 'none'}`;
        return (
          <section key={group.jobId || 'none'} aria-labelledby={headingId}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
              <h3 id={headingId} className="text-sm font-bold text-text-primary m-0">
                {groupTitle(group)} ({group.rows.length})
              </h3>
              {group.jobId && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={readOnly}
                  aria-label={`Accept all ${group.rows.length} pending ${group.rows.length === 1 ? 'must' : 'musts'} ${groupTitle(group)}`}
                  onClick={() => onAcceptAll(group.jobId)}
                >
                  {`Accept all ${group.rows.length}…`}
                </Button>
              )}
            </div>
            <div className="grid-wrap">
              <table className="grid">
                <caption className="sr-only">
                  Practice preference musts waiting for a decision, {groupTitle(group)}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Coach</th>
                    <th scope="col">Team</th>
                    <th scope="col">Rule</th>
                    <th scope="col">Coach&apos;s priority</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{coachName(row.coach_id)}</td>
                      <td>{teamName(row.team_id)}</td>
                      <td>{describeRule(row, locationNames)}</td>
                      <td>
                        {row.coach_priority ? (
                          <Badge tone="neutral">{PRIORITY_LABEL[row.coach_priority]}</Badge>
                        ) : (
                          <span aria-label="No priority">—</span>
                        )}
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={readOnly || busyId === row.id}
                            aria-label={`Accept as must: ${ruleLabel(row)}`}
                            onClick={() => onAccept(row)}
                          >
                            Accept as must
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={readOnly || busyId === row.id}
                            loading={busyId === row.id}
                            aria-label={`Keep as prefer: ${ruleLabel(row)}`}
                            onClick={() => onKeepPrefer(row)}
                          >
                            Keep as prefer
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

PendingMusts.propTypes = {
  groups: PropTypes.arrayOf(
    PropTypes.shape({
      jobId: PropTypes.string.isRequired,
      rows: PropTypes.array.isRequired,
      fileName: PropTypes.string,
      importedOn: PropTypes.string,
    })
  ).isRequired,
  coachName: PropTypes.func.isRequired,
  teamName: PropTypes.func.isRequired,
  locationNames: PropTypes.instanceOf(Map).isRequired,
  readOnly: PropTypes.bool.isRequired,
  busyId: PropTypes.string,
  onAccept: PropTypes.func.isRequired,
  onKeepPrefer: PropTypes.func.isRequired,
  onAcceptAll: PropTypes.func.isRequired,
};
