import { useMemo } from 'react';
import './App.css';
import { teamSummarySnapshot } from './teamSummarySample.js';
import { practiceReadinessSnapshot } from './practiceReadinessSample.js';

const roadmapSections = [
  {
    id: 'team-generation',
    title: 'Team Generation',
    status: 'in-progress',
    summary:
      'Balanced roster allocator with buddy diagnostics and overflow tracking is ready; wiring the summary UI into the admin experience is underway.',
    actions: ['Connect Supabase persistence', 'Complete roster review workflows'],
  },
  {
    id: 'practice-scheduling',
    title: 'Practice Scheduling',
    status: 'in-progress',
    summary:
      'Allocator honors coach preferences, manual locks, and fairness scoring with automated swap recovery. Admin dashboards are still being assembled.',
    actions: ['Wire scheduler run logs', 'Expose manual adjustment tooling'],
  },
  {
    id: 'game-scheduling',
    title: 'Game Scheduling',
    status: 'in-progress',
    summary:
      'Round-robin generator and conflict-aware slot allocator are ready; Supabase persistence and admin tooling remain.',
    actions: ['Persist game assignments', 'Add conflict resolution dashboard'],
  },
  {
    id: 'evaluation',
    title: 'Evaluation Pipeline',
    status: 'in-progress',
    summary:
      'Practice and game metrics aggregate into readiness signals. Next step is wiring Supabase orchestration.',
    actions: ['Store evaluator snapshots', 'Surface dashboard visualisations'],
  },
  {
    id: 'output-generation',
    title: 'Output Generation',
    status: 'in-progress',
    summary:
      'CSV formatters produce master and per-team exports; storage integration and email workflows are upcoming.',
    actions: ['Implement Supabase storage uploads', 'Draft coach email templates'],
  },
];

const statusLabels = {
  complete: { label: 'Complete', tone: 'status-complete' },
  'in-progress': { label: 'In Progress', tone: 'status-progress' },
  pending: { label: 'Pending', tone: 'status-pending' },
};

