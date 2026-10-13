import { fetchAllPages } from '../lib/pagedFetch.js';

/**
 * The org's `practice.recommendation_enacted` audit rows, read as the user
 * (the audit log is admin-readable under RLS), paged to completion. A failed
 * read is `{ ok: false }`, never an empty list: a confirmation must not claim
 * "none" when nobody could look.
 *
 * @param {any} client
 * @param {string|null|undefined} organizationId
 * @returns {Promise<{ ok: true, rows: any[] } | { ok: false, message: string }>}
 */
async function enactAuditRows(client, organizationId) {
  if (!organizationId) return { ok: false, message: 'no organization is selected' };
  try {
    const rows = await fetchAllPages(() =>
      client
        .from('audit_log')
        .select('id, metadata')
        .eq('organization_id', organizationId)
        .eq('action', 'practice.recommendation_enacted')
    );
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, message: err?.message ?? 'audit_log unreadable' };
  }
}

/** Distinct `series.assignment_id` of the rows `keep` admits. */
function seriesCount(rows, keep) {
  return new Set(
    rows.filter(keep).map((row) => String(row.metadata?.series?.assignment_id ?? row.id))
  ).size;
}

/**
 * How many practice series were enacted off one field (8.6 3b PR 11c,
 * `docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1 "Un-retiring after an enact"),
 * counted from the immutable `practice.recommendation_enacted` audit rows
 * whose `cause.kind` is `retirement`, whose `cause.id` is the field and whose
 * `cause.stored_effective_to` is the retirement being cleared (an earlier
 * retire / un-retire cycle is not this one): distinct `series.assignment_id`.
 * The filter runs on the client: the rows are the org's enacts only, a small
 * set.
 *
 * The kind is required (3b PR 11d-3, plan §2.7): blackout enacts are audited
 * under the same action, and a uuid colliding across `fields` and
 * `field_blackouts` must not be what keeps them out (the sibling contract of
 * {@link countSeriesEnactedOffBlackout}).
 *
 * Kept apart from `practiceRepairEnact.js` so the field page does not load
 * the repair to ask this.
 *
 * @param {any} client - the supabase client
 * @param {{ organizationId: string|null|undefined, fieldId: string,
 *   storedEffectiveTo: string|null }} params
 * @returns {Promise<{ ok: true, count: number } | { ok: false, message: string }>}
 */
export async function countSeriesEnactedOff(
  client,
  { organizationId, fieldId, storedEffectiveTo }
) {
  const read = await enactAuditRows(client, organizationId);
  if (read.ok !== true) return read;
  const field = String(fieldId).toLowerCase();
  const count = seriesCount(
    read.rows,
    (row) =>
      row.metadata?.cause?.kind === 'retirement' &&
      String(row.metadata?.cause?.id ?? '').toLowerCase() === field &&
      (row.metadata?.cause?.stored_effective_to ?? null) === storedEffectiveTo
  );
  return { ok: true, count };
}

/**
 * How many practice series were enacted off one saved blackout (3b PR 11d-3,
 * plan §2.7, operator answer Q11): the same audit rows, with `cause.kind`
 * `blackout` and `cause.id` the blackout's. A count only, for the blackout's
 * edit and delete confirmations: editing or removing the blackout withdraws
 * nothing, and its enacted temporary changes stay live and locked (3b
 * decision 6; plan D7). An enact whose exception was later withdrawn is still
 * counted (D9).
 *
 * @param {any} client - the supabase client
 * @param {{ organizationId: string|null|undefined, blackoutId: string }} params
 * @returns {Promise<{ ok: true, count: number } | { ok: false, message: string }>}
 */
export async function countSeriesEnactedOffBlackout(client, { organizationId, blackoutId }) {
  const read = await enactAuditRows(client, organizationId);
  if (read.ok !== true) return read;
  const blackout = String(blackoutId).toLowerCase();
  const count = seriesCount(
    read.rows,
    (row) =>
      row.metadata?.cause?.kind === 'blackout' &&
      String(row.metadata?.cause?.id ?? '').toLowerCase() === blackout
  );
  return { ok: true, count };
}
