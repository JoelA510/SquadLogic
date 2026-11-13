/**
 * The practice schedule import, as the Import panel's Practices tab calls it (plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.11; PR 11, task L2). The sibling of `gameImportClient.js`, with
 * the same contract per step, so the panel runs both kinds through one flow:
 *
 * 1. `readPracticeImportLeague`: what the organization has that a label could mean (the season's divisions with their
 *    practice settings and teams; locations, fields and their halves or sides).
 * 2. `startPracticeImport`: an import job for the season, the WHOLE file staged through `import-validation` in one
 *    request (the parse judges the file as a whole; core's `PRACTICE_IMPORT_STAGE_LIMITS`), and the job marked ready.
 *    What the function staged is read back (`readStagedPracticeRows`) and THAT is what the mapping step shows.
 * 3. `savePracticeImportMapping` then `previewPracticeImport`: the mapping stored on the job (with the ticked probable
 *    moves in `options.add_moved_rows`), and the apply with every write undone (`apply_practice_import_job`'s dry run).
 * 4. `confirmPracticeImport`: the dry run again, refused as stale when its counts differ from the ones the admin saw,
 *    else the apply; then the division settings the admin ticked, and the TIME TBD list rebuilt with them.
 * 5. `rollbackPracticeImport`, `discardPracticeImport`, `readLatestPracticeImportJob`, `readUnfinishedPracticeImportJobs`.
 *
 * **The counts and the probable moves are the database's.** Nothing here computes a count, a flag or a pairing apart
 * from the dry run's result: `practiceImportConfirmCounts` copies the result's own `counts`, and
 * `practiceProbableMoves` groups the rows the database flagged `probable_move` (it never pairs rows itself; core's
 * `pairProbableMoves` pairs by team and sees no dates, and is not called).
 *
 * Every refusal is thrown as an `Error` with the database's or the function's own words and a `code` where it gave one.
 */

import { practiceImportReadsHeader } from '@squadlogic/core/practiceImport/parseRows.js';
import {
  PRACTICE_IMPORT_PREVIEW_STALE,
  practiceImportConfirmCounts,
} from '@squadlogic/core/practiceImport/previewCounts.js';
import {
  PRACTICE_IMPORT_STAGE_LIMITS,
  stagedPracticeRowToParsed,
} from '@squadlogic/core/practiceImport/staging.js';

// The counts a preview shows and a confirm carries are the dry run's own (core's `previewCounts.js`).
export { practiceImportConfirmCounts };
import { fetchAllPages } from '../lib/pagedFetch.js';
import { readSeasonTeamDirectory } from './scheduleReportsRead.js';
import { readScheduleTbd, refreshScheduleTbd } from './scheduleTbdClient.js';
import { functionErrorBody, refusal, requireClient, rpcRefusal } from './importClientCommon.js';

const TYPE = 'practice_schedule';

/** Words for a refusal whose database message is not written for a person. */
const RPC_REFUSAL_WORDS = {
  import_not_ready_to_apply:
    'This import is no longer waiting to be applied (it was applied or discarded in the meantime).',
  mapping_required: 'Say what each name in the file is, then preview the import again.',
  season_not_active: 'Only the active season takes a practice schedule import.',
  season_completed: 'This season is completed and takes no import.',
};

/** A database error in its own words. @param {any} error @param {string} fallback */
const fromRpc = (error, fallback) => rpcRefusal(error, fallback, RPC_REFUSAL_WORDS);

/**
 * What the organization has that a label of the file could mean, as core's mapping reads it
 * (`PracticeLeagueView`), with each division's stored practice settings.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 */
