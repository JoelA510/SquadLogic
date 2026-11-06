/**
 * Counts the plants of `fixtures/practice-schedule-2026/` FROM THE CSV, with plain loops and no
 * knowledge of how the file was made (plan `docs/changes/2026-11-03-schedule-expansion.md` 4.11.7,
 * PR 9 task J1).
 *
 * This is the third count the fixture test holds the generator to: the generator keeps its own
 * bookkeeping of what it planted, and a second reading (this file) recounts every plant from the
 * rows alone. They agree, or one of them is wrong. Nothing here imports the product (`packages/core`)
 * or the generator: a count that shared code with what it checks would agree with it by construction.
 *
 * The subject sets come from the ROSTER (`teams.csv`, `divisions.csv`), never from the schedule
 * (lessons 46 and 92): a team the plants dropped from the file is still a team, and a count over the
 * file's own teams would not see it.
 *
 * Each measure is a definition, written here and in the README:
 *
 * | measure | counts |
 * | --- | --- |
 * | `shortTeams` | roster teams with fewer placement rows than their division's practices a week |
 * | `doublePlaced` | teams with two placement rows on one weekday at one start on DIFFERENT fields |
 * | `teamOnBothHalves` | teams with rows on two different halves of ONE field at one weekday and start |
 * | `overCapacity` | cells (one surface, weekday, start) holding more placement rows than their Capacity |
 * | `overlappingSlots` | pairs of distinct cells on one ground, one weekday, overlapping in time |
 * | `coachClashes` | coaches of two teams whose placements overlap in time on one weekday |
 * | `trailingWhitespace` | Team cells whose text differs from its trim |
 * | `holds` | rows whose Use is `hold` |
 */

/** @param {string} hhmm */
export const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The file's weekday words, in week order (the order a pattern is spelled in). */
const WEEK_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Strictly overlapping half-open intervals: back to back is not an overlap. */
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * @typedef {Object} SweepRow
 * @property {number} n  1-based row number
 * @property {string} rawTeam  the Team cell exactly as written
 * @property {string} team  trimmed
 * @property {string} division
 * @property {string} day
 * @property {number} start  minutes past midnight
 * @property {number} end
 * @property {string} location
 * @property {string} field
 * @property {string} subunit  '' for the whole field
 * @property {number} capacity
 * @property {boolean} hold
 * @property {boolean} placement  has a team and is not a hold
 */

/** @param {Array<Record<string, string>>} rows */
export function sweepRows(rows) {
  return rows.map(
    (r, i) =>
      /** @type {SweepRow} */ ({
        n: i + 1,
        rawTeam: r.Team ?? '',
        team: (r.Team ?? '').trim(),
        division: (r.Division ?? '').trim(),
        day: r.Day,
        start: minutesOf(r.Start),
        end: minutesOf(r.End),
        location: r.Location,
        field: r.Field,
        subunit: (r.Subunit ?? '').trim(),
        capacity: (r.Capacity ?? '').trim() === '' ? 1 : Number(r.Capacity),
        hold: (r.Use ?? '').trim().toLowerCase() === 'hold',
        placement: (r.Team ?? '').trim() !== '' && (r.Use ?? '').trim().toLowerCase() !== 'hold',
      })
  );
}

/** @param {SweepRow} r */
const cellOf = (r) => JSON.stringify([r.location, r.field, r.subunit, r.day, r.start]);

/**
 * The coach of each team, from `teams.csv`: coach name -> the teams they coach.
 *
 * @param {Array<Record<string, string>>} teamRows
 * @returns {Map<string, string[]>}
 */
export function coachTeams(teamRows) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const t of teamRows) {
    for (const name of [t['Coach 1'], t['Coach 2'], t['Coach 3']]) {
      if (!name) continue;
      out.set(name, [...(out.get(name) ?? []), t.Team]);
    }
  }
  return out;
}

/**
 * @param {Object} input
 * @param {Array<Record<string, string>>} input.rows  the schedule CSV
 * @param {Array<Record<string, string>>} input.teams  `teams.csv`
 * @param {Array<Record<string, string>>} input.divisions  `divisions.csv`
 * @returns {{
 *   counts: Record<string, number>,
 *   who: Record<string, string[]>,
 * }}
 */
