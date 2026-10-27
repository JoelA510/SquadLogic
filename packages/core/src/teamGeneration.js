/**
 * Generate balanced teams for each division while honoring mutual buddy requests and coach assignments.
 *
 * Players can optionally provide a `buddyId` that references another player. When two players reference each
 * other they are treated as a single unit assignment. A player with a `coachId` must appear on that
 * coach's roster. The id comes from a `coach_team_requests` link (the coach import writes one for each
 * child it names: `linkCoachesToPlayers`, `prepareTeamingInput`), never from a coach an import row
 * names (owner decision 8a, 2026-10-27): the Teams page sets no `coachId` from a row.
 */

import { TEAM_GENERATION } from './constants.js';
import { PlayerSchema } from './schemas/index.js';
import { BuddyEvaluator, EVALUATOR_REGISTRY } from './evaluators/index.js';
import { buildAssignmentUnits, calculateUnitSkill } from './assignmentUnits.js';
import { reconcileTeamDeltas } from './teamDelta.js';
import { getCanonicalBuddyId } from './buddyLinking.js';
import { applyCoachContinuity } from './coachContinuity.js';
import { cannotBePlaced, isEligibilityBlocked, isWaitlisted } from './playUp.js';
import { balanceSignalKind, divisionLeadCompensation, playerSignal } from './balanceSignals.js';
import {
  compensatedLoad,
  countLeads,
  orderForLeadDeal,
  spreadsCoachingLeads,
  withFewestLeads,
} from './coachingLeads.js';

/** @typedef {import('./types.js').Player} Player */
/** @typedef {import('./types.js').Team} Team */
/** @typedef {import('./types.js').DivisionConfig} DivisionConfig */

/**
 * @param {Object} params
 * @param {Array<Player>} params.players - List of player records. Each record must include an `id` and `division`.
 * @param {Object<string, DivisionConfig>} params.divisionConfigs - Map of division identifiers.
 * @param {function(): number} [params.random=Math.random] - RNG returning [0, 1).
 * @param {string|number} [params.seed] - Optional seed for deterministic generation. Overrides random if provided.
 * @param {Object} [params.featureFlags={}] - Map of active feature flags for evaluating logic.
 * @param {boolean} [params.dryRun=false] - If true, evaluates without final assignment (Ghost Roster).
 * @param {Record<string, number>} [params.customWeights={}] - Optional weighting parameter for traits.
 * @param {any} [params.existingSnapshot=null] - Existing roster snapshot to preserve (see teamSnapshot.js).
 *   When null, generation is fully fresh and output is identical to previous releases.
 * @param {string} [params.generationMode='draft'] - 'draft' | 'review' | 'published' | 'locked'.
 * @param {{ teamCountPolicy?: string, allowOverCapAssignments?: boolean, lockManualAssignments?: boolean, divisionKeyById?: Record<string, string>, coachReplacementMap?: Record<string, string>, allowHouseholdCoachReplacement?: boolean, allowLateCoachAttachToChildTeam?: boolean, allowAssistantShellCreation?: boolean }} [params.changePolicy={}]
 *   - `teamCountPolicy`: 'auto' | 'preserve-existing' | 'preserve-or-expand' | 'preserve-with-overflow'.
 *     Defaults: no snapshot → 'auto'; snapshot + review/published/locked → 'preserve-existing';
 *     snapshot + draft → 'preserve-or-expand'.
 *   - `divisionKeyById`: maps persisted division_id (UUID) → generator division key, required when
 *     a relational snapshot's team rows carry only `division_id`.
 *   - Coach continuity (PR 06): `coachReplacementMap` ({oldId: newId}, explicit, always wins),
 *     `allowHouseholdCoachReplacement` (default false), `allowLateCoachAttachToChildTeam`
 *     (default true), `allowAssistantShellCreation` (default false — assistant-only late units
 *     backfill existing teams or place as general units instead of creating shells).
 *
 * Eligibility (Phase B2): a player whose `placement` is `play_up_blocked` or `play_down_blocked`
 * (`isEligibilityBlocked`, playUp.js) is never seated. They leave the pool before the team count
 * and coach anchors are computed and are in `overflowByDivision` with reason
 * `eligibility-blocked`, one entry per player, metadata `{ placement, reviewReason, naturalAge,
 * coachId }`; a mutual buddy is placed alone (`buddy-not-placed`). A blocked player already on a
 * preserved roster stays there and is listed in `changeDiagnosticsByDivision[div].eligibilityHolds`.
 *
 * Waitlist (owner, 2026-10-27): a player with `status: 'waitlist'` (`isWaitlisted`) is not seated
 * either; each is in overflow with reason `waitlisted`, metadata `{ coachId }`. The league-wide
 * averages (`globalStats`: org means and ranges) leave out every player who cannot be placed,
 * blocked or waitlisted.
 *
 * Coaching leads (Phase B6, `coachingLeads.js`): a player with `isCoachingLead` is not a coach
 * and anchors no team. Once coaches' children are placed, units holding a lead are dealt to a
 * team with the fewest leads, the most leads first, and every other unit to the team with the
 * lowest `signal total + c × leads` (the league's signal: `featureFlags.player_rating`, else
 * `years_played`). With neither, or when no player of the division carries the signal, `c` is 0
 * and the evaluators place what the lead spread leaves. With `featureFlags.teaming_spread_coaching_leads`
 * false, or no lead in the division, placement is exactly as before B6. On a rerun the same rule
 * places the late players; preserved players never move.
 * @returns {{
 *   teamsByDivision: Record<string, Array<Team>>,
 *   overflowByDivision: Record<string, Array<{ players: Array<Player>, reason: string, metadata?: Object }>>,
 *   overflowSummaryByDivision: Record<
 *     string,
 *     { totalUnits: number, totalPlayers: number, byReason: Record<string, { units: number, players: number }> }
 *   >,
 *   buddyDiagnosticsByDivision: Record<string, {
 *     mutualPairs: Array<{ playerIds: Array<string> }>,
 *     unmatchedRequests: Array<{ playerId: string, requestedBuddyId: string, reason: string }>,
 *   }>,
 *   coachCoverageByDivision: Record<string, {
 *     totalTeams: number,
 *     volunteerCoaches: number,
 *     teamsWithCoach: number,
 *     teamsWithoutCoach: number,
 *     coverageRate: number,
 *     needsAdditionalCoaches: boolean,
 *     additionalCoachesNeeded: number,
 *   }>,
 *   rosterBalanceByDivision: Record<string, {
 *     teamStats: Array<{
 *       teamId: string,
 *       coachId: string | null,
 *       playerCount: number,
 *       maxRosterSize: number,
 *       slotsRemaining: number,
 *       fillRate: number,
 *       minRosterSize?: number,
 *       needsPlayersToMin?: number,
 *     }>,
 *     summary: {
 *       totalPlayers: number,
 *       totalCapacity: number,
 *       averageFillRate: number,
 *       teamsNeedingPlayers: Array<string>,
 *       teamsBelowMinRoster?: Array<string>,
 *       minRosterSize?: number,
 *       teamCountConstraints?: {
 *         minTeams: number | null,
 *         maxTeams: number | null,
 *       },
 *     },
 *   }>,
 *   skillBalanceByDivision: Record<string, {
 *     teamStats: Array<{
 *       teamId: string,
 *       coachId: string | null,
 *       playerCount: number,
 *       skillTotal: number,
 *       averageSkill: number,
 *     }>,
 *     summary: {
 *       totalSkill: number,
 *       averageSkillPerPlayer: number,
 *       minAverageSkill: number,
 *       maxAverageSkill: number,
 *       spread: number,
 *     },
 *   }>,
 *   changeDiagnosticsByDivision?: Record<string, any>,
 *   snapshotDiagnostics?: Array<{ code: string, severity: string, message: string }>,
 *   evaluationResults?: any,
 * }}
 */
