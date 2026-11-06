/**
 * The Published switch on games, as the app reasons about it (migration `20261119010000_game_published.sql`; plan
 * `docs/changes/2026-11-03-schedule-expansion.md`, sections 3.1 to 3.4, PR 1 task A3). Pure: no React, no network.
 *
 * **Words.** "Published" means these games were told to families: a per-game flag on `game_assignments`. It is not the
 * Exports panel's "Published baseline" (`publication_baselines`, the immutable record) and not a roster status.
 * Turning it ON needs nothing; turning it OFF is the deliberate, audited act the screen calls "Allow changes" (the
 * Edge function's `overrides` field is an unrelated count of pending manual overrides).
 *
 * **What is here, and which side holds the rule.** The database is the authority (a trigger on every writer, the
 * save's omission check, the switch's gates); this module is its TWIN for the app, held to it by a test that reads
 * the migration (`tests/gamePublished.test.js`) and, for the mock client, by one input that reaches every outcome
 * (`tests/mockGamePublished.test.js`, lesson 77). It is used to say "no" before a call is sent, to build the
 * bulk calls, and as the oracle for what a regeneration must carry (PR 2).
 *
 * **Identity.** The game save keys its upsert on the matchup tuple (home, away, slot, week) and writes no `id`, so
 * `publishedOmissions` works on that tuple too. A game moved to another slot or week is a new tuple, hence a new row
 * with a new id: a Published original is then an OMISSION, and anything keyed by the old id stays with the old row.
 *
 * @module gamePublished
 */

import { z } from 'zod';

/**
 * The reasons an admin can give when allowing changes to a Published game: a closed list, never free text, so the
 * audit row holds no personal data. The first four are exactly the grid override prompt's
 * (`GRID_OVERRIDE_REASONS` in `frontend/src/utils/gridOverridePrompt.js`, held equal by a test); the SQL list is
 * `c_reasons` in `admin_set_games_published`, also held equal.
 */
export const GAME_PUBLISH_REASONS = Object.freeze([
  Object.freeze({ code: 'field-change', label: 'Field change' }),
  Object.freeze({ code: 'coach-request', label: 'Coach request' }),
  Object.freeze({ code: 'conflict-fix', label: 'Conflict fix' }),
  Object.freeze({ code: 'published-in-error', label: 'Published in error' }),
  Object.freeze({ code: 'other', label: 'Other' }),
]);

/**
 * The codes of {@link GAME_PUBLISH_REASONS}.
 * @type {readonly string[]}
 */
export const GAME_PUBLISH_REASON_CODES = Object.freeze(
  GAME_PUBLISH_REASONS.map((reason) => reason.code)
);

/** Ids in one `admin_set_games_published` call: the spreadsheet's own row limit. */
export const GAME_PUBLISH_MAX_IDS = 2400;

/** Characters in the optional note (decision 1: allowed, with helper text and a counter on the screen). */
export const GAME_PUBLISH_NOTE_MAX = 200;

/** How a bulk call was chosen; recorded in the audit row. */
export const GAME_PUBLISH_SCOPE_KINDS = Object.freeze([
  'all',
  'division',
  'date',
  'venue',
  'selection',
]);

/** Characters in a scope's value (a division name, a date, a venue name). */
export const GAME_PUBLISH_SCOPE_VALUE_MAX = 100;

/**
 * The columns of a saved game the guard refuses to change while it is Published: where, when and who plays. Not a
 * placement, so writable: `run_id`, `assignment_source`, `division` (a label that follows a division rename),
 * `updated_at` and the `published*` columns. Camel and snake spellings of a row are both read.
 */
export const PUBLISHED_GUARDED_FIELDS = Object.freeze([
  'game_slot_id',
  'slot_id',
  'field_id',
  'home_team_id',
  'away_team_id',
  'week_index',
  'start',
  'end',
]);

/** The audit actions the switch writes (registered in `audit_actions` by the migration). */
export const GAME_PUBLISHED_AUDIT_ACTIONS = Object.freeze({
  set: 'game.published_set',
  overridden: 'game.publish_overridden',
});

