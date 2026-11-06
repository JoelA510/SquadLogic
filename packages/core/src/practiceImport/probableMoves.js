/**
 * Probable moves on a re-import (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11.6, decision 24 and
 * the owner's change 4 of 2026-11-06; PR 9, task J2).
 *
 * A re-import of a practice file is **purely additive**: it changes nothing already saved and deletes
 * nothing. A team the new file puts in another cell therefore gets a new row, and its old row stays. The
 * preview shows the two lists a dry run returns, "in the schedule, not in this file" (`leaving`) and "new
 * in this file" (`arriving`), and, where both belong to the same team, a **probable move**.
 *
 * ## Paired at team level, never row to row
 *
 * "Team X: N rows leaving, M arriving." A team that swaps two days has two leaving rows and two arriving
 * rows, and matched row to row there are two readings, neither of them the file's word. So a move is the
 * team, with both its lists, and **no row is paired with a row**: there is no field that says which
 * leaving row an arriving one replaces. N need not equal M. A team with rows on one side only is not
 * paired: its leaving rows are listed as leaving only, its arriving rows are ordinary new rows.
 *
 * ## The new rows of a probable move arrive unticked
 *
 * `defaultTicked` is false for every arriving row of a team that has a move, true for every other new
 * row. The admin ticks to add, so a move does not silently leave a team over its count (the leaving rows
 * stay: an import never deletes). {@link selectedArrivals} turns the defaults and the admin's ticks into
 * the rows to add. **How an unticked row reaches `apply_practice_import_job` is PR 10's first design
 * task**; the plan fixes this behaviour and no signature.
 *
 * Over-counts are still flagged by the database under decision 20; `holdsIfAllTicked` says how many of
 * the move's rows the team would hold if every arriving row were ticked.
 *
 * Pure: it reads the two lists and nothing else, changes neither, and a list that a dry run cannot return
 * (a row without a team, a row twice, a row on both sides) is a defect in the caller and throws.
 */

/**
 * @typedef {Object} PracticeRowRef  a practice row as a dry run lists it; any other field is carried
 * @property {string} rowKey  identifies the row on its side of the preview
 * @property {string} teamId  the team (an id, not a label: two teams may share a name)
 * @property {string} [teamLabel]
 */

/**
 * @typedef {PracticeRowRef & Record<string, any>} PracticeRow  a row with whatever else the dry run carries
 */

/**
 * @param {unknown} list
 * @param {string} what
 * @returns {PracticeRow[]}
 */
function readRows(list, what) {
  if (!Array.isArray(list)) throw new TypeError(`pairProbableMoves: ${what} must be an array`);
  const seen = new Set();
  for (const row of list) {
    if (row === null || typeof row !== 'object') {
      throw new TypeError(`pairProbableMoves: ${what} holds something that is not a row`);
    }
    if (typeof row.teamId !== 'string' || row.teamId === '') {
      throw new TypeError(`pairProbableMoves: a row of ${what} has no teamId`);
    }
    if (typeof row.rowKey !== 'string' || row.rowKey === '') {
      throw new TypeError(`pairProbableMoves: a row of ${what} has no rowKey`);
    }
    if (seen.has(row.rowKey)) {
      throw new TypeError(
        `pairProbableMoves: row ${JSON.stringify(row.rowKey)} is listed twice in ${what}`
      );
    }
    seen.add(row.rowKey);
  }
  return list;
}

/** @param {string} a @param {string} b */
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {number} n */
const rows = (n) => `${n} ${n === 1 ? 'row' : 'rows'}`;

