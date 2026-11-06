/**
 * The calls the Games page and the Exports panel make to set whether games are Published, and to read a game's
 * history (migration `20261119010000_game_published.sql`; plan `docs/changes/2026-11-03-schedule-expansion.md`, 3.4).
 *
 * Both are RPCs over the signed-in session, never the service role; the database judges who may call them
 * (`is_org_admin`), which ids exist in this organization, and the reason list. This module only builds the call from
 * the saved set, says "no" before sending what the database would refuse for a reason the screen could have known
 * (the pure twin, `setGamesPublishedRefusal`), splits a long list into calls of at most 2,400 games, and hands the
 * database's own words back when it refuses.
 *
 * @module gamePublishedClient
 */

import { setGamesPublishedRefusal, splitGameIds } from '@squadlogic/core/gamePublished.js';
import { supabase } from '../lib/supabaseClient.js';

/**
 * Set the Published flag of the named games. A list of more than 2,400 games is sent as several calls in order; the
 * first refusal stops the rest, and the error says how many calls were already saved (`err.done`), because those
 * games have changed.
 *
 * Turning Published ON sends no reason and no note (the database refuses either). Turning it OFF ("Allow changes")
 * sends the reason and the optional note; an empty note is not sent.
 *
 * @param {Object} input
 * @param {string} input.organizationId
 * @param {Iterable<string>} input.ids - saved game ids of the loaded schedule
 * @param {boolean} input.published - true to publish, false to allow changes
 * @param {string | null} [input.reasonCode]
 * @param {string | null} [input.note]
 * @param {{ kind: string, value?: string } | null} [input.scope] - how the games were chosen, for the audit row
 * @param {any} [input.client] - the Supabase client (the app's, unless a test passes its own)
 * @returns {Promise<{ changed: number, unchanged: number, ids: string[], calls: number }>}
 * @throws {Error & { code?: string, details?: string, done?: { calls: number, of: number, changed: number } }}
 */
export async function setGamesPublished({
  organizationId,
  ids,
  published,
  reasonCode = null,
  note = null,
  scope = null,
  client = supabase,
}) {
  const chunks = splitGameIds(ids);
  if (chunks.length === 0) throw new Error('Name at least one game.');
  const off = published === false;
  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  const result = { changed: 0, unchanged: 0, ids: /** @type {string[]} */ ([]), calls: 0 };
  for (const chunk of chunks) {
    const payload = {
      organizationId,
      assignmentIds: chunk,
      published,
      reasonCode: off ? reasonCode : null,
      note: off && trimmedNote !== '' ? trimmedNote : null,
      scope,
    };
    // The database's own checks, said before the call: a refusal the screen could have known is never sent.
    const refusal = setGamesPublishedRefusal(payload);
    if (refusal) {
      throw Object.assign(new Error(`Not sent: ${refusal}.`), {
        code: 'client_refusal',
        details: refusal,
        done: { calls: result.calls, of: chunks.length, changed: result.changed },
      });
    }
    const { data, error } = await client.rpc('admin_set_games_published', {
      p_organization_id: organizationId,
      p_assignment_ids: chunk,
      p_published: published,
      p_reason_code: payload.reasonCode,
      p_note: payload.note,
      p_scope: scope,
    });
    if (error) {
      throw Object.assign(new Error(error.message || 'The change was not saved.'), {
        code: error.code,
        details: error.details,
        done: { calls: result.calls, of: chunks.length, changed: result.changed },
      });
    }
    result.calls += 1;
    result.changed += Number(data?.changed ?? 0);
    result.unchanged += Number(data?.unchanged ?? 0);
    if (Array.isArray(data?.ids)) result.ids.push(...data.ids.map(String));
  }
  return result;
}

/**
 * The audit rows that name one game (`get_schedule_audit_log`): newest first, at most `limit`. Admin only; the
 * database refuses anyone else in its own words. The ids are the game's row id as the database holds it, so a game
 * moved to another slot or week has no history here (it is a new row, lesson 95).
 *
 * @param {Object} input
 * @param {string} input.organizationId
 * @param {string} input.gameId
 * @param {number} [input.limit]
 * @param {any} [input.client]
 * @returns {Promise<Array<{ id: string, created_at: string, action: string, metadata: Record<string, any>,
 *   actor_name: string }>>}
 */
export async function readGameHistory({ organizationId, gameId, limit = 50, client = supabase }) {
  const { data, error } = await client.rpc('get_schedule_audit_log', {
    p_organization_id: organizationId,
    p_assignment_id: gameId,
    p_limit: limit,
  });
  if (error) {
    throw Object.assign(new Error(error.message || 'The history could not be read.'), {
      code: error.code,
      details: error.details,
    });
  }
  return Array.isArray(data) ? data : [];
}