export function generateTeams({
  players,
  divisionConfigs,
  random = Math.random,
  seed,
  featureFlags = {},
  dryRun: _dryRun = false,
  customWeights = {},
  existingSnapshot = null,
  generationMode = 'draft',
  changePolicy = {},
}) {
  if (!Array.isArray(players)) {
    throw new TypeError('players must be an array');
  }
  if (typeof divisionConfigs !== 'object' || divisionConfigs === null) {
    throw new TypeError('divisionConfigs must be an object');
  }

  // If seed is provided, create a deterministic RNG
  if (seed !== undefined && seed !== null && seed !== '') {
    const seedNum = typeof seed === 'string' ? xmur3(seed)() : Number(seed);
    const prng = mulberry32(seedNum);
    random = prng;
  }

  if (typeof random !== 'function') {
    throw new TypeError('random must be a function');
  }

  // Snapshot-aware (incremental) generation setup. With no snapshot — or an explicit
  // teamCountPolicy of 'auto' — the fresh path below is used unchanged and no incremental
  // output keys are added.
  changePolicy = changePolicy ?? {};
  const teamCountPolicy = resolveTeamCountPolicy({
    existingSnapshot,
    generationMode,
    changePolicy,
  });
  const incrementalMode = existingSnapshot != null && teamCountPolicy !== 'auto';
  /** @type {Map<string, any> | null} */
  const playerCloneById = incrementalMode ? new Map() : null;

  const playersByDivision = new Map();
  const playerDivisions = new Map();
  for (const player of players) {
    PlayerSchema.parse(player);

    // Duplicate detection keys by the same normalized id used downstream (snapshot
    // reconciliation, persistence), so ids that collide after coercion (e.g. 42 vs '42')
    // are rejected instead of silently overwriting each other.
    const idKey = String(player.id).trim();
    const previousDivision = playerDivisions.get(idKey);
    if (previousDivision) {
      throw new Error(
        `duplicate player id detected: ${player.id} (divisions ${previousDivision} and ${player.division})`
      );
    }
    playerDivisions.set(idKey, player.division);

    const clone = structuredClone(player);
    const bucket = playersByDivision.get(player.division) ?? [];
    bucket.push(clone);
    playersByDivision.set(player.division, bucket);
    if (playerCloneById) {
      playerCloneById.set(idKey, clone);
    }
  }

  let reconciliation = null;
  /** @type {any} */
  const changeDiagnosticsByDivision = {};
  if (incrementalMode) {
    reconciliation = reconcileTeamDeltas({
      players,
      existingSnapshot,
      generationMode,
      changePolicy,
      divisionConfigs,
    });
    // Divisions present only in the snapshot must remain in the output (empty incoming bucket).
    for (const division of Object.keys(reconciliation.preservedTeamsByDivision)) {
      if (!playersByDivision.has(division)) {
        playersByDivision.set(division, []);
      }
    }
  }

  // Calculate globalStats (orgMeans and minMax) for weighted evaluation
  let globalStatsCount = 0;
  const orgMeansMap = {};
  const minMaxMap = {};

  for (const player of players) {
    // A player the generator cannot seat (blocked by eligibility, or waitlisted) is not part of
    // the league the averages describe (owner, 2026-10-27).
    if (cannotBePlaced(player)) continue;
    globalStatsCount++;

    // Base skill
    const skill =
      typeof player.skillRating === 'number'
        ? player.skillRating
        : player.custom_attributes?.skill_rating || 0;
    orgMeansMap['skill_rating'] = (orgMeansMap['skill_rating'] || 0) + Number(skill);
    minMaxMap['skill_rating'] = minMaxMap['skill_rating'] || {
      min: Number.MAX_VALUE,
      max: -Number.MAX_VALUE,
    };
    minMaxMap['skill_rating'].min = Math.min(minMaxMap['skill_rating'].min, Number(skill));
    minMaxMap['skill_rating'].max = Math.max(minMaxMap['skill_rating'].max, Number(skill));

    // Custom attributes
    const attrs = player.custom_attributes || {};
    for (const [key, val] of Object.entries(attrs)) {
      const numVal = Number(val);
      if (!isNaN(numVal)) {
        orgMeansMap[key] = (orgMeansMap[key] || 0) + numVal;
        minMaxMap[key] = minMaxMap[key] || { min: Number.MAX_VALUE, max: -Number.MAX_VALUE };
        minMaxMap[key].min = Math.min(minMaxMap[key].min, numVal);
        minMaxMap[key].max = Math.max(minMaxMap[key].max, numVal);
      }
    }
  }

  for (const key of Object.keys(orgMeansMap)) {
    orgMeansMap[key] = orgMeansMap[key] / globalStatsCount;
  }
  const globalStats = { orgMeans: orgMeansMap, minMax: minMaxMap };

  // Log custom weights applied for telemetry
  console.log(
    `[Teaming] Generating teams using weights:`,
    Object.keys(customWeights).length > 0 ? customWeights : { skill_rating: 1.0 }
  );

  /** @type {Record<string, Array<Team>>} */
  const results = {};
  /** @type {any} */
  const overflowByDivision = {};
  /** @type {any} */
  const overflowSummaryByDivision = {};
  /** @type {any} */
  const buddyDiagnosticsByDivision = {};
  /** @type {any} */
  const coachCoverageByDivision = {};
  /** @type {any} */
  const rosterBalanceByDivision = {};
  /** @type {any} */
  const skillBalanceByDivision = {};

  for (const [division, divisionPlayers] of playersByDivision.entries()) {
    const config = divisionConfigs[division];
    const structuralWarnings = [];

    // Incremental per-division inputs: preserved shells rehydrated with the full incoming
    // player objects, plus the late/unassigned players that still need placement.
    const divisionIncremental = incrementalMode
      ? {
          preservedTeams: rehydratePreservedTeams(
            reconciliation.preservedTeamsByDivision[division] ?? [],
            playerCloneById
          ),
          latePlayers: (reconciliation.unassignedPlayersByDivision[division] ?? [])
            .map((id) => playerCloneById.get(id))
            .filter(Boolean),
          teamCountPolicy,
          allowOverCapAssignments: changePolicy.allowOverCapAssignments === true,
          allowAssistantShellCreation: changePolicy.allowAssistantShellCreation === true,
        }
      : null;

    // Coach continuity: explicit replacements, dropped-coach clearing with evidence-based
    // household replacement, and late coaches attaching to their child's coachless team.
    // Skipped for snapshot-only divisions (no incoming players = no evidence; shells keep
    // their coach metadata intact rather than mass-reporting drops on a partial import).
    let coachContinuity = null;
    if (divisionIncremental && divisionPlayers.length > 0) {
      coachContinuity = applyCoachContinuity({
        teams: divisionIncremental.preservedTeams,
        divisionPlayers,
        changePolicy,
      });
      divisionIncremental.preservedTeams = coachContinuity.teams;
    }

    let effectiveConfig = config;
    let rosterConstraints;
    if (!config) {
      if (divisionIncremental && divisionPlayers.length === 0) {
        // Division exists only in the snapshot and has no division config: preserve the shells
        // with synthetic constraints instead of failing the whole run (rule: snapshot-only
        // divisions must remain in output).
        const largestRoster = Math.max(
          1,
          ...divisionIncremental.preservedTeams.map((team) => team.players.length)
        );
        rosterConstraints = { maxRosterSize: largestRoster };
        effectiveConfig = /** @type {any} */ ({ id: division, maxRosterSize: largestRoster });
        structuralWarnings.push(
          `division ${division} exists only in the snapshot and has no division config; preserved with synthetic maxRosterSize ${largestRoster}`
        );
      } else {
        throw new Error(`missing maxRosterSize for division ${division}`);
      }
    } else {
      rosterConstraints = normalizeDivisionRosterConstraints(config, division);
    }
    const maxRosterSize = rosterConstraints.maxRosterSize;
    if (maxRosterSize <= 0) {
      throw new Error(`maxRosterSize for division ${division} must be positive`);
    }

    // A division absent from the snapshot has nothing to preserve. Under 'preserve-or-expand'
    // it runs with full fresh semantics so structural config (minTeams, teamCountOverride,
    // coach pre-creation) is honored exactly as in fresh generation.
    const divisionUsesFreshPath =
      divisionIncremental != null &&
      divisionIncremental.preservedTeams.length === 0 &&
      teamCountPolicy === 'preserve-or-expand' &&
      divisionPlayers.length > 0;

    const { teams, overflow, buddyDiagnostics, incrementalStats } = buildTeamsForDivision({
      division,
      players: divisionPlayers,
      maxRosterSize,
      divisionConfig: effectiveConfig,
      rosterConstraints,
      random,
      featureFlags,
      customWeights,
      globalStats,
      incremental: divisionUsesFreshPath ? null : divisionIncremental,
    });

    results[division] = teams.map((team) => ({
      id: team.id,
      name: team.name,
      division: team.division,
      coachId: team.coachId,
      coachNeeded: !team.coachId || Boolean(team.coachInactive),
      // Round-trips the snapshot team lock so persistence does not silently drop it
      // (always false in fresh generation).
      locked: Boolean(team.locked),
      assistantCoachIds: team.assistantCoachIds ? [...team.assistantCoachIds] : [],
      skillTotal: team.skillTotal,
      players: team.players.map((player) => structuredClone(player)),
    }));
    overflowByDivision[division] = overflow.map((entry) => ({
      players: entry.players.map((player) => structuredClone(player)),
      reason: entry.reason,
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    }));
    overflowSummaryByDivision[division] = summarizeOverflow(overflow);
    buddyDiagnosticsByDivision[division] = {
      mutualPairs: buddyDiagnostics.mutualPairs.map((pair) => ({
        playerIds: [...pair.playerIds],
      })),
      unmatchedRequests: buddyDiagnostics.unmatchedRequests.map((entry) => ({
        playerId: entry.playerId,
        requestedBuddyId: entry.requestedBuddyId,
        reason: entry.reason,
      })),
    };

    // An inactive (dropped) coach on a locked team still counts as missing coverage.
    const uniqueCoachIds = new Set(
      teams
        .map((team) => (team.coachId && !team.coachInactive ? team.coachId : null))
        .filter(Boolean)
    );
    const teamsWithoutCoach = teams.filter((team) => !team.coachId || team.coachInactive).length;
    const teamsWithCoach = teams.length - teamsWithoutCoach;
    const coverageRate = teams.length > 0 ? Number((teamsWithCoach / teams.length).toFixed(4)) : 0;

    coachCoverageByDivision[division] = {
      totalTeams: teams.length,
      volunteerCoaches: uniqueCoachIds.size,
      teamsWithCoach,
      teamsWithoutCoach,
      coverageRate,
      needsAdditionalCoaches: teamsWithoutCoach > 0,
      additionalCoachesNeeded: teamsWithoutCoach,
    };

    const teamStats = teams.map((team) => {
      const playerCount = team.players.length;
      const slotsRemaining = Math.max(0, maxRosterSize - playerCount);
      const fillRate = Number((playerCount / maxRosterSize).toFixed(4));
      const minRosterSize = rosterConstraints.minRosterSize;

      return {
        teamId: team.id,
        coachId: team.coachId ?? null,
        playerCount,
        maxRosterSize,
        slotsRemaining,
        fillRate,
        ...(minRosterSize
          ? {
              minRosterSize,
              needsPlayersToMin: Math.max(0, minRosterSize - playerCount),
            }
          : {}),
      };
    });

    const totalPlayers = teamStats.reduce((sum, entry) => sum + entry.playerCount, 0);
    const totalCapacity = teamStats.reduce((sum, entry) => sum + entry.maxRosterSize, 0);
    const averageFillRate =
      totalCapacity > 0 ? Number((totalPlayers / totalCapacity).toFixed(4)) : 0;
    const teamsNeedingPlayers = teamStats
      .filter((entry) => entry.slotsRemaining > 0)
      .map((entry) => entry.teamId);
    const teamsBelowMinRoster = rosterConstraints.minRosterSize
      ? teamStats.filter((entry) => entry.needsPlayersToMin > 0).map((entry) => entry.teamId)
      : undefined;

    rosterBalanceByDivision[division] = {
      teamStats,
      summary: {
        totalPlayers,
        totalCapacity,
        averageFillRate,
        teamsNeedingPlayers,
        ...(teamsBelowMinRoster
          ? {
              teamsBelowMinRoster,
              minRosterSize: rosterConstraints.minRosterSize,
            }
          : {}),
        ...(rosterConstraints.minTeams || rosterConstraints.maxTeams
          ? {
              teamCountConstraints: {
                minTeams: rosterConstraints.minTeams ?? null,
                maxTeams: rosterConstraints.maxTeams ?? null,
              },
            }
          : {}),
      },
    };

    const skillStats = teams.map((team) => {
      const playerCount = team.players.length;
      const skillTotal = team.skillTotal ?? 0;
      const averageSkill = playerCount > 0 ? Number((skillTotal / playerCount).toFixed(4)) : 0;

      return {
        teamId: team.id,
        coachId: team.coachId ?? null,
        playerCount,
        skillTotal,
        averageSkill,
      };
    });

    const totalSkill = skillStats.reduce((sum, entry) => sum + entry.skillTotal, 0);
    const averageSkillPerPlayer =
      totalPlayers > 0 ? Number((totalSkill / totalPlayers).toFixed(4)) : 0;
    const minAverageSkill = skillStats.length
      ? Math.min(...skillStats.map((entry) => entry.averageSkill))
      : 0;
    const maxAverageSkill = skillStats.length
      ? Math.max(...skillStats.map((entry) => entry.averageSkill))
      : 0;
    const spread = Number((maxAverageSkill - minAverageSkill).toFixed(4));

    skillBalanceByDivision[division] = {
      teamStats: skillStats,
      summary: {
        totalSkill,
        averageSkillPerPlayer,
        minAverageSkill,
        maxAverageSkill,
        spread,
      },
    };

    if (divisionIncremental) {
      const preservedTeamsInput = divisionIncremental.preservedTeams;
      const manualAssignmentsPreserved = preservedTeamsInput.reduce(
        (sum, team) =>
          sum + team.players.filter((player) => player.assignment_source === 'manual').length,
        0
      );
      // Computed from the FINAL rosters so violations introduced by allowOverCapAssignments
      // are reported alongside pre-existing over-cap preserved teams.
      const capacityViolations = teams
        .filter((team) => team.players.length > maxRosterSize)
        .map((team) => ({
          teamId: team.id,
          playerCount: team.players.length,
          maxRosterSize,
        }));

      // When the division fell back to the fresh path (nothing to preserve), synthesize the
      // stats from the fresh outputs.
      const overflowedPlayerCount = overflow.reduce((sum, entry) => sum + entry.players.length, 0);
      const stats = incrementalStats ?? {
        existingTeamsPreserved: 0,
        newTeamsCreated: teams.length,
        latePlayersAssigned: divisionPlayers.length - overflowedPlayerCount,
        latePlayersOverflowed: overflowedPlayerCount,
      };

      // A team-count change was "blocked" when a unit overflowed for capacity WHILE team
      // creation was unavailable — the policy forbids it, or maxTeams is already reached.
      // (An oversized unit overflowing under an expandable policy is NOT a blocked count.)
      const creationUnavailable =
        teamCountPolicy === 'preserve-existing' ||
        teamCountPolicy === 'preserve-with-overflow' ||
        (rosterConstraints.maxTeams ? teams.length >= rosterConstraints.maxTeams : false);
      // Units larger than the roster cap never count: no new team could seat them anyway.
      const teamCountChangeBlocked =
        creationUnavailable &&
        overflow.some(
          (entry) =>
            entry.reason === TEAM_GENERATION.REASON_InsufficientCapacity &&
            entry.players.length <= maxRosterSize
        );
      // Preserved players whose assignment is locked (per-player lock, or manual assignments
      // in review/published/locked modes).
      let lockedAssignmentsPreserved = 0;
      for (const team of preservedTeamsInput) {
        for (const player of team.players) {
          if (player.locked === true) {
            lockedAssignmentsPreserved += 1;
          }
        }
      }

      changeDiagnosticsByDivision[division] = {
        mode: generationMode,
        teamCountPolicy,
        existingTeamsPreserved: stats.existingTeamsPreserved,
        newTeamsCreated: stats.newTeamsCreated,
        teamCountChangeBlocked,
        lockedAssignmentsPreserved,
        latePlayersAssigned: stats.latePlayersAssigned,
        latePlayersOverflowed: stats.latePlayersOverflowed,
        buddyTargetAssignments: stats.buddyTargetAssignments ?? [],
        assistantBackfills: stats.assistantBackfills ?? [],
        coachDrops: coachContinuity?.coachDrops ?? [],
        coachReplacements: coachContinuity?.coachReplacements ?? [],
        manualReview: coachContinuity?.manualReview ?? [],
        droppedPlayersRemoved: (reconciliation.droppedPlayersByDivision[division] ?? []).length,
        manualAssignmentsPreserved,
        capacityViolations,
        minRosterWarnings: teamsBelowMinRoster ?? [],
        structuralWarnings,
        // A blocked player seated on a final roster: only a preserved one can be (late blocked
        // players overflow), and they stay (owner decision 3), listed for the admin.
        eligibilityHolds: teams.flatMap((team) =>
          team.players.filter(isEligibilityBlocked).map((player) => ({
            playerId: player.id,
            teamId: team.id,
            placement: player.placement,
            reviewReason: player.reviewReason ?? null,
          }))
        ),
      };
    }
  }

  return {
    teamsByDivision: results,
    overflowByDivision,
    overflowSummaryByDivision,
    buddyDiagnosticsByDivision,
    coachCoverageByDivision,
    rosterBalanceByDivision,
    skillBalanceByDivision,
    ...(incrementalMode
      ? { changeDiagnosticsByDivision, snapshotDiagnostics: reconciliation.diagnostics }
      : {}),
  };
}

