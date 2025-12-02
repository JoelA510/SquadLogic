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
            <dd style={{ fontSize: '1rem' }}>{teamPersistenceSnapshot.lastRunId}</dd>
          </div>
          <div className="metric-item">
            <dt>Synced</dt>
            <dd style={{ fontSize: '1rem' }}>{formatDateTime(lastSyncedAt)}</dd>
          </div>
          <div className="metric-item">
            <dt>Prepared</dt>
            <dd style={{ fontSize: '1rem' }}>
              {teamPersistenceSnapshot.preparedTeamRows} teams
            </dd>
          </div>
        </dl>
      </header>

      <div className="team-persistence__actions" style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
          <button
            type="button"
            className="persistence-button"
            onClick={handlePersist}
            disabled={persistenceActionState === 'submitting'}
            style={{
              padding: '0.75rem 1.5rem',
              borderRadius: '9999px',
              background: 'var(--color-primary)',
              color: 'white',
              border: 'none',
              fontWeight: '600',
              cursor: 'pointer',
              boxShadow: '0 4px 12px var(--color-primary-glow)'
            }}
          >
            {persistenceButtonCopy[persistenceActionState] ?? persistenceButtonCopy.idle}
          </button>
          <span className="text-muted">{teamPersistenceSnapshot.pendingManualOverrideGoal}</span>
        </div>

        <div className={`persistence-mode-banner ${persistenceEndpoint ? 'live' : 'simulated'}`}
          style={{
            padding: '0.75rem',
            borderRadius: '0.5rem',
            background: persistenceEndpoint ? 'var(--color-status-success-bg)' : 'var(--color-status-warning-bg)',
            color: persistenceEndpoint ? 'var(--color-status-success)' : 'var(--color-status-warning)',
            border: `1px solid ${persistenceEndpoint ? 'var(--color-status-success)' : 'var(--color-status-warning)'}`,
            marginBottom: '1rem'
          }}>
          <p className="team-persistence__mode" role="note" style={{ margin: 0, fontSize: '0.9rem' }}>
            {persistenceEndpoint
              ? `Live Supabase persistence enabled at ${persistenceEndpoint}.`
              : 'Simulated Supabase persistence active.'}
          </p>
        </div>

        <p className="team-persistence__action-message" role="status" style={{ color: 'var(--color-text-secondary)' }}>
          {persistenceActionMessage || 'No Supabase push requested yet.'}
        </p>
      </div>

      <div className="insights-grid">
        <article className="insight-card">
          <h3>Manual overrides</h3>
          <p className="insight-meta" style={{ marginBottom: '1rem' }}>
            {persistenceCounts.pending} of {persistenceCounts.total} pending review.
          </p>
          <ul className="insight-list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.75rem' }}>
            {persistenceOverrides.map((override) => (
              <li key={override.id} style={{
                background: 'var(--color-bg-app)',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--color-border-subtle)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>
                    {override.teamName}
                  </span>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.25rem 0.5rem',
                      borderRadius: '999px',
                      background: override.status === 'pending' ? 'var(--color-status-warning-bg)' : 'var(--color-status-success-bg)',
                      color: override.status === 'pending' ? 'var(--color-status-warning)' : 'var(--color-status-success)'
                    }}
                  >
                    {override.status === 'pending' ? 'Pending' : 'Applied'}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>{override.reason}</p>
                {override.status === 'pending' && (
                  <button
                    type="button"
                    onClick={() => handleOverrideStatusUpdate(override.id)}
                    style={{
                      marginTop: '0.5rem',
                      background: 'transparent',
                      border: '1px solid var(--color-primary)',
                      color: 'var(--color-primary)',
                      padding: '0.25rem 0.75rem',
                      borderRadius: '0.25rem',
                      cursor: 'pointer',
                      fontSize: '0.75rem'
                    }}
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
          <ul className="persistence-history" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.75rem' }}>
            {latestHistory.map((run) => (
              <li key={run.runId} style={{
                background: 'var(--color-bg-app)',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                border: '1px solid var(--color-border-subtle)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <span style={{ fontFamily: 'monospace', color: 'var(--color-text-accent)' }}>{run.runId}</span>
                  <span style={{
                    fontSize: '0.75rem',
                    color: run.status === 'success' ? 'var(--color-status-success)' : 'var(--color-status-warning)'
                  }}>
                    {run.status}
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
                  {formatDateTime(run.startedAt)}
                </p>
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
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
