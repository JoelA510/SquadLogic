import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import { GAME_PUBLISH_NOTE_MAX, GAME_PUBLISH_REASONS } from '@squadlogic/core/gamePublished.js';
import { NOTE_HELPER_TEXT, matchupOf, movedGameNote } from '../../utils/gamePublishedText.js';

/** How many games the dialog lists before saying how many more there are. */
const LISTED = 10;

/**
 * "Allow changes" to Published games (plan `docs/changes/2026-11-03-schedule-expansion.md`, 3.4 and 3.6, PR 3 task
 * C3; owner decision 1). Turning Published OFF is a deliberate, audited act, so it is never a side effect of a save,
 * a move or a cancel; this dialog is the only way to do it. Its pattern is `GridOverrideDialog`'s (the practice
 * grid's unlock prompt):
 *
 * - The count, and the first ten games by name, so the person sees what they are about to release.
 * - **A reason from the closed list** and **one tick**. Confirm stays disabled, with a visible reason, until both are
 *   given. Nothing is sent before Confirm.
 * - **An optional note** of at most 200 characters, with a counter, and the helper text that asks for no player names
 *   or other personal information. The note is audited and an audit row has no per-row delete path (it is pruned
 *   only by the retention job), so the helper text is a soft control and the dialog says what the note is for.
 * - Focus goes to the heading on open and back to what opened it on close (`Modal` restores it). A refusal after
 *   Confirm is shown here, as an alert, in the database's words.
 *
 * It also says, once, what a move does to a game's identity: a game moved to another slot or week is still the same
 * game and keeps its history (see `movedGameNote`).
 *
 * The parent remounts it (a new `key`) for each opening, so a tick or a reason never carries over to another set of
 * games.
 *
 * @param {{ open: boolean,
 *   games: Array<Record<string, any>>,
 *   scopeText?: string | null,
 *   busy: boolean,
 *   notice: { tone: 'alert' | 'status', text: string } | null,
 *   onConfirm: (input: { reasonCode: string, note: string }) => void,
 *   onClose: () => void }} props
 */
