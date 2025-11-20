/**
 * Backend-oriented helpers for validating and responding to team persistence requests.
 */

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('snapshot must be an object');
  }

  const payload = snapshot.payload;
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('snapshot.payload must be an object');
  }

  const { teamRows, teamPlayerRows } = payload;

  if (!Array.isArray(teamRows)) {
    throw new TypeError('snapshot.payload.teamRows must be an array');
  }
  if (!Array.isArray(teamPlayerRows)) {
    throw new TypeError('snapshot.payload.teamPlayerRows must be an array');
  }

  teamRows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`teamRows[${index}] must be an object`);
    }
    if (typeof row.id !== 'string' || !row.id.trim()) {
      throw new Error(`teamRows[${index}] requires an id`);
    }
  });

  teamPlayerRows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new TypeError(`teamPlayerRows[${index}] must be an object`);
    }
    if (typeof row.team_id !== 'string' || !row.team_id.trim()) {
      throw new Error(`teamPlayerRows[${index}] requires a team_id`);
    }
    if (typeof row.player_id !== 'string' || !row.player_id.trim()) {
      throw new Error(`teamPlayerRows[${index}] requires a player_id`);
    }
  });

  return {
    teamRows,
    teamPlayerRows,
    runId: snapshot.lastRunId ?? snapshot.runId ?? null,
  };
}

function evaluateOverrides(overrides = []) {
  if (!Array.isArray(overrides)) {
    throw new TypeError('overrides must be an array');
  }

  const pending = overrides.reduce((count, entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`overrides[${index}] must be an object`);
    }

    const status =
      (typeof entry.status === 'string' && entry.status.trim().toLowerCase()) || 'pending';

    return status === 'pending' ? count + 1 : count;
  }, 0);

  return { pending };
}

/**
 * Validate a persistence request payload and return a response-friendly summary.
 */
export function handleTeamPersistence({ snapshot, overrides = [], now = new Date() } = {}) {
  const { teamRows, teamPlayerRows, runId } = normalizeSnapshot(snapshot);
  const { pending } = evaluateOverrides(overrides);

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  if (pending > 0) {
    return {
      status: 'blocked',
      message: `${pending} manual override${pending === 1 ? ' is' : 's are'} still pending review.`,
      pendingOverrides: pending,
      runId,
    };
  }

  return {
    status: 'success',
    message: 'Snapshot validated. Ready for persistence upsert.',
    syncedAt: now.toISOString(),
    updatedTeams: teamRows.length,
    updatedPlayers: teamPlayerRows.length,
    runId,
  };
}

export { normalizeSnapshot, evaluateOverrides };
