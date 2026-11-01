/**
 * The mock's `finalize_evaluation_import_job` (migration `20261113010000_evaluations_import.sql`,
 * Phase E3c; plan `docs/changes/2026-10-27-season-enrollment.md`, C2): the evaluations import,
 * years played, a skill tier and a 1-5 rating by registration id onto the players of ONE season.
 *
 * **What the SQL does and this mirrors, refusals included.**
 *   - 42501 for a caller who does not administer the job's organization, P0002 for no such job,
 *     22023 for a job of another type, a cancelled one, or validation errors that are not an array;
 *   - a finished job answers with the result it stored (`replayed: true`);
 *   - the job's season (else the active one): none is `season_missing`, a completed one is refused
 *     22023 `season_completed` before anything is read or written, dry run included;
 *   - each staged row is judged whole (`validateEvaluationRow`, the SQL's rules): a bad cell or no
 *     registration id makes it invalid, none of it applied; a repeated registration id uses the
 *     lowest row number and lists the rest; a row names a player of THIS season by registration id,
 *     as text, or it is unmatched and nothing is created; a blank cell leaves the stored value
 *     alone and a zero is a value; a value is written only when it differs;
 *   - `p_dry_run` computes the same result and writes nothing;
 *   - an apply marks the processed staged rows, finishes the job, and audits `import.completed`
 *     with the counts and no registration ids.
 *
 * **Not mirrored:** the lock the SQL takes, and the read-only trigger on `players` (a completed
 * season is refused before it could matter). Pure over `db`; `mockSupabaseClient.js` saves it.
 */
import { evaluationRegistrationId, validateEvaluationRow } from '../utils/importEvaluations.js';
import { enrollmentRefusal, importSeasonMissing, importSeasonOf } from './mockEnrollment.js';

export const EVALUATION_IMPORT_RPCS = Object.freeze(['finalize_evaluation_import_job']);

/** At most this many unmatched, invalid and duplicate entries are listed, as in the SQL. */
const LIST_LIMIT = 200;

const same = (a, b) => String(a) === String(b);
const fail = (code, message, details) => ({
  data: null,
  error: { code, message, ...(details ? { details } : {}) },
});
const byRow = (a, b) => (a.source_row_number ?? Infinity) - (b.source_row_number ?? Infinity);

