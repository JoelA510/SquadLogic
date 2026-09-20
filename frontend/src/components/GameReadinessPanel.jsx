import React from 'react';
import InsightSection from './InsightSection.jsx';
import { formatPercentPrecise, formatDate } from '../utils/formatters.js';

/**
 * **There is no `timezone` prop, and its absence is the contract.**
 * `generatedAt` is `scheduler_runs.completed_at`/`created_at` (see
 * `gameSummaryMapper`), or `new Date().toISOString()` straight from the
 * auto-scheduler — a real instant carrying a zone either way, not a season
 * wall time. The viewer's own clock is the right one to read it on, and the
 * `toSeasonInstant` docblock in `utils/formatters.js` states that rule.
 *
 * `PracticeReadinessPanel` and `TeamOverviewPanel` reached the same conclusion
 * in #402; this panel and `TeamListView` were the two arms that fix missed.
 * The prop was threaded here from `WorkflowPage` as a permanent `undefined`
 * (`useDashboardData` has never returned a zone) and from `GameSchedulingPage`
 * as a **real** season zone, which is the one place it was actually rendering
 * a run timestamp on the wrong clock.
 */
function GameReadinessPanel({ gameReadinessSnapshot, gameSummary, generatedAt }) {
  const hasGameWarnings =
    (gameReadinessSnapshot.warnings?.length ?? 0) > 0 ||
    (gameReadinessSnapshot.unscheduled?.length ?? 0) > 0;

  return (
    <section
      className="section-panel glass-panel game-readiness"
      aria-labelledby="game-readiness-heading"
    >
      <header className="section-header">
        <div>
          <h2 id="game-readiness-heading">Game readiness</h2>
          <p>Schedule completion and conflict alerts from {formatDate(generatedAt)}.</p>
        </div>
        <dl className="metrics-grid">
          <div className="metric-item">
            <dt>Scheduled</dt>
            <dd>{formatPercentPrecise(gameSummary.scheduledRate)}</dd>
          </div>
          <div className="metric-item">
            <dt>Unscheduled</dt>
            <dd>{gameSummary.unscheduledMatchups}</dd>
          </div>
          <div className="metric-item">
            <dt>Byes</dt>
            <dd>{gameSummary.teamsWithByes}</dd>
          </div>
        </dl>
      </header>

      {hasGameWarnings && (
        <div className="alert-banner" role="status">
          <span>⚠</span>
          Review conflicts and unscheduled matchups.
        </div>
      )}

      <div className="insights-grid">
        <InsightSection
          title="Unscheduled matchups"
          items={gameReadinessSnapshot.unscheduled}
          emptyMessage="All matchups assigned."
          renderItem={(entry) => (
            <div key={`unscheduled-${entry.weekIndex}-${entry.matchup}`} className="insight-card">
              <h3>Week {entry.weekIndex}</h3>
              <p>{entry.matchup}</p>
              <p className="insight-meta">{entry.reason}</p>
            </div>
          )}
        />

        <InsightSection
          title="Conflicts"
          items={gameReadinessSnapshot.warnings}
          emptyMessage="No conflicts."
          renderItem={(warning, index) => (
            <div key={`warning-${warning.message}-${index}`} className="insight-card">
              <h3>Conflict</h3>
              <p>{warning.message}</p>
            </div>
          )}
        />
      </div>
    </section>
  );
}

export default GameReadinessPanel;
