import React, { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';

/**
 * The enact confirmation, which IS the ruling-2 override prompt for one
 * assignment (8.6 3b PR 11c; `docs/PHASE_8_6_PR11_ENACT_PLAN.md` §2).
 *
 * - The heading names the field and its STORED retirement date (Q3): the
 *   dialog opens only once the retirement is committed.
 * - It lists every row the write re-ranges or replaces, with its
 *   `assigned_via` and exactly what happens to it, then what replaces it,
 *   then how many published practices could change.
 * - **One checkbox per team.** Confirm stays disabled, with a visible
 *   reason, until every box is ticked. An unticked box sends nothing.
 * - The click-to-commit latency is declared (Q5): the schedule fingerprint
 *   does not cover slots, fields, blackouts or coaches.
 * - Focus goes to the heading on open and back to the row's Enact button on
 *   close (`Modal` restores it).
 *
 * @param {{ open: boolean, fieldName: string, storedDate: string, team: string,
 *   teams: Array<{ id: string, name: string }>,
 *   rows: Array<{ assignmentId: string, now: string, range: string, assignedVia: string,
 *     effect: string, rangeAfter: string | null }>,
 *   replacement: string, affected: number, busy: boolean,
 *   notice: { tone: 'alert' | 'status', text: string } | null,
 *   blocked: string | null, onConfirm: () => void, onClose: () => void }} props
 */
export default function PracticeEnactDialog({
  open,
  fieldName,
  storedDate,
  team,
  teams,
  rows,
  replacement,
  affected,
  busy,
  notice,
  blocked,
  onConfirm,
  onClose,
}) {
  const headingRef = useRef(/** @type {HTMLHeadingElement|null} */ (null));
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
  const allTicked = teams.length > 0 && teams.every((t) => ticked[t.id] === true);
  const disabledWhy = busy
    ? 'Saving…'
    : blocked
      ? blocked
      : allTicked
        ? null
        : `Tick the box for ${teams.length === 1 ? 'the team' : 'every team'} to confirm the override.`;

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Enact: ${fieldName} retires after ${storedDate}`}
      initialFocusRef={headingRef}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setTicked({});
              onConfirm();
            }}
            disabled={disabledWhy !== null}
            aria-busy={busy}
            aria-describedby="practice-enact-confirm-why"
            data-testid="practice-enact-confirm"
          >
            Confirm and enact
          </Button>
        </>
      }
    >
      <h3
        ref={headingRef}
        tabIndex={-1}
        className="text-sm"
        data-testid="practice-enact-heading"
        data-stored-date={storedDate}
      >
        <strong>
          Move {team}&rsquo;s practice off {fieldName}, retired after {storedDate}
        </strong>
      </h3>
      <p className="text-sm mt-2">
        This overrides a saved practice. Each row below is locked, and enacting changes it:
      </p>
      <ul className="text-sm" data-testid="practice-enact-rows">
        {rows.map((row) => (
          <li
            key={row.assignmentId}
            data-testid="practice-enact-row"
            data-assignment-id={row.assignmentId}
            data-effect={row.effect}
          >
            {row.now}, {row.range} (assigned via {row.assignedVia}): <strong>{row.effect}</strong>
            {row.rangeAfter ? `, now ${row.rangeAfter}` : ', from the retirement on'}
          </li>
        ))}
      </ul>
      <p className="text-sm mt-2" data-testid="practice-enact-replacement">
        Replaced by: {replacement}
      </p>
      <p className="text-sm" data-testid="practice-enact-affected" data-count={affected}>
        <strong>{affected}</strong> published practice{affected === 1 ? '' : 's'} could change.
      </p>
      <fieldset className="mt-2">
        <legend className="text-sm">
          <strong>Accept the override</strong>
        </legend>
        {teams.map((t) => (
          <div key={t.id} className="field">
            <label className="text-sm" htmlFor={`practice-enact-accept-${t.id}`}>
              <input
                id={`practice-enact-accept-${t.id}`}
                type="checkbox"
                className="cbx"
                checked={ticked[t.id] === true}
                disabled={busy}
                onChange={(event) =>
                  setTicked((current) => ({ ...current, [t.id]: event.target.checked }))
                }
                data-testid="practice-enact-accept"
              />{' '}
              Move and lock {t.name}&rsquo;s practice as shown
            </label>
          </div>
        ))}
      </fieldset>
      <p id="practice-enact-confirm-why" className="text-sm" data-testid="practice-enact-why">
        {disabledWhy ?? 'Ready: Confirm saves this one practice and locks it.'}
      </p>
      {notice && (
        <p
          className={`badge ${notice.tone === 'alert' ? 'danger' : 'success'} mt-2`}
          role={notice.tone}
          data-testid="practice-enact-notice"
        >
          {notice.text}
        </p>
      )}
      <p className="text-sm mt-2" data-testid="practice-enact-latency">
        Declared, not enforced: the check that the schedule has not changed covers practice
        assignments and exceptions only. Slots, fields, blackouts and coaches are re-read when you
        confirm, but a change to them in the seconds between Confirm and the save is not detected.
      </p>
    </Modal>
  );
}

PracticeEnactDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  fieldName: PropTypes.string.isRequired,
  storedDate: PropTypes.string.isRequired,
  team: PropTypes.string.isRequired,
  teams: PropTypes.arrayOf(
    PropTypes.shape({ id: PropTypes.string.isRequired, name: PropTypes.string.isRequired })
  ).isRequired,
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  replacement: PropTypes.string.isRequired,
  affected: PropTypes.number.isRequired,
  busy: PropTypes.bool.isRequired,
  notice: PropTypes.shape({ tone: PropTypes.string, text: PropTypes.string }),
  blocked: PropTypes.string,
  onConfirm: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
