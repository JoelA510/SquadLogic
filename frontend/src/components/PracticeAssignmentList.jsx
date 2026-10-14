import React from 'react';
import { Lock, Trash2, Unlock } from 'lucide-react';

export default function PracticeAssignmentList({
  assignments = [],
  onToggleLock = undefined,
  onCancelAssignment = undefined,
  loading = false,
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="text-text-secondary animate-pulse">Loading assignments...</div>
      </div>
    );
  }

  if (assignments.length === 0) {
    return (
      <div className="bg-bg-surface border border-dashed border-border-subtle rounded-xl p-12 text-center text-text-muted italic">
        No practice assignments found for this run.
      </div>
    );
  }

  return (
    <div className="glass-panel overflow-hidden mt-8">
      <div
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a horizontally scrolling region: focusable so the keyboard can scroll it (WCAG 2.1.1)
        tabIndex={0}
        role="region"
        aria-label="Practice assignments"
        className="overflow-x-auto"
      >
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-bg-app/50 border-b border-border-subtle">
              <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider">
                Team
              </th>
              <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider">
                Field Slot
              </th>
              <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider">
                Range
              </th>
              <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider text-right">
                {onCancelAssignment ? 'Actions' : 'Manual Choice'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle/30">
            {assignments.map((assignment) => {
              const isLocked = assignment.source === 'manual';
              const team = assignment.teams || {};
              const teamName = team.name || 'Unknown Team';
              const division = team.divisions || {};
              const slot = assignment.practiceSlots || {};
              const field = slot.fields || {};
              // Provenance, not a lock (operator ruling 2, plan Q1): every
              // saved practice is locked whatever this says; it records
              // whether the slot was a manual choice (`source`).
              const lockTitle = !onToggleLock
                ? 'Changing the manual-choice mark requires schedule edit permission'
                : isLocked
                  ? 'Mark as automatic'
                  : 'Mark as manual choice';
              const lockActionLabel = !onToggleLock
                ? `Manual choice mark for ${teamName} requires schedule edit permission`
                : `Manual choice: ${teamName}`;

              return (
                <tr key={assignment.id} className="hover:bg-bg-glass transition-colors group">
                  <td className="p-4">
                    <div className="font-bold text-text-primary">{teamName}</div>
                    <div className="text-xs text-text-secondary">
                      {division.name || 'Unknown Division'}
                    </div>
                  </td>
                  <td className="p-4 font-mono text-sm capitalize">
                    <span className="text-text-accent">
                      {slot.dayOfWeek} @ {slot.startTime?.substring(0, 5)} -{' '}
                      {slot.endTime?.substring(0, 5)}
                    </span>
                    <div className="text-[10px] text-text-muted mt-0.5 uppercase tracking-tighter">
                      {field.name || 'Unknown Field'}
                    </div>
                  </td>
                  <td className="p-4 text-text-secondary text-xs">
                    {assignment.effectiveDateRange || 'Full Season'}
                  </td>
                  <td className="p-4 text-right">
                    <div className="inline-flex items-center gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => onToggleLock?.(assignment.id, isLocked ? 'auto' : 'manual')}
                        disabled={!onToggleLock}
                        aria-label={lockActionLabel}
                        aria-pressed={isLocked}
                        className={`p-2 rounded-lg transition-all inline-flex border ${
                          isLocked
                            ? 'bg-amber-500/10 text-amber-500 border-amber-500/30 hover:bg-amber-500/20 shadow-[0_0_10px_rgba(245,158,11,0.1)]'
                            : 'bg-bg-app text-text-muted border-border-subtle hover:text-brand-400 hover:border-brand-400/50'
                        } ${!onToggleLock ? 'cursor-not-allowed opacity-60' : ''}`}
                        title={lockTitle}
                      >
                        {isLocked ? (
                          <Lock size={16} aria-hidden="true" />
                        ) : (
                          <Unlock size={16} aria-hidden="true" />
                        )}
                      </button>
                      {onCancelAssignment && assignment.persisted && (
                        <button
                          type="button"
                          className="p-2 rounded-lg border border-border-subtle bg-bg-app text-text-muted hover:text-red-400 hover:border-red-400/50 hover:bg-red-500/10 transition-all"
                          aria-label={`Cancel practice for ${teamName}`}
                          onClick={() => onCancelAssignment(assignment)}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
