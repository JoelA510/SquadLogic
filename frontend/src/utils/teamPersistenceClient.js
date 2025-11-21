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
  endpoint: providedEndpoint,
  fetchImpl = fetch,
  simulateDelayMs = 800,
  runMetadata,
  signal,
} = {}) {
  const pendingResult = resolvePendingOverrides(overrides);
  if (pendingResult) {
    return pendingResult;
  }

  if (!snapshot || typeof snapshot !== 'object') {
    return { status: 'error', message: 'Snapshot data unavailable' };
  }

  const endpoint = normalizeEndpoint(providedEndpoint ?? readPersistenceEndpoint());
  const effectiveRunMetadata =
    runMetadata ??
    (snapshot.runMetadata && typeof snapshot.runMetadata === 'object' && !Array.isArray(snapshot.runMetadata)
      ? snapshot.runMetadata
      : undefined);
  if (!endpoint) {
    return simulateTeamPersistenceUpsert({ snapshot, overrides, delayMs: simulateDelayMs });
  }

  try {
    const response = await fetchImpl(`${endpoint}/team-persistence`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ snapshot, overrides, runMetadata: effectiveRunMetadata }),
      signal,
    });

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to parse persistence response payload:', error);
    }

    if (!response.ok) {
      return {
        status: 'error',
        message:
          payload?.message ||
          `Persistence request failed with status ${response.status}`,
      };
    }

    if (!payload || typeof payload !== 'object') {
      return {
        status: 'error',
        message: 'Unexpected response from persistence endpoint.',
      };
    }
    const status = typeof payload.status === 'string' ? payload.status : 'error';
    return {
      status,
      message:
        payload.message ||
        (status === 'success'
          ? 'Supabase sync completed.'
          : 'Unexpected response from persistence endpoint.'),
      syncedAt: payload.syncedAt,
      updatedTeams: payload.updatedTeams,
      updatedPlayers: payload.updatedPlayers,
      runId: payload.runId,
    };
  } catch (error) {
    // Helpful for debugging network or unexpected failures
    // eslint-disable-next-line no-console
    console.error('Supabase sync failed:', error);
    return { status: 'error', message: 'Supabase sync failed. Please retry.' };
  }
}

export function getPersistenceEndpoint() {
  return normalizeEndpoint(readPersistenceEndpoint());
}
