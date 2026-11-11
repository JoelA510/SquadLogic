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
import { scheduleLabelKey } from '@squadlogic/core/scheduleImport/mapping.js';
import { SCHEDULE_IMPORT_COLUMNS } from '@squadlogic/core/scheduleImport/parseRows.js';
import { buildScheduleCsv } from '@squadlogic/core/scheduleImport/scheduleCsv.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { readCurrentSavedGameIds } from './gamePublishedClient.js';
import { readSeasonTeamDirectory } from './scheduleReportsRead.js';
import { readScheduleTbd } from './scheduleTbdClient.js';

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
  // Only the columns the import reads leave the browser (the function drops the rest too, but a note, a coach or an
  // email in the file has no reason to travel). The header row goes whole, as names, so the dropped columns are named.
  const read = new Set(
    Object.values(SCHEDULE_IMPORT_COLUMNS).map((name) => scheduleLabelKey(name))
  );
  const kept = headers.filter((header) => read.has(scheduleLabelKey(header)));
  const sentHeaders = headers.slice(0, SCHEDULE_IMPORT_CHUNK_LIMITS.MAX_HEADERS);
  const sentRows = rows.map((row) => Object.fromEntries(kept.map((h) => [h, row?.[h] ?? ''])));
  // A file with a header and no rows still goes to the function once, so the refusal or the empty answer is its own.
  for (let offset = 0; offset === 0 || offset < rows.length; offset += size) {
    const { data, error } = await client.functions.invoke('import-validation', {
      body: {
        import_type: 'games',
        action: 'stage',
        organization_id: organizationId,
        import_job_id: jobId,
        headers: sentHeaders,
        rows: sentRows.slice(offset, offset + size),
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
 * @param {Record<string, any>} mapping  `{ options: { arrive_published }, divisions, venues, fields, teams }`, each
 *   group a decision per decision key (`mappingForJob` builds it)
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
 * @returns {Promise<{ status: 'applied' | 'stale', result?: any, message?: string, differing?: string[],
 *   confirmed?: any, current?: any, preview?: any }>} `applied` with the `result`; or `stale` with the message, the
 *   counts that differ, both sets of counts and the fresh `preview` (nothing was written)
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

/**
 * Roll an applied import back. The database decides by the job alone (an admin of the job's organization may), so the
 * caller says which organization and season it is looking at, and a job of any other is refused HERE, before the call:
 * a roll back button must never undo an import of a scope that is not on screen.
 *
 * @param {any} client
 * @param {{ jobId: string, organizationId: string | null, seasonSettingsId: string | null }} input
 */
export async function rollbackGameImport(client, { jobId, organizationId, seasonSettingsId }) {
  requireClient(client);
  const found = await client
    .from('import_jobs')
    .select('id, organization_id, season_settings_id, job_type')
    .eq('id', jobId)
    .maybeSingle();
  if (found.error) throw fromRpc(found.error, 'The import could not be read.');
  const job = found.data;
  if (
    !job ||
    !organizationId ||
    !seasonSettingsId ||
    String(job.organization_id) !== String(organizationId) ||
    String(job.season_settings_id) !== String(seasonSettingsId)
  ) {
    throw refusal(
      'This is not an import of the organization and season on screen, so it is not rolled back from here.',
      'game_import_out_of_scope'
    );
  }
  const { data, error } = await client.rpc('rollback_game_import_job', {
    p_import_job_id: jobId,
  });
  if (error) throw fromRpc(error, 'The import could not be rolled back.');
  return data;
}

/**
 * Where a games import job stands, read from the job itself: its status and, once applied, the result the apply
 * stored on it. This is how a confirm whose answer never arrived is settled, and what a discard is decided on.
 *
 * @param {any} client
 * @param {string} jobId
 * @returns {Promise<{ status: string | null, result: any }>} `status` null when the job cannot be seen
 */
export async function readGameImportJobState(client, jobId) {
  requireClient(client);
  const { data, error } = await client
    .from('import_jobs')
    .select('id, status, warning_summary')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw fromRpc(error, 'The import could not be read.');
  if (!data) return { status: null, result: null };
  const stored = data.warning_summary?.game_import;
  return {
    status: String(data.status ?? ''),
    result: stored && typeof stored === 'object' ? stored : null,
  };
}

/** The one status a games job may be discarded in: staged, and not applied. */
export const GAME_IMPORT_DISCARDABLE_STATUS = 'ready_to_apply';

/**
 * Discard a staged import that was never applied: `cancel_ready_import_job` marks the job `failed` (audited
 * `import.canceled`), so it can no longer be mapped or applied. Its staged rows stay with the failed job (they hold
 * labels, dates and times, no person's data) and go when the job does.
 *
 * The discard is never sent blind. `cancel_ready_import_job` as deployed does not check the job's status: sent for a
 * job that was APPLIED it marks it `failed`, which leaves the games saved, takes the job out of the roll back and
 * audits an `import.canceled` that did not happen. So the job is read first, here, for every caller, and the call is
 * made only for a job read as `ready_to_apply`; a job that cannot be read is not discarded (the read's error is
 * thrown). The time between this read and the call is the database's to close: the function is to refuse such a job
 * itself in the next migration (docs/changes/2026-11-03-schedule-expansion.md).
 *
 * @param {any} client
 * @param {string} jobId
 * @returns {Promise<{ discarded: boolean, status: string | null }>} `discarded` false, with the status that was
 *   read, when the job was not one to discard: no call was made
 */
export async function discardGameImport(client, jobId) {
  requireClient(client);
  const { status } = await readGameImportJobState(client, jobId);
  if (status !== GAME_IMPORT_DISCARDABLE_STATUS) return { discarded: false, status };
  const { error } = await client.rpc('cancel_ready_import_job', {
    p_import_job_id: jobId,
    p_import_type: 'games',
  });
  if (error) throw fromRpc(error, 'The staged import could not be discarded.');
  return { discarded: true, status };
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
    .limit(10);
  if (error) throw fromRpc(error, 'The last games import could not be read.');
  // The latest one that wrote something: an import that found nothing to apply made no run and has nothing to undo.
  const job = (data ?? []).find((candidate) => {
    const stored = candidate?.warning_summary?.game_import;
    return stored && stored.nothing_to_apply !== true;
  });
  const result = job?.warning_summary?.game_import;
  if (!job || !result) return null;
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

/**
 * The season's saved schedule as a file the games import reads (G3): the current run's games with their slots, the
 * season's teams, the venues and fields, and the TIME TBD games that hold a date. Read whole or not at all.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string, timeZone: string | null | undefined }} params
 *   `timeZone` is the season's (`season_settings.timezone`): a game's times are read on it, never on the host's clock
 * @returns {Promise<ReturnType<typeof buildScheduleCsv> & { games: number }>}
 */
export async function readSavedScheduleCsv(client, { organizationId, seasonSettingsId, timeZone }) {
  requireClient(client);
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw refusal(
      'This season has no time zone set, so the times of its games cannot be written. Set the season’s time zone first.'
    );
  }
  // The same reading of "the current run" the Published controls use (one place decides it).
  const { runId } = await readCurrentSavedGameIds({ organizationId, seasonSettingsId, client });
  const [games, slots, league, tbd] = await Promise.all([
    runId === null
      ? []
      : fetchAllPages(() =>
          client
            .from('game_assignments')
            .select(
              'id, external_ref, game_slot_id, field_id, home_team_id, away_team_id, division, week_index, start, end'
            )
            .eq('run_id', runId)
        ),
    fetchAllPages(() =>
      client
        .from('game_slots')
        .select('id, field_id, week_index')
        .eq('organization_id', organizationId)
    ),
    readGameImportLeague(client, { organizationId, seasonSettingsId }),
    readScheduleTbd(client, seasonSettingsId),
  ]);
  const divisionName = new Map(league.divisions.map((d) => [d.id, d.name]));
  const built = buildScheduleCsv({
    games: games.map((g) => ({
      id: String(g.id),
      externalRef: g.external_ref ?? null,
      gameSlotId: g.game_slot_id ?? null,
      fieldId: g.field_id ?? null,
      homeTeamId: String(g.home_team_id),
      awayTeamId: String(g.away_team_id),
      division: g.division ?? null,
      weekIndex: g.week_index ?? null,
      start: g.start ?? null,
      end: g.end ?? null,
    })),
    timeZone,
    slots: slots.map((s) => ({
      id: String(s.id),
      fieldId: s.field_id ?? null,
      weekIndex: s.week_index ?? null,
    })),
    teams: league.teams.map((t) => ({
      id: t.id,
      name: t.name,
      division: divisionName.get(t.divisionId) ?? null,
    })),
    fields: league.fields,
    venues: league.venues,
    tbdGames: tbd.rows
      .filter((row) => row.kind === 'game')
      .map((row) => ({
        externalRef: row.external_ref ?? null,
        gameDate: row.game_date ?? null,
        weekIndex: row.week_index,
        homeTeamId: String(row.home_team_id),
        awayTeamId: String(row.away_team_id),
        division: row.division_name ?? null,
      })),
  });
  return { ...built, games: games.length };
}

/**
 * The season's games imports that were checked and never confirmed (`ready_to_apply`), newest first. Nothing ends one
 * on its own: the stale-job sweep fails only a job still `importing`, and the Import page's job screen leaves games
 * jobs to this panel. The upload step names them and offers to discard each (`discardGameImport`).
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 * @returns {Promise<Array<{ id: string, fileName: string, createdAt: string | null }>>}
 */
export async function readUnfinishedGameImportJobs(client, { organizationId, seasonSettingsId }) {
  requireClient(client);
  const { data, error } = await client
    .from('import_jobs')
    .select('id, storage_path, status, created_at, season_settings_id')
    .eq('organization_id', organizationId)
    .eq('job_type', 'games')
    .eq('season_settings_id', seasonSettingsId)
    .eq('status', 'ready_to_apply')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw fromRpc(error, 'The unfinished games imports could not be read.');
  return (data ?? []).map((job) => ({
    id: String(job.id),
    fileName: String(job.storage_path ?? '')
      .split('/')
      .pop(),
    createdAt: job.created_at ?? null,
  }));
}
