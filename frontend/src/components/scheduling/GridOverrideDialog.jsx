import React, { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import { GRID_OVERRIDE_REASONS } from '../../utils/gridOverridePrompt.js';

/**
 * The scheduling grid's override prompt (operator ruling 2;
 * `docs/PLAN_GRID_OVERRIDE_PROMPT.md` §2.2, §2.9). The pattern is
 * `PracticeEnactDialog`'s, not a copy of it (Q5):
 *
 * - Per team: the saved series being replaced, what replaces them, and the
 *   history kept unchanged.
 * - **One checkbox per team**, and one reason from a picklist (Q3). Confirm
 *   stays disabled, with a visible reason, until every box is ticked and a
 *   reason is chosen. Nothing is sent before Confirm.
 * - A row the admin did not stage (`strays`) blocks Confirm by name (Q7).
 * - Focus goes to the heading on open and back to Apply on close (`Modal`
 *   restores it). A refusal after Confirm is shown here, as an alert.
 *
 * The parent remounts it (a new `key`) whenever the list it shows changes, so
 * a tick never carries over to a different prompt.
 *
 * @param {{ open: boolean,
 *   teams: Array<{ teamId: string, teamName: string, replacing: string[],
 *     replacement: string[], kept: string[], past?: string | null }>,
 *   strays: string[], blocked: string | null, busy: boolean,
 *   notice: { tone: 'alert' | 'status', text: string } | null,
 *   onConfirm: (reasonCode: string) => void, onClose: () => void }} props
 */
export default function GridOverrideDialog({
  open,
  teams,
  strays,
  blocked,
  busy,
  notice,
  onConfirm,
  onClose,
}) {
  const headingRef = useRef(/** @type {HTMLHeadingElement|null} */ (null));
  // Confirm disables every control while saving, which drops focus to the
  // page; a refusal then pulls it back to the notice, inside the dialog.
  const noticeRef = useRef(/** @type {HTMLParagraphElement|null} */ (null));
  useEffect(() => {
    if (notice && !busy) noticeRef.current?.focus();
  }, [notice, busy]);
  // `Modal` re-runs its focus effect whenever `onClose` changes identity, so
  // it gets one stable callback: ticking a box must never move focus.
  const latest = useRef({ busy, onClose });
  useEffect(() => {
    latest.current = { busy, onClose };
  });
  const close = useCallback(() => {
    if (!latest.current.busy) latest.current.onClose();
  }, []);
  const [ticked, setTicked] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [reasonCode, setReasonCode] = useState('');
  const allTicked = teams.length > 0 && teams.every((t) => ticked[t.teamId] === true);
  const disabledWhy = busy
    ? 'Saving…'
    : strays.length > 0
      ? 'It cannot be saved here: a saved practice of a team with no staged override would be ' +
        'removed. Discard the review and stage that team too, or leave it out.'
      : blocked
        ? blocked
        : !allTicked
          ? `Tick the box for ${teams.length === 1 ? 'the team' : 'every team'} to confirm the override.`
          : !reasonCode
            ? 'Choose a reason for the override.'
            : null;
  const heading =
    teams.length === 1
      ? `Replace ${teams[0].teamName}’s saved practice`
      : `Replace ${teams.length} teams’ saved practices`;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Override a saved practice"
      initialFocusRef={headingRef}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm(reasonCode)}
            disabled={disabledWhy !== null}
            aria-busy={busy}
            aria-describedby="grid-override-confirm-why"
            data-testid="grid-override-confirm"
          >
            Confirm and save
          </Button>
        </>
      }
    >
      <h3 ref={headingRef} tabIndex={-1} className="text-sm" data-testid="grid-override-heading">
        <strong>
          {strays.length > 0 && teams.length === 0 ? 'This save cannot unlock' : heading}
        </strong>
      </h3>
      <p className="text-sm mt-2">
        Saved practices are locked. Confirming unlocks exactly the series listed as replaced. Each
        one that has started ends on yesterday, so its past practices stay as they were; one that
        has not started yet is replaced whole. The rest of the schedule is saved as staged.
      </p>
      {teams.map((t) => (
        <section
          key={t.teamId}
          className="mt-2"
          aria-labelledby={`grid-override-team-${t.teamId}`}
          data-testid="grid-override-team"
          data-team-id={t.teamId}
        >
          <h4 id={`grid-override-team-${t.teamId}`} className="text-sm">
            <strong>{t.teamName}</strong>
          </h4>
          <ul className="text-sm">
            <li data-testid="grid-override-replacing">Replacing: {t.replacing.join(' and ')}</li>
            <li data-testid="grid-override-replacement">
              With: {t.replacement.length > 0 ? t.replacement.join(' and ') : 'no practice'}
            </li>
            {t.past && <li data-testid="grid-override-past">{t.past}</li>}
            {t.kept.length > 0 && (
              <li data-testid="grid-override-kept">
                Kept (history, unchanged): {t.kept.join(' and ')}
              </li>
            )}
          </ul>
        </section>
      ))}
      {strays.length > 0 && (
        <div className="mt-2" data-testid="grid-override-strays">
          <p className="text-sm">
            <strong>Cannot be unlocked here</strong> (no override was staged for its team):
          </p>
          <ul className="text-sm">
            {strays.map((text) => (
              <li key={text} data-testid="grid-override-stray">
                {text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {teams.length > 0 && (
        <fieldset className="mt-2">
          <legend className="text-sm">
            <strong>Accept the override</strong>
          </legend>
          {teams.map((t) => (
            <div key={t.teamId} className="field">
              <label className="text-sm" htmlFor={`grid-override-accept-${t.teamId}`}>
                <input
                  id={`grid-override-accept-${t.teamId}`}
                  type="checkbox"
                  className="cbx"
                  checked={ticked[t.teamId] === true}
                  disabled={busy}
                  onChange={(event) =>
                    setTicked((current) => ({ ...current, [t.teamId]: event.target.checked }))
                  }
                  data-testid="grid-override-accept"
                />{' '}
                Replace and lock {t.teamName}&rsquo;s practice as shown
              </label>
            </div>
          ))}
        </fieldset>
      )}
      <div className="field mt-2">
        <label htmlFor="grid-override-reason">Reason for the override</label>
        <select
          id="grid-override-reason"
          className="select"
          value={reasonCode}
          disabled={busy}
          onChange={(event) => setReasonCode(event.target.value)}
          data-testid="grid-override-reason"
        >
          <option value="">Choose a reason</option>
          {GRID_OVERRIDE_REASONS.map((reason) => (
            <option key={reason.code} value={reason.code}>
              {reason.label}
            </option>
          ))}
        </select>
      </div>
      <p id="grid-override-confirm-why" className="text-sm" data-testid="grid-override-why">
        {disabledWhy ?? 'Ready: Confirm unlocks the replaced practices and saves the override.'}
      </p>
      {notice && (
        <p
          className={`badge ${notice.tone === 'alert' ? 'danger' : 'success'} mt-2`}
          role={notice.tone}
          ref={noticeRef}
          tabIndex={-1}
          data-testid="grid-override-notice"
        >
          {notice.text}
        </p>
      )}
    </Modal>
  );
}

GridOverrideDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  teams: PropTypes.arrayOf(
    PropTypes.shape({
      teamId: PropTypes.string.isRequired,
      teamName: PropTypes.string.isRequired,
      replacing: PropTypes.arrayOf(PropTypes.string).isRequired,
      replacement: PropTypes.arrayOf(PropTypes.string).isRequired,
      kept: PropTypes.arrayOf(PropTypes.string).isRequired,
      past: PropTypes.string,
    })
  ).isRequired,
  strays: PropTypes.arrayOf(PropTypes.string).isRequired,
  blocked: PropTypes.string,
  busy: PropTypes.bool.isRequired,
  notice: PropTypes.shape({ tone: PropTypes.string, text: PropTypes.string }),
  onConfirm: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
