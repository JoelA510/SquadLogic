import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDateTime } from '../utils/formatDateTime.js';
import {
  getPersistenceEndpoint,
  triggerTeamPersistence,
} from '../utils/teamPersistenceClient.js';
import { applyOverridesToSnapshot } from '../utils/applyOverridesToSnapshot.js';

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
  const [persistenceOverrides, setPersistenceOverrides] = useState(
    teamPersistenceSnapshot.manualOverrides ?? [],
  );
  const persistenceTimeoutRef = useRef();

  useEffect(() => {
    setPersistenceOverrides(teamPersistenceSnapshot.manualOverrides ?? []);
  }, [teamPersistenceSnapshot.manualOverrides]);
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

  const hasBlockingOverrides = persistenceCounts.pending > 0;

  useEffect(() => {
    return () => {
      if (persistenceTimeoutRef.current) {
        clearTimeout(persistenceTimeoutRef.current);
      }
    };
  }, []);

  const setBlockedState = useCallback(() => {
    setPersistenceActionState('blocked');
    setPersistenceActionMessage(
      `${persistenceCounts.pending} manual override${persistenceCounts.pending === 1 ? ' is' : 's are'
      } still pending review.`,
    );
  }, [persistenceCounts.pending]);

  useEffect(() => {
    if (hasBlockingOverrides) {
      if (persistenceActionState !== 'submitting') {
        setBlockedState();
      }
      return;
    }

    if (persistenceActionState === 'blocked') {
      setPersistenceActionState('idle');
      setPersistenceActionMessage('All manual overrides have been reviewed.');
    }
  }, [hasBlockingOverrides, persistenceActionState, setBlockedState]);

  const persistenceEndpoint = getPersistenceEndpoint();
  const snapshotForPersistence = useMemo(() => {
    return applyOverridesToSnapshot(teamPersistenceSnapshot, persistenceOverrides);
  }, [teamPersistenceSnapshot, persistenceOverrides]);

  const handlePersist = async () => {
    if (persistenceActionState === 'submitting') {
      return;
    }

    if (hasBlockingOverrides) {
      setBlockedState();
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
        snapshot: snapshotForPersistence,
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

  const handleOverrideStatusUpdate = (overrideId) => {
    setPersistenceOverrides((current) =>
      current.map((entry) =>
        entry.id === overrideId
          ? { ...entry, status: 'applied', updatedAt: new Date().toISOString() }
          : entry,
      ),
    );
    setPersistenceActionMessage(
      'Override marked as applied. Supabase sync will include the update.',
    );
  };

  return (
    <section className="section-panel glass-panel team-persistence" aria-labelledby="team-persistence-heading">
      <header className="section-header">
        <div>
          <h2 id="team-persistence-heading">Supabase persistence</h2>
          <p>
            Manual overrides are staged before writing teams and roster rows back to Supabase. Use this panel to
            confirm override readiness.
          </p>
        </div>
        <dl className="metrics-grid" aria-label="Supabase persistence status">
          <div className="metric-item">
            <dt>Last run</dt>
            <dd className="text-display">{teamPersistenceSnapshot.lastRunId}</dd>
          </div>
          <div className="metric-item">
            <dt>Synced</dt>
            <dd className="text-display">{formatDateTime(lastSyncedAt)}</dd>
          </div>
          <div className="metric-item">
            <dt>Prepared</dt>
            <dd className="text-display">
              {teamPersistenceSnapshot.preparedTeamRows} teams
            </dd>
          </div>
        </dl>
      </header>

      <div className="team-persistence__actions">
        <div className="team-persistence__controls">
          <button
            type="button"
            className="persistence-button"
            onClick={handlePersist}
            disabled={persistenceActionState === 'submitting'}
          >
            {persistenceButtonCopy[persistenceActionState] ?? persistenceButtonCopy.idle}
          </button>
          <span className="text-muted">{teamPersistenceSnapshot.pendingManualOverrideGoal}</span>
        </div>

        <div className={`persistence-mode-banner ${persistenceEndpoint ? 'live' : 'simulated'}`}>
          <p className="team-persistence__mode" role="note">
            {persistenceEndpoint
              ? `Live Supabase persistence enabled at ${persistenceEndpoint}.`
              : 'Simulated Supabase persistence active.'}
          </p>
        </div>

        <p className="team-persistence__action-message" role="status">
          {persistenceActionMessage || 'No Supabase push requested yet.'}
        </p>
      </div>

      <div className="insights-grid">
        <article className="insight-card">
          <h3>Manual overrides</h3>
          <p className="insight-meta">
            {persistenceCounts.pending} of {persistenceCounts.total} pending review.
          </p>
          <ul className="insight-card__list">
            {persistenceOverrides.map((override) => (
              <li key={override.id} className="insight-card__list-item">
                <div className="insight-card__list-header">
                  <span className="insight-card__list-label">
                    {override.teamName}
                  </span>
                  <span
                    className={`insight-card__status-pill ${override.status === 'pending' ? 'status-warning' : 'status-success'
                      }`}
                  >
                    {override.status === 'pending' ? 'Pending' : 'Applied'}
                  </span>
                </div>
                <p className="insight-card__list-meta">{override.reason}</p>
                {override.status === 'pending' && (
                  <button
                    type="button"
                    className="insight-card__action-button"
                    onClick={() => handleOverrideStatusUpdate(override.id)}
                  >
                    Mark reviewed
                  </button>
                )}
              </li>
            ))}
          </ul>
        </article>

        <article className="insight-card">
          <h3>Recent Supabase syncs</h3>
          <ul className="insight-card__list">
            {latestHistory.map((run) => (
              <li key={run.runId} className="insight-card__list-item">
                <div className="insight-card__list-header">
                  <span className="text-accent text-monospace">{run.runId}</span>
                  <span
                    className={`insight-card__status-text ${run.status === 'success' ? 'text-success' : 'text-warning'
                      }`}
                  >
                    {run.status}
                  </span>
                </div>
                <p className="insight-card__list-meta">
                  {formatDateTime(run.startedAt)}
                </p>
                <p className="insight-card__list-detail">
                  Updated {run.updatedTeams} teams
                </p>
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
