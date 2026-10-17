/**
 * End-to-end persistence round-trip for snapshot-aware re-runs (teaming follow-ups PR):
 * fresh generation → review snapshot → persist → reload (as useTeamPersistence shapes it)
 * → re-run → persist again — against a faithful in-memory simulation of the
 * `persist_team_schedule` RPC contract (per-submitted-team roster REPLACE + the
 * `teams.assistant_coach_ids` COALESCE-on-absent semantics added in
 * 20260610000000_teaming_rerun_followups.sql). Mirrors the SQL so a future RPC change
 * that breaks the loop fails here first.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateTeams } from '../packages/core/src/teamGeneration.js';
import {
  buildExistingSnapshotForRerun,
  buildTeamReviewSnapshot,
} from '../frontend/src/utils/teamReviewPersistence.js';
import {
  buildPayloadByDivision,
  selectLatestTeamRunsPerDivision,
} from '../frontend/src/utils/schedulerRunFilters.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { createDeterministicRandom } from './fixtures/incrementalTeamingFixtures.js';
import { MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

const DIVISION_KEY = 'U10';
const DIVISION_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '44444444-4444-4444-8444-444444444444';
const U10_CONFIG = { id: DIVISION_KEY, teamsCount: 2, slotsPerWeek: 4, maxRosterSize: 4 };

/** In-memory relational state mirroring the tables the RPC touches. */
function createDb() {
  return { scheduler_runs: [], teams: [], team_players: [], coaches: [] };
}

/**
 * Faithful simulation of `persist_team_schedule` (migration 20260610000000):
 * 1. scheduler_runs upsert by id.
 * 2. teams upsert by id; `assistant_coach_ids` is sanitized to a deduped string array when the
 *    payload carries the key, and PRESERVES the existing value when the key is absent (the SQL
 *    `COALESCE(EXCLUDED.assistant_coach_ids, teams.assistant_coach_ids)`).
 * 3. team_players REPLACE per submitted team: memberships absent from the incoming rows are
 *    DELETEd, the rest upserted. Teams absent from the payload are untouched.
 */
function simulatePersistTeamSchedule(db, { runData, teams, teamPlayers }) {
  const existingRun = db.scheduler_runs.find((run) => run.id === runData.id);
  const runRow = {
    id: runData.id,
    organization_id: runData.organizationId,
    season_settings_id: runData.seasonSettingsId ?? null,
    run_type: 'team',
    status: runData.status,
    parameters: runData.parameters ?? {},
    metrics: runData.metrics ?? {},
    results: runData.results ?? {},
    created_at: runData.createdAt,
  };
  if (existingRun) Object.assign(existingRun, runRow);
  else db.scheduler_runs.push(runRow);

  for (const row of teams) {
    // Mirrors the SQL: a deduped uuid[] restricted to coaches that EXIST and
    // belong to the run org (the column grants portal/RLS access) — non-UUID
    // strings, unknown ids, and cross-org coaches are all dropped (they
    // round-trip via the results JSON only). Absent key → NULL → COALESCE
    // preserves the stored value.
    const isOrgCoach = (id) =>
      db.coaches.some((coach) => coach.id === id && coach.organization_id === ORG_ID);
    const sanitizedAssistants = Array.isArray(row.assistant_coach_ids)
      ? [
          ...new Set(
            row.assistant_coach_ids.filter(
              (value) =>
                typeof value === 'string' && UUIDISH.test(value.trim()) && isOrgCoach(value)
            )
          ),
        ]
      : null;
    const existing = db.teams.find((team) => team.id === row.id);
    if (existing) {
      existing.division_id = row.division_id;
      existing.name = row.name;
      existing.coach_id = row.coach_id ?? null;
      existing.assistant_coach_ids = sanitizedAssistants ?? existing.assistant_coach_ids ?? null;
    } else {
      db.teams.push({
        id: row.id,
        organization_id: row.organization_id,
        division_id: row.division_id,
        name: row.name,
        coach_id: row.coach_id ?? null,
        assistant_coach_ids: sanitizedAssistants,
      });
    }
  }

  const payloadTeamIds = new Set([
    ...teams.map((row) => row.id),
    ...teamPlayers.map((row) => row.team_id),
  ]);
  const incoming = new Set(teamPlayers.map((row) => `${row.team_id}|${row.player_id}`));
  db.team_players = db.team_players.filter(
    (row) => !payloadTeamIds.has(row.team_id) || incoming.has(`${row.team_id}|${row.player_id}`)
  );
  for (const row of teamPlayers) {
    const key = (item) => `${item.team_id}|${item.player_id}`;
    const existing = db.team_players.find((item) => key(item) === key(row));
    const source = row.source === 'manual' ? 'manual' : 'auto';
    if (existing) {
      existing.role = row.role ?? 'player';
      existing.source = source;
    } else {
      db.team_players.push({
        team_id: row.team_id,
        player_id: row.player_id,
        organization_id: ORG_ID,
        role: row.role ?? 'player',
        source,
      });
    }
  }
}

