import { escapeCsvCell } from './csv.js';
import { coachExportCells, coachesOfTeamRow } from './people/coachList.js';

/**
 * The schedule exports: one row per team per event, in a fixed column order.
 *
 * ## Why there is no `Coach Name` column any more (8.2)
 *
 * There used to be three coach columns: `Coach Name`, `Coach Email` and
 * `Assistant Coaches`. That shape states a hierarchy — one named coach, and
 * everybody else filed under "assistant" — which the rec league this corpus
 * comes from does not run, and which nothing in the model can actually
 * substantiate. The coach *order* is real and survives: it is the club's
 * declared order and `people/roster.js` uses it to break clashes. The *role* is
 * not, so it is gone from the artifact.
 *
 * Every coach is now exported, in order, in one `Coaches` column, through the
 * single producer in `people/coachList.js`. A team with three coaches prints
 * three; the old shape printed one in `Coach Name` and hoped whoever read the
 * CSV noticed the last column.
 */
const HEADERS = {
  TEAM_ID: 'Team ID',
  TEAM_NAME: 'Team Name',
  DIVISION: 'Division',
  COACHES: 'Coaches',
  COACH_EMAILS: 'Coach Emails',
  EVENT_TYPE: 'Event Type',
  OPPONENT: 'Opponent',
  ROLE: 'Role',
  START: 'Start',
  END: 'End',
  FIELD: 'Field',
  SLOT: 'Slot',
  NOTES: 'Notes',
};

const MASTER_HEADERS = Object.values(HEADERS);

/**
 * The export column vocabulary, published so other modules can emit rows this
 * function would accept without keeping a second copy of the header names.
 *
 * Added for `packages/core/src/reserve/publication.js`, which projects reserved
 * slots and TIME TBD fixtures into these columns. `generateScheduleExports()`
 * below now builds its header list from the same constant rather than repeating
 * it, so the two sides cannot drift into two spellings of the same column.
 */
export const SCHEDULE_EXPORT_HEADERS = Object.freeze({ ...HEADERS });

/** The master export's columns, in order. */
export const SCHEDULE_EXPORT_COLUMNS = Object.freeze([...MASTER_HEADERS]);

/**
 * Generate flattened schedule exports for practices and games.
 *
 * A team may state its coaches as a `coaches` list (`{ personId, displayName,
 * email, slot }`), as the legacy `coachName` / `coachEmail` /
 * `assistantCoaches` fields, or as both. Both are read as *sources* and
 * reconciled by `people/coachList.js`: the union is exported and any
 * disagreement between them comes back in `coachFindings` rather than being
 * settled here.
 *
 * @param {Object} params
 * @param {Array<Object>} params.teams
 * @param {Array<Object>} [params.practiceAssignments=[]]
 * @param {Array<Object>} [params.gameAssignments=[]]
 * @param {string} [params.timezone]
 * @returns {{ master: { headers: Array<string>, rows: Array<Object>, csv: string }, perTeam: Array<{ teamId: string, headers: Array<string>, rows: Array<Object>, csv: string }>, coachFindings: Array<Object> }}
 */
