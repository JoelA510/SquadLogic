import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { persistPracticeSnapshotTransactional } from '../packages/core/src/practicePersistenceHandler.js';
import { persistTeamSnapshotTransactional } from '../packages/core/src/teamPersistenceHandler.js';

// #64: `persist_practice_schedule` now returns jsonb (`run_id`, what it
// superseded, what it kept). The shared handler must read the id out of it,
// and must keep reading the bare id the team RPC still returns.
function clientReturning(data) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data, error: null };
    },
  };
}

describe('persistence handler run id (#64)', () => {
  it('reads run_id out of the practice RPC jsonb result', async () => {
    const client = clientReturning({ run_id: 'run-from-rpc', superseded_count: 2 });
    const result = await persistPracticeSnapshotTransactional({
      supabaseClient: client,
      snapshot: { payload: { assignmentRows: [{ team_id: 't1', practice_slot_id: 's1' }] } },
      runMetadata: { seasonSettingsId: 'season-1' },
      now: new Date('2026-09-24T00:00:00Z'),
    });
    assert.equal(client.calls.length, 1, 'the RPC was never called');
    assert.equal(client.calls[0].args.run_data.season_settings_id, 'season-1');
    assert.equal(client.calls[0].name, 'persist_practice_schedule');
    assert.equal(result.runId, 'run-from-rpc');
  });

  it('prefers the caller run id over the RPC result', async () => {
    const client = clientReturning({ run_id: 'run-from-rpc' });
    const result = await persistPracticeSnapshotTransactional({
      supabaseClient: client,
      snapshot: { payload: { assignmentRows: [{ team_id: 't1', practice_slot_id: 's1' }] } },
      runMetadata: { runId: 'run-from-caller', seasonSettingsId: 'season-1' },
      now: new Date('2026-09-24T00:00:00Z'),
    });
    assert.equal(result.runId, 'run-from-caller');
  });

  it('never hands the whole jsonb object back as the run id', async () => {
    const client = clientReturning({ superseded_count: 0 });
    const result = await persistPracticeSnapshotTransactional({
      supabaseClient: client,
      snapshot: { payload: { assignmentRows: [{ team_id: 't1', practice_slot_id: 's1' }] } },
      runMetadata: { seasonSettingsId: 'season-1' },
      now: new Date('2026-09-24T00:00:00Z'),
    });
    assert.equal(result.runId, null);
  });

  it('still reads the bare id the team RPC returns', async () => {
    const client = clientReturning('team-run-id');
    const result = await persistTeamSnapshotTransactional({
      supabaseClient: client,
      snapshot: { payload: { teamRows: [], teamPlayerRows: [] } },
      now: new Date('2026-09-24T00:00:00Z'),
    });
    assert.equal(result.runId, 'team-run-id');
  });
});
