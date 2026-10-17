/**
 * Frontend/persistence integration (project-hardening PR 08): buildExistingSnapshotForRerun
 * (persisted snapshot -> existingSnapshot) plus an end-to-end round-trip proving a re-run
 * preserves UUIDs and produces a full authoritative persistence payload.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildExistingSnapshotForRerun,
  buildTeamReviewSnapshot,
} from '../frontend/src/utils/teamReviewPersistence.js';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { reconcileTeamDeltas } from '../packages/core/src/teamDelta.js';
import { createDeterministicRandom } from './fixtures/incrementalTeamingFixtures.js';
import { MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const U_A = '11111111-1111-4111-8111-111111111111';
const U_B = '22222222-2222-4222-8222-222222222222';

/** A persisted snapshot in the shape useTeamPersistence exposes (generation teams + relational rows). */
function persistedSnapshot() {
  return {
    lastRunId: 'run-prev',
    runHistory: [{ status: 'review' }],
    payload: {
      teamRows: [
        {
          id: U_A,
          generatorId: 'U10-T01',
          name: 'Raptors',
          division: 'U10',
          coachId: 'coach-1',
          assistantCoachIds: ['asst-1'],
          players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
        },
        {
          id: U_B,
          generatorId: 'U10-T02',
          name: 'Sharks',
          division: 'U10',
          players: [{ id: 'p4' }, { id: 'p5' }, { id: 'p6' }],
        },
      ],
      teamPlayerRows: [
        { team_id: U_A, player_id: 'p1', role: 'player', source: 'manual' },
        { team_id: U_A, player_id: 'p2', role: 'player', source: 'auto' },
        { team_id: U_A, player_id: 'p3', role: 'player', source: 'auto' },
        { team_id: U_A, player_id: 'asst-1', role: 'assistant_coach', source: 'auto' },
        { team_id: U_B, player_id: 'p4', role: 'player', source: 'auto' },
        { team_id: U_B, player_id: 'p5', role: 'player', source: 'auto' },
        { team_id: U_B, player_id: 'p6', role: 'player', source: 'auto' },
      ],
    },
  };
}

test('buildExistingSnapshotForRerun returns null when there is nothing to preserve', () => {
  assert.equal(buildExistingSnapshotForRerun(null), null);
  assert.equal(buildExistingSnapshotForRerun({ payload: { teamRows: [] } }), null);
  assert.equal(
    buildExistingSnapshotForRerun(persistedSnapshot(), { divisionKey: 'U99' }),
    null,
    'no teams for the requested division'
  );
});

test('buildExistingSnapshotForRerun preserves UUIDs, coach/assistant ids, and manual source', () => {
  const snapshot = buildExistingSnapshotForRerun(persistedSnapshot(), { divisionKey: 'U10' });
  assert.equal(snapshot.status, 'review');
  assert.equal(snapshot.runId, 'run-prev');
  const teams = snapshot.teamsByDivision.U10;
  assert.equal(teams.length, 2);

  const raptors = teams.find((t) => t.id === U_A);
  assert.equal(raptors.id, U_A, 'persisted UUID preserved (not remapped)');
  assert.equal(raptors.generatorId, 'U10-T01');
  assert.equal(raptors.coachId, 'coach-1');
  assert.deepEqual(raptors.assistantCoachIds, ['asst-1'], 'assistant reconstructed from role rows');
  // The relational source is authoritative: p1 is manual.
  assert.equal(raptors.players.find((p) => p.id === 'p1').assignment_source, 'manual');
  assert.equal(raptors.players.find((p) => p.id === 'p2').assignment_source, 'auto');
  assert.ok(!raptors.players.some((p) => p.id === 'asst-1'), 'assistant not in the roster');
});

