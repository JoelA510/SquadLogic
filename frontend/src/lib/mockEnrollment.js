/**
 * The mock's side of per-season enrollment (migration `20261108010000_season_enrollment.sql`,
 * Phase E3a; plan `docs/changes/2026-10-27-season-enrollment.md`): a player or a coach row belongs
 * to one season, and the import matches in the destination season only.
 *
 * **What the SQL does and this mirrors.**
 *   - A trigger fills a new player's `season_settings_id` (its division's season, else the
 *     organization's active season) and a coach's (the active season). The mock database is
 *     assembled from seed rows and test-injected rows, so {@link normalizeEnrollment} applies the
 *     rule when the database is read, which is where the SQL applies it when a row is written.
 *   - A player's division and team are in the player's own season; a roster row, a buddy pair, a
 *     team's coach and a coach's child are of one season. The refusals below carry the SQL's
 *     codes: 22023 from the RPCs (`season_mismatch`), 23514 from the table triggers.
 *   - An import resolves its destination season as the SQL does (the job's own, else the active
 *     one); {@link importSeasonRefusal} is the refusal for an organization with no season.
 *
 * Pure over `db`, so a test can drive it directly.
 */

const same = (a, b) => String(a) === String(b);

/** The organization's one active season row, or undefined. */
export function activeSeasonOf(db, organizationId) {
  return (db.season_settings || []).find(
    (season) => same(season.organization_id, organizationId) && season.status === 'active'
  );
}

/** The season a division is in, or null when the division is unknown. */
function seasonOfDivision(db, divisionId) {
  if (!divisionId) return null;
  const division = (db.divisions || []).find((item) => same(item.id, divisionId));
  return division?.season_settings_id ?? null;
}

/** The season a team is in (its division's), or null when the team or division is unknown. */
function seasonOfTeam(db, teamId) {
  if (!teamId) return null;
  const team = (db.teams || []).find((item) => same(item.id, teamId));
  return team ? seasonOfDivision(db, team.division_id) : null;
}

/**
 * The season row an import job adds to: the job's own, else the organization's active season.
 * @returns {any | undefined}
 */
export function importSeasonOf(db, job) {
  return (db.season_settings || []).find(
    (season) =>
      same(season.organization_id, job.organization_id) &&
      (job.season_settings_id
        ? same(season.id, job.season_settings_id)
        : season.status === 'active')
  );
}

/**
 * Applies the two fill triggers to `db` in place: a player without a season takes its division's
 * (else the organization's active season), a coach the active season; and a `view_org_metrics` row
 * without one is the active season's. A row that already has one is left alone. Idempotent.
 * @param {any} db
 * @returns {any} db
 */
export function normalizeEnrollment(db) {
  for (const player of db.players || []) {
    if (player.season_settings_id) continue;
    const season =
      seasonOfDivision(db, player.division_id) ??
      activeSeasonOf(db, player.organization_id)?.id ??
      null;
    if (season) player.season_settings_id = season;
  }
  for (const coach of db.coaches || []) {
    if (coach.season_settings_id) continue;
    const season = activeSeasonOf(db, coach.organization_id)?.id ?? null;
    if (season) coach.season_settings_id = season;
  }
  // `view_org_metrics` has one row per season of an organization. A test-injected row that names
  // no season is the active season's.
  for (const metrics of db.view_org_metrics || []) {
    if (metrics.season_settings_id) continue;
    const season = activeSeasonOf(db, metrics.organization_id)?.id ?? null;
    if (season) metrics.season_settings_id = season;
  }
  return db;
}

/** An RPC refusal in the SQL's shape (22023, with the DETAIL the SQL names). */
export const enrollmentRefusal = (message, detail, code = '22023') => ({
  data: null,
  error: { code, message, ...(detail ? { details: detail } : {}) },
});

/** `finalize_import_job` / `finalize_coach_import_job` for an organization with no season. */
export const importSeasonMissing = (organizationId) =>
  enrollmentRefusal(
    `Organization ${organizationId} has no season to import into`,
    'season_missing'
  );

/**
 * `apply_player_patch`'s refusal of a division or team outside the player's season, or null.
 * @param {any} db
 * @param {{ season_settings_id?: string | null }} player
 * @param {Record<string, any>} patch the sanitized patch (only the keys it names are judged)
 */
export function playerPatchSeasonRefusal(db, player, patch) {
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
  if (has('division_id') && patch.division_id) {
    if (!same(seasonOfDivision(db, patch.division_id) ?? '', player.season_settings_id ?? '')) {
      return enrollmentRefusal(
        `division ${patch.division_id} is not in the player's season`,
        'season_mismatch'
      );
    }
  }
  if (has('team_id') && patch.team_id) {
    if (!same(seasonOfTeam(db, patch.team_id) ?? '', player.season_settings_id ?? '')) {
      return enrollmentRefusal(
        `team ${patch.team_id} is not in the player's season`,
        'season_mismatch'
      );
    }
  }
  return null;
}

/** A table trigger's refusal (23514). */
export const seasonTriggerRefusal = (message) =>
  enrollmentRefusal(message, 'season_mismatch', '23514');

/** The coach-assignment trigger's refusal, or null: the coach and the team's season must match. */
export function coachTeamSeasonRefusal(db, coachId, teamId) {
  if (!coachId) return null;
  const coach = (db.coaches || []).find((item) => same(item.id, coachId));
  const teamSeason = seasonOfTeam(db, teamId);
  if (coach?.season_settings_id && teamSeason && !same(coach.season_settings_id, teamSeason)) {
    return seasonTriggerRefusal(
      `a team's coaches are of its own season: coach ${coachId} is in another season than team ${teamId}`
    );
  }
  return null;
}
