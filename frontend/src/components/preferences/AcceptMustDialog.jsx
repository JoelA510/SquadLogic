import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import Modal from '../ui/Modal.jsx';
import { decideMustPreference } from '../../hooks/useCoachPracticePreferences.js';
import { describeRule, ruleOfRow } from '../../utils/coachPreferencePreview.js';
import MustKeepPreview from './MustKeepPreview.jsx';

/** Accept one requested must, with the re-judge of what it would break. */
export default function AcceptMustDialog({
  row,
  coachName,
  teamName,
  previewContext,
  date,
  onClose,
  onDone,
  toast,
}) {
  const [busy, setBusy] = useState(false);
  // A row core cannot read says so (as the preview does for the others) instead of breaking the dialog.
  const proposal = useMemo(() => {
    try {
      return { rule: { ...ruleOfRow(row), level: 'must' }, error: null };
    } catch (err) {
      return { rule: null, error: err?.message || String(err) };
    }
  }, [row]);

  const confirm = async () => {
    setBusy(true);
    try {
      await decideMustPreference({ row, decision: 'accept' });
      toast('Accepted as a must', 'success');
      await onDone();
      onClose();
    } catch (err) {
      toast(err?.message || 'The decision failed', 'warning');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Accept as must"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} loading={busy} disabled={busy}>
            Accept as must
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm m-0">
          Coach: <strong>{coachName}</strong> · Team: <strong>{teamName}</strong>
        </p>
        <p className="text-sm m-0">
          Requested as a must: {describeRule(row, previewContext.locationNames)}
        </p>
        {proposal.error ? (
          <p role="alert" className="text-sm m-0">
            Could not re-judge this decision: {proposal.error}. Review the team&apos;s current
            series before accepting.
          </p>
        ) : (
          <MustKeepPreview proposal={proposal.rule} context={previewContext} date={date} />
        )}
      </div>
    </Modal>
  );
}

AcceptMustDialog.propTypes = {
  row: PropTypes.object.isRequired,
  coachName: PropTypes.string.isRequired,
  teamName: PropTypes.string.isRequired,
  previewContext: PropTypes.object.isRequired,
  date: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
  toast: PropTypes.func.isRequired,
};
