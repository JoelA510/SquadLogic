import { TEAM_GENERATION } from './constants.js';

/**
 * The outcome of a team-generation run against its roster limits, per division (Phase B4,
 * docs/changes/2026-10-22-phase-b-teaming.md): teams under the minimum roster, teams over the
 * maximum, and players the run did not place for lack of room. The settings panel's advice
 * (`assessTeamCount`, rosterSizing.js) says what a count should give before generation; this says
 * what the run gave.
 *
 * Teams are enumerated from the run's rosters (`teamsByDivision`), never from the diagnostics
 * that name the teams with a problem, and each size is counted from the roster (or from
 * `rosterSizeByTeamId`, the run's current rows, when a manual edit has moved players since). The
 * limits are the ones the generator recorded on each team (`rosterBalanceByDivision[div]
 * .teamStats`). A run that did not record them, or whose teams carry no rosters, is not checked:
 * its `underMin` is `null`, and so is its `overMax` unless the run carries the generator's own
 * over-maximum check (`changeDiagnosticsByDivision[div].capacityViolations`, which only a rerun
 * computes). `null` means "not checked", never "none".
 */

/** Overflow reasons that mean "no room": the teams, the coach's team or the buddy's team was full. */
export const CAPACITY_OVERFLOW_REASONS = Object.freeze([
  TEAM_GENERATION.REASON_InsufficientCapacity,
  TEAM_GENERATION.REASON_CoachCapacity,
  TEAM_GENERATION.REASON_BuddyTargetCapacity,
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveIntegerOrNull = (value) =>
  Number.isInteger(value) && value > 0 ? /** @type {number} */ (value) : null;

function playerName(player) {
  if (!player) return null;
  const name =
    (typeof player.name === 'string' && player.name.trim()) ||
    `${player.firstName ?? player.first_name ?? ''} ${player.lastName ?? player.last_name ?? ''}`.trim();
  return name || null;
}

/**
 * The limits the generator recorded for a division, read from every team's stats: the largest
 * maximum and minimum any team carries (the generator gives every team of a division the same).
 * @param {any} rosterBalance - `rosterBalanceByDivision[div]`
 */
function recordedLimits(rosterBalance) {
  const teamStats = Array.isArray(rosterBalance?.teamStats) ? rosterBalance.teamStats : [];
  let maxRosterSize = null;
  let minRosterSize = positiveIntegerOrNull(rosterBalance?.summary?.minRosterSize);
  for (const entry of teamStats) {
    const max = positiveIntegerOrNull(entry?.maxRosterSize);
    if (max !== null && (maxRosterSize === null || max > maxRosterSize)) maxRosterSize = max;
    const min = positiveIntegerOrNull(entry?.minRosterSize);
    if (min !== null && (minRosterSize === null || min > minRosterSize)) minRosterSize = min;
  }
  // The generator writes a maximum on every team's stats; stats without one (a seeded or
  // hand-made run) say nothing about the limits, a missing minimum included.
  return { recorded: maxRosterSize !== null, maxRosterSize, minRosterSize };
}

/**
 * @typedef {{ teamId: string, teamName: string, playerCount: number }} TeamSize
 * @typedef {{ playerId: string, name: string, reason: string }} CapacityOverflowEntry
 * @typedef {{
 *   division: string,
 *   teamCount: number,
 *   playersPlaced: number | null,
 *   rostersKnown: boolean,
 *   limitsRecorded: boolean,
 *   minRosterSize: number | null,
 *   maxRosterSize: number | null,
 *   underMin: TeamSize[] | null,
 *   overMax: TeamSize[] | null,
 *   notPlacedForCapacity: CapacityOverflowEntry[],
 * }} DivisionTeamSizeOutcome
 */

/**
 * @param {any} result - `generateTeams`' result, or a stored run's `results`
 *   (`buildTeamReviewSnapshot`'s shape, whose team ids are the persisted ones)
 * @param {{ rosterSizeByTeamId?: Map<string, number> | null }} [options] - each team's current
 *   size, when the run's rows say where players are now; a team missing from it has none, unless
 *   the rows seat nobody on any of the division's teams (then its rosters are read instead)
 * @returns {{ divisions: DivisionTeamSizeOutcome[] } | null} null when the result holds no
 *   division's rosters
 */
export function summarizeTeamSizeOutcome(result, { rosterSizeByTeamId = null } = {}) {
  if (!isRecord(result) || !isRecord(result.teamsByDivision)) return null;
  const overflowByDivision = isRecord(result.overflowByDivision) ? result.overflowByDivision : {};
  const rosterBalanceByDivision = isRecord(result.rosterBalanceByDivision)
    ? result.rosterBalanceByDivision
    : {};
  const changesByDivision = isRecord(result.changeDiagnosticsByDivision)
    ? result.changeDiagnosticsByDivision
    : {};

  /** @type {DivisionTeamSizeOutcome[]} */
  const divisions = [];
  for (const [division, divisionTeams] of Object.entries(result.teamsByDivision)) {
    const teams = Array.isArray(divisionTeams) ? divisionTeams : [];
    // A generator id and its persisted id name one team: the generator's own diagnostics use
    // the first on a fresh team, the stored rosters the second.
    /** @type {Map<string, TeamSize>} */
    const sizeById = new Map();
    // A size is known from the run's rows, when they seat anyone on this division's teams (a
    // team they leave out has nobody), or else from each team's own roster; a team with neither
    // (a team row with no players array) leaves the division's sizes unknown, not zero.
    const rowsCoverDivision =
      rosterSizeByTeamId !== null && teams.some((team) => rosterSizeByTeamId.has(String(team?.id)));
    const rostersKnown = rowsCoverDivision || teams.every((team) => Array.isArray(team?.players));
    /** @type {TeamSize[]} */
    const sizes = teams.map((team) => {
      const teamId = String(team?.id);
      const rosterSize = Array.isArray(team?.players) ? team.players.length : 0;
      const playerCount = rowsCoverDivision ? (rosterSizeByTeamId?.get(teamId) ?? 0) : rosterSize;
      const size = { teamId, teamName: team?.name ? String(team.name) : teamId, playerCount };
      sizeById.set(teamId, size);
      if (team?.generatorId != null) sizeById.set(String(team.generatorId), size);
      return size;
    });

    const limits = recordedLimits(rosterBalanceByDivision[division]);
    const capacityViolations = changesByDivision[division]?.capacityViolations;
    const maxRosterSize =
      limits.maxRosterSize ??
      (Array.isArray(capacityViolations)
        ? (capacityViolations
            .map((entry) => positiveIntegerOrNull(entry?.maxRosterSize))
            .find((max) => max !== null) ?? null)
        : null);
    const minRosterSize = limits.recorded ? limits.minRosterSize : null;

    /** @type {TeamSize[] | null} */
    let overMax = null;
    if (sizes.length === 0) {
      overMax = [];
    } else if (rostersKnown && maxRosterSize !== null) {
      overMax = sizes.filter((size) => size.playerCount > maxRosterSize);
    } else if (Array.isArray(capacityViolations)) {
      // The generator's own check, with no maximum or no rosters to compare against.
      overMax = capacityViolations.map((entry) => {
        const teamId = String(entry?.teamId);
        const known = sizeById.get(teamId);
        return {
          teamId: known?.teamId ?? teamId,
          teamName: known?.teamName ?? teamId,
          playerCount: Number.isInteger(entry?.playerCount) ? entry.playerCount : 0,
        };
      });
    }

    /** @type {TeamSize[] | null} */
    let underMin = null;
    if (sizes.length === 0) {
      underMin = [];
    } else if (rostersKnown && limits.recorded) {
      // No minimum recorded on any team means none was set: no team can be under it.
      underMin =
        minRosterSize === null ? [] : sizes.filter((size) => size.playerCount < minRosterSize);
    }

    /** @type {CapacityOverflowEntry[]} */
    const notPlacedForCapacity = [];
    const overflow = Array.isArray(overflowByDivision[division])
      ? overflowByDivision[division]
      : [];
    for (const entry of overflow) {
      const reason = entry?.reason ? String(entry.reason) : null;
      if (!reason || !CAPACITY_OVERFLOW_REASONS.includes(reason)) continue;
      for (const player of Array.isArray(entry?.players) ? entry.players : []) {
        const playerId = String(player?.id);
        notPlacedForCapacity.push({ playerId, name: playerName(player) ?? playerId, reason });
      }
    }

    divisions.push({
      division,
      teamCount: sizes.length,
      playersPlaced: rostersKnown ? sizes.reduce((sum, size) => sum + size.playerCount, 0) : null,
      rostersKnown,
      limitsRecorded: limits.recorded,
      minRosterSize,
      maxRosterSize,
      underMin,
      overMax,
      notPlacedForCapacity,
    });
  }
  return divisions.length > 0 ? { divisions } : null;
}
