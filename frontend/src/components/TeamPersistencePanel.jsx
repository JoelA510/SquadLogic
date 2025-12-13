import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useAuth } from '../contexts/AuthContext';
import { formatDateTime } from '../utils/formatters.js';
import {
  getPersistenceEndpoint,
  triggerTeamPersistence,
} from '../utils/teamPersistenceClient.js';
import { applyOverridesToSnapshot } from '../utils/applyOverridesToSnapshot.js';
import PersistencePanel from './PersistencePanel';
import PersistenceOverridesList from './PersistenceOverridesList';
import PersistenceHistoryList from './PersistenceHistoryList';

const SUPABASE_SYNC_TIMEOUT_MS = 10000;

export default function TeamPersistencePanel({ teamPersistenceSnapshot }) {
  const { session } = useAuth();

  if (!teamPersistenceSnapshot) {
    return null;
  }

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
        accessToken: session?.access_token,
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
        setPersistenceActionState('error');
        return;
      }

      setLastSyncedAt(result.syncedAt);
      setPersistenceActionState('ready');
      setPersistenceActionMessage(
        `Supabase upsert completed for ${result.updatedTeams} teams and ${result.updatedPlayers} players at ${formatDateTime(result.syncedAt)}.`,
      );
    } catch (error) {
      setPersistenceActionState('error');
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

  let panelStatus = 'idle';
  if (persistenceActionState === 'submitting') panelStatus = 'syncing';
  if (persistenceActionState === 'ready') panelStatus = 'success';
  if (persistenceActionState === 'error' || persistenceActionState === 'blocked') panelStatus = 'error';


  return (
    <PersistencePanel
      title="Team Persistence"
      colorTheme="blue"
      stats={[
        { label: 'Last Run', value: teamPersistenceSnapshot.lastRunId || '-' },
        { label: 'Synced', value: lastSyncedAt ? formatDateTime(lastSyncedAt) : 'Never' },
        { label: 'Prepared', value: `${teamPersistenceSnapshot.preparedTeamRows || 0} teams` }
      ]}
      onSync={handlePersist}
      status={panelStatus}
      message={persistenceActionMessage}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <PersistenceOverridesList
          overrides={persistenceOverrides}
          totalCount={persistenceCounts.total}
          pendingCount={persistenceCounts.pending}
          onMarkReviewed={handleOverrideStatusUpdate}
        />

        <PersistenceHistoryList history={latestHistory} />
      </div>
    </PersistencePanel>
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
