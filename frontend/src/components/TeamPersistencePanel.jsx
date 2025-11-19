import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime } from '../utils/formatDateTime.js';

const persistenceButtonCopy = {
  idle: 'Push overrides to Supabase',
  submitting: 'Preparing payload…',
  ready: 'Payload ready for Supabase upsert',
};

function TeamPersistencePanel({ teamPersistenceSnapshot }) {
  const [persistenceActionState, setPersistenceActionState] = useState('idle');
  const [persistenceActionMessage, setPersistenceActionMessage] = useState('');
  const persistenceTimeoutRef = useRef();

  const persistenceOverrides = teamPersistenceSnapshot.manualOverrides ?? [];
  const sortedPersistenceHistory = useMemo(() => {
    return [...(teamPersistenceSnapshot.runHistory ?? [])].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }, [teamPersistenceSnapshot.runHistory]);

  const latestHistory = sortedPersistenceHistory.slice(0, 3);
  const pendingOverrides = persistenceOverrides.filter((override) => override.status === 'pending');
  const persistenceCounts = {
    total: persistenceOverrides.length,
    pending: pendingOverrides.length,
    applied: persistenceOverrides.length - pendingOverrides.length,
  };

  useEffect(() => {
    return () => {
      if (persistenceTimeoutRef.current) {
        clearTimeout(persistenceTimeoutRef.current);
      }
    };
  }, []);

  const handleSimulatedPersist = () => {
    if (persistenceActionState === 'submitting') {
      return;
    }
    setPersistenceActionState('submitting');
    setPersistenceActionMessage('Preparing Supabase payload with deterministic team IDs...');
    persistenceTimeoutRef.current = setTimeout(() => {
      setPersistenceActionState('ready');
      setPersistenceActionMessage(
        `Prepared ${teamPersistenceSnapshot.preparedTeamRows} team rows and ${teamPersistenceSnapshot.preparedPlayerRows} roster rows for ${teamPersistenceSnapshot.lastRunId}.`,
      );
    }, 900);
  };

  return (
    <section className="team-persistence" aria-labelledby="team-persistence-heading">
      <header className="team-persistence__header">
        <div>
          <h2 id="team-persistence-heading">Supabase persistence</h2>
          <p>
            Manual overrides are staged before writing teams and roster rows back to Supabase. Use this panel to
            confirm override readiness, preview the queued upsert payload, and track the last scheduler run that
            touched Supabase.
          </p>
        </div>
        <dl className="team-persistence__status" aria-label="Supabase persistence status">
          <div>
            <dt>Last run</dt>
            <dd>{teamPersistenceSnapshot.lastRunId}</dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>{formatDateTime(teamPersistenceSnapshot.lastSyncedAt)}</dd>
          </div>
          <div>
            <dt>Prepared rows</dt>
            <dd>
              {teamPersistenceSnapshot.preparedTeamRows} teams · {teamPersistenceSnapshot.preparedPlayerRows} players
            </dd>
          </div>
        </dl>
      </header>
      <div className="team-persistence__actions">
        <div>
          <button
            type="button"
            className="persistence-button"
            onClick={handleSimulatedPersist}
            disabled={persistenceActionState === 'submitting'}
          >
            {persistenceButtonCopy[persistenceActionState] ?? persistenceButtonCopy.idle}
          </button>
          <p className="team-persistence__goal">{teamPersistenceSnapshot.pendingManualOverrideGoal}</p>
        </div>
        <p className="team-persistence__action-message" role="status">
          {persistenceActionMessage || 'No Supabase push requested yet.'}
        </p>
      </div>
      <div className="team-persistence__grid">
        <article>
          <h3>Manual overrides</h3>
          <p className="team-persistence__helper">
            {persistenceCounts.pending} of {persistenceCounts.total} overrides still require review before the next
            Supabase write.
          </p>
          <ul className="persistence-list">
            {persistenceOverrides.map((override) => (
              <li key={override.id}>
                <div className="persistence-list__title">
                  {override.teamName} · {override.field}
                </div>
                <p className="persistence-list__meta">
                  {override.status === 'pending' ? 'Pending' : 'Applied'} · {formatDateTime(override.updatedAt)}
                </p>
                <p className="persistence-list__detail">{override.reason}</p>
                <p className="persistence-list__detail">Value: {override.value}</p>
              </li>
            ))}
          </ul>
        </article>
        <article>
          <h3>Recent Supabase syncs</h3>
          <p className="team-persistence__helper">
            Track which scheduler run last wrote data and whether it succeeded.
          </p>
          <ul className="persistence-history">
            {latestHistory.map((run) => (
              <li key={run.runId}>
                <div className="persistence-history__header">
                  <span className="persistence-history__id">{run.runId}</span>
                  <span className={`persistence-pill persistence-pill--${run.status}`}>
                    {run.status === 'success' ? 'Success' : run.status === 'blocked' ? 'Blocked' : run.status}
                  </span>
                </div>
                <p className="persistence-history__meta">
                  Triggered by {run.triggeredBy} · {formatDateTime(run.startedAt)}
                </p>
                <p className="persistence-history__meta">
                  Updated {run.updatedTeams} teams · {run.updatedPlayers} players
                </p>
                <p className="persistence-history__detail">{run.notes}</p>
              </li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}

export default TeamPersistencePanel;
