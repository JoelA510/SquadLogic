/**
 * One game added by hand on the Games page (plan `docs/changes/2026-11-03-schedule-expansion.md`, 5.5, PR 8, task H1).
 *
 * The rules, in one place, so the dialog, the page's Apply and their tests agree:
 *
 * - **A slot that holds a Published game (or one with a score) is never added over.** That is a blocker the owner keeps
 *   ("the Published, held or scored guard", 2026-11-09 entry 2); {@link heldGameAt} is the one test of it, asked when
 *   the game is staged and again on Apply, when the database has said which slot a new time is.
 * - **A double booking is flagged, not blocked** (owner, 2026-11-09: "warnings, not blockers"): a team already playing
 *   at that time, or a field already in use at that time ({@link doubleBookings}). An outside club stands for several
 *   real teams, so it is never double-booked (the import's rule, `20261122010000`).
 * - **The game starts not Published**, as a `manual` game with no id: the save inserts it, and the save never writes the
 *   flag (`persist_game_schedule`).
 * - A new time is a slot the database finds or makes (`ensure_game_slot`, on Apply): the page matches it here by the
 *   database's own key (field, date, start time), so a time that IS an existing slot is that slot.
 *
 * @module gameAddByHand
 */
import { isHeld } from '@squadlogic/core/gameIdentity.js';
import { scheduleWeekOf } from '@squadlogic/core/scheduleImport/parseRows.js';
import { requireZonedInstant } from '@squadlogic/core/timing/index.js';
import { formatDateTime } from './formatters.js';
import { matchupOf } from './gamePublishedText.js';
import { isSlotOnField, parseCellId } from './gameGridCells.js';

/** The placeholder slot id of a new time, until Apply has the database's. */
export const NEW_SLOT_PREFIX = 'new-slot-';

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
 * The held game (Published, or with a score) in a slot, other than `exceptId`, or null. The one test of "never added
 * over a Published slot".
 *
 * @param {string} slotId
 * @param {ReadonlyArray<Record<string, any>>} games
 * @param {unknown} [exceptId]
 */
export function heldGameAt(slotId, games, exceptId = undefined) {
  return (
    games.find(
      (game) => sameId(game.slotId, slotId) && !sameId(game.id, exceptId) && isHeld(game)
    ) ?? null
  );
}

/** The sentence for a held slot. */
export function heldSlotRefusal(held) {
  const { home, away } = matchupOf(held);
  return held.published === true
    ? `${home} vs ${away} is Published in that slot, so no game is added there. Choose another slot or time, or use Allow changes on that game first.`
    : `${home} vs ${away} has a score in that slot, so no game is added there. Choose another slot or time.`;
}

/**
 * The double bookings of a candidate game against the others: a team (not an outside club) already playing, or the
 * field already in use, at an overlapping time. Each a warning the conflict banner shows; none refuses.
 *
 * @param {Record<string, any>} candidate - `homeTeamId`, `awayTeamId`, `fieldId`, `start`, `end`
 * @param {ReadonlyArray<Record<string, any>>} others
 * @param {{ isExternal: (teamId: string) => boolean, fieldName: (fieldId: string) => string }} names
 * @returns {Array<{ type: string, message: string, details: Record<string, any> }>}
 */
export function doubleBookings(candidate, others, { isExternal, fieldName }) {
  const start = instant(candidate.start);
  const end = instant(candidate.end);
  if (start === null || end === null) return [];
  const warnings = [];
  const clashing = others.filter((game) => {
    if (sameId(game.id, candidate.id)) return false;
    const s = instant(game.start);
    const e = instant(game.end);
    return s !== null && e !== null && s < end && start < e;
  });
  const { home, away } = matchupOf(candidate);
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
      details: { teamId, gameIds: [other.id] },
    });
  }
  const onField = clashing.find((game) => sameId(game.fieldId, candidate.fieldId));
  if (onField) {
    const o = matchupOf(onField);
    warnings.push({
      type: 'field-overlap',
      message: `${fieldName(candidate.fieldId)} already has ${o.home} vs ${o.away} at that time.`,
      details: { fieldId: candidate.fieldId, gameIds: [onField.id] },
    });
  }
  return warnings;
}