/** The first non-blank of `keys` in the payload, trimmed, or null (SQL `import_payload_text`). */
function payloadText(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

/**
 * @param {any} db
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ isOrgAdmin: (organizationId: string) => boolean, currentUserId: string }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not this RPC
 */
export function handleEvaluationImportRpc(db, name, params, ctx) {
  if (!EVALUATION_IMPORT_RPCS.includes(name)) return null;

  const jobId = params?.p_import_job_id;
  const dry = params?.p_dry_run === true;
  const validationErrors = params?.p_validation_errors ?? [];
  if (!jobId) return fail('22023', 'p_import_job_id is required');
  if (!Array.isArray(validationErrors)) {
    return fail('22023', 'p_validation_errors must be a jsonb array');
  }

  const job = (db.import_jobs || []).find((item) => same(item.id, jobId));
  if (!job) return fail('P0002', `Import job ${jobId} not found`);
  if (!ctx.isOrgAdmin(job.organization_id)) {
    return fail(
      '42501',
      `Access denied: user is not an admin of organization ${job.organization_id}`
    );
  }
  if (job.job_type !== 'evaluations') {
    return fail('22023', `Import job ${jobId} is ${job.job_type}, not evaluations`);
  }
  if (job.status === 'completed' || job.status === 'completed_with_warnings') {
    const stored = job.warning_summary?.evaluation_finalize;
    if (stored) return { data: { ...stored, replayed: true }, error: null };
    return fail('22023', `Import job ${jobId} is already ${job.status}`);
  }
  if (job.status === 'failed' || job.status === 'needs_fix') {
    const label = job.status === 'failed' ? 'Failed' : 'Needs_fix';
    return fail('22023', `${label} import job ${jobId} cannot be finalized`);
  }

  const season = importSeasonOf(db, job);
  if (!season) return importSeasonMissing(job.organization_id);
  if (season.status === 'completed') {
    return enrollmentRefusal(
      `Season ${season.id} is completed and takes no import`,
      'season_completed'
    );
  }

  const staged = (db.staging_import_rows || []).filter((row) => same(row.import_job_id, jobId));
  const pending = staged
    .filter(
      (row) =>
        same(row.organization_id, job.organization_id) &&
        row.import_type === 'evaluations' &&
        !row.applied_at &&
        row.normalized_payload &&
        (!row.validation_errors || row.validation_errors.length === 0)
    )
    .sort(byRow);

  const invalidCells = [];
  const valid = [];
  for (const row of pending) {
    const payload = row.normalized_payload;
    const errors = validateEvaluationRow(payload);
    if (errors.length > 0) {
      errors
        .slice()
        .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
        .forEach((error) =>
          invalidCells.push({
            row,
            source_row_number: row.source_row_number,
            field: error.field,
            message: error.message,
          })
        );
      continue;
    }
    valid.push({
      row,
      source_row_number: row.source_row_number,
      registrationId: evaluationRegistrationId(payload),
      years: payloadText(payload, ['years_played']),
      tier: payloadText(payload, ['skill_tier', 'skill_level']),
      rating: payloadText(payload, ['rating']),
    });
  }

  // The first row of a repeated registration id (the lowest row number) is used.
  const seen = new Set();
  const used = [];
  const duplicates = [];
  for (const item of valid) {
    if (seen.has(item.registrationId)) duplicates.push(item);
    else {
      seen.add(item.registrationId);
      used.push(item);
    }
  }

  const unmatched = [];
  const changes = [];
  for (const item of used) {
    const player = (db.players || []).find(
      (candidate) =>
        same(candidate.organization_id, job.organization_id) &&
        same(candidate.season_settings_id, season.id) &&
        String(candidate.external_registration_id ?? '') === item.registrationId
    );
    if (!player) {
      unmatched.push(item);
      continue;
    }
    const yearsValue = item.years === null ? null : Number(item.years);
    const tierValue = item.tier === null ? null : item.tier.toLowerCase();
    const ratingValue = item.rating === null ? null : Number(item.rating);
    changes.push({
      item,
      player,
      yearsValue,
      tierValue,
      ratingValue,
      yearsChanges: yearsValue !== null && yearsValue !== (player.years_played ?? null),
      tierChanges: tierValue !== null && tierValue !== (player.skill_tier ?? null),
      ratingChanges: ratingValue !== null && ratingValue !== (player.rating ?? null),
    });
  }
  const toUpdate = changes.filter((c) => c.yearsChanges || c.tierChanges || c.ratingChanges);

  const listEntry = (item) => ({
    source_row_number: item.source_row_number,
    registration_id: String(item.registrationId).slice(0, 100),
  });
  const invalidRows = new Set(invalidCells.map((cell) => cell.row.id)).size;
  const summary = {
    staged_rows: staged.filter((row) => row.import_type === 'evaluations').length,
    matched_rows: changes.length,
    updated_players: toUpdate.length,
    unchanged_players: changes.length - toUpdate.length,
    years_updated: toUpdate.filter((c) => c.yearsChanges).length,
    tier_updated: toUpdate.filter((c) => c.tierChanges).length,
    rating_updated: toUpdate.filter((c) => c.ratingChanges).length,
    unmatched_rows: unmatched.length,
    unmatched: unmatched.slice(0, LIST_LIMIT).map(listEntry),
    invalid_rows: invalidRows,
    invalid: invalidCells
      .slice()
      .sort((a, b) => byRow(a, b))
      .slice(0, LIST_LIMIT)
      .map((cell) => ({
        source_row_number: cell.source_row_number,
        field: cell.field,
        message: cell.message,
      })),
    duplicate_rows: duplicates.length,
    duplicates: duplicates.slice(0, LIST_LIMIT).map(listEntry),
    validation_error_rows: validationErrors.length,
    season_settings_id: season.id,
    dry_run: dry,
  };

  if (dry) return { data: { ...summary, status: 'preview' }, error: null };

  const status =
    validationErrors.length > 0 ||
    summary.invalid_rows > 0 ||
    summary.unmatched_rows > 0 ||
    summary.duplicate_rows > 0
      ? 'completed_with_warnings'
      : 'completed';
  const result = { ...summary, status };
  const now = new Date().toISOString();

  toUpdate.forEach((c) => {
    if (c.yearsValue !== null) c.player.years_played = c.yearsValue;
    if (c.tierValue !== null) c.player.skill_tier = c.tierValue;
    if (c.ratingValue !== null) c.player.rating = c.ratingValue;
    c.player.updated_at = now;
  });
  valid.forEach((item) => {
    item.row.applied_at = now;
    item.row.applied_by = ctx.currentUserId;
  });
  const errorsByRow = new Map();
  invalidCells.forEach((cell) => {
    const list = errorsByRow.get(cell.row.id) ?? [];
    list.push({
      field: cell.field,
      message: cell.message,
      source_row_number: cell.source_row_number,
    });
    errorsByRow.set(cell.row.id, list);
  });
  pending.forEach((row) => {
    if (errorsByRow.has(row.id)) row.validation_errors = errorsByRow.get(row.id);
  });

  Object.assign(job, {
    status,
    processed_rows: valid.length,
    progress_percent: 100,
    completed_at: now,
    error_summary: { rowErrors: validationErrors },
    warning_summary: { ...(job.warning_summary || {}), evaluation_finalize: result },
  });

  // The counts and the season, not the registration ids the lists name.
  const { unmatched: _u, invalid: _i, duplicates: _d, ...counts } = result;
  db.audit_log = db.audit_log || [];
  db.audit_log.push({
    id: `audit-evaluations-${job.id}`,
    organization_id: job.organization_id,
    action: 'import.completed',
    user_id: ctx.currentUserId,
    resource_type: 'import_job',
    resource_id: job.id,
    metadata: { ...counts, import_type: 'evaluations' },
    created_at: now,
  });

  return { data: result, error: null };
}
