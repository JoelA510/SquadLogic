/**
 * The games import, as the Import panel calls it (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.2; PR 6).
 *
 * One function per step of the flow, each over the supabase client it is given, so the panel holds no query and a test
 * drives the same calls against the mock client:
 *
 * 1. `readGameImportLeague`: what the organization has that a label could mean (divisions and teams of the season,
 *    venues, fields).
 * 2. `startGameImport`: an import job for the season, the file staged through `import-validation` in chunks of 500,
 *    and the job marked ready. The Edge function is the one reader of the file that counts: what it staged is read
 *    back (`readStagedGameRows`) and THAT is what the mapping step shows, never the browser's own reading.
 * 3. `saveGameImportMapping` then `previewGameImport`: the mapping stored on the job, and the apply with its writes off.
 * 4. `confirmGameImport`: the apply, through the Edge function, which refuses a preview that has gone stale.
 * 5. `rollbackGameImport`, `discardGameImport`, `readLatestGameImportJob`.
 *
 * Every refusal is thrown as an `Error` with the database's or the function's own words and a `code` where it gave one.
 * Nothing here retries, and nothing here guesses a default for a label.
 */

import {
  SCHEDULE_IMPORT_CHUNK_LIMITS,
  stagedRowToParsed,
} from '@squadlogic/core/scheduleImport/staging.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { readSeasonTeamDirectory } from './scheduleReportsRead.js';

/** An error that carries the code a refusal gave. @param {string} message @param {string | null} [code] @param {any} [body] */
function refusal(message, code = null, body = null) {
  return Object.assign(new Error(message), { code, body });
}

/** @param {any} client */
function requireClient(client) {
  if (typeof client?.rpc !== 'function' || typeof client?.from !== 'function') {
    throw new Error('there is no database connection to import with');
  }
}

/** A database error in its own words. @param {any} error @param {string} fallback */
function fromRpc(error, fallback) {
  return refusal(error?.message || fallback, error?.details || error?.code || null);
}

/**
 * The body of an Edge function's non-2xx answer (supabase-js puts the response on `context`), or null.
 * @param {any} error
 */
async function functionErrorBody(error) {
  if (typeof error?.context?.json !== 'function') return null;
  try {
    return await error.context.json();
  } catch {
    // Best effort: a body that is absent, already read or not JSON leaves the client's own message, which is shown.
    return null;
  }
}

/**
 * What the organization has that a label of the file could mean.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 * @returns {Promise<import('@squadlogic/core/scheduleImport/mapping.js').LeagueView>}
 */
export async function readGameImportLeague(client, { organizationId, seasonSettingsId }) {
  requireClient(client);
  const [divisions, directory, venues, fields] = await Promise.all([
    fetchAllPages(() =>
      client
        .from('divisions')
        .select('id, name')
        .eq('organization_id', organizationId)
        .eq('season_settings_id', seasonSettingsId)
    ),
    // The season's teams as the tables hold them, outside clubs included: a club a previous import made is reused.
    readSeasonTeamDirectory(client, { organizationId, seasonSettingsId }),
    fetchAllPages(() =>
      client.from('locations').select('id, name').eq('organization_id', organizationId)
    ),
    fetchAllPages(() =>
      client.from('fields').select('id, name, location_id').eq('organization_id', organizationId)
    ),
  ]);
  if (directory.ok !== true) {
    throw refusal(`The season's ${directory.table} could not be read: ${directory.message}`);
  }
  return {
    divisions: divisions.map((d) => ({ id: String(d.id), name: String(d.name ?? '') })),
    teams: directory.teams.map((t) => ({
      id: t.id,
      name: t.name,
      divisionId: t.divisionId,
      isExternal: t.isExternal,
    })),
    venues: venues.map((v) => ({ id: String(v.id), name: String(v.name ?? '') })),
    fields: fields.map((f) => ({
      id: String(f.id),
      venueId: String(f.location_id),
      name: String(f.name ?? ''),
    })),
  };
}

/**
 * Create the job, stage the file through the Edge function and mark the job ready.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string, fileName: string, headers: string[],
 *   rows: Array<Record<string, unknown>>, onProgress?: (done: number, total: number) => void }} input
 * @returns {Promise<{ jobId: string, summary: { rows: number, ok: number, tbd: number, refused: number,
 *   flagged: number, by_reason: Record<string, number>, dropped_columns: string[],
 *   warnings: Array<{ row: number, code: string, message: string }>,
 *   refused_rows: Array<{ row: number, code: string, message: string }> } }>}
 */