export default function AllowChangesDialog({
  open,
  games,
  scopeText = null,
  busy,
  notice,
  onConfirm,
  onClose,
}) {
  const headingRef = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  // Confirm disables every control while saving, which drops focus to the page; a refusal then pulls it back to the
  // notice, inside the dialog.
  const noticeRef = useRef(/** @type {HTMLParagraphElement | null} */ (null));
  useEffect(() => {
    if (notice && !busy) noticeRef.current?.focus();
  }, [notice, busy]);
  // `Modal` re-runs its focus effect whenever `onClose` changes identity, so it gets one stable callback: choosing a
  // reason must never move focus.
  const latest = useRef({ busy, onClose });
  useEffect(() => {
    latest.current = { busy, onClose };
  });
  const close = useCallback(() => {
    if (!latest.current.busy) latest.current.onClose();
  }, []);

  const ids = {
    reason: useId(),
    note: useId(),
    help: useId(),
    count: useId(),
    tick: useId(),
    why: useId(),
  };
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [ticked, setTicked] = useState(false);

  const total = games.length;
  const noteLength = [...note].length;
  const disabledWhy = busy
    ? 'Saving…'
    : total === 0
      ? 'There are no Published games here to allow changes to.'
      : !reasonCode
        ? 'Choose a reason.'
        : !ticked
          ? 'Tick the box to confirm.'
          : null;
  const heading = `Allow changes to ${total} Published ${total === 1 ? 'game' : 'games'}`;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Allow changes to Published games"
      initialFocusRef={headingRef}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onConfirm({ reasonCode, note })}
            disabled={disabledWhy !== null}
            aria-busy={busy}
            aria-describedby={ids.why}
            data-testid="allow-changes-confirm"
          >
            Confirm and allow changes
          </Button>
        </>
      }
    >
      <h3 ref={headingRef} tabIndex={-1} className="text-sm" data-testid="allow-changes-heading">
        <strong>{heading}</strong>
      </h3>
      <p className="text-sm mt-2">
        {scopeText ? `Chosen as: ${scopeText}. ` : ''}
        These games are Published: families have been told where and when they play, so they are
        held in place. Allowing changes releases them so they can be moved or cancelled, and so that
        a new schedule can move them. Nothing else about them changes, and you can publish them
        again at any time. The published baseline that an export records is a separate record of
        what went out, and it is not changed.
      </p>
      <p className="text-sm mt-2" data-testid="allow-changes-moved-note">
        {movedGameNote}
      </p>
      <ul className="text-sm mt-2" data-testid="allow-changes-games">
        {games.slice(0, LISTED).map((game) => {
          const { home, away } = matchupOf(game);
          return (
            <li key={game.id}>
              {home} vs {away}
              {game.whenText ? ` · ${game.whenText}` : ''}
            </li>
          );
        })}
      </ul>
      {total > LISTED && (
        <p className="text-sm" data-testid="allow-changes-more">
          and {total - LISTED} more
        </p>
      )}

      <div className="field mt-2">
        <label htmlFor={ids.reason}>Reason for allowing changes</label>
        <select
          id={ids.reason}
          className="select"
          value={reasonCode}
          disabled={busy}
          onChange={(event) => setReasonCode(event.target.value)}
          data-testid="allow-changes-reason"
        >
          <option value="">Choose a reason</option>
          {GAME_PUBLISH_REASONS.map((reason) => (
            <option key={reason.code} value={reason.code}>
              {reason.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field mt-2">
        <label htmlFor={ids.note}>Note (optional)</label>
        <textarea
          id={ids.note}
          className="input"
          rows={2}
          value={note}
          disabled={busy}
          aria-describedby={`${ids.help} ${ids.count}`}
          // The database counts characters, not UTF-16 units, and refuses a longer note; the screen never lets one be
          // typed or pasted.
          onChange={(event) =>
            setNote([...event.target.value].slice(0, GAME_PUBLISH_NOTE_MAX).join(''))
          }
          data-testid="allow-changes-note"
        />
        <p id={ids.help} className="text-xs mt-1" data-testid="allow-changes-note-help">
          {NOTE_HELPER_TEXT}
        </p>
        <p id={ids.count} className="text-xs" data-testid="allow-changes-note-count">
          {noteLength} / {GAME_PUBLISH_NOTE_MAX}
        </p>
        <p className="text-xs">
          The note is kept in the audit history, which is cleared only by the retention job (180
          days by default).
        </p>
      </div>

      <div className="field mt-2">
        <label className="text-sm" htmlFor={ids.tick}>
          <input
            id={ids.tick}
            type="checkbox"
            className="cbx"
            checked={ticked}
            disabled={busy}
            onChange={(event) => setTicked(event.target.checked)}
            data-testid="allow-changes-tick"
          />{' '}
          {total === 1
            ? 'I understand this game is no longer held in place until I publish it again.'
            : `I understand these ${total} games are no longer held in place until I publish them again.`}
        </label>
      </div>

      <p id={ids.why} className="text-sm" data-testid="allow-changes-why">
        {disabledWhy ?? 'Ready: Confirm releases the games and records the reason.'}
      </p>
      {notice && (
        <p
          className={`text-sm mt-2 ${
            notice.tone === 'alert' ? 'text-status-error-text' : 'text-status-success-text'
          }`}
          role={notice.tone}
          ref={noticeRef}
          tabIndex={-1}
          data-testid="allow-changes-notice"
        >
          {notice.text}
        </p>
      )}
    </Modal>
  );
}

AllowChangesDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  games: PropTypes.arrayOf(PropTypes.object).isRequired,
  scopeText: PropTypes.string,
  busy: PropTypes.bool.isRequired,
  notice: PropTypes.shape({ tone: PropTypes.string, text: PropTypes.string }),
  onConfirm: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
