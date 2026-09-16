import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * Severity classification for warning types from evaluateGameSchedule().
 * Hard conflicts (scheduling errors) are 'error'; advisory items are 'warning'.
 */
const SEVERITY_MAP = {
  'field-overlap': 'error',
  'coach-conflict': 'error',
  'team-double-booked': 'error',
  // A persisted booking standing inside a closed window. An error, not an
  // advisory: the two statements cannot both be honoured -- the ground is
  // either shut or played on.
  'field-blackout': 'error',
  // A booking that could not be placed on a calendar at all, so the blackout
  // check could not judge it. An advisory, not an error: nothing is known to
  // clash, and silence would read as "checked, and clean".
  'blackout-unjudged': 'warning',
  'unknown-team': 'warning',
  'unscheduled-matchups': 'warning',
  'shared-slot-imbalance': 'warning',
};

/**
 * Human-readable labels for conflict types.
 */
const TYPE_LABELS = {
  'field-overlap': 'Field Overlap',
  'coach-conflict': 'Coach Conflict',
  'team-double-booked': 'Double-Booked',
  'field-blackout': 'Blackout',
  'blackout-unjudged': 'Not Judged',
  'unknown-team': 'Unknown Team',
  'unscheduled-matchups': 'Unscheduled',
  'shared-slot-imbalance': 'Imbalance',
};

function ConflictItem({ warning, onConflictClick }) {
  const severity = SEVERITY_MAP[warning.type] || 'warning';
  const label = TYPE_LABELS[warning.type] || warning.type;

  return (
    <button
      type="button"
      onClick={() => onConflictClick?.(warning)}
      disabled={!onConflictClick}
      className={`font-mono text-sm bg-bg-glass p-3 rounded-lg border flex items-center justify-between w-full text-left transition-colors ${
        onConflictClick ? 'cursor-pointer hover:bg-bg-surface-hover' : 'cursor-default'
      } ${severity === 'error' ? 'border-status-error/30' : 'border-status-warning/30'}`}
      data-testid={`conflict-item-${warning.type}`}
    >
      <span className="text-text-secondary">{warning.message}</span>
      <span
        className={`text-xs px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ml-3 ${
          severity === 'error'
            ? 'bg-status-error/20 text-status-error'
            : 'bg-status-warning/20 text-status-warning'
        }`}
      >
        {label}
      </span>
    </button>
  );
}

ConflictItem.propTypes = {
  warning: PropTypes.shape({
    type: PropTypes.string.isRequired,
    message: PropTypes.string.isRequired,
    details: PropTypes.object,
  }).isRequired,
  onConflictClick: PropTypes.func,
};

/**
 * GameConflictBanner — displays active scheduling conflicts and warnings.
 *
 * Mirrors the RosterManager conflict banner styling (red glow, ShieldAlert icon).
 * Separates hard conflicts (field-overlap, coach-conflict, team-double-booked) from
 * soft warnings (unscheduled-matchups, shared-slot-imbalance) with expandable sections.
 */
export default function GameConflictBanner({ warnings, onConflictClick = undefined }) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!warnings || warnings.length === 0) return null;

  const hardConflicts = warnings.filter((w) => SEVERITY_MAP[w.type] === 'error');
  const softWarnings = warnings.filter((w) => SEVERITY_MAP[w.type] !== 'error');
  const hardCount = hardConflicts.length;
  const totalCount = warnings.length;

  return (
    <div
      className="bg-status-error-bg text-text-primary p-4 border border-status-error rounded-xl mb-6 flex flex-col gap-2 shadow-[0_0_30px_rgba(239,68,68,0.3)] animate-fadeIn"
      data-testid="game-conflict-banner"
      role="alert"
    >
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between w-full"
      >
        <div className="flex items-center gap-2 font-bold uppercase tracking-widest text-status-error">
          <ShieldAlert size={20} />
          {hardCount > 0
            ? `${hardCount} Conflict${hardCount !== 1 ? 's' : ''} Detected`
            : `${totalCount} Warning${totalCount !== 1 ? 's' : ''}`}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted font-normal normal-case tracking-normal">
            {totalCount} total issue{totalCount !== 1 ? 's' : ''}
          </span>
          {isExpanded ? (
            <ChevronUp size={16} className="text-text-muted" />
          ) : (
            <ChevronDown size={16} className="text-text-muted" />
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="flex flex-col gap-2 mt-1" data-testid="conflict-list">
          {hardConflicts.map((w, i) => (
            <ConflictItem key={`hard-${i}`} warning={w} onConflictClick={onConflictClick} />
          ))}
          {softWarnings.map((w, i) => (
            <ConflictItem key={`soft-${i}`} warning={w} onConflictClick={onConflictClick} />
          ))}
        </div>
      )}
    </div>
  );
}

GameConflictBanner.propTypes = {
  warnings: PropTypes.arrayOf(
    PropTypes.shape({
      type: PropTypes.string.isRequired,
      message: PropTypes.string.isRequired,
      details: PropTypes.object,
    })
  ),
  onConflictClick: PropTypes.func,
};
