import React from 'react';
import InsightSection from './InsightSection';
import { formatPercentPrecise } from '../utils/formatters';

function GameReadinessPanel({ gameReadinessSnapshot, gameSummary, generatedAt }) {
    const hasGameWarnings =
        (gameReadinessSnapshot.warnings?.length ?? 0) > 0 ||
        (gameReadinessSnapshot.unscheduled?.length ?? 0) > 0;

    return (
        <section className="section-panel glass-panel game-readiness" aria-labelledby="game-readiness-heading">
            <header className="section-header">
                <div>
                    <h2 id="game-readiness-heading">Game readiness</h2>
                    <p>
                        Schedule completion and conflict alerts from {new Date(generatedAt).toLocaleDateString()}.
                    </p>
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
