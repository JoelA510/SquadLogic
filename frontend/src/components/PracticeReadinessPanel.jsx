import React from 'react';
import PropTypes from 'prop-types';
import { formatDateTime } from '../utils/formatters.js';

function KpiCard({ label, value, status, description }) {
  const toneClass =
    status === 'good'
      ? 'text-status-success border-status-success/30 bg-status-success/5'
      : 'text-status-warning border-status-warning/30 bg-status-warning/5';
  return (
    <article className={`card-glass border ${toneClass} rounded-lg p-4`} aria-label={label}>
      <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
      <div className="text-2xl font-display font-bold mt-1">{value}</div>
      <div className="text-xs text-text-secondary mt-1">{description}</div>
    </article>
  );
}

KpiCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  status: PropTypes.oneOf(['good', 'warning']),
  description: PropTypes.string,
};

/**
 * **`generatedAt` is a prop, not a field of the snapshot.**
 *
 * This header used to read `practiceReadinessSnapshot.lastCalculated`, and
 * nothing anywhere ever wrote that field: the snapshot is `run.results`
 * verbatim (`practiceSummaryMapper`), i.e. `practiceMetrics`' report, which has
 * no timestamp in it at all. So the guard was permanently false and
 * "Generated ..." never rendered -- a line that reads as load-bearing and is
 * not. The run's timestamp does exist; the mapper already lifts it as
 * `generatedAt`, and `GameReadinessPanel` already takes it as a prop of that
 * name. That contract is adopted here rather than a third one invented.
 *
 * **There is no `timezone` prop, and its absence is the contract.**
 * `generatedAt` is `scheduler_runs.completed_at`/`created_at`, a real instant
 * carrying a zone, and the viewer's own clock is the right one to read it on
 * -- the `toSeasonInstant` docblock in `utils/formatters.js` names this panel
 * as one of the callers that deliberately passes none. The prop used to be
 * declared, typed and destructured as `_timezone`, which is the same
 * reads-as-load-bearing-and-is-not shape as the `lastCalculated` above it.
 *
 * **The KPI row reads `summary`, and only `summary`.**
 * Four cards used to read `balancedScore`, `manualActionRequiredCount`,
 * `venueSaturation` and `conflictFreeTeams` off the snapshot. Nothing in the
 * repository has ever written any of the four: the snapshot is
 * `scheduler_runs.results` verbatim (`practiceSummaryMapper`), i.e.
 * `evaluatePracticeSchedule`'s report, whose keys are `summary`,
 * `slotUtilization`, `baseSlotDistribution`, `divisionDayDistribution`,
 * `divisionBaseSlotDistribution`, `dayConcentrationAlerts`, `coachLoad`,
 * `coachConflicts`, `dataQualityWarnings`, `fairnessConcerns`,
 * `underutilizedBaseSlots`, `unassignedByReason` and
 * `manualFollowUpBreakdown`. Each card carried a `?? 0` / `?? 'Unknown'`
 * fallback, so all four rendered a confident constant — `0%`, `0`, `Unknown`,
 * `0%` — over every season this app has ever scheduled.
 *
 * That is the `lastCalculated` defect above, on this same component, for four
 * more fields: the fix landed on the header line and left the cards beside it.
 *
 * **Only one of the four had a metric measuring the same quantity.**
 * `summary.unassignedTeams` (unit `ROSTERED_TEAM`) is exactly "teams requiring
 * manual slot assignment", so "Manual Actions" is wired to it. The other three
 * are deleted rather than derived: `slotUtilization` is per-slot occupancy and
 * not venue saturation, `coachConflicts` counts coach pairs and not
 * conflict-free teams, and no metric measures primary-vs-secondary field
 * evenness at all. A number derived to keep a card alive cannot be told apart
 * from a measured one, which is worse than an absent card.
 *
 * **The KPI card and the reasons list count different things, and the panel
 * says so when they disagree.**
 * `summary.unassignedTeams` is `totalTeams - assignedTeams`, derived from the
 * roster (`practiceMetrics.js:621`). `unassignedByReason[].count` is derived
 * from the `unassigned` **list**: the bucket is incremented before the roster
 * lookup (`:331`), so an entry naming a team that is not in `teams` is counted
 * there and not in the card. Three divergences are reachable and all three are
 * reproduced in `tests/dashboardDeadReads.test.jsx`:
 *
 * - an `unassigned` entry naming an unknown team — reasons sum **higher**;
 *   the engine records why in `dataQualityWarnings`.
 * - an `assignments` entry naming an unknown team — same warning, card higher.
 * - **a team in neither list — card higher, and no warning at all.** This is
 *   the one that matters: `dataQualityWarnings` is empty, so rendering the
 *   warnings alone would not have reconciled it, and any writer that persists
 *   a snapshot without an `unassigned` list lands here for every team.
 *
 * Presented as a total and its breakdown they would silently disagree, and the
 * empty state asserted "All teams assigned automatically" over a card reading
 * 7. So the card keeps the engine's own quantity (it is `manualFollowUpRate`'s
 * numerator), the empty state no longer claims more than it knows, a
 * reconciliation line appears whenever the two part company, and
 * `dataQualityWarnings` — which nothing in the app rendered — is shown.
 *
 * The reconciliation line explains itself without referring anywhere, and
 * points at the notes only when there are notes: the team-in-neither-list
 * case is precisely the one with none, so an unconditional pointer would send
 * the reader to an absent section in the branch that matters most.
 *
 * @param {{
 *   practiceReadinessSnapshot?: {
 *     summary?: { unassignedTeams?: number },
 *     unassignedByReason?: Array<{ reason: string, count: number }>,
 *     dataQualityWarnings?: Array<string>,
 *   },
 *   dashboardLoading?: { practice?: boolean },
 *   generatedAt?: string|null,
 * }} props
 */
