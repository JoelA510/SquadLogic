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
 * @param {{
 *   practiceReadinessSnapshot?: {
 *     summary?: { unassignedTeams?: number },
 *     unassignedByReason?: Array<{ reason: string, count: number }>,
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
        {/* One placeholder because one card follows. Four promised three
            cards that no producer can fill. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="h-24 bg-bg-glass rounded-lg" />
        </div>
      </div>
    );
  }

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

      {typeof practiceReadinessSnapshot.summary?.unassignedTeams === 'number' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <KpiCard
            label="Manual Actions"
            value={practiceReadinessSnapshot.summary.unassignedTeams}
            status={practiceReadinessSnapshot.summary.unassignedTeams === 0 ? 'good' : 'warning'}
            description="Teams requiring manual slot assignment"
          />
        </div>
      )}

      <div className="insights-grid">
        <article className="insight-card" aria-labelledby="manual-follow-ups">
          <h3 className="insight-card__title" id="manual-follow-ups">
            Manual follow-up reasons
          </h3>
          {!practiceReadinessSnapshot.unassignedByReason?.length ? (
            <p className="insight-card__empty">All teams assigned automatically.</p>
          ) : (
            <ul className="insight-card__list">
              {practiceReadinessSnapshot.unassignedByReason.map((reason, idx) => (
                <li key={idx} className="insight-card__list-item">
                  <span className="font-medium">{reason.reason}:</span> {reason.count} teams
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
