import React from 'react';
import PropTypes from 'prop-types';
import { useDroppable } from '@dnd-kit/core';
import { Check, X } from 'lucide-react';
import GameCard from './GameCard.jsx';

/**
 * TimeSlotDropZone — a droppable cell in the schedule grid.
 *
 * Each zone represents one field + time slot combination.
 * Uses `useDroppable` from @dnd-kit/core (not SortableContext,
 * since each slot holds at most one game).
 *
 * The composite droppable ID is `${fieldId}:${slotId}` so drag
 * handlers can parse the target location from event.over.id.
 */
export default function TimeSlotDropZone({
  fieldId,
  slotId,
  slotLabel = '',
  assignment = undefined,
  isValidTarget = false,
  isInvalidTarget = false,
  invalidReason = '',
  conflictSet = undefined,
  isDragDisabled = false,
  timezone = undefined,
}) {
  const invalidReasonId = React.useId();
  const droppableId = `${fieldId}:${slotId}`;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  const hasConflict = conflictSet?.has(assignment?.id);
  const showValidIndicator = isOver && isValidTarget;
  const showInvalidIndicator = isOver && isInvalidTarget;
  const invalidTooltipId = invalidReason ? `${invalidReasonId}-invalid-reason` : undefined;

  return (
    <div
      ref={setNodeRef}
      data-testid={`drop-zone-${droppableId}`}
      className={`relative min-h-[80px] p-2 rounded-lg border transition-colors ${
        showValidIndicator
          ? 'border-green-500 bg-green-500/10'
          : showInvalidIndicator
            ? 'border-status-error bg-status-error/10'
            : isOver
              ? 'border-blue-500/50 bg-blue-500/5'
              : 'border-border-subtle bg-bg-surface/30'
      }`}
    >
      {/* Slot time label */}
      {slotLabel && (
        <div className="text-[10px] text-text-muted font-mono mb-1.5 uppercase tracking-wider">
          {slotLabel}
        </div>
      )}

      {/* Validation indicator overlay */}
      {showValidIndicator && (
        <div className="absolute top-1 right-1" data-testid="valid-indicator">
          <Check size={14} className="text-status-success-text" />
        </div>
      )}
      {showInvalidIndicator && (
        <div
          className="absolute top-1 right-1 group rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-error/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
          data-testid="invalid-indicator"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so a keyboard user can read why the drop is invalid (its tooltip opens on focus, WCAG 1.4.13)
          tabIndex={0}
          aria-label="Invalid drop target"
          aria-describedby={invalidTooltipId}
        >
          <X size={14} className="text-status-error" aria-hidden="true" />
          {invalidReason && (
            <div
              id={invalidTooltipId}
              role="tooltip"
              className="absolute right-0 top-5 bg-bg-surface border border-border-subtle rounded px-2 py-1 text-xs text-text-secondary whitespace-nowrap shadow-lg z-10 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              {invalidReason}
            </div>
          )}
        </div>
      )}

      {/* Game card or empty placeholder */}
      {assignment ? (
        // Keyed by game: when a game leaves a cell another game shows in, a
        // reused card would keep the focus (and dnd-kit's focus restore) that
        // belonged to the game that moved.
        <GameCard
          key={assignment.id}
          assignment={assignment}
          hasConflict={hasConflict}
          isDragDisabled={isDragDisabled}
          timezone={timezone}
        />
      ) : (
        <div
          className={`h-16 border-2 border-dashed rounded-lg flex items-center justify-center text-text-muted text-xs italic ${
            isOver ? 'border-blue-500/40' : 'border-border-subtle'
          }`}
          data-testid={`empty-slot-${droppableId}`}
        >
          {isOver ? 'Drop here' : 'Open'}
        </div>
      )}
    </div>
  );
}

TimeSlotDropZone.propTypes = {
  fieldId: PropTypes.string.isRequired,
  slotId: PropTypes.string.isRequired,
  slotLabel: PropTypes.string,
  assignment: PropTypes.object,
  isValidTarget: PropTypes.bool,
  isInvalidTarget: PropTypes.bool,
  invalidReason: PropTypes.string,
  conflictSet: PropTypes.instanceOf(Set),
  isDragDisabled: PropTypes.bool,
  timezone: PropTypes.string,
};
