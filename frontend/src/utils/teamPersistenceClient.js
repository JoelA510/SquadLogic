import { simulateTeamPersistenceUpsert } from './simulateTeamPersistenceUpsert.js';

function readPersistenceEndpoint() {
  const viteEndpoint =
    typeof import.meta !== 'undefined'
      ? import.meta.env?.VITE_SUPABASE_PERSISTENCE_URL
      : undefined;

  const nodeEnvEndpoint =
    typeof process !== 'undefined' ? process.env?.VITE_SUPABASE_PERSISTENCE_URL : undefined;

  return viteEndpoint || nodeEnvEndpoint;
}

function normalizeEndpoint(baseUrl) {
  if (!baseUrl) return undefined;
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function resolvePendingOverrides(overrides = []) {
  const pending = overrides.filter((entry) => entry?.status === 'pending').length;

  if (pending > 0) {
    return {
      status: 'blocked',
      message: `${pending} manual override${pending === 1 ? ' is' : 's are'} still pending review.`,
    };
  }

  return undefined;
}

export async function triggerTeamPersistence({
  snapshot,
  overrides = [],
  fetchImpl = fetch,
  simulateDelayMs = 800,
  signal,
} = {}) {
  const pendingResult = resolvePendingOverrides(overrides);
  if (pendingResult) {
    return pendingResult;
  }

  if (!snapshot || typeof snapshot !== 'object') {
    return { status: 'error', message: 'Snapshot data unavailable' };
  }

  const endpoint = normalizeEndpoint(readPersistenceEndpoint());
  if (!endpoint) {
    return simulateTeamPersistenceUpsert({ snapshot, overrides, delayMs: simulateDelayMs });
  }

  try {
    const response = await fetchImpl(`${endpoint}/team-persistence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ snapshot, overrides }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Persistence request failed with status ${response.status}`);
    }

    const payload = await response.json();
    return {
      status: payload.status ?? 'success',
      message: payload.message,
      syncedAt: payload.syncedAt,
      updatedTeams: payload.updatedTeams,
      updatedPlayers: payload.updatedPlayers,
      runId: payload.runId,
    };
  } catch (error) {
    return { status: 'error', message: 'Supabase sync failed. Please retry.' };
  }
}

export function getPersistenceEndpoint() {
  return normalizeEndpoint(readPersistenceEndpoint());
}
