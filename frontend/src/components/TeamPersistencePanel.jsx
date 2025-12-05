import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { formatDateTime } from '../utils/formatDateTime.js';
import {
  getPersistenceEndpoint,
  triggerTeamPersistence,
} from '../utils/teamPersistenceClient.js';
import { applyOverridesToSnapshot } from '../utils/applyOverridesToSnapshot.js';
import { PERSISTENCE_THEMES } from '../utils/themes.js';

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

  const theme = PERSISTENCE_THEMES.blue; // Default theme for Team Persistence

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
    <section className="glass-panel p-6 rounded-xl border border-white/10 relative overflow-hidden mb-10" aria-labelledby="team-persistence-heading">
      <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} pointer-events-none`} />

      <div className="relative z-10">
        <header className="flex justify-between items-start gap-8 mb-8 flex-wrap">
          <div>
            <h2 id="team-persistence-heading" className="text-2xl font-bold text-white mb-2 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${theme.dotColor} ${theme.shadowColor}`} />
              Supabase persistence
            </h2>
            <p className="text-white/70 max-w-prose leading-relaxed">
              Manual overrides are staged before writing teams and roster rows back to Supabase. Use this panel to
              confirm override readiness.
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-4" aria-label="Supabase persistence status">
            <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
              <dt className="text-xs text-white/50 uppercase tracking-wider mb-1 font-semibold">Last run</dt>
              <dd className="text-xl font-mono text-white font-bold">{teamPersistenceSnapshot.lastRunId}</dd>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
              <dt className="text-xs text-white/50 uppercase tracking-wider mb-1 font-semibold">Synced</dt>
              <dd className="text-xl font-mono text-white font-bold">{formatDateTime(lastSyncedAt)}</dd>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
              <dt className="text-xs text-white/50 uppercase tracking-wider mb-1 font-semibold">Prepared</dt>
              <dd className="text-xl font-mono text-white font-bold">
                {teamPersistenceSnapshot.preparedTeamRows} teams
              </dd>
            </div>
          </dl>
        </header>

        <div className="mb-6">
          <div className="flex gap-4 items-center mb-4">
            <button
              type="button"
              className={`px-6 py-3 rounded-full font-semibold text-white shadow-lg transition-all duration-200 ${persistenceActionState === 'submitting'
                  ? 'bg-white/10 text-white/50 cursor-not-allowed'
                  : `${theme.btnBg} ${theme.btnShadow} hover:-translate-y-px`
                }`}
              onClick={handlePersist}
              disabled={persistenceActionState === 'submitting'}
            >
              {persistenceButtonCopy[persistenceActionState] ?? persistenceButtonCopy.idle}
            </button>
            <span className="text-white/50">{teamPersistenceSnapshot.pendingManualOverrideGoal}</span>
          </div>

          <div className={`p-3 rounded-md mb-4 border ${persistenceEndpoint
              ? 'bg-green-500/10 text-green-400 border-green-500/20'
              : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
            }`}>
            <p className="text-sm m-0" role="note">
              {persistenceEndpoint
                ? `Live Supabase persistence enabled at ${persistenceEndpoint}.`
                : 'Simulated Supabase persistence active.'}
            </p>
          </div>

          <p className="text-white/70" role="status">
            {persistenceActionMessage || 'No Supabase push requested yet.'}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <article className="bg-white/5 border border-white/10 rounded-lg p-5 flex flex-col gap-2">
            <h3 className="text-base font-semibold text-blue-300 m-0">Manual overrides</h3>
            <p className="text-sm text-white/50 mt-auto pt-3 border-t border-white/10">
              {persistenceCounts.pending} of {persistenceCounts.total} pending review.
            </p>
            <ul className="list-none p-0 m-2 grid gap-2">
              {persistenceOverrides.map((override) => (
                <li key={override.id} className="p-2 rounded-md bg-white/5 flex justify-between items-baseline shadow-sm">
                  <div className="flex flex-col">
                    <div className="flex justify-between mb-1">
                      <span className="font-semibold text-white">{override.teamName}</span>
                      <span
                        className={`text-xs px-2 py-1 rounded-full font-semibold ${override.status === 'pending'
                            ? 'bg-yellow-500/20 text-yellow-400'
                            : 'bg-green-500/20 text-green-400'
                          }`}
                      >
                        {override.status === 'pending' ? 'Pending' : 'Applied'}
                      </span>
                    </div>
                    <p className="text-sm text-white/50 m-0">{override.reason}</p>
                  </div>
                  {override.status === 'pending' && (
                    <button
                      type="button"
                      className="mt-2 bg-transparent border border-blue-400 text-blue-400 px-3 py-1 rounded text-xs cursor-pointer hover:bg-blue-400/20 transition-colors"
                      onClick={() => handleOverrideStatusUpdate(override.id)}
                    >
                      Mark reviewed
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </article>

          <article className="bg-white/5 border border-white/10 rounded-lg p-5 flex flex-col gap-2">
            <h3 className="text-base font-semibold text-blue-300 m-0">Recent Supabase syncs</h3>
            <ul className="list-none p-0 m-2 grid gap-2">
              {latestHistory.map((run) => (
                <li key={run.runId} className="p-2 rounded-md bg-white/5 shadow-sm">
                  <div className="flex justify-between mb-1">
                    <span className="text-blue-300 font-mono">{run.runId}</span>
                    <span
                      className={`text-xs font-semibold ${run.status === 'success' ? 'text-green-400' : 'text-yellow-400'
                        }`}
                    >
                      {run.status}
                    </span>
                  </div>
                  <p className="text-sm text-white/50 m-0">
                    {formatDateTime(run.startedAt)}
                  </p>
                  <p className="text-sm text-white/70 mt-1">
                    Updated {run.updatedTeams} teams
                  </p>
                </li>
              ))}
            </ul>
          </article>
        </div>
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
