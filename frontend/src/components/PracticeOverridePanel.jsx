import React, { useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { AlertCircle, Plus, Check } from 'lucide-react';
import Button from './ui/Button.jsx';
import { coachKeysByTeamId, coachLabel, sharedCoachNames } from '../utils/teamCoaches.js';

/**
 * How to name the coaches two teams share, in a sentence.
 *
 * The panel's own team rows carry ids and no names, so this has to read
 * correctly with no names at all — the first draft produced "Coach 1 coach(es)
 * (names not loaded) is already scheduled", which is the shipped path.
 *
 * @param {number} sharedCount
 * @param {string[]} named
 * @returns {string}
 */
function sharedCoachPhrase(sharedCount, named) {
  const plural = sharedCount === 1 ? 'coach' : 'coaches';
  if (named.length === sharedCount && named.length > 0) {
    return `${sharedCount === 1 ? 'Coach' : 'Coaches'} ${named.join(', ')} ${
      sharedCount === 1 ? 'is' : 'are'
    }`;
  }
  if (named.length > 0) {
    return `${named.join(', ')} and ${sharedCount - named.length} other ${
      sharedCount - named.length === 1 ? 'coach' : 'coaches'
    } are`;
  }
  return `${sharedCount} shared ${plural} ${sharedCount === 1 ? 'is' : 'are'}`;
}

function getAssignmentTeamId(assignment) {
  return assignment?.teamId ?? assignment?.team_id ?? assignment?.teams?.id ?? null;
}

function getAssignmentSlotId(assignment) {
  return (
    assignment?.slotId ??
    assignment?.slot_id ??
    assignment?.practiceSlotId ??
    assignment?.practice_slot_id ??
    assignment?.practiceSlots?.id ??
    null
  );
}

export default function PracticeOverridePanel({
  teams = [],
  baseSlots = [],
  stagedAssignments = [],
  onStageAssignment,
}) {
  const fieldId = useId();
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [selectedSlotId, setSelectedSlotId] = useState('');

  // 8.2: every coach on the team, not `team.headCoach` — a field nothing in
  // this repo produces outside the mock client's seeds, so this check used to
  // return null for every override on real data.
  //
  // Each team's coach keys are derived **once**: deriving them inside the loop
  // meant a `.strict()` Zod parse per team per staged assignment per render.
  const teamById = useMemo(() => new Map(teams.map((team) => [String(team.id), team])), [teams]);
  const coachKeys = useMemo(() => coachKeysByTeamId(teams), [teams]);
  // The picker's labels, once per team list rather than once per team per
  // render: `coachLabel()` is a reconciliation, and it was running in JSX.
  const coachLabels = useMemo(
    () => new Map(teams.map((team) => [String(team.id), coachLabel(team)])),
    [teams]
  );

  const checkForConflict = (teamId, slotId) => {
    const team = teamById.get(String(teamId));
    const keys = coachKeys.get(String(teamId));
    if (!team || !keys || keys.size === 0) return null;

    for (const assignment of stagedAssignments) {
      const stagedTeamId = String(getAssignmentTeamId(assignment));
      if (stagedTeamId === String(teamId)) continue;
      if (getAssignmentSlotId(assignment) !== slotId) continue;
      const otherKeys = coachKeys.get(stagedTeamId);
      if (!otherKeys || ![...otherKeys].some((key) => keys.has(key))) continue;

      const otherTeam = teamById.get(stagedTeamId);
      const sharedCount = [...otherKeys].filter((key) => keys.has(key)).length;
      const named = sharedCoachNames(team, otherTeam);
      return `${sharedCoachPhrase(sharedCount, named)} already scheduled at this time with ${
        otherTeam?.name || 'another team'
      }.`;
    }

    return null;
  };

  const handleAssign = () => {
    if (!selectedTeamId || !selectedSlotId) return;

    onStageAssignment?.(selectedTeamId, selectedSlotId);
    setSelectedTeamId('');
    setSelectedSlotId('');
  };

  const manualStagedAssignments = stagedAssignments
    .filter((assignment) => assignment?.source === 'manual' || assignment?.source === 'locked')
    .map((assignment) => {
      const teamId = getAssignmentTeamId(assignment);
      const slotId = getAssignmentSlotId(assignment);
      return {
        id: assignment.id ?? `${teamId}-${slotId}`,
        teamId,
        slotId,
        conflictWarning: checkForConflict(teamId, slotId),
      };
    });

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 mt-8 shadow-sm">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h3 className="text-xl font-bold text-text-primary mb-1">Manual Practice Overrides</h3>
          <p className="text-sm text-text-secondary">
            Assign specific teams to practice slots, overriding the algorithm.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4 mb-8 p-4 bg-bg-surface-hover border border-border-subtle rounded-lg">
        <div className="flex-1 min-w-[200px]">
          <label
            htmlFor={`${fieldId}-team`}
            className="block text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide"
          >
            Select Team
          </label>
          <select
            id={`${fieldId}-team`}
            data-testid="team-select"
            className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-text-primary focus:border-blue-500 focus:outline-none transition-colors appearance-none"
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
          >
            <option value="">-- Choose Team --</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.division}) - {coachLabels.get(String(t.id))}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 min-w-[200px]">
          <label
            htmlFor={`${fieldId}-slot`}
            className="block text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide"
          >
            Select Practice Slot
          </label>
          <select
            id={`${fieldId}-slot`}
            data-testid="slot-select"
            className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-text-primary focus:border-blue-500 focus:outline-none transition-colors appearance-none"
            value={selectedSlotId}
            onChange={(e) => setSelectedSlotId(e.target.value)}
          >
            <option value="">-- Choose Slot --</option>
            {baseSlots.map((s) => (
              <option key={s.baseSlotId} value={s.baseSlotId}>
                {s.day} @ {s.startLabel ?? s.baseSlotId.split('_').pop().slice(0, 5)} (Avail:{' '}
                {Math.max(0, (s.totalCapacity ?? 0) - (s.totalAssigned ?? 0))})
              </option>
            ))}
          </select>
        </div>

        <Button
          data-testid="assign-slot-button"
          variant="primary"
          onClick={handleAssign}
          disabled={!selectedTeamId || !selectedSlotId}
          className="flex items-center gap-2 h-10"
        >
          <Plus size={16} /> Assign Slot
        </Button>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-text-primary mb-3">Staged Overrides</h4>
        {manualStagedAssignments.length === 0 ? (
          <div className="text-sm text-text-muted italic p-4 text-center border border-dashed border-border-subtle rounded-md">
            No manual overrides created yet.
          </div>
        ) : (
          manualStagedAssignments.map((override) => {
            const team = teams.find((t) => String(t.id) === String(override.teamId));
            const slot = baseSlots.find((s) => s.baseSlotId === override.slotId);

            return (
              <div
                key={override.id}
                className="flex items-start justify-between p-4 bg-bg-surface border border-border-subtle rounded-md"
              >
                <div className="space-y-1 w-full max-w-lg">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-text-primary">{team?.name}</span>
                    <span className="text-text-muted">&rarr;</span>
                    <span className="font-medium text-text-accent">
                      {slot?.day} at {slot?.startLabel ?? slot?.baseSlotId.split('_').pop()}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold bg-amber-500/20 text-status-warning-text border border-amber-500/30">
                      Manual
                    </span>
                  </div>
                  <p className="text-xs text-text-secondary">Division: {team?.division}</p>

                  {override.conflictWarning && (
                    <div className="mt-2 text-xs flex items-center gap-1.5 text-status-warning-text bg-amber-500/10 p-2 rounded border border-amber-500/20">
                      <AlertCircle size={14} className="shrink-0" />
                      <span>Conflict: {override.conflictWarning}</span>
                    </div>
                  )}
                </div>

                <div className="text-status-success-text flex items-center gap-1 text-xs font-semibold">
                  <Check size={14} /> Staged
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

PracticeOverridePanel.propTypes = {
  teams: PropTypes.array,
  baseSlots: PropTypes.array,
  stagedAssignments: PropTypes.array,
  onStageAssignment: PropTypes.func,
};