/** Valid team-count policies for snapshot-aware generation. */
const TEAM_COUNT_POLICIES = [
  'auto',
  'preserve-existing',
  'preserve-or-expand',
  'preserve-with-overflow',
];
/** Generation modes in which existing team structure must be preserved by default. */
const PRESERVING_MODES = ['review', 'published', 'locked'];

/**
 * Resolve the effective team-count policy from changePolicy + defaults.
 * @param {{ existingSnapshot: any, generationMode: string, changePolicy: any }} params
 * @returns {string}
 */
function resolveTeamCountPolicy({ existingSnapshot, generationMode, changePolicy }) {
  const requested = changePolicy?.teamCountPolicy;
  if (TEAM_COUNT_POLICIES.includes(requested)) {
    return requested;
  }
  if (existingSnapshot == null) {
    return 'auto';
  }
  return PRESERVING_MODES.includes(String(generationMode))
    ? 'preserve-existing'
    : 'preserve-or-expand';
}

/**
 * Rehydrate normalized snapshot team shells with the full incoming player objects, carrying
 * assignment metadata (`assignment_source`, `locked`) onto each preserved player.
 * @param {any[]} preservedTeams - Normalized teams from reconcileTeamDeltas (active players only).
 * @param {Map<string, any>} playerCloneById
 */
