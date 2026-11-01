import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import Modal from '../ui/Modal.jsx';
import {
  acceptAllMusts,
  isExpectedCountMismatch,
} from '../../hooks/useCoachPracticePreferences.js';
import {
  DIMENSION_LABEL,
  describeRule,
  formatPreferenceValue,
} from '../../utils/coachPreferencePreview.js';
import { acceptAllImpact } from '../../utils/practiceMustConflicts.js';
import { groupTitle } from '../../utils/pendingMustGroups.js';

/**
 * The confirmation for Accept all (Phase D C2): one file's pending musts made musts together.
 *
 * It names **how many** rules it makes musts and lists **any conflicts first**: musts that no
 * practice can meet together (among the file's own rules, or with musts already in force), which
 * leave a team TIME TBD naming the rules. After the conflicts it lists the team's current practice
 * series that would stop meeting a must.
 *
 * The count on the button is the count sent: `admin_accept_all_musts(job, expected_count)` refuses
 * and accepts nothing when the file's pending musts are not that many. The refusal is shown in
 * the dialog in words, the list is refreshed, and the button then names the new count: the admin
 * confirms again, knowing what changed. Nothing is swallowed.
 */
export default function AcceptAllDialog({
  group,
  ruleRows,
  rosterRows,
  practiceRows,
  date,
  previewError,
  coachName,
  teamName,
  locationNames,
  onClose,
  onRefresh,
  toast,
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(
    /** @type {{ text: string, database: string } | null} */ (null)
  );
  const count = group.rows.length;

  const outcome = useMemo(() => {
    if (previewError) {
      return { error: previewError.message || 'the team and practice data did not load' };
    }
    try {
      return {
        impact: acceptAllImpact({
          pendingRows: group.rows,
          ruleRows,
          rosterRows,
          practiceRows,
          date,
        }),
      };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  }, [group.rows, ruleRows, rosterRows, practiceRows, date, previewError]);

  const rowById = useMemo(() => new Map(ruleRows.map((row) => [String(row.id), row])), [ruleRows]);
  const ruleText = (ruleId) => {
    const row = rowById.get(String(ruleId));
    if (!row) return `Rule ${ruleId}`;
    const pendingNote = row.must_decision === 'pending' ? ' (would become a must)' : '';
    return `${coachName(row.coach_id)}: ${describeRule(row, locationNames)}${pendingNote}`;
  };

  const confirm = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const result = await acceptAllMusts({ importJobId: group.jobId, expectedCount: count });
      toast(`${result?.accepted ?? count} rules are musts now`, 'success');
      await onRefresh();
      onClose();
    } catch (err) {
      const database = err?.message || 'Accept all failed';
      if (isExpectedCountMismatch(err)) {
        setRefusal({
          text: 'Nothing was accepted. This file’s pending musts changed after you opened this, so the count you confirmed is out of date. The list has been refreshed: check the count below and confirm again.',
          database,
        });
        // The refusal is the cue to look again: the list is read afresh, and the button names the
        // count it now holds.
        try {
          await onRefresh();
        } catch (refreshError) {
          setRefusal({
            text: `Nothing was accepted, and the list could not be refreshed (${refreshError?.message || 'unknown error'}). Close this and reload the page before trying again.`,
            database,
          });
        }
      } else {
        setRefusal({ text: `Nothing was accepted. ${database}`, database });
      }
    } finally {
      setBusy(false);
    }
  };

  const conflicts = outcome.impact?.conflicts ?? [];
  const unsatisfiable = outcome.impact?.unsatisfiable ?? [];
  const teamCount = new Set(group.rows.map((row) => String(row.team_id))).size;

  return (
    <Modal
      open
      onClose={onClose}
      title="Accept all pending musts"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} loading={busy} disabled={busy || count === 0}>
            {`Make ${count} ${count === 1 ? 'rule a must' : 'rules musts'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {refusal && (
          <div role="alert" data-testid="accept-all-refusal" className="text-sm field-error">
            <p className="m-0">{refusal.text}</p>
            <p className="m-0 mt-1 text-text-muted">The database said: {refusal.database}</p>
          </div>
        )}
        <p className="text-sm m-0" data-testid="accept-all-count">
          This makes <strong>{count}</strong> {count === 1 ? 'rule a must' : 'rules musts'}: every
          pending must from {groupTitle(group).replace(/^From /, '')}, for{' '}
          <strong>{teamCount}</strong> {teamCount === 1 ? 'team' : 'teams'}. A must is a hard rule:
          a team with no practice that meets it is listed as TIME TBD, never dropped.
        </p>
        {count === 0 && (
          <p className="text-sm m-0">
            This file has no pending musts left; there is nothing to accept.
          </p>
        )}

        {outcome.error ? (
          <p role="alert" className="text-sm m-0">
            Could not check these musts against the teams&apos; rules and practices: {outcome.error}
            . Review the conflicts view before accepting.
          </p>
        ) : (
          <>
            <section
              aria-labelledby="accept-all-conflicts-heading"
              data-testid="accept-all-conflicts"
            >
              <h3 id="accept-all-conflicts-heading" className="text-sm font-bold m-0 mb-2">
                Conflicts ({conflicts.length})
              </h3>
              {conflicts.length === 0 ? (
                <p className="text-sm m-0">
                  No conflicts: these musts can be met together with each other and with the musts
                  already in force.
                </p>
              ) : (
                <>
                  <p className="text-sm m-0 mb-2">
                    These musts cannot all be met by one practice. If you accept them, each team
                    below is listed as TIME TBD, naming these rules, until one is changed.
                  </p>
                  <ul className="m-0 pl-5 text-sm flex flex-col gap-2">
                    {conflicts.map((conflict) => (
                      <li
                        key={`${conflict.teamId}-${conflict.dimension}-${conflict.ruleIds.join(',')}`}
                        data-testid="accept-all-conflict"
                      >
                        <strong>{teamName(conflict.teamId)}</strong>:{' '}
                        {DIMENSION_LABEL[conflict.dimension].toLowerCase()} values with nothing in
                        common.
                        <ul className="m-0 pl-5">
                          {conflict.ruleIds.map((ruleId) => (
                            <li key={ruleId}>{ruleText(ruleId)}</li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section aria-labelledby="accept-all-series-heading">
              <h3 id="accept-all-series-heading" className="text-sm font-bold m-0 mb-2">
                Current practice series that would stop meeting a must ({unsatisfiable.length})
              </h3>
              {unsatisfiable.length === 0 ? (
                <p className="text-sm m-0" data-testid="accept-all-series-none">
                  None
                </p>
              ) : (
                <ul className="m-0 pl-5 text-sm">
                  {unsatisfiable.map((entry) => (
                    <li key={entry.assignmentId} data-testid="accept-all-series">
                      {teamName(entry.teamId)}:{' '}
                      {formatPreferenceValue('weekday', entry.placement.weekday)}{' '}
                      {formatPreferenceValue('start_time', entry.placement.startMinutes)} at{' '}
                      {formatPreferenceValue('venue', entry.placement.locationId, locationNames)}
                      {entry.alreadyUnsatisfiable &&
                        ' (already unsatisfiable before this decision)'}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {(outcome.impact?.unreadable ?? []).length > 0 && (
              <p role="alert" className="text-sm m-0">
                {outcome.impact.unreadable.length} rule(s) could not be read and are not part of
                this check: {outcome.impact.unreadable.map((item) => item.message).join('; ')}.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

AcceptAllDialog.propTypes = {
  group: PropTypes.shape({
    jobId: PropTypes.string.isRequired,
    rows: PropTypes.array.isRequired,
    fileName: PropTypes.string,
    importedOn: PropTypes.string,
  }).isRequired,
  ruleRows: PropTypes.array.isRequired,
  rosterRows: PropTypes.array.isRequired,
  practiceRows: PropTypes.array.isRequired,
  date: PropTypes.string.isRequired,
  previewError: PropTypes.object,
  coachName: PropTypes.func.isRequired,
  teamName: PropTypes.func.isRequired,
  locationNames: PropTypes.instanceOf(Map).isRequired,
  onClose: PropTypes.func.isRequired,
  onRefresh: PropTypes.func.isRequired,
  toast: PropTypes.func.isRequired,
};
