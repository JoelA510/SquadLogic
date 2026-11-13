/**
 * One game added by hand on the Games page (plan `docs/changes/2026-11-03-schedule-expansion.md`, 5.5, PR 8, task H1).
 *
 * The rules, in one place, so the dialog, the page's Apply and their tests agree:
 *
 * - **One game per slot.** A slot that already holds a game is never added to: the grid draws one game per cell, and a
 *   schedule that hides a game is the worst failure here (the coordinator's review of #731). A slot holding a Published
 *   or scored game says so in the hold's own words (`holdReason`, "the Published, held or scored guard": owner,
 *   2026-11-09, entry 2). {@link occupantAt} is the one test, asked when the game is staged and again on Apply, once the
 *   database has said which slot a new time is.
 * - **A new time that is an existing slot must be that slot as it is.** The database finds a slot by field, date and
 *   start time (`ensure_game_slot`), so a new time with another end is refused in words, never silently given the
 *   slot's end (as the practice import's slot-differs), and on Apply a found slot whose week, start or end differs from
 *   what the page worked out refuses the Apply.
 * - **A double booking is flagged, not blocked** (owner, 2026-11-09: "warnings, not blockers"): a team already playing,
 *   or a field already in use, at an overlapping time ({@link addedGameWarnings}). An outside club stands for several
 *   real teams, so it is never double-booked (the import's rule, `20261122010000`). A slot reserved for another
 *   division is flagged too. Each clash is said once ({@link uniqueWarnings}).
 * - **The game starts not Published**, as a `manual` game with no id: the save inserts it, and the save never writes the
 *   flag (`persist_game_schedule`).
 *
 * @module gameAddByHand
 */
import { holdReason } from '@squadlogic/core/gameIdentity.js';
import { wallOfInstant } from '@squadlogic/core/reports/wall.js';
import { scheduleWeekOf } from '@squadlogic/core/scheduleImport/parseRows.js';
import { requireZonedInstant } from '@squadlogic/core/timing/index.js';
import { formatDateTime } from './formatters.js';
import { matchupOf } from './gamePublishedText.js';
import { isSlotOnField, parseCellId } from './gameGridCells.js';

const hhmm = (time) => String(time ?? '').slice(0, 5);
const instant = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Why the form cannot be added yet, in words, or null when it is complete. Not a refusal: what is missing.
 *
 * @param {{ division?: string, homeTeamId?: string, awayTeamId?: string, where?: string, cellId?: string,
 *   fieldId?: string, date?: string, startTime?: string, endTime?: string }} choice
 * @returns {string | null}
 */
export function addGameFormProblem(choice) {
  if (!choice.division) return 'Choose a division.';
  if (!choice.homeTeamId) return 'Choose the home team.';
  if (!choice.awayTeamId) return 'Choose the away team.';
  if (sameId(choice.homeTeamId, choice.awayTeamId)) return 'Choose two different teams.';
  if (choice.where === 'slot') return choice.cellId ? null : 'Choose an open slot.';
  if (choice.where !== 'new') return 'Choose where it is played.';
  if (!choice.fieldId) return 'Choose a field.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(choice.date ?? '')) return 'Give the date.';
  if (!/^\d{2}:\d{2}$/.test(hhmm(choice.startTime))) return 'Give the start time.';
  if (!/^\d{2}:\d{2}$/.test(hhmm(choice.endTime))) return 'Give the end time.';
  if (hhmm(choice.endTime) <= hhmm(choice.startTime)) return 'The game must end after it starts.';
  return null;
}

/**
 * The game already in a slot, other than `exceptId`, or null: a held one (Published, or with a score) first, so its
 * refusal says why it is held. The one test of "one game per slot".
 *
 * @param {string} slotId
 * @param {ReadonlyArray<Record<string, any>>} games
 * @param {unknown} [exceptId]
 */
export function occupantAt(slotId, games, exceptId = undefined) {
  const inSlot = games.filter((game) => sameId(game.slotId, slotId) && !sameId(game.id, exceptId));
  return inSlot.find((game) => holdReason(game) !== null) ?? inSlot[0] ?? null;
}

/** Why a game is not added to a slot that holds `occupant`, for the pair `homeTeamId` v `awayTeamId`. */
function occupiedRefusal(occupant, homeTeamId, awayTeamId) {
  const { home, away } = matchupOf(occupant);
  const held = holdReason(occupant);
  if (held === 'published') {
    return `${home} vs ${away} is Published in that slot, so no game is added there. Choose another slot or time, or use Allow changes on that game first.`;
  }
  if (held === 'scored') {
    return `${home} vs ${away} has a score in that slot, so no game is added there. Choose another slot or time.`;
  }
  if (sameId(occupant.homeTeamId, homeTeamId) && sameId(occupant.awayTeamId, awayTeamId)) {
    return `${home} vs ${away} is already in that slot, so it is not added again.`;
  }
  return `${home} vs ${away} is already in that slot. A slot holds one game: move that game first, or choose another slot or time.`;
}