function rehydratePreservedTeams(preservedTeams, playerCloneById) {
  return preservedTeams.map((team) => ({
    id: team.id,
    name: team.name,
    division: team.division,
    coachId: team.coachId ?? null,
    locked: Boolean(team.locked),
    assistantCoachIds: Array.isArray(team.assistantCoachIds) ? [...team.assistantCoachIds] : [],
    players: team.players
      .map((player) => {
        const base = playerCloneById.get(player.id);
        return base
          ? { ...base, assignment_source: player.assignment_source, locked: player.locked }
          : null;
      })
      .filter(Boolean),
  }));
}

/**
 * @param {Object} params
 * @param {string} params.division
 * @param {Array<Player>} params.players
 * @param {number} params.maxRosterSize
 * @param {DivisionConfig} params.divisionConfig
 * @param {Object} params.rosterConstraints
 * @param {function(): number} params.random
 * @param {Object} params.featureFlags
 * @param {Object} [params.customWeights]
 * @param {Object} [params.globalStats]
 * @param {any} [params.incremental] - Snapshot-aware inputs (preserved shells, late players,
 *   team-count policy); null for fresh generation.
 */
/**
 * The number of teams a fresh (non-incremental) generation builds for a division. The one place
 * this is computed: `buildTeamsForDivision` and the teaming settings panel's advice
 * (`assessTeamCount`, rosterSizing.js) both call it.
 *
 * Starts from the override, or `ceil(players / targetTeamSize)`; never fewer than one team per
 * head coach, `minTeams`, or enough teams to keep every roster at or under `maxRosterSize`; then
 * no more than keeps every roster at or above `minRosterSize` (unless that would break one of the
 * floors); and finally no more than `maxTeams`.
 *
 * @param {{ playerCount: number, coachCount?: number, maxRosterSize: number,
 *   targetTeamSize?: number|null, teamCountOverride?: number|null, minTeams?: number|null,
 *   maxTeams?: number|null, minRosterSize?: number|null }} params
 * @returns {number}
 */
export function resolveTeamCount({
  playerCount,
  coachCount = 0,
  maxRosterSize,
  targetTeamSize,
  teamCountOverride,
  minTeams,
  maxTeams,
  minRosterSize,
}) {
  let calculatedTeams = Math.ceil(playerCount / (targetTeamSize ?? maxRosterSize)) || 1;

  if (teamCountOverride) {
    calculatedTeams = teamCountOverride;
  }

  const minimumTeamCount = Math.max(coachCount, minTeams ?? 1);
  const minTeamsForCapacity = Math.ceil(playerCount / maxRosterSize);
  let finalRequiredTeams = Math.max(calculatedTeams, minimumTeamCount, minTeamsForCapacity);

  if (minRosterSize && playerCount >= minRosterSize) {
    const maxTeamsForMinRoster = Math.max(1, Math.floor(playerCount / minRosterSize));
    finalRequiredTeams = Math.max(
      minimumTeamCount,
      minTeamsForCapacity,
      Math.min(finalRequiredTeams, maxTeamsForMinRoster)
    );
  }

  if (maxTeams) {
    finalRequiredTeams = Math.min(finalRequiredTeams, maxTeams);
  }

  return finalRequiredTeams;
}