const CAMEL = Object.freeze({
  game_slot_id: 'gameSlotId',
  slot_id: 'slotId',
  field_id: 'fieldId',
  home_team_id: 'homeTeamId',
  away_team_id: 'awayTeamId',
  week_index: 'weekIndex',
  start: 'kickoff',
  end: 'end',
});

// The characters the database trims off a reason and a note (btrim with space, tab, CR, LF): not every Unicode space.
const trimWs = (value) => String(value ?? '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

// An instant, read as the database reads it: a time with no zone designator is UTC (the functions pin TimeZone to
// UTC), not the runtime's local time.
const instant = (value) => {
  const text = String(value).trim();
  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
      text
    );
  if (!m) return Date.parse(text);
  let zone = (m[3] ?? 'Z').toUpperCase();
  if (zone !== 'Z')
    zone =
      zone.length === 3
        ? `${zone}:00`
        : zone.length === 5
          ? `${zone.slice(0, 3)}:${zone.slice(3)}`
          : zone;
  return Date.parse(`${m[1]}T${m[2]}${zone}`);
};

const read = (row, field) => {
  const value = row?.[field] ?? row?.[CAMEL[field]];
  return value === undefined ? null : value;
};

const sameValue = (a, b, field) => {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (field === 'start' || field === 'end') {
    const x = instant(a);
    const y = instant(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x === y;
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
};

/**
 * Which guarded fields a change would alter (an unchanged value is not a change, so carrying a row forward as it is
 * passes). The twin of the trigger's column test.
 *
 * @param {Record<string, any>} before - a saved game
 * @param {Record<string, any>} after - the same game as it would be saved
 * @returns {string[]} the changed fields, in {@link PUBLISHED_GUARDED_FIELDS} order
 */
export function changedPublishedFields(before, after) {
  return PUBLISHED_GUARDED_FIELDS.filter(
    (field) => !sameValue(read(before, field), read(after, field), field)
  );
}

/** Whether a change to a saved game is one the guard refuses while it is Published. */
export function changesPublishedPlacement(before, after) {
  return changedPublishedFields(before, after).length > 0;
}

/**
 * Split ids into calls of at most {@link GAME_PUBLISH_MAX_IDS} (the bulk bar resolves a scope to ids from the saved
 * set and sends them in as few calls as that allows). Duplicates are dropped, first sight wins; a non-string or empty
 * id is an error, not skipped (nothing is parsed and left unread).
 *
 * @param {Iterable<string>} ids
 * @param {number} [size]
 * @returns {string[][]}
 */
export function splitGameIds(ids, size = GAME_PUBLISH_MAX_IDS) {
  if (!Number.isInteger(size) || size < 1 || size > GAME_PUBLISH_MAX_IDS) {
    throw new RangeError(`a call carries 1 to ${GAME_PUBLISH_MAX_IDS} ids`);
  }
  const seen = new Set();
  const unique = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('a game id is a non-empty string');
    }
    const key = id.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(id);
    }
  }
  const calls = [];
  for (let at = 0; at < unique.length; at += size) calls.push(unique.slice(at, at + size));
  return calls;
}

// The matchup key, or null when a part is missing: as in SQL, a NULL part matches nothing (NULL = NULL is not true).
const keyOf = (row) => {
  const parts = [
    read(row, 'home_team_id'),
    read(row, 'away_team_id'),
    read(row, 'game_slot_id') ?? read(row, 'slot_id'),
    read(row, 'week_index'),
  ];
  if (parts.some((part) => part === null || part === '')) return null;
  return parts.map((part) => String(part).toLowerCase()).join('|');
};

/**
 * The Published saved games a save would leave out: the twin of the check in `persist_game_schedule`. A save carries
 * every Published game of its season, unchanged; a game it leaves out is not deleted but orphaned in an older run and
 * gone from the page. The key is the matchup tuple (home, away, slot, week) because the save's upsert is keyed on it.
 *
 * `saved` is the set the save is about: the caller scopes it to the season (the database scopes by the home team's
 * division's season, or by the organization's seasons that are not completed when the run names no season). Only a
 * game a save can carry is an omission, as in the database: a row with an incomplete key is not listed (no save could
 * carry it; the guard trigger still holds it), and a game of a completed season, which is read-only, is the caller's
 * to leave out.
 *
 * @param {Array<Record<string, any>>} saved - saved games (`published` true marks the guarded ones)
 * @param {Array<Record<string, any>>} payload - the games the save carries
 * @returns {Array<Record<string, any>>} the omitted Published games, in id order
 */
