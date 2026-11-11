/**
 * The TIME TBD list: practices a team is still short of and games the scheduler could not place
 * (Phase D, E; plan `docs/changes/2026-10-27-phase-d-scheduling.md`, section E).
 *
 * **Where the list lives.** `public.schedule_tbd` (migration `20261108020000`), a table of its own
 * and not rows in `practice_assignments` / `game_assignments`: a row there is read as a held
 * practice by the lock loader, the writer's prune, `teams_without_practice` and the metrics, and a
 * reader that missed one would count a missing practice as a held one. `persist_practice_schedule`
 * rebuilds the practice rows from the roster and each division's practices a week;
 * `persist_game_schedule` records the run's unscheduled games. The admin reads it through
 * `get_schedule_tbd(season)`.
 *
 * **What this module is.** The vocabulary (reasons, in one place, pinned to the table's CHECK by
 * `tests/scheduleTbd.test.js`), the words an admin reads, and the Zod schemas for the three places
 * the list crosses a boundary: the RPC's rows coming in, the export's `tbdItems`, and the unscheduled
 * entries the game page sends to be recorded. `generateScheduleExports()` turns an item into rows.
 *
 * @module scheduleTbd
 */

import { z } from 'zod';

import { describeUnplacedReason } from './practiceUnplacedReasons.js';

/** A practice no run has given a reason for yet (the table's default for a short team). */
export const NOT_SCHEDULED_YET = 'not-scheduled-yet';

/**
 * Why a practice is missing: the auto-scheduler's own reasons
 * (`PRACTICE_UNPLACED_REASON`) and {@link NOT_SCHEDULED_YET}. The table's CHECK spells the same list.
 *
 * An array and not a frozen object of codes: it is a closed list to validate against, not a table of
 * finding codes (`tests/reasonCodeReachability.test.js` audits those).
 */
export const SCHEDULE_TBD_PRACTICE_REASONS = Object.freeze([
  'no-slot-available',
  'no-live-date',
  'coach-preference',
  'practice-length',
  'not-enough-days',
  NOT_SCHEDULED_YET,
]);

/** Why a game is unplaced: the reasons `scheduleGames()` gives an unscheduled matchup. */
export const SCHEDULE_TBD_GAME_REASONS = Object.freeze([
  'unknown-team',
  'division-mismatch',
  'duplicate-matchup',
  'coach-coaches-both-teams',
  'coach-scheduling-conflict',
  'no-slot-available',
]);

/**
 * Why a game the schedule import read has no time: the file row carried no time or no field (PR 5, migration
 * `20261121010000`; `apply_game_import_job` records it). The scheduler never gives it, so it is not one of
 * {@link SCHEDULE_TBD_GAME_REASONS} (the entries a game save records are checked against that list); it is one of the
 * reasons a row of the table may carry.
 */
export const IMPORTED_WITHOUT_TIME = 'imported-without-time';

/**
 * Every reason a stored game row may carry: the scheduler's, and {@link IMPORTED_WITHOUT_TIME}. The table's CHECK
 * spells the same list (the latest migration that sets it; `tests/scheduleTbd.test.js` reads that one).
 */
export const SCHEDULE_TBD_STORED_GAME_REASONS = Object.freeze([
  ...SCHEDULE_TBD_GAME_REASONS,
  IMPORTED_WITHOUT_TIME,
]);

const GAME_REASON_TEXT = Object.freeze({
  'unknown-team': 'a team in the matchup is not on the roster',
  'division-mismatch': 'the teams are not in the division',
  'duplicate-matchup': 'a team already plays that week',
  'coach-coaches-both-teams': 'one coach coaches both teams',
  'coach-scheduling-conflict': "a coach's other games leave no free time",
  'no-slot-available': 'no game slot was free for it',
  [IMPORTED_WITHOUT_TIME]: 'the imported file gave it no time or no field',
});

/**
 * A reason in words. A reason this build does not know is shown as written, never hidden.
 *
 * @param {'practice' | 'game'} kind
 * @param {unknown} reason
 * @returns {string}
 */
export function describeScheduleTbdReason(kind, reason) {
  const key = String(reason ?? '');
  if (kind === 'game') return GAME_REASON_TEXT[key] ?? key;
  if (key === NOT_SCHEDULED_YET) return 'no schedule has placed it yet';
  return describeUnplacedReason(key);
}

/**
 * The `Notes` cell of one TIME TBD export row.
 *
 * @param {ScheduleTbdItem} item
 * @param {{ ordinal?: number }} [options] - which of a practice item's missing practices this row is (1-based)
 * @returns {string}
 */
export function scheduleTbdNote(item, { ordinal = 1 } = {}) {
  const why = describeScheduleTbdReason(item.kind, item.reason);
  // A game an import gave a date and no time (`schedule_tbd.game_date`) says its date; it still has no time.
  if (item.kind === 'game') {
    return item.gameDate
      ? `Game not scheduled (week ${item.weekIndex}, on ${item.gameDate}): ${why}.`
      : `Game not scheduled (week ${item.weekIndex}): ${why}.`;
  }
  return item.missingCount > 1
    ? `Practice not scheduled (${ordinal} of ${item.missingCount} missing): ${why}.`
    : `Practice not scheduled: ${why}.`;
}