function buildTeamsForDivision({
  division,
  players,
  maxRosterSize,
  divisionConfig,
  rosterConstraints,
  random,
  featureFlags,
  customWeights,
  globalStats,
  incremental = null,
}) {
  if (incremental) {
    return buildTeamsForDivisionIncremental({
      division,
      maxRosterSize,
      divisionConfig,
      rosterConstraints,
      random,
      featureFlags,
      customWeights,
      globalStats,
      incremental,
    });
  }

  // Blocked and waitlisted players leave the pool before anything is counted or anchored: they add
  // no team, a coach's child among them anchors none, and each is in overflow with the reason.
  const blocked = separateEligibilityBlocked(players);
  players = blocked.eligible;
  if (players.length === 0 && blocked.blockedPlayers.length > 0) {
    // Everyone is blocked: no team could seat anyone, so none is built (empty shells would be
    // persisted as if teamed). Every player is in overflow with the reason.
    return {
      teams: [],
      overflow: blocked.overflow,
      buddyDiagnostics: { mutualPairs: [], unmatchedRequests: [] },
    };
  }

  const coachIds = Array.from(
    new Set(players.filter((player) => player.coachId).map((player) => player.coachId))
  );

  const { maxTeams } = rosterConstraints;
  const finalRequiredTeams = resolveTeamCount({
    playerCount: players.length,
    coachCount: coachIds.length,
    maxRosterSize,
    targetTeamSize: rosterConstraints.targetTeamSize,
    teamCountOverride: rosterConstraints.teamCountOverride,
    minTeams: rosterConstraints.minTeams,
    maxTeams,
    minRosterSize: rosterConstraints.minRosterSize,
  });

  const teams = [];
  let teamIndex = 0;

  /** @type {Array<{ players: Array<Player>, reason: string, metadata?: Object }>} */
  const overflow = [...blocked.overflow];

  const createTeam = (coachId = null) => {
    if (maxTeams && teams.length >= maxTeams) {
      return null;
    }
    teamIndex += 1;
    const id = `${division}-T${String(teamIndex).padStart(2, '0')}`;
    const name = generateTeamName({ division, teamIndex, divisionConfig });
    const team = { id, name, division, coachId, assistantCoachIds: [], players: [], skillTotal: 0 };
    teams.push(team);
    return team;
  };

  for (const coachId of coachIds) {
    createTeam(coachId);
  }
  while (teams.length < finalRequiredTeams) {
    if (!createTeam(null)) {
      break;
    }
  }

  const { units, buddyDiagnostics } = buildAssignmentUnits(players);
  relabelBlockedBuddyRequests(buddyDiagnostics, blocked.blockedPlayers);
  const coachUnits = [];
  const generalUnits = [];

  for (const unit of units) {
    if (unit.type === 'coach' || unit.type === 'assistant') {
      coachUnits.push(unit);
    } else {
      generalUnits.push(unit);
    }
  }

  // Assign players that require a specific coach first.
  for (const assignmentUnit of coachUnits) {
    const { coachId, assistantCoachIds, skillTotal } = assignmentUnit;
    const unit = assignmentUnit.players;
    let targetTeam = null;

    if (coachId) {
      targetTeam = teams.find((team) => team.coachId === coachId);
      if (!targetTeam) {
        targetTeam = createTeam(coachId);
      }
    } else if (assistantCoachIds.length > 0) {
      // Assistant-only units BACKFILL existing teams needing assistant coverage before any new
      // shell is created: a team already carrying this assistant, then a coached team without
      // assistants, then a coachless team needing adult coverage.
      targetTeam =
        findAssistantBackfillTeam({
          teams,
          assistantCoachIds,
          unitSize: unit.length,
          maxRosterSize,
        }) ?? createTeam(null);
    }

    if (!targetTeam && !coachId && assistantCoachIds.length === 0) {
      // Fallback (shouldn't happen given logic above)
      targetTeam = createTeam(null);
    }

    if (!targetTeam) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_InsufficientCapacity,
        metadata: {
          unitSize: unit.length,
          coachId,
          maxTeams,
          currentTeams: teams.length,
        },
      });
      continue;
    }

    // Ensure team has assistant array
    if (!targetTeam.assistantCoachIds) {
      targetTeam.assistantCoachIds = [];
    }
    // Add new assistants
    for (const acid of assistantCoachIds) {
      if (!targetTeam.assistantCoachIds.includes(acid)) {
        targetTeam.assistantCoachIds.push(acid);
      }
    }

    const assigned = assignUnitToTeam({
      unit,
      unitSkillTotal: skillTotal,
      team: targetTeam,
      maxRosterSize,
      reason: TEAM_GENERATION.REASON_CoachAssignment,
    });

    if (!assigned) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_CoachCapacity,
        metadata: { coachId },
      });
    }
  }

  const leadPolicy = resolveLeadPolicy({ featureFlags, players });

  for (const assignmentUnit of orderGeneralUnits(generalUnits, leadPolicy)) {
    const unit = assignmentUnit.players;
    const skillTotal = assignmentUnit.skillTotal;
    const team = pickTeamForGeneralUnit({
      teams,
      allTeams: teams,
      unit,
      unitSkillTotal: skillTotal,
      maxRosterSize,
      random,
      featureFlags,
      customWeights,
      globalStats,
      leadPolicy,
    });
    if (!team) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_InsufficientCapacity,
        metadata: { unitSize: unit.length },
      });
      continue;
    }

    assignUnitToTeam({
      unit,
      unitSkillTotal: skillTotal,
      team,
      maxRosterSize,
      reason: TEAM_GENERATION.REASON_Balancing,
    });
  }

  return { teams, overflow, buddyDiagnostics };
}

/**
 * Snapshot-aware division builder. Initializes teams from preserved snapshot shells (ids, names,
 * coach/assistant metadata, and already-assigned players are kept), then places ONLY the late /
 * unassigned players using the same unit + placement helpers as fresh generation. Team creation is
 * governed by `teamCountPolicy`:
 *   - 'preserve-existing' / 'preserve-with-overflow': never create or delete teams; units that do
 *     not fit overflow.
 *   - 'preserve-or-expand': create the minimum necessary new teams (on demand) when capacity or a
 *     late coach anchor requires it, still respecting `maxTeams`.
 * Preserved players are never moved; preserved over-cap teams accept no additional players unless
 * `allowOverCapAssignments` is true.
 */
