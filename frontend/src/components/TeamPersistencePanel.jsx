import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDateTime } from '../utils/formatDateTime.js';
import {
  getPersistenceEndpoint,
  triggerTeamPersistence,
} from '../utils/teamPersistenceClient.js';

const SUPABASE_SYNC_TIMEOUT_MS = 10000;

const persistenceButtonCopy = {
  idle: 'Push overrides to Supabase',
  submitting: 'Preparing payload…',
  ready: 'Supabase sync succeeded',
  blocked: 'Resolve overrides to sync',
};

function TeamPersistencePanel({ teamPersistenceSnapshot }) {
  const [persistenceActionState, setPersistenceActionState] = useState('idle');
  const [persistenceActionMessage, setPersistenceActionMessage] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(
    teamPersistenceSnapshot.lastSyncedAt,
  );
  const persistenceTimeoutRef = useRef();

  const persistenceOverrides = teamPersistenceSnapshot.manualOverrides ?? [];
  const sortedPersistenceHistory = useMemo(() => {
    return [...(teamPersistenceSnapshot.runHistory ?? [])].sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }, [teamPersistenceSnapshot.runHistory]);

  const latestHistory = sortedPersistenceHistory.slice(0, 3);
  const persistenceCounts = useMemo(() => {
    const byStatus = persistenceOverrides.reduce(
      (acc, { status }) => {
        if (!status) return acc;
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      },
      { pending: 0, applied: 0 },
    );

    return {
      total: persistenceOverrides.length,
      pending: byStatus.pending ?? 0,
      applied: byStatus.applied ?? 0,
    };
  }, [persistenceOverrides]);

  useEffect(() => {
    return () => {
      if (persistenceTimeoutRef.current) {
        clearTimeout(persistenceTimeoutRef.current);
      }
    };
  }, []);

  const persistenceEndpoint = getPersistenceEndpoint();

  const handlePersist = async () => {
    if (persistenceActionState === 'submitting') {
      return;
    }
    setPersistenceActionState('submitting');
    setPersistenceActionMessage(
      persistenceEndpoint
        ? 'Validating overrides and pushing Supabase payload...'
        : 'Validating overrides and preparing Supabase payload...',
    );
    persistenceTimeoutRef.current = setTimeout(() => {
      setPersistenceActionState('blocked');
      setPersistenceActionMessage('Supabase sync timed out. Please retry.');
    }, SUPABASE_SYNC_TIMEOUT_MS);

    try {
      const result = await triggerTeamPersistence({
        snapshot: teamPersistenceSnapshot,
        overrides: persistenceOverrides,
        endpoint: persistenceEndpoint,
      });

      if (result.status === 'blocked') {
        setPersistenceActionState('blocked');
        setPersistenceActionMessage(result.message);
        return;
      }

      if (result.status === 'error') {
        setPersistenceActionState('idle');
        setPersistenceActionMessage(
          result.message || 'Snapshot unavailable. Refresh and try again.',
        );
        return;
      }

      setLastSyncedAt(result.syncedAt);
      setPersistenceActionState('ready');
      setPersistenceActionMessage(
        `Supabase upsert completed for ${result.updatedTeams} teams and ${result.updatedPlayers} players at ${formatDateTime(result.syncedAt)}.`,
      );
    } catch (error) {
      setPersistenceActionState('idle');
      setPersistenceActionMessage('Supabase sync failed. Please retry.');
    } finally {
      if (persistenceTimeoutRef.current) {
        clearTimeout(persistenceTimeoutRef.current);
        persistenceTimeoutRef.current = null;
      }
    }
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
            <dd>{formatDateTime(lastSyncedAt)}</dd>
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
            onClick={handlePersist}
            disabled={persistenceActionState === 'submitting'}
          >
            {persistenceButtonCopy[persistenceActionState] ?? persistenceButtonCopy.idle}
          </button>
          <p className="team-persistence__goal">{teamPersistenceSnapshot.pendingManualOverrideGoal}</p>
        </div>
        <p className="team-persistence__mode" role="note">
          {persistenceEndpoint
            ? `Live Supabase persistence enabled at ${persistenceEndpoint}/team-persistence.`
            : 'Simulated Supabase persistence active. Set VITE_SUPABASE_PERSISTENCE_URL to target your live endpoint.'}
        </p>
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

TeamPersistencePanel.propTypes = {
  teamPersistenceSnapshot: PropTypes.shape({
    lastRunId: PropTypes.string,
    lastSyncedAt: PropTypes.string,
    preparedTeamRows: PropTypes.number,
    preparedPlayerRows: PropTypes.number,
    pendingManualOverrideGoal: PropTypes.string,
    manualOverrides: PropTypes.arrayOf(
      PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
        teamName: PropTypes.string,
        field: PropTypes.string,
        status: PropTypes.string,
        updatedAt: PropTypes.string,
        reason: PropTypes.string,
        value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
      }),
    ),
    runHistory: PropTypes.arrayOf(
      PropTypes.shape({
        runId: PropTypes.string,
        status: PropTypes.string,
        triggeredBy: PropTypes.string,
        startedAt: PropTypes.string,
        updatedTeams: PropTypes.number,
        updatedPlayers: PropTypes.number,
        notes: PropTypes.string,
      }),
    ),
  }).isRequired,
};

export default TeamPersistencePanel;
