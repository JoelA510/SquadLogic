import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';
import { formatDateTime } from '../../utils/formatters.js';
import { readGameHistory } from '../../utils/gamePublishedClient.js';
import { describeHistoryRow, matchupOf } from '../../utils/gamePublishedText.js';

/**
 * One game's Published history: when it was published and who did it, and each time changes were allowed, with the
 * reason, the note and how the game was chosen (plan `docs/changes/2026-11-03-schedule-expansion.md`, 3.4 and 3.6;
 * the rows are `get_schedule_audit_log`'s, admin only).
 *
 * The history is the database's, for this game's row id, as it returns it. A game moved to another slot or week keeps
 * its id (the save updates it in place), so its history stays with it; a game the new schedule no longer holds stays in
 * the old run with its history, and a game the schedule has that continues no saved game is new and starts with none.
 * The dialog says so rather than let an empty list read as "never published".
 *
 * Opened for one game and remounted (a new `key`) for the next, so the read is the dialog's own.
 *
 * @param {{ open: boolean, game: Record<string, any>, organizationId: string, timezone?: string | null,
 *   onClose: () => void, client?: any }} props
 */
export default function GameHistoryDialog({
  open,
  game,
  organizationId,
  timezone = null,
  onClose,
  client = undefined,
}) {
  const headingRef = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  const [state, setState] = useState(
    /** @type {{ status: 'loading' | 'ready' | 'error', rows: any[], error: string | null }} */ ({
      status: 'loading',
      rows: [],
      error: null,
    })
  );
  const { home, away } = matchupOf(game);

  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    readGameHistory({
      organizationId,
      gameId: String(game.id),
      ...(client ? { client } : {}),
    }).then(
      (rows) => {
        if (current) setState({ status: 'ready', rows, error: null });
      },
      (err) => {
        // The database's words; nothing here is a guess about what the list would have said.
        if (current) setState({ status: 'error', rows: [], error: err.message });
      }
    );
    return () => {
      current = false;
    };
  }, [open, organizationId, game.id, client]);

  const entries =
    state.status === 'ready'
      ? state.rows
          .map((row) =>
            describeHistoryRow(row, (value) => formatDateTime(value, timezone ?? undefined))
          )
          .filter(Boolean)
      : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`History: ${home} versus ${away}`}
      initialFocusRef={headingRef}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <h3 ref={headingRef} tabIndex={-1} className="text-sm" data-testid="game-history-heading">
        <strong>
          {home} vs {away}
        </strong>
      </h3>
      {state.status === 'loading' && (
        <p className="text-sm mt-2" role="status">
          Reading the history{'…'}
        </p>
      )}
      {state.status === 'error' && (
        <p
          className="text-sm mt-2 text-status-error-text"
          role="alert"
          data-testid="game-history-error"
        >
          {state.error}
        </p>
      )}
      {state.status === 'ready' && entries.length === 0 && (
        <p className="text-sm mt-2" data-testid="game-history-empty">
          No history is recorded for this game yet.
        </p>
      )}
      {entries.length > 0 && (
        <ol className="text-sm mt-2 space-y-2" data-testid="game-history-list">
          {entries.map((entry) => (
            <li key={entry.id} data-testid="game-history-entry">
              <strong>{entry.title}</strong>
              {` · ${entry.when} · ${entry.who}`}
              {entry.details.length > 0 && (
                <ul>
                  {entry.details.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="text-xs text-text-muted mt-2">
        This is the history of this game as it is saved. A game keeps its history when it is moved
        to another time slot or week. A new game, one that continues no saved game, starts with
        none.
      </p>
    </Modal>
  );
}

GameHistoryDialog.propTypes = {
  open: PropTypes.bool.isRequired,
  game: PropTypes.object.isRequired,
  organizationId: PropTypes.string.isRequired,
  timezone: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  client: PropTypes.object,
};
