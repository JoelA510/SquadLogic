/**
 * `game-persistence`: the response for a save the database refused because of a Published game (migration
 * `20261119010000_game_published.sql`; plan `docs/changes/2026-11-03-schedule-expansion.md`, PR 1 task A2). Pure, so
 * vitest runs it directly (`tests/gamePersistenceErrors.test.js`); the Edge imports it.
 *
 * **Only these two refusals.** Every other error keeps today's response (a 500 carrying the message): this returns
 * null for it, and the caller falls through to its existing handling.
 *
 * | SQLSTATE | DETAIL                                                     | HTTP                                  |
 * |----------|------------------------------------------------------------|---------------------------------------|
 * | 22023    | `game_published`                                           | 409 `GAME_PUBLISHED`, the game's id   |
 * | 22023    | `game_published_omitted count=<n> ids=<first 50 ids>`      | 409 `GAME_PUBLISHED`, the ids, count  |
 *
 * The first is the guard trigger refusing a save that moves a Published game in place (the message names the game);
 * the second is the save refusing to leave a Published game out. The database's message is always kept.
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
