const FINALIZE_RPC_BY_TYPE = {
  coaches: 'finalize_coach_import_job',
  fields: 'finalize_field_import_job',
  field_availability: 'finalize_field_availability_import_job',
};
const DEFERRED_IMPORT_TYPES = new Set(['coaches', 'fields', 'field_availability']);

const getDeferredImportTypeFromJob = (job) => {
  const deferredType = job?.warning_summary?.deferred_apply?.import_type;
  if (DEFERRED_IMPORT_TYPES.has(deferredType)) return deferredType;
  if (job?.job_type === 'fields') return 'fields';
  if (job?.job_type === 'field_availability') return 'field_availability';
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
 * What a finalize actually did, as lines for the import log.
 *
 * **One producer for both apply paths.** The refusal reporting was added to
 * `applyDeferredImport` first and the direct-apply path in `startImport` --
 * which runs the very same finalize RPCs -- went on printing only its insert
 * counts. That is the one-arm-and-not-its-twin shape this project keeps
 * finding, so the lines are built here and both callers use it.
 *
 * `invalid_rows` is returned by all three finalizers, so the count reads the
 * same whichever import this is. `unresolved_field_rows` is field_availability
 * only, and it is the one a person can act on.
 *
 * The wording is careful about what it promises. The rows ARE still staged and
 * a further finalize on the same job would apply them -- but no UI reaches that
 * today, so this does not tell anyone to "apply again" as though a button
 * existed. See the PR body for LIVE-2.
 */
export function describeFinalizeOutcome(result) {
  const lines = [];
  const invalid = Number(result?.invalid_rows) || 0;
  const unresolved = Number(result?.unresolved_field_rows) || 0;
  if (invalid > 0) {
    lines.push(
      `${invalid} row(s) were not applied. Nothing was discarded — they are still staged on this import job.`
    );
  }
  if (unresolved > 0) {
    lines.push(
      `${unresolved} of those name a field this organization does not have. Create the field, or correct the location/field spelling, and the rows can be applied without re-uploading.`
    );
  }
  return lines;
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
    throw new Error(error.message || `${type} import cancellation failed`);
  }
  return data;
}
