import React, { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  getFirstCollision,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  buildDivisionRoundRobins,
  savedSides,
  scheduleGames,
} from '@squadlogic/core/gameScheduling.js';
import { evaluateGameSchedule } from '@squadlogic/core/gameMetrics.js';
import { findBlackoutConflicts } from '@squadlogic/core/fieldAdmin/index.js';
import { useDashboardData } from '../hooks/useDashboardData.js';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import { useAutoRunOnNavigate } from '../hooks/useAutoRunOnNavigate.js';
import TeamScheduleView from '../components/TeamScheduleView.jsx';
import AutoSchedulerPanel from '../components/scheduling/AutoSchedulerPanel.jsx';
import GameScheduleGrid from '../components/scheduling/GameScheduleGrid.jsx';
import { GameCardPreview, GameMoveContext } from '../components/scheduling/GameCard.jsx';
import PublishedControls, {
  GamePublishedContext,
} from '../components/scheduling/PublishedSwitch.jsx';
import GamePublishedBar from '../components/scheduling/GamePublishedBar.jsx';
import AllowChangesDialog from '../components/scheduling/AllowChangesDialog.jsx';
import GameHistoryDialog from '../components/scheduling/GameHistoryDialog.jsx';
import AddGameDialog from '../components/scheduling/AddGameDialog.jsx';
import Button from '../components/ui/Button.jsx';
import ProgressBar from '../components/ui/ProgressBar.jsx';
import Tabs from '../components/ui/Tabs.jsx';
import {
  Edit2,
  Save,
  Trophy,
  Sparkles,
  CheckCircle,
  RotateCcw,
  XCircle,
  Trash2,
  Plus,
} from 'lucide-react';
import GameReadinessPanel from '../components/GameReadinessPanel.jsx';
import GameConflictBanner from '../components/scheduling/GameConflictBanner.jsx';
import GameTimeTbdSection from '../components/scheduling/GameTimeTbdList.jsx';
import { formatDateTime } from '../utils/formatters.js';
import {
  SeasonClockError,
  anchorToSeasonClock,
  requireZonedInstant,
} from '@squadlogic/core/timing/index.js';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useSeasonReadOnly } from '../hooks/useSeasonReadOnly.js';
import { useSeasonTeamDirectory } from '../hooks/useSeasonTeamDirectory.js';
import SeasonReadOnlyNote from '../components/chrome/SeasonReadOnlyNote.jsx';
import { PERMISSIONS } from '../constants/permissions.js';
import { persistGameScheduleReview } from '../utils/gamePersistenceClient.js';
import { parseGameUnscheduled } from '@squadlogic/core/scheduleTbd.js';
import { carryGameIds, holdReason, isHeld } from '@squadlogic/core/gameIdentity.js';
import { rekeyReview } from '../utils/gameReviewRekey.js';
import { isUnknownPersistenceOutcome } from '../lib/persistenceRequest.js';
import { useFieldClosures } from '../hooks/useFieldClosures.js';
import { toBlackoutWarnings, toClosureInputs, toFieldBookings } from '../utils/fieldBookings.js';
import { todayIso } from '../utils/today.js';
import { isFieldOfferableOn, venueOf, venueRegistry } from '../utils/fieldLifecycle.js';
import { isSlotOnField, parseCellId } from '../utils/gameGridCells.js';
import { logger } from '../lib/logger.js';
import {
  isUnknownPublishedOutcome,
  readCurrentSavedGameIds,
  setGamesPublished,
} from '../utils/gamePublishedClient.js';
import {
  PUBLISHED_FILTERS,
  describeScope,
  filterByPublishedState,
  leftBehindHistoryGames,
} from '../utils/gamePublishedScope.js';
import {
  cancelRefusal,
  describeSetFailure,
  describeStaleCheckFailure,
  describeStaleSchedule,
  describeSetResult,
  matchupOf,
  leftBehindNote,
  moveRefusal,
  stagedMoveNote,
} from '../utils/gamePublishedText.js';
import {
  addedGameWarningsToSave,
  addedWarningsNotShown,
  describeNewSlot,
  planAddedGame,
  resolveAddedSlots,
  warningsOfAddedGames,
} from '../utils/gameAddByHand.js';

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

/**
 * A team-run team as the game scheduler reads it.
 *
 * `playsGames` is the division's CURRENT `divisions.plays_games` (D2,
 * `docs/changes/2026-10-22-demo-mode.md`), not anything the persisted run
 * carries: the run holds no division settings, so the flag reaches the
 * generator only through `practiceOnly`, which the page builds from its own
 * read of `divisions`. Matched by division id when the id names a division
 * the read returned, else by name among the season's divisions; a division
 * neither finds plays (the column's default).
 *
 * @param {Record<string, any>} team
 * @param {{ ids: Set<string>, names: Set<string>, knownIds?: Set<string> }} [practiceOnly]
 */
export function normalizeTeam(team, practiceOnly = { ids: new Set(), names: new Set() }) {
  const id = team?.id ?? team?.teamId;
  if (!id) return null;
  const divisionId = team.divisionId ?? team.division_id ?? null;
  const division =
    team.division ?? team.divisionName ?? team.divisions?.name ?? divisionId ?? 'Unassigned';
  const isPracticeOnly =
    divisionId !== null &&
    (practiceOnly.knownIds?.has(String(divisionId)) || practiceOnly.ids.has(String(divisionId)))
      ? practiceOnly.ids.has(String(divisionId))
      : practiceOnly.names.has(String(division).trim().toLowerCase());

  return {
    id,
    name: team.name ?? `Team ${id}`,
    division,
    divisionId,
    coachId: team.coachId ?? team.coach_id ?? team.coach?.id ?? null,
    playsGames: !isPracticeOnly,
  };
}

/**
 * The divisions that play no games (D2), from a read of `divisions`: their ids,
 * and their names among the selected season's divisions (a team-run team may
 * carry only its division's name). With no season selected, every division's
 * name counts.
 *
 * @param {Array<{ id?: unknown, name?: unknown, season_settings_id?: unknown, plays_games?: unknown }>} rows
 * @param {string|null|undefined} seasonSettingsId
 */
export function practiceOnlyDivisionsOf(rows, seasonSettingsId) {
  const ids = new Set();
  const names = new Set();
  const knownIds = new Set();
  for (const row of rows ?? []) {
    if (row?.id) knownIds.add(String(row.id));
    if (row?.plays_games !== false) continue;
    if (row.id) ids.add(String(row.id));
    if (!seasonSettingsId || String(row.season_settings_id) === String(seasonSettingsId)) {
      names.add(
        String(row.name ?? '')
          .trim()
          .toLowerCase()
      );
    }
  }
  names.delete('');
  return { ids, names, knownIds };
}

/**
 * Compose a `game_slots` wall reading onto the season's clock.
 *
 * `slot_date` is a `date` and `start_time` is a `time` -- naive wall values with
 * no zone. The result has to be an instant, because `game_assignments.start` is
 * a `timestamptz`. This used to return `` `${date}T${time}` `` and let
 * `new Date()` downstream read it in whatever zone the admin's browser sat in,
 * which persisted the same 4:44 PM slot as three instants eight hours apart.
 *
 * The zone is a parameter rather than a lookup: today it is always the season's
 * (`season_settings.timezone`), and that is the ruling -- the season has one
 * clock, not the venue.
 *
 * @param {string|null|undefined} date - `YYYY-MM-DD`
 * @param {string|null|undefined} time - `HH:MM[:SS]`
 * @param {string|null|undefined} timezone - IANA zone name
 * @returns {string|null} an ISO instant carrying the season's offset, or `null`
 *   when there is no wall reading to compose.
 * @throws {import('@squadlogic/core/timing/index.js').SeasonClockError} when a
 *   wall reading exists but cannot be placed: no season timezone, or a time
 *   daylight saving skips.
 */
export function buildDateTime(date, time, timezone) {
  if (!date || !time) return null;
  return requireZonedInstant({ date, time, timeZone: timezone, label: 'slot time' });
}

/**
 * Place a value that may already be an instant onto the season clock.
 *
 * A zone-carrying value comes back untouched; a naive wall string is composed;
 * a nullish one stays nullish so the caller's `??` chain still reaches the
 * `slot_date` + `start_time` pair.
 *
 * @param {unknown} value
 * @param {string|null|undefined} timezone
 * @returns {string|null|undefined}
 */
function anchorOrThrow(value, timezone) {
  if (value === null || value === undefined) return /** @type {null|undefined} */ (value);
  const { iso, findings } = anchorToSeasonClock(value, timezone);
  if (iso === null && findings.length > 0) {
    throw new SeasonClockError(findings[0].message, findings[0].code, findings);
  }
  return /** @type {string} */ (iso);
}

