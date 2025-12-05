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
                    <div className="metric-item">
                        <dt>Divisions</dt>
                        <dd>{totals.divisions}</dd>
                    </div>
                    <div className="metric-item">
                        <dt>Teams</dt>
                        <dd>{totals.teams}</dd>
                    </div>
                    <div className="metric-item">
                        <dt>Players</dt>
                        <dd>{totals.playersAssigned}</dd>
                    </div>
                    <div className="metric-item">
                        <dt>Overflow</dt>
                        <dd>{totals.overflowPlayers}</dd>
                    </div>
                </dl>
            </header>

            <div className="insights-grid">
                {divisions.map((division) => (
                    <article key={division.divisionId} className="insight-card">
                        <h3>{division.divisionId}</h3>
                        <p>{division.totalTeams} teams · {division.playersAssigned} players</p>
                        <div className="insight-meta">
                            Fill Rate: {formatPercent(division.averageFillRate)} · Coach Coverage: {formatPercent(division.coachCoverage.coverageRate)}
                        </div>
                        {division.needsAdditionalCoaches && (
                            <p className="insight-card__alert-text">
                                ⚠ Needs coaches
                            </p>
                        )}
                    </article>
                ))}
            </div>
        </section>
    );
}

export default TeamOverviewPanel;