test('buildExistingSnapshotForRerun falls back to inline players when relational rows are absent', () => {
  const base = {
    runHistory: [{ status: 'published' }],
    payload: {
      teamRows: [
        {
          id: U_A,
          division: 'U10',
          players: [{ id: 'p1', assignment_source: 'manual' }, { id: 'p2' }],
        },
      ],
    },
  };
  const snapshot = buildExistingSnapshotForRerun(base, { divisionKey: 'U10' });
  const players = snapshot.teamsByDivision.U10[0].players;
  assert.equal(players.find((p) => p.id === 'p1').assignment_source, 'manual');
  assert.equal(players.find((p) => p.id === 'p2').assignment_source, 'auto');
});

test('buildExistingSnapshotForRerun prefers the division-specific payloadByDivision over the global payload', () => {
  // The most-recent run persisted U12, so the global `payload` holds only U12. U10 (persisted by an
  // earlier run) lives in payloadByDivision — without it, re-running U10 finds nothing in `payload`
  // and would silently regenerate fresh, discarding U10's UUIDs and manual moves.
  const snapshot = {
    lastRunId: 'run-u12',
    runHistory: [{ status: 'review' }],
    payload: {
      teamRows: [{ id: U_B, division: 'U12', players: [{ id: 'q1' }] }],
      teamPlayerRows: [{ team_id: U_B, player_id: 'q1', role: 'player', source: 'auto' }],
    },
    payloadByDivision: {
      U10: {
        teamRows: [{ id: U_A, division: 'U10', coachId: 'coach-1', players: [{ id: 'p1' }] }],
        teamPlayerRows: [{ team_id: U_A, player_id: 'p1', role: 'player', source: 'manual' }],
      },
    },
  };

  const u10 = buildExistingSnapshotForRerun(snapshot, { divisionKey: 'U10' });
  assert.ok(u10, 'U10 found via payloadByDivision even though the latest run was U12');
  const team = u10.teamsByDivision.U10[0];
  assert.equal(team.id, U_A, 'preserved the earlier U10 run UUID');
  assert.equal(team.coachId, 'coach-1');
  assert.equal(team.players.find((p) => p.id === 'p1').assignment_source, 'manual');

  // The global payload still serves the most-recent division directly.
  const u12 = buildExistingSnapshotForRerun(snapshot, { divisionKey: 'U12' });
  assert.equal(u12.teamsByDivision.U12[0].id, U_B);
});

test('buildExistingSnapshotForRerun keeps coach role rows out of the roster', () => {
  const base = {
    runHistory: [{ status: 'review' }],
    payload: {
      teamRows: [{ id: U_A, division: 'U10', players: [] }],
      teamPlayerRows: [
        { team_id: U_A, player_id: 'p1', role: 'player', source: 'auto' },
        { team_id: U_A, player_id: 'coach-1', role: 'coach', source: 'auto' },
        { team_id: U_A, player_id: 'asst-1', role: 'Assistant Coach', source: 'auto' },
      ],
    },
  };
  const team = buildExistingSnapshotForRerun(base, { divisionKey: 'U10' }).teamsByDivision.U10[0];
  assert.deepEqual(
    team.players.map((p) => p.id),
    ['p1'],
    'head-coach and assistant role rows are not seated as roster players'
  );
  assert.deepEqual(
    team.assistantCoachIds,
    ['asst-1'],
    'case-insensitive assistant role reconstructed into assistantCoachIds'
  );
});

