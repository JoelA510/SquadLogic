const FINALIZE_RPC_BY_TYPE = {
  coaches: 'finalize_coach_import_job',
  evaluations: 'finalize_evaluation_import_job',
  fields: 'finalize_field_import_job',
  field_availability: 'finalize_field_availability_import_job',
};
const DEFERRED_IMPORT_TYPES = new Set(['coaches', 'evaluations', 'fields', 'field_availability']);

const getDeferredImportTypeFromJob = (job) => {
  const deferredType = job?.warning_summary?.deferred_apply?.import_type;
  if (DEFERRED_IMPORT_TYPES.has(deferredType)) return deferredType;
  if (job?.job_type === 'fields') return 'fields';
  if (job?.job_type === 'field_availability') return 'field_availability';
  if (job?.job_type === 'evaluations') return 'evaluations';
  return null;
};

export function buildDeferredImportDataFromJob(job) {
  const importType = getDeferredImportTypeFromJob(job);
  if (!job || !importType) return null;

  const validationErrors = job.error_summary?.rowErrors || [];
  const readySummary = job.warning_summary?.deferred_apply || {
    status: 'ready_to_apply',
    import_type: importType,
    staged_rows: job.processed_rows || 0,
    validation_error_rows: validationErrors.length,
  };

  return {
    importJobId: job.id,
    fileName: job.storage_path?.split('/').pop() || `${importType}.csv`,
    totalRows: job.total_rows || 0,
    validRows: readySummary.staged_rows || job.processed_rows || 0,
    errorRows: validationErrors.length,
    timestamp: job.created_at ? new Date(job.created_at) : new Date(),
    data: [],
    validationErrors,
    persistence: {
      durable: true,
      deferred: true,
      ready: readySummary,
      result: null,
    },
  };
}

/**
 * Import types whose finalizer will RETRY a row it once refused.
 *
 * **Only field_availability.** The coach and field finalizers select their
 * staged rows with `AND COALESCE(jsonb_array_length(validation_errors), 0) = 0`
 * (`20260503060000:194`, `20260503070000:211`, `20260726000300:715`), so a row
 * they counted in `invalid_rows` has just had its errors written to it and is
 * excluded from every future finalize -- the refusal is terminal.
 * `finalize_field_availability_import_job` deliberately omits that clause so a
 * row refused for an unresolvable field can be applied once the field exists;
 * its migration header argues why, and its smoke asserts the clause stays
 * absent.
 *
 * The distinction is here because the LOG LINE differs: telling an operator
 * that three refused rows of a FIELDS import are "still staged" would promise
 * a recovery that finalizer does not offer.
 */
const REPLAYS_REFUSED_ROWS = new Set(['field_availability']);

/**
 * What a finalize actually did, as lines for the import log.
 *
 * **One producer for both apply paths.** The refusal reporting was added to
 * `applyDeferredImport` first and the direct-apply path in `startImport` --
 * which runs the very same finalize RPCs -- went on printing only its insert
 * counts. That is the one-arm-and-not-its-twin shape this project keeps
 * finding, so the lines are built here and both callers use it.
 *
 * The wording is careful about what it promises. A replayable row IS still
 * staged and a further finalize on the same job would apply it -- but no UI
 * reaches that today, so this does not tell anyone to "apply again" as though a
 * button existed. See the PR body for LIVE-2.
 */
export function describeFinalizeOutcome(result, importType) {
  const lines = [];
  const invalid = Number(result?.invalid_rows) || 0;
  const unresolved = Number(result?.unresolved_field_rows) || 0;
  const replayable = REPLAYS_REFUSED_ROWS.has(importType);
  if (importType === 'coaches') {
    // S7: the coach's children, named by player registration id. An id that matches no player of
    // the organization wrote no link and is never fatal; players are imported before coaches.
    const linked = Number(result?.linked_children) || 0;
    const unmatched = Number(result?.unmatched_child_id_count) || 0;
    if (linked > 0) {
      lines.push(
        `${linked} child link(s) written; they anchor each coach's team when teams are generated.`
      );
    }
    if (unmatched > 0) {
      const listed = (Array.isArray(result?.unmatched_child_ids) ? result.unmatched_child_ids : [])
        .map((item) => item?.registration_id)
        .filter(Boolean);
      const shown = listed.slice(0, 10).join(', ');
      const more = unmatched - Math.min(listed.length, 10);
      lines.push(
        `${unmatched} child registration id(s) match no player in this organization, so no link was written for them${shown ? `: ${shown}${more > 0 ? `, and ${more} more` : ''}` : ''}. Import players first, then import the coaches again.`
      );
    }
  }
  if (importType === 'evaluations') lines.push(...describeEvaluationOutcome(result));
  if (invalid > 0) {
    lines.push(
      replayable
        ? `${invalid} row(s) were not applied. Nothing was discarded — they are still staged on this import job.`
        : `${invalid} row(s) were not applied. Their errors are recorded against the staged rows, and a further apply will not retry them.`
    );
  }
  if (unresolved > 0) {
    // **"of those" needs the line above it to exist.** The two branches gate
    // independently, so a result reporting unresolved rows and no invalid ones
    // produced a sentence with no antecedent. No SQL or mock path yields that
    // today -- every unresolved row is also counted invalid -- but this is an
    // exported helper with its own tests, and a caller that reaches the state
    // should get a sentence rather than a dangling reference.
    lines.push(
      `${unresolved}${invalid > 0 ? ' of those' : ' row(s)'} name a field this organization does not have. Create the field, or correct the location/field spelling, and the rows can be applied without re-uploading.`
    );
  }
  return lines;
}