export async function startGameImport(
  client,
  { organizationId, seasonSettingsId, fileName, headers, rows, onProgress }
) {
  requireClient(client);
  const created = await client.rpc('create_import_job', {
    p_organization_id: organizationId,
    p_import_type: 'games',
    p_file_name: fileName,
    p_season_settings_id: seasonSettingsId,
  });
  if (created.error) throw fromRpc(created.error, 'The import could not be started.');
  const jobId = created.data?.id ?? created.data?.job_id ?? created.data;
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('The import could not be started: the job came back without an id.');
  }

  const summary = {
    rows: 0,
    ok: 0,
    tbd: 0,
    refused: 0,
    flagged: 0,
    /** @type {Record<string, number>} */
    by_reason: {},
    /** @type {string[]} */
    dropped_columns: [],
    /** @type {Array<{ row: number, code: string, message: string }>} */
    warnings: [],
    /** @type {Array<{ row: number, code: string, message: string }>} */
    refused_rows: [],
  };
  const size = SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_CHUNK_ROWS;
  // A file with a header and no rows still goes to the function once, so the refusal or the empty answer is its own.
  for (let offset = 0; offset === 0 || offset < rows.length; offset += size) {
    const { data, error } = await client.functions.invoke('import-validation', {
      body: {
        import_type: 'games',
        action: 'stage',
        organization_id: organizationId,
        import_job_id: jobId,
        headers,
        rows: rows.slice(offset, offset + size),
        row_offset: offset,
      },
    });
    if (error) {
      const body = await functionErrorBody(error);
      throw refusal(
        body?.message || error.message || 'The file could not be checked.',
        body?.code ?? null,
        body
      );
    }
    if (data?.status === 'refused') {
      throw refusal(data.message || 'The file was refused.', data.code ?? null, data);
    }
    if (data?.status !== 'success' || !data.summary) {
      throw new Error('The file check answered in a shape this page cannot read.');
    }
    const s = data.summary;
    for (const key of /** @type {const} */ (['rows', 'ok', 'tbd', 'refused', 'flagged'])) {
      summary[key] += Number(s[key] ?? 0);
    }
    for (const [reason, n] of Object.entries(s.by_reason ?? {})) {
      summary.by_reason[reason] = (summary.by_reason[reason] ?? 0) + Number(n);
    }
    summary.dropped_columns = s.dropped_columns ?? summary.dropped_columns;
    summary.warnings.push(...(s.warnings ?? []));
    summary.refused_rows.push(...(s.refused_rows ?? []));
    onProgress?.(Math.min(offset + size, rows.length), rows.length);
  }

  // The job stops being "importing" (which the stale-job sweep fails after five minutes) and waits for its confirm.
  const ready = await client.rpc('mark_import_job_ready_to_apply', {
    p_import_job_id: jobId,
    p_import_type: 'games',
    p_validation_errors: summary.refused_rows.map((r) => ({
      row: r.row,
      field: r.code,
      message: r.message,
    })),
  });
  if (ready.error) throw fromRpc(ready.error, 'The staged file could not be marked ready.');
  return { jobId, summary };
}

/**
 * The rows the Edge function staged for a job, as the mapping step reads them.
 *
 * @param {any} client
 * @param {string} jobId
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function readStagedGameRows(client, jobId) {
  requireClient(client);
  const staged = await fetchAllPages(
    () =>
      client
        .from('staging_import_rows')
        .select('id, source_row_number, normalized_payload, validation_errors')
        .eq('import_job_id', jobId)
        .eq('import_type', 'games'),
    { orderBy: 'source_row_number' }
  );
  return staged
    .slice()
    .sort((a, b) => Number(a.source_row_number) - Number(b.source_row_number))
    .map((row) => stagedRowToParsed(row));
}

/**
 * Store the admin's decisions on the job.
 *
 * @param {any} client
 * @param {string} jobId
 * @param {{ options: { arrive_published: boolean }, divisions: Record<string, any>, venues: Record<string, any>,
 *   fields: Record<string, any>, teams: Record<string, any> }} mapping
 */
