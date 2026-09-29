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
 *   `tier: 'cross-venue'` (new; tier 2's node limit);
 * - the `daylight` block and the `PRACTICE_REPAIR_DAYLIGHT_UNCHECKED` finding
 *   (8.9 PR 7, new; every pinned run is given no calendar, so the gate judges
 *   nothing and those two are all it adds).
 *
 * Everything tier 1 decides — `rehomed`, `timeTbd` and its reasons, `plan`,
 * `coachDays`, `stats`, every other finding — is kept whole, so a sweep pinned
 * to main's projection proves tier 1 byte-identical. The pins are computed by
 * running this same function over `origin/main`'s result.
 *
 * @param {any} result
 * @returns {any}
 */
import { derivePracticeStatus } from '../../packages/core/src/practice/reasonCodes.js';

/**
 * The one finding main emitted first on every result, which 3b PR 10 removed
 * (the repair is wired). {@link asOnMain} puts it back, byte for byte, so a
 * sweep keeps main's own pinned digests: a match proves the PR changed nothing
 * else in any result. It refuses a result that still carries it.
 */
const MAIN_UNWIRED_FINDING = Object.freeze({
  code: 'PRACTICE_REPAIR_UNWIRED',
  severity: 'info',
  message:
    'Practice repair has no production caller: the live scheduler is the auto-scheduler Edge Function. 8.6 PR 3b wires this.',
  details: { wiredBy: '8.6 PR 3b' },
});

/** @param {any} projection - a {@link tier1Projection} */
export function asOnMain(projection) {
  if (projection.findings.some((f) => f.code === MAIN_UNWIRED_FINDING.code)) {
    throw new Error('asOnMain: the result still carries PRACTICE_REPAIR_UNWIRED');
  }
  return { ...projection, findings: [MAIN_UNWIRED_FINDING, ...projection.findings] };
}

export function tier1Projection(result) {
  const {
    recommendations: _recommendations,
    recommendationSearch: _search,
    daylight: _daylight,
    ...rest
  } = result;
  const findings = rest.findings
    .filter((finding) => finding.details?.tier !== 'cross-venue')
    .filter((finding) => finding.code !== 'PRACTICE_REPAIR_DAYLIGHT_UNCHECKED')
    .map((finding) => {
      if (finding.code !== 'PRACTICE_REPAIR_TIME_TBD') return finding;
      const {
        crossVenueOptions: _count,
        crossVenueRecommendation: _recommendation,
        ...details
      } = finding.details;
      return { ...finding, message: finding.message.replace(/; [^;]*$/, ''), details };
    });
  return {
    ...rest,
    // 3b PR 10 raised DAYLIGHT_UNCHECKED (left out above) from info to
    // compromise, so the status is re-derived from what the projection keeps;
    // on main, where it was info, the two agree.
    status: derivePracticeStatus(findings),
    timeTbd: rest.timeTbd.map(({ crossVenueOptions: _options, ...entry }) => entry),
    findings,
  };
}
