/**
 * Effective-dated coach assignment rows (8.8 PR 2), read into the roster model.
 *
 * `team_coach_assignments` is the source of truth for who coaches which team
 * and when; `teams.coach_id` / `teams.assistant_coach_ids` are its current-state
 * denormalisation. This module is the app-side reader of that table, and it
 * answers two questions with it:
 *
 * 1. **Who coached this team on a date** ({@link coachesOfTeamOn}) — the
 *    question 8.8's acceptance names, and the one the columns cannot answer.
 * 2. **What a coaching change costs** ({@link coachChangeConsequence}) — the
 *    sole-coach register run before and after the change, so the operator sees
 *    which teams drop to one coach, or to none, before committing.
 *
 * **Dates are inclusive on both ends**, exactly as `windowCoversDate()` reads
 * them, because that is what the SQL writes: a change effective on day D ends
 * the old row on D - 1. A row whose `effective_to` precedes its
 * `effective_from` was started and ended on the same day and never took
 * effect; it is kept in the table (the lifecycle deletes nothing) and read
 * here as a withdrawn assignment, which `buildCoachRoster()` counts as
 * inactive rather than rejecting as malformed.
 *
 * {@link applyCoachChange} mirrors `public.set_team_coaches()` in
 * `supabase/migrations/20260923000000_team_coach_assignments.sql`, and the mock
 * client's twin uses it, so the preview, the mock and the database share one
 * contract rather than three.
 *
 * @module people/assignmentHistory
 */

import { ASSIGNMENT_STATUS, PEOPLE_REASON } from './reasonCodes.js';
import { buildCoachRoster, soleCoachRiskRegister, windowCoversDate } from './roster.js';
import { TEAM_COACH_ROLE, applyCoachChange, coachChangeRefusal } from './assignmentChange.js';

export { TEAM_COACH_ROLE, applyCoachChange, coachChangeRefusal };

/** @typedef {import('./assignmentChange.js').TeamCoachAssignmentRow} TeamCoachAssignmentRow */

/**
 * Did this row put its coach on the team on `date`? A never-in-effect row
 * (`effective_to` before `effective_from`) covers no date at all.
 *
 * @param {TeamCoachAssignmentRow} row
 * @param {string} date - `YYYY-MM-DD`
 * @returns {boolean}
 */
export function assignmentRowCovers(row, date) {
  const to = row.effective_to ?? null;
  if (to !== null && to < row.effective_from) return false;
  return windowCoversDate(date, row.effective_from, to);
}

/**
 * Who coached `teamId` on `date`, read from the assignment rows.
 *
 * @param {ReadonlyArray<TeamCoachAssignmentRow>} rows
 * @param {string} teamId
 * @param {string} date - `YYYY-MM-DD`
 * @returns {{ lead: string[], assistants: string[] }} coach ids, sorted
 */
export function coachesOfTeamOn(rows, teamId, date) {
  const lead = [];
  const assistants = [];
  for (const row of rows) {
    if (String(row.team_id) !== String(teamId) || !assignmentRowCovers(row, date)) continue;
    (row.role === TEAM_COACH_ROLE.LEAD ? lead : assistants).push(String(row.coach_id));
  }
  return { lead: lead.sort(), assistants: [...new Set(assistants)].sort() };
}

/**
 * The rows, as `buildCoachRoster()` input.
 *
 * People are keyed by coach id and carry the id as their name: the table holds
 * ids only (see the migration's note on erasure), and nothing in the register
 * reads a name. The page resolves ids to names for display.
 *
 * Slots: lead is 1; each assistant row of a team gets its own slot after it,
 * ordered by start date then coach id, so two assistants in office together
 * can never share one. Two concurrent LEAD rows share slot 1 on purpose — that
 * is a drifted table, and `ASSIGNMENT_SLOT_DUPLICATE` is the right report.
 *
 * @param {ReadonlyArray<TeamCoachAssignmentRow>} rows
 * @returns {{ people: Array<Object>, assignments: Array<Object> }}
 */
export function rosterInputFromAssignmentRows(rows) {
  const personIds = [...new Set(rows.map((row) => String(row.coach_id)))].sort();
  const people = personIds.map((id) => ({ id, givenName: id, familyName: id, displayName: id }));

  const assistantSlot = new Map();
  const assistants = rows
    .filter((row) => row.role === TEAM_COACH_ROLE.ASSISTANT)
    .sort((a, b) =>
      String(a.team_id) === String(b.team_id)
        ? a.effective_from === b.effective_from
          ? String(a.coach_id).localeCompare(String(b.coach_id))
          : a.effective_from.localeCompare(b.effective_from)
        : String(a.team_id).localeCompare(String(b.team_id))
    );
  const perTeam = new Map();
  for (const row of assistants) {
    const next = (perTeam.get(String(row.team_id)) ?? 1) + 1;
    perTeam.set(String(row.team_id), next);
    assistantSlot.set(row, next);
  }

  const assignments = rows.map((row, index) => {
    const to = row.effective_to ?? null;
    const neverInEffect = to !== null && to < row.effective_from;
    return {
      id: row.id ? String(row.id) : `row-${index}`,
      personId: String(row.coach_id),
      teamId: String(row.team_id),
      slot: row.role === TEAM_COACH_ROLE.LEAD ? 1 : /** @type {number} */ (assistantSlot.get(row)),
      status: neverInEffect ? ASSIGNMENT_STATUS.WITHDRAWN : ASSIGNMENT_STATUS.ASSIGNED,
      effectiveFrom: neverInEffect ? null : row.effective_from,
      effectiveTo: neverInEffect ? null : to,
      source: 'team_coach_assignments',
    };
  });
  return { people, assignments };
}

