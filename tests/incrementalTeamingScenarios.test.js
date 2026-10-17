/**
 * Consolidated end-to-end regression scenarios for snapshot-aware incremental teaming
 * (project-hardening PR 09). Each test is one admin-facing scenario from the PR 09 plan, exercised
 * through the public surface: core `generateTeams` and the frontend review-snapshot round-trip
 * (`buildExistingSnapshotForRerun` → `generateTeams` → `buildTeamReviewSnapshot`). These are
 * intentionally narrative/acceptance-style; finer-grained units live in teamGenerationIncremental /
 * coachContinuity / existingSnapshotRerun / changeDiagnostics tests.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import {
  buildExistingSnapshotForRerun,
  buildTeamReviewSnapshot,
} from '../frontend/src/utils/teamReviewPersistence.js';
import { createDeterministicRandom } from './fixtures/incrementalTeamingFixtures.js';
import { MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const U10 = { id: 'U10', teamsCount: 3, slotsPerWeek: 4, maxRosterSize: 4 };
const NINE = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];

/** Build U10 generator players, applying per-id field overrides (e.g. a coach or buddy reference). */
function rosterWithOverrides(ids, overrides = {}) {
  return ids.map((id) => ({ id, division: 'U10', ...(overrides[id] || {}) }));
}

/** Published 3-team U10 snapshot (UUID-style ids); team 1 carries a coach + assistant. */
function publishedThreeTeams() {
  return {
    status: 'published',
    runId: 'run-prev',
    teamsByDivision: {
      U10: [
        {
          id: 'uuid-1',
          name: 'Raptors',
          division: 'U10',
          coachId: 'coach-1',
          assistantCoachIds: ['asst-1'],
          players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
        },
        {
          id: 'uuid-2',
          name: 'Sharks',
          division: 'U10',
          players: [{ id: 'p4' }, { id: 'p5' }, { id: 'p6' }],
        },
        {
          id: 'uuid-3',
          name: 'Wolves',
          division: 'U10',
          players: [{ id: 'p7' }, { id: 'p8' }, { id: 'p9' }],
        },
      ],
    },
  };
}

test('1. published 3-team division: a player drops and the team count stays at 3', () => {
  const result = generateTeams({
    players: rosterWithOverrides(
      NINE.filter((id) => id !== 'p5'),
      { p1: { coachId: 'coach-1' } }
    ),
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
    existingSnapshot: publishedThreeTeams(),
    generationMode: 'published',
  });

  const teams = result.teamsByDivision.U10;
  assert.equal(teams.length, 3, 'no team collapses after a drop');
  assert.deepEqual(
    teams.map((t) => t.id),
    ['uuid-1', 'uuid-2', 'uuid-3'],
    'team UUIDs preserved'
  );
  const diag = result.changeDiagnosticsByDivision.U10;
  assert.equal(diag.teamCountPolicy, 'preserve-existing', 'published default keeps the count');
  assert.equal(diag.existingTeamsPreserved, 3);
  assert.equal(diag.newTeamsCreated, 0);
  assert.equal(diag.droppedPlayersRemoved, 1);
});

test('2. reviewed teams with a manual move: a late player is seated and the manual lock is untouched', () => {
  const snapshot = publishedThreeTeams();
  snapshot.status = 'review';
  // An admin manually placed p3 on Raptors.
  snapshot.teamsByDivision.U10[0].players = [
    { id: 'p1' },
    { id: 'p2' },
    { id: 'p3', assignment_source: 'manual' },
  ];

  const result = generateTeams({
    players: rosterWithOverrides([...NINE, 'late-1'], { p1: { coachId: 'coach-1' } }),
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
    existingSnapshot: snapshot,
    generationMode: 'review',
  });

  const raptors = result.teamsByDivision.U10.find((t) => t.id === 'uuid-1');
  assert.ok(raptors, 'Raptors (uuid-1) is present in the result');
  const p3 = /** @type {any} */ (raptors.players.find((p) => p.id === 'p3'));
  assert.ok(p3, 'the manual player stays on its team — never reshuffled');
  assert.equal(p3.assignment_source, 'manual');
  assert.equal(p3.locked, true, 'manual assignment is locked in review mode');
  // No reshuffle: the other preserved players are still on Raptors too — not just p3.
  assert.deepEqual(
    raptors.players
      .map((p) => p.id)
      .filter((id) => ['p1', 'p2', 'p3'].includes(id))
      .sort(),
    ['p1', 'p2', 'p3'],
    'every preserved Raptors player stays put'
  );

  const lateTeam = result.teamsByDivision.U10.find((t) => t.players.some((p) => p.id === 'late-1'));
  assert.ok(lateTeam, 'the late player is seated');
  const diag = result.changeDiagnosticsByDivision.U10;
  assert.equal(diag.latePlayersAssigned, 1);
  assert.ok(diag.manualAssignmentsPreserved >= 1, 'manual assignment counted as preserved');
  assert.ok(diag.lockedAssignmentsPreserved >= 1, 'manual assignment counted as locked');
});