/**
 * The division a slot is reserved for: by its `division_id` (the page's read of `divisions`), else the name it carries,
 * else null (any division).
 *
 * @param {Record<string, any> | null | undefined} slot
 * @param {(divisionId: string) => string | null} divisionName
 * @returns {string | null}
 */
export function reservedDivisionOf(slot, divisionName) {
  if (!slot) return null;
  const id = slot.division_id ?? slot.divisionId;
  return (id ? divisionName(id) : null) ?? slot.division ?? null;
}

/**
 * The warnings a staged game raises against the rest of the review, none a refusal: a team (not an outside club)
 * already playing, or the field already in use, at an overlapping time; and a slot reserved for another division.
 * Everything is read from where the game is NOW (its slot, field and times), never from when it was added, so a game
 * moved with "Move to" is judged in its new place (review of #731, C5).
 *
 * @param {Record<string, any>} candidate - `id`, `homeTeamId`, `awayTeamId`, `slotId`, `fieldId`, `start`, `end`,
 *   `division`
 * @param {ReadonlyArray<Record<string, any>>} others
 * @param {{ isExternal: (teamId: string) => boolean, fieldName: (fieldId: string) => string,
 *   slotDivision: (slotId: string) => string | null }} names
 * @returns {Array<{ type: string, message: string, details: Record<string, any> }>}
 */
export function addedGameWarnings(candidate, others, { isExternal, fieldName, slotDivision }) {
  const warnings = [];
  const { home, away } = matchupOf(candidate);
  const reserved = slotDivision(candidate.slotId);
  if (reserved && reserved !== candidate.division) {
    warnings.push({
      type: 'slot-other-division',
      message: `${home} vs ${away} is in a slot reserved for ${reserved}.`,
      details: { gameIds: [candidate.id] },
    });
  }
  const start = instant(candidate.start);
  const end = instant(candidate.end);
  if (start === null || end === null) return warnings;
  const clashing = others.filter((game) => {
    if (sameId(game.id, candidate.id)) return false;
    const s = instant(game.start);
    const e = instant(game.end);
    return s !== null && e !== null && s < end && start < e;
  });
  for (const [teamId, teamName] of [
    [candidate.homeTeamId, home],
    [candidate.awayTeamId, away],
  ]) {
    if (isExternal(teamId)) continue;
    const other = clashing.find(
      (game) => sameId(game.homeTeamId, teamId) || sameId(game.awayTeamId, teamId)
    );
    if (!other) continue;
    const o = matchupOf(other);
    warnings.push({
      type: 'team-double-booked',
      message: `${teamName} already plays ${o.home} vs ${o.away} at that time.`,
      details: { teamId, gameIds: [candidate.id, other.id] },
    });
  }
  const onField = clashing.find((game) => sameId(game.fieldId, candidate.fieldId));
  if (onField) {
    const o = matchupOf(onField);
    warnings.push({
      type: 'field-overlap',
      message: `${fieldName(candidate.fieldId)} already has ${o.home} vs ${o.away} at that time.`,
      details: { fieldId: candidate.fieldId, gameIds: [candidate.id, onField.id] },
    });
  }
  return warnings;
}

/**
 * Each clash once: two added games that clash raise the same warning from both sides, keyed by its type, its team or
 * field, and the unordered pair of games.
 *
 * @template {{ type: string, details?: Record<string, any> }} W
 * @param {ReadonlyArray<W>} warnings
 * @returns {W[]}
 */
