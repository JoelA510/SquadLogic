/**
 * What a practice preference file will do, worked out in the browser before anything is uploaded
 * (Phase D C2). The JavaScript twin of the body of `finalize_practice_preference_import_job`
 * (migration 20261112010000), the way `practicePreferenceRows.js` is the twin of its row parsing:
 * the same coach lookup (by email, within the season), the same team lookup (by name within the
 * season, or each team the coach coaches today when the team is blank), the same refusals, the same
 * once-only rule for identical rows and the same replacement of the imported rules of the teams the
 * file names. Its answer is the finalizer's result before the finalizer runs.
 *
 * `tests/preferenceImport.test.jsx` runs the mock finalizer (itself held to the SQL by
 * `tests/coachPreferencesMock.test.js` and `supabase/tests/practice_preference_import.sql`) over the
 * same inputs and requires every count here to equal the one it returns, so a rule changed in one
 * place and not the other turns that test red.
 *
 * A row is read in this order, and the first problem found is the row's: its own content (the same
 * `parsePreferenceRow` the mock finalizer reads), then the coach, then the team. An unknown coach or
 * team is listed and never created.
 */

import { parsePreferenceRow } from './practicePreferenceRows.js';

/** The reasons a row is not applied, as the finalizer counts them. */
export const ROW_REFUSAL = Object.freeze({
  INVALID: 'invalid',
  UNKNOWN_COACH: 'unknown_coach',
  UNKNOWN_TEAM: 'unknown_team',
  NO_TEAM: 'no_team',
  NOT_ON_TEAM: 'not_on_team',
});

/** @param {unknown} left @param {unknown} right */
const same = (left, right) => String(left) === String(right);

/**
 * @typedef {Object} PreviewContext
 * @property {string} seasonId - the season the import adds to
 * @property {Array<{ id: string, email?: string | null, full_name?: string | null, season_settings_id?: string | null }>} coaches
 * @property {Array<{ id: string, name: string, division_id?: string | null }>} teams
 * @property {Array<{ id: string, season_settings_id?: string | null }>} divisions
 * @property {Array<{ team_id: string, coach_id: string, effective_from: string, effective_to?: string | null }>} assignments
 * @property {Array<{ id: string, name: string }>} locations
 * @property {any[]} ruleRows - `coach_practice_preferences` rows of the organization
 * @property {string} today - the database's day, `YYYY-MM-DD`
 */

/**
 * @param {Object} input
 * @param {Array<{ row: number, payload: Record<string, string> }>} input.staged - the rows that
 *   reach the finalizer (`readPreferenceFile`)
 * @param {PreviewContext} input.context
 */
