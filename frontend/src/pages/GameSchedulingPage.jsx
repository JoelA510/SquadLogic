import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { generateRoundRobinWeeks, scheduleGames } from '@squadlogic/core/gameScheduling.js';
import { evaluateGameSchedule } from '@squadlogic/core/gameMetrics.js';
import { findBlackoutConflicts } from '@squadlogic/core/fieldAdmin/index.js';
import { useDashboardData } from '../hooks/useDashboardData.js';
import { useAutoRunOnNavigate } from '../hooks/useAutoRunOnNavigate.js';
import TeamScheduleView from '../components/TeamScheduleView.jsx';
import AutoSchedulerPanel from '../components/scheduling/AutoSchedulerPanel.jsx';
import GameScheduleGrid from '../components/scheduling/GameScheduleGrid.jsx';
import { GameCardPreview } from '../components/scheduling/GameCard.jsx';
import Button from '../components/ui/Button.jsx';
import ProgressBar from '../components/ui/ProgressBar.jsx';
import {
  Edit2,
  Save,
  Trophy,
  Sparkles,
  CheckCircle,
  RotateCcw,
  XCircle,
  Trash2,
} from 'lucide-react';
import GameReadinessPanel from '../components/GameReadinessPanel.jsx';
import GameConflictBanner from '../components/scheduling/GameConflictBanner.jsx';
import { formatDateTime } from '../utils/formatters.js';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { PERMISSIONS } from '../constants/permissions.js';
import { persistGameScheduleReview } from '../utils/gamePersistenceClient.js';
import { useFieldClosures } from '../hooks/useFieldClosures.js';
import { toBlackoutWarnings, toClosureInputs, toFieldBookings } from '../utils/fieldBookings.js';
import { todayIso } from '../utils/today.js';
import { isFieldOfferableOn, venueOf, venueRegistry } from '../utils/fieldLifecycle.js';

function normalizeAssignmentSource(source) {
  return source === 'manual' || source === 'locked' ? 'manual' : 'auto';
}

function getAssignmentSlotId(assignment) {
  return (
    assignment?.slotId ?? assignment?.slot_id ?? assignment?.gameSlotId ?? assignment?.game_slot_id
  );
}

function getAssignmentHomeTeamId(assignment) {
  return assignment?.homeTeamId ?? assignment?.home_team_id;
}

function getAssignmentAwayTeamId(assignment) {
  return assignment?.awayTeamId ?? assignment?.away_team_id;
}

function getAssignmentFieldId(assignment) {
  return assignment?.fieldId ?? assignment?.field_id ?? null;
}

