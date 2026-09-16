import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useDashboardData } from '../hooks/useDashboardData.js';
import PracticeAssignmentList from '../components/PracticeAssignmentList.jsx';
import PracticeOverridePanel from '../components/PracticeOverridePanel.jsx';
import AutoSchedulerPanel from '../components/scheduling/AutoSchedulerPanel.jsx';
import PracticeReadinessPanel from '../components/PracticeReadinessPanel.jsx';
import Button from '../components/ui/Button.jsx';
import { Edit2, Save, Sparkles, Calendar, CheckCircle, RotateCcw } from 'lucide-react';
import EvaluationPanel from '../components/EvaluationPanel.jsx';
import GameConflictBanner from '../components/scheduling/GameConflictBanner.jsx';
import { findBlackoutConflicts } from '@squadlogic/core/fieldAdmin/index.js';
import { useFieldClosures } from '../hooks/useFieldClosures.js';
import { toBlackoutWarnings, toClosureInputs, toFieldBookings } from '../utils/fieldBookings.js';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { PERMISSIONS } from '../constants/permissions.js';
import { useAutoScheduler } from '../hooks/useAutoScheduler.js';
import { useAutoRunOnNavigate } from '../hooks/useAutoRunOnNavigate.js';
import { persistPracticeScheduleReview } from '../utils/practicePersistenceClient.js';

const DAY_LABELS = {
  sun: 'Sunday',
  sunday: 'Sunday',
  mon: 'Monday',
  monday: 'Monday',
  tue: 'Tuesday',
  tuesday: 'Tuesday',
  wed: 'Wednesday',
  wednesday: 'Wednesday',
  thu: 'Thursday',
  thursday: 'Thursday',
  fri: 'Friday',
  friday: 'Friday',
  sat: 'Saturday',
  saturday: 'Saturday',
};

const DAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function normalizeDay(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return DAY_LABELS[normalized] ?? value ?? 'Practice Day';
}