export default function PracticeReadinessPanel({
  practiceReadinessSnapshot = {},
  dashboardLoading = {},
  generatedAt = undefined,
}) {
  if (dashboardLoading.practice) {
    return (
      <div className="glass-panel p-8 animate-pulse">
        <div className="h-6 w-1/3 bg-bg-surface-hover rounded mb-4" />
        {/* One KPI placeholder and one insight placeholder: the two sections
            the loaded panel renders. The KPI card is gated on
            `summary.unassignedTeams` being a number, and every report
            `evaluatePracticeSchedule` produces carries one — asserted in
            `tests/dashboardDeadReads.test.jsx` rather than assumed here — so
            the promise holds for every real snapshot. */}
        <div className="max-w-xs mb-8">
          <div className="h-24 bg-bg-glass rounded-lg" />
        </div>
        <div className="h-24 bg-bg-glass rounded-lg" />
      </div>
    );
  }

  const summary = practiceReadinessSnapshot.summary;
  const unassignedTeams =
    typeof summary?.unassignedTeams === 'number' ? summary.unassignedTeams : null;
  const reasons = practiceReadinessSnapshot.unassignedByReason ?? [];
  const reasonsTotal = reasons.reduce((total, entry) => total + (entry?.count ?? 0), 0);
  const warnings = practiceReadinessSnapshot.dataQualityWarnings ?? [];
  // The KPI card and this list are two different quantities that usually
  // coincide, so the panel must never present them as a total and its
  // breakdown without saying when they part company. See the docblock above.
  const reconciles = unassignedTeams === null || reasonsTotal === unassignedTeams;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-bold text-text-primary">Practice Readiness</h2>
        {generatedAt && (
          <span className="text-sm text-text-secondary">
            Generated {formatDateTime(generatedAt)}
          </span>
        )}
      </div>

      {unassignedTeams !== null && (
        <div className="max-w-xs mb-8">
          <KpiCard
            label="Manual Actions"
            value={unassignedTeams}
            status={unassignedTeams === 0 ? 'good' : 'warning'}
            description="Teams requiring manual slot assignment"
          />
        </div>
      )}

      <div className="insights-grid">
        <article className="insight-card" aria-labelledby="manual-follow-ups">
          <h3 className="insight-card__title" id="manual-follow-ups">
            Manual follow-up reasons
          </h3>
          {reasons.length === 0 ? (
            // "All teams assigned automatically" was asserted whenever the
            // list was empty, including over a card reading 7. An empty list
            // means no reasons were recorded, which is not the same claim.
            unassignedTeams === null || unassignedTeams === 0 ? (
              <p className="insight-card__empty">All teams assigned automatically.</p>
            ) : (
              <p className="insight-card__empty">
                This run recorded no reasons for the {unassignedTeams} team
                {unassignedTeams === 1 ? '' : 's'} needing manual assignment.
              </p>
            )
          ) : (
            <>
              <ul className="insight-card__list">
                {reasons.map((reason, idx) => (
                  <li key={idx} className="insight-card__list-item">
                    <span className="font-medium">{reason.reason}:</span> {reason.count} teams
                  </li>
                ))}
              </ul>
              {!reconciles && (
                // The explanation stands on its own, and the pointer to the
                // notes is conditional on there being notes. The divergence
                // this panel exists for -- a team in neither list -- produces
                // an EMPTY `dataQualityWarnings`, so an unconditional "see
                // the data-quality notes" sent the reader to nothing in
                // exactly the branch that matters most.
                //
                // The class is `insight-card__empty` on a message that is not
                // an empty state, which is a naming mismatch and was raised as
                // one. The only closer-sounding class, `insight-card__alert-text`
                // (`App.css:149`), is `display: inline-flex` with a `gap` and
                // no `flex-wrap`, built for an icon plus a short label: this
                // sentence is many JSX fragments, so each would become its own
                // non-wrapping flex item with a gap between. It also has no
                // other user in the repository. Keeping the plain block style
                // rather than reviving dead CSS into a shape it was not built
                // for; a properly named class is a design-system change, not
                // this PR.
                <p className="insight-card__empty" role="status">
                  Reasons account for {reasonsTotal} team{reasonsTotal === 1 ? '' : 's'}, but{' '}
                  {unassignedTeams} {unassignedTeams === 1 ? 'is' : 'are'} unassigned. The reasons
                  list counts this run&apos;s unassigned entries; the total counts teams with no
                  slot.
                  {warnings.length > 0 ? ' See the data-quality notes below.' : ''}
                </p>
              )}
            </>
          )}
          {warnings.length > 0 && (
            // Nothing rendered `dataQualityWarnings` anywhere. It is the
            // engine's own explanation for the commonest divergence above --
            // an unassigned entry naming a team that is not on the roster.
            <ul className="insight-card__list">
              {warnings.map((warning, idx) => (
                <li key={`dq-${idx}`} className="insight-card__list-item">
                  <span className="font-medium">Data quality:</span> {warning}
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>
    </div>
  );
}

PracticeReadinessPanel.propTypes = {
  practiceReadinessSnapshot: PropTypes.object,
  dashboardLoading: PropTypes.object,
  generatedAt: PropTypes.string,
};