function getAssignmentWeekIndex(assignment, slot) {
  const value =
    assignment?.weekIndex ?? assignment?.week_index ?? slot?.weekIndex ?? slot?.week_index;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeTeam(team) {
  const id = team?.id ?? team?.teamId;
  if (!id) return null;
  const divisionId = team.divisionId ?? team.division_id ?? null;
  const division =
    team.division ?? team.divisionName ?? team.divisions?.name ?? divisionId ?? 'Unassigned';

  return {
    id,
    name: team.name ?? `Team ${id}`,
    division,
    divisionId,
    coachId: team.coachId ?? team.coach_id ?? team.coach?.id ?? null,
  };
}

function buildDateTime(date, time) {
  if (!date || !time) return null;
  return `${date}T${time}`;
}

function normalizeGameSlot(row, { fieldById, divisionById, timezone }) {
  const field = fieldById.get(row.field_id ?? row.fieldId);
  const division =
    row.divisions?.name ??
    divisionById.get(row.division_id ?? row.divisionId) ??
    row.division ??
    null;
  const start =
    row.start ?? buildDateTime(row.slot_date ?? row.slotDate, row.start_time ?? row.startTime);
  const end = row.end ?? buildDateTime(row.slot_date ?? row.slotDate, row.end_time ?? row.endTime);
  const weekIndex = Number(row.week_index ?? row.weekIndex ?? 1);

  if (!row.id || !start || !end || !Number.isInteger(weekIndex) || weekIndex <= 0) {
    throw new Error('Game slots must include id, start/end, and a positive week index.');
  }

  return {
    ...row,
    id: row.id,
    division,
    weekIndex,
    start,
    end,
    capacity: Math.max(1, Number(row.capacity ?? 1)),
    fieldId: row.field_id ?? row.fieldId ?? null,
    fieldName: field?.name ?? row.fieldName ?? null,
    priority: Number(field?.priority_rating ?? field?.priority ?? row.priority ?? 1),
    label: formatDateTime(start, timezone),
  };
}

function buildRoundRobinByDivision(teams) {
  const teamsByDivision = new Map();
  for (const team of teams) {
    const bucket = teamsByDivision.get(team.division) ?? [];
    bucket.push(team.id);
    teamsByDivision.set(team.division, bucket);
  }

  /** @type {Record<string, ReturnType<typeof generateRoundRobinWeeks>>} */
  const roundRobinByDivision = {};
  for (const [division, teamIds] of teamsByDivision.entries()) {
    if (teamIds.length >= 2) {
      roundRobinByDivision[division] = generateRoundRobinWeeks({ teamIds });
    }
  }
  return roundRobinByDivision;
}

function formatUnscheduledMatchup(entry) {
  return `${entry.matchup?.homeTeamId ?? 'Home'} vs ${entry.matchup?.awayTeamId ?? 'Away'}`;
}

function summarizeGameResult({ assignments, byes, unscheduled }) {
  const totalMatchups = assignments.length + unscheduled.length;
  return {
    totalGames: assignments.length,
    scheduledRate: totalMatchups > 0 ? assignments.length / totalMatchups : 0,
    unscheduledMatchups: unscheduled.length,
    teamsWithByes: byes.length,
  };
}

function buildDisplayAssignment({ assignment, index, runId, teamById, slotById, fieldById }) {
  const slotId = getAssignmentSlotId(assignment);
  const slot = slotById.get(slotId);
  const homeTeamId = getAssignmentHomeTeamId(assignment);
  const awayTeamId = getAssignmentAwayTeamId(assignment);
  const homeTeam = teamById.get(homeTeamId);
  const awayTeam = teamById.get(awayTeamId);
  const fieldId = getAssignmentFieldId(assignment) ?? slot?.fieldId ?? null;
  const field = fieldById.get(fieldId);
  const start = assignment.start ?? assignment.kickoff ?? slot?.start ?? null;
  const end = assignment.end ?? slot?.end ?? null;
  const weekIndex = getAssignmentWeekIndex(assignment, slot);

  return {
    ...assignment,
    id:
      assignment.id ??
      `${runId ?? 'review'}-${homeTeamId ?? 'home'}-${awayTeamId ?? 'away'}-${slotId ?? 'slot'}-${weekIndex}-${index}`,
    // Synthetic ids (built above) don't exist in the DB, so row-level
    // mutations like cancel must be hidden for them.
    persisted: Boolean(assignment.id),
    runId: runId ?? assignment.runId ?? assignment.run_id ?? null,
    division: assignment.division ?? homeTeam?.division ?? slot?.division ?? 'Unassigned',
    weekIndex,
    slotId,
    gameSlotId: assignment.gameSlotId ?? assignment.game_slot_id ?? slotId,
    fieldId,
    fieldName: assignment.fieldName ?? field?.name ?? slot?.fieldName ?? null,
    homeTeamId,
    awayTeamId,
    homeTeamName: assignment.homeTeamName ?? homeTeam?.name ?? homeTeamId,
    awayTeamName: assignment.awayTeamName ?? awayTeam?.name ?? awayTeamId,
    start,
    end,
    kickoff: assignment.kickoff ?? start,
    assignmentSource: normalizeAssignmentSource(
      assignment.assignmentSource ?? assignment.assignment_source ?? assignment.source
    ),
  };
}

function toPersistenceAssignment(assignment) {
  return {
    division: assignment.division,
    weekIndex: getAssignmentWeekIndex(assignment),
    slotId: getAssignmentSlotId(assignment),
    start: assignment.start,
    end: assignment.end,
    fieldId: getAssignmentFieldId(assignment),
    homeTeamId: getAssignmentHomeTeamId(assignment),
    awayTeamId: getAssignmentAwayTeamId(assignment),
    source: normalizeAssignmentSource(assignment.assignmentSource ?? assignment.source),
  };
}

export default function GameSchedulingPage() {
  const { game, team, loading } = useDashboardData();
  const { currentOrganization, currentSeasonSetting, permissions = [] } = useOrganization();
  const [localAssignments, setLocalAssignments] = useState([]);
  const [reviewAssignments, setReviewAssignments] = useState(null);
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [activeTab, setActiveTab] = useState('full');
  const [schedulerStatus, setSchedulerStatus] = useState('idle');
  const [schedulerProgress, setSchedulerProgress] = useState(null);
  const [schedulerResult, setSchedulerResult] = useState(null);
  const [schedulerError, setSchedulerError] = useState(null);
  const [applyStatus, setApplyStatus] = useState('idle');
  const [applyError, setApplyError] = useState(null);
  const [statusMessage, setStatusMessage] = useState(null);
  const [lastRollbackAssignments, setLastRollbackAssignments] = useState(null);
  const [fields, setFields] = useState([]);
  // **Every field the organisation holds, live or retired.** The scheduler's
  // list above is filtered to live ground; a venue-scoped blackout still has to
  // reach a slot sitting on a retired pitch, and enumerating that ground from
  // the filtered list -- or from the slots themselves -- is the shape
  // CLAUDE.md section 3 names: a subject set derived from the data a break
  // would corrupt.
  const [allFields, setAllFields] = useState([]);
  const { closures: fieldClosures } = useFieldClosures();
  const [gameSlotRows, setGameSlotRows] = useState([]);
  const [referenceError, setReferenceError] = useState(null);
  const [activeGame, setActiveGame] = useState(null);

  const timezone = currentSeasonSetting?.timezone;
  const canManageSchedule =
    permissions.includes(PERMISSIONS.MANAGE_SCHEDULE) ||
    permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION);
  const canEditSchedule = canManageSchedule && isEditMode;
  // Cancelling is destructive and the RPC requires org admin, so the button
  // is gated tighter than general schedule editing.
  const canCancelAssignments = permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION) && isEditMode;

  useEffect(() => {
    setLastRollbackAssignments(null);
  }, [currentOrganization?.id, currentSeasonSetting?.id]);

  useEffect(() => {
    let isMounted = true;

    async function loadGridReferenceData() {
      if (!currentOrganization?.id) {
        setFields([]);
        setAllFields([]);
        setGameSlotRows([]);
        setReferenceError(null);
        return;
      }

      setReferenceError(null);

      try {
        const [
          { data: fieldRows, error: fieldError },
          { data: slotRows, error: slotError },
          { data: venueRows, error: venueError },
        ] = await Promise.all([
          // **No `.eq('active', true)` any more.** `fields.active` is a
          // WRITE-TIME CACHE of `effective_to`, not a continuously true
          // derivation: 20260906000000's trigger fires on write and reads
          // `current_date`, so a field retired with a FUTURE date keeps
          // `active = true` until something writes the row again. Filtering
          // on the column alone therefore kept formally retired ground in the
          // scheduler's list on and after the day the retirement took effect
          // -- which is exactly the guarantee 8.4's retire path exists to
          // make. The migration's own header names repointing this read as PR
          // 3's work. `isLiveOn()` is the reading `field_is_live_on` gives in
          // SQL; `active` is still honoured, because it also means
          // "deactivated" for every field deactivated before dating existed.
          supabase.from('fields').select('*').eq('organization_id', currentOrganization.id),
          supabase
            .from('game_slots')
            .select('*, divisions(id, name)')
            .eq('organization_id', currentOrganization.id)
            .order('week_index', { ascending: true })
            .order('start', { ascending: true }),
          // **The venues, because a pitch at a closed site is closed.**
          // 20260911000000 retires a venue by writing one date on one row
          // and copying nothing down, so the containment half of
          // `isFieldOfferableOn` has to be read from here. Loading the
          // fields alone and passing `null` would report every pitch
          // unoffered; not loading them at all no longer compiles, because
          // the third argument throws on `undefined`.
          supabase
            .from('locations')
            .select('id, effective_to')
            .eq('organization_id', currentOrganization.id),
        ]);

        if (!isMounted) return;
        if (fieldError) throw fieldError;
        if (slotError) throw slotError;
        // **A failed venue read is an ERROR, not an empty registry.** The 8.4
        // PR 3 review found `useFields().error` being dropped, which left a
        // clean-looking grid on a failed read; swallowing this one would hide
        // every pitch instead, which looks different and is the same defect.
        if (venueError) throw venueError;

        setAllFields(fieldRows ?? []);
        // The two halves of "may the scheduler still offer this" live in one
        // testable producer, because the reading is the point of the change and
        // an inline predicate on a 1000-line page is a reading nothing can pin.
        const asOf = todayIso();
        const venues = venueRegistry(venueRows ?? []);
        setFields(
          (fieldRows ?? []).filter((row) => isFieldOfferableOn(row, asOf, venueOf(row, venues)))
        );
        setGameSlotRows(slotRows ?? []);
      } catch (err) {
        if (!isMounted) return;
        setFields([]);
        setAllFields([]);
        setGameSlotRows([]);
        setReferenceError(err.message || 'Game schedule reference data could not be loaded.');
      }
    }

    loadGridReferenceData();

    return () => {
      isMounted = false;
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
    return map;
  }, [schedulerTeams]);

  const divisionById = useMemo(() => {
    const map = new Map();
    for (const entry of team?.divisions ?? []) {
      if (entry.id) {
        map.set(entry.id, entry.name ?? entry.division ?? entry.id);
      }
    }
    for (const entry of schedulerTeams) {
      if (entry.divisionId && entry.division) {
        map.set(entry.divisionId, entry.division);
      }
    }
    return map;
  }, [schedulerTeams, team?.divisions]);

  const fieldById = useMemo(() => new Map(fields.map((field) => [field.id, field])), [fields]);

  const { gameSlots, slotById, slotShapeError } = useMemo(() => {
    try {
      const normalized = gameSlotRows.map((row) =>
        normalizeGameSlot({ ...row }, { fieldById, divisionById, timezone })
      );
      return {
        gameSlots: normalized,
        slotById: new Map(normalized.map((slot) => [slot.id, slot])),
        slotShapeError: null,
      };
    } catch (err) {
      return {
        gameSlots: [],
        slotById: new Map(),
        slotShapeError: err.message,
      };
    }
  }, [divisionById, fieldById, gameSlotRows, timezone]);

  useEffect(() => {
    const nextAssignments = (game?.assignments ?? []).map((assignment, index) =>
      buildDisplayAssignment({
        assignment,
        index,
        runId: game?.runId,
        teamById,
        slotById,
        fieldById,
      })
    );
    setLocalAssignments(nextAssignments);
  }, [fieldById, game?.assignments, game?.generatedAt, game?.runId, slotById, teamById]);

  const displayedAssignments = reviewAssignments ?? localAssignments;
  const isReviewing = Boolean(reviewAssignments);
  const displayedAssignmentsRef = useRef(displayedAssignments);

  useEffect(() => {
    displayedAssignmentsRef.current = displayedAssignments;
  }, [displayedAssignments]);

  /**
   * Blackout conflicts, merged into the same banner the scheduler's own
   * warnings use.
   *
   * 8.4's acceptance criterion is that a blackout added through the UI makes
   * the affected games show as conflicts and removing it clears them. This is
   * where "show as conflicts" happens for games: the reading is
   * `findBlackoutConflicts()` over `public.field_closures` and the slots this
   * page already holds, and it does not need a scheduler run -- a persisted
   * slot inside a closure is wrong whether or not anything was generated today.
   */
  const blackoutWarnings = useMemo(() => {
    const { dated, recurring, unreadable } = toFieldBookings({ gameSlots: gameSlotRows });
    const { findings } = findBlackoutConflicts({
      closures: toClosureInputs(fieldClosures),
      fields: allFields.map((row) => ({
        id: String(row.id),
        locationId: row.location_id ? String(row.location_id) : null,
      })),
      dated,
      recurring,
    });
    // `unreadable` is carried, not dropped: a slot nothing could place produces
    // no conflict, and a banner that says nothing about it reads as clean.
    return toBlackoutWarnings(findings, unreadable);
  }, [fieldClosures, allFields, gameSlotRows]);

  const conflictSet = useMemo(() => {
    const ids = new Set();
    (game?.warnings ?? []).forEach((warning) => {
      (warning.details?.conflicts ?? []).forEach((assignment) => {
        if (assignment?.id) ids.add(assignment.id);
      });
    });
    return ids;
  }, [game?.warnings]);

  const schedulerDisabled =
    loading.game ||
    !canManageSchedule ||
    schedulerStatus === 'running' ||
    !schedulerTeams.length ||
    !gameSlots.length ||
    Boolean(referenceError) ||
    Boolean(slotShapeError);

  const schedulerReadinessMessage =
    referenceError ||
    slotShapeError ||
    (!schedulerTeams.length ? 'No generated teams are available for game scheduling.' : null) ||
    (!gameSlots.length ? 'No game slots are available for this organization.' : null);

  const reviewSnapshot = useMemo(() => {
    const source = schedulerResult?.evaluation;
    if (!source) return game?.snapshot ?? {};
    return {
      ...source,
      generatedAt: schedulerResult.generatedAt,
      unscheduled: (schedulerResult.unscheduled ?? []).map((entry) => ({
        ...entry,
        matchup: formatUnscheduledMatchup(entry),
      })),
    };
  }, [game?.snapshot, schedulerResult]);

  const reviewSummary = useMemo(
    () =>
      schedulerResult?.summary ??
      game?.summary ?? { scheduledRate: 0, unscheduledMatchups: 0, teamsWithByes: 0 },
    [game?.summary, schedulerResult]
  );

  const handleAutoGenerate = useCallback(async () => {
    if (schedulerDisabled) return;

    setSchedulerStatus('running');
    setSchedulerProgress({ iteration: 0, bestScore: 0, elapsedMs: 0 });
    setSchedulerError(null);
    setApplyError(null);
    setStatusMessage(null);
    setReviewAssignments(null);

    await Promise.resolve();

    try {
      const roundRobinByDivision = buildRoundRobinByDivision(schedulerTeams);
      const start = performance.now();
      const result = scheduleGames({
        teams: schedulerTeams,
        slots: gameSlots,
        roundRobinByDivision,
      });
      const evaluation = evaluateGameSchedule({
        assignments: result.assignments,
        teams: schedulerTeams,
        byes: result.byes,
        unscheduled: result.unscheduled,
        sharedSlotUsage: result.sharedSlotUsage,
      });
      const elapsedMs = Math.round(performance.now() - start);
      const summary = summarizeGameResult(result);
      const generatedAt = new Date().toISOString();
      const nextAssignments = result.assignments.map((assignment, index) =>
        buildDisplayAssignment({
          assignment,
          index,
          runId: null,
          teamById,
          slotById,
          fieldById,
        })
      );

      const nextResult = {
        ...result,
        assignments: nextAssignments,
        unassigned: result.unscheduled,
        evaluation,
        summary,
        generatedAt,
        runId: null,
        optimization: {
          seedScore: summary.scheduledRate,
          bestScore: summary.scheduledRate,
          improvement: 0,
          iterations: 1,
          restarts: 0,
          elapsedMs,
          terminationReason: 'deterministic-round-robin',
        },
      };

      setReviewAssignments(nextAssignments);
      setSchedulerResult(nextResult);
      setSchedulerProgress({
        iteration: 1,
        bestScore: summary.scheduledRate,
        elapsedMs,
      });
      setSchedulerStatus('completed');
      setApplyStatus('review');
    } catch (err) {
      setSchedulerStatus('failed');
      setSchedulerError(err.message || 'Game schedule generation failed.');
      setApplyStatus('error');
      setApplyError(err.message || 'Game schedule generation failed.');
    }
  }, [fieldById, gameSlots, schedulerDisabled, schedulerTeams, slotById, teamById]);

  // Auto-run when arriving from the dashboard "Run Game Scheduling" button.
  // Fires once the page is ready (teams + slots loaded, permission granted);
  // otherwise the readiness message explains what is missing.
  useAutoRunOnNavigate({
    intentKey: 'autoRunGames',
    ready: !schedulerDisabled,
    onRun: handleAutoGenerate,
  });

  const handleCancelAutoScheduler = useCallback(() => {
    setSchedulerStatus('idle');
    setSchedulerProgress(null);
    setApplyStatus('cancelled');
  }, []);

  const handleResetAutoScheduler = useCallback(() => {
    setSchedulerStatus('idle');
    setSchedulerProgress(null);
    setSchedulerResult(null);
    setSchedulerError(null);
    setReviewAssignments(null);
    setApplyStatus('idle');
    setApplyError(null);
    setStatusMessage(null);
  }, []);

  const discardReview = useCallback(() => {
    setReviewAssignments(null);
    setSchedulerResult(null);
    setApplyStatus('discarded');
    setApplyError(null);
    setStatusMessage(null);
  }, []);

  const persistReviewedAssignments = useCallback(
    async ({ assignments, generationMode, resultSummary, resultDetails }) => {
      const persistenceAssignments = assignments.map(toPersistenceAssignment);
      const missingSlot = persistenceAssignments.find(
        (assignment) => !assignment.slotId || !slotById.has(assignment.slotId)
      );

      if (assignments.length > 0 && missingSlot) {
        throw new Error('One or more staged games references a game slot that no longer exists.');
      }

      const now = new Date().toISOString();
      const result = await persistGameScheduleReview({
        assignments: persistenceAssignments,
        runMetadata: {
          organizationId: currentOrganization?.id,
          seasonSettingsId: currentSeasonSetting?.id,
          parameters: {
            organizationId: currentOrganization?.id,
            teamCount: schedulerTeams.length,
            slotCount: gameSlots.length,
            generationMode,
          },
          metrics: resultDetails?.optimization ?? {},
          results: {
            summary:
              resultSummary ?? summarizeGameResult({ assignments, byes: [], unscheduled: [] }),
            assignments: persistenceAssignments,
            byes: resultDetails?.byes ?? [],
            unscheduled: resultDetails?.unscheduled ?? [],
            sharedSlotUsage: resultDetails?.sharedSlotUsage ?? [],
            warnings: resultDetails?.evaluation?.warnings ?? [],
          },
          completedAt: now,
        },
      });

      return { result, persistenceAssignments };
    },
    [
      currentOrganization?.id,
      currentSeasonSetting?.id,
      gameSlots.length,
      schedulerTeams.length,
      slotById,
    ]
  );

  const handleApplySchedule = useCallback(async () => {
    if (!canManageSchedule || reviewAssignments == null) return;

    setApplyStatus('applying');
    setApplyError(null);

    try {
      const { result } = await persistReviewedAssignments({
        assignments: reviewAssignments,
        generationMode: 'round-robin',
        resultSummary: schedulerResult?.summary,
        resultDetails: schedulerResult,
      });

      const appliedRunId = result.runId ?? game?.runId ?? null;
      setLastRollbackAssignments(localAssignments);
      setLocalAssignments(
        reviewAssignments.map((assignment) => ({
          ...assignment,
          runId: appliedRunId,
          assignmentSource: normalizeAssignmentSource(assignment.assignmentSource),
        }))
      );
      setReviewAssignments(null);
      setApplyStatus('applied');
      setStatusMessage('Game schedule applied through the persistence workflow.');
    } catch (err) {
      setApplyStatus('error');
      setApplyError(err.message || 'Game schedule changes could not be applied.');
    }
  }, [
    canManageSchedule,
    game?.runId,
    localAssignments,
    persistReviewedAssignments,
    reviewAssignments,
    schedulerResult,
  ]);

  const handleRollbackLastApply = useCallback(async () => {
    if (!canManageSchedule || !lastRollbackAssignments) return;

    setApplyStatus('rollingBack');
    setApplyError(null);

    try {
      const { result } = await persistReviewedAssignments({
        assignments: lastRollbackAssignments,
        generationMode: 'rollback',
        resultSummary: summarizeGameResult({
          assignments: lastRollbackAssignments,
          byes: [],
          unscheduled: [],
        }),
        resultDetails: null,
      });

      const rollbackRunId = result.runId ?? null;
      setLocalAssignments(
        lastRollbackAssignments.map((assignment) => ({
          ...assignment,
          runId: rollbackRunId,
          assignmentSource: normalizeAssignmentSource(assignment.assignmentSource),
        }))
      );
      setLastRollbackAssignments(null);
      setApplyStatus('rolledBack');
      setStatusMessage('Game schedule rolled back through the persistence workflow.');
    } catch (err) {
      setApplyStatus('error');
      setApplyError(err.message || 'Game schedule rollback could not be applied.');
    }
  }, [canManageSchedule, lastRollbackAssignments, persistReviewedAssignments]);

  const handleDragStart = useCallback(
    (event) => {
      if (!canEditSchedule) return;
      const assignment = displayedAssignmentsRef.current.find(
        (a) => String(a.id) === String(event.active.id)
      );
      setActiveGame(assignment ?? null);
    },
    [canEditSchedule]
  );

  const handleDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      setActiveGame(null);
      if (!canEditSchedule) return;
      if (!over?.id) return;

      const [targetFieldId, targetSlotId] = String(over.id).split(':');
      if (!targetFieldId || !targetSlotId) return;

      const targetSlot = gameSlots.find((slot) => String(slot.id) === targetSlotId);
      const sourceAssignments = displayedAssignmentsRef.current;
      const currentAssignment = sourceAssignments.find((assignment) => {
        return String(assignment.id) === String(active.id);
      });
      if (!currentAssignment) return;

      const updatedAssignment = {
        ...currentAssignment,
        fieldId: targetFieldId,
        slotId: targetSlotId,
        gameSlotId: targetSlotId,
        start: targetSlot?.start ?? currentAssignment.start,
        end: targetSlot?.end ?? currentAssignment.end,
        weekIndex: targetSlot?.weekIndex ?? currentAssignment.weekIndex,
        assignmentSource: 'manual',
      };

      const staged = sourceAssignments.map((assignment) =>
        String(assignment.id) === String(active.id) ? updatedAssignment : assignment
      );

      setReviewAssignments(staged);
      setApplyStatus('review');
      setApplyError(null);
      setStatusMessage('Manual game move staged. Apply the schedule to persist it.');
    },
    [canEditSchedule, gameSlots]
  );

  const handleCancelGameAssignment = useCallback(async (assignment) => {
    if (
      !window.confirm(
        `Cancel the game between ${assignment.homeTeamName ?? 'Home'} and ${assignment.awayTeamName ?? 'Away'}? This cannot be undone.`
      )
    )
      return;
    const { error } = await supabase.rpc('admin_cancel_game_assignment', {
      p_assignment_id: assignment.id,
    });
    if (error) {
      window.alert(error.message || 'Cancel failed');
    } else {
      setLocalAssignments((prev) => prev.filter((a) => a.id !== assignment.id));
    }
  }, []);

  if (loading.game && !game) {
    return (
      <div className="p-12 text-center animate-fadeIn">
        <ProgressBar progress={45} label="Loading master game schedule..." />
      </div>
    );
  }

  return (
    <div className="animate-fadeIn space-y-8">
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold text-text-primary mb-2">
            Game Scheduling
          </h1>
          <p className="text-text-muted">
            Generate, review, and apply the master competition schedule.
          </p>
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

      <GameConflictBanner
        warnings={[...(reviewSnapshot?.warnings ?? game?.warnings ?? []), ...blackoutWarnings]}
      />

      {(applyStatus !== 'idle' || statusMessage || applyError || schedulerReadinessMessage) && (
        <section className="glass-panel p-4 border border-border-subtle" aria-live="polite">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 text-sm">
              {applyStatus === 'applied' ? (
                <CheckCircle size={18} className="text-emerald-400 mt-0.5" />
              ) : applyStatus === 'error' ? (
                <XCircle size={18} className="text-red-400 mt-0.5" />
              ) : (
                <RotateCcw size={18} className="text-cyan-400 mt-0.5" />
              )}
              <div>
                <p className="font-semibold text-text-primary">
                  {isReviewing
                    ? `${reviewAssignments.length} game assignment${reviewAssignments.length === 1 ? '' : 's'} staged for review`
                    : applyStatus === 'applied'
                      ? 'Game schedule applied'
                      : applyStatus === 'rolledBack'
                        ? 'Game schedule rolled back'
                        : applyStatus === 'discarded'
                          ? 'Game schedule review discarded'
                          : 'Game schedule workflow'}
                </p>
                <p className={applyError ? 'text-red-300' : 'text-text-muted'}>
                  {applyError ||
                    statusMessage ||
                    schedulerReadinessMessage ||
                    'Review the staged schedule before applying it.'}
                </p>
              </div>
            </div>
            {isReviewing && canManageSchedule && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={discardReview}
                  disabled={applyStatus === 'applying'}
                >
                  Discard Review
                </Button>
                <Button
                  variant="primary"
                  onClick={handleApplySchedule}
                  loading={applyStatus === 'applying'}
                  disabled={applyStatus === 'applying'}
                >
                  Apply Schedule
                </Button>
              </div>
            )}
            {!isReviewing && lastRollbackAssignments && canManageSchedule && (
              <Button
                variant="secondary"
                onClick={handleRollbackLastApply}
                loading={applyStatus === 'rollingBack'}
                disabled={applyStatus === 'rollingBack'}
              >
                Rollback Last Apply
              </Button>
            )}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <div className="bg-bg-glass border border-border-subtle rounded-xl overflow-hidden shadow-md">
            <div className="px-6 py-4 border-b border-border-subtle flex justify-between items-center bg-bg-glass">
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setActiveTab('full')}
                  className={`text-sm font-semibold transition-colors ${
                    activeTab === 'full' ? 'text-blue-400' : 'text-text-muted hover:text-text-muted'
                  }`}
                >
                  Full Schedule
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('team')}
                  className={`text-sm font-semibold transition-colors ${
                    activeTab === 'team' ? 'text-blue-400' : 'text-text-muted hover:text-text-muted'
                  }`}
                >
                  By Team
                </button>
              </div>
            </div>

            <div className="p-0">
              {canEditSchedule ? (
                <div className="p-4 overflow-x-auto">
                  <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                    <GameScheduleGrid
                      assignments={displayedAssignments}
                      fields={fields}
                      timeSlots={gameSlots}
                      conflictSet={conflictSet}
                      activeGameId={activeGame?.id}
                      timezone={timezone}
                    />
                    <DragOverlay>
                      {activeGame ? <GameCardPreview assignment={activeGame} /> : null}
                    </DragOverlay>
                  </DndContext>
                </div>
              ) : activeTab === 'full' ? (
                <GameScheduleList
                  assignments={displayedAssignments}
                  timezone={timezone}
                  onEditSchedule={canManageSchedule ? handleAutoGenerate : undefined}
                  onCancelAssignment={canCancelAssignments ? handleCancelGameAssignment : undefined}
                />
              ) : (
                <TeamScheduleSelector
                  assignments={displayedAssignments}
                  selectedTeamId={selectedTeamId}
                  onSelectTeam={setSelectedTeamId}
                  onEditSchedule={canManageSchedule ? handleAutoGenerate : undefined}
                  timezone={timezone}
                />
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-1 space-y-6">
          <AutoSchedulerPanel
            title="Game Auto-Scheduler"
            description="Generate round-robin matchups from current teams and game slots"
            runningLabel="Building game schedule..."
            assignedLabel="Games"
            unassignedLabel="Unscheduled"
            status={schedulerStatus}
            progress={schedulerProgress}
            result={schedulerResult}
            error={schedulerError}
            onTrigger={handleAutoGenerate}
            onCancel={handleCancelAutoScheduler}
            onReset={handleResetAutoScheduler}
            disabled={schedulerDisabled}
          />

          <GameReadinessPanel
            gameReadinessSnapshot={reviewSnapshot ?? {}}
            gameSummary={reviewSummary}
            generatedAt={schedulerResult?.generatedAt ?? game?.generatedAt}
            timezone={timezone}
          />
        </div>
      </div>
    </div>
  );
}

