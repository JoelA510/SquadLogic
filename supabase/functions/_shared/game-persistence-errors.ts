/**
 * `game-persistence`: the response for a save the database refused because of a Published game (migration
 * `20261119010000_game_published.sql`; plan `docs/changes/2026-11-03-schedule-expansion.md`, PR 1 task A2). Pure, so
 * vitest runs it directly (`tests/gamePersistenceErrors.test.js`); the Edge imports it.
 *
 * **Only these refusals.** Every other error keeps today's response (a 500 carrying the message, logged as a failure):
 * each function here returns null for it, and the caller falls through to its existing handling.
 *
 * | SQLSTATE | DETAIL                                                     | HTTP                                  |
 * |----------|------------------------------------------------------------|---------------------------------------|
 * | 22023    | `game_published`                                           | 409 `GAME_PUBLISHED`, the game's id   |
 * | 22023    | `game_published_omitted count=<n> ids=<first 50 ids>`      | 409 `GAME_PUBLISHED`, the ids, count  |
 *
 * The first is the guard trigger refusing a save that moves a Published game in place (the message names the game);
 * the second is the save refusing to leave a Published game out. The database's message is always kept.
 *
 * **A save that names games by id** (`20261120010000_game_identity.sql`; `gameIdentityErrorResponse`). All six are a
 * 409 with the database's words. Four are caused by what the admin sent or by another admin's act a moment before (one
 * cancels game X while another applies a regeneration that names X): `game_not_found`, `game_identity_season`,
 * `game_identity_conflict` and `game_removed` are not logged as a failure. The other two, `game_identity_invalid` and
 * `game_identity_repeated`, are not an admin's doing or a race: the page never sends a placeholder id (only saved games
 * carry one) and the matcher throws on a duplicate, so they signal a page regression and `logAsFailure` asks the caller
 * to write the failure log for them, as the generic path does.
 *
 * | SQLSTATE | DETAIL                                         | HTTP                                              |
 * |----------|------------------------------------------------|---------------------------------------------------|
 * | 22023    | `game_identity_invalid`                        | 409 `GAME_IDENTITY`, reason `game_identity_invalid`  |
 * | 22023    | `game_identity_repeated`                       | 409 `GAME_IDENTITY`, reason `game_identity_repeated` |
 * | 23503    | `game_not_found`                               | 409 `GAME_IDENTITY`, reason `game_not_found`         |
 * | 22023    | `game_identity_season ids=<id>`                | 409 `GAME_IDENTITY`, reason `game_identity_season`   |
 * | 22023    | `game_identity_conflict ids=<id>[,<id>]`       | 409 `GAME_IDENTITY`, reason `game_identity_conflict` |
 * | 40001    | (none; the message is the SQL's, word for word) | 409 `GAME_IDENTITY`, reason `game_removed`          |
 */