export function uniqueWarnings(warnings) {
  const seen = new Set();
  return warnings.filter((warning) => {
    const d = warning.details ?? {};
    const pair = [...(d.gameIds ?? [])].map(String).sort().join('+');
    const key = `${warning.type}|${d.teamId ?? d.fieldId ?? ''}|${pair}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A slot's end on the wall, `HH:MM`, from its column or else its instant. */
function slotEndWall(slot, timezone) {
  if (slot.end_time) return hhmm(slot.end_time);
  return wallOfInstant(slot.end, timezone)?.time ?? null;
}

/**
 * The staged game for a complete choice ({@link addGameFormProblem} said null), or why it is refused.
 *
 * @param {Record<string, any>} choice
 * @param {{ review: ReadonlyArray<Record<string, any>>, slots: ReadonlyArray<Record<string, any>>,
 *   teamName: (teamId: string) => string, isExternal: (teamId: string) => boolean,
 *   fieldName: (fieldId: string) => string, divisionName: (divisionId: string) => string | null,
 *   timezone: string | null | undefined, seasonStart: string | null | undefined, key: number }} ctx
 * @returns {{ refusal: string } | { game: Record<string, any>, warnings: Array<{ type: string, message: string, details: Record<string, any> }> }}
 */
export function planAddedGame(choice, ctx) {
  /** @type {Record<string, any> | null} */
  let slot = null;
  let fieldId = null;
  /** @type {Record<string, any> | undefined} */
  let newSlot;
  if (choice.where === 'slot') {
    const parsed = parseCellId(choice.cellId);
    slot = ctx.slots.find((s) => sameId(s.id, parsed.slotId)) ?? null;
    if (!slot || !isSlotOnField(slot, parsed.fieldId)) {
      return { refusal: 'That slot is not one of this season’s game slots on that field.' };
    }
    fieldId = parsed.fieldId;
  } else {
    fieldId = choice.fieldId;
    // The database's key for a slot (`ensure_game_slot`): the field, the date and the start time.
    slot =
      ctx.slots.find(
        (s) =>
          sameId(s.fieldId ?? s.field_id, fieldId) &&
          String(s.slot_date ?? '') === choice.date &&
          hhmm(s.start_time) === hhmm(choice.startTime)
      ) ?? null;
    if (slot) {
      const occupant = occupantAt(slot.id, ctx.review);
      if (occupant) {
        return { refusal: occupiedRefusal(occupant, choice.homeTeamId, choice.awayTeamId) };
      }
      const end = slotEndWall(slot, ctx.timezone);
      if (end !== hhmm(choice.endTime)) {
        return {
          refusal: `That time is an existing slot on ${ctx.fieldName(fieldId)}, and it ends at ${end ?? 'another time'}, not ${hhmm(choice.endTime)}. Pick it as an open slot, or choose another time.`,
        };
      }
    } else {
      // Another staged game at this very new time: once Apply makes the slot, it would be its occupant.
      const pendingTwin = ctx.review.find(
        (game) =>
          game.newSlot &&
          sameId(game.slotId, game.newSlot.placeholderId) &&
          sameId(game.newSlot.fieldId, fieldId) &&
          game.newSlot.date === choice.date &&
          game.newSlot.startTime === hhmm(choice.startTime)
      );
      if (pendingTwin) {
        return { refusal: occupiedRefusal(pendingTwin, choice.homeTeamId, choice.awayTeamId) };
      }
      if (!ctx.seasonStart) {
        return {
          refusal:
            'The season has no start date, so the week of a new time cannot be worked out. Choose an open slot, or set the season’s start date first.',
        };
      }
      const weekIndex = scheduleWeekOf(choice.date, ctx.seasonStart);
      if (weekIndex < 1) {
        return {
          refusal: `${choice.date} is before the season starts (${ctx.seasonStart}), so it has no week.`,
        };
      }
      if (weekIndex > 255) return { refusal: `${choice.date} is too far after the season starts.` };
      let start;
      let end;
      try {
        start = requireZonedInstant({
          date: choice.date,
          time: hhmm(choice.startTime),
          timeZone: ctx.timezone,
          label: 'game start',
        });
        end = requireZonedInstant({
          date: choice.date,
          time: hhmm(choice.endTime),
          timeZone: ctx.timezone,
          label: 'game end',
        });
      } catch (err) {
        return { refusal: err instanceof Error ? err.message : String(err) };
      }
      newSlot = {
        placeholderId: `new-slot-${ctx.key}`,
        fieldId,
        date: choice.date,
        startTime: hhmm(choice.startTime),
        endTime: hhmm(choice.endTime),
        weekIndex,
        start,
        end,
      };
    }
  }

  if (slot && choice.where === 'slot') {
    const occupant = occupantAt(slot.id, ctx.review);
    if (occupant) {
      return { refusal: occupiedRefusal(occupant, choice.homeTeamId, choice.awayTeamId) };
    }
  }

  const game = {
    id: `added-${ctx.key}`,
    persisted: false,
    addedByHand: true,
    published: false,
    division: choice.division,
    homeTeamId: choice.homeTeamId,
    awayTeamId: choice.awayTeamId,
    homeTeamName: ctx.teamName(choice.homeTeamId),
    awayTeamName: ctx.teamName(choice.awayTeamId),
    slotId: slot ? slot.id : newSlot?.placeholderId,
    gameSlotId: slot ? slot.id : newSlot?.placeholderId,
    fieldId,
    fieldName: ctx.fieldName(fieldId),
    start: slot ? slot.start : newSlot?.start,
    end: slot ? slot.end : newSlot?.end,
    kickoff: slot ? slot.start : newSlot?.start,
    weekIndex: slot ? slot.weekIndex : newSlot?.weekIndex,
    assignmentSource: 'manual',
    ...(newSlot ? { newSlot } : {}),
  };
  return {
    game,
    warnings: uniqueWarnings(
      addedGameWarnings(game, ctx.review, {
        isExternal: ctx.isExternal,
        fieldName: ctx.fieldName,
        slotDivision: (slotId) =>
          reservedDivisionOf(
            ctx.slots.find((s) => sameId(s.id, slotId)),
            ctx.divisionName
          ),
      })
    ),
  };
}

/** A new time's slot as a person reads it: the field, and when it starts on the season's clock. */
export function describeNewSlot(newSlot, fieldName, timezone) {
  return `${fieldName}, ${formatDateTime(newSlot.start, timezone)}`;
}

/**
 * How a slot the database already had differs from the new time the page worked out, in words, or null.
 *
 * @param {Record<string, any>} pending - the staged `newSlot`
 * @param {Record<string, any>} row - the `game_slots` row the database returned
 */
function slotDifference(pending, row) {
  const diffs = [];
  if (Number(row.week_index) !== Number(pending.weekIndex)) {
    diffs.push(`it is in week ${row.week_index}, not week ${pending.weekIndex}`);
  }
  if (row.end_time && hhmm(row.end_time) !== pending.endTime) {
    diffs.push(`it ends at ${hhmm(row.end_time)}, not ${pending.endTime}`);
  }
  const startMs = instant(row.start);
  const endMs = instant(row.end);
  if (startMs !== null && startMs !== instant(pending.start))
    diffs.push('it starts at another instant');
  if (endMs !== null && endMs !== instant(pending.end)) diffs.push('it ends at another instant');
  return diffs.length > 0 ? diffs.join('; ') : null;
}

/**
 * Two games of one pair at one place (pair, slot, week): the save's unique key, refused before the save. Null when
 * there are none.
 *
 * @param {ReadonlyArray<Record<string, any>>} review
 */
export function duplicateTupleRefusal(review) {
  const seen = new Map();
  for (const game of review) {
    const key = [game.homeTeamId, game.awayTeamId, game.slotId, game.weekIndex]
      .map(String)
      .join('|');
    const first = seen.get(key);
    if (first) return occupiedRefusal(first, game.homeTeamId, game.awayTeamId);
    seen.set(key, game);
  }
  return null;
}

/**
 * On Apply: the database's slot for each new time in the review (`ensure_game_slot`), in order, and the review with
 * those ids in place. Refused before anything is saved, with every slot made so far on the error (`madeSlots`): a slot
 * the database returns that holds a game, one it already had that differs from the new time (its week, start or end),
 * and two games of one pair at one place.
 *
 * @param {ReadonlyArray<Record<string, any>>} review
 * @param {(newSlot: Record<string, any>) => Promise<{ id: string, created: boolean, row?: Record<string, any> }>} ensureSlot
 *   - `row` is the slot as stored, read back when the database did not make it
 * @param {{ fieldName: (fieldId: string) => string }} names
 * @returns {Promise<{ review: Array<Record<string, any>>, made: Array<Record<string, any>>, slotIds: Set<string> }>}
 */
export async function resolveAddedSlots(review, ensureSlot, { fieldName }) {
  const made = [];
  const slotIds = new Set();
  const next = [...review];
  const refuse = (message) => Object.assign(new Error(message), { madeSlots: made });
  for (const [index, game] of review.entries()) {
    const pending = game.newSlot;
    if (!pending || !sameId(game.slotId, pending.placeholderId)) continue;
    let found;
    try {
      found = await ensureSlot(pending);
    } catch (err) {
      // Annotated and rethrown: the caller says which slots this Apply has already made.
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { madeSlots: made });
    }
    if (found.created) made.push(pending);
    const occupant = occupantAt(found.id, next, game.id);
    if (occupant) throw refuse(occupiedRefusal(occupant, game.homeTeamId, game.awayTeamId));
    if (!found.created) {
      const differs = found.row ? slotDifference(pending, found.row) : 'it could not be read back';
      if (differs) {
        throw refuse(
          `The database already has a slot on ${fieldName(pending.fieldId)} at ${pending.date} ${pending.startTime}, but ${differs}. Nothing was saved: pick that slot as an open slot, or choose another time.`
        );
      }
    }
    slotIds.add(String(found.id));
    const { newSlot: _resolved, ...rest } = game;
    next[index] = { ...rest, slotId: found.id, gameSlotId: found.id };
  }
  const duplicate = duplicateTupleRefusal(next);
  if (duplicate) throw refuse(duplicate);
  return { review: next, made, slotIds };
}