export function normalizeGameSlot(row, { fieldById, divisionById, timezone }) {
  const field = fieldById.get(row.field_id ?? row.fieldId);
  const division =
    row.divisions?.name ??
    divisionById.get(row.division_id ?? row.divisionId) ??
    row.division ??
    null;
  const slotDate = row.slot_date ?? row.slotDate;
  // A row that already carries an instant keeps it; a naive one still needs the
  // season clock whichever column it arrived in. `anchorOrThrow` keeps that
  // judgement in the core helper instead of a second `includes('Z')` here.
  const start =
    anchorOrThrow(row.start, timezone) ??
    buildDateTime(slotDate, row.start_time ?? row.startTime, timezone);
  const end =
    anchorOrThrow(row.end, timezone) ??
    buildDateTime(slotDate, row.end_time ?? row.endTime, timezone);
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

/**
 * Split `game_slots` rows into the ones that can be placed on a clock and the
 * ones that cannot.
 *
 * **Per row, never per page.** The page used to wrap the whole `map` in one
 * try/catch, so a single slot that could not be placed returned no slots at all
 * and the operator lost 400 good ones behind one bad one's message -- CLAUDE.md
 * §3's "never silently drop an unplaceable fixture" inverted into dropping every
 * placeable one. Unplaceable slots come back carrying their reason code and are
 * **reported** as TIME TBD in the readiness banner, with a count and a cause;
 * the rest schedule. Precisely: no row is rendered for them in the grid -- they
 * are absent from it, and the banner is where they exist. Rendering a
 * placeholder row is a larger change than this one.
 *
 * The season-wide case still blocks, and blocks by arithmetic rather than by a
 * special rule: a season with no timezone has no clock for *any* slot, so every
 * row lands in `unplaceableSlots`, `gameSlots` is empty, and the page's existing
 * `!gameSlots.length` guard disables the scheduler.
 *
 * @param {Array<Object>} rows
 * @param {{ fieldById: Map<any, any>, divisionById: Map<any, any>, timezone: string|null|undefined }} reference
 * @returns {{ gameSlots: Array<Object>, slotById: Map<any, Object>, unplaceableSlots: Array<Object> }}
 */
export function partitionGameSlots(rows, { fieldById, divisionById, timezone }) {
  const gameSlots = [];
  const unplaceableSlots = [];
  for (const row of rows ?? []) {
    try {
      gameSlots.push(normalizeGameSlot({ ...row }, { fieldById, divisionById, timezone }));
    } catch (err) {
      unplaceableSlots.push({
        id: row?.id ?? null,
        date: row?.slot_date ?? row?.slotDate ?? null,
        time: row?.start_time ?? row?.startTime ?? null,
        // `code` is the contract; `SLOT_SHAPE_INVALID` covers the pre-existing
        // shape throws (no id, no week index), which carry no reason code.
        code: err?.code ?? 'SLOT_SHAPE_INVALID',
        reason: err?.message ?? 'Slot could not be read.',
      });
    }
  }
  return {
    gameSlots,
    slotById: new Map(gameSlots.map((slot) => [slot.id, slot])),
    unplaceableSlots,
  };
}

/**
 * `describeUnplaceableSlots`, `isSeasonClockLoading` and the cause table moved
 * to `utils/seasonClockSlots.js` when `PracticeSchedulingPage` came onto the
 * season clock and needed the same three answers (LIVE-7). Re-exported here so
 * this page's existing importers -- including
 * `tests/gameSchedulingSeasonClock.test.js` -- are unchanged, and so there is
 * one place that decides what an operator is told about a slot with no clock.
 */
export {
  UNPLACEABLE_CAUSE,
  UNPLACEABLE_CAUSE_UNKNOWN,
  UNPLACEABLE_EXAMPLES,
  describeUnplaceableSlots,
  isSeasonClockLoading,
} from '../utils/seasonClockSlots.js';
// `export ... from` re-exports without binding the names locally, and this page
// calls both of them below.
import { describeUnplaceableSlots, isSeasonClockLoading } from '../utils/seasonClockSlots.js';

/**
 * The readiness banner's sentence, composed away from React so it can be
 * tested without one.
 *
 * Two things it deliberately does NOT say:
 *
 * 1. **The unplaceable summary.** It used to be appended here *and* rendered on
 *    its own line below, so in the common case -- no apply error, no status
 *    message -- the operator read the same sentence twice. The separate line is
 *    the one that stays, because it survives an `applyStatus` change that
 *    displaces this message entirely.
 * 2. **Anything about the season's clock while the season row is still in
 *    flight.** `currentSeasonSetting` is null both when the season has no
 *    timezone and before `OrganizationContext` has answered, and the slot read
 *    is keyed only on the organisation, so the two land in either order. On the
 *    losing order every slot is unplaceable and the banner told the operator to
 *    set a timezone that was already set. "Not loaded yet" is not "no clock".
 *
 * @param {Object} input
 * @param {string|null} [input.referenceError]
 * @param {number} input.teamCount
 * @param {number} input.placeableSlotCount
 * @param {number} input.unplaceableSlotCount
 * @param {boolean} input.seasonClockLoading
 * @param {number} [input.practiceOnlyTeamCount] - teams in practice-only divisions (D2), not
 *   counted in `teamCount`
 * @param {string|null} [input.savedScheduleError] - why the saved schedule could not be read; a new
 *   schedule is not generated without it (it holds the Published games and who hosts)
 * @returns {string|null}
 */
export function composeSchedulerReadinessMessage({
  referenceError,
  teamCount,
  placeableSlotCount,
  unplaceableSlotCount,
  seasonClockLoading,
  practiceOnlyTeamCount = 0,
  savedScheduleError = null,
}) {
  // A new schedule is built around the saved one: who hosts, and the Published games it must keep.
  // Without a saved schedule it could read, it would build one that moves them and the save would
  // refuse it, so it is not built.
  const unreadable = savedScheduleError
    ? 'The saved game schedule could not be read, so a new one is not generated: it could not keep the Published games or who hosts.'
    : null;
  const parts = seasonClockLoading
    ? [referenceError, unreadable, 'Loading this season\u2019s settings\u2026']
    : [
        referenceError,
        unreadable,
        // D2: teams that exist but all play no games are not "no teams".
        teamCount === 0 && practiceOnlyTeamCount > 0
          ? 'Every generated team is in a practice-only division, so there are no games to schedule.'
          : teamCount === 0
            ? 'No generated teams are available for game scheduling.'
            : null,
        placeableSlotCount === 0 && unplaceableSlotCount === 0
          ? 'No game slots are available for this organization.'
          : null,
      ];
  return parts.filter(Boolean).join(' \u00b7 ') || null;
}

/** @type {string[]} */
const GRID_DIRECTIONS = [KeyboardCode.Down, KeyboardCode.Up, KeyboardCode.Left, KeyboardCode.Right];

/**
 * Where an arrow key takes a game being dragged with the keyboard: the nearest
 * cell in that direction (plan item M4.3).
 *
 * The roster manager's `sortableKeyboardCoordinates` cannot be used as it is:
 * it moves only an item that is itself a droppable (a sortable), and a game
 * card is a plain draggable, so it returned nothing and the card never moved.
 * This is its direction filter and `closestCorners` pick, without that
 * requirement. Returns `undefined` (no move) for any other key, or when there
 * is no cell that way.
 *
 * @param {KeyboardEvent} event
 * @param {{ context: Record<string, any> }} args
 * @returns {{ x: number, y: number } | undefined}
 */
export function gridKeyboardCoordinates(event, { context }) {
  const { active, collisionRect, droppableRects, droppableContainers, over } = context;
  if (!GRID_DIRECTIONS.includes(event.code)) return undefined;
  event.preventDefault();
  if (!active || !collisionRect) return undefined;

  // Directions are read from the cell the game is over, not from the card: a
  // card sits inset in its cell, so on the first press its own column would
  // count as "left" of it and its own row as "above" it.
  const from = (over && droppableRects.get(over.id)) || collisionRect;
  const ahead = [];
  for (const entry of droppableContainers.getEnabled()) {
    const rect = entry && !entry.disabled ? droppableRects.get(entry.id) : null;
    if (!rect) continue;
    if (
      (event.code === KeyboardCode.Down && rect.top > from.top) ||
      (event.code === KeyboardCode.Up && rect.top < from.top) ||
      (event.code === KeyboardCode.Right && rect.left > from.left) ||
      (event.code === KeyboardCode.Left && rect.left < from.left)
    ) {
      ahead.push(entry);
    }
  }
  const collisions = closestCorners({
    active,
    collisionRect,
    droppableRects,
    droppableContainers: ahead,
    pointerCoordinates: null,
  });
  let closestId = getFirstCollision(collisions, 'id');
  if (closestId === over?.id && collisions.length > 1) closestId = collisions[1].id;
  const rect = closestId == null ? null : droppableRects.get(closestId);
  return rect ? { x: rect.left, y: rect.top } : undefined;
}

/**
 * The game grid's sensors: the roster manager's pattern (a pointer drag that
 * starts after 5px, so a click on a card's controls is not a drag, and a
 * keyboard drag), with the grid's own arrow-key rule.
 */
export function useGameGridSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: gridKeyboardCoordinates })
  );
}

const GRID_DRAG_INSTRUCTIONS =
  'To move a game, press space or enter on its drag handle, use the arrow keys to move ' +
  'between fields and time slots, then press space or enter to drop it, or escape to cancel. ' +
  'Each game also has a Move to list.';

function formatUnscheduledMatchup(entry) {
  return `${entry.matchup?.homeTeamId ?? 'Home'} vs ${entry.matchup?.awayTeamId ?? 'Away'}`;
}

/** Chronological, then by division, slot and home team: the order the generator returns its games in. */
function compareGamesByTime(a, b) {
  return (
    a.weekIndex - b.weekIndex ||
    String(a.division).localeCompare(String(b.division)) ||
    Date.parse(a.start) - Date.parse(b.start) ||
    String(getAssignmentSlotId(a)).localeCompare(String(getAssignmentSlotId(b))) ||
    String(getAssignmentHomeTeamId(a)).localeCompare(String(getAssignmentHomeTeamId(b)))
  );
}

/**
 * What a regeneration says about the games it did not touch: the Published ones, and (since F11-2) the ones held by a
 * score and not Published, each counted in its own sentence so neither number is a count of something else.
 *
 * @param {number} published - held games that are Published
 * @param {number} [scored] - held games that are not Published (held by their score)
 */
