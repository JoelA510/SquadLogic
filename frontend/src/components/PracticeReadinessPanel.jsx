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
 * @param {{
 *   practiceReadinessSnapshot?: {
 *     balancedScore?: number,
 *     manualActionRequiredCount?: number,
 *     venueSaturation?: string,
 *     conflictFreeTeams?: number,
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-bg-glass rounded-lg" />
          ))}
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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard
          label="Field Distribution"
          value={`${practiceReadinessSnapshot.balancedScore ?? 0}%`}
          status={(practiceReadinessSnapshot.balancedScore ?? 0) > 85 ? 'good' : 'warning'}
          description="Evenness of primary vs secondary fields"
        />
        <KpiCard
          label="Manual Actions"
          value={practiceReadinessSnapshot.manualActionRequiredCount ?? 0}
          status={
            (practiceReadinessSnapshot.manualActionRequiredCount ?? 0) === 0 ? 'good' : 'warning'
          }
          description="Teams requiring manual slot assignment"
        />
        <KpiCard
          label="Venue Saturation"
          value={practiceReadinessSnapshot.venueSaturation ?? 'Unknown'}
          status={practiceReadinessSnapshot.venueSaturation === 'Low' ? 'good' : 'warning'}
          description="Current capacity utilization"
        />
        <KpiCard
          label="Conflict Free"
          value={`${practiceReadinessSnapshot.conflictFreeTeams ?? 0}%`}
          status={(practiceReadinessSnapshot.conflictFreeTeams ?? 0) > 95 ? 'good' : 'warning'}
          description="Teams without schedule overlapping"
        />
      </div>

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
