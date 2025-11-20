import assert from 'node:assert/strict';
import test from 'node:test';

import { applyOverridesToSnapshot } from '../frontend/src/utils/applyOverridesToSnapshot.js';

test('applyOverridesToSnapshot applies reviewed overrides to payload team rows', () => {
  const snapshot = {
    preparedTeamRows: 2,
    payload: {
      teamRows: [
        { id: 't1', name: 'Team One', coachId: 'coach-1' },
        { id: 't2', name: 'Team Two', coachId: 'coach-2' },
      ],
    },
  };

  const overrides = [
    { id: 'override-1', teamId: 't1', field: 'name', value: 'Team One Updated', status: 'applied' },
    { id: 'override-2', teamId: 't2', field: 'coachId', value: 'coach-9', status: 'pending' },
  ];

  const updatedSnapshot = applyOverridesToSnapshot(snapshot, overrides);

  assert.deepEqual(updatedSnapshot.manualOverrides, overrides);
  assert.deepEqual(updatedSnapshot.payload.teamRows, [
    { id: 't1', name: 'Team One Updated', coachId: 'coach-1' },
    { id: 't2', name: 'Team Two', coachId: 'coach-2' },
  ]);
  assert.equal(updatedSnapshot.preparedTeamRows, 2);
});