test("3. a late player with a mutual buddy request to a locked player joins the buddy's team when capacity allows", () => {
  const snapshot = publishedThreeTeams();
  snapshot.status = 'review';
  // p4 on Sharks (3/4, open capacity) is a manual assignment → locked in review.
  snapshot.teamsByDivision.U10[1].players = [
    { id: 'p4', assignment_source: 'manual' },
    { id: 'p5' },
    { id: 'p6' },
  ];

  const result = generateTeams({
    players: [
      ...rosterWithOverrides(NINE, { p1: { coachId: 'coach-1' }, p4: { buddyId: 'newbie' } }),
      { id: 'newbie', division: 'U10', buddyId: 'p4' }, // mutual request with the locked p4
    ],
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
    existingSnapshot: snapshot,
    generationMode: 'review',
  });

  const sharks = result.teamsByDivision.U10.find((t) => t.id === 'uuid-2');
  assert.ok(sharks, 'Sharks (uuid-2) is present in the result');
  assert.ok(
    sharks.players.some((p) => p.id === 'newbie'),
    "late buddy lands on the locked player's team"
  );
  const p4 = /** @type {any} */ (sharks.players.find((p) => p.id === 'p4'));
  assert.ok(p4, 'the locked buddy p4 is still on Sharks');
  assert.equal(p4.locked, true, 'the locked buddy itself is never moved');
  assert.deepEqual(result.changeDiagnosticsByDivision.U10.buddyTargetAssignments, [
    { playerId: 'newbie', buddyId: 'p4', teamId: 'uuid-2' },
  ]);
  assert.deepEqual(result.overflowByDivision.U10, [], 'no overflow when the target team has room');
});

test('4. the same late buddy overflows with a clear reason when the buddy team is full (no reshuffle)', () => {
  const snapshot = publishedThreeTeams();
  snapshot.status = 'review';
  // Sharks is now full (4/4).
  snapshot.teamsByDivision.U10[1].players = [
    { id: 'p4', assignment_source: 'manual' },
    { id: 'p5' },
    { id: 'p6' },
    { id: 'p10' },
  ];

  const result = generateTeams({
    players: [
      ...rosterWithOverrides([...NINE, 'p10'], {
        p1: { coachId: 'coach-1' },
        p4: { buddyId: 'newbie' },
      }),
      { id: 'newbie', division: 'U10', buddyId: 'p4' },
    ],
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
    existingSnapshot: snapshot,
    generationMode: 'review',
  });

  const overflow = result.overflowByDivision.U10;
  assert.equal(overflow.length, 1, 'the late buddy overflows rather than reshuffling a full team');
  assert.equal(overflow[0].reason, 'buddy-target-capacity');
  assert.deepEqual(
    overflow[0].players.map((p) => p.id),
    ['newbie']
  );
  assert.equal(overflow[0].metadata.targetTeamId, 'uuid-2', 'overflow names the intended team');
});

