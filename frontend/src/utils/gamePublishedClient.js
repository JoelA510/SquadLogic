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
import { fetchAllPages } from '../lib/pagedFetch.js';
import { scopeSchedulerRunsToActiveSeason } from './schedulerRunFilters.js';
import { PUBLISHED_OUTCOME_UNKNOWN, isUnknownPublishedOutcome } from './gamePublishedText.js';

export { PUBLISHED_OUTCOME_UNKNOWN, isUnknownPublishedOutcome };

// What the database (and PostgREST) put in `code` when they REFUSE a call: a SQLSTATE (22023, 42501, P0002, SLA01) or
// a PostgREST code (PGRST202). A refusal rolled the call back. An error with any other `code` (supabase-js gives a
// failed fetch the empty string, or a system error code such as ECONNRESET or EPIPE, which has no digit: every
// SQLSTATE has one) or none (a gateway's 502 or 504 with a
// body that is not JSON) never reached an answer, and the change may have been committed before the answer was lost.
const DATABASE_REFUSAL_CODE = /^(?:(?=[0-9A-Z]*\d)[0-9A-Z]{5}|PGRST\d+)$/;
const isDatabaseRefusal = (error) => DATABASE_REFUSAL_CODE.test(String(error?.code ?? ''));

// The RPC's answer when it worked: `{ changed, unchanged, ids }`, the counts numbers. Anything else that came back
// without an error is an answer nobody can read, and a call that may have been committed.
const isCount = (value) => typeof value === 'number' && Number.isFinite(value);
const isReadableAnswer = (data) =>
  data !== null && typeof data === 'object' && isCount(data.changed) && isCount(data.unchanged);

/** The error for a call whose outcome is not known: the message says so (what the caller does about it is the caller's to say), and `done` says what was saved before it. */
function unknownOutcome(words, done, cause) {
  return Object.assign(new Error(`${words}, so it is not known whether the change was saved.`), {
    code: PUBLISHED_OUTCOME_UNKNOWN,
    cause: cause ?? undefined,
    done,
  });
}

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
 * A call whose answer was lost or could not be read (a failed fetch, a gateway's 502, a body that is not the answer)
 * may have been committed: it throws an error with `code` {@link PUBLISHED_OUTCOME_UNKNOWN}
 * ({@link isUnknownPublishedOutcome}), and the caller reads the saved flags again. A refusal that carries the
 * database's own code rolled back and changed nothing.
 *
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
    const done = { calls: result.calls, of: chunks.length, changed: result.changed };
    /** @type {{ data?: any, error?: any }} */
    let answer;
    try {
      answer = await client.rpc('admin_set_games_published', {
        p_organization_id: organizationId,
        p_assignment_ids: chunk,
        p_published: published,
        p_reason_code: payload.reasonCode,
        p_note: payload.note,
        p_scope: scope,
      });
    } catch (thrown) {
      // A request that threw never reached an answer (the network, an abort): the database may have committed it.
      throw unknownOutcome(thrown?.message || 'The request failed', done, thrown);
    }
    const { data, error } = answer ?? {};
    if (error) {
      if (!isDatabaseRefusal(error)) {
        throw unknownOutcome(error.message || 'The request failed', done, error);
      }
      throw Object.assign(new Error(error.message || 'The change was not saved.'), {
        code: error.code,
        details: error.details,
        done,
      });
    }
    if (!isReadableAnswer(data)) {
      throw unknownOutcome('The answer could not be read', done, null);
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

/**
 * The ids of the games of the CURRENT saved schedule, read fresh from the database: the club's latest completed game
 * run (scoped to the season as `useSchedulerRun` scopes it, so it is the run the Games page shows) and its rows.
 *
 * The Exports panel checks the files it is about to mark Published against this: its own list of games was read when
 * the page opened, and another tab may have moved a game and applied since. A game of an OLDER run is a real row that
 * `admin_set_games_published` would accept, and the Games page could not show or release it. A refused read throws
 * (it is never an empty schedule); no saved run is an empty set.
 *
 * @param {Object} input
 * @param {string} input.organizationId
 * @param {string | null} [input.seasonSettingsId]
 * @param {any} [input.client]
 * @returns {Promise<{ runId: string | null, ids: Set<string> }>}
 */
export async function readCurrentSavedGameIds({
  organizationId,
  seasonSettingsId = null,
  client = supabase,
}) {
  let runQuery = client
    .from('scheduler_runs')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('run_type', 'game')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });
  runQuery = scopeSchedulerRunsToActiveSeason(runQuery, seasonSettingsId);
  const { data: run, error } = await runQuery.limit(1).maybeSingle();
  if (error) throw error;
  if (!run?.id) return { runId: null, ids: new Set() };
  const rows = await fetchAllPages(() =>
    client.from('game_assignments').select('id').eq('run_id', run.id)
  );
  return { runId: String(run.id), ids: new Set(rows.map((row) => String(row.id))) };
}