/**
 * The sole-coach register over every team, as of `asOf`.
 *
 * **The universe is `teamIds` — the teams table — not the rows.** A team with
 * no assignment row at all is absent from the roster `buildCoachRoster()`
 * builds, so the register alone would never call it uncoached; it is counted
 * here instead. A row naming a team outside the universe is returned, not
 * dropped.
 *
 * @param {ReadonlyArray<TeamCoachAssignmentRow>} rows
 * @param {ReadonlyArray<string>} teamIds
 * @param {string} asOf
 */
function coverageOf(rows, teamIds, asOf) {
  const roster = buildCoachRoster(rosterInputFromAssignmentRows(rows), { asOf });
  const register = soleCoachRiskRegister(roster);
  // **The register decides, not a head count taken beside it.** A team is
  // `sole` because the register listed it, and `uncoached` because the
  // register raised TEAM_UNCOACHED for it -- or because it has no row at all
  // and so never reached the roster (the universe note above).
  const soleBy = new Map(register.teams.map((entry) => [String(entry.teamId), entry.personId]));
  const uncoached = new Set(
    register.findings
      .filter((finding) => finding.code === PEOPLE_REASON.TEAM_UNCOACHED)
      .map((finding) => String(finding.details?.teamId))
  );
  /** @type {Map<string, { state: 'uncoached'|'sole'|'covered', soleCoachId: string|null }>} */
  const byTeam = new Map();
  for (const raw of teamIds) {
    const teamId = String(raw);
    if (!roster.teams.has(teamId) || uncoached.has(teamId)) {
      byTeam.set(teamId, { state: 'uncoached', soleCoachId: null });
    } else if (soleBy.has(teamId)) {
      byTeam.set(teamId, { state: 'sole', soleCoachId: String(soleBy.get(teamId)) });
    } else {
      byTeam.set(teamId, { state: 'covered', soleCoachId: null });
    }
  }
  const universe = new Set(teamIds.map(String));
  const outsideUniverse = [...roster.teams.keys()].filter((id) => !universe.has(id)).sort();
  return { register, byTeam, outsideUniverse };
}

/**
 * What a coaching change does to coverage, BEFORE it is committed.
 *
 * Runs `soleCoachRiskRegister()` over the current rows and over the rows as
 * {@link applyCoachChange} would leave them, both as of `effectiveOn`, and
 * reports the teams whose coverage moved: to one coach, to none, or back above
 * one. Teams whose coverage did not move are counted, not listed.
 *
 * **What it does not compute, said here so the preview can say it too:** which
 * games and practices the change touches, and which conflict checks it moves.
 * Those need the schedule, and this is a reading of the assignment table.
 *
 * @param {{
 *   rows: ReadonlyArray<TeamCoachAssignmentRow>,
 *   teamIds: ReadonlyArray<string>,
 *   change: { teamId: string, leadCoachId: string|null, assistantCoachIds: string[]|null },
 *   effectiveOn: string,
 * }} input
 */
export function coachChangeConsequence({ rows, teamIds, change, effectiveOn }) {
  if (!teamIds.map(String).includes(String(change.teamId))) {
    throw new Error(
      `coachChangeConsequence: team "${change.teamId}" is not in the team universe it was given`
    );
  }
  const before = coverageOf(rows, teamIds, effectiveOn);
  const applied = applyCoachChange(rows, change, effectiveOn);
  const after = coverageOf(applied.rows, teamIds, effectiveOn);

  const changes = [];
  for (const teamId of [...teamIds].map(String).sort()) {
    const was = /** @type {{state: string, soleCoachId: string|null}} */ (
      before.byTeam.get(teamId)
    );
    const now = /** @type {{state: string, soleCoachId: string|null}} */ (after.byTeam.get(teamId));
    // A sole team whose one coach CHANGED is still news: the person the team
    // depends on is a different person.
    if (was.state === now.state && was.soleCoachId === now.soleCoachId) continue;
    changes.push({
      teamId,
      effect: now.state,
      stateBefore: was.state,
      soleCoachId: now.soleCoachId,
    });
  }

  return {
    effectiveOn,
    teamsExamined: teamIds.length,
    changes,
    ended: applied.ended,
    started: applied.started,
    before: before.register,
    after: after.register,
    rowsOutsideUniverse: after.outsideUniverse,
  };
}

/**
 * The drift check's JS twin: do a team's coach columns equal its rows current
 * on `asOf`? Mirrors `public.team_coach_assignment_drift()`, and is how the
 * mock client's writers are tested for keeping the two in step.
 *
 * Enumerated from `teams`, one entry per team, so a team whose rows were lost
 * is reported rather than skipped.
 *
 * @param {{ teams: ReadonlyArray<{ id: string, coach_id?: string|null, assistant_coach_ids?: string[]|null }>, rows: ReadonlyArray<TeamCoachAssignmentRow>, asOf: string }} input
 * @returns {Array<{ teamId: string, inSync: boolean, columnLead: string[], assignmentLeads: string[], columnAssistants: string[], assignmentAssistants: string[] }>}
 */
export function coachColumnDrift({ teams, rows, asOf }) {
  return [...teams]
    .map((team) => {
      const current = coachesOfTeamOn(rows, team.id, asOf);
      const columnLead = team.coach_id == null ? [] : [String(team.coach_id)];
      const columnAssistants = [
        ...new Set((team.assistant_coach_ids ?? []).filter((id) => id != null).map(String)),
      ].sort();
      const inSync =
        columnLead.join('|') === current.lead.join('|') &&
        columnAssistants.join('|') === current.assistants.join('|');
      return {
        teamId: String(team.id),
        inSync,
        columnLead,
        assignmentLeads: current.lead,
        columnAssistants,
        assignmentAssistants: current.assistants,
      };
    })
    .sort((a, b) => a.teamId.localeCompare(b.teamId));
}
