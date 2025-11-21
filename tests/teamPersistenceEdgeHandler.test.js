import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamPersistenceHttpHandler } from '../src/teamPersistenceEdgeHandler.js';

const SAMPLE_SNAPSHOT = {
  payload: {
    teamRows: [
      { id: 'team-1', division_id: 'u10', name: 'Sharks', coach_id: 'coach-1' },
    ],
    teamPlayerRows: [
      { team_id: 'team-1', player_id: 'player-1', role: 'player', source: 'auto' },
    ],
  },
};

function buildTransactionStub() {
  const calls = [];
  return {
    calls,
    client: {
      transaction: async (callback) => {
        const tx = {
          from: (table) => ({
            upsert: async (rows) => {
              calls.push({ table, rows });
              return { data: rows, error: null };
            },
          }),
        };

        const result = await callback(tx);
        calls.push({ committed: true });
        return result;
      },
    },
  };
}

test('returns 400 when the request body cannot be parsed', async () => {
  const { client } = buildTransactionStub();
  const handler = createTeamPersistenceHttpHandler({ supabaseClient: client });

  const request = new Request('http://localhost/team-persistence', {
    method: 'POST',
    body: '{"bad-json"',
    headers: { 'Content-Type': 'application/json' },
  });

  const response = await handler(request);
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.status, 'error');
  assert.match(payload.message, /Invalid JSON payload/);
});

test('returns 401 when user is missing', async () => {
  const { client } = buildTransactionStub();
  const handler = createTeamPersistenceHttpHandler({
    supabaseClient: client,
    allowedRoles: ['admin'],
    getUser: async () => null,
  });

  const request = new Request('http://localhost/team-persistence', {
    method: 'POST',
    body: JSON.stringify({ snapshot: SAMPLE_SNAPSHOT, runMetadata: { seasonSettingsId: 1 } }),
    headers: { 'Content-Type': 'application/json' },
  });

  const response = await handler(request);
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.status, 'unauthorized');
});

test('returns 400 when the request object is invalid', async () => {
  const { client } = buildTransactionStub();
  const handler = createTeamPersistenceHttpHandler({ supabaseClient: client });

  const response = await handler(null);
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.status, 'error');
  assert.match(payload.message, /Invalid request object/i);
});

test('returns success response when persistence succeeds', async () => {
  const { client, calls } = buildTransactionStub();
  const now = new Date('2024-08-12T12:00:00Z');
  const handler = createTeamPersistenceHttpHandler({
    supabaseClient: client,
    allowedRoles: ['admin'],
    now,
    getUser: async () => ({ role: 'admin' }),
  });

  const request = new Request('http://localhost/team-persistence', {
    method: 'POST',
    body: JSON.stringify({
      snapshot: { ...SAMPLE_SNAPSHOT, lastRunId: 'run-1' },
      runMetadata: { seasonSettingsId: 99, createdBy: 'admin-1' },
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  const response = await handler(request);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, 'success');
  assert.equal(payload.syncedAt, now.toISOString());
  assert.equal(payload.runId, 'run-1');

  const runCall = calls.find((entry) => entry.table === 'scheduler_runs');
  assert.ok(runCall, 'scheduler_runs upsert should occur');
  assert.equal(runCall.rows[0].created_by, 'admin-1');
});

test('returns 403 when user is authenticated but not allowed', async () => {
  const { client } = buildTransactionStub();
  const handler = createTeamPersistenceHttpHandler({
    supabaseClient: client,
    allowedRoles: ['admin'],
    getUser: async () => ({ role: 'coach' }),
  });

  const request = new Request('http://localhost/team-persistence', {
    method: 'POST',
    body: JSON.stringify({
      snapshot: SAMPLE_SNAPSHOT,
      runMetadata: { seasonSettingsId: 1 },
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  const response = await handler(request);
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.equal(payload.status, 'forbidden');
});

test('returns 500 when an unexpected error occurs in handler', async () => {
  const { client } = buildTransactionStub();
  const handler = createTeamPersistenceHttpHandler({
    supabaseClient: client,
    allowedRoles: ['admin'],
    getUser: async () => {
      throw new Error('boom');
    },
  });

  const request = new Request('http://localhost/team-persistence', {
    method: 'POST',
    body: JSON.stringify({
      snapshot: SAMPLE_SNAPSHOT,
      runMetadata: { seasonSettingsId: 1 },
    }),
    headers: { 'Content-Type': 'application/json' },
  });

  const response = await handler(request);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.status, 'error');
  assert.match(payload.message, /internal server error/i);
});