export async function readPracticeImportLeague(client, { organizationId, seasonSettingsId }) {
  requireClient(client);
  const [divisions, directory, locations, fields, subunits] = await Promise.all([
    fetchAllPages(() =>
      client
        .from('divisions')
        .select(
          'id, name, practices_per_week, practice_minutes, max_roster_size, min_roster_size, target_team_size, team_count_override, min_teams, max_teams'
        )
        .eq('organization_id', organizationId)
        .eq('season_settings_id', seasonSettingsId)
    ),
    readSeasonTeamDirectory(client, { organizationId, seasonSettingsId }),
    fetchAllPages(() =>
      client.from('locations').select('id, name').eq('organization_id', organizationId)
    ),
    fetchAllPages(() =>
      client.from('fields').select('id, name, location_id').eq('organization_id', organizationId)
    ),
    fetchAllPages(() =>
      client
        .from('field_subunits')
        .select('id, field_id, label')
        .eq('organization_id', organizationId)
    ),
  ]);
  if (directory.ok !== true) {
    throw refusal(`The season's ${directory.table} could not be read: ${directory.message}`);
  }
  return {
    divisions: divisions.map((d) => ({
      id: String(d.id),
      name: String(d.name ?? ''),
      practicesPerWeek: d.practices_per_week ?? null,
      practiceMinutes: d.practice_minutes ?? null,
      // The rules the settings save must send back as they are (`writeDivisionSettings`), as read for this import.
      roster: rosterOf(d),
    })),
    teams: directory.teams.map((t) => ({
      id: t.id,
      name: t.name,
      divisionId: t.divisionId,
      isExternal: t.isExternal,
    })),
    locations: locations.map((l) => ({ id: String(l.id), name: String(l.name ?? '') })),
    fields: fields.map((f) => ({
      id: String(f.id),
      locationId: String(f.location_id),
      name: String(f.name ?? ''),
    })),
    subunits: subunits.map((s) => ({
      id: String(s.id),
      fieldId: String(s.field_id),
      name: String(s.label ?? ''),
    })),
  };
}

/**
 * Create the job, stage the file through the Edge function and mark the job ready.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string, fileName: string, headers: string[],
 *   rows: Array<Record<string, unknown>>, dates?: { validFrom?: string | null, validUntil?: string | null } | null }} input
 */
