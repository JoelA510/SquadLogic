/**
 * The `results` of a team run, in the one shape every reader of one reads (PR 5, fix round 2).
 *
 * A saved team run is read by the Teams, Practices and Games pages (`mapSchedulerRunToSummary`, through
 * `useTeamSummary` and `useDashboardData`), by the team review's re-run (`useTeamPersistence`,
 * `buildPayloadByDivision`), by the placement and roster reviews and by the exports. They read the LATEST team run of the
 * season, and they read it through these keys, so a run that carries only some of them (the games import's first shell
 * runs carried `teams` and `team_players` and no `teamsByDivision`) leaves every team out of the summary without an error:
 * the pages show "no teams" for a league that has them.
 *
 * `TEAM_RUN_RESULT_KEYS` is that shape, named once. `carryTeamRunResults` is the one function that makes it for a run the
 * import writes: the latest run's results carried forward (every key it has, every division it names) and each division's
 * new shells added to the division. The SQL (`apply_game_import_job`) writes the same shape in SQL and
 * `tests/gameImportTeamRunShape.test.js` holds the migration text to this list, the pgTAP file asserts the keys of what
 * it wrote, and the same test runs every reader over this function's output.
 *
 * Pure: no React, no Supabase.
 */

/** The keys of a team run's `results` that its readers use. A run the import writes carries every one. */
export const TEAM_RUN_RESULT_KEYS = Object.freeze(['teamsByDivision', 'teams', 'team_players']);

/** @param {unknown} value @returns {Record<string, any>} */
const objectOf = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * The division a team row of an older or hand-made run names, as `groupTeamRows` keys it.
 * @param {Record<string, any>} team
 */
const keyOfTeamRow = (team) => String(team?.division || team?.division_id || 'Unassigned');

/**
 * The key under which a run groups a division's teams: the key it already uses for the division (the division's id or
 * name, or the key of a group whose teams carry the division's id), else the division's name (what the demo seed keys by
 * and what the Teams page shows as the heading). Keys are tried in byte order so the choice does not depend on how the
 * groups happen to be ordered.
 *
 * @param {Record<string, any[]>} grouped
 * @param {{ id: string, name: string }} division
 */
function keyForDivision(grouped, division) {
  const id = String(division.id).toLowerCase();
  const keys = Object.keys(grouped).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const found = keys.find((key) => {
    if (key.toLowerCase() === id || key === division.name) return true;
    return (Array.isArray(grouped[key]) ? grouped[key] : []).some(
      (team) => String(team?.division_id ?? team?.divisionId ?? '').toLowerCase() === id
    );
  });
  return found ?? division.name;
}

/**
 * The results of a new team run: the latest run's `results` carried forward whole, with each division's shells added to
 * the division's group of `teamsByDivision`, the flat `teams` rebuilt from the groups and `team_players` carried.
 *
 * @param {object} input
 * @param {Record<string, any> | null | undefined} input.base  the latest team run's `results` (null: none yet)
 * @param {Array<{ id: string, name: string, teams: Array<{ id: string, name: string }> }>} input.divisions
 *   the divisions that gained shells, each with its id and name and its new shells
 * @param {Array<Record<string, any>>} [input.ownTeams]  a division's own teams as the table holds them, used only for a
 *   division the base names nowhere (`id` of the division, then its teams)
 * @returns {Record<string, any>}
 */
export function carryTeamRunResults({ base, divisions, ownTeams = [] }) {
  const carried = objectOf(base);
  /** @type {Record<string, any[]>} */
  let grouped = {};
  if (carried.teamsByDivision && typeof carried.teamsByDivision === 'object') {
    for (const [key, teams] of Object.entries(objectOf(carried.teamsByDivision))) {
      grouped[key] = Array.isArray(teams) ? [...teams] : [];
    }
  } else if (Array.isArray(carried.teams)) {
    for (const team of carried.teams) {
      const key = keyOfTeamRow(team);
      (grouped[key] = grouped[key] ?? []).push(team);
    }
  }
  for (const division of divisions) {
    let key = keyForDivision(grouped, division);
    const named = Object.hasOwn(grouped, key);
    if (!named) {
      // The division is in no saved run: its own teams as the table has them (an outside club is not one).
      grouped[key] = ownTeams
        .filter(
          (team) => String(team.division_id).toLowerCase() === String(division.id).toLowerCase()
        )
        .map((team) => ({
          id: team.id,
          name: team.name,
          division: key,
          division_id: division.id,
          coachId: team.coach_id ?? null,
          assistantCoachIds: team.assistant_coach_ids ?? [],
          players: [],
        }));
    }
    const first = grouped[key][0];
    const label = String(first?.division || key);
    key = String(key);
    for (const shell of division.teams) {
      grouped[key].push({
        id: shell.id,
        name: shell.name,
        division: label,
        division_id: division.id,
        coachId: null,
        assistantCoachIds: [],
        players: [],
      });
    }
  }
  return {
    ...carried,
    teamsByDivision: grouped,
    teams: Object.values(grouped).flat(),
    team_players: Array.isArray(carried.team_players) ? carried.team_players : [],
  };
}