export function generateScheduleExports({
  teams,
  practiceAssignments = [],
  gameAssignments = [],
  timezone = undefined,
}) {
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  // ... (existing validation)
  if (!Array.isArray(practiceAssignments)) {
    throw new TypeError('practiceAssignments must be an array');
  }
  if (!Array.isArray(gameAssignments)) {
    throw new TypeError('gameAssignments must be an array');
  }

  const teamDirectory = new Map();
  /** @type {Array<Object>} */
  const coachFindings = [];
  for (const team of teams) {
    if (!team || typeof team !== 'object') {
      throw new TypeError('each team must be an object');
    }
    if (!team.id) {
      throw new TypeError('each team requires an id');
    }

    const reconciled = coachesOfTeamRow(team);
    coachFindings.push(...reconciled.findings);

    // Both cells from one producer, which refuses a pair that does not line
    // up: two functions with two rules about which coaches to skip is how the
    // name cell and the address cell came to disagree.
    const cells = coachExportCells(reconciled.coaches);
    const sanitized = {
      id: team.id,
      name: team.name ?? team.id,
      division: team.division ?? '',
      coaches: cells.coaches,
      coachEmails: cells.emails,
    };
    teamDirectory.set(team.id, sanitized);
  }

  const masterRows = [];
  const teamRows = new Map();

  const pushRow = (teamId, row) => {
    masterRows.push(row);
    const bucket = teamRows.get(teamId) ?? [];
    bucket.push(row);
    teamRows.set(teamId, bucket);
  };

  for (const assignment of practiceAssignments) {
    validatePracticeAssignment(assignment);
    const team = teamDirectory.get(assignment.teamId);
    if (!team) {
      throw new Error(`practice assignment references unknown team ${assignment.teamId}`);
    }

    const row = formatRow({
      team,
      opponentTeamId: null,
      opponentName: null,
      eventType: 'Practice',
      start: assignment.start,
      end: assignment.end,
      fieldId: assignment.fieldId ?? '',
      slotId: assignment.slotId ?? '',
      notes: assignment.notes ?? '',
      role: '',
      timezone,
    });

    pushRow(team.id, row);
  }

  for (const assignment of gameAssignments) {
    validateGameAssignment(assignment);

    const homeTeam = teamDirectory.get(assignment.homeTeamId);
    if (!homeTeam) {
      throw new Error(`game assignment references unknown team ${assignment.homeTeamId}`);
    }
    const awayTeam = teamDirectory.get(assignment.awayTeamId);
    if (!awayTeam) {
      throw new Error(`game assignment references unknown team ${assignment.awayTeamId}`);
    }

    const baseDetails = {
      eventType: 'Game',
      start: assignment.start,
      end: assignment.end,
      fieldId: assignment.fieldId ?? '',
      slotId: assignment.slotId ?? '',
      notes: assignment.notes ?? '',
      timezone,
    };

    const homeRow = formatRow({
      team: homeTeam,
      opponentTeamId: awayTeam.id,
      opponentName: awayTeam.name,
      role: 'Home',
      ...baseDetails,
    });
    pushRow(homeTeam.id, homeRow);

    const awayRow = formatRow({
      team: awayTeam,
      opponentTeamId: homeTeam.id,
      opponentName: homeTeam.name,
      role: 'Away',
      ...baseDetails,
    });
    pushRow(awayTeam.id, awayRow);
  }

  masterRows.sort(compareRows);
  for (const rows of teamRows.values()) {
    rows.sort(compareRows);
  }

  const headers = [...SCHEDULE_EXPORT_COLUMNS];

  return {
    master: {
      headers: headers.slice(),
      rows: masterRows.map((row) => ({ ...row })),
      csv: formatCsv(headers, masterRows),
    },
    perTeam: Array.from(teamRows.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([teamId, rows]) => ({
        teamId,
        headers: headers.slice(),
        rows: rows.map((row) => ({ ...row })),
        csv: formatCsv(headers, rows),
      })),
    coachFindings,
  };
}

// ... validation functions ...

function validatePracticeAssignment(assignment) {
  if (!assignment || typeof assignment !== 'object') {
    throw new TypeError('each practice assignment must be an object');
  }
  if (!assignment.teamId) {
    throw new TypeError('practice assignments require teamId');
  }
  if (!assignment.start || !assignment.end) {
    throw new TypeError('practice assignments require start and end');
  }
}

function validateGameAssignment(assignment) {
  if (!assignment || typeof assignment !== 'object') {
    throw new TypeError('each game assignment must be an object');
  }
  if (!assignment.homeTeamId || !assignment.awayTeamId) {
    throw new TypeError('game assignments require homeTeamId and awayTeamId');
  }
  if (!assignment.start || !assignment.end) {
    throw new TypeError('game assignments require start and end');
  }
}

function formatRow({
  team,
  opponentTeamId,
  opponentName,
  eventType,
  start,
  end,
  fieldId,
  slotId,
  notes,
  role,
  timezone,
}) {
  const normalizedStart = normalizeDate(start, timezone);
  const normalizedEnd = normalizeDate(end, timezone);

  const opponent = opponentName ?? opponentTeamId ?? '';

  return {
    [HEADERS.TEAM_ID]: team.id,
    [HEADERS.TEAM_NAME]: team.name,
    [HEADERS.DIVISION]: team.division,
    [HEADERS.COACHES]: team.coaches,
    [HEADERS.COACH_EMAILS]: team.coachEmails,
    [HEADERS.EVENT_TYPE]: eventType,
    [HEADERS.OPPONENT]: opponent,
    [HEADERS.ROLE]: role,
    [HEADERS.START]: normalizedStart,
    [HEADERS.END]: normalizedEnd,
    [HEADERS.FIELD]: fieldId,
    [HEADERS.SLOT]: slotId,
    [HEADERS.NOTES]: notes,
  };
}

function normalizeDate(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('invalid date provided to export formatter');
  }
  if (timezone) {
    return date.toLocaleString('en-US', { timeZone: timezone });
  }
  return date.toISOString();
}

function compareRows(a, b) {
  const startComparison = a[HEADERS.START].localeCompare(b[HEADERS.START]);
  if (startComparison !== 0) {
    return startComparison;
  }
  return a[HEADERS.TEAM_ID].localeCompare(b[HEADERS.TEAM_ID]);
}

/**
 * Convert rows into a CSV string using the supplied headers.
 *
 * @param {Array<string>} headers
 * @param {Array<Object>} rows
 * @returns {string}
 */
export function formatCsv(headers, rows) {
  if (!Array.isArray(headers)) {
    throw new TypeError('headers must be an array');
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }

  const headerLine = headers.map(escapeCsvCell).join(',');
  const dataLines = rows.map((row) => {
    return headers.map((header) => escapeCsvCell(row[header] ?? '')).join(',');
  });

  return [headerLine, ...dataLines].join('\n');
}
