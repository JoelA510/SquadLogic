/**
 * The tier-1 projection of a `repairPracticeLoss()` result (8.6 PR 3b, PR 5).
 *
 * PR 5 replaced the standalone cross-venue options and their `sharedWith` with
 * the joint tier-2 search, and added `recommendations` and
 * `recommendationSearch`. Those, and nothing else, are what this projection
 * leaves out:
 *
 * - `recommendations` and `recommendationSearch` (new);
 * - `crossVenueOptions` on a TIME TBD entry (retired);
 * - the cross-venue clause of a `PRACTICE_REPAIR_TIME_TBD` message (after its
 *   last `; `) and that finding's cross-venue detail (retired / replaced);
 * - a `PRACTICE_REPAIR_MINIMALITY_UNPROVEN` finding marked
 *   `tier: 'cross-venue'` (new; tier 2's node limit).
 *
 * Everything tier 1 decides — `rehomed`, `timeTbd` and its reasons, `plan`,
 * `coachDays`, `stats`, every other finding — is kept whole, so a sweep pinned
 * to main's projection proves tier 1 byte-identical. The pins are computed by
 * running this same function over `origin/main`'s result.
 *
 * @param {any} result
 * @returns {any}
 */
export function tier1Projection(result) {
  const { recommendations: _recommendations, recommendationSearch: _search, ...rest } = result;
  return {
    ...rest,
    timeTbd: rest.timeTbd.map(({ crossVenueOptions: _options, ...entry }) => entry),
    findings: rest.findings
      .filter((finding) => finding.details?.tier !== 'cross-venue')
      .map((finding) => {
        if (finding.code !== 'PRACTICE_REPAIR_TIME_TBD') return finding;
        const {
          crossVenueOptions: _count,
          crossVenueRecommendation: _recommendation,
          ...details
        } = finding.details;
        return { ...finding, message: finding.message.replace(/; [^;]*$/, ''), details };
      }),
  };
}