test('5. a head coach drops: the roster is preserved and the team is marked coach-needed', () => {
  const result = generateTeams({
    players: rosterWithOverrides(['p1', 'p2']),
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
    existingSnapshot: {
      status: 'published',
      teamsByDivision: {
        U10: [
          {
            id: 'uuid-1',
            division: 'U10',
            coachId: 'coach-gone',
            players: [{ id: 'p1' }, { id: 'p2' }],
          },
        ],
      },
    },
    generationMode: 'published',
  });

  const team = result.teamsByDivision.U10[0];
  assert.deepEqual(
    team.players.map((p) => p.id).sort(),
    ['p1', 'p2'],
    'roster untouched by the coach drop'
  );
  assert.equal(team.coachId, null, 'inactive coach cleared');
  assert.equal(team.coachNeeded, true, 'team flagged coach-needed');
  assert.deepEqual(result.changeDiagnosticsByDivision.U10.coachDrops, [
    { teamId: 'uuid-1', coachId: 'coach-gone' },
  ]);
});

test('6. a late coach whose child is already on a coachless team attaches to that team', () => {
  const result = generateTeams({
    players: [
      { id: 'p1', division: 'U10', coachId: 'new-coach' }, // the parent now volunteers
      { id: 'p2', division: 'U10' },
    ],
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
    existingSnapshot: {
      status: 'published',
      teamsByDivision: {
        U10: [{ id: 'uuid-1', division: 'U10', players: [{ id: 'p1' }, { id: 'p2' }] }],
      },
    },
    generationMode: 'published',
  });

  const team = result.teamsByDivision.U10[0];
  assert.equal(team.coachId, 'new-coach', 'the late coach attaches to their child’s team');
  assert.equal(team.coachNeeded, false);
  assert.deepEqual(result.changeDiagnosticsByDivision.U10.coachReplacements, [
    { teamId: 'uuid-1', fromCoachId: null, toCoachId: 'new-coach' },
  ]);
});

test('7. an assistant-only registration backfills an existing team instead of creating a ghost shell', () => {
  const result = generateTeams({
    players: [
      { id: 'p1', division: 'U10', coachId: 'coach-1' },
      { id: 'p2', division: 'U10' },
      { id: 'late-kid', division: 'U10', assistantCoachId: 'asst-9' },
    ],
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
    existingSnapshot: {
      status: 'published',
      teamsByDivision: {
        U10: [
          {
            id: 'uuid-1',
            division: 'U10',
            coachId: 'coach-1',
            players: [{ id: 'p1' }, { id: 'p2' }],
          },
        ],
      },
    },
    generationMode: 'published',
  });

  const teams = result.teamsByDivision.U10;
  assert.equal(teams.length, 1, 'no ghost shell is created for an assistant-only unit');
  assert.ok(
    teams[0].players.some((p) => p.id === 'late-kid'),
    'the assistant’s child joins the team'
  );
  assert.deepEqual(teams[0].assistantCoachIds, ['asst-9']);
  assert.deepEqual(result.changeDiagnosticsByDivision.U10.assistantBackfills, [
    { teamId: 'uuid-1', assistantCoachIds: ['asst-9'] },
  ]);
});