export function publishedOmissions(saved, payload) {
  const carried = new Set((payload ?? []).map(keyOf).filter((key) => key !== null));
  return (saved ?? [])
    .filter((row) => {
      if (row?.published !== true) return false;
      const key = keyOf(row);
      return key !== null && !carried.has(key);
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/**
 * The payload of `admin_set_games_published`, in the app's spelling. `safeParse` reports the database's own codes as
 * the issue messages (`ids_required`, `too_many_ids`, `ids_invalid`, `published_required`, `reason_required`,
 * `reason_unknown`, `reason_only_when_off`, `note_too_long`, `scope_invalid`), in the order the database checks them,
 * so a refusal can be shown before a call is sent and the two can be compared. What only the database can judge
 * (a signed-in admin, existing ids of this organization, a completed season) is not here.
 */
export const SetGamesPublishedSchema = z
  .object({
    organizationId: z.string(),
    assignmentIds: z.array(z.any()).nullish(),
    published: z.boolean({ error: 'published_required' }).nullish(),
    reasonCode: z.string().nullish(),
    note: z.string().nullish(),
    scope: z.any().nullish(),
  })
  .superRefine((value, ctx) => {
    const refuse = (message, path) => ctx.addIssue({ code: 'custom', message, path });
    const ids = value.assignmentIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      refuse('ids_required', ['assignmentIds']);
      return;
    }
    if (ids.some((id) => typeof id !== 'string' || id.trim() === '')) {
      refuse('ids_invalid', ['assignmentIds']);
      return;
    }
    if (new Set(ids.map((id) => id.toLowerCase())).size > GAME_PUBLISH_MAX_IDS) {
      refuse('too_many_ids', ['assignmentIds']);
      return;
    }
    if (typeof value.published !== 'boolean') {
      refuse('published_required', ['published']);
      return;
    }
    const reason = trimWs(value.reasonCode);
    const note = trimWs(value.note);
    if (value.published) {
      if (reason !== '' || note !== '') refuse('reason_only_when_off', ['reasonCode']);
    } else if (reason === '') {
      refuse('reason_required', ['reasonCode']);
    } else if (!GAME_PUBLISH_REASON_CODES.includes(reason)) {
      refuse('reason_unknown', ['reasonCode']);
    } else if ([...note].length > GAME_PUBLISH_NOTE_MAX) {
      refuse('note_too_long', ['note']);
    }
    const scope = value.scope;
    if (
      scope != null &&
      (typeof scope !== 'object' ||
        Array.isArray(scope) ||
        !GAME_PUBLISH_SCOPE_KINDS.includes(scope.kind) ||
        Object.keys(scope).some((key) => key !== 'kind' && key !== 'value') ||
        (scope.value != null && typeof scope.value !== 'string') ||
        [...(scope.value ?? '')].length > GAME_PUBLISH_SCOPE_VALUE_MAX)
    ) {
      refuse('scope_invalid', ['scope']);
    }
  });

/**
 * The database's code for the first thing wrong with a switch payload, or null when the payload is well formed.
 *
 * @param {unknown} input - `{ organizationId, assignmentIds, published, reasonCode?, note?, scope? }`
 * @returns {string | null}
 */
export function setGamesPublishedRefusal(input) {
  const result = SetGamesPublishedSchema.safeParse(input);
  if (result.success) return null;
  return result.error.issues[0]?.message ?? 'invalid';
}

/**
 * The detail the database puts on a `game_published_omitted` refusal
 * (`game_published_omitted count=<n> ids=<the first 50 ids, in id order>`), read back; null for any other text.
 *
 * @param {unknown} details - a PostgREST error's `details`
 * @returns {{ count: number, ids: string[] } | null}
 */
export function parseGamePublishedOmitted(details) {
  const match = /^game_published_omitted count=(\d+) ids=([0-9a-fA-F,-]*)$/.exec(
    String(details ?? '')
  );
  if (!match) return null;
  return { count: Number(match[1]), ids: match[2] === '' ? [] : match[2].split(',') };
}
