import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Clock, MapPin } from 'lucide-react';
import { formatTime } from '../../utils/formatters.js';
import { useFeatures } from '../../hooks/useFeatures.js';
import { divisionDisplayName } from '../../utils/divisions.js';

/**
 * The grid's move targets and its one move handler, provided by
 * `GameSchedulingPage` around the grid (plan item M4.3).
 *
 * - `cellLabels`: every cell the grid renders (`'fieldId:slotId'`, the drop
 *   zone's id, so a move names its target exactly as a drop does) -> its name.
 * - `emptyCells`: the cells a game can be moved to, `{ id, label }`: each game
 *   slot on its own field, with no game in it.
 * - `moveGame(gameId, cellId, { focusMoved })`: the page's move handler, the
 *   same one a drop calls. There is no second write path.
 * - `claimFocus(gameId)`: true once for the game a "Move to" just moved, so its
 *   card takes focus where it lands rather than leaving it on the body.
 *
 * @type {React.Context<null | {
 *   cellLabels: Map<string, string>,
 *   emptyCells: Array<{ id: string, label: string }>,
 *   moveGame: (gameId: string, cellId: string, options?: { focusMoved?: boolean }) => void,
 *   claimFocus: (gameId: string) => boolean,
 * }>}
 */
export const GameMoveContext = createContext(null);

/**
 * "Move to…": the non-drag alternative to dragging a game (WCAG 2.2, 2.5.7).
 *
 * The options are rendered once the list is reached (focus or a press), not
 * with every card: a season's grid holds many games, each of which could list
 * every empty slot.
 */
