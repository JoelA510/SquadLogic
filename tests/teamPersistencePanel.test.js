import assert from 'node:assert/strict';
import test from 'node:test';

import { applyOverridesToSnapshot } from '../frontend/src/utils/applyOverridesToSnapshot.js';

test('applyOverridesToSnapshot resolves generator ids via teamIdMap and applies name/coach changes', () => {
  const snapshot = {
    preparedTeamRows: 2,
    payload: {
      teamRows: [
        { id: 'supabase-1', name: 'Team One', coach_id: 'coach-1' },
        { id: 'supabase-2', name: 'Team Two', coach_id: 'coach-2' },
      ],
      teamIdMap: new Map([
        ['generator-1', 'supabase-1'],
        ['generator-2', 'supabase-2'],
      ]),
    },
  };

  const overrides = [
    {
      id: 'override-1',
      teamId: 'generator-1',
      field: 'name',
      value: 'Team One Updated',
      status: 'applied',
    },
    {
      id: 'override-2',
      teamId: 'generator-2',
      field: 'coachId',
      value: 'coach-9',
      status: 'applied',
    },
  ];

  const updatedSnapshot = applyOverridesToSnapshot(snapshot, overrides);

  assert.deepEqual(updatedSnapshot.manualOverrides, overrides);
  assert.deepEqual(updatedSnapshot.payload.teamRows, [
    { id: 'supabase-1', name: 'Team One Updated', coach_id: 'coach-1' },
    { id: 'supabase-2', name: 'Team Two', coach_id: 'coach-9' },
  ]);
  assert.equal(updatedSnapshot.preparedTeamRows, 2);
});

test('applyOverridesToSnapshot updates coach_id when using plain object teamIdMap', () => {
  const snapshot = {
    preparedTeamRows: 1,
    payload: {
      teamRows: [{ id: 'db-1', name: 'Original', coach_id: 'coach-a' }],
      teamIdMap: { 'generator-3': 'db-1' },
    },
  };

  const overrides = [
    {
      id: 'override-3',
      teamId: 'generator-3',
      field: 'coachId',
      value: 'coach-new',
      status: 'applied',
    },
  ];

  const updatedSnapshot = applyOverridesToSnapshot(snapshot, overrides);

  assert.deepEqual(updatedSnapshot.payload.teamRows, [
    { id: 'db-1', name: 'Original', coach_id: 'coach-new' },
  ]);
});