export function countPlants({ rows, teams, divisions }) {
  const all = sweepRows(rows);
  const placements = all.filter((r) => r.placement);
  const perWeek = new Map(divisions.map((d) => [d.Division, Number(d['Practices Per Week'])]));

  /** @type {Record<string, string[]>} */
  const who = {
    shortTeams: [],
    doublePlaced: [],
    teamOnBothHalves: [],
    overCapacity: [],
    overlappingSlots: [],
    coachClashes: [],
    trailingWhitespace: [],
    holds: [],
  };

  // Short teams: the subject set is the roster.
  const rowsOf = new Map();
  for (const r of placements) rowsOf.set(r.team, [...(rowsOf.get(r.team) ?? []), r]);
  for (const t of teams) {
    const want = perWeek.get(t.Division);
    if (want === undefined)
      throw new Error(`practiceSweep: no divisions.csv row for ${t.Division}`);
    if ((rowsOf.get(t.Team) ?? []).length < want) who.shortTeams.push(t.Team);
  }

  // Double-placed and on both halves: two rows of one team at one weekday and start.
  for (const [team, list] of rowsOf) {
    let double = false;
    let halves = false;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.day !== b.day || a.start !== b.start) continue;
        const sameField = a.location === b.location && a.field === b.field;
        if (!sameField) double = true;
        else if (a.subunit !== '' && b.subunit !== '' && a.subunit !== b.subunit) halves = true;
      }
    }
    if (double) who.doublePlaced.push(team);
    if (halves) who.teamOnBothHalves.push(team);
  }

  // Over capacity: group the placement rows by cell.
  const cells = new Map();
  for (const r of placements) cells.set(cellOf(r), [...(cells.get(cellOf(r)) ?? []), r]);
  for (const [cell, list] of cells) {
    if (list.length > Math.max(...list.map((r) => r.capacity))) who.overCapacity.push(cell);
  }

  // Overlapping cells: distinct cells (rows of one cell are one slot), every pair on a ground.
  /** @type {Map<string, SweepRow>} */
  const slots = new Map();
  for (const r of all) if (!r.hold && !slots.has(cellOf(r))) slots.set(cellOf(r), r);
  const slotList = [...slots.values()];
  for (let i = 0; i < slotList.length; i += 1) {
    for (let j = i + 1; j < slotList.length; j += 1) {
      const a = slotList[i];
      const b = slotList[j];
      if (a.location !== b.location || a.field !== b.field || a.day !== b.day) continue;
      // a whole field (no subunit) against each of its halves; two different halves never clash
      const sameGround = a.subunit === '' || b.subunit === '' || a.subunit === b.subunit;
      if (sameGround && overlaps(a.start, a.end, b.start, b.end)) {
        who.overlappingSlots.push(JSON.stringify([cellOf(a), cellOf(b)]));
      }
    }
  }

  // Coach clashes: a coach of two teams, placements overlapping on one weekday.
  for (const [coach, coached] of coachTeams(teams)) {
    if (coached.length < 2) continue;
    const mine = placements.filter((r) => coached.includes(r.team));
    let clash = false;
    for (let i = 0; i < mine.length; i += 1) {
      for (let j = i + 1; j < mine.length; j += 1) {
        const a = mine[i];
        const b = mine[j];
        if (a.team !== b.team && a.day === b.day && overlaps(a.start, a.end, b.start, b.end)) {
          clash = true;
        }
      }
    }
    if (clash) who.coachClashes.push(coach);
  }

  for (const r of all)
    if (r.rawTeam !== r.rawTeam.trim()) who.trailingWhitespace.push(`row ${r.n}`);
  for (const r of all) if (r.hold) who.holds.push(`row ${r.n}`);

  const counts = Object.fromEntries(Object.entries(who).map(([k, v]) => [k, v.length]));
  return { counts, who };
}

/**
 * The shape of the file, in the terms of plan 4.11.1, counted from the rows.
 *
 * @param {Array<Record<string, string>>} rows
 */
export function shapeOf(rows) {
  const all = sweepRows(rows);
  const placements = all.filter((r) => r.placement);
  const minutes = (r) => r.end - r.start;
  const teamRows = new Map();
  for (const r of placements) teamRows.set(r.team, [...(teamRows.get(r.team) ?? []), r]);

  /** @type {Record<string, number>} */
  const patterns = {};
  let sameSlotBothDays = 0;
  let twoWeekday = 0;
  let sameWeekday = 0;
  let single = 0;
  let twoPractice = 0;
  for (const list of teamRows.values()) {
    if (list.length === 1) single += 1;
    else twoPractice += 1;
    const days = [...new Set(list.map((r) => r.day))];
    if (list.length >= 2 && days.length === 1) sameWeekday += 1;
    if (days.length !== 2) continue;
    twoWeekday += 1;
    const key = [...days].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b)).join('+');
    patterns[key] = (patterns[key] ?? 0) + 1;
    const where = (d) =>
      JSON.stringify(
        list
          .filter((r) => r.day === d)
          .map((r) => [r.location, r.field, r.subunit, r.start])
          .sort()
      );
    if (where(days[0]) === where(days[1])) sameSlotBothDays += 1;
  }

  // Labelled ground: every half. A half is used when it has a placement, or its field has a
  // whole-field placement (the grid's merged cell covers both halves).
  const halves = new Set(
    all.filter((r) => r.subunit !== '').map((r) => JSON.stringify([r.location, r.field, r.subunit]))
  );
  const wholeFields = new Set(
    placements.filter((r) => r.subunit === '').map((r) => JSON.stringify([r.location, r.field]))
  );
  const usedHalves = new Set();
  for (const r of placements) {
    if (r.subunit !== '') usedHalves.add(JSON.stringify([r.location, r.field, r.subunit]));
  }
  for (const h of halves) {
    const [location, field] = JSON.parse(h);
    if (wholeFields.has(JSON.stringify([location, field]))) usedHalves.add(h);
  }

  return {
    rows: all.length,
    placements: placements.length,
    placements45: placements.filter((r) => minutes(r) === 45).length,
    placements60: placements.filter((r) => minutes(r) === 60).length,
    open: all.filter((r) => !r.hold && r.team === '').length,
    holds: all.filter((r) => r.hold).length,
    teamsWithRows: teamRows.size,
    singlePractice: single,
    twoPractice,
    twoWeekday,
    sameWeekday,
    patterns,
    sameSlotBothDays,
    venues: new Set(all.map((r) => r.location)).size,
    fields: new Set(all.map((r) => JSON.stringify([r.location, r.field]))).size,
    labelledRows: halves.size,
    usedLabelledRows: usedHalves.size,
    wholeFieldPlacements: placements.filter((r) => r.subunit === '').length,
  };
}