test('8. the frontend review snapshot preserves persisted UUIDs and emits a full authoritative payload', () => {
  const U_A = '11111111-1111-4111-8111-111111111111';
  const U_B = '22222222-2222-4222-8222-222222222222';
  const persisted = {
    lastRunId: 'run-prev',
    runHistory: [{ status: 'review' }],
    payload: {
      teamRows: [
        { id: U_A, division: 'U10', coachId: 'coach-1', players: [{ id: 'p1' }, { id: 'p2' }] },
        { id: U_B, division: 'U10', players: [{ id: 'p3' }, { id: 'p4' }] },
      ],
      teamPlayerRows: [
        { team_id: U_A, player_id: 'p1', role: 'player', source: 'manual' },
        { team_id: U_A, player_id: 'p2', role: 'player', source: 'auto' },
        { team_id: U_B, player_id: 'p3', role: 'player', source: 'auto' },
        { team_id: U_B, player_id: 'p4', role: 'player', source: 'auto' },
      ],
    },
  };

  const existingSnapshot = buildExistingSnapshotForRerun(persisted, { divisionKey: 'U10' });
  const result = generateTeams({
    players: [
      { id: 'p1', division: 'U10', coachId: 'coach-1' },
      ...rosterWithOverrides(['p2', 'p3', 'p4', 'late-1']),
    ],
    divisionConfigs: { U10: { id: 'U10', teamsCount: 2, slotsPerWeek: 4, maxRosterSize: 4 } },
    random: createDeterministicRandom(),
    existingSnapshot,
    generationMode: 'review',
  });

  let minted = 0;
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
    idFactory: () => `minted-${++minted}`,
  });

  const persistedIds = review.payload.teamRows.map((r) => r.id);
  assert.ok(
    persistedIds.includes(U_A) && persistedIds.includes(U_B),
    'persisted UUIDs survive the review build'
  );
  assert.equal(minted, 0, 'no new UUIDs minted for preserved teams');

  // Authoritative payload: every team and every player on it is a row (so the UPSERT reasserts the
  // full roster and can never strand a preserved assignment).
  assert.equal(review.payload.teamRows.length, result.teamsByDivision.U10.length);
  const totalPlayers = result.teamsByDivision.U10.reduce((n, t) => n + t.players.length, 0);
  assert.equal(review.payload.teamPlayerRows.length, totalPlayers);
  const p1Row = review.payload.teamPlayerRows.find((r) => r.player_id === 'p1');
  assert.ok(p1Row, 'p1 has a persisted player row');
  assert.equal(p1Row.source, 'manual', 'the manual flag round-trips to the persisted row source');
});

test('8b. an expanding re-run mints a UUID only for the new team and preserves the existing ones', () => {
  // Positive control complementing scenario 8: both persisted teams are full, so a late player
  // forces a NEW team — exercising the idFactory() branch (vs. the preserved-UUID branch) and
  // proving expansion does not re-mint the preserved teams.
  const U_A = '11111111-1111-4111-8111-111111111111';
  const U_B = '22222222-2222-4222-8222-222222222222';
  const persisted = {
    lastRunId: 'run-prev',
    runHistory: [{ status: 'review' }],
    payload: {
      teamRows: [
        {
          id: U_A,
          division: 'U10',
          players: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
        },
        {
          id: U_B,
          division: 'U10',
          players: [{ id: 'p5' }, { id: 'p6' }, { id: 'p7' }, { id: 'p8' }],
        },
      ],
      teamPlayerRows: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map((id, i) => ({
        team_id: i < 4 ? U_A : U_B,
        player_id: id,
        role: 'player',
        source: 'auto',
      })),
    },
  };

  const existingSnapshot = buildExistingSnapshotForRerun(persisted, { divisionKey: 'U10' });
  const result = generateTeams({
    players: rosterWithOverrides(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'late-1']),
    divisionConfigs: { U10: { id: 'U10', teamsCount: 2, slotsPerWeek: 4, maxRosterSize: 4 } },
    random: createDeterministicRandom(),
    existingSnapshot,
    generationMode: 'draft', // preserve-or-expand
  });
  assert.equal(
    result.teamsByDivision.U10.length,
    3,
    'the full teams force a third team for the late player'
  );

  let minted = 0;
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
    idFactory: () => `minted-${++minted}`,
  });

  assert.equal(minted, 1, 'exactly one UUID minted — for the new team only');
  const ids = review.payload.teamRows.map((r) => r.id);
  assert.ok(
    ids.includes(U_A) && ids.includes(U_B),
    'both existing UUIDs are preserved, not re-minted'
  );
  assert.ok(ids.includes('minted-1'), 'the newly created team carries the freshly minted id');
});

test('9. no-snapshot draft generation is byte-identical to the original fresh generator', () => {
  const roster = rosterWithOverrides(['a', 'b', 'c', 'd', 'e', 'f']);
  const fresh = generateTeams({
    players: roster,
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
  });
  const draft = generateTeams({
    players: roster,
    divisionConfigs: { U10 },
    random: createDeterministicRandom(),
    existingSnapshot: null,
    generationMode: 'draft',
    changePolicy: {},
  });

  assert.deepEqual(draft, fresh, 'the incremental params are inert without a snapshot');
  assert.ok(
    !('changeDiagnosticsByDivision' in draft),
    'fresh generation carries no incremental diagnostics for the UI to special-case'
  );
});
