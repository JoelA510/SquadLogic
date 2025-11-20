import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { triggerTeamPersistence } from '../frontend/src/utils/teamPersistenceClient.js';

afterEach(() => {
  delete process.env.VITE_SUPABASE_PERSISTENCE_URL;
});

test('blocks persistence when pending overrides remain', async () => {
  process.env.VITE_SUPABASE_PERSISTENCE_URL = 'http://example.com';

  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const result = await triggerTeamPersistence({
    snapshot: { preparedTeamRows: 1, preparedPlayerRows: 1 },
    overrides: [{ id: 'pending-1', status: 'pending' }],
    fetchImpl,
    simulateDelayMs: 0,
  });

  assert.equal(result.status, 'blocked');
  assert.match(result.message, /pending review/);
  assert.equal(fetchCalled, false);
});

test('falls back to simulation when no endpoint is configured', async () => {
  const result = await triggerTeamPersistence({
    snapshot: {
      preparedTeamRows: 3,
      preparedPlayerRows: 45,
      lastRunId: 'run-123',
    },
    overrides: [],
    simulateDelayMs: 0,
  });

  assert.equal(result.status, 'success');
  assert.equal(result.updatedTeams, 3);
  assert.equal(result.updatedPlayers, 45);
});

test('posts to a configured endpoint and returns payload data', async () => {
  process.env.VITE_SUPABASE_PERSISTENCE_URL = 'https://api.example.com';

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
    snapshot: { preparedTeamRows: 4, preparedPlayerRows: 50, lastRunId: 'run-live-1' },
    overrides: [],
    fetchImpl,
  });

  assert.equal(capturedUrl, 'https://api.example.com/team-persistence');
  assert.deepEqual(capturedBody.snapshot, {
    preparedTeamRows: 4,
    preparedPlayerRows: 50,
    lastRunId: 'run-live-1',
  });
  assert.equal(result.status, 'success');
  assert.equal(result.syncedAt, '2024-07-20T18:00:00Z');
});

test('treats missing status responses as errors', async () => {
  process.env.VITE_SUPABASE_PERSISTENCE_URL = 'https://api.example.com';

  const fetchImpl = async () => {
    return {
      ok: true,
      json: async () => ({}),
    };
  };

  const result = await triggerTeamPersistence({
    snapshot: { preparedTeamRows: 1, preparedPlayerRows: 10 },
    overrides: [],
    fetchImpl,
  });

  assert.equal(result.status, 'error');
  assert.match(result.message, /Unexpected response/);
});

test('falls back to a default success message when status is success but message is missing', async () => {
  process.env.VITE_SUPABASE_PERSISTENCE_URL = 'https://api.example.com';

  const fetchImpl = async () => {
    return {
      ok: true,
      json: async () => ({ status: 'success', syncedAt: '2024-07-21T10:00:00Z' }),
    };
  };

  const result = await triggerTeamPersistence({
    snapshot: { preparedTeamRows: 2, preparedPlayerRows: 22 },
    overrides: [],
    fetchImpl,
  });

  assert.equal(result.status, 'success');
  assert.equal(result.message, 'Supabase sync completed.');
  assert.equal(result.syncedAt, '2024-07-21T10:00:00Z');
});

test('returns an error status when the request fails', async () => {
  process.env.VITE_SUPABASE_PERSISTENCE_URL = 'https://api.example.com';

  const fetchImpl = async () => {
    throw new Error('network failure');
  };

  const result = await triggerTeamPersistence({
    snapshot: { preparedTeamRows: 2, preparedPlayerRows: 20 },
    overrides: [],
    fetchImpl,
  });

  assert.equal(result.status, 'error');
  assert.match(result.message, /Supabase sync failed/);
});