function normalizeTime(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const [hours = '00', minutes = '00', seconds = '00'] = trimmed.split(':');
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`;
}

function buildDateTime(date, time) {
  return `${date}T${time}`;
}

function parseDateOnly(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function getSlotDateForDay(effectiveFrom, day) {
  const baseDate = parseDateOnly(effectiveFrom);
  const dayIndex = DAY_INDEX[String(day ?? '').toLowerCase()];

  if (!baseDate || dayIndex == null) {
    return effectiveFrom;
  }

  const delta = (dayIndex - baseDate.getUTCDay() + 7) % 7;
  baseDate.setUTCDate(baseDate.getUTCDate() + delta);
  return baseDate.toISOString().slice(0, 10);
}

function getSeasonDateRange(seasonSetting) {
  return {
    start: seasonSetting?.season_start ?? seasonSetting?.seasonStart ?? null,
    end: seasonSetting?.season_end ?? seasonSetting?.seasonEnd ?? null,
  };
}

function normalizePracticeSlot(row, seasonSetting) {
  const seasonRange = getSeasonDateRange(seasonSetting);
  const effectiveFrom = row.valid_from ?? row.validFrom ?? seasonRange.start;
  const effectiveUntil = row.valid_until ?? row.validUntil ?? seasonRange.end;
  const startTime = normalizeTime(row.start_time ?? row.startTime);
  const endTime = normalizeTime(row.end_time ?? row.endTime);
  const day = normalizeDay(row.day_of_week ?? row.dayOfWeek);

  if (!row.id || !effectiveFrom || !effectiveUntil || !startTime || !endTime) {
    throw new Error('Practice slots must include an id, time window, and effective date range.');
  }

  const slotDate = getSlotDateForDay(effectiveFrom, day);

  return {
    id: row.id,
    day,
    start: buildDateTime(slotDate, startTime),
    end: buildDateTime(slotDate, endTime),
    startTime,
    endTime,
    capacity: Math.max(1, Number(row.capacity ?? row.slotCapacity ?? 1)),
    effectiveFrom,
    effectiveUntil,
    baseSlotId: row.base_slot_id ?? row.baseSlotId ?? row.id,
    fieldId: row.field_id ?? row.fieldId ?? null,
    fieldSubunitId: row.field_subunit_id ?? row.fieldSubunitId ?? null,
    fieldName: row.fields?.name ?? row.fieldName ?? null,
  };
}

export function normalizeTeam(team) {
  const id = team?.id ?? team?.teamId;
  if (!id) return null;
  const division =
    team.division ??
    team.divisionName ??
    team.division_id ??
    team.divisionId ??
    team.divisions?.name ??
    'Unassigned';

  return {
    id,
    name: team.name ?? `Team ${id}`,
    division,
    coachId: team.coachId ?? team.coach_id ?? team.coach?.id ?? null,
    // The auto-scheduler function reads `assistantCoachIds`; team rows carry either spelling.
    assistantCoachIds: team.assistantCoachIds ?? team.assistant_coach_ids ?? [],
    divisions: team.divisions ?? { name: division },
  };
}

function normalizeAssignmentSource(source) {
  return source === 'manual' || source === 'locked' ? 'manual' : 'auto';
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

function buildDisplayAssignment({ assignment, index, runId, teamById, slotById }) {
  const teamId = getAssignmentTeamId(assignment);
  const slotId = getAssignmentSlotId(assignment);
  const team = teamById.get(teamId) ?? assignment.teams ?? {};
  const slot = slotById.get(slotId);
  const fallbackSlot = assignment.practiceSlots ?? {};
  const fieldName = slot?.fieldName ?? fallbackSlot.fields?.name ?? 'Unknown Field';

  return {
    ...assignment,
    id: assignment.id ?? `${runId ?? 'review'}-${teamId}-${slotId}-${index}`,
    // Synthetic ids (built above) don't exist in the DB, so row-level
    // mutations like cancel must be hidden for them.
    persisted: Boolean(assignment.id),
    runId: runId ?? assignment.runId ?? assignment.run_id ?? null,
    teamId,
    slotId,
    practiceSlotId: slotId,
    source: normalizeAssignmentSource(assignment.source),
    effectiveDateRange:
      assignment.effectiveDateRange ??
      assignment.effective_date_range ??
      (slot ? `[${slot.effectiveFrom},${slot.effectiveUntil}]` : 'Full Season'),
    teams: {
      ...team,
      id: teamId,
      name: team.name ?? 'Unknown Team',
      divisions: team.divisions ?? {
        name: team.division ?? team.divisionName ?? 'Unknown Division',
      },
    },
    practiceSlots: {
      ...fallbackSlot,
      id: slotId,
      dayOfWeek: fallbackSlot.dayOfWeek ?? fallbackSlot.day_of_week ?? slot?.day,
      startTime: fallbackSlot.startTime ?? fallbackSlot.start_time ?? slot?.startTime,
      endTime: fallbackSlot.endTime ?? fallbackSlot.end_time ?? slot?.endTime,
      fields: fallbackSlot.fields ?? {
        id: slot?.fieldId ?? null,
        name: fieldName,
      },
    },
  };
}

function toPersistenceAssignment(assignment) {
  return {
    teamId: getAssignmentTeamId(assignment),
    slotId: getAssignmentSlotId(assignment),
    source: normalizeAssignmentSource(assignment.source),
  };
}

export default function PracticeSchedulingPage() {
  const { practice, team, loading: dashboardLoading } = useDashboardData();
  const { currentOrganization, currentSeasonSetting, permissions = [] } = useOrganization();
  const [assignments, setAssignments] = useState(practice?.assignments ?? []);
  const [reviewAssignments, setReviewAssignments] = useState(null);
  const [practiceSlotRows, setPracticeSlotRows] = useState([]);
  const { closures: fieldClosures } = useFieldClosures();
  const [practiceSlotsLoading, setPracticeSlotsLoading] = useState(false);
  const [practiceSlotsError, setPracticeSlotsError] = useState(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  const [applyStatus, setApplyStatus] = useState('idle');
  const [applyError, setApplyError] = useState(null);
  const [reviewedSchedulerRunId, setReviewedSchedulerRunId] = useState(null);

  const canManageSchedule =
    permissions.includes(PERMISSIONS.MANAGE_SCHEDULE) ||
    permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION);
  const canEditSchedule = canManageSchedule && isEditMode;
  // Cancelling is destructive and the RPC requires org admin, so the button
  // is gated tighter than general schedule editing.
  const canCancelAssignments = permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION) && isEditMode;

  const autoScheduler = useAutoScheduler({ organizationId: currentOrganization?.id });

  useEffect(() => {
    if (practice?.assignments) {
      setAssignments(practice.assignments);
    }
  }, [
    practice.assignments,
    practice?.assignments?.length,
    practice?.snapshot?.lastCalculated,
    practice?.runId,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function fetchPracticeSlots() {
      if (!currentOrganization?.id) {
        setPracticeSlotRows([]);
        setPracticeSlotsError(null);
        return;
      }

      setPracticeSlotsLoading(true);
      setPracticeSlotsError(null);

      try {
        const { data, error } = await supabase
          .from('practice_slots')
          .select(
            `
            id,
            day_of_week,
            start_time,
            end_time,
            capacity,
            valid_from,
            valid_until,
            field_id,
            field_subunit_id,
            fields (
              id,
              name,
              location_id
            )
          `
          )
          .eq('organization_id', currentOrganization.id)
          .order('day_of_week', { ascending: true })
          .order('start_time', { ascending: true });

        if (cancelled) return;
        if (error) throw error;
        setPracticeSlotRows(data ?? []);
      } catch (err) {
        if (cancelled) return;
        setPracticeSlotsError(err.message || 'Practice slots could not be loaded.');
        setPracticeSlotRows([]);
      } finally {
        if (!cancelled) setPracticeSlotsLoading(false);
      }
    }

    fetchPracticeSlots();

    return () => {
      cancelled = true;
    };
  }, [currentOrganization?.id]);

  const schedulerTeams = useMemo(
    () => (team?.teams ?? []).map(normalizeTeam).filter(Boolean),
    [team?.teams]
  );

  const teamById = useMemo(() => {
    const map = new Map();
    for (const entry of schedulerTeams) {
      map.set(entry.id, entry);
    }
    for (const assignment of assignments) {
      const teamId = getAssignmentTeamId(assignment);
      if (teamId && assignment.teams && !map.has(teamId)) {
        map.set(teamId, normalizeTeam({ ...assignment.teams, id: teamId }));
      }
    }
    return map;
  }, [assignments, schedulerTeams]);

  const { schedulerSlots, slotById, slotShapeError } = useMemo(() => {
    try {
      const normalized = practiceSlotRows.map((row) =>
        normalizePracticeSlot(row, currentSeasonSetting)
      );
      return {
        schedulerSlots: normalized,
        slotById: new Map(normalized.map((slot) => [slot.id, slot])),
        slotShapeError: null,
      };
    } catch (err) {
      return {
        schedulerSlots: [],
        slotById: new Map(),
        slotShapeError: err.message,
      };
    }
  }, [currentSeasonSetting, practiceSlotRows]);

  useEffect(() => {
    if (autoScheduler.status !== 'completed' || !autoScheduler.result) return;
    const resultRunId = autoScheduler.result.runId ?? 'latest-auto-scheduler-result';
    if (reviewedSchedulerRunId === resultRunId) return;

    const nextAssignments = (autoScheduler.result.assignments ?? []).map((assignment, index) =>
      buildDisplayAssignment({
        assignment,
        index,
        runId: autoScheduler.result.runId,
        teamById,
        slotById,
      })
    );

    setReviewAssignments(nextAssignments);
    setApplyStatus('review');
    setApplyError(null);
    setStatusMessage(null);
    setReviewedSchedulerRunId(resultRunId);
  }, [autoScheduler.result, autoScheduler.status, reviewedSchedulerRunId, slotById, teamById]);

  const localAssignments = reviewAssignments ?? assignments;
  const isColdStart = !schedulerTeams.length;
  const schoolDayEnd =
    currentSeasonSetting?.school_day_end ?? currentSeasonSetting?.schoolDayEnd ?? undefined;
  const timezone = currentSeasonSetting?.timezone ?? undefined;

  const lockedAssignments = useMemo(
    () =>
      localAssignments
        .map(toPersistenceAssignment)
        .filter(
          (assignment) =>
            assignment.teamId &&
            assignment.slotId &&
            normalizeAssignmentSource(assignment.source) === 'manual'
        ),
    [localAssignments]
  );

  const overrideBaseSlots = useMemo(() => {
    const assignedBySlot = new Map();
    for (const assignment of localAssignments) {
      const slotId = getAssignmentSlotId(assignment);
      if (!slotId) continue;
      assignedBySlot.set(slotId, (assignedBySlot.get(slotId) ?? 0) + 1);
    }

    return schedulerSlots.map((slot) => ({
      baseSlotId: slot.id,
      day: slot.day,
      startLabel: slot.startTime.slice(0, 5),
      totalCapacity: slot.capacity,
      totalAssigned: assignedBySlot.get(slot.id) ?? 0,
    }));
  }, [localAssignments, schedulerSlots]);

  const schedulerDisabled =
    dashboardLoading.practice ||
    practiceSlotsLoading ||
    isColdStart ||
    !schedulerSlots.length ||
    Boolean(slotShapeError) ||
    !canManageSchedule;

  const schedulerReadinessMessage =
    practiceSlotsError ||
    slotShapeError ||
    (!practiceSlotsLoading && !schedulerSlots.length && !isColdStart
      ? 'No practice slots are available for this organization.'
      : null);

  const handleAutoGenerate = useCallback(async () => {
    if (!canManageSchedule || schedulerDisabled) return;

    setReviewAssignments(null);
    setReviewedSchedulerRunId(null);
    setApplyStatus('idle');
    setApplyError(null);
    setStatusMessage(null);

    await autoScheduler.trigger({
      teams: schedulerTeams,
      slots: schedulerSlots,
      lockedAssignments,
      scoringWeights: {},
      schoolDayEnd,
      timezone,
      seasonSettingsId: currentSeasonSetting?.id,
      config: {
        timeBudgetMs: 8000,
        maxIterations: 1000,
        seed: 42,
      },
    });
  }, [
    autoScheduler,
    canManageSchedule,
    currentSeasonSetting?.id,
    lockedAssignments,
    schedulerDisabled,
    schedulerSlots,
    schedulerTeams,
    schoolDayEnd,
    timezone,
  ]);

  // Auto-run when arriving from the dashboard "Run Practice Scheduling" button.
  // Fires once the page is ready (slots loaded, permission granted); otherwise
  // the readiness message explains what is missing.
  useAutoRunOnNavigate({
    intentKey: 'autoRunPractice',
    ready: !schedulerDisabled,
    onRun: handleAutoGenerate,
  });

  const cancelAutoScheduler = useCallback(() => {
    autoScheduler.cancel();
    setReviewAssignments(null);
    setApplyStatus('cancelled');
    setApplyError(null);
  }, [autoScheduler]);

  const resetAutoScheduler = useCallback(() => {
    autoScheduler.reset();
    setReviewAssignments(null);
    setReviewedSchedulerRunId(null);
    setApplyStatus('idle');
    setApplyError(null);
    setStatusMessage(null);
  }, [autoScheduler]);

  const discardReview = useCallback(() => {
    autoScheduler.reset();
    setReviewAssignments(null);
    setReviewedSchedulerRunId(null);
    setApplyStatus('discarded');
    setApplyError(null);
    setStatusMessage(null);
  }, [autoScheduler]);

  const handleApplySchedule = useCallback(async () => {
    if (!canManageSchedule || !reviewAssignments?.length) return;

    const persistenceAssignments = reviewAssignments.map(toPersistenceAssignment);
    const missingSlot = persistenceAssignments.find(
      (assignment) => !slotById.has(assignment.slotId)
    );

    if (missingSlot) {
      setApplyError(
        'One or more staged assignments references a practice slot that no longer exists.'
      );
      setApplyStatus('error');
      return;
    }

    const runId = autoScheduler.result?.runId ?? practice?.runId ?? undefined;
    const now = new Date().toISOString();

    setApplyStatus('applying');
    setApplyError(null);

    try {
      const result = await persistPracticeScheduleReview({
        assignments: persistenceAssignments,
        slots: schedulerSlots,
        runId,
        runMetadata: {
          runId,
          seasonSettingsId: currentSeasonSetting?.id,
          parameters: {
            organizationId: currentOrganization?.id,
            teamCount: schedulerTeams.length,
            slotCount: schedulerSlots.length,
            lockedCount: lockedAssignments.length,
            schoolDayEnd,
            timezone,
          },
          metrics: autoScheduler.result?.optimization ?? {},
          results: {
            assignments: persistenceAssignments,
            unassigned: autoScheduler.result?.unassigned ?? [],
            evaluation: autoScheduler.result?.evaluation ?? null,
            optimization: autoScheduler.result?.optimization ?? null,
          },
          completedAt: now,
        },
      });

      const appliedRunId = result.runId ?? runId ?? null;
      setAssignments(
        reviewAssignments.map((assignment) => ({
          ...assignment,
          runId: appliedRunId,
          source: normalizeAssignmentSource(assignment.source),
        }))
      );
      setReviewAssignments(null);
      setApplyStatus('applied');
      setStatusMessage(null);
    } catch (err) {
      setApplyError(err.message || 'Practice schedule changes could not be applied.');
      setApplyStatus('error');
    }
  }, [
    autoScheduler.result,
    canManageSchedule,
    currentOrganization?.id,
    currentSeasonSetting?.id,
    lockedAssignments.length,
    practice?.runId,
    reviewAssignments,
    schedulerSlots,
    schedulerTeams.length,
    schoolDayEnd,
    slotById,
    timezone,
  ]);

  const handleToggleLock = useCallback(
    (assignmentId, nextSource) => {
      if (!canManageSchedule) return;

      const staged = localAssignments.map((assignment) =>
        assignment.id === assignmentId
          ? { ...assignment, source: normalizeAssignmentSource(nextSource) }
          : assignment
      );

      setReviewAssignments(staged);
      setApplyStatus('review');
      setApplyError(null);
      setStatusMessage('Lock change staged. Apply the schedule to persist it.');
    },
    [canManageSchedule, localAssignments]
  );

  const handleCancelPracticeAssignment = useCallback(async (assignment) => {
    const teamName = assignment.teams?.name ?? 'this team';
    if (!window.confirm(`Cancel the practice assignment for ${teamName}? This cannot be undone.`))
      return;
    const { error } = await supabase.rpc('admin_cancel_practice_assignment', {
      p_assignment_id: assignment.id,
    });
    if (error) {
      window.alert(error.message || 'Cancel failed');
    } else {
      setAssignments((prev) => prev.filter((a) => a.id !== assignment.id));
    }
  }, []);

  const handleStageManualAssignment = useCallback(
    (teamId, slotId) => {
      if (!canManageSchedule) return;

      const nextAssignment = buildDisplayAssignment({
        assignment: {
          id: `staged-${teamId}-${slotId}`,
          teamId,
          slotId,
          source: 'manual',
        },
        index: localAssignments.length,
        runId: autoScheduler.result?.runId ?? practice?.runId ?? null,
        teamById,
        slotById,
      });

      const replaced = localAssignments.some(
        (assignment) => String(getAssignmentTeamId(assignment)) === String(teamId)
      );
      const staged = replaced
        ? localAssignments.map((assignment) =>
            String(getAssignmentTeamId(assignment)) === String(teamId) ? nextAssignment : assignment
          )
        : [...localAssignments, nextAssignment];

      setReviewAssignments(staged);
      setApplyStatus('review');
      setApplyError(null);
      setStatusMessage('Manual override staged. Apply the schedule to persist it.');
    },
    [
      autoScheduler.result?.runId,
      canManageSchedule,
      localAssignments,
      practice?.runId,
      slotById,
      teamById,
    ]
  );

  /**
   * Blackout conflicts for practices -- the other half of 8.4's second
   * acceptance criterion, rendered through the same banner the game page uses
   * rather than a second component that would drift from it.
   *
   * **The ground is enumerated from the slots' own embedded field rows**, not
   * from a separate registry read. That is safe in the direction the rule
   * cares about -- no slot can be missed, because every slot carries its field
   * -- and it is stated because the reverse enumeration would not be. What it
   * cannot do is reach a slot whose field row carries no `location_id` with a
   * VENUE-scoped closure; such a slot is still reached by a field-scoped one.
   */
  const blackoutWarnings = useMemo(() => {
    const { recurring, unreadable } = toFieldBookings({ practiceSlots: practiceSlotRows });
    const fieldRows = [];
    const seen = new Set();
    for (const row of practiceSlotRows) {
      const id = row?.fields?.id ?? row?.field_id;
      if (!id || seen.has(String(id))) continue;
      seen.add(String(id));
      fieldRows.push({
        id: String(id),
        locationId: row?.fields?.location_id ? String(row.fields.location_id) : null,
      });
    }
    const { findings } = findBlackoutConflicts({
      closures: toClosureInputs(fieldClosures),
      fields: fieldRows,
      dated: [],
      recurring,
    });
    return toBlackoutWarnings(findings, unreadable);
  }, [fieldClosures, practiceSlotRows]);

  return (
    <div className="animate-fadeIn space-y-8 max-w-[65ch] mx-auto w-full">
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold text-text-primary mb-2">
            Practice Scheduling
          </h1>
          <p className="text-text-muted">Configure and optimize team field assignments.</p>
        </div>
        {canManageSchedule && (
          <div className="flex gap-3">
            <Button
              variant={canEditSchedule ? 'primary' : 'secondary'}
              onClick={() => setIsEditMode(!isEditMode)}
              className="flex items-center gap-2"
            >
              {canEditSchedule ? <Save size={18} /> : <Edit2 size={18} />}
              {canEditSchedule ? 'Exit Manual Override' : 'Enter Manual Override'}
            </Button>
          </div>
        )}
      </div>

      <GameConflictBanner warnings={blackoutWarnings} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <AutoSchedulerPanel
            status={autoScheduler.status}
            progress={autoScheduler.progress}
            result={autoScheduler.result}
            error={autoScheduler.error}
            onTrigger={handleAutoGenerate}
            onCancel={cancelAutoScheduler}
            onReset={resetAutoScheduler}
            disabled={schedulerDisabled}
          />

          {schedulerReadinessMessage && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
            >
              {schedulerReadinessMessage}
            </div>
          )}

          {applyStatus !== 'idle' && (
            <section
              aria-label="Practice schedule review"
              role="region"
              className="mt-4 rounded-xl border border-border-subtle bg-bg-glass p-4"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-base font-semibold text-text-primary">
                    {applyStatus === 'applied'
                      ? 'Practice Schedule Applied'
                      : applyStatus === 'discarded'
                        ? 'Review Discarded'
                        : applyStatus === 'cancelled'
                          ? 'Optimization Cancelled'
                          : 'Review Practice Changes'}
                  </h3>
                  <p className="mt-1 text-sm text-text-muted">
                    {reviewAssignments?.length
                      ? `${reviewAssignments.length} assignments are staged for persistence.`
                      : 'No practice assignment changes are currently staged.'}
                  </p>
                </div>
                {reviewAssignments?.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleApplySchedule}
                      loading={applyStatus === 'applying'}
                      disabled={applyStatus === 'applying'}
                      className="flex items-center gap-1"
                    >
                      <CheckCircle size={14} aria-hidden="true" />
                      Apply Schedule
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={discardReview}
                      disabled={applyStatus === 'applying'}
                      className="flex items-center gap-1"
                    >
                      <RotateCcw size={14} aria-hidden="true" />
                      Discard Review
                    </Button>
                  </div>
                )}
              </div>
              {applyError && (
                <div role="alert" className="mt-3 text-sm text-red-300">
                  {applyError}
                </div>
              )}
            </section>
          )}

          {isColdStart && (
            <div className="glass-panel p-12 text-center animate-fadeIn border-brand-400/20 relative overflow-hidden">
              <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                <Calendar size={120} className="text-brand-400" />
              </div>
              <div className="max-w-md mx-auto relative z-10">
                <h2 className="text-2xl font-display font-bold text-text-primary mb-4">
                  Ready to Schedule Practices?
                </h2>
                <p className="text-text-muted mb-8">
                  You haven&apos;t generated any teams yet. Practice scheduling requires assigned
                  teams to calculate field availability and distribution.
                </p>
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                  <Button
                    variant="primary"
                    size="lg"
                    className="flex items-center gap-2 mx-auto"
                    onClick={() => (window.location.hash = '#/teaming')}
                  >
                    Go to Team Generation <Sparkles size={18} />
                  </Button>
                </div>
              </div>
            </div>
          )}

          <EvaluationPanel
            practiceData={{
              assignments: localAssignments,
            }}
          />

          <div className="bg-bg-glass border border-border-subtle rounded-xl overflow-hidden shadow-md mt-8">
            {statusMessage && (
              <div
                role="status"
                className="border-b border-blue-400/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-100"
              >
                {statusMessage}
              </div>
            )}
            <PracticeAssignmentList
              assignments={localAssignments}
              onToggleLock={canEditSchedule ? handleToggleLock : undefined}
              onCancelAssignment={canCancelAssignments ? handleCancelPracticeAssignment : undefined}
              loading={dashboardLoading?.practice}
            />
          </div>
          {canEditSchedule && (
            <PracticeOverridePanel
              teams={schedulerTeams}
              baseSlots={overrideBaseSlots}
              stagedAssignments={reviewAssignments ?? []}
              onStageAssignment={handleStageManualAssignment}
            />
          )}
        </div>

        <div className="lg:col-span-1 space-y-6">
          <PracticeReadinessPanel
            practiceReadinessSnapshot={practice?.snapshot || {}}
            dashboardLoading={dashboardLoading || {}}
          />
        </div>
      </div>
    </div>
  );
}