function buildTeamsForDivisionIncremental({
  division,
  maxRosterSize,
  divisionConfig,
  rosterConstraints,
  random,
  featureFlags,
  customWeights,
  globalStats,
  incremental,
}) {
  const {
    preservedTeams,
    latePlayers: incomingLatePlayers,
    teamCountPolicy,
    allowOverCapAssignments,
    allowAssistantShellCreation,
  } = incremental;
  const { maxTeams } = rosterConstraints;
  const allowTeamCreation = teamCountPolicy === 'preserve-or-expand';
  // A blocked late player is never placed; a blocked preserved player stays (eligibilityHolds).
  const blocked = separateEligibilityBlocked(incomingLatePlayers);
  const latePlayers = blocked.eligible;
  const effectiveMaxRosterSize = allowOverCapAssignments ? Number.MAX_SAFE_INTEGER : maxRosterSize;

  const teams = preservedTeams.map((team, index) => ({
    id: team.id,
    name: team.name ?? `${division} Team ${String(index + 1).padStart(2, '0')}`,
    division,
    coachId: team.coachId ?? null,
    coachInactive: Boolean(team.coachInactive),
    locked: Boolean(team.locked),
    assistantCoachIds: [...team.assistantCoachIds],
    players: [...team.players],
    skillTotal: calculateUnitSkill(team.players),
  }));

  // Leads are counted over the division as it will stand, each player once: the preserved
  // rosters, before any late player joins them, and the eligible late players.
  const leadPolicy = resolveLeadPolicy({
    featureFlags,
    players: [...teams.flatMap((team) => team.players), ...latePlayers],
  });

  const preservedTeamIdSet = new Set(preservedTeams.map((team) => team.id));
  const assistantBackfills = [];

  // Historical buddy lookup: preserved player id → { teamId, player } (this division only).
  // The player object is kept so targeting can verify the request is RECIPROCAL.
  const preservedBuddyTargets = new Map();
  for (const team of preservedTeams) {
    for (const player of team.players) {
      const id = String(player.id).trim();
      if (!preservedBuddyTargets.has(id)) {
        preservedBuddyTargets.set(id, { teamId: team.id, player });
      }
    }
  }

  /** @type {Array<{ players: Array<Player>, reason: string, metadata?: Object }>} */
  const overflow = [...blocked.overflow];
  let teamIndex = teams.length;

  const createTeam = (coachId = null) => {
    if (!allowTeamCreation) {
      return null;
    }
    if (maxTeams && teams.length >= maxTeams) {
      return null;
    }
    teamIndex += 1;
    let id = `${division}-T${String(teamIndex).padStart(2, '0')}`;
    while (teams.some((team) => team.id === id)) {
      teamIndex += 1;
      id = `${division}-T${String(teamIndex).padStart(2, '0')}`;
    }
    const name = generateTeamName({ division, teamIndex, divisionConfig });
    const team = { id, name, division, coachId, assistantCoachIds: [], players: [], skillTotal: 0 };
    teams.push(team);
    return team;
  };

  const { units, buddyDiagnostics } = buildAssignmentUnits(latePlayers);
  relabelBlockedBuddyRequests(buddyDiagnostics, blocked.blockedPlayers);
  const coachUnits = [];
  const targetedBuddyUnits = [];
  const generalUnits = [];
  for (const unit of units) {
    if (unit.type === 'coach' || unit.type === 'assistant') {
      coachUnits.push(unit);
      continue;
    }
    // Historical buddy routing: a late solo player whose RECIPROCAL buddy is already preserved
    // on a team becomes a targeted-buddy unit aimed at that team. (Coach anchoring takes
    // precedence; late mutual pairs stay mutual-buddy units; one-sided requests are NOT honored —
    // matching fresh generation's mutual-only policy.)
    if (unit.type === 'general' && unit.players.length === 1) {
      const latePlayer = unit.players[0];
      const buddyId = getCanonicalBuddyId(latePlayer);
      const target = buddyId ? preservedBuddyTargets.get(buddyId) : undefined;
      if (target && getCanonicalBuddyId(target.player) === String(latePlayer.id).trim()) {
        targetedBuddyUnits.push({ ...unit, type: 'targeted-buddy', targetTeamId: target.teamId });
        continue;
      }
    }
    generalUnits.push(unit);
  }

  // The unit builder diagnosed these buddies as 'missing-player' (they are not late players) —
  // they are in fact preserved; the routing outcome is reported instead.
  if (targetedBuddyUnits.length > 0) {
    const targetedPlayerIds = new Set(targetedBuddyUnits.map((unit) => unit.players[0].id));
    buddyDiagnostics.unmatchedRequests = buddyDiagnostics.unmatchedRequests.filter(
      (entry) => !(entry.reason === 'missing-player' && targetedPlayerIds.has(entry.playerId))
    );
  }

  // Late coach/assistant units first: join their preserved team when one exists; otherwise a new
  // team is created only under 'preserve-or-expand'.
  for (const assignmentUnit of coachUnits) {
    const { coachId, assistantCoachIds, skillTotal } = assignmentUnit;
    const unit = assignmentUnit.players;
    let targetTeam = null;

    if (coachId) {
      // Canonical comparison: continuity writes trimmed string ids onto preserved shells while
      // unit coach ids arrive raw from player records.
      const coachKey = String(coachId).trim();
      targetTeam =
        teams.find((team) => team.coachId != null && String(team.coachId).trim() === coachKey) ??
        createTeam(coachKey);
    } else if (assistantCoachIds.length > 0) {
      // Backfill an existing team needing assistant coverage; a new unmanaged shell is created
      // only when the policy explicitly allows it. With neither, the unit places like a general
      // unit (assistant metadata still merges after placement).
      targetTeam = findAssistantBackfillTeam({
        teams,
        assistantCoachIds,
        unitSize: unit.length,
        maxRosterSize: effectiveMaxRosterSize,
        excludeLocked: true,
      });
      if (!targetTeam && allowAssistantShellCreation === true) {
        targetTeam = createTeam(null);
      }
      if (!targetTeam) {
        generalUnits.push(assignmentUnit);
        continue;
      }
    }

    // A locked preserved team accepts no late additions — not even its own coach's child.
    if (targetTeam && targetTeam.locked) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_CoachCapacity,
        metadata: { coachId, locked: true },
      });
      continue;
    }

    if (!targetTeam) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_InsufficientCapacity,
        metadata: {
          unitSize: unit.length,
          coachId,
          teamCountPolicy,
          currentTeams: teams.length,
        },
      });
      continue;
    }

    const assigned = assignUnitToTeam({
      unit,
      unitSkillTotal: skillTotal,
      team: targetTeam,
      maxRosterSize: effectiveMaxRosterSize,
      reason: TEAM_GENERATION.REASON_CoachAssignment,
    });

    if (!assigned) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_CoachCapacity,
        metadata: { coachId },
      });
      continue;
    }

    // Merge assistant metadata only AFTER successful placement so an overflowed late unit cannot
    // mutate a preserved team's assistantCoachIds.
    for (const acid of assistantCoachIds) {
      if (!targetTeam.assistantCoachIds.includes(acid)) {
        targetTeam.assistantCoachIds.push(acid);
      }
    }
    if (!coachId && assistantCoachIds.length > 0 && preservedTeamIdSet.has(targetTeam.id)) {
      assistantBackfills.push({
        teamId: targetTeam.id,
        assistantCoachIds: assistantCoachIds.map((id) => String(id).trim()),
      });
    }
  }

  // Targeted-buddy units: route the late player onto their buddy's preserved team when capacity
  // and policy allow; otherwise overflow with a specific reason. Existing rosters are NEVER
  // reshuffled to make room.
  const buddyTargetAssignments = [];
  for (const assignmentUnit of targetedBuddyUnits) {
    const unit = assignmentUnit.players;
    const targetTeam = teams.find((team) => team.id === assignmentUnit.targetTeamId);
    if (!targetTeam || targetTeam.locked) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_BuddyTargetLocked,
        metadata: {
          targetTeamId: assignmentUnit.targetTeamId,
          buddyId: unit[0].buddyId,
        },
      });
      continue;
    }

    const assigned = assignUnitToTeam({
      unit,
      unitSkillTotal: assignmentUnit.skillTotal,
      team: targetTeam,
      maxRosterSize: effectiveMaxRosterSize,
      reason: TEAM_GENERATION.REASON_BuddyRequest,
    });

    if (assigned) {
      buddyTargetAssignments.push({
        playerId: unit[0].id,
        buddyId: unit[0].buddyId,
        teamId: targetTeam.id,
      });
    } else {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_BuddyTargetCapacity,
        metadata: {
          targetTeamId: targetTeam.id,
          buddyId: unit[0].buddyId,
          playerCount: targetTeam.players.length,
          maxRosterSize,
        },
      });
    }
  }

  for (const assignmentUnit of orderGeneralUnits(generalUnits, leadPolicy)) {
    const unit = assignmentUnit.players;
    const skillTotal = assignmentUnit.skillTotal;
    // Locked preserved teams accept no late additions (filtered per unit so teams created
    // during expansion remain candidates).
    let team = pickTeamForGeneralUnit({
      teams: teams.filter((candidate) => !candidate.locked),
      allTeams: teams,
      unit,
      unitSkillTotal: skillTotal,
      maxRosterSize: effectiveMaxRosterSize,
      random,
      featureFlags,
      customWeights,
      globalStats,
      leadPolicy,
    });
    if (!team && unit.length <= effectiveMaxRosterSize) {
      // 'preserve-or-expand': create a team only when a unit actually needs one and can fit.
      team = createTeam(null);
    }
    if (!team) {
      overflow.push({
        players: unit,
        reason: TEAM_GENERATION.REASON_InsufficientCapacity,
        metadata: { unitSize: unit.length, teamCountPolicy },
      });
      continue;
    }

    const assigned = assignUnitToTeam({
      unit,
      unitSkillTotal: skillTotal,
      team,
      maxRosterSize: effectiveMaxRosterSize,
      reason: TEAM_GENERATION.REASON_Balancing,
    });

    // A demoted assistant-only unit still carries its assistant metadata onto the team it joins.
    if (
      assigned &&
      assignmentUnit.assistantCoachIds &&
      assignmentUnit.assistantCoachIds.length > 0
    ) {
      const cleanAssistantIds = assignmentUnit.assistantCoachIds.map((id) => String(id).trim());
      const existingAssistantIds = team.assistantCoachIds.map((id) => String(id).trim());
      for (const acid of cleanAssistantIds) {
        if (!existingAssistantIds.includes(acid)) {
          team.assistantCoachIds.push(acid);
          existingAssistantIds.push(acid);
        }
      }
      if (preservedTeamIdSet.has(team.id)) {
        assistantBackfills.push({ teamId: team.id, assistantCoachIds: cleanAssistantIds });
      }
    }
  }

  const latePlayersOverflowed = overflow.reduce((sum, entry) => sum + entry.players.length, 0);
  const incrementalStats = {
    existingTeamsPreserved: preservedTeams.length,
    newTeamsCreated: teams.length - preservedTeams.length,
    latePlayersAssigned: incomingLatePlayers.length - latePlayersOverflowed,
    latePlayersOverflowed,
    buddyTargetAssignments,
    assistantBackfills,
  };

  return { teams, overflow, buddyDiagnostics, incrementalStats };
}

