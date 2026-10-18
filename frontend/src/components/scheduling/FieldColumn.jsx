import React from 'react';
import PropTypes from 'prop-types';
import { MapPin } from 'lucide-react';
import TimeSlotDropZone from './TimeSlotDropZone.jsx';
import { isSlotOnField } from '../../utils/gameGridCells.js';

/**
 * FieldColumn — one vertical column in the schedule grid, representing a single field.
 *
 * Renders a header with the field name and a vertical stack of TimeSlotDropZones,
 * one per time slot. Purely presentational — no dnd hooks of its own.
 */
export default function FieldColumn({
  field,
  timeSlots,
  assignmentsBySlot = {},
  conflictSet = undefined,
  validationResult = undefined,
  activeGameId = undefined,
  isDragDisabled = false,
  timezone = undefined,
}) {
  return (
    <div
      className="bg-bg-surface/50 border border-border-subtle rounded-xl flex flex-col"
      data-testid={`field-column-${field.id}`}
    >
      {/* Field header */}
      <div className="p-3 border-b border-border-subtle bg-bg-surface rounded-t-xl shrink-0">
        <div className="flex items-center gap-2">
          <MapPin size={14} className="text-text-accent" />
          <h3 className="font-bold text-sm text-text-primary">{field.name}</h3>
        </div>
        {field.surface_type && (
          <span className="text-[10px] text-text-muted mt-0.5 block">
            {field.surface_type} • {field.size || 'Standard'}
          </span>
        )}
      </div>

      {/* Time slot stack */}
      <div className="flex-1 p-2 space-y-2">
        {timeSlots.map((slot) => {
          const assignment = assignmentsBySlot[slot.id] || null;
          // Another field's booking, drawn in this column: no drop lands here (the page's
          // move handler refuses it, as "Move to" never offers it).
          const isBookable = isSlotOnField(slot, field.id);

          // Determine validation state for this specific cell
          const isActiveTarget =
            validationResult &&
            activeGameId &&
            validationResult.targetFieldId === field.id &&
            validationResult.targetSlotId === slot.id;

          return (
            <TimeSlotDropZone
              key={slot.id}
              fieldId={field.id}
              slotId={slot.id}
              slotLabel={slot.label || ''}
              assignment={assignment}
              isBookable={isBookable}
              isValidTarget={isBookable && isActiveTarget ? validationResult.valid === true : false}
              isInvalidTarget={
                !isBookable || (isActiveTarget ? validationResult.valid === false : false)
              }
              invalidReason={
                !isBookable
                  ? `This time slot is booked on another field, not ${field.name}.`
                  : isActiveTarget && !validationResult.valid
                    ? validationResult.reason
                    : ''
              }
              conflictSet={conflictSet}
              isDragDisabled={isDragDisabled}
              timezone={timezone}
            />
          );
        })}

        {timeSlots.length === 0 && (
          <div className="text-center text-text-muted text-xs italic py-4">
            No time slots available
          </div>
        )}
      </div>
    </div>
  );
}

FieldColumn.propTypes = {
  field: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    surface_type: PropTypes.string,
    size: PropTypes.string,
  }).isRequired,
  timeSlots: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      label: PropTypes.string,
    })
  ).isRequired,
  assignmentsBySlot: PropTypes.object,
  conflictSet: PropTypes.instanceOf(Set),
  validationResult: PropTypes.shape({
    valid: PropTypes.bool,
    reason: PropTypes.string,
    targetFieldId: PropTypes.string,
    targetSlotId: PropTypes.string,
  }),
  activeGameId: PropTypes.string,
  isDragDisabled: PropTypes.bool,
  timezone: PropTypes.string,
};
