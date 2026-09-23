/**
 * The row arithmetic of one coaching change, with no dependencies.
 *
 * Split out of `assignmentHistory.js` so the mock Supabase client -- which
 * ships in the main bundle -- can share the exact function the consequence
 * preview runs without pulling the roster model and its schemas in with it.
 * One contract for the preview, the mock and `public.set_team_coaches()`.
 *
 * @module people/assignmentChange
 */

/**
 * The two roles an assignment row carries. `slot` in the roster model is an
 * order, not a role; the adapter below maps lead to slot 1 and assistants to
 * the slots after it.
 *
 * @readonly
 * @enum {string}
 */
export const TEAM_COACH_ROLE = Object.freeze({
  LEAD: 'lead',
  ASSISTANT: 'assistant',
});

/**
 * @typedef {Object} TeamCoachAssignmentRow
 * @property {string} [id]
 * @property {string} team_id
 * @property {string} coach_id
 * @property {'lead'|'assistant'} role
 * @property {string} effective_from - `YYYY-MM-DD`, inclusive
 * @property {string|null} effective_to - `YYYY-MM-DD`, inclusive; null = open
 */

/** @param {string} date @param {number} days */
function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/**
 * The rows after a change, mirroring `public.set_team_coaches()`.
 *
 * `assistantCoachIds: null` leaves the assistants as they are, the SQL
 * writer's contract. Open rows the new state drops end on `effectiveOn - 1`;
 * appointments it adds start on `effectiveOn`. Nothing is removed.
 *
 * @param {ReadonlyArray<TeamCoachAssignmentRow>} rows
 * @param {{ teamId: string, leadCoachId: string|null, assistantCoachIds: string[]|null }} change
 * @param {string} effectiveOn - `YYYY-MM-DD`
 * @returns {{ rows: TeamCoachAssignmentRow[], ended: TeamCoachAssignmentRow[], started: TeamCoachAssignmentRow[] }}
 */
export function applyCoachChange(rows, change, effectiveOn) {
  const teamId = String(change.teamId);
  const lead = change.leadCoachId == null ? null : String(change.leadCoachId);
  const assistants =
    change.assistantCoachIds == null
      ? null
      : [...new Set(change.assistantCoachIds.filter((id) => id != null).map(String))];
  const dayBefore = addDays(effectiveOn, -1);

  const ended = [];
  const next = rows.map((row) => {
    if (String(row.team_id) !== teamId || row.effective_to != null) return row;
    const kept =
      row.role === TEAM_COACH_ROLE.LEAD
        ? String(row.coach_id) === lead
        : assistants === null || assistants.includes(String(row.coach_id));
    if (kept) return row;
    const closed = { ...row, effective_to: dayBefore };
    ended.push(closed);
    return closed;
  });

  const open = (role, coachId) =>
    next.some(
      (row) =>
        String(row.team_id) === teamId &&
        row.effective_to == null &&
        row.role === role &&
        String(row.coach_id) === coachId
    );
  const started = [];
  if (lead !== null && !open(TEAM_COACH_ROLE.LEAD, lead)) {
    started.push({
      team_id: teamId,
      coach_id: lead,
      role: TEAM_COACH_ROLE.LEAD,
      effective_from: effectiveOn,
      effective_to: null,
    });
  }
  for (const coachId of assistants ?? []) {
    if (open(TEAM_COACH_ROLE.ASSISTANT, coachId)) continue;
    started.push({
      team_id: teamId,
      coach_id: coachId,
      role: TEAM_COACH_ROLE.ASSISTANT,
      effective_from: effectiveOn,
      effective_to: null,
    });
  }
  return { rows: [...next, ...started], ended, started };
}

/**
 * Why `public.set_team_coaches()` would refuse this change, in its words, or
 * null. Checked only when the change moves a row, as the SQL checks it.
 *
 * - **Future**: the columns are current state, and nothing would move them
 *   when the date arrived.
 * - **Before the team's latest recorded change**: that would rewrite history
 *   already read. The floor is the latest start, or the day after the latest
 *   end, over every row of the team.
 *
 * @param {ReadonlyArray<TeamCoachAssignmentRow>} teamRows - every row of the team
 * @param {string} effectiveOn
 * @param {string} today - `YYYY-MM-DD`
 * @returns {string|null}
 */
export function coachChangeRefusal(teamRows, effectiveOn, today) {
  if (effectiveOn > today) {
    return `a coaching change cannot take effect in the future (${effectiveOn} is after ${today})`;
  }
  let floor = '';
  for (const row of teamRows) {
    const next = row.effective_to == null ? row.effective_from : addDays(row.effective_to, 1);
    const latest = next > row.effective_from ? next : row.effective_from;
    if (latest > floor) floor = latest;
  }
  return floor && effectiveOn < floor
    ? `this team's coaching history already runs to ${floor}; a change dated ${effectiveOn} would rewrite it`
    : null;
}
