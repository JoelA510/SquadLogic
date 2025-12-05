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

export default function TeamPersistencePanel({ teamPersistenceSnapshot }) {
  const [persistenceActionState, setPersistenceActionState] = useState('idle');
  const [persistenceActionMessage, setPersistenceActionMessage] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(
    teamPersistenceSnapshot.lastSyncedAt,
  );
  const [persistenceOverrides, setPersistenceOverrides] = useState(
    teamPersistenceSnapshot.manualOverrides ?? [],
  );
  const persistenceTimeoutRef = useRef();

  const theme = PERSISTENCE_THEMES.blue;

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
              Supabase Persistence
            </h2>
            <p className="text-white/70 max-w-prose leading-relaxed">
              Manual overrides are staged before writing teams and roster rows back to Supabase. Use this panel to
              confirm override readiness.
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-4" aria-label="Supabase persistence status">
            <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
              <dt className="text-xs text-white/50 uppercase tracking-wider mb-1 font-semibold">Last Run</dt>
              <dd className="text-xl font-mono text-white font-bold">{teamPersistenceSnapshot.lastRunId || '-'}</dd>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
              <dt className="text-xs text-white/50 uppercase tracking-wider mb-1 font-semibold">Synced</dt>
              <dd className="text-xl font-mono text-white font-bold">{lastSyncedAt ? formatDateTime(lastSyncedAt) : 'Never'}</dd>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-lg p-3 text-center">
              <dt className="text-xs text-white/50 uppercase tracking-wider mb-1 font-semibold">Prepared</dt>
              <dd className="text-xl font-mono text-white font-bold">
                {teamPersistenceSnapshot.preparedTeamRows || 0} teams
              </dd>
            </div>
          </dl>
        </header>

        <div className="mb-8 p-4 bg-white/5 rounded-lg border border-white/10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${persistenceEndpoint ? 'bg-green-400' : 'bg-yellow-400'}`}></span>
              <span className="font-semibold text-white">{persistenceEndpoint ? 'Live Mode' : 'Simulation Mode'}</span>
            </div>
            <p className="text-sm text-white/60 m-0">
              {persistenceEndpoint
                ? `Syncing to ${persistenceEndpoint}`
                : 'Changes will not be saved to remote database.'}
            </p>
            {persistenceActionMessage && (
              <p className="text-sm text-blue-300 mt-2 animate-pulse">
                {persistenceActionMessage}
              </p>
            )}
          </div>

          <div className="flex items-center gap-4">
            {hasBlockingOverrides && (
              <div className="text-right hidden md:block">
                <div className="text-yellow-400 font-semibold text-sm">Action Required</div>
                <div className="text-white/60 text-xs">Review overrides to sync</div>
              </div>
            )}
            <button
              type="button"
              className={`px-6 py-3 rounded-lg font-semibold text-white shadow-lg transition-all duration-200 flex items-center gap-2 ${persistenceActionState === 'submitting'
                ? 'bg-white/10 text-white/50 cursor-not-allowed'
                : hasBlockingOverrides
                  ? 'bg-white/10 text-white/50 cursor-not-allowed border border-white/10'
                  : `${theme.btnBg} ${theme.btnShadow} hover:-translate-y-px`
                }`}
              onClick={handlePersist}
              disabled={persistenceActionState === 'submitting' || hasBlockingOverrides}
            >
              {persistenceButtonCopy[persistenceActionState] ?? persistenceButtonCopy.idle}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <article className="bg-white/5 border border-white/10 rounded-lg p-5 flex flex-col gap-2">
            <h3 className="text-base font-semibold text-blue-300 m-0">Manual Overrides</h3>
            <p className="text-sm text-white/50 mt-auto pt-3 border-t border-white/10">
              {persistenceCounts.pending} of {persistenceCounts.total} pending review.
            </p>
            {persistenceOverrides.length > 0 ? (
              <ul className="list-none p-0 m-2 grid gap-2">
                {persistenceOverrides.map((override) => (
                  <li key={override.id} className="p-3 rounded-md bg-white/5 flex justify-between items-start shadow-sm border border-white/5">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{override.teamName}</span>
                        <span
                          className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-bold ${override.status === 'pending'
                            ? 'bg-yellow-500/20 text-yellow-400'
                            : 'bg-green-500/20 text-green-400'
                            }`}
                        >
                          {override.status}
                        </span>
                      </div>
                      <p className="text-sm text-white/70 m-0">{override.reason}</p>
                    </div>
                    {override.status === 'pending' && (
                      <button
                        type="button"
                        className="ml-4 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 px-3 py-1.5 rounded text-xs font-medium transition-colors whitespace-nowrap"
                        onClick={() => handleOverrideStatusUpdate(override.id)}
                      >
                        Mark Reviewed
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-8 text-center text-white/30 italic border border-dashed border-white/10 rounded-lg">
                No manual overrides detected.
              </div>
            )}
          </article>

          <article className="bg-white/5 border border-white/10 rounded-lg p-5 flex flex-col gap-2">
            <h3 className="text-base font-semibold text-blue-300 m-0">Recent Supabase Syncs</h3>
            {latestHistory.length > 0 ? (
              <ul className="list-none p-0 m-2 grid gap-2">
                {latestHistory.map((run) => (
                  <li key={run.runId} className="p-3 rounded-md bg-white/5 shadow-sm border border-white/5">
                    <div className="flex justify-between mb-1">
                      <span className="text-blue-300 font-mono text-sm">{run.runId}</span>
                      <span
                        className={`text-xs font-semibold ${run.status === 'success' ? 'text-green-400' : 'text-yellow-400'
                          }`}
                      >
                        {run.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-xs text-white/50 m-0">
                      {formatDateTime(run.startedAt)}
                    </p>
                    <p className="text-sm text-white/80 mt-1">
                      Updated {run.updatedTeams} teams
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-8 text-center text-white/30 italic border border-dashed border-white/10 rounded-lg">
                No sync history available.
              </div>
            )}
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


