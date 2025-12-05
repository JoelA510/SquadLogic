import React from 'react';
import InsightSection from './InsightSection';
import { formatPercentPrecise, formatTime, formatClockFromMinutes } from '../utils/formatters';

const MANUAL_FOLLOW_UP_THRESHOLD = 0.05;

function PracticeReadinessPanel({ practiceReadinessSnapshot, practiceSummary, generatedAt }) {
    const baseSlotItems = practiceReadinessSnapshot.baseSlotDistribution ?? [];
    const dayConcentrationItems = practiceReadinessSnapshot.dayConcentrationAlerts ?? [];
    const divisionDayItems = Object.entries(practiceReadinessSnapshot.divisionDayDistribution ?? {});
    const underutilizedBaseSlotItems = practiceReadinessSnapshot.underutilizedBaseSlots ?? [];
    const manualFollowUpBreakdown = practiceReadinessSnapshot.manualFollowUpBreakdown ?? [];

    return (
        <section className="section-panel glass-panel practice-readiness" aria-labelledby="practice-readiness-heading">
            <header className="section-header">
                <div>
                    <h2 id="practice-readiness-heading">Practice readiness</h2>
                    <p>
                        Evaluator output from {new Date(generatedAt).toLocaleDateString()}.
                        Assignment progress and fairness alerts.
                    </p>
                </div>
                <dl className="metrics-grid">
                    <div className="metric-item">
                        <dt>Assigned</dt>
                        <dd>{formatPercentPrecise(practiceSummary.assignmentRate)}</dd>
                    </div>
                    <div className="metric-item">
                        <dt>Manual Fix</dt>
                        <dd>{formatPercentPrecise(practiceSummary.manualFollowUpRate)}</dd>
                    </div>
                    <div className="metric-item">
                        <dt>Unassigned</dt>
                        <dd>{practiceSummary.unassignedTeams}</dd>
                    </div>
                </dl>
            </header>

            {practiceSummary.manualFollowUpRate > MANUAL_FOLLOW_UP_THRESHOLD && (
                <div className="alert-banner" role="status">
                    <span>⚠</span>
                    {practiceSummary.unassignedTeams} teams require manual assignment.
                </div>
            )}

            <div className="insights-grid">
                <article className="insight-card">
                    <h3 className="insight-card__title">Manual follow-up reasons</h3>
                    {!practiceReadinessSnapshot.unassignedByReason?.length ? (
                        <p className="insight-card__empty">All teams assigned automatically.</p>
                    ) : (
                        <ul className="insight-card__list">
                            {practiceReadinessSnapshot.unassignedByReason.map((entry) => (
                                <li key={entry.reason} className="insight-card__list-item">
                                    <div className="insight-card__list-label">{entry.reason}</div>
                                    <p className="insight-card__list-meta">{entry.count} teams</p>
                                </li>
                            ))}
                        </ul>
                    )}
                </article>
            </div>

            <div className="insights-grid">
                <InsightSection
                    title="Manual follow-up categories"
                    items={manualFollowUpBreakdown}
                    emptyMessage="No category breakdown."
                    renderItem={(entry) => (
                        <div key={entry.category} className="insight-card">
                            <h3>{entry.category}</h3>
                            <p>{entry.count} teams · {formatPercentPrecise(entry.percentage)}</p>
                        </div>
                    )}
                />

                <InsightSection
                    title="Fairness watchlist"
                    items={practiceReadinessSnapshot.fairnessConcerns}
                    emptyMessage="No fairness concerns."
                    renderItem={(concern) => (
                        <div key={concern.baseSlotId} className="insight-card">
                            <h3>{concern.baseSlotId}</h3>
                            <p>{concern.message}</p>
                            <p className="insight-meta">Dominant: {concern.dominantDivision}</p>
                        </div>
                    )}
                />

                <InsightSection
                    title="Base slot utilization"
                    items={baseSlotItems}
                    emptyMessage="No base slot data."
                    renderItem={(slot) => (
                        <div key={slot.baseSlotId} className="insight-card">
                            <h3>{slot.baseSlotId}</h3>
                            <p>
                                {slot.day} · {formatTime(slot.representativeStart)}
                            </p>
                            <p className="insight-meta">
                                Utilization: {formatPercentPrecise(slot.utilization)} ({slot.totalAssigned}/{slot.totalCapacity})
                            </p>
                            {slot.divisionBreakdown?.length > 0 && (
                                <ul className="insight-card__list insight-card__list--compact">
                                    {slot.divisionBreakdown.map((division) => (
                                        <li key={`${slot.baseSlotId}-${division.division}`} className="insight-card__list-item">
                                            <div className="insight-card__list-label">{division.division}</div>
                                            <p className="insight-card__list-meta">
                                                {division.count} teams · {formatPercentPrecise(division.percentage)}
                                            </p>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                />

                <InsightSection
                    title="Day concentration"
                    items={divisionDayItems}
                    emptyMessage="No day distribution data."
                    renderItem={([division, details]) => (
                        <div key={division} className="insight-card">
                            <h3>{division}</h3>
                            <p>{details.totalAssigned} assignments</p>
                            <p className="insight-meta">Avg start: {formatClockFromMinutes(details.averageStartMinutes)}</p>
                            {details.dayBreakdown?.length > 0 && (
                                <ul className="insight-card__list insight-card__list--compact">
                                    {details.dayBreakdown.map((day) => (
                                        <li key={`${division}-${day.day}`} className="insight-card__list-item">
                                            <div className="insight-card__list-label">{day.day}</div>
                                            <p className="insight-card__list-meta">
                                                {day.count} teams · {formatPercentPrecise(day.percentage)}
                                            </p>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                />

                <InsightSection
                    title="Underutilized base slots"
                    items={underutilizedBaseSlotItems}
                    emptyMessage="No underutilized base slots."
                    renderItem={(slot) => (
                        <div key={slot.baseSlotId} className="insight-card">
                            <h3>{slot.baseSlotId}</h3>
                            <p>
                                {slot.day} · {formatTime(slot.representativeStart)}
                            </p>
                            <p className="insight-meta">
                                Utilization: {formatPercentPrecise(slot.utilization)} ({slot.totalAssigned}/{slot.totalCapacity})
                            </p>
                        </div>
                    )}
                />

                <InsightSection
                    title="Day concentration alerts"
                    items={dayConcentrationItems}
                    emptyMessage="No concentration alerts."
                    renderItem={(alert) => (
                        <div key={`${alert.division}-${alert.dominantDay}`} className="insight-card">
                            <h3>{alert.division}</h3>
                            <p>
                                Dominant day: {alert.dominantDay} ({alert.dominantCount}/{alert.totalAssignments})
                            </p>
                            <p className="insight-meta">Share: {formatPercentPrecise(alert.dominantShare)}</p>
                        </div>
                    )}
                />
            </div>
        </section>
    );
}

export default PracticeReadinessPanel;