export async function startPracticeImport(
  client,
  { organizationId, seasonSettingsId, fileName, headers, rows, dates }
) {
  requireClient(client);
  if (rows.length > PRACTICE_IMPORT_STAGE_LIMITS.MAX_ROWS) {
    throw refusal(
      `The file has ${rows.length.toLocaleString('en-US')} rows; one import takes at most ${PRACTICE_IMPORT_STAGE_LIMITS.MAX_ROWS.toLocaleString('en-US')}. Split it and import the parts one after the other.`,
      'too-many-rows'
    );
  }
  // A file with more columns than the import reads is refused here, before a job is made, and never cut: a column the
  // import reads past the cap (a Team) would be dropped while its values stayed, and a placement would read as an
  // open slot (Codex on #732).
  if (headers.length > PRACTICE_IMPORT_STAGE_LIMITS.MAX_HEADERS) {
    throw refusal(
      `The file has ${headers.length} columns; one import reads at most ${PRACTICE_IMPORT_STAGE_LIMITS.MAX_HEADERS}. Remove the columns it does not need and choose it again.`,
      'too-many-columns'
    );
  }
  const created = await client.rpc('create_import_job', {
    p_organization_id: organizationId,
    p_import_type: TYPE,
    p_file_name: fileName,
    p_season_settings_id: seasonSettingsId,
  });
  if (created.error) throw fromRpc(created.error, 'The import could not be started.');
  const jobId = created.data?.id ?? created.data?.job_id ?? created.data;
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('The import could not be started: the job came back without an id.');
  }

  // Only the columns the import reads leave the browser (the function drops the rest too, but a coach, an email or a
  // note in the file has no reason to travel). The header row goes whole, as names, so the dropped ones are named.
  const kept = headers.filter((header) => practiceImportReadsHeader(header));
  const sentRows = rows.map((row) => Object.fromEntries(kept.map((h) => [h, row?.[h] ?? ''])));
  const { data, error } = await client.functions.invoke('import-validation', {
    body: {
      import_type: TYPE,
      action: 'stage',
      organization_id: organizationId,
      import_job_id: jobId,
      headers,
      rows: sentRows,
      dates: {
        valid_from: dates?.validFrom || null,
        valid_until: dates?.validUntil || null,
      },
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
  const summary = data.summary;
  const ready = await client.rpc('mark_import_job_ready_to_apply', {
    p_import_job_id: jobId,
    p_import_type: TYPE,
    p_validation_errors: (summary.refused_rows ?? []).map((r) => ({
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
 */
export async function readStagedPracticeRows(client, jobId) {
  requireClient(client);
  const staged = await fetchAllPages(
    () =>
      client
        .from('staging_import_rows')
        .select('id, source_row_number, normalized_payload, validation_errors')
        .eq('import_job_id', jobId)
        .eq('import_type', TYPE),
    { orderBy: 'source_row_number' }
  );
  return staged
    .slice()
    .sort((a, b) => Number(a.source_row_number) - Number(b.source_row_number))
    .map((row) => stagedPracticeRowToParsed(row));
}

/**
 * Store the admin's decisions, and the ticked probable moves, on the job.
 *
 * @param {any} client
 * @param {string} jobId
 * @param {Record<string, any>} mapping  `{ options: { add_moved_rows }, divisions, locations, fields, subunits, teams }`
 */
export async function savePracticeImportMapping(client, jobId, mapping) {
  requireClient(client);
  const { data, error } = await client.rpc('map_practice_import_job', {
    p_import_job_id: jobId,
    p_mapping: mapping,
  });
  if (error) throw fromRpc(error, 'The mapping could not be saved.');
  return data;
}

/**
 * The preview: the apply with every write undone (the database's sentinel), so its counts and flags are the apply's.
 *
 * @param {any} client
 * @param {string} jobId
 */
export async function previewPracticeImport(client, jobId) {
  requireClient(client);
  const { data, error } = await client.rpc('apply_practice_import_job', {
    p_import_job_id: jobId,
    p_dry_run: true,
  });
  if (error) throw fromRpc(error, 'The preview could not be made.');
  if (!data || typeof data !== 'object' || !data.counts || typeof data.counts !== 'object') {
    throw new Error('The preview came back in a shape this page cannot read.');
  }
  return data;
}

/** The roster rules of a division row, which `admin_upsert_division_settings` SETS to what it is given. */
export const ROSTER_RULES = Object.freeze([
  'max_roster_size',
  'min_roster_size',
  'target_team_size',
  'team_count_override',
  'min_teams',
  'max_teams',
]);
/** @param {Record<string, any>} row */
function rosterOf(row) {
  return Object.fromEntries(ROSTER_RULES.map((key) => [key, row?.[key] ?? null]));
}

/**
 * Save a division's practice settings, its other rules sent back as they are: `admin_upsert_division_settings` SETS the
 * roster rules to what it is given (a null clears them), and no RPC sets the practice settings alone (a follow-up in
 * the plan). The division is read again just before the write, and the write is refused, in words, when its roster
 * rules are no longer the ones this import read (`expected`): another admin changed them, and sending the old values
 * would undo that.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string, divisionId: string, expected: Record<string, any> | null,
 *   practicesPerWeek?: number, practiceMinutes?: number | 'any' }} patch
 */
async function writeDivisionSettings(
  client,
  { organizationId, seasonSettingsId, divisionId, expected, practicesPerWeek, practiceMinutes }
) {
  const found = await client
    .from('divisions')
    .select(`id, name, ${ROSTER_RULES.join(', ')}`)
    .eq('id', divisionId)
    .eq('organization_id', organizationId)
    .eq('season_settings_id', seasonSettingsId)
    .maybeSingle();
  if (found.error) throw fromRpc(found.error, 'The division could not be read.');
  if (!found.data) throw refusal('The division is not one of this season’s.');
  const d = found.data;
  const now = rosterOf(d);
  const changed = ROSTER_RULES.filter(
    (key) => expected === null || JSON.stringify(now[key]) !== JSON.stringify(expected[key] ?? null)
  );
  if (changed.length > 0) {
    throw refusal(
      `its team rules (${changed.join(', ').replace(/_/g, ' ')}) changed after this import read them, so saving here would undo that change; nothing was saved for it`,
      'division_rules_changed'
    );
  }
  const { error } = await client.rpc('admin_upsert_division_settings', {
    p_organization_id: organizationId,
    p_season_settings_id: seasonSettingsId,
    p_division_id: divisionId,
    p_name: d.name,
    p_max_roster_size: d.max_roster_size ?? null,
    p_min_roster_size: d.min_roster_size ?? null,
    p_target_team_size: d.target_team_size ?? null,
    p_team_count_override: d.team_count_override ?? null,
    p_min_teams: d.min_teams ?? null,
    p_max_teams: d.max_teams ?? null,
    // null keeps the stored value; 0 is "any slot length"
    p_practices_per_week: practicesPerWeek ?? null,
    p_practice_minutes:
      practiceMinutes === undefined ? null : practiceMinutes === 'any' ? 0 : practiceMinutes,
  });
  if (error) throw fromRpc(error, 'The division settings could not be saved.');
  return String(d.name ?? '');
}

/**
 * The division settings the admin ticked, saved through the audited `admin_upsert_division_settings`, then the TIME TBD
 * list rebuilt so it counts by them and read back, so the result shows the teams short AFTER the settings. Only an
 * existing division is offered a setting (one the import creates is set on the Team Analysis page after the confirm:
 * a setting on it would make a roll back keep it as changed). Each division is said, saved or not; one that fails does
 * not stop the others, and the import stays applied. A roll back of the import does not undo a saved setting.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string,
 *   patches: Array<{ divisionId: string, isNew?: boolean, name?: string, roster?: Record<string, any> | null,
 *     practicesPerWeek?: number, practiceMinutes?: number | 'any' }> }} input
 * @returns {Promise<{ saved: Array<{ name: string }>, failed: Array<{ name: string, message: string }>,
 *   refreshed: boolean, refreshMessage: string | null,
 *   tbd: Array<{ team_id: string, missing_count: number }> | null }>}
 */
export async function applyPracticeDivisionSettings(
  client,
  { organizationId, seasonSettingsId, patches }
) {
  requireClient(client);
  const saved = [];
  const failed = [];
  for (const patch of patches) {
    const label = patch.name ?? patch.divisionId;
    try {
      if (patch.isNew) {
        throw refusal('a division this import creates is set on the Team Analysis page');
      }
      const name = await writeDivisionSettings(client, {
        organizationId,
        seasonSettingsId,
        divisionId: patch.divisionId,
        expected: patch.roster ?? null,
        practicesPerWeek: patch.practicesPerWeek,
        practiceMinutes: patch.practiceMinutes,
      });
      saved.push({ name: name || label });
    } catch (err) {
      failed.push({ name: label, message: String(err?.message ?? err) });
    }
  }
  let refreshed = false;
  let refreshMessage = null;
  let tbd = null;
  if (saved.length > 0) {
    try {
      await refreshScheduleTbd(client, seasonSettingsId);
      refreshed = true;
      const list = await readScheduleTbd(client, seasonSettingsId);
      tbd = (list.rows ?? [])
        .filter((row) => row.kind === 'practice' && row.team_id)
        .map((row) => ({ team_id: String(row.team_id), missing_count: Number(row.missing_count) }));
    } catch (err) {
      refreshMessage = String(err?.message ?? err);
    }
  }
  return { saved, failed, refreshed, refreshMessage, tbd };
}

/**
 * The confirm, through the Edge function (`import-validation`, `action: 'apply'`): it runs the dry run again as the
 * admin and applies only when its counts are still the ones the admin saw; else nothing is written and the fresh
 * preview comes back as `stale`. Then the ticked division settings.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId?: string, jobId: string, confirmed: Record<string, number>,
 *   extra?: { settings?: Array<any> } }} input
 */
export async function confirmPracticeImport(
  client,
  { organizationId, seasonSettingsId, jobId, confirmed, extra }
) {
  requireClient(client);
  const { data, error } = await client.functions.invoke('import-validation', {
    body: {
      import_type: TYPE,
      action: 'apply',
      organization_id: organizationId,
      import_job_id: jobId,
      confirmed,
    },
  });
  if (error) {
    const body = await functionErrorBody(error);
    if (body?.code === PRACTICE_IMPORT_PREVIEW_STALE && body.preview) {
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
      RPC_REFUSAL_WORDS[body?.code] ||
        body?.message ||
        error.message ||
        'The import could not be applied.',
      body?.code ?? null,
      body
    );
  }
  const result = data?.result;
  if (data?.status !== 'success' || !result || typeof result !== 'object' || !result.counts) {
    throw new Error('The import answered in a shape this page cannot read.');
  }
  if (result.replayed === true) return { status: 'applied', result };
  const patches = extra?.settings ?? [];
  const settings =
    patches.length > 0 && seasonSettingsId
      ? await applyPracticeDivisionSettings(client, {
          organizationId,
          seasonSettingsId,
          patches,
        })
      : null;
  return { status: 'applied', result, settings };
}

/**
 * Roll an applied import back, for the organization and season on screen only (a job of any other is refused here,
 * before the call).
 *
 * @param {any} client
 * @param {{ jobId: string, organizationId: string | null, seasonSettingsId: string | null }} input
 */
export async function rollbackPracticeImport(client, { jobId, organizationId, seasonSettingsId }) {
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
    job.job_type !== TYPE ||
    String(job.organization_id) !== String(organizationId) ||
    String(job.season_settings_id) !== String(seasonSettingsId)
  ) {
    throw refusal(
      'This is not a practice import of the organization and season on screen, so it is not rolled back from here.',
      'practice_import_out_of_scope'
    );
  }
  const { data, error } = await client.rpc('rollback_practice_import_job', {
    p_import_job_id: jobId,
  });
  if (error) throw fromRpc(error, 'The import could not be rolled back.');
  return data;
}

/**
 * Where a practice import job stands, read from the job itself: its status and, once applied, the result the apply
 * stored on it.
 *
 * @param {any} client
 * @param {string} jobId
 * @returns {Promise<{ status: string | null, result: any }>}
 */
export async function readPracticeImportJobState(client, jobId) {
  requireClient(client);
  const { data, error } = await client
    .from('import_jobs')
    .select('id, status, warning_summary')
    .eq('id', jobId)
    .maybeSingle();
  if (error) throw fromRpc(error, 'The import could not be read.');
  if (!data) return { status: null, result: null };
  const stored = data.warning_summary?.practice_import;
  return {
    status: String(data.status ?? ''),
    result: stored && typeof stored === 'object' ? stored : null,
  };
}

/** The one status a practice job may be discarded in: staged, and not applied. */
export const PRACTICE_IMPORT_DISCARDABLE_STATUS = 'ready_to_apply';

/**
 * Discard a staged import that was never applied (`cancel_ready_import_job`, audited `import.canceled`). The job is
 * read first, and the call is made only for one read as `ready_to_apply`.
 *
 * @param {any} client
 * @param {string} jobId
 * @returns {Promise<{ discarded: boolean, status: string | null }>}
 */
export async function discardPracticeImport(client, jobId) {
  requireClient(client);
  const { status } = await readPracticeImportJobState(client, jobId);
  if (status !== PRACTICE_IMPORT_DISCARDABLE_STATUS) return { discarded: false, status };
  const { error } = await client.rpc('cancel_ready_import_job', {
    p_import_job_id: jobId,
    p_import_type: TYPE,
  });
  if (error?.details === 'import_not_ready_to_apply') {
    return { discarded: false, status: (await readPracticeImportJobState(client, jobId)).status };
  }
  if (error) throw fromRpc(error, 'The staged import could not be discarded.');
  return { discarded: true, status };
}

/**
 * The season's applied practice imports, newest first (rolled back ones are `needs_fix` and are not read).
 * @param {any} client @param {{ organizationId: string, seasonSettingsId: string }} params
 */
async function readAppliedPracticeJobs(client, { organizationId, seasonSettingsId }) {
  const { data, error } = await client
    .from('import_jobs')
    .select('id, storage_path, status, completed_at, warning_summary, season_settings_id')
    .eq('organization_id', organizationId)
    .eq('job_type', TYPE)
    .eq('season_settings_id', seasonSettingsId)
    .in('status', ['completed', 'completed_with_warnings'])
    .order('completed_at', { ascending: false })
    .limit(10);
  if (error) throw fromRpc(error, 'The last practice import could not be read.');
  return data ?? [];
}

/**
 * The season's most recent practice import that was applied, not rolled back and wrote something, or null: the one
 * the panel still offers to roll back after a reload.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 * @returns {Promise<{ id: string, fileName: string, completedAt: string | null, result: any } | null>}
 */
export async function readLatestPracticeImportJob(client, params) {
  requireClient(client);
  const jobs = await readAppliedPracticeJobs(client, params);
  const job = jobs.find((candidate) => {
    const c = candidate?.warning_summary?.practice_import?.counts;
    return (
      c &&
      Number(c.inserted ?? 0) +
        Number(c.slots_created ?? 0) +
        Number(c.team_shells_created ?? 0) +
        Number(c.divisions_created ?? 0) +
        Number(c.locations_created ?? 0) +
        Number(c.fields_created ?? 0) +
        Number(c.subunits_created ?? 0) >
        0
    );
  });
  if (!job) return null;
  return {
    id: String(job.id),
    fileName: String(job.storage_path ?? '')
      .split('/')
      .pop(),
    completedAt: job.completed_at ?? null,
    result: job.warning_summary.practice_import,
  };
}

/**
 * The mapping stored on the season's previous completed practice import (decision 30's third proposal), or null.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 */
export async function readPreviousPracticeMapping(client, params) {
  requireClient(client);
  const jobs = await readAppliedPracticeJobs(client, params);
  const mapping = jobs.find((job) => job?.warning_summary?.practice_mapping)?.warning_summary
    ?.practice_mapping;
  return mapping && typeof mapping === 'object' ? mapping : null;
}

/**
 * The season's practice imports that were checked and never confirmed (`ready_to_apply`), newest first.
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string }} params
 */
export async function readUnfinishedPracticeImportJobs(
  client,
  { organizationId, seasonSettingsId }
) {
  requireClient(client);
  const { data, error } = await client
    .from('import_jobs')
    .select('id, storage_path, status, created_at, season_settings_id')
    .eq('organization_id', organizationId)
    .eq('job_type', TYPE)
    .eq('season_settings_id', seasonSettingsId)
    .eq('status', 'ready_to_apply')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw fromRpc(error, 'The unfinished practice imports could not be read.');
  return (data ?? []).map((job) => ({
    id: String(job.id),
    fileName: String(job.storage_path ?? '')
      .split('/')
      .pop(),
    createdAt: job.created_at ?? null,
  }));
}

/**
 * The probable moves of a dry run, team by team, from the rows the DATABASE flagged and nothing else (requirement of
 * the PR 10 review): a team has a move when the dry run marks at least one of its new rows `probable_move` (the
 * database scopes that by dates: a saved practice is leaving only when its range meets the team's dates in the file,
 * and a new row is a move only when a leaving row meets its own). The team's leaving rows are the dry run's `leaving`
 * rows of that team. No row is paired with another, and no date is compared here.
 *
 * @param {any} preview  a result of `apply_practice_import_job`
 * @returns {Array<{ teamId: string, team: string, leaving: any[], arriving: any[], heldBack: number, summary: string }>}
 */
export function practiceProbableMoves(preview) {
  const arriving = Array.isArray(preview?.arriving) ? preview.arriving : [];
  const leaving = Array.isArray(preview?.leaving) ? preview.leaving : [];
  /** @type {Map<string, any[]>} */
  const byTeam = new Map();
  for (const row of arriving) {
    if (row?.probable_move !== true) continue;
    const team = String(row.team_id);
    byTeam.set(team, [...(byTeam.get(team) ?? []), row]);
  }
  const plural = (n) => `${n} ${n === 1 ? 'row' : 'rows'}`;
  return [...byTeam.entries()]
    .map(([teamId, rows]) => {
      const out = leaving.filter((l) => String(l.team_id) === teamId);
      const team = String(rows[0]?.team ?? out[0]?.team ?? teamId);
      return {
        teamId,
        team,
        leaving: out,
        arriving: rows,
        heldBack: rows.filter((r) => r.added !== true).length,
        summary: `${team}: ${plural(out.length)} leaving, ${plural(rows.length)} arriving`,
      };
    })
    .sort((a, b) => (a.team < b.team ? -1 : a.team > b.team ? 1 : a.teamId < b.teamId ? -1 : 1));
}