function GameScheduleList({ assignments, timezone, onEditSchedule, onCancelAssignment }) {
  if (!assignments || assignments.length === 0) {
    return (
      <div className="glass-panel p-12 text-center animate-fadeIn border-brand-400/20 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
          <Trophy size={120} className="text-brand-400" />
        </div>
        <div className="max-w-md mx-auto relative z-10">
          <h2 className="text-2xl font-display font-bold text-text-primary mb-4">
            No Game Schedule Yet
          </h2>
          <p className="text-text-muted mb-8">
            The game schedule has not been generated for the current season. Run the scheduler on
            the right once teams and field availability are finalized.
          </p>
          {onEditSchedule && (
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button
                variant="primary"
                size="lg"
                className="flex items-center gap-2"
                onClick={onEditSchedule}
              >
                Generate Schedule <Sparkles size={18} />
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse" data-testid="game-schedule-list">
        <thead>
          <tr className="bg-bg-app/50 border-b border-border-subtle">
            <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider">
              Matchup
            </th>
            <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider">
              Field
            </th>
            <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider">
              Kickoff
            </th>
            {onCancelAssignment && (
              <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider text-right">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle/30">
          {assignments.map((a) => (
            <tr
              key={a.id ?? `${a.homeTeamId}-${a.awayTeamId}-${a.slotId}`}
              className="hover:bg-bg-glass"
            >
              <td className="p-4 text-text-primary font-medium">
                {a.homeTeamName ?? a.homeTeamId ?? 'Home'} vs{' '}
                {a.awayTeamName ?? a.awayTeamId ?? 'Away'}
              </td>
              <td className="p-4 text-text-secondary">{a.fieldName ?? a.fieldId ?? '-'}</td>
              <td className="p-4 text-text-secondary">
                {a.kickoff ? formatDateTime(a.kickoff, timezone) : '-'}
              </td>
              {onCancelAssignment && (
                <td className="p-4 text-right">
                  {a.persisted && (
                    <button
                      type="button"
                      className="p-1.5 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      aria-label={`Cancel game ${a.homeTeamName ?? ''} vs ${a.awayTeamName ?? ''}`}
                      onClick={() => onCancelAssignment(a)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamScheduleSelector({
  assignments,
  selectedTeamId,
  onSelectTeam,
  onEditSchedule,
  timezone,
}) {
  const teams = useMemo(() => {
    const teamSet = new Map();
    assignments.forEach((a) => {
      if (a.homeTeamId) teamSet.set(a.homeTeamId, a.homeTeamName ?? a.homeTeamId);
      if (a.awayTeamId) teamSet.set(a.awayTeamId, a.awayTeamName ?? a.awayTeamId);
    });
    return Array.from(teamSet.entries()).map(([id, name]) => ({ id, name }));
  }, [assignments]);

  return (
    <div className="p-6">
      <div className="mb-6">
        <label className="block text-xs font-semibold uppercase tracking-wider text-text-muted mb-2">
          Select Team
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {teams.map((team) => (
            <button
              type="button"
              key={team.id}
              onClick={() => onSelectTeam(team.id)}
              className={`px-3 py-2 rounded text-xs font-medium transition-all ${
                selectedTeamId === team.id
                  ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/20'
                  : 'bg-bg-glass text-text-muted hover:bg-bg-surface-hover'
              }`}
            >
              {team.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8 border-t border-border-subtle pt-8">
        {selectedTeamId ? (
          <TeamScheduleView assignments={assignments} teamId={selectedTeamId} timezone={timezone} />
        ) : assignments.length === 0 ? (
          <div className="glass-panel p-12 text-center animate-fadeIn border-brand-400/20 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
              <Trophy size={120} className="text-brand-400" />
            </div>
            <div className="max-w-md mx-auto relative z-10">
              <h2 className="text-2xl font-display font-bold text-text-primary mb-4">
                No Game Schedule Yet
              </h2>
              <p className="text-text-muted mb-8">
                The game schedule has not been generated for the current season. You can generate a
                new schedule once teams and field availability are finalized.
              </p>
              {onEditSchedule && (
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                  <Button
                    variant="primary"
                    size="lg"
                    className="flex items-center gap-2"
                    onClick={onEditSchedule}
                  >
                    Generate Schedule <Sparkles size={18} />
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center text-text-muted py-8 bg-bg-surface rounded border border-border-subtle border-dashed">
            Select a team to view their schedule
          </div>
        )}
      </div>
    </div>
  );
}