export async function saveGameImportMapping(client, jobId, mapping) {
  requireClient(client);
  const { data, error } = await client.rpc('map_game_import_job', {
    p_import_job_id: jobId,
    p_mapping: mapping,
  });
  if (error) throw fromRpc(error, 'The mapping could not be saved.');
  return data;
}

/**
 * The preview: the apply with its writes off. One statement with the apply, so its counts are the apply's.
 *
 * @param {any} client
 * @param {string} jobId
 */
export async function previewGameImport(client, jobId) {
  requireClient(client);
  const { data, error } = await client.rpc('apply_game_import_job', {
    p_import_job_id: jobId,
    p_dry_run: true,
  });
  if (error) throw fromRpc(error, 'The preview could not be made.');
  if (!data || typeof data !== 'object') {
    throw new Error('The preview came back in a shape this page cannot read.');
  }
  return data;
}

/**
 * The confirm. `confirmed` is the counts the admin saw (`scheduleImportConfirmCounts` of the preview on screen); the
 * Edge function runs the dry run again and applies only when they still hold.
 *
 * @param {any} client
 * @param {{ organizationId: string, jobId: string, confirmed: Record<string, number | boolean> }} input
 * @returns {Promise<{ status: 'applied', result: any }
 *   | { status: 'stale', message: string, differing: string[], confirmed: any, current: any, preview: any }>}
 */
export async function confirmGameImport(client, { organizationId, jobId, confirmed }) {
  requireClient(client);
  const { data, error } = await client.functions.invoke('import-validation', {
    body: {
      import_type: 'games',
      action: 'apply',
      organization_id: organizationId,
      import_job_id: jobId,
      confirmed,
    },
  });
  if (error) {
    const body = await functionErrorBody(error);
    if (body?.code === 'game_import_preview_stale' && body.preview) {
      return {
        status: 'stale',
        message: String(body.message ?? 'The schedule changed after this preview was made.'),
        differing: Array.isArray(body.differing) ? body.differing : [],
        confirmed: body.confirmed ?? confirmed,
        current: body.current ?? {},
        preview: body.preview,
      };
    }
    throw refusal(
      body?.message || error.message || 'The import could not be applied.',
      body?.code ?? null,
      body
    );
  }
  if (data?.status !== 'success' || !data.result || typeof data.result !== 'object') {
    throw new Error('The import answered in a shape this page cannot read.');
  }
  return { status: 'applied', result: data.result };
}

/** @param {any} client @param {string} jobId */
export async function rollbackGameImport(client, jobId) {
  requireClient(client);
  const { data, error } = await client.rpc('rollback_game_import_job', {
    p_import_job_id: jobId,
  });
  if (error) throw fromRpc(error, 'The import could not be rolled back.');
  return data;
}

/** Discard a staged import that was never applied. @param {any} client @param {string} jobId */
export async function discardGameImport(client, jobId) {
  requireClient(client);
  const { error } = await client.rpc('cancel_ready_import_job', {
    p_import_job_id: jobId,
    p_import_type: 'games',
  });
  if (error) throw fromRpc(error, 'The staged import could not be discarded.');
}

/**
 * The season's most recent games import that was applied and not rolled back, or null: the one the panel still offers
 * to roll back after a reload.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 * @returns {Promise<{ id: string, fileName: string, completedAt: string | null, result: any } | null>}
 */
export async function readLatestGameImportJob(client, { organizationId, seasonSettingsId }) {
  requireClient(client);
  const { data, error } = await client
    .from('import_jobs')
    .select('id, storage_path, status, completed_at, warning_summary, season_settings_id')
    .eq('organization_id', organizationId)
    .eq('job_type', 'games')
    .eq('season_settings_id', seasonSettingsId)
    .in('status', ['completed', 'completed_with_warnings'])
    .order('completed_at', { ascending: false })
    .limit(1);
  if (error) throw fromRpc(error, 'The last games import could not be read.');
  const job = (data ?? [])[0];
  const result = job?.warning_summary?.game_import;
  if (!job || !result || result.nothing_to_apply === true) return null;
  return {
    id: String(job.id),
    // `import_jobs.storage_path` is `imports/<user>/<file name>`: the name is its last part.
    fileName: String(job.storage_path ?? '')
      .split('/')
      .pop(),
    completedAt: job.completed_at ?? null,
    result,
  };
}
