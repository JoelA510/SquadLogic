/**
 * Creates an import job. `seasonSettingsId` names the season the import adds to when it is not
 * the organization's active one (a draft); left out, the server uses the active season. It is
 * sent only when given, so a call for the active season has the shape it always had.
 */
export async function createImportJob({
  supabase,
  organizationId,
  type,
  fileName,
  seasonSettingsId = null,
}) {
  const { data, error } = await supabase.rpc('create_import_job', {
    p_organization_id: organizationId,
    p_import_type: type,
    p_file_name: fileName,
    ...(seasonSettingsId ? { p_season_settings_id: seasonSettingsId } : {}),
  });

  if (error) {
    throw new Error(error.message || 'Could not create import job');
  }
  return data;
}

export async function persistImportJobProgress({
  supabase,
  importJobId,
  progressPercent = null,
  processedRows = null,
  totalRows = null,
  efficiencyMetadata = null,
}) {
  const { data, error } = await supabase.rpc('update_import_job_progress', {
    p_import_job_id: importJobId,
    p_progress_percent: progressPercent,
    p_processed_rows: processedRows,
    p_total_rows: totalRows,
    p_efficiency_metadata: efficiencyMetadata,
  });

  if (error) {
    throw new Error(error.message || 'Could not update import job progress');
  }
  return data;
}

export async function failImportJob({ supabase, importJobId, message, stage, errorSummary = {} }) {
  const { data, error } = await supabase.rpc('fail_import_job', {
    p_import_job_id: importJobId,
    p_message: message,
    p_error_summary: {
      ...errorSummary,
      stage,
    },
  });

  if (error) {
    throw new Error(error.message || 'Could not fail import job');
  }
  return data;
}
