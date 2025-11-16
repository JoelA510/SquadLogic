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
 * @param {Record<string, Object>} [result.overflowSummaryByDivision]
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
 *     overflowPlayersByReason: Record<string, number>,
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
    overflowSummaryByDivision = {},
  } = result;

  validateRecord(teamsByDivision, 'teamsByDivision');
  validateRecord(overflowByDivision, 'overflowByDivision');
  validateRecord(buddyDiagnosticsByDivision, 'buddyDiagnosticsByDivision');
  validateRecord(coachCoverageByDivision, 'coachCoverageByDivision');
  validateRecord(rosterBalanceByDivision, 'rosterBalanceByDivision');
  validateRecord(overflowSummaryByDivision, 'overflowSummaryByDivision');

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

    const {
      playersAssigned,
      totalCapacity,
      slotsRemaining,
    } = rosterBalance.teamStats.reduce(
      (stats, entry) => {
        stats.playersAssigned += entry.playerCount ?? 0;
        stats.totalCapacity += entry.maxRosterSize ?? 0;
        stats.slotsRemaining += Math.max(0, entry.slotsRemaining ?? 0);
        return stats;
      },
      { playersAssigned: 0, totalCapacity: 0, slotsRemaining: 0 },
    );

    const overflowRollup = buildOverflowRollup({
      entries: overflowEntries,
      summary: overflowSummaryByDivision[divisionId],
    });

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
      coachCoverage,
      mutualBuddyPairs: buddyDiagnostics.mutualPairs?.length ?? 0,
      unmatchedBuddyCount: buddyDiagnostics.unmatchedRequests?.length ?? 0,
      unmatchedBuddyReasons,
      overflowUnits: overflowRollup.units,
      overflowPlayers: overflowRollup.players,
      overflowByReason: overflowRollup.byReason,
      overflowPlayersByReason: overflowRollup.playersByReason,
    };

    divisions.push(divisionSummary);

    totals.teams += divisionSummary.totalTeams;
    totals.playersAssigned += playersAssigned;
    totals.overflowPlayers += overflowRollup.players;

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
  const allIds = Object.values(records).flatMap(Object.keys);
  return Array.from(new Set(allIds));
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

function buildOverflowRollup({ entries, summary }) {
  const derived = summarizeOverflowEntries(entries);

  if (!summary || typeof summary !== 'object') {
    return derived;
  }

  const overflowByReason = normalizeReasonCounts({
    byReason: summary.byReason,
    fallbackByReason: derived.byReason,
    field: 'units',
  });
  const overflowPlayersByReason = normalizeReasonCounts({
    byReason: summary.byReason,
    fallbackByReason: derived.byReason,
    field: 'players',
  });

  const players = Number.isFinite(summary.totalPlayers)
    ? summary.totalPlayers
    : derived.players;
  const units = Number.isFinite(summary.totalUnits)
    ? summary.totalUnits
    : derived.units;

  return {
    players,
    units,
    byReason: overflowByReason,
    playersByReason: overflowPlayersByReason,
  };
}

function summarizeOverflowEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { players: 0, units: 0, byReason: {} };
  }

  const rollup = { players: 0, units: 0, byReason: {} };
  for (const entry of entries) {
    rollup.units += 1;
    const playerCount = Array.isArray(entry.players) ? entry.players.length : 0;
    rollup.players += playerCount;

    const reason = entry.reason ?? 'unknown';
    const existing = rollup.byReason[reason] ?? { units: 0, players: 0 };
    existing.units += 1;
    existing.players += playerCount;
    rollup.byReason[reason] = existing;
  }

  return rollup;
}

function normalizeReasonCounts({ byReason, fallbackByReason, field }) {
  if (byReason && typeof byReason === 'object') {
    return Object.entries(byReason).reduce((acc, [reason, entry]) => {
      const value = entry?.[field];
      if (Number.isFinite(value)) {
        acc[reason] = value;
      }
      return acc;
    }, {});
  }

  if (fallbackByReason && typeof fallbackByReason === 'object') {
    return Object.entries(fallbackByReason).reduce((acc, [reason, entry]) => {
      const value = entry?.[field];
      if (Number.isFinite(value)) {
        acc[reason] = value;
      }
      return acc;
    }, {});
  }

  return {};
}