export function previewPracticePreferenceImport({ staged, context }) {
  const { seasonId, coaches, teams, divisions, assignments, locations, ruleRows, today } = context;

  const seasonDivisionIds = new Set(
    divisions
      .filter((division) => same(division.season_settings_id, seasonId))
      .map((division) => String(division.id))
  );
  const seasonTeams = teams.filter((team) => seasonDivisionIds.has(String(team.division_id)));
  const seasonCoaches = coaches.filter((coach) => same(coach.season_settings_id, seasonId));
  const teamName = (teamId) =>
    String(seasonTeams.find((team) => same(team.id, teamId))?.name ?? teamId);
  const coachesToday = (teamId, coachId) =>
    assignments.some(
      (a) =>
        same(a.team_id, teamId) &&
        same(a.coach_id, coachId) &&
        a.effective_from <= today &&
        (a.effective_to == null || a.effective_to >= today)
    );

  const counts = {
    invalid_rows: 0,
    unknown_coach_rows: 0,
    unknown_team_rows: 0,
    no_team_rows: 0,
    coach_not_on_team_rows: 0,
    duplicate_rule_rows: 0,
  };
  /** @type {Array<{ row: number, kind: string, message: string, email?: string, team?: string }>} */
  const refusals = [];
  /** @type {Array<{ row: number, email: string, teams: string[] }>} */
  const fanOut = [];
  const seen = new Set();
  /** @type {any[]} */
  const rules = [];

  const refuse = (row, kind, message, extra = {}) => {
    const key = {
      [ROW_REFUSAL.INVALID]: 'invalid_rows',
      [ROW_REFUSAL.UNKNOWN_COACH]: 'unknown_coach_rows',
      [ROW_REFUSAL.UNKNOWN_TEAM]: 'unknown_team_rows',
      [ROW_REFUSAL.NO_TEAM]: 'no_team_rows',
      [ROW_REFUSAL.NOT_ON_TEAM]: 'coach_not_on_team_rows',
    }[kind];
    counts[key] += 1;
    refusals.push({ row, kind, message, ...extra });
  };

  const ordered = [...staged].sort((a, b) => a.row - b.row);
  for (const { row, payload } of ordered) {
    const parsed = parsePreferenceRow(payload, { locations });
    if (!parsed.ok) {
      refuse(row, ROW_REFUSAL.INVALID, parsed.message ?? 'The row could not be read');
      continue;
    }
    const rule = /** @type {NonNullable<typeof parsed.rule>} */ (parsed.rule);
    const coach = seasonCoaches.find((c) => String(c.email ?? '').toLowerCase() === rule.email);
    if (!coach) {
      refuse(row, ROW_REFUSAL.UNKNOWN_COACH, 'No coach with this email in the season', {
        email: rule.email,
      });
      continue;
    }

    /** @type {string[]} */
    let teamIds;
    if (rule.team !== null) {
      const wanted = rule.team.trim().toLowerCase();
      const matches = seasonTeams.filter(
        (team) => String(team.name).trim().toLowerCase() === wanted
      );
      if (matches.length === 0) {
        refuse(row, ROW_REFUSAL.UNKNOWN_TEAM, 'No team with this name in the season', {
          team: rule.team,
        });
        continue;
      }
      if (matches.length > 1) {
        refuse(row, ROW_REFUSAL.INVALID, 'More than one team in the season has this name');
        continue;
      }
      if (!coachesToday(matches[0].id, coach.id)) {
        refuse(row, ROW_REFUSAL.NOT_ON_TEAM, 'The coach does not coach this team', {
          team: rule.team,
        });
        continue;
      }
      teamIds = [String(matches[0].id)];
    } else {
      teamIds = [
        ...new Set(
          assignments
            .filter(
              (a) =>
                same(a.coach_id, coach.id) &&
                seasonTeams.some((team) => same(team.id, a.team_id)) &&
                a.effective_from <= today &&
                (a.effective_to == null || a.effective_to >= today)
            )
            .map((a) => String(a.team_id))
        ),
      ].sort();
      if (teamIds.length === 0) {
        refuse(
          row,
          ROW_REFUSAL.NO_TEAM,
          'The row names no team and the coach coaches none in the season',
          { email: rule.email }
        );
        continue;
      }
      if (teamIds.length > 1) {
        fanOut.push({ row, email: rule.email, teams: teamIds.map(teamName) });
      }
    }

    for (const teamId of teamIds) {
      const signature = JSON.stringify([
        teamId,
        String(coach.id),
        rule.requestedLevel,
        rule.weekdays,
        rule.startMinutes,
        rule.venueIds,
        rule.effectiveFrom,
        rule.effectiveTo,
        rule.coachPriority,
      ]);
      if (seen.has(signature)) {
        counts.duplicate_rule_rows += 1;
      } else {
        seen.add(signature);
        rules.push({
          ...rule,
          row,
          teamId,
          teamName: teamName(teamId),
          coachId: String(coach.id),
          coachName: coach.full_name ?? rule.email,
        });
      }
    }
  }

  // The imported rules of the teams the file names are replaced; admin rules and imported rules on
  // other teams are not. A replaced rule that was an accepted must comes back pending.
  const named = new Set(rules.map((rule) => rule.teamId));
  const replaced = ruleRows.filter(
    (existing) =>
      existing.source === 'import' &&
      existing.status === 'in_force' &&
      named.has(String(existing.team_id))
  );
  const acceptedMustsReplaced = replaced.filter((existing) => existing.level === 'must');

  return {
    rows_read: ordered.length,
    inserted_rules: rules.length,
    replaced_rules: replaced.length,
    accepted_musts_replaced: acceptedMustsReplaced.length,
    teams_named: named.size,
    pending_musts: rules.filter((rule) => rule.requestedLevel === 'must').length,
    ...counts,
    rules,
    refusals,
    fanOut,
    /** Nothing in the file can be applied: the import would insert no rule and replace none. */
    nothingToApply: rules.length === 0,
  };
}
