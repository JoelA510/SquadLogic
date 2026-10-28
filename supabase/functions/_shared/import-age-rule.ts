/**
 * The age rule a player file is counted under (Phase E3b; Codex's findings on #680).
 *
 * import-validation counts each row's natural age under the season's rule (cutoff, season year,
 * the divisions' birth-date windows and bands) and stages the age; finalization copies it, with no
 * birth date left to recount. The rule is read in ONE call, `import_age_rule`, which returns it with
 * the season's `age_rule_revision` from a single statement and stamps the job with that revision;
 * the ages are counted from what the call returned and from nothing read separately. The revision
 * only goes up, on every change that moves an age, so `finalize_import_job` refuses a job whose
 * stamp is not the season's revision now (22023, `age_rule_changed`), a change and its reversal
 * (A, B, A) included: a fingerprint of the rule's values could not tell those from no change.
 *
 * The first batch of a file (`row_offset` 0) takes a new stamp, so validating the file again
 * refreshes it; a later batch keeps the first's.
 */

import type { ImportSeason, WindowedDivision } from './natural-age.ts';

export interface AgeRuleClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export interface ImportAgeRule {
  /** The season the ages are counted in; null when the organization has none for the job. */
  season: ImportSeason | null;
  /** The season's divisions that bear a birth-date window (both ends). */
  windowedDivisions: WindowedDivision[];
  /** The season's `age_rule_revision` the job was stamped with, if it was. */
  revision: number | null;
}

/**
 * Reads the rule for a player file (and stamps its job). The caller counts ages from the result.
 * @returns the rule, or the error to report
 */
export async function loadImportAgeRule(
  client: AgeRuleClient,
  request: { organizationId: string; importJobId?: string | null; rowOffset?: number | null }
): Promise<{ rule: ImportAgeRule; error: null } | { rule: null; error: { message: string } }> {
  const { data, error } = await client.rpc('import_age_rule', {
    p_organization_id: request.organizationId,
    p_import_job_id: request.importJobId ?? null,
    p_restart: (request.rowOffset ?? 0) === 0,
  });
  if (error) return { rule: null, error: { message: error.message ?? 'Age rule lookup failed' } };
  if (data === null || data === undefined) {
    return { rule: { season: null, windowedDivisions: [], revision: null }, error: null };
  }
  const row = data as Record<string, unknown>;
  const divisions = Array.isArray(row.divisions) ? (row.divisions as WindowedDivision[]) : [];
  return {
    rule: {
      season: {
        id: (row.season_id as string | null) ?? null,
        status: (row.status as string | null) ?? null,
        season_year: (row.season_year as number | null) ?? null,
        age_cutoff_mode: (row.age_cutoff_mode as string | null) ?? null,
        age_cutoff_month: (row.age_cutoff_month as number | null) ?? null,
        age_cutoff_day: (row.age_cutoff_day as number | null) ?? null,
      },
      windowedDivisions: divisions,
      revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
    },
    error: null,
  };
}
