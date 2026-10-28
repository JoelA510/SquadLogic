/**
 * The age rule a player file is validated under (Phase E3b; Codex's finding on #680).
 *
 * import-validation counts each row's natural age under the season's rule (cutoff, season year,
 * the divisions' birth-date windows) and stages the age; finalization copies it, with no birth date
 * left to recount. A rule change after the validation read the rule and before its first staged row
 * finds nothing pending for the database's guard to refuse. So the validation stamps the job with a
 * fingerprint of the rule BEFORE it reads the rule (`stamp_import_job_age_rule`), and
 * `finalize_import_job` refuses a job whose stamp is not the season's rule any more
 * (22023, `age_rule_changed`). A change in between can only make the stamp stale, never match.
 *
 * The first batch of a file (`row_offset` 0) takes a new stamp, so validating the file again
 * refreshes it; a later batch keeps the first's.
 */

export interface AgeRuleStampClient {
  rpc(
    fn: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

/**
 * Stamps the job when the request is a player file for a job; any other request is left alone.
 * @returns the error to report, or null (stamped, or nothing to stamp)
 */
export async function stampAgeRule(
  client: AgeRuleStampClient,
  request: { importType: string; importJobId?: string | null; rowOffset?: number | null }
): Promise<{ message: string } | null> {
  if (request.importType !== 'players' || !request.importJobId) return null;
  const { error } = await client.rpc('stamp_import_job_age_rule', {
    p_import_job_id: request.importJobId,
    p_restart: (request.rowOffset ?? 0) === 0,
  });
  return error ? { message: error.message ?? 'Age rule stamp failed' } : null;
}
