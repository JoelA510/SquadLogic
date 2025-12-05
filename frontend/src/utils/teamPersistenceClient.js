import { ApiClient } from './apiClient.js';
import { simulateTeamPersistenceUpsert } from './simulateTeamPersistenceUpsert.js';
import { API_BASE_URL } from '../config.js';

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
  endpoint: providedEndpoint, // Allow overriding endpoint for testing
  accessToken,
  simulateDelayMs = 800,
  runMetadata,
  signal,
  fetchImpl = fetch,
} = {}) {
  // 1. Validation
  const pendingResult = resolvePendingOverrides(overrides);
  if (pendingResult) return pendingResult;

  if (!snapshot || typeof snapshot !== 'object') {
    return { status: 'error', message: 'Snapshot data unavailable' };
  }

  // 2. Resolve Configuration
  // Use the provided endpoint or fall back to the global constant from config.js
  const targetUrl = providedEndpoint ? normalizeEndpoint(providedEndpoint) : API_BASE_URL;

  // 3. Simulation vs. Real Request
  // If no endpoint is available (mock mode), default to simulation
  const shouldUseSimulation = !targetUrl || targetUrl.includes('localhost') && !accessToken && !providedEndpoint;

  // However, the original logic had a specific check:
  // If we derived the URL from env (source='supabase-url') but have no token, simulate.
  // With centralization, API_BASE_URL is always defined (defaults to localhost).
  // So we rely on the specific 'providedEndpoint' argument to force a real fetch in tests,
  // or the presence of a token for real auth calls.

  // Simplification for Refactor:
  // If we have an accessToken, we assume we want to write to the backend.
  // If we don't, and no explicit endpoint was forced, we simulate.
  const isMock = !accessToken && !providedEndpoint;

  if (isMock) {
    return simulateTeamPersistenceUpsert({ snapshot, overrides, delayMs: simulateDelayMs });
  }

  // 4. Execute Request
  const client = new ApiClient(targetUrl, accessToken, (_url, _ops) => (signal ? fetchImpl(_url, { ..._ops, signal }) : fetchImpl(_url, _ops)));
  const effectiveRunMetadata =
    runMetadata ??
    (snapshot.runMetadata && typeof snapshot.runMetadata === 'object' && !Array.isArray(snapshot.runMetadata)
      ? snapshot.runMetadata
      : undefined);

  const result = await client.post('team-persistence', {
    snapshot,
    overrides,
    runMetadata: effectiveRunMetadata,
  }, { signal });

  // 5. Normalization
  if (result.status === 'error') {
    return {
      status: 'error',
      message: result.message || 'Supabase sync failed. Please retry.'
    };
  }

  return {
    status: result.status || 'error', // Default to error if status undefined
    message: result.message || (result.status === 'success' ? 'Supabase sync completed.' : 'Unexpected response from persistence endpoint.'),
    syncedAt: result.syncedAt,
    updatedTeams: result.updatedTeams,
    updatedPlayers: result.updatedPlayers,
    runId: result.runId,
  };
}

export function getPersistenceEndpoint() {
  return normalizeEndpoint(API_BASE_URL);
}
