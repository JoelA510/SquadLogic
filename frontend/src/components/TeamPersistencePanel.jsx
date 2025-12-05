import PersistenceOverridesList from './PersistenceOverridesList';
import PersistenceHistoryList from './PersistenceHistoryList';

// ... (imports remain)
export default function TeamPersistencePanel({ teamPersistenceSnapshot }) {
  // ... (state logic remains)
  // ...
  // ...

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