export interface GamePublishedErrorResponse {
  status: 409;
  body: {
    status: 'error';
    code: 'GAME_PUBLISHED';
    reason: 'game_published' | 'game_published_omitted';
    message: string;
    /** The games named: the one the trigger refused, or the first 50 the save left out. */
    ids: string[];
    /** How many Published games the save left out (the ids list stops at 50); 1 for the trigger's. */
    count: number;
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const OMITTED = /^game_published_omitted count=(\d+) ids=([0-9a-fA-F,-]*)$/;

export function gamePublishedErrorResponse(error: unknown): GamePublishedErrorResponse | null {
  const e = error as { code?: unknown; details?: unknown; message?: unknown } | null;
  if (e?.code !== '22023' || typeof e.details !== 'string') return null;
  const message =
    typeof e.message === 'string' && e.message
      ? e.message
      : 'The save was refused: a game is Published.';

  const omitted = OMITTED.exec(e.details);
  if (omitted) {
    const ids = omitted[2] === '' ? [] : omitted[2].split(',');
    return {
      status: 409,
      body: {
        status: 'error',
        code: 'GAME_PUBLISHED',
        reason: 'game_published_omitted',
        message,
        ids,
        count: Number(omitted[1]),
      },
    };
  }
  if (e.details === 'game_published') {
    const ids = [...new Set((message.match(UUID) ?? []).map((id) => id.toLowerCase()))];
    return {
      status: 409,
      body: {
        status: 'error',
        code: 'GAME_PUBLISHED',
        reason: 'game_published',
        message,
        ids,
        count: Math.max(ids.length, 1),
      },
    };
  }
  return null;
}

export interface GameIdentityErrorResponse {
  status: 409;
  body: {
    status: 'error';
    code: 'GAME_IDENTITY';
    reason:
      | 'game_identity_invalid'
      | 'game_identity_repeated'
      | 'game_not_found'
      | 'game_identity_season'
      | 'game_identity_conflict'
      | 'game_removed';
    /** The database's message, or words of our own when it gave none. */
    message: string;
    /** The games named (the DETAIL's ids, else the message's); empty when the refusal names none. */
    ids: string[];
  };
  /**
   * Whether the caller also writes the failure log (NOT part of the response body). True for the two refusals the page
   * itself must never cause: an id that is not a uuid (the page sends only saved games' ids) and a game named twice (the
   * matcher throws on a duplicate), so either signals a page regression and stays visible. False for the other four, which
   * an admin or another admin's act a moment before causes.
   */
  logAsFailure: boolean;
}

/** The message `persist_game_schedule` raises (40001) when a game it has just seen is gone by the time it locks it. */
const REMOVED_MESSAGE =
  'a game was removed while this save was being checked: nothing was saved, try again';
const IDENTITY_DETAIL =
  /^(game_identity_season|game_identity_conflict) ids=([0-9a-fA-F-]+(?:,[0-9a-fA-F-]+)?)$/;

/**
 * The 409 for a refusal of a save that names games by id, or null for anything else (the caller then keeps its existing
 * handling: the failure is logged and the response is a 500).
 *
 * Keyed on the SQLSTATE AND the DETAIL together (an unrelated 22023, 23503 or 40001 is not ours): `tests/
 * gamePersistenceErrors.test.js` holds the strings to the migration's.
 */
export function gameIdentityErrorResponse(error: unknown): GameIdentityErrorResponse | null {
  const e = error as { code?: unknown; details?: unknown; message?: unknown } | null;
  const code = e?.code;
  const details = typeof e?.details === 'string' ? e.details : null;
  const raw = typeof e?.message === 'string' && e.message ? e.message : null;
  const respond = (
    reason: GameIdentityErrorResponse['body']['reason'],
    fallback: string,
    ids: string[]
  ): GameIdentityErrorResponse => ({
    status: 409,
    body: { status: 'error', code: 'GAME_IDENTITY', reason, message: raw ?? fallback, ids },
    logAsFailure: reason === 'game_identity_invalid' || reason === 'game_identity_repeated',
  });
  const idsOf = (text: string) => [
    ...new Set((text.match(UUID) ?? []).map((id) => id.toLowerCase())),
  ];

  if (code === '40001') {
    return raw === REMOVED_MESSAGE ? respond('game_removed', REMOVED_MESSAGE, []) : null;
  }
  if (code === '23503') {
    return details === 'game_not_found'
      ? respond(
          'game_not_found',
          'A game of this save is not a saved game of this organization.',
          idsOf(raw ?? '')
        )
      : null;
  }
  if (code !== '22023' || details === null) return null;
  if (details === 'game_identity_invalid') {
    return respond(
      'game_identity_invalid',
      'A game id of this save is not a game id (a uuid).',
      []
    );
  }
  if (details === 'game_identity_repeated') {
    return respond(
      'game_identity_repeated',
      'A game is named more than once in this save.',
      idsOf(raw ?? '')
    );
  }
  const named = IDENTITY_DETAIL.exec(details);
  if (named) {
    const ids = named[2].split(',').map((id) => id.toLowerCase());
    return named[1] === 'game_identity_season'
      ? respond('game_identity_season', 'A game of this save belongs to another season.', ids)
      : respond('game_identity_conflict', 'Two games of this save would end at one place.', ids);
  }
  return null;
}
