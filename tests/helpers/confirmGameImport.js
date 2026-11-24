import { scheduleImportConfirmCounts } from '../../packages/core/src/scheduleImport/previewCounts.js';

/** Confirm the preview for tests that exercise the resulting schedule or its rollback. */
export function confirmGameImport(rpc, db, id) {
  const preview = rpc(db, 'apply_game_import_job', { p_import_job_id: id, p_dry_run: true });
  if (preview.error) throw new Error(preview.error.message);
  return rpc(db, 'apply_game_import_job', {
    p_import_job_id: id,
    p_dry_run: false,
    p_confirmed_counts: scheduleImportConfirmCounts(preview.data),
  });
}
