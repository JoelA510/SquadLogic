export function simulateTeamPersistenceUpsert({
  snapshot,
  overrides = [],
  delayMs = 800,
} = {}) {
  const pending = overrides.filter((entry) => entry?.status === 'pending').length;

  return new Promise((resolve) => {
    setTimeout(() => {
      if (!snapshot || typeof snapshot !== 'object') {
        resolve({ status: 'error', message: 'Snapshot data unavailable' });
        return;
      }

      if (pending > 0) {
        resolve({
          status: 'blocked',
          message: `${pending} manual override${pending === 1 ? ' is' : 's are'} still pending review.`,
        });
        return;
      }

      const syncedAt = new Date().toISOString();
      resolve({
        status: 'success',
        syncedAt,
        updatedTeams: snapshot.preparedTeamRows ?? 0,
        updatedPlayers: snapshot.preparedPlayerRows ?? 0,
        runId: snapshot.lastRunId ?? 'latest-run',
      });
    }, delayMs);
  });
}
