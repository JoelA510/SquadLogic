const MASTER_HEADERS = [
  'Team ID',
  'Team Name',
  'Division',
  'Coach Name',
  'Coach Email',
  'Event Type',
  'Opponent',
  'Role',
  'Start',
  'End',
  'Field',
  'Slot',
  'Notes',
];

/**
 * Generate flattened schedule exports for practices and games.
 *
 * @param {Object} params
 * @param {Array<Object>} params.teams
 * @param {Array<Object>} [params.practiceAssignments=[]]
 * @param {Array<Object>} [params.gameAssignments=[]]
 * @returns {{ master: { headers: Array<string>, rows: Array<Object>, csv: string }, perTeam: Array<{ teamId: string, headers: Array<string>, rows: Array<Object>, csv: string }> }}
 */
export function generateScheduleExports({
  teams,
  practiceAssignments = [],
  gameAssignments = [],
}) {
  if (!Array.isArray(teams)) {
    throw new TypeError('teams must be an array');
  }
  if (!Array.isArray(practiceAssignments)) {
    throw new TypeError('practiceAssignments must be an array');
  }
  if (!Array.isArray(gameAssignments)) {
    throw new TypeError('gameAssignments must be an array');
  }

  const teamDirectory = new Map();
  for (const team of teams) {
    if (!team || typeof team !== 'object') {
      throw new TypeError('each team must be an object');
    }
    if (!team.id) {
      throw new TypeError('each team requires an id');
    }

    const sanitized = {
      id: team.id,
      name: team.name ?? team.id,
      division: team.division ?? '',
      coachName: team.coachName ?? '',
      coachEmail: team.coachEmail ?? '',
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
      eventType: 'Practice',
      start: assignment.start,
      end: assignment.end,
      fieldId: assignment.fieldId ?? '',
      slotId: assignment.slotId ?? '',
      notes: assignment.notes ?? '',
      role: '',
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

  return {
    master: {
      headers: MASTER_HEADERS.slice(),
      rows: masterRows.map((row) => ({ ...row })),
      csv: formatCsv(MASTER_HEADERS, masterRows),
    },
    perTeam: Array.from(teamRows.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([teamId, rows]) => ({
        teamId,
        headers: MASTER_HEADERS.slice(),
        rows: rows.map((row) => ({ ...row })),
        csv: formatCsv(MASTER_HEADERS, rows),
      })),
  };
}

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
}) {
  const normalizedStart = normalizeDate(start);
  const normalizedEnd = normalizeDate(end);

  const opponent = opponentName ?? (opponentTeamId ? opponentTeamId : '');

  return {
    'Team ID': team.id,
    'Team Name': team.name,
    Division: team.division,
    'Coach Name': team.coachName,
    'Coach Email': team.coachEmail,
    'Event Type': eventType,
    Opponent: opponent,
    Role: role,
    Start: normalizedStart,
    End: normalizedEnd,
    Field: fieldId,
    Slot: slotId,
    Notes: notes,
  };
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('invalid date provided to export formatter');
  }
  return date.toISOString();
}

function compareRows(a, b) {
  const startComparison = a.Start.localeCompare(b.Start);
  if (startComparison !== 0) {
    return startComparison;
  }
  return a['Team ID'].localeCompare(b['Team ID']);
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

  const headerLine = headers.map(escapeCsvValue).join(',');
  const dataLines = rows.map((row) => {
    return headers.map((header) => escapeCsvValue(row[header] ?? '')).join(',');
  });

  return [headerLine, ...dataLines].join('\n');
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const stringValue = String(value);
  if (stringValue.includes('"') || stringValue.includes(',') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}