test('integration: a re-run preserves persisted team UUIDs and manual locks', () => {
  const existingSnapshot = buildExistingSnapshotForRerun(persistedSnapshot(), {
    divisionKey: 'U10',
  });
  const result = generateTeams({
    // p4 dropped; late-1 added; everyone else returns. p1 (the coach's child) carries the
    // coach reference exactly as linkCoachesToPlayers projects it in the real pipeline, so
    // coach continuity recognizes coach-1 as still-active and keeps the anchor.
    players: [
      { id: 'p1', division: 'U10', coachId: 'coach-1' },
      { id: 'p2', division: 'U10' },
      { id: 'p3', division: 'U10' },
      { id: 'p5', division: 'U10' },
      { id: 'p6', division: 'U10' },
      { id: 'late-1', division: 'U10' },
    ],
    divisionConfigs: { U10: { id: 'U10', teamsCount: 2, slotsPerWeek: 4, maxRosterSize: 4 } },
    random: createDeterministicRandom(),
    existingSnapshot,
    generationMode: 'review',
  });

  const teams = result.teamsByDivision.U10;
  assert.deepEqual(
    teams.map((t) => t.id).sort(),
    [U_A, U_B].sort(),
    'both persisted team UUIDs preserved — no new UUIDs for existing teams'
  );
  const raptors = teams.find((t) => t.id === U_A);
  assert.equal(raptors.coachId, 'coach-1', 'coach preserved');
  // p1 was manual → locked in review mode → never moved.
  assert.ok(raptors.players.some((p) => p.id === 'p1'));
  const diag = result.changeDiagnosticsByDivision.U10;
  assert.equal(diag.existingTeamsPreserved, 2);
  assert.equal(diag.droppedPlayersRemoved, 1, 'p4 dropped');
  assert.ok(diag.lockedAssignmentsPreserved >= 1, 'manual p1 locked in review');
});

test('integration: the review snapshot of a re-run is a full authoritative payload with kept UUIDs', () => {
  const existingSnapshot = buildExistingSnapshotForRerun(persistedSnapshot(), {
    divisionKey: 'U10',
  });
  const result = generateTeams({
    players: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'late-1'].map((id) => ({ id, division: 'U10' })),
    divisionConfigs: { U10: { id: 'U10', teamsCount: 2, slotsPerWeek: 4, maxRosterSize: 4 } },
    random: createDeterministicRandom(),
    existingSnapshot,
    generationMode: 'review',
  });

  let counter = 0;
  const review = buildTeamReviewSnapshot({
    generatedResult: result,
    divisionKey: 'U10',
    divisionId: '33333333-3333-4333-8333-333333333333',
    organizationId: '44444444-4444-4444-8444-444444444444',
    seasonSettingsId: MOCK_SEASON_ID,
    userId: 'user-1',
    selectedProgramId: 'U10',
    divisionConfig: { id: 'U10', maxRosterSize: 4 },
    nowIso: '2026-06-10T00:00:00Z',
    runId: 'run-next',
    idFactory: () => `generated-uuid-${++counter}`,
  });

  // Existing persisted teams keep their UUIDs; no idFactory call for them.
  const teamIds = review.payload.teamRows.map((row) => row.id);
  assert.ok(
    teamIds.includes(U_A) && teamIds.includes(U_B),
    'persisted UUIDs survive the review build'
  );
  assert.equal(counter, 0, 'no new UUIDs minted for preserved teams');

  // Authoritative: every team in the result is present in the payload, and every player on a
  // persisted team is a row (so the upsert reasserts the full roster).
  assert.equal(review.payload.teamRows.length, result.teamsByDivision.U10.length);
  const playersInResult = result.teamsByDivision.U10.reduce((n, t) => n + t.players.length, 0);
  assert.equal(review.payload.teamPlayerRows.length, playersInResult);
  // The manual flag round-trips to the persisted row source.
  const p1Row = review.payload.teamPlayerRows.find((r) => r.player_id === 'p1');
  assert.equal(p1Row.source, 'manual');
});

test('reconcileTeamDeltas consumes the rerun snapshot directly (no remap needed)', () => {
  const existingSnapshot = buildExistingSnapshotForRerun(persistedSnapshot(), {
    divisionKey: 'U10',
  });
  const reconciliation = reconcileTeamDeltas({
    players: ['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({ id, division: 'U10' })),
    existingSnapshot,
    generationMode: 'review',
  });
  // p6 dropped from Sharks; shells preserved under their UUIDs.
  assert.ok(reconciliation.preservedTeamsByDivision.U10.some((t) => t.id === U_A));
  assert.deepEqual(reconciliation.droppedPlayersByDivision.U10, ['p6']);
});