function MoveToControl({ assignment, move }) {
  const [armed, setArmed] = useState(false);
  const [target, setTarget] = useState('');
  const selectRef = useRef(null);
  const { claimFocus } = move;
  const cellId = `${assignment.fieldId}:${assignment.slotId}`;
  const here = move.cellLabels.get(cellId);
  const options = armed ? move.emptyCells.filter((cell) => cell.id !== cellId) : [];
  // A choice another move has since filled is no longer a choice.
  const chosen = options.some((cell) => cell.id === target) ? target : '';
  const matchup = `${assignment.homeTeamId} vs ${assignment.awayTeamId}`;
  const nothingEmpty = move.emptyCells.every((cell) => cell.id === cellId);
  // Cleared, not only masked (React's adjust-state-while-rendering pattern):
  // the cell could empty again and the old choice would come back unchosen.
  if (armed && target && !chosen) setTarget('');

  useEffect(() => {
    if (claimFocus(String(assignment.id))) selectRef.current?.focus();
  }, [assignment.id, claimFocus]);

  // A pointer press here is a choice, not the start of a drag of the card.
  const keepPointer = (event) => event.stopPropagation();

  return (
    <div className="mt-2 flex items-center gap-2">
      <select
        ref={selectRef}
        className="select"
        aria-label={`Move ${matchup}${here ? `, now at ${here},` : ''} to`}
        value={chosen}
        onChange={(event) => setTarget(event.target.value)}
        onFocus={() => setArmed(true)}
        onPointerDown={(event) => {
          keepPointer(event);
          setArmed(true);
        }}
        disabled={nothingEmpty}
      >
        <option value="">{nothingEmpty ? 'No empty slot' : 'Move to…'}</option>
        {options.map((cell) => (
          <option key={cell.id} value={cell.id}>
            {cell.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-default sm"
        disabled={!chosen}
        onPointerDown={keepPointer}
        onClick={() => move.moveGame(String(assignment.id), chosen, { focusMoved: true })}
      >
        Move
      </button>
    </div>
  );
}

MoveToControl.propTypes = {
  assignment: PropTypes.object.isRequired,
  move: PropTypes.shape({
    cellLabels: PropTypes.instanceOf(Map).isRequired,
    emptyCells: PropTypes.array.isRequired,
    moveGame: PropTypes.func.isRequired,
    claimFocus: PropTypes.func.isRequired,
  }).isRequired,
};

/**
 * GameCard — a draggable card representing a single game assignment in the schedule grid.
 *
 * Uses `useDraggable` from @dnd-kit/core (not useSortable, since slots hold 0-1 games).
 * Attaches the full assignment as drag data so handlers can access it.
 *
 * A pointer drags the whole card. The keyboard drags from the grip, a button
 * (the activator node), so a key pressed in the "Move to…" control never
 * starts a drag; the page's `KeyboardSensor` moves it between cells.
 */
export default function GameCard({
  assignment,
  hasConflict = false,
  isDragDisabled = false,
  timezone = undefined,
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } =
    useDraggable({
      id: assignment.id,
      data: assignment,
      disabled: isDragDisabled,
    });
  /** @type {{ onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement> } & Record<string, any>} */
  const { onKeyDown: keyboardListener, ...pointerListeners } = listeners ?? {};
  const move = useContext(GameMoveContext);
  const matchup = `${assignment.homeTeamId} vs ${assignment.awayTeamId}`;
  const { genderModel } = useFeatures();
  // Engine identity stays gendered; only the label collapses under co-ed.
  const divisionLabel = divisionDisplayName(assignment.division || '', genderModel) || '—';

  const style = {
    transform: transform ? CSS.Transform.toString(transform) : undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  const isManual = assignment.assignmentSource === 'manual';

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`game-card-${assignment.id}`}
      className={`p-3 bg-bg-surface border rounded-lg shadow-sm transition-colors ${
        isDragDisabled ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
      } ${
        hasConflict
          ? 'border-status-error shadow-[0_0_12px_rgba(239,68,68,0.25)]'
          : isDragging
            ? 'border-blue-500/50 shadow-lg'
            : 'border-border-subtle hover:border-border-highlight'
      }`}
      {...pointerListeners}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          {!isDragDisabled && (
            <button
              type="button"
              ref={setActivatorNodeRef}
              className="rounded text-text-muted hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ring)]"
              {...attributes}
              onKeyDown={keyboardListener}
              aria-label={`Drag ${matchup}`}
            >
              <GripVertical size={14} aria-hidden="true" />
            </button>
          )}
          <span className="font-semibold text-sm text-text-primary">{assignment.homeTeamId}</span>
          <span className="text-xs text-text-muted">vs</span>
          <span className="font-semibold text-sm text-text-primary">{assignment.awayTeamId}</span>
        </div>
        {isManual && (
          <span
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold bg-amber-500/20 text-status-warning-text border border-amber-500/30"
            data-testid="manual-badge"
          >
            manual
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-text-secondary">
        <span className="flex items-center gap-1">
          <Clock size={11} />
          {formatTime(assignment.start, timezone)}
        </span>
        <span className="flex items-center gap-1">
          <MapPin size={11} />
          Field {assignment.fieldId}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-bg-surface-hover text-text-muted text-[10px] font-medium">
          {divisionLabel}
        </span>
      </div>

      {move && !isDragDisabled && <MoveToControl assignment={assignment} move={move} />}
    </div>
  );
}

GameCard.propTypes = {
  assignment: PropTypes.shape({
    id: PropTypes.string.isRequired,
    slotId: PropTypes.string,
    homeTeamId: PropTypes.string.isRequired,
    awayTeamId: PropTypes.string.isRequired,
    start: PropTypes.string.isRequired,
    end: PropTypes.string,
    fieldId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
    division: PropTypes.string,
    assignmentSource: PropTypes.string,
  }).isRequired,
  hasConflict: PropTypes.bool,
  isDragDisabled: PropTypes.bool,
  timezone: PropTypes.string,
};

/**
 * GameCardPreview — simplified card shown in DragOverlay during drag.
 * No dnd hooks — purely presentational.
 */
export function GameCardPreview({ assignment }) {
  return (
    <div
      className="p-3 bg-bg-surface border border-blue-500 rounded-lg shadow-md opacity-90 scale-105 transform rotate-2"
      data-testid="game-card-preview"
    >
      <div className="flex items-center gap-2">
        <GripVertical size={14} className="text-text-accent" />
        <span className="font-semibold text-sm text-text-primary">
          {assignment.homeTeamId} vs {assignment.awayTeamId}
        </span>
      </div>
      <span className="text-xs text-text-muted">Moving game...</span>
    </div>
  );
}

GameCardPreview.propTypes = {
  assignment: PropTypes.shape({
    homeTeamId: PropTypes.string.isRequired,
    awayTeamId: PropTypes.string.isRequired,
  }).isRequired,
};
