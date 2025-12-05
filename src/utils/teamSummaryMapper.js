/**
 * Maps a scheduler run result (from Supabase scheduler_runs table)
 * to the summary format expected by TeamOverviewPanel.
 */
export function mapSchedulerRunToSummary(run) {
    if (!run || !run.results) {
        return null;
    }

    const { results, completed_at, created_at } = run;

    // Use completed_at if available, otherwise created_at
    const generatedAt = completed_at || created_at;

    // Extract high-level metrics from the results payload
    // The structure matches src/teamGeneration.js output
    const {
        teamsByDivision,
        overflowByDivision,
        overflowSummaryByDivision,
        buddyDiagnosticsByDivision,
        coachCoverageByDivision,
        rosterBalanceByDivision,
    } = results;

    // 1. Calculate Grand Totals
    const divisionKeys = Object.keys(teamsByDivision || {});
    const totalDivisions = divisionKeys.length;

    let totalTeams = 0;
    let totalPlayersAssigned = 0;
    let totalOverflow = 0;
    let divisionsNeedingCoaches = 0;
    let divisionsWithOpenRosterSlots = 0;

    divisionKeys.forEach((division) => {
        const teams = teamsByDivision[division] || [];
        totalTeams += teams.length;

        // Count players in teams
        teams.forEach(team => {
            totalPlayersAssigned += (team.players || []).length;
        });

        // Count overflow
        const overflowSummary = overflowSummaryByDivision?.[division];
        if (overflowSummary) {
            // totalPlayers might be nested or direct
            totalOverflow += (overflowSummary.totalPlayers || 0);
        }

        // Check coach needs
        const coverage = coachCoverageByDivision?.[division];
        if (coverage?.needsAdditionalCoaches) {
            divisionsNeedingCoaches++;
        }

        // Check open slots
        const rosterBalance = rosterBalanceByDivision?.[division];
        const openSlots = rosterBalance?.summary?.totalCapacity - rosterBalance?.summary?.totalPlayers;
        if (openSlots > 0) {
            divisionsWithOpenRosterSlots++;
        }
    });

    // 2. Map Division Summaries
    const divisions = divisionKeys.map((divisionId) => {
        const teams = teamsByDivision[divisionId] || [];
        const rosterBalance = rosterBalanceByDivision?.[divisionId];
        const coachCoverage = coachCoverageByDivision?.[divisionId];
        const buddyDiagnostics = buddyDiagnosticsByDivision?.[divisionId];
        const overflowSummary = overflowSummaryByDivision?.[divisionId];
        const overflowDetail = overflowByDivision?.[divisionId] || [];

        // Derive teams needing players
        const teamsNeedingPlayers = (rosterBalance?.teamStats || [])
            .filter(t => t.slotsRemaining > 0)
            .map(t => t.teamId);

        // Sum unmatched buddy reasons
        const unmatchedBuddyReasons = {};
        (buddyDiagnostics?.unmatchedRequests || []).forEach(req => {
            const reason = req.reason || 'unknown';
            unmatchedBuddyReasons[reason] = (unmatchedBuddyReasons[reason] || 0) + 1;
        });

        // Sum overflow reasons
        const overflowPlayersByReason = {};
        const overflowByReason = {}; // units

        if (overflowSummary?.byReason) {
            Object.entries(overflowSummary.byReason).forEach(([reason, stats]) => {
                overflowByReason[reason] = stats.units;
                overflowPlayersByReason[reason] = stats.players;
            });
        }

        return {
            divisionId,
            totalTeams: teams.length,
            playersAssigned: rosterBalance?.summary?.totalPlayers || 0,
            totalCapacity: rosterBalance?.summary?.totalCapacity || 0,
            averageFillRate: rosterBalance?.summary?.averageFillRate || 0,
            teamsNeedingPlayers,
            slotsRemaining: (rosterBalance?.summary?.totalCapacity || 0) - (rosterBalance?.summary?.totalPlayers || 0),
            needsAdditionalCoaches: coachCoverage?.needsAdditionalCoaches || false,
            coachCoverage: {
                totalTeams: coachCoverage?.totalTeams || 0,
                volunteerCoaches: coachCoverage?.volunteerCoaches || 0,
                teamsWithCoach: coachCoverage?.teamsWithCoach || 0,
                teamsWithoutCoach: coachCoverage?.teamsWithoutCoach || 0,
                coverageRate: coachCoverage?.coverageRate || 0,
                needsAdditionalCoaches: coachCoverage?.needsAdditionalCoaches || false,
            },
            mutualBuddyPairs: (buddyDiagnostics?.mutualPairs || []).length,
            unmatchedBuddyCount: (buddyDiagnostics?.unmatchedRequests || []).length,
            unmatchedBuddyReasons,
            overflowUnits: overflowSummary?.totalUnits || 0,
            overflowPlayers: overflowSummary?.totalPlayers || 0,
            overflowByReason,
            overflowPlayersByReason,
        };
    });

    return {
        generatedAt,
        totals: {
            divisions: totalDivisions,
            teams: totalTeams,
            playersAssigned: totalPlayersAssigned,
            overflowPlayers: totalOverflow,
            divisionsNeedingCoaches,
            divisionsWithOpenRosterSlots,
        },
        divisions,
    };
}
