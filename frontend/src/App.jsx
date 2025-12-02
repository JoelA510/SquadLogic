import { useMemo } from 'react';
import './App.css';
import { teamSummarySnapshot } from './teamSummarySample.js';
import { practiceReadinessSnapshot } from './practiceReadinessSample.js';
import { gameReadinessSnapshot } from './gameReadinessSample.js';
import { teamPersistenceSnapshot } from './teamPersistenceSample.js';
import TeamPersistencePanel from './components/TeamPersistencePanel.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';

const MANUAL_FOLLOW_UP_THRESHOLD = 0.05;

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

function InsightSection({ title, items, emptyMessage, renderItem }) {
  const hasItems = items && items.length > 0;
  const sectionId = `insight-${title.toLowerCase().replace(/\s+/g, '-')}`;

  return (
    <article aria-labelledby={sectionId}>
      <h3 id={sectionId}>{title}</h3>
      {hasItems ? (
        <div className="insights-grid">{items.map(renderItem)}</div>
      ) : (
        <p className="insight__empty">{emptyMessage}</p>
      )}
    </article>
  );
}

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
  const dayConcentrationAlerts = practiceReadinessSnapshot.dayConcentrationAlerts ?? [];
  const gameSummary = gameReadinessSnapshot.summary;
  const gameGeneratedAt = gameReadinessSnapshot.generatedAt;

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
  const formatClockFromMinutes = (minutes) => {
    if (!Number.isFinite(minutes)) {
      return 'unspecified time';
    }
    const normalized = Math.max(0, Math.round(minutes));
    const hours = Math.floor(normalized / 60) % 24;
    const mins = normalized % 60;
    const label = `${hours.toString().padStart(2, '0')}:${mins
      .toString()
      .padStart(2, '0')}`;
    const suffix = hours >= 12 ? 'pm' : 'am';
    const adjustedHour = ((hours + 11) % 12) + 1;
    return `${adjustedHour}:${mins.toString().padStart(2, '0')} ${suffix} (${label})`;
  };

  const formatGameWarningDetails = (details) => {
    if (!details) {
      return 'See evaluator details';
    }
    if (details.dominantDivision) {
      return `${details.dominantDivision} at ${formatPercentPrecise(details.dominantShare)}`;
    }
    if (details.coachId) {
      return `Coach ${details.coachId} · Week ${details.weekIndex}`;
    }
    return 'See evaluator details';
  };

  const hasNoConflictsOrWarnings =
    practiceReadinessSnapshot.coachConflicts.length === 0 &&
    practiceReadinessSnapshot.dataQualityWarnings.length === 0;

  const hasGameWarnings =
    (gameReadinessSnapshot.warnings?.length ?? 0) > 0 ||
    (gameReadinessSnapshot.unscheduled?.length ?? 0) > 0;

  const baseSlotItems = practiceReadinessSnapshot.baseSlotDistribution ?? [];
  const divisionDayItems = Object.entries(practiceReadinessSnapshot.divisionDayDistribution ?? {});
  const underutilizedBaseSlotItems = practiceReadinessSnapshot.underutilizedBaseSlots ?? [];
  const manualFollowUpBreakdown =
    practiceReadinessSnapshot.manualFollowUpBreakdown ?? [];
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-logo">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L3 7V12C3 17.52 6.84 22.74 12 24C17.16 22.74 21 17.52 21 12V7L12 2Z" fill="url(#logo-gradient)" />
            <defs>
              <linearGradient id="logo-gradient" x1="3" y1="2" x2="21" y2="24" gradientUnits="userSpaceOnUse">
                <stop stopColor="var(--color-primary-400)" />
                <stop offset="1" stopColor="var(--color-primary-600)" />
              </linearGradient>
            </defs>
          </svg>
          <span>SquadLogic</span>
        </div>
      </header>

      <main className="app-main">
        <section className="hero">
          <h1>Admin Dashboard</h1>
          <p>
            Intelligent team assembly and scheduling automation. Monitor agents, review readiness, and manage persistence.
          </p>
        </section>

        <section className="summary-grid" aria-label="Roadmap progress summary">
          <article className="summary-card glass-panel" data-tone="complete">
            <h2>{summary.completed}</h2>
            <p>Automation pillars active</p>
          </article>
          <article className="summary-card glass-panel" data-tone="progress">
            <h2>{summary.pending}</h2>
            <p>Integrations planned</p>
          </article>
        </section>

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

        <TeamPersistencePanel teamPersistenceSnapshot={teamPersistenceSnapshot} />

        <section className="section-panel glass-panel practice-readiness" aria-labelledby="practice-readiness-heading">
          <header className="section-header">
            <div>
              <h2 id="practice-readiness-heading">Practice readiness</h2>
              <p>
                Evaluator output from {new Date(practiceGeneratedAt).toLocaleDateString()}.
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
          </div>
        </section>

        <section className="section-panel glass-panel game-readiness" aria-labelledby="game-readiness-heading">
          <header className="section-header">
            <div>
              <h2 id="game-readiness-heading">Game readiness</h2>
              <p>
                Schedule completion and conflict alerts from {new Date(gameGeneratedAt).toLocaleDateString()}.
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
              renderItem={(entry, index) => (
                <div key={`unscheduled-${index}`} className="insight-card">
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
                <div key={`warning-${index}`} className="insight-card">
                  <h3>Conflict</h3>
                  <p>{warning.message}</p>
                </div>
              )}
            />
          </div>
        </section>

        <section aria-labelledby="roadmap-heading" className="section-panel glass-panel roadmap-section">
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
                      <div style={{ marginTop: '0.5rem' }}>
                        <p className="text-muted" style={{ fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Next actions</p>
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
      </main>

      <ThemeToggle />
    </div>
  );
}

export default App;