/** Persist a review snapshot exactly as the sync flow submits it. */
function persistReview(db, review, createdAt) {
  simulatePersistTeamSchedule(db, {
    runData: {
      id: review.lastRunId,
      organizationId: ORG_ID,
      seasonSettingsId: MOCK_SEASON_ID,
      status: 'needs_manual_review',
      parameters: review.runMetadata.parameters,
      metrics: review.runMetadata.metrics,
      results: review.runMetadata.results,
      createdAt,
    },
    teams: review.payload.teamRows,
    teamPlayers: review.payload.teamPlayerRows,
  });
}

/** Rebuild the persistenceSnapshot shape useTeamPersistence exposes from the simulated DB. */
function loadPersistenceSnapshot(db) {
  const runs = [...db.scheduler_runs].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const lastRun = runs[0];
  // The division map is seeded by the same shared mirror the mock client + hook use, so the test
  // exercises the real get_latest_team_runs_per_division contract (newest-per-division, empty runs
  // skipped) rather than a hand-copied second implementation.
  return {
    lastRunId: lastRun?.id ?? null,
    runHistory: runs.map((run) => ({ runId: run.id, status: run.status })),
    runMetadata: lastRun ? { results: lastRun.results } : {},
    payload: {
      teamRows: lastRun?.results?.teams || [],
      teamPlayerRows: lastRun?.results?.team_players || [],
    },
    payloadByDivision: buildPayloadByDivision(selectLatestTeamRunsPerDivision(db.scheduler_runs)),
  };
}

function generate(players, existingSnapshot = null) {
  return generateTeams({
    players,
    divisionConfigs: { [DIVISION_KEY]: U10_CONFIG },
    random: createDeterministicRandom(),
    existingSnapshot,
    generationMode: existingSnapshot ? 'review' : 'draft',
  });
}

function buildReview(result, runId, idFactory) {
  return buildTeamReviewSnapshot({
    generatedResult: result,
    divisionKey: DIVISION_KEY,
    divisionId: DIVISION_ID,
    organizationId: ORG_ID,
    seasonSettingsId: MOCK_SEASON_ID,
    userId: 'user-1',
    selectedProgramId: DIVISION_KEY,
    divisionConfig: { id: DIVISION_KEY, maxRosterSize: 4 },
    nowIso: '2026-06-10T00:00:00Z',
    runId,
    idFactory,
  });
}

const ASSISTANT_UUID = 'a51c0ac4-0000-4000-8000-0000000000a1';

const FRESH_ROSTER = [
  { id: 'p1', division: DIVISION_KEY, coachId: 'coach-1' },
  { id: 'p2', division: DIVISION_KEY, assistantCoachId: ASSISTANT_UUID },
  { id: 'p3', division: DIVISION_KEY },
  { id: 'p4', division: DIVISION_KEY },
  { id: 'p5', division: DIVISION_KEY },
  { id: 'p6', division: DIVISION_KEY },
];

