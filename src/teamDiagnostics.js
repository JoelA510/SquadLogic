const EMPTY_BUDDY_DIAGNOSTICS = {
  mutualPairs: [],
  unmatchedRequests: [],
};

const EMPTY_COACH_COVERAGE = {
  totalTeams: 0,
  volunteerCoaches: 0,
  teamsWithCoach: 0,
  teamsWithoutCoach: 0,
  coverageRate: 0,
  needsAdditionalCoaches: false,
};

const EMPTY_ROSTER_BALANCE = {
  teamStats: [],
  summary: {
    totalPlayers: 0,
    totalCapacity: 0,
    averageFillRate: 0,
    teamsNeedingPlayers: [],
  },
};

/**
 * Produce UI friendly summary data from the team generation result payload.
 *
 * @param {Object} result - Output from `generateTeams` in `src/teamGeneration.js`.
 * @param {Record<string, Array>} result.teamsByDivision
 * @param {Record<string, Array>} result.overflowByDivision
 * @param {Record<string, Object>} result.buddyDiagnosticsByDivision
 * @param {Record<string, Object>} result.coachCoverageByDivision
 * @param {Record<string, Object>} result.rosterBalanceByDivision
 * @returns {{
 *   divisions: Array<{
 *     divisionId: string,
 *     totalTeams: number,
 *     playersAssigned: number,
 *     totalCapacity: number,
 *     averageFillRate: number,
 *     teamsNeedingPlayers: Array<string>,
 *     slotsRemaining: number,
 *     needsAdditionalCoaches: boolean,
 *     coachCoverage: typeof EMPTY_COACH_COVERAGE,
 *     mutualBuddyPairs: number,
 *     unmatchedBuddyCount: number,
 *     unmatchedBuddyReasons: Record<string, number>,
 *     overflowUnits: number,
 *     overflowPlayers: number,
 *     overflowByReason: Record<string, number>,
 *   }>,
 *   totals: {
 *     divisions: number,
 *     teams: number,
 *     playersAssigned: number,
 *     overflowPlayers: number,
 *     divisionsNeedingCoaches: number,
 *     divisionsWithOpenRosterSlots: number,
 *   },
 * }}
 */
export function summarizeTeamGeneration(result) {
  if (!result || typeof result !== 'object') {
    throw new TypeError('result must be an object');
  }

  const {
    teamsByDivision,
    overflowByDivision,
    buddyDiagnosticsByDivision,
    coachCoverageByDivision,
    rosterBalanceByDivision,
  } = result;

  validateRecord(teamsByDivision, 'teamsByDivision');
  validateRecord(overflowByDivision, 'overflowByDivision');
  validateRecord(buddyDiagnosticsByDivision, 'buddyDiagnosticsByDivision');
  validateRecord(coachCoverageByDivision, 'coachCoverageByDivision');
  validateRecord(rosterBalanceByDivision, 'rosterBalanceByDivision');

  const divisionIds = collectDivisionIds({
    teamsByDivision,
    overflowByDivision,
    buddyDiagnosticsByDivision,
    coachCoverageByDivision,
    rosterBalanceByDivision,
  });

  const divisions = [];
  const totals = {
    divisions: divisionIds.length,
    teams: 0,
    playersAssigned: 0,
    overflowPlayers: 0,
    divisionsNeedingCoaches: 0,
    divisionsWithOpenRosterSlots: 0,
  };

  for (const divisionId of divisionIds) {
    const teams = teamsByDivision[divisionId] ?? [];
    const overflowEntries = overflowByDivision[divisionId] ?? [];
    const buddyDiagnostics = buddyDiagnosticsByDivision[divisionId] ?? EMPTY_BUDDY_DIAGNOSTICS;
    const coachCoverage = coachCoverageByDivision[divisionId] ?? EMPTY_COACH_COVERAGE;
    const rosterBalance = rosterBalanceByDivision[divisionId] ?? EMPTY_ROSTER_BALANCE;

    const playersAssigned = rosterBalance.teamStats.reduce(
      (sum, entry) => sum + (entry.playerCount ?? 0),
      0,
    );
    const totalCapacity = rosterBalance.teamStats.reduce(
      (sum, entry) => sum + (entry.maxRosterSize ?? 0),
      0,
    );
    const slotsRemaining = rosterBalance.teamStats.reduce(
      (sum, entry) => sum + Math.max(0, entry.slotsRemaining ?? 0),
      0,
    );

    const overflowPlayers = overflowEntries.reduce(
      (sum, entry) => sum + (Array.isArray(entry.players) ? entry.players.length : 0),
      0,
    );
    const overflowByReason = aggregateByKey(overflowEntries, (entry) => entry.reason);

    const unmatchedBuddyReasons = aggregateByKey(
      buddyDiagnostics.unmatchedRequests,
      (entry) => entry.reason,
    );

    const divisionSummary = {
      divisionId,
      totalTeams: teams.length,
      playersAssigned,
      totalCapacity,
      averageFillRate: rosterBalance.summary?.averageFillRate ?? 0,
      teamsNeedingPlayers: rosterBalance.summary?.teamsNeedingPlayers ?? [],
      slotsRemaining,
      needsAdditionalCoaches: Boolean(coachCoverage.needsAdditionalCoaches),
      coachCoverage: coachCoverage ?? EMPTY_COACH_COVERAGE,
      mutualBuddyPairs: buddyDiagnostics.mutualPairs?.length ?? 0,
      unmatchedBuddyCount: buddyDiagnostics.unmatchedRequests?.length ?? 0,
      unmatchedBuddyReasons,
      overflowUnits: overflowEntries.length,
      overflowPlayers,
      overflowByReason,
    };

    divisions.push(divisionSummary);

    totals.teams += divisionSummary.totalTeams;
    totals.playersAssigned += playersAssigned;
    totals.overflowPlayers += overflowPlayers;

    if (divisionSummary.needsAdditionalCoaches) {
      totals.divisionsNeedingCoaches += 1;
    }
    if (divisionSummary.slotsRemaining > 0) {
      totals.divisionsWithOpenRosterSlots += 1;
    }
  }

  divisions.sort((a, b) => a.divisionId.localeCompare(b.divisionId));

  return { divisions, totals };
}

function validateRecord(value, name) {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${name} must be an object`);
  }
}

function collectDivisionIds(records) {
  const ids = new Set();
  for (const record of Object.values(records)) {
    for (const key of Object.keys(record)) {
      ids.add(key);
    }
  }
  return Array.from(ids);
}

function aggregateByKey(entries, keySelector) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {};
  }

  return entries.reduce((acc, entry) => {
    const key = keySelector(entry) ?? 'unknown';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}
