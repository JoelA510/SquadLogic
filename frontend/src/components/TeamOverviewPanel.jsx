import React from 'react';
import { formatPercent } from '../utils/formatters';

function TeamOverviewPanel({ totals, divisions, generatedAt }) {
    return (
        <section className="section-panel glass-panel team-overview" aria-labelledby="team-overview-heading">
            <header className="section-header">
                <div>
                    <h2 id="team-overview-heading">Team formation snapshot</h2>
                    <p>
                        Roster fill rates, coach coverage, and overflow diagnostics.
                        Sourced from dry-run on {new Date(generatedAt).toLocaleDateString()}.
                    </p>
                </div>
                <dl className="metrics-grid" aria-label="Overall allocator totals">
                    <div className="metric-item card-glass">
                        <dt>Divisions</dt>
                        <dd>{totals.divisions}</dd>
                    </div>
                    <div className="metric-item card-glass">
                        <dt>Teams</dt>
                        <dd>{totals.teams}</dd>
                    </div>
                    <div className="metric-item card-glass">
                        <dt>Players</dt>
                        <dd>{totals.playersAssigned}</dd>
                    </div>
                    <div className="metric-item card-glass">
                        <dt>Overflow</dt>
                        <dd>{totals.overflowPlayers}</dd>
                    </div>
                </dl>
            </header>

            <div className="insights-grid">
                {divisions.map((division) => (
                    <article key={division.divisionId} className="insight-card card-glass hover:bg-bg-surface-hover transition-colors">
                        <h3 className="text-brand-400 font-bold mb-1">{division.divisionId}</h3>
                        <p className="text-text-secondary mb-3">{division.totalTeams} teams · {division.playersAssigned} players</p>
                        <div className="insight-meta border-t border-border-subtle pt-3 mt-auto text-sm text-text-muted">
                            Fill Rate: <span className="text-text-primary">{formatPercent(division.averageFillRate)}</span> · Coach Coverage: <span className="text-text-primary">{formatPercent(division.coachCoverage.coverageRate)}</span>
                        </div>
                        {division.needsAdditionalCoaches && (
                            <p className="insight-card__alert-text mt-2 flex items-center gap-2 text-amber-400 bg-amber-400/10 px-3 py-1 rounded-full w-fit text-xs font-bold">
                                <span>⚠</span> Needs coaches
                            </p>
                        )}
                    </article>
                ))}
            </div>
        </section>
    );
}

export default TeamOverviewPanel;
