/**
 * The pending musts grouped by the import file they came from (Phase D C2): what the Pending musts
 * list shows under each file's name, and what Accept all means by "this file".
 */

import { priorityRank } from './coachPreferencePreview.js';

/** The day a file was imported, for a group's name. */
function dayOf(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : null;
}

/**
 * The pending musts grouped by the import file they came from, newest file first, and within a
 * file the coach's priority first (High, Medium, Low, none), then the oldest. A must with no file
 * (`import_job_id` null) is its own group: it has no file for Accept all to mean.
 *
 * @param {any[]} pending - rows with `must_decision` pending
 * @param {Map<string, { fileName: string, createdAt: string | null }>} labels - by import job id
 * @param {(coachId: string) => string} coachName
 */
export function groupPendingMusts(pending, labels, coachName) {
  /** @type {Map<string, any[]>} */
  const byJob = new Map();
  for (const row of pending) {
    const key = row.import_job_id ? String(row.import_job_id) : '';
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key).push(row);
  }
  const groups = [...byJob.entries()].map(([jobId, rows]) => {
    const sorted = [...rows].sort(
      (a, b) =>
        priorityRank(a.coach_priority) - priorityRank(b.coach_priority) ||
        String(a.created_at).localeCompare(String(b.created_at)) ||
        coachName(a.coach_id).localeCompare(coachName(b.coach_id)) ||
        String(a.id).localeCompare(String(b.id))
    );
    const label = jobId ? labels.get(jobId) : null;
    return {
      jobId,
      rows: sorted,
      fileName: label?.fileName ?? null,
      importedOn: dayOf(label?.createdAt) ?? dayOf(sorted[0]?.created_at),
    };
  });
  return groups.sort(
    (a, b) =>
      String(b.importedOn).localeCompare(String(a.importedOn)) || a.jobId.localeCompare(b.jobId)
  );
}

export function groupTitle(group) {
  if (!group.jobId) return 'Musts with no import file';
  const from = group.fileName ? `“${group.fileName}”` : 'a preference file';
  return `From ${from}${group.importedOn ? `, imported ${group.importedOn}` : ''}`;
}