test('full round-trip: persist → reload → re-run preserves UUIDs/locks/assistants and deletes dropped rows', () => {
  const db = createDb();
  db.coaches.push({ id: ASSISTANT_UUID, organization_id: ORG_ID });

  // --- First pass: fresh generation, manual move, persist. ---
  const fresh = generate(FRESH_ROSTER);
  // An admin manually moves p4 (mark it manual the way RosterManager does).
  for (const team of fresh.teamsByDivision[DIVISION_KEY]) {
    for (const player of team.players) {
      if (player.id === 'p4') /** @type {any} */ (player).assignment_source = 'manual';
    }
  }
  let minted = 0;
  const firstReview = buildReview(fresh, 'run-1', () => {
    minted += 1;
    return `aaaaaaa${minted}-0000-4000-8000-00000000000${minted}`;
  });
  assert.equal(minted, 2, 'fresh teams mint persisted UUIDs');
  persistReview(db, firstReview, '2026-06-10T01:00:00Z');

  const coachedRow = db.teams.find((team) => Array.isArray(team.assistant_coach_ids));
  assert.ok(coachedRow, 'assistant ids landed on the relational teams row');
  assert.deepEqual(coachedRow.assistant_coach_ids, [ASSISTANT_UUID]);
  assert.equal(db.team_players.length, 6, 'all six players have relational rows');

  // --- Division-key contract: the persisted division value is exactly the selectedProgram key
  // the rerun filter uses, on both the relational-ish teamRows and the inline results.teams.
  for (const row of firstReview.payload.teamRows) assert.equal(row.division, DIVISION_KEY);
  for (const team of firstReview.runMetadata.results.teams) {
    assert.equal(team.division, DIVISION_KEY);
  }

  // --- Second pass: reload exactly as the hook does, then re-run with p3 dropped + late-1 added. ---
  const reloaded = loadPersistenceSnapshot(db);
  const existingSnapshot = buildExistingSnapshotForRerun(reloaded, { divisionKey: DIVISION_KEY });
  assert.ok(existingSnapshot, 'the persisted run is found for the division');

  const rerun = generate(
    [
      { id: 'p1', division: DIVISION_KEY, coachId: 'coach-1' },
      { id: 'p2', division: DIVISION_KEY, assistantCoachId: ASSISTANT_UUID },
      { id: 'p4', division: DIVISION_KEY },
      { id: 'p5', division: DIVISION_KEY },
      { id: 'p6', division: DIVISION_KEY },
      { id: 'late-1', division: DIVISION_KEY },
    ],
    existingSnapshot
  );

  const firstIds = firstReview.payload.teamRows.map((row) => row.id).sort();
  assert.deepEqual(
    rerun.teamsByDivision[DIVISION_KEY].map((team) => team.id).sort(),
    firstIds,
    're-run preserves both persisted team UUIDs'
  );
  const manualTeam = rerun.teamsByDivision[DIVISION_KEY].find((team) =>
    team.players.some((player) => player.id === 'p4')
  );
  assert.ok(manualTeam, 'manual player still seated');
  const p4 = /** @type {any} */ (manualTeam.players.find((player) => player.id === 'p4'));
  assert.equal(p4.assignment_source, 'manual', 'manual flag survived the DB round-trip');
  assert.equal(p4.locked, true, 'manual assignment locked in review mode');
  const rerunAssistants = rerun.teamsByDivision[DIVISION_KEY].flatMap(
    (team) => team.assistantCoachIds
  );
  assert.deepEqual(rerunAssistants, [ASSISTANT_UUID], 'assistant survived the DB round-trip');

  // --- Persist the re-run: dropped p3's relational row must be DELETEd (per-team replace). ---
  let rerunMinted = 0;
  const secondReview = buildReview(rerun, 'run-2', () => {
    rerunMinted += 1;
    return `bbbbbbb${rerunMinted}-0000-4000-8000-00000000000${rerunMinted}`;
  });
  assert.equal(rerunMinted, 0, 'no new UUIDs minted for preserved teams');
  persistReview(db, secondReview, '2026-06-10T02:00:00Z');

  assert.ok(
    !db.team_players.some((row) => row.player_id === 'p3'),
    "dropped p3's relational row is deleted by the per-team replace"
  );
  assert.ok(
    db.team_players.some((row) => row.player_id === 'late-1'),
    'the late player gained a relational row'
  );
  const manualRow = db.team_players.find((row) => row.player_id === 'p4');
  assert.equal(manualRow.source, 'manual', 'manual source re-asserted relationally');
  assert.deepEqual(
    [...new Set(db.teams.map((team) => team.id))].sort(),
    firstIds,
    'no extra relational team rows appeared'
  );
});

