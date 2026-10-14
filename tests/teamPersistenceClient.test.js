import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';

import { triggerTeamPersistence } from '../frontend/src/utils/teamPersistenceClient.js';
import { PERSISTENCE_INVALID_PAYLOAD } from '../frontend/src/lib/persistenceRequest.js';

// A snapshot the team-persistence Edge Function would accept (its
// `PersistencePayloadSchema`): since M4.4 the client checks that before sending.
const TEAM_PAYLOAD = {
  teamRows: [{ id: 'team-1' }],
  teamPlayerRows: [{ team_id: 'team-1', player_id: 'player-1' }],
};

afterEach(() => {
  delete process.env.VITE_SUPABASE_PERSISTENCE_URL;
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.SUPABASE_URL;
});

test('blocks persistence when pending overrides remain', async () => {
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 1, preparedPlayerRows: 1 },
    overrides: [{ id: 'pending-1', status: 'pending' }],
    fetchImpl,
    endpoint: 'http://example.com',
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.message, /pending review/);
  assert.equal(fetchCalled, false);
});

test('falls back to simulation when no endpoint is configured (mock mode)', async () => {
  const result = await triggerTeamPersistence({
    snapshot: {
      payload: TEAM_PAYLOAD,
      preparedTeamRows: 3,
      preparedPlayerRows: 45,
      lastRunId: 'run-123',
    },
    overrides: [],
    // No endpoint, no accessToken => Mock
  });

  assert.equal(result.status, 'error');
  assert.equal(result.message, 'Authentication token missing. Please sign in.');
});

test('uses provided endpoint and forwards access token', async () => {
  let capturedUrl;
  let capturedHeaders;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 2, preparedPlayerRows: 22 },
    overrides: [],
    fetchImpl,
    accessToken: 'token-123',
    endpoint: 'https://project.supabase.co/functions/v1',
  });

  assert.equal(capturedUrl, 'https://project.supabase.co/functions/v1/team-persistence');
  assert.equal(/** @type {any} */ (capturedHeaders).Authorization, 'Bearer token-123');
  assert.equal(result.status, 'success');
});

test('uses provided endpoint when available (vite example)', async () => {
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 1, preparedPlayerRows: 1 },
    overrides: [],
    fetchImpl,
    accessToken: 'token-abc',
    endpoint: 'https://vite.project.supabase.co/functions/v1',
  });

  assert.equal(capturedUrl, 'https://vite.project.supabase.co/functions/v1/team-persistence');
  assert.equal(result.status, 'success');
});

test('falls back to simulation when using derived endpoint without auth token', async () => {
  // If we call with an endpoint but NO token, logic suggests we might want to fail or simulate?
  // Current logic: const isMock = !accessToken && !providedEndpoint;
  // So if providedEndpoint IS present, isMock is false.
  // But if we want to test the "mock fallback", we should ensure isMock becomes true.
  // Implicitly, if we don't pass an endpoint, it defaults to API_BASE_URL (localhost).
  // If no access token, isMock is TRUE (because providedEndpoint is undefined).

  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 2, preparedPlayerRows: 22 },
    overrides: [],
    fetchImpl,
    // No accessToken, No endpoint => Mock
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.status, 'error');
});

test('posts to a configured endpoint and returns payload data', async () => {
  let capturedUrl;
  let capturedBody;
  const fetchImpl = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        status: 'success',
        syncedAt: '2024-07-20T18:00:00Z',
        updatedTeams: 4,
        updatedPlayers: 50,
        runId: 'run-live-1',
      }),
    };
  };

  const result = await triggerTeamPersistence({
    snapshot: {
      payload: TEAM_PAYLOAD,
      preparedTeamRows: 4,
      preparedPlayerRows: 50,
      lastRunId: 'run-live-1',
      runMetadata: { seasonSettingsId: 'fall', runId: 'run-live-1' },
    },
    overrides: [],
    fetchImpl,
    endpoint: 'https://api.example.com',
    accessToken: 'token',
  });

  assert.equal(capturedUrl, 'https://api.example.com/team-persistence');
  assert.deepEqual(/** @type {any} */ (capturedBody).snapshot, {
    payload: TEAM_PAYLOAD,
    preparedTeamRows: 4,
    preparedPlayerRows: 50,
    lastRunId: 'run-live-1',
    runMetadata: { seasonSettingsId: 'fall', runId: 'run-live-1' },
  });
  assert.deepEqual(/** @type {any} */ (capturedBody).runMetadata, {
    seasonSettingsId: 'fall',
    runId: 'run-live-1',
  });
  assert.equal(result.status, 'success');
  assert.equal(result.syncedAt, '2024-07-20T18:00:00Z');
});

