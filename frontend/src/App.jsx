import { useMemo } from 'react';
import './App.css';
import { teamSummarySnapshot } from './teamSummarySample.js';
import { practiceReadinessSnapshot } from './practiceReadinessSample.js';
import { gameReadinessSnapshot } from './gameReadinessSample.js';

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

  return (
    <article>
      <h3>{title}</h3>
      {hasItems ? (
        <ul className="insight-list">{items.map(renderItem)}</ul>
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

        {practiceSummary.manualFollowUpRate > MANUAL_FOLLOW_UP_THRESHOLD && (
          <p className="practice-readiness__alert" role="status">
            {practiceSummary.unassignedTeams}{' '}
            {practiceSummary.unassignedTeams === 1 ? 'team requires' : 'teams require'} a manual
            practice assignment — allocate additional slot capacity or adjust priorities before publishing.
          </p>
        )}

        <div className="practice-insights">
          <article>
            <h3>Manual follow-up reasons</h3>
            {!practiceReadinessSnapshot.unassignedByReason?.length ? (
              <p className="insight__empty">All teams received automated practice assignments.</p>
            ) : (
              <ul className="insight-list">
                {practiceReadinessSnapshot.unassignedByReason.map((entry) => (
                  <li key={entry.reason}>
                    <div className="insight__title">{entry.reason}</div>
                    <p>
                      {entry.count} {entry.count === 1 ? 'team' : 'teams'} awaiting manual scheduling
                      {entry.teamIds && entry.teamIds.length > 0 &&
                        ` (${entry.teamIds.join(', ')})`}
                    </p>
                    {entry.divisionBreakdown && entry.divisionBreakdown.length > 0 && (
                      <p className="insight__meta">
                        {entry.divisionBreakdown
                          .map(
                            (division) =>
                              `${division.division}: ${formatPercentPrecise(division.percentage)}`,
                          )
                          .join(' · ')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article>
            <h3>Field load highlights</h3>
            {practiceReadinessSnapshot.slotUtilization.length === 0 ? (
              <p className="insight__empty">No slot utilization data captured.</p>
            ) : (
              <ul className="insight-list">
                {practiceReadinessSnapshot.slotUtilization.map((slot) => (
                  <li key={slot.slotId}>
                    <div className="insight__title">{slot.slotId}</div>
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
              <p className="insight__empty">No dominant division patterns detected.</p>
            ) : (
              <ul className="insight-list">
                {practiceReadinessSnapshot.fairnessConcerns.map((concern) => (
                  <li key={concern.baseSlotId}>
                    <div className="insight__title">{concern.baseSlotId}</div>
                    <p>
                      {concern.day ?? 'Unknown day'} · {formatTime(concern.representativeStart)} ·{' '}
                      {concern.message}
                    </p>
                    <p className="insight__meta">
                      Dominant division {concern.dominantDivision} at{' '}
                      {formatPercentPrecise(concern.dominantShare)} share
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </article>

          <InsightSection
            title="Base slot distribution"
            items={baseSlotItems}
            emptyMessage="No base slot summaries captured."
            renderItem={(slot) => (
              <li key={slot.baseSlotId}>
                <div className="insight__title">{slot.baseSlotId}</div>
                <p>
                  {slot.day ?? 'Unknown day'} · {formatTime(slot.representativeStart)} · {slot.totalAssigned} of {slot.totalCapacity}
                  teams assigned
                </p>
                {slot.divisionBreakdown && slot.divisionBreakdown.length > 0 && (
                  <p className="insight__meta">
                    {slot.divisionBreakdown
                      .map(
                        (division) => `${division.division}: ${formatPercentPrecise(division.percentage)} (${division.count})`,
                      )
                      .join(' · ')}
                  </p>
                )}
              </li>
            )}
          />

          <InsightSection
            title="Division day coverage"
            items={divisionDayItems}
            emptyMessage="No day distribution captured for this run."
            renderItem={(entry) => {
              const [division, details] = entry;
              return (
                <li key={division}>
                  <div className="insight__title">{division}</div>
                  <p>
                    {details.totalAssigned} assignments · average start {formatClockFromMinutes(details.averageStartMinutes)}
                  </p>
                  {details.dayBreakdown && details.dayBreakdown.length > 0 && (
                    <p className="insight__meta">
                      {details.dayBreakdown
                        .map(
                          (dayEntry) => `${dayEntry.day}: ${formatPercentPrecise(dayEntry.percentage)} (${dayEntry.count})`,
                        )
                        .join(' · ')}
                    </p>
                  )}
                </li>
              );
            }}
          />

          <InsightSection
            title="Day concentration alerts"
            items={dayConcentrationAlerts}
            emptyMessage="No divisions are stacked on a single practice day."
            renderItem={(alert) => (
              <li key={`${alert.division}-${alert.dominantDay}`}>
                <div className="insight__title">{alert.division}</div>
                <p>
                  {formatPercentPrecise(alert.dominantShare)} of practices ({alert.dominantCount}/{alert.totalAssignments}) are
                  concentrated on {alert.dominantDay}.
                </p>
              </li>
            )}
          />

          <InsightSection
            title="Underutilized base slots"
            items={underutilizedBaseSlotItems}
            emptyMessage="All base slots are at healthy utilization."
            renderItem={(slot) => (
              <li key={slot.baseSlotId}>
                <div className="insight__title">{slot.baseSlotId}</div>
                <p>
                  {slot.day ?? 'Unknown day'} · {formatTime(slot.representativeStart)} · {slot.totalAssigned} of {slot.totalCapacity}
                  teams assigned
                </p>
                <p className="insight__meta">
                  Utilization {formatPercentPrecise(slot.utilization)} — consider rebalancing.
                </p>
              </li>
            )}
          />

          <article>
            <h3>Conflicts & warnings</h3>
            {hasNoConflictsOrWarnings ? (
              <p className="insight__empty">No conflicts detected in the latest run.</p>
            ) : (
              <ul className="insight-list">
                {practiceReadinessSnapshot.coachConflicts.map((conflict, index) => (
                  <li key={`conflict-${conflict.coachId}-${index}`}>
                    <div className="insight__title">Coach {conflict.coachId}</div>
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
                    <div className="insight__title">Data quality</div>
                    <p>{warning}</p>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      </section>

      <section className="game-readiness" aria-labelledby="game-readiness-heading">
        <header className="game-readiness__header">
          <div>
            <h2 id="game-readiness-heading">Game readiness</h2>
            <p>
              Snapshot of the latest game evaluator outputs from{' '}
              {new Date(gameGeneratedAt).toLocaleDateString()} capturing schedule completion,
              bye coverage, and any outstanding matchups or shared slot imbalances surfaced by
              the metrics agent.
            </p>
          </div>
          <dl className="game-readiness__grid" aria-label="Game metrics summary">
            <div>
              <dt>Games scheduled</dt>
              <dd>
                {gameSummary.totalGames} ({formatPercentPrecise(gameSummary.scheduledRate)} of planned)
              </dd>
            </div>
            <div>
              <dt>Divisions covered</dt>
              <dd>{gameSummary.divisionsCovered}</dd>
            </div>
            <div>
              <dt>Unscheduled matchups</dt>
              <dd>{gameSummary.unscheduledMatchups}</dd>
            </div>
            <div>
              <dt>Teams with byes</dt>
              <dd>{gameSummary.teamsWithByes}</dd>
            </div>
            <div>
              <dt>Shared slot alerts</dt>
              <dd>{gameSummary.sharedSlotAlerts}</dd>
            </div>
          </dl>
        </header>

        {hasGameWarnings && (
          <p className="game-readiness__alert" role="status">
            Review the flagged conflicts and unscheduled matchups before publishing the slate;
            targeted adjustments will improve coach availability and balance shared fields.
          </p>
        )}

        <div className="game-insights">
          <article>
            <h3>Unscheduled matchups</h3>
            {gameReadinessSnapshot.unscheduled.length === 0 ? (
              <p className="insight__empty">All matchups are assigned.</p>
            ) : (
              <ul className="insight-list">
                {gameReadinessSnapshot.unscheduled.map((entry, index) => (
                  <li key={`unscheduled-${entry.matchup}-${index}`}>
                    <div className="insight__title">Week {entry.weekIndex}</div>
                    <p>
                      {entry.matchup} · {entry.reason}
                    </p>
                    {entry.note && <p className="insight__meta">{entry.note}</p>}
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article>
            <h3>Conflicts & shared slot alerts</h3>
            {gameReadinessSnapshot.warnings.length === 0 ? (
              <p className="insight__empty">No conflicts detected.</p>
            ) : (
              <ul className="insight-list">
                {gameReadinessSnapshot.warnings.map((warning, index) => (
                  <li key={`warning-${warning.type}-${index}`}>
                    <div className="insight__title">{warning.message}</div>
                    {warning.details && (
                      <p className="insight__meta">{formatGameWarningDetails(warning.details)}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </article>

          <article>
            <h3>Field highlights</h3>
            {gameReadinessSnapshot.fieldHighlights.length === 0 ? (
              <p className="insight__empty">No field usage captured.</p>
            ) : (
              <ul className="insight-list">
                {gameReadinessSnapshot.fieldHighlights.map((entry) => (
                  <li key={entry.fieldId}>
                    <div className="insight__title">{entry.fieldId}</div>
                    <p>
                      {entry.games} games · Divisions {formatList(entry.divisions)}
                    </p>
                    {entry.note && <p className="insight__meta">{entry.note}</p>}
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