test('a payload that omits assistant_coach_ids preserves the stored value (old-client safety)', () => {
  const db = createDb();
  db.coaches.push({ id: ASSISTANT_UUID, organization_id: ORG_ID });
  const fresh = generate(FRESH_ROSTER);
  const review = buildReview(fresh, 'run-1', () => randomUUID());
  persistReview(db, review, '2026-06-10T01:00:00Z');
  const before = db.teams.find((team) => Array.isArray(team.assistant_coach_ids));
  assert.deepEqual(before.assistant_coach_ids, [ASSISTANT_UUID]);

  // An older client re-persists the same teams WITHOUT the new key.
  simulatePersistTeamSchedule(db, {
    runData: {
      id: 'run-old-client',
      organizationId: ORG_ID,
      status: 'completed',
      results: review.runMetadata.results,
      createdAt: '2026-06-10T02:00:00Z',
    },
    teams: review.payload.teamRows.map(({ assistant_coach_ids: _omitted, ...row }) => row),
    teamPlayers: review.payload.teamPlayerRows,
  });

  const after = db.teams.find((team) => team.id === before.id);
  assert.deepEqual(
    after.assistant_coach_ids,
    [ASSISTANT_UUID],
    'COALESCE-on-absent keeps the assistant list intact'
  );
});

test('a non-UUID assistant id is excluded relationally but still round-trips via the results JSON', () => {
  const db = createDb();
  const fresh = generate([
    { id: 'p1', division: DIVISION_KEY, coachId: 'coach-1' },
    { id: 'p2', division: DIVISION_KEY, assistantCoachId: 'asst-import-7' }, // import-era id
    { id: 'p3', division: DIVISION_KEY },
    { id: 'p4', division: DIVISION_KEY },
  ]);
  const review = buildReview(fresh, 'run-1', () => randomUUID());
  // The relational row carries only UUID assistants (coach_id convention)…
  for (const row of review.payload.teamRows) {
    assert.deepEqual(row.assistant_coach_ids, [], 'non-UUID assistant filtered from the uuid[]');
  }
  // …but the inline results JSON keeps the full list, which is what re-runs read.
  persistReview(db, review, '2026-06-10T01:00:00Z');
  const reloaded = loadPersistenceSnapshot(db);
  const snapshot = buildExistingSnapshotForRerun(reloaded, { divisionKey: DIVISION_KEY });
  const assistants = snapshot.teamsByDivision[DIVISION_KEY].flatMap(
    (team) => team.assistantCoachIds
  );
  assert.deepEqual(assistants, ['asst-import-7'], 'JSON round-trip preserves the non-UUID id');
});

test('cross-org and unknown assistant ids never land in the access-granting column', () => {
  const db = createDb();
  const CROSS_ORG_COACH = 'c4055046-0000-4000-8000-0000000000c1';
  const UNKNOWN_UUID = 'de2d0000-0000-4000-8000-0000000000d1';
  db.coaches.push({ id: ASSISTANT_UUID, organization_id: ORG_ID });
  db.coaches.push({ id: CROSS_ORG_COACH, organization_id: 'some-other-org' });

  const fresh = generate(FRESH_ROSTER);
  const review = buildReview(fresh, 'run-1', () => randomUUID());
  // A hostile/buggy payload injects a foreign coach and an unknown uuid alongside the real one.
  for (const row of review.payload.teamRows) {
    if (row.assistant_coach_ids.length > 0) {
      row.assistant_coach_ids = [ASSISTANT_UUID, CROSS_ORG_COACH, UNKNOWN_UUID];
    }
  }
  persistReview(db, review, '2026-06-10T01:00:00Z');

  const stored = db.teams.find((team) => (team.assistant_coach_ids ?? []).length > 0);
  assert.deepEqual(
    stored.assistant_coach_ids,
    [ASSISTANT_UUID],
    'only the same-org existing coach survives — assistant_coach_ids grants portal/RLS access'
  );
});