/**
 * The staged game for a complete choice ({@link addGameFormProblem} said null), or why it is refused.
 *
 * @param {Record<string, any>} choice
 * @param {{ review: ReadonlyArray<Record<string, any>>, slots: ReadonlyArray<Record<string, any>>,
 *   fields: ReadonlyArray<{ id: string, name?: string }>, teams: Map<string, { name?: string, isExternal?: boolean }>,
 *   timezone: string | null | undefined, seasonStart: string | null | undefined, key: number }} ctx
 * @returns {{ refusal: string } | { game: Record<string, any>, warnings: Array<{ type: string, message: string, details: Record<string, any> }> }}
 */
export function planAddedGame(choice, ctx) {
  const fieldName = (id) =>
    ctx.fields.find((field) => sameId(field.id, id))?.name ?? String(id ?? '');
  const team = (id) => ctx.teams.get(String(id));
  const isExternal = (id) => team(id)?.isExternal === true;

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
    if (!slot) {
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
        placeholderId: `${NEW_SLOT_PREFIX}${ctx.key}`,
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

  if (slot) {
    const held = heldGameAt(slot.id, ctx.review);
    if (held) return { refusal: heldSlotRefusal(held) };
    // One place holds one game of a pair (the save's unique matchup, slot and week): a necessary refusal, said here
    // rather than as the save's identity conflict.
    const twin = ctx.review.find(
      (game) =>
        sameId(game.slotId, slot.id) &&
        Number(game.weekIndex) === Number(slot.weekIndex) &&
        sameId(game.homeTeamId, choice.homeTeamId) &&
        sameId(game.awayTeamId, choice.awayTeamId)
    );
    if (twin) {
      const { home, away } = matchupOf(twin);
      return { refusal: `${home} vs ${away} is already in that slot, so it is not added again.` };
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
    homeTeamName: team(choice.homeTeamId)?.name ?? choice.homeTeamId,
    awayTeamName: team(choice.awayTeamId)?.name ?? choice.awayTeamId,
    slotId: slot ? slot.id : newSlot?.placeholderId,
    gameSlotId: slot ? slot.id : newSlot?.placeholderId,
    fieldId,
    fieldName: fieldName(fieldId),
    start: slot ? slot.start : newSlot?.start,
    end: slot ? slot.end : newSlot?.end,
    kickoff: slot ? slot.start : newSlot?.start,
    weekIndex: slot ? slot.weekIndex : newSlot?.weekIndex,
    assignmentSource: 'manual',
    ...(newSlot ? { newSlot } : {}),
  };
  return { game, warnings: doubleBookings(game, ctx.review, { isExternal, fieldName }) };
}

/** A new time's slot as a person reads it: the field, and when it starts on the season's clock. */
export function describeNewSlot(newSlot, fieldName, timezone) {
  return `${fieldName}, ${formatDateTime(newSlot.start, timezone)}`;
}

/**
 * On Apply: the database's slot for each new time in the review (`ensure_game_slot`), in order, and the review with
 * those ids in place. A slot the database returns that holds a held game refuses the whole Apply before anything is
 * saved. Throws an Error (its `madeSlots` lists the slots made so far) on a refusal or a failed call.
 *
 * @param {ReadonlyArray<Record<string, any>>} review
 * @param {(newSlot: Record<string, any>) => Promise<{ id: string, created: boolean }>} ensureSlot
 * @returns {Promise<{ review: Array<Record<string, any>>, made: Array<Record<string, any>>, slotIds: Set<string> }>}
 */
export async function resolveAddedSlots(review, ensureSlot) {
  const made = [];
  const slotIds = new Set();
  const next = [...review];
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
    const held = heldGameAt(found.id, next, game.id);
    if (held) throw Object.assign(new Error(heldSlotRefusal(held)), { madeSlots: made });
    slotIds.add(String(found.id));
    const { newSlot: _resolved, ...rest } = game;
    next[index] = { ...rest, slotId: found.id, gameSlotId: found.id };
  }
  return { review: next, made, slotIds };
}
