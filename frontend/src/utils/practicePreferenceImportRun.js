/**
 * Running a practice preference import (Phase D C2): the same three steps every import takes, in the
 * order `ImportContext` takes them for a coach file, written once here so the preferences screen
 * does not need the shared import context (and so the evaluations import that edits that context
 * does not collide with this one):
 *
 *   1. `create_import_job`          a job for the season shown (a draft is named; the active one is
 *                                   the server's default);
 *   2. `import-validation`          stages the file's rows in chunks (the Edge function keeps only the
 *                                   allowlisted columns and refuses a row with no valid email);
 *   3. `finalize_practice_preference_import_job`  applies the staged rows: one rule per row and team.
 *
 * A failure after the job exists marks the job failed (best effort, logged) and is thrown to the
 * caller with the database's own message; nothing is swallowed to make the screen look done.
 */

import { logger } from '../lib/logger.js';
import { withTimeout } from '../lib/withTimeout.js';
import { PreferenceRpcError } from '../hooks/useCoachPracticePreferences.js';
import {
  createImportJob,
  failImportJob,
  persistImportJobProgress,
} from './importJobLifecycleActions.js';
import { PREFERENCE_IMPORT_TYPE } from './practicePreferenceFile.js';

/** Rows sent to `import-validation` in one request (the function takes 5,000). */
export const STAGE_CHUNK_SIZE = 1000;
/** The row limit every browser import shares (`ImportContext`). */
export const MAX_IMPORT_ROWS = 10000;

/**
 * @param {Object} input
 * @param {any} input.supabase
 * @param {string} input.organizationId
 * @param {string | null} input.seasonSettingsId - named only when it is not the active season
 * @param {string} input.fileName
 * @param {Array<Record<string, unknown>>} input.rows - the file's rows with only the kept columns
 * @param {(step: string) => void} [input.onStep] - says what is happening, for the screen
 * @returns {Promise<{ importJobId: string, result: any, validationErrors: any[] }>}
 */
export async function runPracticePreferenceImport({
  supabase,
  organizationId,
  seasonSettingsId,
  fileName,
  rows,
  onStep = () => {},
}) {
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`The file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}.`);
  }
  onStep('Creating the import');
  const job = await createImportJob({
    supabase,
    organizationId,
    type: PREFERENCE_IMPORT_TYPE,
    fileName,
    seasonSettingsId,
  });

  const stage = { name: 'validation' };
  try {
    await persistImportJobProgress({ supabase, importJobId: job.id, totalRows: rows.length });

    /** @type {any[]} */
    const validationErrors = [];
    for (let start = 0; start < rows.length; start += STAGE_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + STAGE_CHUNK_SIZE);
      onStep(`Checking rows ${start + 1} to ${start + chunk.length} of ${rows.length}`);
      // 60 s guards against a function that never answers, as the other imports do.
      const { data, error } = await withTimeout(
        supabase.functions.invoke('import-validation', {
          body: {
            import_type: PREFERENCE_IMPORT_TYPE,
            organization_id: organizationId,
            rows: chunk,
            import_job_id: job.id,
            row_offset: start,
          },
        }),
        60000,
        'Import validation'
      );
      if (error || !data || data.status === 'error') {
        throw new Error(error?.message || data?.message || 'Validation failed');
      }
      for (const issue of data.validation_errors ?? []) {
        // The function numbers a chunk's rows from 1; the file's row is that plus the chunk's start.
        validationErrors.push({ ...issue, row: issue.row + start });
      }
    }

    stage.name = 'finalize';
    onStep('Applying the rules');
    const { data: result, error: finalizeError } = await supabase.rpc(
      'finalize_practice_preference_import_job',
      { p_import_job_id: job.id, p_validation_errors: validationErrors }
    );
    if (finalizeError) throw new PreferenceRpcError(finalizeError);
    return { importJobId: job.id, result, validationErrors };
  } catch (err) {
    // Best-effort cleanup: the job is marked failed so it does not sit as "importing". A failure to
    // do even that is logged; the error the person needs is the one that stopped the import.
    try {
      await failImportJob({
        supabase,
        importJobId: job.id,
        stage: stage.name,
        message: /** @type {any} */ (err)?.message || 'The preference import failed',
      });
    } catch (cleanupError) {
      logger.error('Could not mark the failed preference import job', cleanupError);
    }
    throw err;
  }
}
