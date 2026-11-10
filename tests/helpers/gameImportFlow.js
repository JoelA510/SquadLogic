/**
 * The games import driven the way the panel drives it, step by step, over a supabase client (the real mock client in
 * the tests): stage through `import-validation`, read the staged rows back, map (every single match stands, the given
 * choices on top), preview. Used by the twins and the round trip so they run the calls the panel runs.
 */
import {
  proposeScheduleMapping,
  scheduleImportConfirmCounts,
} from '../../packages/core/src/scheduleImport/index.js';
import {
  confirmGameImport,
  previewGameImport,
  readGameImportLeague,
  readStagedGameRows,
  saveGameImportMapping,
  startGameImport,
} from '../../frontend/src/utils/gameImportClient.js';
import { decisionsFromChoices, mappingForJob } from '../../frontend/src/utils/gameImportMapping.js';

/**
 * Stage a file and store its mapping; returns the job and the preview (the dry run).
 *
 * @param {any} client
 * @param {{ organizationId: string, seasonSettingsId: string, headers: string[], rows: Array<Record<string, string>>,
 *   choices?: Record<string, Record<string, string>>, arrivePublished?: boolean, fileName?: string }} input
 */
export async function stageMapPreview(
  client,
  {
    organizationId,
    seasonSettingsId,
    headers,
    rows,
    choices = {},
    arrivePublished = true,
    fileName = 'schedule.csv',
  }
) {
  const params = { organizationId, seasonSettingsId };
  const started = await startGameImport(client, { ...params, fileName, headers, rows });
  const staged = await readStagedGameRows(client, started.jobId);
  const league = await readGameImportLeague(client, params);
  const proposal = proposeScheduleMapping({
    rows: staged,
    league,
    decisions: decisionsFromChoices(choices),
  });
  const mapping = mappingForJob(proposal, choices, arrivePublished);
  await saveGameImportMapping(client, started.jobId, mapping);
  const preview = await previewGameImport(client, started.jobId);
  return {
    jobId: started.jobId,
    summary: started.summary,
    staged,
    league,
    proposal,
    mapping,
    preview,
  };
}

/** Confirm a preview as the panel does: with the counts of the preview on screen. */
export const confirmPreview = (client, { organizationId, jobId, preview }) =>
  confirmGameImport(client, {
    organizationId,
    jobId,
    confirmed: scheduleImportConfirmCounts(preview),
  });