/**
 * Split a division's unplaced players into those the generator may seat and those it may not:
 * blocked by eligibility (Phase B2) or waitlisted (owner decision, 2026-10-27). Each is an
 * overflow entry of its own, in input order, with its reason. A player both blocked and
 * waitlisted is reported as blocked. With nobody held out, `eligible` holds the same players in
 * the same order.
 * @param {Array<Player>} players
 */
function separateEligibilityBlocked(players) {
  const eligible = [];
  const blockedPlayers = [];
  const overflow = [];
  for (const player of players) {
    const blocked = isEligibilityBlocked(player);
    if (!blocked && !isWaitlisted(player)) {
      eligible.push(player);
      continue;
    }
    blockedPlayers.push(player);
    const annotated = /** @type {any} */ (player);
    // An assistant whose child is held out is not attached anywhere; say who, when there is one.
    const assistant = player.assistantCoachId ? { assistantCoachId: player.assistantCoachId } : {};
    overflow.push({
      players: [player],
      reason: blocked
        ? TEAM_GENERATION.REASON_EligibilityBlocked
        : TEAM_GENERATION.REASON_Waitlisted,
      metadata: blocked
        ? {
            placement: annotated.placement,
            reviewReason: annotated.reviewReason ?? null,
            naturalAge: Number.isFinite(annotated.naturalAge) ? annotated.naturalAge : null,
            coachId: player.coachId ?? null,
            ...assistant,
          }
        : { coachId: player.coachId ?? null, ...assistant },
    });
  }
  return { eligible, blockedPlayers, overflow };
}

/**
 * The unit builder only sees eligible players, so a request naming a blocked player reads as
 * `missing-player`. Say what it is instead: `buddy-not-placed` for a mutual buddy (placed
 * alone), and `not-reciprocated`, as before B2, for a one-way request. Matches ids as the unit
 * builder does (strictly).
 * @param {{ unmatchedRequests: Array<{ playerId: string, requestedBuddyId: string, reason: string }> }} buddyDiagnostics
 * @param {Array<Player>} blockedPlayers
 */
function relabelBlockedBuddyRequests(buddyDiagnostics, blockedPlayers) {
  if (blockedPlayers.length === 0) return;
  const blockedById = new Map(blockedPlayers.map((player) => [player.id, player]));
  for (const entry of buddyDiagnostics.unmatchedRequests) {
    const target = blockedById.get(entry.requestedBuddyId);
    if (entry.reason !== 'missing-player' || !target) continue;
    entry.reason = target.buddyId === entry.playerId ? 'buddy-not-placed' : 'not-reciprocated';
  }
}

/**
 * Attempt to assign a unit of players to a specific team if capacity allows.
 *
 * @param {Object} params
 * @param {Array<Player>} params.unit - The unit of players (1 or 2).
 * @param {number} params.unitSkillTotal - Pre-calculated skill total for the unit.
 * @param {Team} params.team - The target team object.
 * @param {number} params.maxRosterSize - Roster capacity constraint.
 * @param {string} params.reason - Description for assignment diagnostics.
 * @returns {boolean} True if assignment was successful.
 */
function assignUnitToTeam({ unit, unitSkillTotal, team, maxRosterSize, reason: _reason }) {
  if (team.players.length + unit.length > maxRosterSize) {
    return false;
  }

  for (const player of unit) {
    if (team.players.some((existing) => existing.id === player.id)) {
      throw new Error(`player ${player.id} is already assigned to team ${team.id}`);
    }
    team.players.push(player);
  }

  team.skillTotal += unitSkillTotal;

  return true;
}

/**
 * @typedef {{ signalKind: string, c: number }} LeadPolicy
 *   How a division deals its coaching leads (Phase B6): the league's balance signal and what
 *   one lead adds to a team's load; with `c` 0 the deal does not compensate, and the
 *   evaluators balance what the lead spread leaves.
 */

/**
 * The lead rule for one division, or `null` when it does not apply: the league turned
 * `teaming_spread_coaching_leads` off, or no player of the division is a lead. `null` keeps
 * placement exactly as it was before B6. The deal compensates only when the league's signal is
 * one a player can carry (`player_rating` or `years_played`) and some player of the division
 * carries it (`carriesSignal`); otherwise there is nothing to compensate with, and the
 * evaluators balance the rest as they do without leads.
 * @param {{ featureFlags: Object, players: Array<Player> }} params
 * @returns {LeadPolicy | null}
 */
function resolveLeadPolicy({ featureFlags, players }) {
  if (!spreadsCoachingLeads(featureFlags) || countLeads(players) === 0) return null;
  const signalKind = balanceSignalKind(featureFlags);
  return { signalKind, c: divisionLeadCompensation(players, signalKind) };
}

/** A unit's (or roster's) total of the league's balance signal. */
function signalTotalOf(players, signalKind) {
  return players.reduce((total, player) => total + playerSignal(player, signalKind), 0);
}

/**
 * The order the general units are placed in. Without a lead policy, by skill total, as
 * before B6. With one: units holding a lead first, the most leads first, then by the league's
 * signal when the deal compensates (else by skill total, as before), each in descending order.
 * @param {Array<import('./assignmentUnits.js').AssignmentUnit>} units
 * @param {LeadPolicy | null} leadPolicy
 */
function orderGeneralUnits(units, leadPolicy) {
  if (!leadPolicy) return [...units].sort((a, b) => b.skillTotal - a.skillTotal);
  const { signalKind, c } = leadPolicy;
  return orderForLeadDeal(units, {
    leadsOf: (unit) => countLeads(unit.players),
    weightOf: (unit) => (c > 0 ? signalTotalOf(unit.players, signalKind) : unit.skillTotal),
  });
}

const buddyEvaluator = new BuddyEvaluator();

/**
 * The team a general unit joins. With no lead policy, the evaluators decide
 * (`pickTeamWithMostCapacity`), as before B6. With one (`coachingLeads.js`), among the teams
 * with room, a unit holding a lead keeps only the teams with the fewest leads. Then, when the
 * deal compensates: a buddy the unit asked for (best effort, `BuddyEvaluator`) narrows them to
 * that buddy's team; then the lowest `signal total + c × leads`, the smallest roster, and the
 * seeded random draw among any still tied. When it does not, the evaluators choose among them.
 * @param {Object} params
 * @param {Array<Team>} params.teams - the candidates
 * @param {Array<Team>} params.allTeams - every team of the division
 * @param {Array<Player>} params.unit
 * @param {number} params.unitSkillTotal
 * @param {number} params.maxRosterSize
 * @param {function(): number} params.random
 * @param {Object} params.featureFlags
 * @param {Object} [params.customWeights]
 * @param {Object} [params.globalStats]
 * @param {LeadPolicy | null} params.leadPolicy
 * @returns {Team | null}
 */