const GAME_TBD_NOTE = /^Game not scheduled \(week (\d+)(?:, on (\d{4}-\d{2}-\d{2}))?\): (.+)\.$/;

/**
 * The week and the reason in words out of a game's `Notes` cell, the inverse of {@link scheduleTbdNote} for a game
 * item. The baseline of a publication keeps only the master export's rows, and a TIME TBD game there has its week in
 * this sentence and nowhere else; `tests/reportsChangesSincePublication.test.js` holds the two to each other.
 *
 * @param {unknown} note
 * @returns {{ weekIndex: number, why: string, gameDate?: string } | null} `null` for any note this module did not
 *   write; `gameDate` only for a game that holds a date
 */
export function parseGameTbdNote(note) {
  if (typeof note !== 'string') return null;
  const match = GAME_TBD_NOTE.exec(note.trim());
  if (match === null) return null;
  const weekIndex = Number(match[1]);
  if (!(Number.isInteger(weekIndex) && weekIndex > 0)) return null;
  return match[2] ? { weekIndex, why: match[3], gameDate: match[2] } : { weekIndex, why: match[3] };
}

const practiceItem = z.object({
  kind: z.literal('practice'),
  teamId: z.string().min(1),
  missingCount: z.number().int().min(1).max(7),
  reason: z.enum(
    /** @type {[string, ...string[]]} */ (/** @type {unknown} */ (SCHEDULE_TBD_PRACTICE_REASONS))
  ),
});

const gameItem = z.object({
  kind: z.literal('game'),
  homeTeamId: z.string().min(1),
  awayTeamId: z.string().min(1),
  weekIndex: z.number().int().min(1).max(255),
  reason: z.enum(
    /** @type {[string, ...string[]]} */ (/** @type {unknown} */ (SCHEDULE_TBD_STORED_GAME_REASONS))
  ),
  /** The date a schedule import gave the game (`schedule_tbd.game_date`); it has a day and no time. */
  gameDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * One TIME TBD item as `generateScheduleExports({ tbdItems })` takes it: a practice item (a team and
 * how many of its practices are missing) or a game item (the two sides and the week).
 */
export const ScheduleTbdItemSchema = z.discriminatedUnion('kind', [practiceItem, gameItem]);

/** @typedef {z.infer<typeof ScheduleTbdItemSchema>} ScheduleTbdItem */

/**
 * The rows `get_schedule_tbd` returns. Only what the export reads is required; the rest (names, the
 * run, the time) is for the page.
 */
export const ScheduleTbdRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['practice', 'game']),
  division_name: z.string().nullish(),
  team_id: z.string().nullish(),
  team_name: z.string().nullish(),
  home_team_id: z.string().nullish(),
  home_team_name: z.string().nullish(),
  away_team_id: z.string().nullish(),
  away_team_name: z.string().nullish(),
  week_index: z.number().int().nullish(),
  missing_count: z.number().int().nullish(),
  reason: z.string(),
  // The table's own column, joined on by the client (`scheduleTbdClient.js`): `get_schedule_tbd` does not return it.
  game_date: z.string().nullish(),
});

/**
 * The RPC's rows as export items. Throws on a row that is not a TIME TBD item (a practice row with
 * no team, a reason off the list): a list that cannot be read is an error, never an empty list.
 *
 * @param {unknown} rows - the RPC's `data`
 * @returns {ScheduleTbdItem[]}
 */
export function scheduleTbdItemsFromRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('the TIME TBD list must be an array');
  }
  return rows.map((raw) => {
    const row = ScheduleTbdRowSchema.parse(raw);
    return ScheduleTbdItemSchema.parse(
      row.kind === 'practice'
        ? {
            kind: 'practice',
            teamId: row.team_id,
            missingCount: row.missing_count,
            reason: row.reason,
          }
        : {
            kind: 'game',
            homeTeamId: row.home_team_id,
            awayTeamId: row.away_team_id,
            weekIndex: row.week_index,
            reason: row.reason,
            ...(row.game_date ? { gameDate: row.game_date } : {}),
          }
    );
  });
}

/**
 * One unscheduled game as `scheduleGames()` returns it and `persist_game_schedule` records it from
 * `results.unscheduled`: checked before the save so a malformed entry is named here and not as a
 * server refusal.
 */
export const GameUnscheduledEntrySchema = z.object({
  weekIndex: z.number().int().min(1).max(255),
  division: z.string().optional(),
  reason: z.enum(
    /** @type {[string, ...string[]]} */ (/** @type {unknown} */ (SCHEDULE_TBD_GAME_REASONS))
  ),
  matchup: z.object({
    homeTeamId: z.string().min(1),
    awayTeamId: z.string().min(1),
  }),
});

/**
 * The unscheduled list a game save carries, validated. Throws (with the entry's position) on a bad entry.
 *
 * @param {unknown} entries
 * @returns {z.infer<typeof GameUnscheduledEntrySchema>[]}
 */
export function parseGameUnscheduled(entries) {
  if (!Array.isArray(entries)) throw new TypeError('unscheduled games must be an array');
  return entries.map((entry, index) => {
    const parsed = GameUnscheduledEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new TypeError(
        `unscheduled[${index}] is not a recordable unscheduled game: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`)
          .join('; ')}`
      );
    }
    return parsed.data;
  });
}