export function describeKeptPublished(published, scored = 0) {
  const parts = [];
  if (published > 0) {
    parts.push(
      published === 1
        ? '1 Published game kept as it is.'
        : `${published} Published games kept as they are.`
    );
  }
  if (scored > 0) {
    parts.push(
      scored === 1
        ? '1 game with a score kept as it is.'
        : `${scored} games with a score kept as they are.`
    );
  }
  return parts.join(' ');
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

/**
 * The id of the saved game a displayed assignment IS, or undefined. A game the database returned, or one the matcher
 * continued from a saved game, is `persisted` and its `id` is a `game_assignments.id`; a new game's id is a placeholder
 * built for the screen (`review-...`), is never sent, and the database would refuse it.
 */
function savedGameIdOf(assignment) {
  return assignment?.persisted === true && typeof assignment.id === 'string' && assignment.id !== ''
    ? assignment.id
    : undefined;
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

/**
 * Cancel one saved game, after a Published game has been refused.
 *
 * A Published game is not cancelled from here: the sentence says to allow changes first, and nothing is asked or sent
 * (the database refuses it too, `game_published`). Anything else is confirmed, cancelled by `admin_cancel_game_assignment`
 * and removed from the list; a refusal from the database is shown in its words and nothing is removed.
 *
 * A function of its own, with its effects passed in, because the list's cancel button is reachable by no role today
 * (the list shows only when the grid does not, and the button only in edit mode, which opens the grid), and its logic
 * is still worth holding: `tests/gameGridPublishedGuards.test.jsx`.
 *
 * @param {Record<string, any>} assignment
 * @param {{ rpc: (name: string, params: Record<string, any>) => Promise<{ error: any }>,
 *   say: (text: string) => void, onCancelled: (id: string) => void,
 *   confirm?: (text: string) => boolean, fail?: (text: string) => void }} deps
 */
export async function cancelGameAssignment(
  assignment,
  {
    rpc,
    say,
    onCancelled,
    confirm = (text) => window.confirm(text),
    fail = (text) => window.alert(text),
  }
) {
  if (isHeld(assignment)) {
    say(cancelRefusal(assignment));
    return;
  }
  if (
    !confirm(
      `Cancel the game between ${assignment.homeTeamName ?? 'Home'} and ${assignment.awayTeamName ?? 'Away'}? This cannot be undone.`
    )
  )
    return;
  const { error } = await rpc('admin_cancel_game_assignment', { p_assignment_id: assignment.id });
  if (error) {
    fail(error.message || 'Cancel failed');
  } else {
    onCancelled(assignment.id);
  }
}

export default function GameSchedulingPage() {
  // `error` too. `game` is an object literal the hook rebuilds every render,
  // so it is never null and the empty grid below is indistinguishable from a
  // season with no games in it -- which is exactly what a refused
  // `scheduler_runs` read rendered as.
  const { game, team, loading, errors } = useDashboardData();
  // The two sources this page renders, and not the aggregate. `error` covers
  // all of them, so a refused `practice_assignments` read used to open an
  // assertive alert here about rows this page never shows -- and folding the
  // assignments reads into the aggregate would have widened that rather than
  // fixed it. This is the narrowing `DataErrorBanner`'s docstring said needed
  // per-source errors on the hook.
  const dataError = errors.game ?? errors.team;
  const {
    currentOrganization,
    currentSeasonSetting,
    permissions = [],
    loading: organizationLoading,
    seasonSettingsLoading,
  } = useOrganization();
  const [localAssignments, setLocalAssignments] = useState([]);
  const [reviewAssignments, setReviewAssignments] = useState(null);
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [activeTab, setActiveTab] = useState('full');
  const viewPanelId = useId();
  const byTeamReasonId = useId();
  const [schedulerStatus, setSchedulerStatus] = useState('idle');
  const [schedulerProgress, setSchedulerProgress] = useState(null);
  const [schedulerResult, setSchedulerResult] = useState(null);
  // What this page's last Apply saved over the current generated result, kept as two sets and never written into the
  // result itself (Codex re-review of #731, C12): the generator's own warnings, saved only when the review applied was
  // the generated one, and the flags of games added by hand, worked out afresh on every Apply. Null until an Apply
  // follows a generation: the generated review is then still the one being applied.
  const [appliedRunWarnings, setAppliedRunWarnings] = useState(
    /** @type {null | { generator: Array<Record<string, any>>, manual: Array<Record<string, any>> }} */ (
      null
    )
  );
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
  // D2: each division's current `plays_games`, read with the grid's
  // reference data. The persisted team run carries no division settings.
  const [divisionRows, setDivisionRows] = useState([]);
  const [referenceError, setReferenceError] = useState(null);
  const [activeGame, setActiveGame] = useState(null);
  // The venues' names by id, for the bulk bar's "one venue" scope (the fields carry only their venue's id).
  const [venueNames, setVenueNames] = useState(/** @type {Record<string, string>} */ ({}));

  const timezone = currentSeasonSetting?.timezone;
  // **"No clock yet" and "no clock at all" are different facts**, and the slot
  // read below is keyed only on `currentOrganization?.id`, so the season row
  // and the slots resolve in whichever order the network gives them. On the
  // losing order every slot is unplaceable with `SEASON_TIMEZONE_MISSING` and
  // the operator is told to set a timezone the season already has.
  // `isSeasonClockLoading` states the three ways that happens.
  const seasonClockLoading = isSeasonClockLoading({
    organizationLoading,
    seasonSettingsLoading,
    currentOrganization,
    currentSeasonSetting,
  });
  // A completed season is history: nothing is generated, applied, saved or cancelled in it
  // (the database refuses the write too, `season_completed`).
  const seasonReadOnly = useSeasonReadOnly();
  const canManageSchedule =
    !seasonReadOnly &&
    (permissions.includes(PERMISSIONS.MANAGE_SCHEDULE) ||
      permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION));
  const canEditSchedule = canManageSchedule && isEditMode;
  // The grid is the full schedule; while it is open, By Team cannot be chosen.
  const shownTab = canEditSchedule ? 'full' : activeTab;
  // Cancelling is destructive and the RPC requires org admin, so the button
  // is gated tighter than general schedule editing.
  const canCancelAssignments =
    !seasonReadOnly && permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION) && isEditMode;
  // Applying (or rolling back) REPLACES the season's game schedule, and the
  // server lets only an org admin do that (docs/PLAN_AUDIT_IN_TRANSACTION.md,
  // Q6), as the practice page's Apply already says (#64).
  const canApplySchedule = !seasonReadOnly && permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION);

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
        setDivisionRows([]);
        setVenueNames({});
        setReferenceError(null);
        return;
      }

      setReferenceError(null);

      try {
        const [
          { data: fieldRows, error: fieldError },
          { data: slotRows, error: slotError },
          { data: venueRows, error: venueError },
          { data: divisionData, error: divisionReadError },
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
            .select('id, name, effective_to')
            .eq('organization_id', currentOrganization.id),
          // **Which divisions play games (D2).** A failed read is an error like
          // the others: guessing "every division plays" would build fixtures
          // for a division that plays none.
          supabase
            .from('divisions')
            .select('id, name, season_settings_id, plays_games')
            .eq('organization_id', currentOrganization.id),
        ]);

        if (!isMounted) return;
        if (fieldError) throw fieldError;
        if (slotError) throw slotError;

        // **The one deploy order this read cannot survive, handled by name.**
        // If the SPA ships ahead of migration 20260911000000 the column does
        // not exist and PostgREST answers 42703 -- which, treated as fatal
        // below, takes down the whole reference load and renders the error
        // state for a page that worked yesterday. A venue with no window IS
        // the pre-migration world, so the fallback re-reads the ids alone and
        // every site reads as unbounded. Every OTHER venue error stays fatal:
        // swallowing them would hide every pitch instead, which looks
        // different and is the same defect.
        /** @type {Array<{ id: any, name?: any, effective_to?: any }>|null} */
        let venues = venueRows;
        let venueFault = venueError;
        if (venueFault?.code === '42703') {
          logger.warn(
            'locations.effective_to is absent, so venue retirement is not migrated yet and every site reads as unbounded'
          );
          const retry = await supabase
            .from('locations')
            .select('id, name')
            .eq('organization_id', currentOrganization.id);
          if (!isMounted) return;
          venues = retry.data;
          venueFault = retry.error;
        }
        // **A failed venue read is an ERROR, not an empty registry.** The 8.4
        // PR 3 review found `useFields().error` being dropped, which left a
        // clean-looking grid on a failed read; swallowing this one would hide
        // every pitch instead, which looks different and is the same defect.
        if (venueFault) throw venueFault;

        // **The same deploy order, for `plays_games`.** The SPA ships before
        // migration 20261029010000; until it lands PostgREST answers 42703,
        // and a division without the column is the pre-migration world, where
        // every division plays. Any other error stays fatal.
        /** @type {Array<Record<string, any>>|null} */
        let divisionList = divisionData;
        let divisionFault = divisionReadError;
        if (divisionFault?.code === '42703') {
          logger.warn(
            'divisions.plays_games is absent, so practice-only divisions are not migrated yet and every division plays games'
          );
          divisionList = [];
          divisionFault = null;
        }
        if (divisionFault) throw divisionFault;

        setAllFields(fieldRows ?? []);
        setVenueNames(
          Object.fromEntries(
            (venues ?? [])
              .filter((row) => row?.id && row?.name)
              .map((row) => [String(row.id), String(row.name)])
          )
        );
        // The two halves of "may the scheduler still offer this" live in one
        // testable producer, because the reading is the point of the change and
        // an inline predicate on a 1000-line page is a reading nothing can pin.
        const asOf = todayIso();
        const venuesById = venueRegistry(venues ?? []);
        setFields(
          (fieldRows ?? []).filter((row) => isFieldOfferableOn(row, asOf, venueOf(row, venuesById)))
        );
        setGameSlotRows(slotRows ?? []);
        setDivisionRows(divisionList ?? []);
      } catch (err) {
        if (!isMounted) return;
        setFields([]);
        setAllFields([]);
        setGameSlotRows([]);
        setDivisionRows([]);
        setVenueNames({});
        setReferenceError(err.message || 'Game schedule reference data could not be loaded.');
      }
    }

    loadGridReferenceData();

    return () => {
      isMounted = false;
    };
  }, [currentOrganization?.id]);

  const practiceOnly = useMemo(
    () => practiceOnlyDivisionsOf(divisionRows, currentSeasonSetting?.id),
    [currentSeasonSetting?.id, divisionRows]
  );

  const schedulerTeams = useMemo(
    () => (team?.teams ?? []).map((entry) => normalizeTeam(entry, practiceOnly)).filter(Boolean),
    [practiceOnly, team?.teams]
  );

  // D2: the teams that play, their round robins, and the practice-only
  // divisions, listed apart rather than counted as unscheduled.
  // Phase D, PR A: a pair already saved keeps its sides when the schedule is
  // generated again. Only the saved run counts (`game.assignments`), never a
  // staged or discarded review, and a pair is not rebalanced.
  const keepSides = useMemo(
    () =>
      savedSides(
        (game?.assignments ?? []).map((assignment) => ({
          homeTeamId: getAssignmentHomeTeamId(assignment),
          awayTeamId: getAssignmentAwayTeamId(assignment),
          weekIndex: getAssignmentWeekIndex(assignment),
        }))
      ),
    [game?.assignments]
  );
  // The saved Published games (PR 1's `game_assignments.published`; a database that does not have the
  // column yet returns none, so nothing is held and generating is exactly what it was). A regeneration
  // keeps each one where it is: the generator takes them as `pinned` and hands them back as `carried`
  // (plan `docs/changes/2026-11-03-schedule-expansion.md`, 3.5). Read from the saved run only, never
  // from a staged or discarded review, as `keepSides` is.
  const publishedGames = useMemo(
    () =>
      (game?.assignments ?? [])
        .filter((assignment) => isHeld(assignment))
        .map((assignment) => ({
          ...assignment,
          slotId: getAssignmentSlotId(assignment),
          homeTeamId: getAssignmentHomeTeamId(assignment),
          awayTeamId: getAssignmentAwayTeamId(assignment),
        })),
    [game?.assignments]
  );
  const divisionPlan = useMemo(
    () => buildDivisionRoundRobins(schedulerTeams, { keepSides }),
    [keepSides, schedulerTeams]
  );
  const gameTeams = /** @type {typeof schedulerTeams} */ (divisionPlan.gameTeams);
  // The practice-only divisions' teams, counted once (D2).
  const practiceOnlyTeamCount = divisionPlan.practiceOnlyDivisions.reduce(
    (sum, entry) => sum + entry.teamIds.length,
    0
  );

  const teamById = useMemo(() => {
    const map = new Map();
    for (const entry of schedulerTeams) {
      map.set(entry.id, entry);
    }
    return map;
  }, [schedulerTeams]);

  // The names of the teams a saved game names: the season's teams as the tables hold them (an outside club is in no team
  // run, so the run's teams would show it as its id), with the run's teams, which the solver is handed, taking their entries.
  const seasonTeams = useSeasonTeamDirectory();
  const displayTeamById = useMemo(() => {
    const map = new Map();
    for (const entry of seasonTeams) map.set(entry.id, entry);
    for (const [id, entry] of teamById) map.set(id, entry);
    return map;
  }, [seasonTeams, teamById]);

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

  const { gameSlots, slotById, unplaceableSlots } = useMemo(
    () => partitionGameSlots(gameSlotRows, { fieldById, divisionById, timezone }),
    [divisionById, fieldById, gameSlotRows, timezone]
  );

  // Held back until the season row has landed: before then every entry in
  // `unplaceableSlots` says `SEASON_TIMEZONE_MISSING` about a season whose
  // clock nobody has read yet, and printing that is the false alarm finding 8
  // names.
  const unplaceableSlotMessage = useMemo(
    () => (seasonClockLoading ? null : describeUnplaceableSlots(unplaceableSlots)),
    [seasonClockLoading, unplaceableSlots]
  );

  // The saved schedule as the page shows it: one entry per row the database returned for the latest run, with
  // the Published state it carries. This is the SAVED SET the Published controls act on (the bulk scopes, the
  // counts, the ids of a call), never the staged review and never a filtered list.
  const savedAssignments = useMemo(
    () =>
      (game?.assignments ?? []).map((assignment, index) =>
        buildDisplayAssignment({
          assignment,
          index,
          runId: game?.runId,
          teamById: displayTeamById,
          slotById,
          fieldById,
        })
      ),
    [displayTeamById, fieldById, game?.assignments, game?.runId, slotById]
  );

  const displayedAssignments = reviewAssignments ?? localAssignments;
  const isReviewing = Boolean(reviewAssignments);
  const displayedAssignmentsRef = useRef(displayedAssignments);

  useEffect(() => {
    displayedAssignmentsRef.current = displayedAssignments;
  }, [displayedAssignments]);

  // ---------------------------------------------------------------------------
  // Published (plan docs/changes/2026-11-03-schedule-expansion.md, 3.6, PR 3)
  //
  // A Published game is held where it is: the database refuses to move or delete it (a trigger), and this page
  // is the friendly half of that. Turning the flag ON needs nothing; turning it OFF is "Allow changes", a
  // deliberate, audited act with its own dialog, so no save, move or cancel ever releases a game by the way.
  //
  // Every control here acts on the SAVED SET (`savedAssignments`, the rows of the latest run as the database
  // returned them): the counts, the bulk scopes and the ids of a call are enumerated from it, never from the
  // staged review and never from the list's filter. The games on screen after an Apply are the staged ones (a
  // moved or regenerated game that continues a saved game carries that game's id, a new game has a placeholder), so
  // the controls wait for the saved schedule to be read again. A game moved to another slot or week keeps its id, its
  // flag and its history, because the save updates it in place (20261120010000); a game the new schedule no longer
  // holds stays in the old run, which the page says rather than hide.
  // ---------------------------------------------------------------------------
  const publishedReasonId = useId();
  const summaryRef = useRef(/** @type {HTMLParagraphElement | null} */ (null));
  const refetchSaved = game?.refetchSaved ?? game?.refetch;
  const savedGamesRef = useRef(game?.assignments);
  useEffect(() => {
    savedGamesRef.current = game?.assignments;
  }, [game?.assignments]);
  // The saved rows the screen last held when a change was made. While `game.assignments` is still that array
  // the read that follows has not landed, and the ids and flags on screen are not known to be the database's.
  const [staleAgainst, setStaleAgainst] = useState(/** @type {unknown} */ (null));
  const savedIsStale = staleAgainst !== null && staleAgainst === game?.assignments;
  const markSavedStale = useCallback(() => setStaleAgainst(savedGamesRef.current ?? null), []);
  // The list follows the saved rows, except while they are known to be the rows from before a change (an Apply, a
  // rollback): a re-render then (a slot read landing, the season clock) would put the list back to the schedule before
  // the save until the saved schedule is read again (review of #731).
  useEffect(() => {
    if (savedIsStale) return;
    setLocalAssignments(savedAssignments);
  }, [savedAssignments, game?.generatedAt, savedIsStale]);
  const [listFilter, setListFilter] = useState('all');
  const [publishBusy, setPublishBusy] = useState(false);
  const publishBusyRef = useRef(false);
  const [publishNotice, setPublishNotice] = useState(
    /** @type {null | { tone: 'alert' | 'status', text: string }} */ (null)
  );
  const [allowDialog, setAllowDialog] = useState(
    /** @type {null | { games: Array<Record<string, any>>, scope: { kind: string, value?: string }, key: number }} */ (
      null
    )
  );
  const [dialogNotice, setDialogNotice] = useState(
    /** @type {null | { tone: 'alert' | 'status', text: string }} */ (null)
  );
  const [historyGame, setHistoryGame] = useState(/** @type {null | Record<string, any>} */ (null));
  const dialogKeyRef = useRef(0);
  const openerRef = useRef(/** @type {Element | null} */ (null));
  const restoreFocusRef = useRef(/** @type {Element | null} */ (null));

  // Only an organization admin may change it (the database's `is_org_admin`), and never in a completed season.
  const canChangePublished = canApplySchedule;
  const canReadHistory = permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION);
  const savedReadState = errors.game
    ? 'unreadable'
    : loading.game || savedIsStale
      ? 'reading'
      : 'ready';
  // Apply waits for the saved schedule while it is read (after an Apply): the next save carries its flags forward (C12).
  const applyWaitsForRead = savedReadState === 'reading';
  /** Why the Published controls are off right now, or null. Said once, in the bar, and pointed at by each switch. */
  let publishedReason = null;
  if (!canChangePublished) {
    publishedReason = seasonReadOnly
      ? 'This season is completed, so whether its games are Published cannot be changed.'
      : 'Only an organization admin can change whether games are Published.';
  } else if (savedReadState === 'unreadable') {
    publishedReason =
      'The saved schedule could not be read, so what is Published cannot be changed.';
  } else if (savedReadState === 'reading') {
    publishedReason = 'Reading the saved schedule…';
  } else if (savedAssignments.length === 0) {
    publishedReason = 'There is no saved schedule yet, so there is nothing to publish.';
  } else if (isReviewing) {
    publishedReason =
      'A staged schedule is waiting. Apply or discard it before changing what is Published.';
  } else if (publishBusy) {
    publishedReason = 'Saving…';
  }

  const allFieldById = useMemo(
    () => new Map(allFields.map((field) => [String(field.id), field])),
    [allFields]
  );
  /** The venue a saved game is at, by name, from every field the organization holds (retired ones too). */
  const gameVenueName = useCallback(
    (savedGame) => {
      const field = allFieldById.get(String(savedGame?.fieldId ?? ''));
      return field?.location_id ? (venueNames[String(field.location_id)] ?? null) : null;
    },
    [allFieldById, venueNames]
  );

  const runSetPublished = useCallback(
    async (input) => {
      if (publishBusyRef.current)
        return { ok: false, error: 'Another change is still being saved.' };
      if (!currentOrganization?.id) return { ok: false, error: 'No organization is selected.' };
      publishBusyRef.current = true;
      setPublishBusy(true);
      try {
        // **Turning Published on names only games of the schedule that is saved now.** This page read its games when
        // it opened, and another tab may have moved a game and applied since: that game's old row is still in the
        // database (in an older run), and publishing it would hold a game the Games page can neither show nor
        // release, with every later save refused for it. Turning it off cannot hide a game, so it is not checked.
        if (input.published === true) {
          const wanted = [...input.ids];
          let stale;
          try {
            const current = await readCurrentSavedGameIds({
              organizationId: currentOrganization.id,
              seasonSettingsId: currentSeasonSetting?.id ?? null,
            });
            stale = wanted.filter((id) => !current.ids.has(String(id)));
          } catch (checkErr) {
            logger.error('Saved schedule check error:', checkErr);
            return { ok: false, error: describeStaleCheckFailure(checkErr) };
          }
          if (stale.length > 0) {
            markSavedStale();
            refetchSaved?.();
            return { ok: false, error: describeStaleSchedule(stale.length, wanted.length) };
          }
        }
        const result = await setGamesPublished({
          organizationId: currentOrganization.id,
          ...input,
        });
        // The flag is the database's, not a guess of ours: read the saved schedule again.
        markSavedStale();
        refetchSaved?.();
        return { ok: true, result };
      } catch (err) {
        // A long list is several calls, and the ones before a refusal were saved. A call whose answer was lost (a
        // failed fetch, a gateway's 502, a body nobody can read) may have been committed too, so the saved flags
        // are read again then as well, as after a save whose outcome is unknown (`rereadAfterUnknownOutcome`).
        if (err?.done?.calls > 0 || isUnknownPublishedOutcome(err)) {
          markSavedStale();
          refetchSaved?.();
        }
        return {
          ok: false,
          error:
            describeSetFailure(err) +
            (isUnknownPublishedOutcome(err)
              ? ' The saved schedule is read again to show what was saved.'
              : ''),
        };
      } finally {
        publishBusyRef.current = false;
        setPublishBusy(false);
      }
    },
    [currentOrganization?.id, currentSeasonSetting?.id, markSavedStale, refetchSaved]
  );

  const publishGames = useCallback(
    async ({ ids, scope }, label = null) => {
      setPublishNotice(null);
      // Where focus is when it is pressed. Publishing can remove that control (the row leaves a filtered list) or
      // leave it nothing to do (a bulk button with no game left), so focus is put back once the list has settled.
      restoreFocusRef.current = document.activeElement;
      const outcome = await runSetPublished({ ids, published: true, scope });
      setPublishNotice(
        outcome.ok
          ? { tone: 'status', text: describeSetResult(outcome.result, true) }
          : { tone: 'alert', text: label ? `${label}: ${outcome.error}` : outcome.error }
      );
    },
    [runSetPublished]
  );

  const openAllowChanges = useCallback(
    (games, scope) => {
      setDialogNotice(null);
      openerRef.current = document.activeElement;
      dialogKeyRef.current += 1;
      setAllowDialog({
        games: games.map((savedGame) => ({
          ...savedGame,
          whenText: formatDateTime(savedGame.start ?? savedGame.kickoff, timezone),
        })),
        scope,
        key: dialogKeyRef.current,
      });
    },
    [timezone]
  );

  const confirmAllowChanges = useCallback(
    async ({ reasonCode, note }) => {
      if (!allowDialog) return;
      setDialogNotice(null);
      const outcome = await runSetPublished({
        ids: allowDialog.games.map((savedGame) => String(savedGame.id)),
        published: false,
        reasonCode,
        note,
        scope: allowDialog.scope,
      });
      if (outcome.ok) {
        restoreFocusRef.current = openerRef.current;
        setAllowDialog(null);
        setPublishNotice({ tone: 'status', text: describeSetResult(outcome.result, false) });
      } else {
        setDialogNotice({ tone: 'alert', text: outcome.error });
      }
    },
    [allowDialog, runSetPublished]
  );

  // Once the saved schedule has been read again, focus goes back to what opened the dialog or pressed the switch (or
  // the bulk button), or to the count when that control has nothing left to do or has left the list: a person is
  // never left on nothing. The list is a copy of the saved rows set one effect after them, so this waits until it has
  // caught up: the row that held focus can be on screen for one render and gone in the next. A person who has moved
  // focus on while it was saving keeps where they went.
  useEffect(() => {
    if (publishedReason !== null || !restoreFocusRef.current) return;
    if (localAssignments !== savedAssignments) return;
    const opener = /** @type {HTMLElement} */ (restoreFocusRef.current);
    restoreFocusRef.current = null;
    const active = document.activeElement;
    const lost = !active || active === document.body || active === opener || !active.isConnected;
    if (!lost) return;
    const target =
      opener.isConnected && !opener.hasAttribute('disabled') ? opener : summaryRef.current;
    target?.focus();
  }, [publishedReason, localAssignments, savedAssignments]);

  const publishedContext = useMemo(
    () => ({
      canChange: canChangePublished,
      canReadHistory,
      disabledReason: canChangePublished ? publishedReason : null,
      reasonId: publishedReasonId,
      publish: (savedGame) => {
        const { home, away } = matchupOf(savedGame);
        publishGames(
          { ids: [String(savedGame.id)], scope: { kind: 'selection' } },
          `${home} vs ${away}`
        );
      },
      allowChanges: (savedGame) => openAllowChanges([savedGame], { kind: 'selection' }),
      showHistory: (savedGame) => setHistoryGame(savedGame),
    }),
    [
      canChangePublished,
      canReadHistory,
      openAllowChanges,
      publishGames,
      publishedReason,
      publishedReasonId,
    ]
  );

  // The list can be filtered to what is Published or released; the filter shapes the LIST and nothing else (the
  // bar above it is given the saved set, not this).
  const showPublishedFilter = !canEditSchedule && activeTab === 'full' && !isReviewing;
  const listAssignments = useMemo(
    () =>
      showPublishedFilter
        ? filterByPublishedState(displayedAssignments, listFilter)
        : displayedAssignments,
    [displayedAssignments, listFilter, showPublishedFilter]
  );

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

  // **`seasonClockLoading` is here because the slot count cannot cover it**,
  // and this arm was the one missing it. `PracticeSchedulingPage` has carried
  // the clause since #400; the argument for dropping it there was that a
  // season with no timezone refuses every slot, so `!gameSlots.length` fires
  // anyway. True for reason (1) of `isSeasonClockLoading` -- and false for
  // reason (3), which is the whole point of that helper: the organisation has
  // switched and the season row still in hand belongs to the one just left, so
  // it HAS a timezone, every slot places against it, and the count arm is
  // false while the clock is another tenant's. Enabling auto-generate there
  // runs `useAutoScheduler({ organizationId: currentOrganization?.id })` -- the
  // NEW organisation -- over the previous one's slots on the previous one's
  // clock. The banner already says "Loading this season's settings…" in that
  // window (see `composeSchedulerReadinessMessage`), so this makes the button
  // agree with the sentence beside it rather than inventing a new rule.
  // A game added by hand and not yet applied would be dropped by a fresh generation (it replaces the review), so
  // generating waits until the review is applied or discarded, and says so (PR 8).
  const addedGamesStaged = (reviewAssignments ?? []).some(
    (assignment) => assignment.addedByHand === true
  );
  const schedulerDisabled =
    addedGamesStaged ||
    loading.game ||
    !canManageSchedule ||
    schedulerStatus === 'running' ||
    seasonClockLoading ||
    !gameTeams.length ||
    !gameSlots.length ||
    Boolean(referenceError) ||
    // The saved schedule is where the Published games come from (`publishedGames`): generating
    // without it would re-solve every one of them, and the save would refuse the result.
    Boolean(errors.game);

  // The unplaceable summary is NOT part of this sentence; it has its own line
  // below. See `composeSchedulerReadinessMessage` for why both halves of that
  // arrangement are needed and why appending it here printed it twice.
  const schedulerReadinessMessage = composeSchedulerReadinessMessage({
    referenceError,
    teamCount: gameTeams.length,
    practiceOnlyTeamCount,
    placeableSlotCount: gameSlots.length,
    unplaceableSlotCount: unplaceableSlots.length,
    seasonClockLoading,
    savedScheduleError: errors.game,
  });

  const reviewSnapshot = useMemo(() => {
    const source = schedulerResult?.evaluation;
    if (!source) return game?.snapshot ?? {};
    return {
      ...source,
      // After an Apply, what it saved: the two sets, each once (C12); before it, the generator's own.
      warnings: appliedRunWarnings
        ? [...appliedRunWarnings.generator, ...appliedRunWarnings.manual]
        : (source.warnings ?? []),
      generatedAt: schedulerResult.generatedAt,
      unscheduled: (schedulerResult.unscheduled ?? []).map((entry) => ({
        ...entry,
        matchup: formatUnscheduledMatchup(entry),
      })),
    };
  }, [appliedRunWarnings, game?.snapshot, schedulerResult]);

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
      const { roundRobinByDivision } = divisionPlan;
      const start = performance.now();
      // The Published games come back as `carried`, unchanged, beside the new games: the review is
      // all of them, because the save must carry every Published game of the season (it refuses one
      // that is left out). Evaluated and summarised as the whole schedule they are.
      const { carried, ...result } = scheduleGames({
        teams: gameTeams,
        slots: gameSlots,
        roundRobinByDivision,
        // Nothing Published: the very call this page always made, not an empty list.
        pinned: publishedGames.length > 0 ? publishedGames : undefined,
      });
      const scheduled = carried?.length
        ? [...carried, ...result.assignments].sort(compareGamesByTime)
        : result.assignments;
      // Which saved game each regenerated game continues, by the same pair and the nearest week (plan
      // `docs/changes/2026-11-06-games-table-source-of-truth.md`, I2). A carried game is the saved game itself and
      // keeps its id; the rest take the id of the saved game of their pair, so the save updates that game in place and
      // its Published state and history stay with it. Read from the saved run only, as `keepSides` is. A proposal: the
      // database checks every id it is sent.
      const savedRows = game?.assignments ?? [];
      const savedById = new Map(savedRows.map((row) => [row.id, row]));
      const identified = carryGameIds(savedRows, scheduled).map((assignment) => {
        const was = savedById.get(assignment.id);
        return was
          ? {
              ...assignment,
              published: was.published,
              publishedAt: was.publishedAt ?? was.published_at,
              publishedBy: was.publishedBy ?? was.published_by,
            }
          : assignment;
      });
      const evaluation = evaluateGameSchedule({
        assignments: scheduled,
        teams: gameTeams,
        byes: result.byes,
        unscheduled: result.unscheduled,
        sharedSlotUsage: result.sharedSlotUsage,
      });
      const elapsedMs = Math.round(performance.now() - start);
      const summary = summarizeGameResult({ ...result, assignments: scheduled });
      const generatedAt = new Date().toISOString();
      const nextAssignments = identified.map((assignment, index) =>
        buildDisplayAssignment({
          assignment,
          index,
          runId: null,
          teamById: displayTeamById,
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
      setAppliedRunWarnings(null);
      setSchedulerProgress({
        iteration: 1,
        bestScore: summary.scheduledRate,
        elapsedMs,
      });
      setSchedulerStatus('completed');
      setApplyStatus('review');
      if (carried?.length) {
        const scoredOnly = carried.filter((kept) => holdReason(kept) === 'scored').length;
        setStatusMessage(describeKeptPublished(carried.length - scoredOnly, scoredOnly));
      }
    } catch (err) {
      setSchedulerStatus('failed');
      setSchedulerError(err.message || 'Game schedule generation failed.');
      setApplyStatus('error');
      setApplyError(err.message || 'Game schedule generation failed.');
    }
  }, [
    divisionPlan,
    fieldById,
    game?.assignments,
    gameSlots,
    gameTeams,
    publishedGames,
    schedulerDisabled,
    slotById,
    displayTeamById,
  ]);

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
    setAppliedRunWarnings(null);
    setSchedulerError(null);
    setReviewAssignments(null);
    setApplyStatus('idle');
    setApplyError(null);
    setStatusMessage(null);
  }, []);

  const discardReview = useCallback(() => {
    setReviewAssignments(null);
    setSchedulerResult(null);
    setAppliedRunWarnings(null);
    setApplyStatus('discarded');
    setApplyError(null);
    setStatusMessage(null);
  }, []);

  const persistReviewedAssignments = useCallback(
    async ({
      assignments,
      generationMode,
      resultSummary,
      resultDetails,
      knownSlotIds = undefined,
      generatorWarnings = [],
      extraWarnings = [],
    }) => {
      const persistenceAssignments = assignments.map(toPersistenceAssignment);
      // The save is told which saved game each assignment is, by id (a moved, flipped or regenerated game keeps its
      // id, its Published state and its history); a new game carries none. The run's recorded `results.assignments`
      // below is what it always was and holds no ids.
      const rowsToSave = assignments.map((assignment, index) => {
        const id = savedGameIdOf(assignment);
        return id === undefined
          ? persistenceAssignments[index]
          : { ...persistenceAssignments[index], id };
      });
      const missingSlot = persistenceAssignments.find(
        (assignment) =>
          !assignment.slotId ||
          (!slotById.has(assignment.slotId) && !knownSlotIds?.has(String(assignment.slotId)))
      );

      if (assignments.length > 0 && missingSlot) {
        throw new Error('One or more staged games references a game slot that no longer exists.');
      }

      const now = new Date().toISOString();
      const result = await persistGameScheduleReview({
        assignments: rowsToSave,
        runMetadata: {
          organizationId: currentOrganization?.id,
          seasonSettingsId: currentSeasonSetting?.id,
          parameters: {
            organizationId: currentOrganization?.id,
            // Every generated team, as before D2; of them, the practice-only
            // divisions' teams, which the run gave no games.
            teamCount: schedulerTeams.length,
            practiceOnlyTeamCount,
            slotCount: gameSlots.length,
            generationMode,
          },
          metrics: resultDetails?.optimization ?? {},
          results: {
            summary:
              resultSummary ?? summarizeGameResult({ assignments, byes: [], unscheduled: [] }),
            assignments: persistenceAssignments,
            byes: resultDetails?.byes ?? [],
            // The scheduler's own list of games it could not place: the server records it as the
            // season's TIME TBD games (`persist_game_schedule`, Phase D, E). Only a run has one; a
            // rollback or a hand edit sends none (`undefined` is left out of the JSON), so it
            // leaves the recorded list as it is.
            unscheduled: Array.isArray(resultDetails?.unscheduled)
              ? parseGameUnscheduled(resultDetails.unscheduled)
              : undefined,
            sharedSlotUsage: resultDetails?.sharedSlotUsage ?? [],
            // The generator's own warnings when the generated review is the one saved, and the flags of the games added
            // by hand (flagged, not blocked: PR 8), each set given by the caller (C12).
            warnings: [...generatorWarnings, ...extraWarnings],
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
      practiceOnlyTeamCount,
      schedulerTeams.length,
      slotById,
    ]
  );

  // A save that timed out, or answered 2xx with a body that could not be
  // read, may still have been written (the message says the outcome is not
  // known). The schedule on screen would then be the one from before it, so
  // the saved schedule is read again; the staged review is left as it was.
  //
  // A save refused for a game's identity (409 `GAME_IDENTITY`: a game removed, of another season, named twice, or
  // colliding with another) names saved games by ids the database no longer holds where the review thinks. The saved
  // schedule is read again (owner, 2026-11-09; F11-3 task C6), and once that read has settled the staged review is
  // matched to it again (`rekeyReview`, review R1): sending the same ids would be refused the same way. A review the new
  // read does not change is discarded, in words, and the schedule is generated again.
  //
  // **Settled means the latest run AND its games** (fix round 2, Codex P2). The re-read is two reads, the latest run and
  // the games of the run on screen, and when another save has made a newer run the old run's games can answer first:
  // they lack every game carried into the newer run, and re-keying against them would strip those games' ids, so the
  // next Apply would insert them as new games. So the marker is consumed only after the re-read has been seen in
  // flight and has then settled without an error, with every saved row of the run the lookup names. A failed read
  // leaves it armed and says so.
  const refetchGame = game?.refetch;
  const rekeyRef = useRef(/** @type {null | { inFlight: boolean, saidFailed: boolean }} */ (null));
  const rereadAfterUnknownOutcome = useCallback(
    (err) => {
      if (isUnknownPersistenceOutcome(err)) refetchGame?.();
      else if (err?.code === 'GAME_IDENTITY') {
        rekeyRef.current = { inFlight: false, saidFailed: false };
        markSavedStale();
        refetchSaved?.();
      }
    },
    [refetchGame, markSavedStale, refetchSaved]
  );
  const savedRunId = game?.runId ?? null;
  const savedReading = Boolean(loading.game);
  const savedReadError = errors.game ?? null;
  useEffect(() => {
    const marker = rekeyRef.current;
    if (marker === null) return;
    if (savedReading) {
      marker.inFlight = true;
      return;
    }
    // The re-read has not started yet: the rows on screen are still the ones the refused review was made from.
    if (!marker.inFlight) return;
    if (savedReadError) {
      if (!marker.saidFailed) {
        marker.saidFailed = true;
        // Said as the error it is, in place of the refusal that led to it.
        setApplyError(
          'The saved schedule could not be read again, so this review was not matched to it. It is kept as it is: reload the page before applying it.'
        );
      }
      return;
    }
    const saved = game?.assignments;
    if (!Array.isArray(saved) || !saved.every((row) => String(row.runId) === String(savedRunId))) {
      return;
    }
    rekeyRef.current = null;
    if (!Array.isArray(reviewAssignments)) return;
    const { review, changed } = rekeyReview(reviewAssignments, saved);
    // The refusal's own words give way to what was done about it.
    setApplyError(null);
    if (changed) {
      setReviewAssignments(review);
      setApplyStatus('review');
      setStatusMessage(
        'The saved schedule changed while this review was open: its games were matched again to the saved schedule as it is now. Check the review and apply it again.'
      );
    } else {
      setReviewAssignments(null);
      setApplyStatus('discarded');
      setStatusMessage(
        'This review was discarded: the saved schedule was read again and matches the review as it was, so applying it again would be refused the same way. Generate the schedule again.'
      );
    }
  }, [game?.assignments, reviewAssignments, savedReading, savedReadError, savedRunId]);

  // The double bookings of the games added by hand, against the rest of the staged review: flagged in the conflict
  // banner while the review is staged and recorded with the run it is saved as (PR 8; never a refusal).
  const fieldNameOf = useCallback(
    (id) => fields.find((field) => String(field.id) === String(id))?.name ?? String(id ?? ''),
    [fields]
  );
  const externalTeamIds = useMemo(
    () => new Set(seasonTeams.filter((entry) => entry.isExternal).map((entry) => String(entry.id))),
    [seasonTeams]
  );
  const isExternalTeam = useCallback((id) => externalTeamIds.has(String(id)), [externalTeamIds]);
  const divisionNameOf = useCallback(
    (id) => divisionRows.find((row) => String(row.id) === String(id))?.name ?? null,
    [divisionRows]
  );
  // The flags of the games added by hand, each clash once, judged where each game is NOW (its slot's reserved division,
  // its field and times; C5): shown in the banner while the review is staged. Apply works them out again over the
  // slots it resolves (C9), through the same function.
  const addedGameWarnings = useMemo(
    () =>
      warningsOfAddedGames(reviewAssignments ?? [], gameSlotRows, {
        isExternal: isExternalTeam,
        fieldName: fieldNameOf,
        divisionName: divisionNameOf,
      }),
    [divisionNameOf, fieldNameOf, gameSlotRows, isExternalTeam, reviewAssignments]
  );
  /** An error, with the new-time slots this Apply made and left unused named after it (the plan, 5.5). */
  const withLeftSlots = useCallback(
    (message, made, { unknown = false } = {}) => {
      if (!made || made.length === 0) return message;
      const named = made.map((slot) => describeNewSlot(slot, fieldNameOf(slot.fieldId), timezone));
      // A save whose outcome is not known may have been written: the slot may hold the saved game.
      if (unknown) {
        return `${message} The new time ${made.length === 1 ? 'slot' : 'slots'} ${named.join('; ')} ${
          made.length === 1 ? 'was' : 'were'
        } made before the save; whether the game was saved into ${
          made.length === 1 ? 'it' : 'them'
        } is being checked.`;
      }
      return made.length === 1
        ? `${message} The new time slot ${named[0]} was made before the save and is kept, unused: it holds no game and does no harm.`
        : `${message} The new time slots ${named.join('; ')} were made before the save and are kept, unused: they hold no game and do no harm.`;
    },
    [fieldNameOf, timezone]
  );

  const handleApplySchedule = useCallback(async () => {
    if (!canManageSchedule || !canApplySchedule || reviewAssignments == null) return;
    // Not while the saved schedule is being read (after an Apply): the flags it carries forward come from it (C12).
    if (applyWaitsForRead) return;

    setApplyStatus('applying');
    setApplyError(null);

    // Apply is one sequence over RESOLVED state (Codex re-review of #731, C9 and C10). Nothing in state changes until
    // the save has succeeded: a failure at any step leaves the staged review exactly as it was (its new times still
    // pending), says why, and Apply again redoes every step (`ensure_game_slot` finds a slot it made before).
    //
    // 1. Resolve: the database's slot for each new time, the slot it already had checked against the new time, and
    //    the one-game-per-slot and one-place-per-pair checks, all on a local copy of the review.
    /** @type {{ review: Array<Record<string, any>>, made: Array<Record<string, any>>, slotIds: Set<string> }} */
    let resolved;
    try {
      resolved = await resolveAddedSlots(
        reviewAssignments,
        async (pending) => {
          const { data, error } = await supabase.rpc('ensure_game_slot', {
            p_organization_id: currentOrganization?.id,
            p_field_id: pending.fieldId,
            p_slot_date: pending.date,
            p_start_time: pending.startTime,
            p_end_time: pending.endTime,
            p_week_index: pending.weekIndex,
            p_start: pending.start,
            p_end: pending.end,
          });
          if (error || !data?.id) {
            throw new Error(
              `The new time could not be made: ${error?.message ?? 'the database returned no slot'}. Nothing was saved.`
            );
          }
          if (data.created) return data;
          // A slot it already had: its result is the id alone, so the slot is read back to be compared.
          const { data: row, error: readError } = await supabase
            .from('game_slots')
            .select('id, field_id, slot_date, start_time, end_time, week_index, start, end')
            .eq('id', data.id)
            .maybeSingle();
          if (readError) {
            throw new Error(
              `The slot the database found could not be read back: ${readError.message}. Nothing was saved.`
            );
          }
          return { ...data, row: row ?? undefined };
        },
        { fieldName: fieldNameOf }
      );
    } catch (err) {
      setApplyStatus('error');
      setApplyError(
        withLeftSlots(
          err instanceof Error ? err.message : String(err),
          /** @type {any} */ (err)?.madeSlots ?? []
        )
      );
      return;
    }

    // 2. Read every resolved slot the page does not hold, whether this Apply made it or another admin did (C8). If the
    //    read fails, stop here: the review is untouched, so Apply again resolves and reads again.
    const missingSlotIds = [...resolved.slotIds].filter(
      (id) => !gameSlotRows.some((row) => String(row.id) === id)
    );
    /** @type {Array<Record<string, any>>} */
    let freshRows = [];
    if (missingSlotIds.length > 0) {
      const { data, error } = await supabase
        .from('game_slots')
        .select('*, divisions(id, name)')
        .in('id', missingSlotIds);
      const read = data ?? [];
      if (error || read.length !== missingSlotIds.length) {
        setApplyStatus('error');
        setApplyError(
          withLeftSlots(
            `The new time slots could not be read: ${error?.message ?? 'not every slot was returned'}. Nothing was saved, and the review is as it was: apply again.`,
            resolved.made
          )
        );
        return;
      }
      freshRows = read;
    }

    // 3. The final games, their flags and their summary, from the resolved review and the slot rows it is saved in:
    //    the same rules the screen uses, given these rows, never the flags worked out before the slots were known (C9).
    const freshIds = new Set(freshRows.map((row) => String(row.id)));
    const slotRows = [...gameSlotRows.filter((row) => !freshIds.has(String(row.id))), ...freshRows];
    const review = resolved.review;
    // With them, the saved run's own flags of games added before, carried forward while they still hold (C11): an
    // unrelated addition must not clear an open conflict.
    const finalWarnings = addedGameWarningsToSave({
      review,
      slotRows,
      savedWarnings: game?.warnings ?? [],
      savedGames: savedAssignments,
      names: { isExternal: isExternalTeam, fieldName: fieldNameOf, divisionName: divisionNameOf },
    });
    // The generator's own warnings, unchanged, only while the review being applied is the generated one (C12).
    const generatorWarnings =
      schedulerResult && appliedRunWarnings === null
        ? (schedulerResult.evaluation?.warnings ?? [])
        : [];
    // The summary of the games actually saved (C7): a generated review's own summary does not count a game added by
    // hand. The generator's byes and unscheduled games stay; with no generation the save makes it from the games
    // itself, as it always did.
    const finalSummary = schedulerResult
      ? summarizeGameResult({
          assignments: review,
          byes: schedulerResult.byes ?? [],
          unscheduled: schedulerResult.unscheduled ?? [],
        })
      : undefined;

    // 4. Save. The save is told which slots exist: the rows the page holds and those just read, nothing else.
    try {
      const { result } = await persistReviewedAssignments({
        assignments: review,
        generationMode: 'round-robin',
        resultSummary: finalSummary,
        resultDetails: schedulerResult,
        knownSlotIds: new Set(slotRows.map((row) => String(row.id))),
        generatorWarnings,
        extraWarnings: finalWarnings,
      });

      // 5. Only now is anything committed: the slots, the applied games, the review cleared, the result brought to
      //    what the run saved.
      if (freshRows.length > 0) setGameSlotRows(slotRows);
      const appliedRunId = result.runId ?? game?.runId ?? null;
      setLastRollbackAssignments(localAssignments);
      setLocalAssignments(
        review.map((assignment) => ({
          ...assignment,
          runId: appliedRunId,
          assignmentSource: normalizeAssignmentSource(assignment.assignmentSource),
        }))
      );
      setReviewAssignments(null);
      // A generated review's result is what the banner and the readiness panel read after Apply, so its summary is
      // brought to the final games (C7). Its warnings stay the generator's own; what this Apply saved is kept beside
      // them, each set replaced, never appended to (C12).
      setSchedulerResult((current) =>
        current ? { ...current, summary: finalSummary ?? current.summary } : current
      );
      setAppliedRunWarnings({ generator: generatorWarnings, manual: finalWarnings });
      setApplyStatus('applied');
      // A game moved, flipped or regenerated keeps its id, its Published state and its history (the save updates it
      // in place). A game that had a Published history and that the new schedule no longer holds stays in the old run
      // with it. Said, not hidden.
      const leftBehind = leftBehindHistoryGames(review, savedAssignments);
      setStatusMessage(
        `Game schedule applied through the persistence workflow.${
          leftBehind.length > 0 ? leftBehindNote(leftBehind.length) : ''
        }`
      );
      // The games on screen are the staged ones; the saved schedule (its ids and flags) is read again, and the
      // Published controls wait for it.
      markSavedStale();
      refetchSaved?.();
    } catch (err) {
      // The review is left as it was staged; Apply again resolves the same slots (found, not made, this time).
      setApplyStatus('error');
      setApplyError(
        withLeftSlots(err.message || 'Game schedule changes could not be applied.', resolved.made, {
          unknown: isUnknownPersistenceOutcome(err),
        })
      );
      rereadAfterUnknownOutcome(err);
    }
  }, [
    canApplySchedule,
    canManageSchedule,
    currentOrganization?.id,
    divisionNameOf,
    fieldNameOf,
    game?.runId,
    game?.warnings,
    appliedRunWarnings,
    gameSlotRows,
    isExternalTeam,
    localAssignments,
    markSavedStale,
    persistReviewedAssignments,
    refetchSaved,
    rereadAfterUnknownOutcome,
    reviewAssignments,
    savedAssignments,
    applyWaitsForRead,
    schedulerResult,
    withLeftSlots,
  ]);

  const handleRollbackLastApply = useCallback(async () => {
    if (!canManageSchedule || !canApplySchedule || !lastRollbackAssignments) return;

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
      markSavedStale();
      refetchSaved?.();
    } catch (err) {
      setApplyStatus('error');
      setApplyError(err.message || 'Game schedule rollback could not be applied.');
      rereadAfterUnknownOutcome(err);
    }
  }, [
    canApplySchedule,
    canManageSchedule,
    lastRollbackAssignments,
    markSavedStale,
    persistReviewedAssignments,
    refetchSaved,
    rereadAfterUnknownOutcome,
  ]);

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

  // A grid cell's slot, by the slot id in the cell's id (`parseCellId`).
  const slotByCellSlotId = useMemo(
    () => new Map(gameSlots.map((slot) => [String(slot.id), slot])),
    [gameSlots]
  );

  // The one move handler (plan item M4.3): a drop and a "Move to" both stage
  // through it, so the keyboard path cannot drift from the drag path.
  const pendingMoveFocusRef = useRef(null);
  const moveGameTo = useCallback(
    (gameId, targetCellId, { focusMoved = false } = {}) => {
      if (!canEditSchedule) return;
      if (!targetCellId) return;

      const { fieldId: targetFieldId, slotId: targetSlotId } = parseCellId(targetCellId);
      if (!targetFieldId || !targetSlotId) return;

      const targetSlot = slotByCellSlotId.get(targetSlotId);
      const sourceAssignments = displayedAssignmentsRef.current;
      const currentAssignment = sourceAssignments.find((assignment) => {
        return String(assignment.id) === String(gameId);
      });
      if (!currentAssignment) return;

      const cellOf = (assignment) => `${assignment.fieldId}:${assignment.slotId}`;
      const targetCell = `${targetFieldId}:${targetSlotId}`;
      // Put back where it was (a keyboard pick-up and drop, a drop on its own
      // cell): nothing moved, so nothing is staged or marked manual.
      if (cellOf(currentAssignment) === targetCell) return;
      // A Published game is held where it is. The card offers no grip and no "Move to" for it; this is the same
      // refusal for a drop or a call that reaches the handler anyway, before anything is staged. The database
      // refuses the move too (a trigger), so this is the friendly half.
      if (isHeld(currentAssignment)) {
        setApplyError(null);
        setStatusMessage(moveRefusal(currentAssignment));
        return;
      }
      // The grid draws every slot under every field, but a slot is one field's
      // booking: what "Move to" does not offer, a drop does not stage either
      // (`isSlotOnField`, the one rule for both).
      if (!isSlotOnField(targetSlot, targetFieldId)) {
        const fieldName = (id) =>
          fields.find((field) => String(field.id) === String(id))?.name ?? String(id);
        setApplyError(null);
        setStatusMessage(
          `${currentAssignment.homeTeamId} vs ${currentAssignment.awayTeamId} was not moved: ` +
            (targetSlot
              ? `that time slot is booked on ${fieldName(targetSlot.fieldId)}, ` +
                `not ${fieldName(targetFieldId)}.`
              : 'that time slot is not one of this season\u2019s game slots.')
        );
        return;
      }
      // The grid shows one game per cell, so a second game there would hide one.
      const occupant = sourceAssignments.find(
        (assignment) =>
          String(assignment.id) !== String(gameId) && cellOf(assignment) === targetCell
      );
      if (occupant) {
        // Cleared, or a standing apply error would hide the refusal.
        setApplyError(null);
        setStatusMessage(
          `${currentAssignment.homeTeamId} vs ${currentAssignment.awayTeamId} was not moved: ` +
            `that slot already has ${occupant.homeTeamId} vs ${occupant.awayTeamId}.`
        );
        return;
      }

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
        String(assignment.id) === String(gameId) ? updatedAssignment : assignment
      );

      if (focusMoved) pendingMoveFocusRef.current = String(gameId);
      setReviewAssignments(staged);
      setApplyStatus('review');
      setApplyError(null);
      // A game that has been Published and is moved keeps its history and stays not Published until it is published
      // again (the save updates it in place by its id): said here, where the move is staged.
      setStatusMessage(
        (currentAssignment.publishedAt ?? currentAssignment.published_at)
          ? stagedMoveNote(currentAssignment)
          : 'Manual game move staged. Apply the schedule to persist it.'
      );
    },
    [canEditSchedule, fields, slotByCellSlotId]
  );

  const handleDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      setActiveGame(null);
      if (!over?.id) return;
      moveGameTo(active.id, over.id);
    },
    [moveGameTo]
  );

  const claimMoveFocus = useCallback((gameId) => {
    if (pendingMoveFocusRef.current !== gameId) return false;
    pendingMoveFocusRef.current = null;
    return true;
  }, []);

  /**
   * Every cell the grid renders, named for a person: the field and the slot's
   * time. The grid offers every slot under every field; a game slot is one
   * field's booking, so the "Move to" list (below) offers only those.
   */
  const cellLabels = useMemo(() => {
    const labels = new Map();
    for (const field of fields) {
      for (const slot of gameSlots) {
        labels.set(`${field.id}:${slot.id}`, `${field.name ?? field.id}, ${slot.label ?? slot.id}`);
      }
    }
    return labels;
  }, [fields, gameSlots]);

  /** The bookings a game can be moved to: each slot on its own field, with no game in it. */
  const emptyCells = useMemo(() => {
    const taken = new Set(
      displayedAssignments.map((assignment) => `${assignment.fieldId}:${assignment.slotId}`)
    );
    return fields.flatMap((field) =>
      gameSlots
        .filter((slot) => isSlotOnField(slot, field.id))
        .map((slot) => `${field.id}:${slot.id}`)
        .filter((id) => !taken.has(id))
        .map((id) => ({ id, label: cellLabels.get(id) }))
    );
  }, [cellLabels, displayedAssignments, fields, gameSlots]);

  const gameMove = useMemo(
    () => ({ cellLabels, emptyCells, moveGame: moveGameTo, claimFocus: claimMoveFocus }),
    [cellLabels, claimMoveFocus, emptyCells, moveGameTo]
  );

  // ---------------------------------------------------------------------------
  // Add one game by hand (plan docs/changes/2026-11-03-schedule-expansion.md, 5.5, PR 8)
  //
  // A dialog stages one `manual` game into the review, in an open slot (the cells "Move to" offers) or at a new time;
  // Apply saves it like a move. The rules are `planAddedGame`'s: never over a held (Published or scored) slot, a double
  // booking flagged and not blocked, and the game starts not Published.
  // ---------------------------------------------------------------------------
  const [addDialogKey, setAddDialogKey] = useState(/** @type {number | null} */ (null));
  const addKeyRef = useRef(0);
  /** The divisions that play games, each with its teams: the league's own and its outside clubs (4.6). */
  const addDivisions = useMemo(() => {
    const byDivision = new Map();
    const put = (division, entry) => {
      const name = String(division ?? '').trim();
      if (!name || practiceOnly.names.has(name.toLowerCase())) return;
      if (!byDivision.has(name)) byDivision.set(name, new Map());
      byDivision.get(name).set(String(entry.id), entry);
    };
    for (const entry of gameTeams) {
      put(entry.division, { id: entry.id, name: entry.name, isExternal: false });
    }
    for (const entry of seasonTeams) {
      if (entry.divisionId && practiceOnly.ids.has(String(entry.divisionId))) continue;
      put(entry.division, {
        id: entry.id,
        name: entry.name,
        isExternal: entry.isExternal === true,
      });
    }
    return [...byDivision.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, teams]) => ({
        name,
        teams: [...teams.values()].sort(
          (a, b) => Number(a.isExternal) - Number(b.isExternal) || a.name.localeCompare(b.name)
        ),
      }));
  }, [gameTeams, practiceOnly, seasonTeams]);
  const addTeamNames = useMemo(
    () =>
      new Map(
        addDivisions.flatMap((division) =>
          division.teams.map((entry) => [String(entry.id), String(entry.name)])
        )
      ),
    [addDivisions]
  );
  const planAddChoice = useCallback(
    (choice) =>
      planAddedGame(choice, {
        review: displayedAssignmentsRef.current,
        slots: gameSlots,
        teamName: (id) => addTeamNames.get(String(id)) ?? String(id),
        isExternal: isExternalTeam,
        fieldName: fieldNameOf,
        divisionName: divisionNameOf,
        timezone,
        seasonStart: currentSeasonSetting?.season_start ?? null,
        key: addKeyRef.current,
      }),
    [
      addTeamNames,
      currentSeasonSetting?.season_start,
      divisionNameOf,
      fieldNameOf,
      gameSlots,
      isExternalTeam,
      timezone,
    ]
  );
  const openAddGame = useCallback(() => {
    addKeyRef.current += 1;
    setAddDialogKey(addKeyRef.current);
  }, []);
  const stageAddedGame = useCallback(({ game: added, warnings }) => {
    const { home, away } = matchupOf(added);
    setReviewAssignments([...displayedAssignmentsRef.current, added]);
    setApplyStatus('review');
    setApplyError(null);
    setStatusMessage(
      `${home} vs ${away} added to the review as a game placed by hand. It starts not Published.` +
        (added.newSlot ? ` The new time on ${added.fieldName} is made when you apply.` : '') +
        (warnings.length > 0
          ? ` Flagged: ${warnings.map((warning) => warning.message).join(' ')}`
          : '') +
        ' Apply the schedule to save it.'
    );
    setAddDialogKey(null);
  }, []);
  /** Why "Add a game" is off right now, or null. */
  const addGameReason = !canManageSchedule
    ? null
    : savedReadState === 'unreadable'
      ? 'The saved schedule could not be read, so a game cannot be added to it.'
      : savedReadState === 'reading'
        ? 'Reading the saved schedule…'
        : referenceError
          ? 'The fields and game slots could not be read, so a game cannot be placed.'
          : seasonClockLoading
            ? 'Loading this season\u2019s settings…'
            : !timezone
              ? 'This season has no time zone, so a game cannot be placed on its clock.'
              : applyStatus === 'applying' || applyStatus === 'rollingBack'
                ? 'Saving…'
                : schedulerStatus === 'running'
                  ? 'The scheduler is running: add a game once it has finished.'
                  : null;
  const addGameReasonId = useId();

  // The new times of games added by hand, not yet made by the database (C4, review of #731): drawn in the preview grid
  // under their own field so the game is seen and can be moved before Apply. Shown, never offered: "Move to" and a
  // drop still take only the season's real slots (`gameSlots`), and a pending time a game has left is not drawn.
  const pendingAddedSlots = useMemo(
    () =>
      displayedAssignments
        .filter(
          (assignment) =>
            assignment.newSlot && String(assignment.slotId) === assignment.newSlot.placeholderId
        )
        .map((assignment) => ({
          id: assignment.newSlot.placeholderId,
          fieldId: assignment.newSlot.fieldId,
          start: assignment.newSlot.start,
          end: assignment.newSlot.end,
          weekIndex: assignment.newSlot.weekIndex,
          label: `${formatDateTime(assignment.newSlot.start, timezone)} (new time, made on Apply)`,
        })),
    [displayedAssignments, timezone]
  );
  const gridTimeSlots = useMemo(
    () => (pendingAddedSlots.length > 0 ? [...gameSlots, ...pendingAddedSlots] : gameSlots),
    [gameSlots, pendingAddedSlots]
  );

  const gridSensors = useGameGridSensors();

  // What a screen reader hears during a keyboard drag: the game and the cell
  // by name, not dnd-kit's default "draggable item ga-1 ... droppable area v1:gs-2".
  const gridAnnouncements = useMemo(() => {
    const cellLabel = (id) => cellLabels.get(String(id)) ?? 'no slot';
    const gameOf = (id) => displayedAssignmentsRef.current.find((a) => String(a.id) === String(id));
    // A cell `moveGameTo` refuses because its slot is another field's booking. Not the game's
    // own cell, which it treats as put back (a game saved with a field its slot is not on).
    const isOtherFieldsSlot = (activeId, cellId) => {
      const game = gameOf(activeId);
      if (game && `${game.fieldId}:${game.slotId}` === String(cellId)) return false;
      const { fieldId, slotId } = parseCellId(cellId);
      return !isSlotOnField(slotByCellSlotId.get(slotId), fieldId);
    };
    const gameLabel = (id) => {
      const game = gameOf(id);
      return game ? `${game.homeTeamId} vs ${game.awayTeamId}` : 'the game';
    };
    return {
      onDragStart: ({ active }) => `Picked up ${gameLabel(active.id)}.`,
      onDragOver: ({ active, over }) => {
        if (!over) return undefined;
        return isOtherFieldsSlot(active.id, over.id)
          ? `${gameLabel(active.id)} is over ${cellLabel(over.id)}, another field's slot. ` +
              'It cannot be dropped here.'
          : `${gameLabel(active.id)} is over ${cellLabel(over.id)}.`;
      },
      onDragEnd: ({ active, over }) => {
        if (!over) return `${gameLabel(active.id)} was dropped outside the grid and did not move.`;
        if (isOtherFieldsSlot(active.id, over.id)) {
          return `${gameLabel(active.id)} was not moved: ${cellLabel(over.id)} is another field's slot.`;
        }
        // `moveGameTo` refuses a cell that holds another game: say so here too,
        // or the announcement and the status line would disagree.
        const taken = displayedAssignmentsRef.current.some(
          (a) => String(a.id) !== String(active.id) && `${a.fieldId}:${a.slotId}` === over.id
        );
        return taken
          ? `${gameLabel(active.id)} was not moved: ${cellLabel(over.id)} already has a game.`
          : `${gameLabel(active.id)} was dropped on ${cellLabel(over.id)}.`;
      },
      onDragCancel: ({ active }) => `Moving ${gameLabel(active.id)} was cancelled.`,
    };
  }, [cellLabels, slotByCellSlotId]);

  const handleCancelGameAssignment = useCallback(
    (assignment) =>
      cancelGameAssignment(assignment, {
        rpc: async (name, params) => supabase.rpc(name, params),
        say: (text) => {
          setApplyError(null);
          setStatusMessage(text);
        },
        onCancelled: (id) => setLocalAssignments((prev) => prev.filter((a) => a.id !== id)),
      }),
    []
  );

  if (loading.game && !game) {
    return (
      <div className="p-12 text-center animate-fadeIn">
        <ProgressBar progress={45} label="Loading master game schedule..." />
      </div>
    );
  }

  // The page, held in a constant so that the provider around it does not re-indent all of it.
  const page = (
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
          <div className="flex gap-3 items-start">
            <div className="flex flex-col items-end">
              <Button
                variant="secondary"
                onClick={openAddGame}
                disabled={addGameReason !== null}
                aria-describedby={addGameReason ? addGameReasonId : undefined}
                className="flex items-center gap-2"
              >
                <Plus size={18} />
                Add a game
              </Button>
              {addGameReason && (
                <p id={addGameReasonId} className="text-xs text-text-muted mt-1">
                  {addGameReason}
                </p>
              )}
            </div>
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

      {/* Above the conflict banner deliberately: a conflict count computed
          from a schedule that failed to load is not a finding about the
          schedule, and the operator needs to know that first.

          `dataError` is now this page's two sources (`errors.game`, then
          `errors.team`) rather than the hook's aggregate, so a refused
          `practice` read no longer opens an alert about rows the page does
          not render. */}
      <SeasonReadOnlyNote />

      <DataErrorBanner message={dataError} />

      <GameConflictBanner
        warnings={[
          ...(reviewSnapshot?.warnings ?? game?.warnings ?? []),
          ...blackoutWarnings,
          // The staged added games' flags, less those already shown from what the last Apply saved (C12).
          ...addedWarningsNotShown(
            reviewSnapshot?.warnings ?? game?.warnings ?? [],
            addedGameWarnings
          ),
        ]}
      />

      {/* The season's TIME TBD games: not on the grid, so listed here. A game an import gave a date and no time is
          listed with its date (owner, 2026-11-09). Read again when the saved run changes. */}
      <GameTimeTbdSection
        seasonSettingsId={currentSeasonSetting?.id}
        enabled={
          permissions.includes(PERMISSIONS.MANAGE_SCHEDULE) ||
          permissions.includes(PERMISSIONS.MANAGE_ORGANIZATION)
        }
        refreshKey={game?.runId ?? null}
        placed={savedAssignments}
      />

      {(applyStatus !== 'idle' ||
        statusMessage ||
        applyError ||
        schedulerReadinessMessage ||
        unplaceableSlotMessage) && (
        <section className="glass-panel p-4 border border-border-subtle" aria-live="polite">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 text-sm">
              {applyStatus === 'applied' ? (
                <CheckCircle size={18} className="text-status-success-text mt-0.5" />
              ) : applyStatus === 'error' ? (
                <XCircle size={18} className="text-status-error-text mt-0.5" />
              ) : (
                <RotateCcw size={18} className="text-text-accent mt-0.5" />
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
                <p className={applyError ? 'text-status-error-text' : 'text-text-muted'}>
                  {applyError ||
                    statusMessage ||
                    schedulerReadinessMessage ||
                    'Review the staged schedule before applying it.'}
                </p>
                {/* Its own line, not an `||` arm, and **only** here. A slot with
                    no clock is still unplaceable after an apply succeeds, so a
                    message that `statusMessage` displaces the moment anything
                    else happens reports the fact once and then stops -- a
                    silent drop wearing a banner. It used to ALSO be appended
                    into `schedulerReadinessMessage`, which is the arm directly
                    above, so whenever there was no apply error and no status
                    message -- the common case -- the operator read it twice. */}
                {unplaceableSlotMessage && (
                  <p className="text-status-warning-text mt-1">{unplaceableSlotMessage}</p>
                )}
                {canManageSchedule &&
                  !canApplySchedule &&
                  (isReviewing || lastRollbackAssignments) && (
                    <p id="game-apply-admin-only" className="mt-1 text-text-muted">
                      Only an organization admin can apply a game schedule.
                    </p>
                  )}
                {/* The saved schedule is read again after an Apply; the next Apply waits for it, because the flags it
                    carries forward come from it (C12). */}
                {canApplySchedule && isReviewing && applyWaitsForRead && (
                  <p id="game-apply-waits-for-read" className="mt-1 text-text-muted">
                    Apply waits while the saved schedule is read again.
                  </p>
                )}
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
                  disabled={applyStatus === 'applying' || !canApplySchedule || applyWaitsForRead}
                  aria-describedby={
                    !canApplySchedule
                      ? 'game-apply-admin-only'
                      : applyWaitsForRead
                        ? 'game-apply-waits-for-read'
                        : undefined
                  }
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
                disabled={applyStatus === 'rollingBack' || !canApplySchedule}
                aria-describedby={canApplySchedule ? undefined : 'game-apply-admin-only'}
              >
                Rollback Last Apply
              </Button>
            )}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <GamePublishedBar
            saved={savedAssignments}
            status={savedReadState}
            canChange={canChangePublished}
            reason={publishedReason}
            reasonId={publishedReasonId}
            controlsOff={publishedReason !== null}
            timezone={timezone}
            venueOf={gameVenueName}
            showFilter={showPublishedFilter}
            filter={listFilter}
            onFilterChange={setListFilter}
            notice={publishNotice}
            summaryRef={summaryRef}
            onPublish={({ ids, scope }) => publishGames({ ids, scope })}
            onAllowChanges={({ games, scope }) => openAllowChanges(games, scope)}
          />
          <div className="bg-bg-glass border border-border-subtle rounded-xl overflow-hidden shadow-md">
            {/* The view tabs are the shared `Tabs` primitive: the selected one carries an
                underline and `aria-selected`, not only a colour (WCAG 1.4.1). The bar's
                bottom padding matches `.page-tabs`' negative margin, so the underline sits on
                the bar's border. */}
            <div className="px-6 pb-3 border-b border-border-subtle bg-bg-glass">
              <Tabs
                tabs={[
                  { id: 'full', label: 'Full Schedule' },
                  {
                    id: 'team',
                    label: 'By Team',
                    disabled: canEditSchedule,
                    describedBy: canEditSchedule ? byTeamReasonId : undefined,
                  },
                ]}
                activeTab={shownTab}
                onChange={setActiveTab}
                panelId={viewPanelId}
                label="Game schedule views"
              />
            </div>

            <div
              className="p-0"
              id={viewPanelId}
              role="tabpanel"
              aria-label={shownTab === 'full' ? 'Full Schedule' : 'By Team'}
            >
              {canEditSchedule ? (
                <div className="p-4 overflow-x-auto">
                  {/* Manual Override edits the field grid; a team's list has nothing to move a
                      game to, so By Team waits until the override is exited (the choice made
                      before it is kept). */}
                  <p id={byTeamReasonId} className="mb-3 text-xs text-text-secondary">
                    By Team is off during Manual Override: games are moved on the field grid.
                  </p>
                  <DndContext
                    sensors={gridSensors}
                    accessibility={{
                      announcements: gridAnnouncements,
                      screenReaderInstructions: { draggable: GRID_DRAG_INSTRUCTIONS },
                    }}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                  >
                    <GameMoveContext.Provider value={gameMove}>
                      <GameScheduleGrid
                        assignments={displayedAssignments}
                        fields={fields}
                        timeSlots={gridTimeSlots}
                        conflictSet={conflictSet}
                        activeGameId={activeGame?.id}
                        timezone={timezone}
                      />
                    </GameMoveContext.Provider>
                    <DragOverlay>
                      {activeGame ? <GameCardPreview assignment={activeGame} /> : null}
                    </DragOverlay>
                  </DndContext>
                </div>
              ) : activeTab === 'full' ? (
                showPublishedFilter &&
                listFilter !== 'all' &&
                listAssignments.length === 0 &&
                displayedAssignments.length > 0 ? (
                  <p className="p-6 text-sm text-text-muted" data-testid="published-filter-empty">
                    {`No saved games are ${
                      PUBLISHED_FILTERS.find((item) => item.id === listFilter)?.label ?? listFilter
                    }.`}
                  </p>
                ) : (
                  <GameScheduleList
                    assignments={listAssignments}
                    timezone={timezone}
                    onEditSchedule={canManageSchedule ? handleAutoGenerate : undefined}
                    onCancelAssignment={
                      canCancelAssignments ? handleCancelGameAssignment : undefined
                    }
                  />
                )
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
          {addedGamesStaged && canManageSchedule && (
            <p className="text-sm text-text-muted" data-testid="generate-waits-for-added">
              Generating is off while a game added by hand is staged: a new schedule would drop it.
              Apply or discard the review first.
            </p>
          )}
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
          />

          <PracticeOnlyDivisions divisions={divisionPlan.practiceOnlyDivisions} />
        </div>
      </div>

      {allowDialog && (
        <AllowChangesDialog
          key={allowDialog.key}
          open
          games={allowDialog.games}
          scopeText={
            allowDialog.scope.kind === 'selection' ? null : describeScope(allowDialog.scope)
          }
          busy={publishBusy}
          notice={dialogNotice}
          onConfirm={confirmAllowChanges}
          onClose={() => setAllowDialog(null)}
        />
      )}
      {addDialogKey !== null && (
        <AddGameDialog
          key={addDialogKey}
          open
          divisions={addDivisions}
          openSlots={emptyCells}
          fields={fields.map((field) => ({
            id: String(field.id),
            name: String(field.name ?? field.id),
          }))}
          plan={planAddChoice}
          onAdd={stageAddedGame}
          onClose={() => setAddDialogKey(null)}
        />
      )}
      {historyGame && currentOrganization?.id && (
        <GameHistoryDialog
          key={String(historyGame.id)}
          open
          game={historyGame}
          organizationId={currentOrganization.id}
          timezone={timezone}
          onClose={() => setHistoryGame(null)}
        />
      )}
    </div>
  );

  return (
    <GamePublishedContext.Provider value={publishedContext}>{page}</GamePublishedContext.Provider>
  );
}

/**
 * The divisions that play no games (D2): listed so their teams read as meant
 * to have no fixtures, not as unscheduled.
 *
 * @param {{ divisions: Array<{ division: string, teamIds: string[] }> }} props
 */
function PracticeOnlyDivisions({ divisions }) {
  const headingId = useId();
  if (!divisions.length) return null;
  return (
    <section className="section-panel glass-panel" aria-labelledby={headingId}>
      <header className="section-header">
        <h2 id={headingId}>Practice only</h2>
      </header>
      <p className="text-sm text-text-muted">
        These divisions play no games, so the scheduler builds them no fixtures. Their teams still
        practise.
      </p>
      <ul className="mt-2 space-y-1 text-sm text-text-primary">
        {divisions.map((entry) => (
          <li key={entry.division}>
            <span className="font-semibold">{entry.division}</span>
            {` \u00b7 ${entry.teamIds.length} team${entry.teamIds.length === 1 ? '' : 's'}, no games`}
          </li>
        ))}
      </ul>
    </section>
  );
}

function GameScheduleList({ assignments, timezone, onEditSchedule, onCancelAssignment }) {
  if (!assignments || assignments.length === 0) {
    return (
      <div className="glass-panel p-12 text-center animate-fadeIn border-brand-400/20 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
          <Trophy size={120} className="text-text-accent" />
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
            <th className="p-4 text-xs font-semibold text-text-muted uppercase tracking-wider">
              Published
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
              <td className="p-4">
                <PublishedControls assignment={a} className="" />
              </td>
              {onCancelAssignment && (
                <td className="p-4 text-right">
                  {a.persisted && (
                    <button
                      type="button"
                      className="p-1.5 rounded text-text-muted hover:text-status-error-text hover:bg-red-500/10 transition-colors"
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
  const selectTeamHeadingId = useId();
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
        {/* A name for the group of team buttons, not a <label>: there is no one
            control for it to label (jsx-a11y label-has-associated-control). */}
        <p
          id={selectTeamHeadingId}
          className="block text-xs font-semibold uppercase tracking-wider text-text-muted mb-2"
        >
          Select Team
        </p>
        <div
          role="group"
          aria-labelledby={selectTeamHeadingId}
          className="grid grid-cols-2 sm:grid-cols-3 gap-2"
        >
          {teams.map((team) => (
            <button
              type="button"
              key={team.id}
              aria-pressed={selectedTeamId === team.id}
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
              <Trophy size={120} className="text-text-accent" />
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
