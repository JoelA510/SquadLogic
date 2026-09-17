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
import { requireZonedInstant } from '@squadlogic/core/timing/index.js';
import {
  describeTimingFindings,
  describeUnplaceableSlots,
  isSeasonClockLoading,
} from '../utils/seasonClockSlots.js';
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

/**
 * Compose a `practice_slots` wall reading onto the season's clock.
 *
 * ## LIVE-7
 *
 * This returned `` `${date}T${time}` `` -- a naive wall reading with no zone --
 * and those strings were shipped to the `auto-scheduler` Edge Function, which
 * did `new Date(s.start)` on them. That is the **host's** zone, and the
 * Supabase edge runtime is UTC, so every practice instant was a function of
 * where the code ran rather than of the season. The request even carried
 * `timezone`; the function contained zero occurrences of the string.
 *
 * Identical to `buildDateTime` in `GameSchedulingPage.jsx`, deliberately: the
 * two pages compose the same kind of value and the twin-arm shape -- a fix
 * landing on one and not its sibling -- is what this codebase keeps paying for.
 * Both call `requireZonedInstant`, which throws a `SeasonClockError` carrying a
 * reason code rather than inventing an instant.
 *
 * @param {string|null|undefined} date - `YYYY-MM-DD`
 * @param {string|null|undefined} time - `HH:MM[:SS]`
 * @param {string|null|undefined} timezone - the season's IANA zone
 * @returns {string|null} an ISO instant carrying the season's offset, or `null`
 *   when there is no wall reading to compose.
 * @throws {import('@squadlogic/core/timing/index.js').SeasonClockError} when a
 *   wall reading exists but cannot be placed.
 */