function pickTeamForGeneralUnit({ leadPolicy, allTeams, ...params }) {
  if (!leadPolicy) return pickTeamWithMostCapacity(params);
  const { teams, unit, maxRosterSize, random, featureFlags } = params;
  let candidates = teams.filter((team) => team.players.length + unit.length <= maxRosterSize);
  if (candidates.length === 0) return null;
  if (countLeads(unit) > 0) {
    candidates = withFewestLeads(candidates, (team) => countLeads(team.players));
  }
  const { signalKind, c } = leadPolicy;
  if (c === 0) {
    return pickTeamWithMostCapacity({ ...params, teams: candidates, allTeams: params.teams });
  }
  const buddyScore = (team) =>
    buddyEvaluator.evaluate({ player: unit[0], team, allTeams, featureFlags });
  candidates = keepBest(candidates, buddyScore);
  candidates = keepBest(
    candidates,
    (team) => -compensatedLoad(signalTotalOf(team.players, signalKind), countLeads(team.players), c)
  );
  candidates = keepBest(candidates, (team) => -team.players.length);
  return candidates[Math.floor(random() * candidates.length)];
}

/**
 * The candidates with the highest score, in their order.
 * @template T
 * @param {T[]} candidates
 * @param {(candidate: T) => number} scoreOf
 * @returns {T[]}
 */
function keepBest(candidates, scoreOf) {
  const scores = candidates.map(scoreOf);
  const best = Math.max(...scores);
  return candidates.filter((_, index) => scores[index] === best);
}

/**
 * @param {Object} params
 * @param {Array<Team>} params.teams - the candidates
 * @param {Array<Team>} [params.allTeams] - the teams the evaluators compare with (default `teams`)
 * @param {Array<Player>} params.unit
 * @param {number} params.unitSkillTotal
 * @param {number} params.maxRosterSize
 * @param {function(): number} params.random
 * @param {Object} params.featureFlags
 * @param {Object} [params.customWeights]
 * @param {Object} [params.globalStats]
 * @returns {Team | null}
 */
function pickTeamWithMostCapacity({
  teams,
  allTeams = teams,
  unit,
  unitSkillTotal: _unitSkillTotal,
  maxRosterSize,
  random,
  featureFlags,
  customWeights,
  globalStats,
}) {
  const unitSize = unit.length;
  const candidates = teams.filter((team) => team.players.length + unitSize <= maxRosterSize);
  if (candidates.length === 0) {
    return null;
  }

  // Phase 1.2: Use modular evaluators
  const evaluatedCandidates = candidates.map((team) => {
    let totalScore = 0;

    // Evaluate for unit anchor
    for (const evaluator of EVALUATOR_REGISTRY) {
      const score = evaluator.evaluate({
        player: unit[0],
        team,
        allTeams,
        featureFlags,
        customWeights,
        globalStats,
      });
      totalScore += score;
    }

    return { team, score: totalScore };
  });

  // Sort by score descending, then by capacity (smallest teams first)
  evaluatedCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.team.players.length - b.team.players.length;
  });

  // Pick from the best candidates
  const topScore = evaluatedCandidates[0].score;
  const bestCandidates = evaluatedCandidates.filter((c) => c.score === topScore);

  const index = Math.floor(random() * bestCandidates.length);
  return bestCandidates[index].team;
}

/**
 * Find a team an assistant-only unit should BACKFILL, in priority order:
 *   1. a team already carrying one of these assistants;
 *   2. a team with a head coach but no assistants;
 *   3. a coachless team needing adult coverage.
 * Only teams with capacity for the unit qualify; locked teams are excluded when requested.
 * Returns null when no existing team qualifies (callers decide whether a new shell is allowed).
 */
function findAssistantBackfillTeam({
  teams,
  assistantCoachIds,
  unitSize,
  maxRosterSize,
  excludeLocked = false,
}) {
  const eligible = teams.filter(
    (team) => !(excludeLocked && team.locked) && team.players.length + unitSize <= maxRosterSize
  );
  // Canonical comparison so numeric / padded assistant ids still match.
  const canonicalAssistantIds = assistantCoachIds.map((id) => String(id).trim());
  return (
    eligible.find(
      (team) =>
        team.assistantCoachIds &&
        team.assistantCoachIds.some((id) => canonicalAssistantIds.includes(String(id).trim()))
    ) ??
    eligible.find(
      (team) => team.coachId && (!team.assistantCoachIds || team.assistantCoachIds.length === 0)
    ) ??
    eligible.find((team) => !team.coachId) ??
    null
  );
}

function summarizeOverflow(entries) {
  if (!entries || entries.length === 0) {
    return { totalUnits: 0, totalPlayers: 0, byReason: {} };
  }

  const summary = {
    totalUnits: entries.length,
    totalPlayers: 0,
    byReason: {},
  };

  for (const entry of entries) {
    const playerCount = Array.isArray(entry.players) ? entry.players.length : 0;
    summary.totalPlayers += playerCount;

    const reason = entry.reason ?? TEAM_GENERATION.REASON_Unknown;
    if (!summary.byReason[reason]) {
      summary.byReason[reason] = { units: 0, players: 0 };
    }
    summary.byReason[reason].units += 1;
    summary.byReason[reason].players += playerCount;
  }

  return summary;
}

function normalizeDivisionRosterConstraints(config, division) {
  const maxRosterSize = normalizePositiveInteger(
    config.maxRosterSize ?? config.max_roster_size,
    `maxRosterSize for division ${division}`
  );
  const minRosterSize = normalizeOptionalPositiveInteger(
    config.minRosterSize ?? config.min_roster_size ?? config.minSize,
    `minRosterSize for division ${division}`
  );
  const targetTeamSize = normalizeOptionalPositiveInteger(
    config.targetTeamSize ?? config.target_team_size ?? config.targetSize,
    `targetTeamSize for division ${division}`
  );
  const teamCountOverride = normalizeOptionalPositiveInteger(
    config.teamCountOverride ?? config.team_count_override,
    `teamCountOverride for division ${division}`
  );
  const minTeams = normalizeOptionalPositiveInteger(
    config.minTeams ?? config.min_teams,
    `minTeams for division ${division}`
  );
  const maxTeams = normalizeOptionalPositiveInteger(
    config.maxTeams ?? config.max_teams,
    `maxTeams for division ${division}`
  );

  if (minRosterSize && minRosterSize > maxRosterSize) {
    throw new Error(`minRosterSize for division ${division} cannot exceed maxRosterSize`);
  }
  if (minTeams && maxTeams && minTeams > maxTeams) {
    throw new Error(`minTeams for division ${division} cannot exceed maxTeams`);
  }
  if (teamCountOverride && minTeams && teamCountOverride < minTeams) {
    throw new Error(`teamCountOverride for division ${division} cannot be below minTeams`);
  }
  if (teamCountOverride && maxTeams && teamCountOverride > maxTeams) {
    throw new Error(`teamCountOverride for division ${division} cannot exceed maxTeams`);
  }

  return {
    maxRosterSize,
    minRosterSize,
    targetTeamSize: targetTeamSize ?? maxRosterSize,
    teamCountOverride,
    minTeams,
    maxTeams,
  };
}

function normalizePositiveInteger(value, context) {
  const normalized = normalizeOptionalPositiveInteger(value, context);
  if (!normalized) {
    throw new Error(`${context} must be a positive integer`);
  }
  return normalized;
}

function normalizeOptionalPositiveInteger(value, context) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }

  return Math.trunc(numberValue);
}

/**
 * @param {Object} params
 * @param {string} params.division
 * @param {number} params.teamIndex
 * @param {DivisionConfig} params.divisionConfig
 * @returns {string}
 */
function generateTeamName({ division, teamIndex, divisionConfig }) {
  const names = (divisionConfig?.teamNames ?? [])
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter((name) => name.length > 0);

  if (names.length >= teamIndex) {
    return names[teamIndex - 1];
  }

  const prefix =
    typeof divisionConfig?.teamNamePrefix === 'string' ? divisionConfig.teamNamePrefix.trim() : '';
  if (prefix.length > 0) {
    return `${prefix} ${String(teamIndex).padStart(2, '0')}`;
  }

  return `${division} Team ${String(teamIndex).padStart(2, '0')}`;
}

/**
 * Simple hash function for seeding.
 */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/**
 * Simple seeded PRNG (Mulberry32).
 */
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