function App() {
  const summary = useMemo(() => {
    const completed = roadmapSections.filter((section) => section.status === 'complete').length;
    const pending = roadmapSections.length - completed;
    return {
      completed,
      pending,
    };
  }, []);

  const { totals, divisions, generatedAt } = teamSummarySnapshot;
  const practiceSummary = practiceReadinessSnapshot.summary;
  const practiceGeneratedAt = practiceReadinessSnapshot.generatedAt;

  const formatPercent = (value) => `${Math.round((value ?? 0) * 100)}%`;
  const formatPercentPrecise = (value) => {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return '0%';
    }
    const scaled = Math.round(numeric * 1000) / 10;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}%`;
  };
  const formatList = (items) => (items.length > 0 ? items.join(', ') : 'None');
  const formatReasons = (reasons) =>
    Object.entries(reasons)
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(', ');
  const formatTime = (value) => {
    if (!value) {
      return 'unspecified time';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'unspecified time';
    }
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <h1>GotSport Teamer Scheduler Admin</h1>
        <p>
          This prototype dashboard introduces the future admin experience. It surfaces roadmap agents and next steps while the
          Supabase-backed workflows are still under construction.
        </p>
      </header>

      <section className="summary-grid" aria-label="Roadmap progress summary">
        <article className="summary-card" data-tone="complete">
          <h2>{summary.completed}</h2>
          <p>Automation pillars already implemented</p>
        </article>
        <article className="summary-card" data-tone="progress">
          <h2>{summary.pending}</h2>
          <p>Follow-up integrations still planned</p>
        </article>
      </section>

      <section className="team-overview" aria-labelledby="team-overview-heading">
        <header className="team-overview__header">
          <div>
            <h2 id="team-overview-heading">Team formation snapshot</h2>
            <p>
              Preview of the summarized output from the allocator showing roster fill rates, coach coverage, and overflow
              diagnostics by division. Data is sourced from a representative dry-run captured on {new Date(generatedAt).toLocaleDateString()}.
            </p>
          </div>
          <dl className="team-overview__totals" aria-label="Overall allocator totals">
            <div>
              <dt>Divisions</dt>
              <dd>{totals.divisions}</dd>
            </div>
            <div>
              <dt>Teams</dt>
              <dd>{totals.teams}</dd>
            </div>
            <div>
              <dt>Players placed</dt>
              <dd>{totals.playersAssigned}</dd>
            </div>
            <div>
              <dt>Overflow</dt>
              <dd>{totals.overflowPlayers}</dd>
            </div>
            <div>
              <dt>Needs coaches</dt>
              <dd>{totals.divisionsNeedingCoaches}</dd>
            </div>
            <div>
              <dt>Open roster divisions</dt>
              <dd>{totals.divisionsWithOpenRosterSlots}</dd>
            </div>
          </dl>
        </header>

        <div className="team-overview__grid">
          {divisions.map((division) => (
            <article key={division.divisionId} className="team-overview__card">
              <header>
                <h3>{division.divisionId}</h3>
                <p>{division.totalTeams} teams · {division.playersAssigned} players placed</p>
              </header>

              <dl className="team-overview__metrics">
                <div>
                  <dt>Roster capacity</dt>
                  <dd>
                    {division.playersAssigned} / {division.totalCapacity} ({formatPercent(division.averageFillRate)})
                  </dd>
                </div>
                <div>
                  <dt>Open slots</dt>
                  <dd>{division.slotsRemaining}</dd>
                </div>
                <div>
                  <dt>Teams needing players</dt>
                  <dd>{formatList(division.teamsNeedingPlayers)}</dd>
                </div>
                <div>
                  <dt>Coach coverage</dt>
                  <dd>
                    {division.coachCoverage.teamsWithCoach}/{division.coachCoverage.totalTeams} teams staffed ·
                    {formatPercent(division.coachCoverage.coverageRate)}
                  </dd>
                </div>
                <div>
                  <dt>Buddy pairs honored</dt>
                  <dd>{division.mutualBuddyPairs}</dd>
                </div>
                <div>
                  <dt>Outstanding buddy issues</dt>
                  <dd>
                    {division.unmatchedBuddyCount > 0
                      ? `${division.unmatchedBuddyCount} (${formatReasons(division.unmatchedBuddyReasons)})`
                      : 'None'}
                  </dd>
                </div>
                <div>
                  <dt>Overflow units</dt>
                  <dd>{division.overflowUnits}</dd>
                </div>
                <div>
                  <dt>Overflow players</dt>
                  <dd>
                    {division.overflowPlayers}
                    {division.overflowPlayers > 0 &&
                      ` (${formatReasons(division.overflowByReason)})`}
                  </dd>
                </div>
              </dl>

              {division.needsAdditionalCoaches && (
                <p className="team-overview__alert" role="status">
                  Additional volunteer coaches required to staff every team.
                </p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="practice-readiness" aria-labelledby="practice-readiness-heading">
        <header className="practice-readiness__header">
          <div>
            <h2 id="practice-readiness-heading">Practice readiness</h2>
            <p>
              Preview of the practice evaluator output captured on{' '}
              {new Date(practiceGeneratedAt).toLocaleDateString()} showing assignment progress,
              manual follow-up requirements, and fairness alerts surfaced by the metrics agent.
            </p>
          </div>
          <dl className="practice-readiness__grid" aria-label="Practice metrics summary">
            <div>
              <dt>Total teams</dt>
              <dd>{practiceSummary.totalTeams}</dd>
            </div>
            <div>
              <dt>Assignment rate</dt>
              <dd>{formatPercentPrecise(practiceSummary.assignmentRate)}</dd>
            </div>
            <div>
              <dt>Manual follow-up</dt>
              <dd>{formatPercentPrecise(practiceSummary.manualFollowUpRate)}</dd>
            </div>
            <div>
              <dt>Unassigned teams</dt>
              <dd>{practiceSummary.unassignedTeams}</dd>
            </div>
          </dl>
        </header>

        {practiceSummary.manualFollowUpRate > 0.05 && (
          <p className="practice-readiness__alert" role="status">
            {practiceSummary.unassignedTeams} team requires a manual practice assignment — allocate
            additional slot capacity or adjust priorities before publishing.
          </p>
        )}

        <div className="practice-insights">
          <article>
            <h3>Field load highlights</h3>
            {practiceReadinessSnapshot.slotUtilization.length === 0 ? (
              <p className="practice-insight__empty">No slot utilization data captured.</p>
            ) : (
              <ul className="practice-insight-list">
                {practiceReadinessSnapshot.slotUtilization.map((slot) => (
                  <li key={slot.slotId}>
                    <div className="practice-insight__title">{slot.slotId}</div>
                    <p>
                      {slot.assignedCount} of {slot.capacity} capacity used ·{' '}
                      {slot.utilization === null
                        ? 'utilization unavailable'
                        : `${formatPercentPrecise(slot.utilization)}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article>
            <h3>Fairness watchlist</h3>
            {practiceReadinessSnapshot.fairnessConcerns.length === 0 ? (
              <p className="practice-insight__empty">No dominant division patterns detected.</p>
            ) : (
              <ul className="practice-insight-list">
                {practiceReadinessSnapshot.fairnessConcerns.map((concern) => (
                  <li key={concern.baseSlotId}>
                    <div className="practice-insight__title">{concern.baseSlotId}</div>
                    <p>
                      {concern.day ?? 'Unknown day'} · {formatTime(concern.representativeStart)} ·{' '}
                      {concern.message}
                    </p>
                    <p className="practice-insight__meta">
                      Dominant division {concern.dominantDivision} at{' '}
                      {formatPercentPrecise(concern.dominantShare)} share
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article>
            <h3>Conflicts & warnings</h3>
            {practiceReadinessSnapshot.coachConflicts.length === 0 &&
            practiceReadinessSnapshot.dataQualityWarnings.length === 0 ? (
              <p className="practice-insight__empty">No conflicts detected in the latest run.</p>
            ) : (
              <ul className="practice-insight-list">
                {practiceReadinessSnapshot.coachConflicts.map((conflict, index) => (
                  <li key={`conflict-${conflict.coachId}-${index}`}>
                    <div className="practice-insight__title">Coach {conflict.coachId}</div>
                    <p>
                      {conflict.reason} between{' '}
                      {conflict.teams
                        .map((team) => `${team.teamId} (${team.slotId})`)
                        .join(', ')}
                    </p>
                  </li>
                ))}
                {practiceReadinessSnapshot.dataQualityWarnings.map((warning, index) => (
                  <li key={`warning-${index}`}>
                    <div className="practice-insight__title">Data quality</div>
                    <p>{warning}</p>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      </section>

      <section aria-labelledby="roadmap-heading" className="roadmap-section">
        <h2 id="roadmap-heading">Core agents</h2>
        <ul className="roadmap-list">
          {roadmapSections.map((section) => {
            const status = statusLabels[section.status] ?? statusLabels.pending;
            return (
              <li key={section.id} className="roadmap-item">
                <div className={`status-pill ${status.tone}`}>
                  <span className="status-dot" aria-hidden="true" />
                  <span>{status.label}</span>
                </div>
                <div className="roadmap-body">
                  <h3>{section.title}</h3>
                  <p>{section.summary}</p>
                  {section.actions.length > 0 && (
                    <div>
                      <p className="actions-heading">Next actions</p>
                      <ul className="actions-list">
                        {section.actions.map((action, index) => (
                          <li key={index}>{action}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

export default App;