function buildDateTime(date, time, timezone) {
  if (!date || !time) return null;
  return requireZonedInstant({ date, time, timeZone: timezone, label: 'practice slot time' });
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

/**
 * The season-local calendar date a slot row actually falls on.
 *
 * The same two steps `normalizePracticeSlot` takes before it composes, so a
 * refusal and the banner that reports it name the same day. Returns `null`
 * rather than guessing when the row has no effective start at all.
 *
 * @param {Record<string, any>} row
 * @param {Record<string, any>|null|undefined} seasonSetting
 * @returns {string|null} `YYYY-MM-DD`
 */
function slotDateOf(row, seasonSetting) {
  const effectiveFrom =
    row?.valid_from ?? row?.validFrom ?? getSeasonDateRange(seasonSetting).start ?? null;
  if (!effectiveFrom) return null;
  return getSlotDateForDay(effectiveFrom, normalizeDay(row?.day_of_week ?? row?.dayOfWeek));
}

/**
 * @param {Record<string, any>} row
 * @param {Record<string, any>|null|undefined} seasonSetting
 * @param {string|null|undefined} timezone - the season's IANA zone. A parameter
 *   rather than a lookup off `seasonSetting`, so the one caller decides where
 *   the clock comes from and a per-venue override would be a call-site change.
 */
function normalizePracticeSlot(row, seasonSetting, timezone) {
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
    start: buildDateTime(slotDate, startTime, timezone),
    end: buildDateTime(slotDate, endTime, timezone),
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

/**
 * Split `practice_slots` rows into the ones that can be placed on a clock and
 * the ones that cannot.
 *
 * **Per row, never per page.** The page used to wrap the whole `map` in one
 * try/catch, so a single slot that could not be read returned no slots at all
 * and the operator lost four hundred good ones behind one bad one -- CLAUDE.md
 * §3's "never silently drop an unplaceable fixture" inverted into dropping
 * every placeable one. Putting `buildDateTime` on the season clock is what
 * makes that matter: a DST spring-forward slot now refuses where it used to
 * compose a naive string, so the per-page catch would have turned a
 * one-slot problem into a dead page.
 *
 * `GameSchedulingPage.partitionGameSlots` reached this shape first and this is
 * that contract, not a second one -- same entry fields, same `code`-is-the-
 * contract rule, same `SLOT_SHAPE_INVALID` fallback for the pre-existing shape
 * throws that carry no reason code.
 *
 * The season-wide case still blocks, and blocks by arithmetic rather than by a
 * special rule: a season with no timezone has no clock for *any* slot, so every
 * row lands in `unplaceableSlots`, `schedulerSlots` is empty, and the page's
 * existing `!schedulerSlots.length` guard disables the scheduler.
 *
 * Exported and pure so the partition can be tested without a render.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {{ seasonSetting: Record<string, any>|null|undefined, timezone: string|null|undefined }} reference
 * @returns {{ schedulerSlots: Array<Object>, slotById: Map<any, Object>, unplaceableSlots: Array<Object> }}
 */
export function partitionPracticeSlots(rows, { seasonSetting, timezone }) {
  const schedulerSlots = [];
  const unplaceableSlots = [];
  for (const row of rows ?? []) {
    try {
      schedulerSlots.push(normalizePracticeSlot(row, seasonSetting, timezone));
    } catch (err) {
      unplaceableSlots.push({
        id: row?.id ?? null,
        // **The date that failed, not the row's `valid_from`.**
        // `normalizePracticeSlot` shifts `valid_from` forward to the slot's
        // weekday before composing, so a DST-gap Sunday slot with
        // `valid_from = 2026-03-01` refuses about 2026-03-08 -- and naming
        // 2026-03-01 in the banner points the operator at a date on which
        // nothing is wrong. Recomputed with the same helper the throwing call
        // used, so the two cannot disagree; `null` when even that is unknown.
        date: slotDateOf(row, seasonSetting),
        time: normalizeTime(row?.start_time ?? row?.startTime),
        code: err?.code ?? 'SLOT_SHAPE_INVALID',
        reason: err?.message ?? 'Practice slot could not be read.',
      });
    }
  }
  return {
    schedulerSlots,
    slotById: new Map(schedulerSlots.map((slot) => [slot.id, slot])),
    unplaceableSlots,
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
  const {
    currentOrganization,
    currentSeasonSetting,
    permissions = [],
    loading: organizationLoading,
    seasonSettingsLoading,
  } = useOrganization();

  // The season's clock. Declared here rather than beside the other scheduler
  // inputs below because `normalizePracticeSlot` needs it, and that runs before
  // them. The season has one timezone, not the venue -- the ruling GAP-30 made.
  const timezone = currentSeasonSetting?.timezone ?? undefined;
  // **"No clock yet" and "no clock at all" are different facts.** The practice
  // slot read below is keyed only on `currentOrganization?.id`, so the season
  // row and the slots resolve in whichever order the network gives them; on the
  // losing order every slot is unplaceable with `SEASON_TIMEZONE_MISSING` and
  // the operator is told to set a timezone the season already has.
  const seasonClockLoading = isSeasonClockLoading({
    organizationLoading,
    seasonSettingsLoading,
    currentOrganization,
    currentSeasonSetting,
  });

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

  const { schedulerSlots, slotById, unplaceableSlots } = useMemo(
    () =>
      partitionPracticeSlots(practiceSlotRows, { seasonSetting: currentSeasonSetting, timezone }),
    [currentSeasonSetting, practiceSlotRows, timezone]
  );

  // Held back until the season row has landed: before then every entry says
  // `SEASON_TIMEZONE_MISSING` about a season whose clock nobody has read yet,
  // and printing that tells the operator to set a timezone the season may
  // already have. `isSeasonClockLoading` states the three ways that happens.
  const unplaceableSlotMessage = useMemo(
    () => (seasonClockLoading ? null : describeUnplaceableSlots(unplaceableSlots)),
    [seasonClockLoading, unplaceableSlots]
  );

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

  // **Unplaceable slots no longer disable the scheduler by themselves.** They
  // used to (`Boolean(slotShapeError)`), back when one unreadable row emptied
  // the whole list; now a refusal is per row, so blocking on one would cost the
  // operator the other four hundred. The season-wide case still blocks, and
  // blocks by arithmetic rather than by a special rule: a season with no
  // timezone has no clock for any slot, so `schedulerSlots` is empty and the
  // `!schedulerSlots.length` arm fires. That is `GameSchedulingPage`'s
  // contract, not a second one.
  const schedulerDisabled =
    dashboardLoading.practice ||
    practiceSlotsLoading ||
    seasonClockLoading ||
    isColdStart ||
    !schedulerSlots.length ||
    !canManageSchedule;

  /**
   * **"No slots" is a claim, and it was being made when it was false.**
   *
   * Two arms guard it, both taken from `composeSchedulerReadinessMessage` in
   * `GameSchedulingPage.jsx`:
   *
   * - While the season row is in flight, `seasonClockLoading` suppresses
   *   `unplaceableSlotMessage` -- correctly, since every entry would say
   *   `SEASON_TIMEZONE_MISSING` about a clock nobody has read yet -- but
   *   `schedulerSlots` is empty for the same reason, so the third arm fired
   *   and the operator was told there are no practice slots. There are; they
   *   have not been placed yet.
   * - Once it has landed, slots refused for a real reason are reported BY
   *   that reason. Saying "no slots are available" alongside "3 slots shown as
   *   TIME TBD" is two answers to one question, and the unhelpful one is the
   *   one that reads like a data problem.
   */
  /**
   * The Edge Function's non-blocking timing advisories, bucketed by **code**.
   *
   * Bucketed for the reason everything else in this change is: each finding's
   * `message` embeds that slot's own date and time, so one line per finding is
   * one line per slot, and the case that produces them at scale is a whole
   * season of practices on a fall-back night.
   */
  const timingFindingMessage = useMemo(
    () => describeTimingFindings(autoScheduler.result?.timingFindings),
    [autoScheduler.result]
  );

  const schedulerReadinessMessage =
    practiceSlotsError ||
    (seasonClockLoading ? "Loading this season's settings…" : null) ||
    unplaceableSlotMessage ||
    (!practiceSlotsLoading && !schedulerSlots.length && !isColdStart && !unplaceableSlots.length
      ? 'No practice slots are available for this organization.'
      : null);

  const handleAutoGenerate = useCallback(async () => {
    if (!canManageSchedule || schedulerDisabled) return;

    setReviewAssignments(null);
    setReviewedSchedulerRunId(null);
    setApplyStatus('idle');
    setApplyError(null);
    setStatusMessage(null);

    // `timezone` is deliberately NOT sent. It used to be, and
    // `auto-scheduler/index.ts` contained zero occurrences of the string
    // (LIVE-7). The function now reads `season_settings.timezone` itself, which
    // makes the value authoritative as well as read; sending it too would be a
    // second answer to the same question. What goes over the wire is
    // `schedulerSlots`, whose `start`/`end` are already instants on that clock.
    await autoScheduler.trigger({
      teams: schedulerTeams,
      slots: schedulerSlots,
      lockedAssignments,
      scoringWeights: {},
      schoolDayEnd,
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

          {/*
            Its own line, not appended to the readiness sentence: the run
            succeeded, so this is advice rather than a blocker, and appending
            it would make a completed run read like a failed one. `role="status"`
            for the same reason -- polite, not assertive.
          */}
          {timingFindingMessage && (
            <div
              role="status"
              className="mt-4 rounded-lg border border-border-subtle bg-bg-glass px-4 py-3 text-sm text-text-secondary"
            >
              {timingFindingMessage}
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