/** How many of a list's entries are named in a log line; the rest are counted. */
const NAMED_IN_LOG = 10;

/**
 * What an evaluations finalize (or its dry run) did to the players, as log lines (E3c): who was
 * updated, who matched nobody (listed, never created), and who repeated an id. The invalid rows
 * are the generic line above. Counts come from the server's result, not recounted here.
 * @param {Record<string, any> | null | undefined} result
 * @returns {string[]}
 */
function describeEvaluationOutcome(result) {
  const lines = [];
  const dry = result?.dry_run === true;
  const updated = Number(result?.updated_players) || 0;
  const unchanged = Number(result?.unchanged_players) || 0;
  const unmatched = Number(result?.unmatched_rows) || 0;
  const duplicates = Number(result?.duplicate_rows) || 0;
  lines.push(
    `${updated} player(s) ${dry ? 'would be updated' : 'updated'}; ${unchanged} already had these values or had nothing to set.`
  );
  if (unmatched > 0) {
    const named = (Array.isArray(result?.unmatched) ? result.unmatched : [])
      .map((item) => item?.registration_id)
      .filter(Boolean)
      .slice(0, NAMED_IN_LOG);
    const more = unmatched - named.length;
    lines.push(
      `${unmatched} row(s) match no player in this season and ${dry ? 'will be skipped' : 'were skipped'}; no player is created from them${named.length ? `: ${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}` : ''}. Import the season's players first, then import these again.`
    );
  }
  if (duplicates > 0) {
    lines.push(
      `${duplicates} row(s) repeat a registration id that appears earlier in the file; only the first row of each was used.`
    );
  }
  return lines;
}

/**
 * The evaluations import's dry run: the same server code as the apply, writing nothing, so the
 * counts and the lists shown before the confirm are the ones the apply will produce.
 * @returns {Promise<Record<string, any>>}
 */
export async function previewEvaluationImportJob({ supabase, importJobId, validationErrors = [] }) {
  const { data, error } = await supabase.rpc('finalize_evaluation_import_job', {
    p_import_job_id: importJobId,
    p_validation_errors: validationErrors,
    p_dry_run: true,
  });
  if (error) {
    throw new Error(error.message || 'Could not preview the evaluations import');
  }
  return data;
}

export async function markDeferredImportReady({
  supabase,
  job,
  type,
  fileName,
  totalRows,
  normalizedData,
  validationErrors = [],
}) {
  const { data, error } = await supabase.rpc('mark_import_job_ready_to_apply', {
    p_import_job_id: job.id,
    p_import_type: type,
    p_validation_errors: validationErrors,
  });

  if (error) {
    throw new Error(error.message || 'Could not mark import ready to apply');
  }

  return {
    importData: {
      importJobId: job.id,
      fileName,
      totalRows,
      validRows: normalizedData.length,
      errorRows: validationErrors.length,
      timestamp: new Date(),
      data: normalizedData,
      validationErrors,
      persistence: {
        durable: true,
        deferred: true,
        ready: data,
        result: null,
      },
    },
    activeJob: {
      ...job,
      status: 'ready_to_apply',
      processed_rows: normalizedData.length,
      progress_percent: 100,
      error_summary: { rowErrors: validationErrors },
      warning_summary: {
        ...(job.warning_summary || {}),
        deferred_apply: data,
      },
    },
  };
}

export async function finalizeDeferredImportJob({
  supabase,
  type,
  importJobId,
  validationErrors = [],
}) {
  const rpcName = FINALIZE_RPC_BY_TYPE[type];
  if (!rpcName) {
    throw new Error(`Deferred apply is not available for ${type} imports`);
  }

  const { data, error } = await supabase.rpc(rpcName, {
    p_import_job_id: importJobId,
    p_validation_errors: validationErrors,
  });

  if (error) {
    throw new Error(error.message || `${type} import finalization failed`);
  }
  return data;
}

export async function cancelDeferredImportJob({ supabase, type, importJobId }) {
  const { data, error } = await supabase.rpc('cancel_ready_import_job', {
    p_import_job_id: importJobId,
    p_import_type: type,
  });

  if (error) {
    // 20261122010000: the function refuses a job that is not `ready_to_apply` (one applied or cancelled in another
    // tab). That is not a failure to retry: the job is read, and the answer says what it IS, so the caller can settle
    // its own state from it. Anything else, and a job that cannot be read, throws as before.
    if (error.details === 'import_not_ready_to_apply') {
      const { data: job, error: readError } = await supabase
        .from('import_jobs')
        .select('id, status')
        .eq('id', importJobId)
        .maybeSingle();
      if (!readError && job?.status) {
        const applied = String(job.status).startsWith('completed');
        return {
          status: 'not_cancelled',
          job_status: job.status,
          applied,
          message: applied
            ? 'This import was already applied, in another tab or by someone else, so there was nothing to cancel. It is listed with the finished imports.'
            : 'This import is no longer waiting to be applied (it was cancelled or closed elsewhere), so there was nothing to cancel. The form has been cleared.',
        };
      }
    }
    throw new Error(error.message || `${type} import cancellation failed`);
  }
  return data;
}
