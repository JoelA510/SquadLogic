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

const GAME_REASON_TEXT = Object.freeze({
  'unknown-team': 'a team in the matchup is not on the roster',
  'division-mismatch': 'the teams are not in the division',
  'duplicate-matchup': 'a team already plays that week',
  'coach-coaches-both-teams': 'one coach coaches both teams',
  'coach-scheduling-conflict': "a coach's other games leave no free time",
  'no-slot-available': 'no game slot was free for it',
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
  if (item.kind === 'game') return `Game not scheduled (week ${item.weekIndex}): ${why}.`;
  return item.missingCount > 1
    ? `Practice not scheduled (${ordinal} of ${item.missingCount} missing): ${why}.`
    : `Practice not scheduled: ${why}.`;
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
    /** @type {[string, ...string[]]} */ (/** @type {unknown} */ (SCHEDULE_TBD_GAME_REASONS))
  ),
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