test('an empty newer run does not shadow the older completed snapshot for its division', () => {
  const db = createDb();
  db.coaches.push({ id: ASSISTANT_UUID, organization_id: ORG_ID });
  const fresh = generate(FRESH_ROSTER);
  const review = buildReview(fresh, 'run-u10', () => randomUUID());
  persistReview(db, review, '2026-06-10T01:00:00Z');

  // A newer failed/queued U10 attempt persists a run row with NO teams.
  simulatePersistTeamSchedule(db, {
    runData: {
      id: 'run-u10-failed',
      organizationId: ORG_ID,
      status: 'failed',
      parameters: { selectedProgramId: DIVISION_KEY },
      results: {},
      createdAt: '2026-06-10T02:00:00Z',
    },
    teams: [],
    teamPlayers: [],
  });

  const reloaded = loadPersistenceSnapshot(db);
  const snapshot = buildExistingSnapshotForRerun(reloaded, { divisionKey: DIVISION_KEY });
  assert.ok(snapshot, 'the older completed snapshot is still found');
  assert.equal(snapshot.teamsByDivision[DIVISION_KEY].length, 2, 'both teams preserved');
});

test('payloadByDivision from newest-per-division runs spans divisions beyond the recent window', () => {
  const db = createDb();
  const fresh = generate(FRESH_ROSTER);
  const review = buildReview(fresh, 'run-u10', () => randomUUID());
  persistReview(db, review, '2026-06-10T01:00:00Z');

  // Bury the U10 run under many newer U12 runs (more than any bounded window).
  for (let i = 0; i < 25; i += 1) {
    simulatePersistTeamSchedule(db, {
      runData: {
        id: `run-u12-${i}`,
        organizationId: ORG_ID,
        status: 'completed',
        parameters: { selectedProgramId: 'U12' },
        results: { teams: [{ id: randomUUID(), division: 'U12', players: [] }] },
        createdAt: `2026-06-11T0${Math.floor(i / 10)}:${String(i % 10)}0:00Z`,
      },
      teams: [],
      teamPlayers: [],
    });
  }

  const reloaded = loadPersistenceSnapshot(db);
  assert.equal(
    reloaded.payload.teamRows[0]?.division,
    'U12',
    'the single-run payload only sees the newest division'
  );
  const u10Snapshot = buildExistingSnapshotForRerun(reloaded, { divisionKey: DIVISION_KEY });
  assert.ok(
    u10Snapshot,
    'U10 is still preservable via the newest-per-division map despite 25 newer U12 runs'
  );
  assert.equal(
    u10Snapshot.teamsByDivision[DIVISION_KEY].length,
    2,
    'both persisted U10 teams found'
  );
});

test('generationSummary is persisted in run metrics with the per-division changes', () => {
  const fresh = generate(FRESH_ROSTER);
  const review = buildReview(fresh, 'run-1', () => randomUUID());
  const summary = review.runMetadata.metrics.generationSummary;
  assert.ok(summary, 'review snapshot carries the structured generation summary');
  const division = summary.divisions.find((entry) => entry.divisionId === DIVISION_KEY);
  assert.ok(division, 'summary is keyed by the same division key');
  assert.equal(division.totalTeams, 2);

  // Incremental run: the summary carries the change diagnostics too.
  const existingSnapshot = buildExistingSnapshotForRerun(
    {
      lastRunId: 'run-1',
      runHistory: [{ status: 'review' }],
      payload: {
        teamRows: review.runMetadata.results.teams,
        teamPlayerRows: review.runMetadata.results.team_players,
      },
    },
    { divisionKey: DIVISION_KEY }
  );
  const rerun = generate(
    FRESH_ROSTER.map((player) => ({ ...player })),
    existingSnapshot
  );
  const rerunReview = buildReview(rerun, 'run-2', () => randomUUID());
  const rerunSummary = rerunReview.runMetadata.metrics.generationSummary;
  const rerunDivision = rerunSummary.divisions.find((entry) => entry.divisionId === DIVISION_KEY);
  assert.ok(rerunDivision.changes, 'incremental summary carries per-division changes');
  assert.equal(rerunDivision.changes.existingTeamsPreserved, 2);
});