/**
 * Pair the rows a team is leaving with the rows it is arriving at.
 *
 * @param {{ leaving: PracticeRow[], arriving: PracticeRow[] }} input
 * @returns {{
 *   moves: Array<{
 *     teamId: string,
 *     teamLabel: string,
 *     leaving: PracticeRow[],
 *     arriving: PracticeRow[],
 *     leavingCount: number,
 *     arrivingCount: number,
 *     holdsIfAllTicked: number,
 *     defaultTicked: false,
 *     summary: string,
 *   }>,
 *   leavingOnly: Array<{ teamId: string, rows: PracticeRow[] }>,
 *   arrivingOnly: Array<{ teamId: string, rows: PracticeRow[] }>,
 *   arrivals: Array<PracticeRow & { probableMove: boolean, defaultTicked: boolean }>,
 * }}
 */
export function pairProbableMoves({ leaving, arriving }) {
  const left = readRows(leaving, 'leaving');
  const coming = readRows(arriving, 'arriving');
  const leftKeys = new Set(left.map((r) => r.rowKey));
  for (const r of coming) {
    if (leftKeys.has(r.rowKey)) {
      throw new TypeError(
        `pairProbableMoves: row ${JSON.stringify(r.rowKey)} is in both leaving and arriving`
      );
    }
  }

  /** @param {PracticeRow[]} list */
  const group = (list) => {
    /** @type {Map<string, PracticeRow[]>} */
    const out = new Map();
    for (const r of list) out.set(r.teamId, [...(out.get(r.teamId) ?? []), r]);
    return out;
  };
  const leftByTeam = group(left);
  const comingByTeam = group(coming);

  const moves = [];
  const leavingOnly = [];
  for (const teamId of [...leftByTeam.keys()].sort(byId)) {
    const l = leftByTeam.get(teamId);
    const a = comingByTeam.get(teamId);
    if (a === undefined) {
      leavingOnly.push({ teamId, rows: l });
      continue;
    }
    const teamLabel = l[0].teamLabel ?? a[0].teamLabel ?? teamId;
    moves.push({
      teamId,
      teamLabel,
      leaving: l,
      arriving: a,
      leavingCount: l.length,
      arrivingCount: a.length,
      holdsIfAllTicked: l.length + a.length,
      defaultTicked: /** @type {const} */ (false),
      summary: `team ${teamLabel}: ${rows(l.length)} leaving, ${a.length} arriving`,
    });
  }
  const arrivingOnly = [...comingByTeam.keys()]
    .filter((teamId) => !leftByTeam.has(teamId))
    .sort(byId)
    .map((teamId) => ({ teamId, rows: comingByTeam.get(teamId) }));

  const moving = new Set(moves.map((m) => m.teamId));
  const arrivals = coming.map((r) => ({
    ...r,
    probableMove: moving.has(r.teamId),
    defaultTicked: !moving.has(r.teamId),
  }));
  return { moves, leavingOnly, arrivingOnly, arrivals };
}

/**
 * The arriving rows to add: each row's default tick, overridden by the admin's.
 *
 * @param {{ arrivals: Array<PracticeRow & { defaultTicked: boolean }> }} result  from {@link pairProbableMoves}
 * @param {Record<string, boolean>} [ticks]  `rowKey` to the admin's tick
 * @returns {PracticeRow[]}
 * @throws {TypeError} on a tick that is not a boolean, or names no arriving row
 */
export function selectedArrivals(result, ticks = {}) {
  if (ticks === null || typeof ticks !== 'object' || Array.isArray(ticks)) {
    throw new TypeError('selectedArrivals: ticks must be an object of rowKey to boolean');
  }
  const known = new Set(result.arrivals.map((r) => r.rowKey));
  for (const [key, value] of Object.entries(ticks)) {
    if (!known.has(key)) {
      throw new TypeError(`selectedArrivals: ${JSON.stringify(key)} is not an arriving row`);
    }
    if (typeof value !== 'boolean') {
      throw new TypeError(
        `selectedArrivals: the tick for ${JSON.stringify(key)} must be a boolean`
      );
    }
  }
  return result.arrivals.filter((r) =>
    Object.hasOwn(ticks, r.rowKey) ? ticks[r.rowKey] : r.defaultTicked
  );
}