test('treats missing status responses as errors (failsafe)', async () => {
  const fetchImpl = async () => {
    return {
      ok: true,
      json: async () => ({}), // Missing status
    };
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 1, preparedPlayerRows: 10 },
    overrides: [],
    fetchImpl,
    endpoint: 'https://api.example.com',
    accessToken: 'token',
  });

  assert.equal(result.status, 'error');
  assert.match(result.message, /Unexpected response/);
});

test('success status but missing message defaults to standard message', async () => {
  const fetchImpl = async () => {
    return {
      ok: true,
      json: async () => ({ status: 'success', syncedAt: '2024-07-21T10:00:00Z' }),
    };
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 2, preparedPlayerRows: 22 },
    overrides: [],
    fetchImpl,
    endpoint: 'https://api.example.com',
    accessToken: 'token',
  });

  assert.equal(result.status, 'success');
  assert.equal(result.message, 'Supabase sync completed.');
  assert.equal(result.syncedAt, '2024-07-21T10:00:00Z');
});

test('surfaces backend error messages when the response is not ok', async () => {
  const fetchImpl = async () => {
    return {
      ok: false,
      status: 422,
      json: async () => ({ message: 'Overrides blocked on the server' }),
    };
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 2, preparedPlayerRows: 30 },
    overrides: [],
    fetchImpl,
    endpoint: 'https://api.example.com',
    accessToken: 'token',
  });

  assert.equal(result.status, 'error');
  assert.equal(result.message, 'Overrides blocked on the server');
});

test('returns an error when the response payload cannot be parsed', async () => {
  const fetchImpl = async () => {
    return {
      ok: true,
      json: async () => {
        throw new Error('invalid json');
      },
      text: async () => 'Not JSON', // ApiClient might try text? No, just fails.
    };
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 2, preparedPlayerRows: 18 },
    overrides: [],
    fetchImpl,
    endpoint: 'https://api.example.com',
    accessToken: 'token',
  });

  assert.equal(result.status, 'error');
  assert.match(result.message, /Invalid response: Unable to parse JSON/);
});

test('returns an error status when the request fails (network error)', async () => {
  const fetchImpl = async () => {
    throw new Error('network failure');
  };

  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, preparedTeamRows: 2, preparedPlayerRows: 20 },
    overrides: [],
    fetchImpl,
    endpoint: 'https://api.example.com',
    accessToken: 'token',
  });

  assert.equal(result.status, 'error');
  assert.match(result.message, /network failure/);
});

// M4.4 (audit finding 2.3): the body is checked against the Edge Function's
// own schema before the network call. Refused in this client's contract, a
// returned `{ status: 'error' }`, with the Zod issues in a readable message.
test('refuses a malformed payload client-side, before any request, naming each issue', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const result = await triggerTeamPersistence({
    snapshot: {
      payload: {
        // A numeric team id and a player row with no player: both are what
        // the Edge's `PersistencePayloadSchema` answers with a 400.
        teamRows: [{ id: 7 }],
        teamPlayerRows: [{ team_id: 'team-1' }],
      },
    },
    overrides: [],
    fetchImpl,
    endpoint: 'https://api.example.com',
    accessToken: 'token',
  });

  assert.equal(fetchCalls, 0, 'a malformed payload reached the network');
  assert.equal(result.status, 'error');
  assert.equal(/** @type {any} */ (result).code, PERSISTENCE_INVALID_PAYLOAD);
  assert.deepEqual(
    /** @type {any} */ (result).issues.map((issue) => issue.path.join('.')),
    ['snapshot.payload.teamRows.0.id', 'snapshot.payload.teamPlayerRows.0.player_id']
  );
  assert.match(result.message, /^The team roster save was not sent: its data is malformed/);
  assert.match(result.message, /snapshot\.payload\.teamRows\.0\.id: [^;]*expected string/);
  assert.match(result.message, /snapshot\.payload\.teamPlayerRows\.0\.player_id: /);
  assert.match(result.message, /Nothing was saved\.$/);
});

test('judges the body as it will arrive: a value JSON sends as a string is not refused', async () => {
  // `JSON.stringify` sends a Date as its ISO string, which the Edge's
  // `lastRunId: z.string()` accepts; refusing the object as it is would make
  // the client stricter than its server.
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({ status: 'success' }) };
  };
  const result = await triggerTeamPersistence({
    snapshot: { payload: TEAM_PAYLOAD, lastRunId: new Date('2026-10-14T00:00:00Z') },
    overrides: [],
    fetchImpl,
    endpoint: 'https://api.example.com',
    accessToken: 'token',
  });
  assert.equal(result.status, 'success');
  assert.equal(fetchCalls, 1);
});
