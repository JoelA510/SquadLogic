/**
 * One small invented league for the schedule reports (Day Sheet, coach schedule, Changes since publication; PR 7 of
 * the schedule expansion). Placeholder names only, built by script: no real person, club or venue.
 *
 * Time zone `America/New_York`; October 2026 is daylight time (UTC-4), so 09:00 local is 13:00Z.
 *
 * | game | division | week | local start         | field  | venue | state                                  |
 * | ---- | -------- | ---- | ------------------- | ------ | ----- | -------------------------------------- |
 * | g1   | U10      | 1    | Sat 2026-10-03 09:00 | A1     | North | Comets v Rockets                       |
 * | g2   | U12      | 1    | Sat 2026-10-03 09:30 | B1     | Main  | Planets v Moons (Alex's second team)   |
 * | g3   | U10      | 2    | Sat 2026-10-10 09:00 | A1     | North | Meteors v Rockets                      |
 * | g4   | U12      | 2    | Sat 2026-10-10 11:00 | A2     | North | Moons v Stars                          |
 * | g5   | U12      | 2    | Sat 2026-10-10 22:00 | B1     | Main  | Planets v Stars (02:00Z the next day)  |
 * | g6   | U10      | 3    | Sat 2026-10-17 09:00 | C1     | Main  | Rockets v Meteors (the other Main Park) |
 *
 * plus one unplaced game on the TIME TBD list: Comets v Meteors, week 2, "no game slot was free for it".
 *
 * Two venues with the same display name ("Main Park") hold fields B1 and C1 (games at both), so a filter by name cannot
 * tell them apart; the venue's id can.
 *
 * Coaches (all placeholders, ids `c-*`):
 *
 * | coach | name         | flag `can_coach_multiple_teams` | teams (role)                       | multi-team marker |
 * | ----- | ------------ | ------------------------------- | ----------------------------------- | ----------------- |
 * | c-1   | Alex Sample  | false                           | Comets (lead), Planets (assistant)  | yes (two teams)   |
 * | c-2   | Blake Sample | true                            | Rockets (lead)                      | no (one team)     |
 * | c-3   | Casey Sample | false                           | Meteors (lead), Moons (assistant)   | yes               |
 * | c-4   | Drew Sample  | false                           | Planets (lead), Planets (assistant) | no (one team)     |
 * | c-5   | Eli Sample   | false                           | Stars (lead)                        | no                |
 *
 * Alex's two teams play at 09:00 and 09:30 on 2026-10-03 (overlapping) and have two Tuesday practices that overlap.
 */
import { generateScheduleExports } from '../../packages/core/src/outputGeneration.js';
import {
  makePublicationSnapshot,
  serialisePublicationSnapshot,
} from '../../packages/core/src/publication/index.js';

export const TZ = 'America/New_York';
export const SEASON_ID = 'season-reports';
export const ORG_ID = '00000000-0000-4000-8000-0000000000a7';
export const RUN_ID = '00000000-0000-4000-8000-0000000000b7';
/** The day the roster is read as of (inside every seeded coach window). */
export const AS_OF = '2026-10-01';

export const TEAMS = [
  { id: 't-1', name: 'Synthetic Comets', divisionId: 'd-10', division: 'U10' },
  { id: 't-2', name: 'Synthetic Rockets', divisionId: 'd-10', division: 'U10' },
  { id: 't-3', name: 'Synthetic Meteors', divisionId: 'd-10', division: 'U10' },
  { id: 't-4', name: 'Synthetic Planets', divisionId: 'd-12', division: 'U12' },
  { id: 't-5', name: 'Synthetic Moons', divisionId: 'd-12', division: 'U12' },
  { id: 't-6', name: 'Synthetic Stars', divisionId: 'd-12', division: 'U12' },
];

export const VENUES = [
  { id: 'v-north', name: 'North Park' },
  { id: 'v-main-1', name: 'Main Park' },
  { id: 'v-main-2', name: 'Main Park' },
];
/** Field `A*` is at North Park, `B1` at the first Main Park, `C1` at the second. */
export const FIELDS = [
  { id: 'f-a1', name: 'Field A1', venueId: 'v-north' },
  { id: 'f-a2', name: 'Field A2', venueId: 'v-north' },
  { id: 'f-b1', name: 'Field B1', venueId: 'v-main-1' },
  { id: 'f-c1', name: 'Field C1', venueId: 'v-main-2' },
];

export const COACHES = [
  { id: 'c-1', name: 'Alex Sample', canCoachMultipleTeams: false },
  { id: 'c-2', name: 'Blake Sample', canCoachMultipleTeams: true },
  { id: 'c-3', name: 'Casey Sample', canCoachMultipleTeams: false },
  { id: 'c-4', name: 'Drew Sample', canCoachMultipleTeams: false },
  { id: 'c-5', name: 'Eli Sample', canCoachMultipleTeams: false },
];

const window = { effective_from: '2026-08-01', effective_to: null };
/** `team_coach_assignments` rows as the table returns them. */
export const COACH_ASSIGNMENTS = [
  { id: 'ca-1', team_id: 't-1', coach_id: 'c-1', role: 'lead', ...window },
  { id: 'ca-2', team_id: 't-4', coach_id: 'c-1', role: 'assistant', ...window },
  { id: 'ca-3', team_id: 't-2', coach_id: 'c-2', role: 'lead', ...window },
  { id: 'ca-4', team_id: 't-3', coach_id: 'c-3', role: 'lead', ...window },
  { id: 'ca-5', team_id: 't-5', coach_id: 'c-3', role: 'assistant', ...window },
  { id: 'ca-6', team_id: 't-4', coach_id: 'c-4', role: 'lead', ...window },
  { id: 'ca-7', team_id: 't-4', coach_id: 'c-4', role: 'assistant', ...window },
  { id: 'ca-8', team_id: 't-6', coach_id: 'c-5', role: 'lead', ...window },
  // Ended before the roster date: Drew once also coached Meteors. Not a team of his now.
  {
    id: 'ca-9',
    team_id: 't-3',
    coach_id: 'c-4',
    role: 'assistant',
    effective_from: '2026-08-01',
    effective_to: '2026-09-15',
  },
];

const at = (date, utcHour, minute = 0) =>
  `${date}T${String(utcHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+00:00`;

/** [id, division, home, away, week, slot, field, start, end] */
const GAME_ROWS = [
  ['g1', 'U10', 't-1', 't-2', 1, 's-1', 'f-a1', at('2026-10-03', 13), at('2026-10-03', 14)],
  ['g2', 'U12', 't-4', 't-5', 1, 's-2', 'f-b1', at('2026-10-03', 13, 30), at('2026-10-03', 14, 30)],
  ['g3', 'U10', 't-3', 't-2', 2, 's-3', 'f-a1', at('2026-10-10', 13), at('2026-10-10', 14)],
  ['g4', 'U12', 't-5', 't-6', 2, 's-4', 'f-a2', at('2026-10-10', 15), at('2026-10-10', 16)],
  ['g5', 'U12', 't-4', 't-6', 2, 's-5', 'f-b1', at('2026-10-11', 2), at('2026-10-11', 3)],
  ['g6', 'U10', 't-2', 't-3', 3, 's-6', 'f-c1', at('2026-10-17', 13), at('2026-10-17', 14)],
];

/** The saved game rows as `useGameAssignments` returns them (camelCase). `overrides` maps an id to changes or null. */
export function savedGames(overrides = {}) {
  return GAME_ROWS.flatMap(([id, division, home, away, week, slot, field, start, end]) => {
    if (overrides[id] === null) return [];
    return [
      {
        id,
        runId: RUN_ID,
        organizationId: ORG_ID,
        division,
        weekIndex: week,
        slotId: slot,
        gameSlotId: slot,
        fieldId: field,
        start,
        end,
        homeTeamId: home,
        awayTeamId: away,
        assignmentSource: 'auto',
        published: false,
        notes: '',
        ...(overrides[id] ?? {}),
      },
    ];
  });
}

/** `game_slots` rows (id and week), the registry a baseline's slot ids are read against. */
export const SLOTS = [
  { id: 's-1', weekIndex: 1 },
  { id: 's-2', weekIndex: 1 },
  { id: 's-3', weekIndex: 2 },
  { id: 's-4', weekIndex: 2 },
  { id: 's-5', weekIndex: 2 },
  { id: 's-6', weekIndex: 3 },
  // Empty slots, week 3: where a moved game can go.
  { id: 's-7', weekIndex: 3 },
  { id: 's-8', weekIndex: 3 },
];

/** The `get_schedule_tbd` rows for the season: one unplaced game, one short practice. */
export function tbdRows() {
  return [
    {
      id: 'tbd-1',
      kind: 'game',
      division_name: 'U10',
      home_team_id: 't-1',
      home_team_name: 'Synthetic Comets',
      away_team_id: 't-3',
      away_team_name: 'Synthetic Meteors',
      week_index: 2,
      reason: 'no-slot-available',
    },
    {
      id: 'tbd-2',
      kind: 'practice',
      division_name: 'U12',
      team_id: 't-5',
      team_name: 'Synthetic Moons',
      missing_count: 1,
      reason: 'no-slot-available',
    },
  ];
}

/** The TIME TBD games as the reports take them (a game item only). */
export function tbdGames() {
  return tbdRows()
    .filter((row) => row.kind === 'game')
    .map((row) => ({
      homeTeamId: row.home_team_id,
      awayTeamId: row.away_team_id,
      weekIndex: row.week_index,
      reason: row.reason,
    }));
}

/** `practice_assignments` rows with their slot embedded, as the practice read returns them. */
export function practiceRows() {
  const slot = (day, start, end, fieldId) => ({
    day_of_week: day,
    start_time: start,
    end_time: end,
    valid_from: '2026-09-01',
    valid_until: '2026-11-30',
    field: { id: fieldId, name: FIELDS.find((f) => f.id === fieldId).name },
  });
  const range = '[2026-09-08,2026-11-20)';
  return [
    {
      id: 'p-1',
      team_id: 't-1',
      effective_date_range: range,
      slot: slot('tue', '17:00:00', '18:30:00', 'f-a1'),
    },
    {
      id: 'p-2',
      team_id: 't-4',
      effective_date_range: range,
      slot: slot('tue', '18:00:00', '19:00:00', 'f-b1'),
    },
    {
      id: 'p-3',
      team_id: 't-4',
      effective_date_range: range,
      slot: slot('wed', '17:00:00', '18:00:00', 'f-b1'),
    },
    {
      id: 'p-4',
      team_id: 't-2',
      effective_date_range: range,
      slot: slot('thu', '17:00:00', '18:00:00', 'f-a2'),
    },
  ];
}

/** The same practices in the shape the reports take (the read util maps the rows above to this). */
export function practices(extra = []) {
  return [
    ...practiceRows().map((row) => ({
      id: row.id,
      teamId: row.team_id,
      range: row.effective_date_range,
      dayOfWeek: row.slot.day_of_week,
      startTime: row.slot.start_time,
      endTime: row.slot.end_time,
      validFrom: row.slot.valid_from,
      validUntil: row.slot.valid_until,
      fieldId: row.slot.field.id,
      fieldName: row.slot.field.name,
    })),
    ...extra,
  ];
}

/** The team directory the master export takes. */
export const exportTeams = () => TEAMS.map(({ id, name, division }) => ({ id, name, division }));

/** The master export's game input from saved rows (what the Exports panel passes `generateScheduleExports`). */
export const exportGames = (games) =>
  games.map((g) => ({
    homeTeamId: g.homeTeamId,
    awayTeamId: g.awayTeamId,
    start: g.start,
    end: g.end,
    fieldId: g.fieldId ?? '',
    slotId: g.slotId ?? '',
    notes: g.notes ?? '',
  }));

/**
 * The rows a baseline holds if the schedule was published as `games` stood: the master export's rows, exactly as the
 * Exports panel records them (so the reports read the real producer's output, not a hand-written copy of it).
 */
export function baselineRows(games, tbd = tbdRows()) {
  const tbdItems = tbd
    .filter((row) => row.kind === 'game')
    .map((row) => ({
      kind: 'game',
      homeTeamId: row.home_team_id,
      awayTeamId: row.away_team_id,
      weekIndex: row.week_index,
      reason: row.reason,
    }));
  return generateScheduleExports({
    teams: exportTeams(),
    gameAssignments: exportGames(games),
    tbdItems,
  }).master.rows;
}

/** A `game.publish_overridden` audit row as `get_schedule_audit_log` returns it. */
export function overrideRow({
  id,
  gameId,
  game,
  createdAt,
  reasonCode = 'field-change',
  note = null,
  actor = 'Synthetic Admin',
}) {
  return {
    id,
    created_at: createdAt,
    action: 'game.publish_overridden',
    resource_type: 'game_assignment',
    resource_id: gameId,
    metadata: {
      reason_code: reasonCode,
      scope: { kind: 'selection' },
      ...(note ? { note } : {}),
      before: {
        game_slot_id: game.slotId,
        field_id: game.fieldId,
        home_team_id: game.homeTeamId,
        away_team_id: game.awayTeamId,
        week_index: game.weekIndex,
        start: game.start,
        end: game.end,
      },
    },
    actor_name: actor,
  };
}

/**
 * A `publication_baselines` row as the table stores it (the snapshot's document, split into columns), for a baseline
 * recorded from `rows`. `mutate` may change the row, for a baseline the integrity check should refuse.
 */
export function baselineDbRow(
  rows,
  { id = 'b-1', version = 3, mutate = (row) => row, ...extra } = {}
) {
  const { snapshot } = makePublicationSnapshot({
    snapshotId: `week-${version}`,
    label: 'Week 1 files',
    channel: 'storage',
    publishedAt: '2026-10-02T08:00:00',
    publishedBy: 'actor-1',
    rows,
  });
  const doc = serialisePublicationSnapshot(snapshot);
  return mutate({
    id,
    organization_id: ORG_ID,
    baseline_version: version,
    document_version: doc.version,
    snapshot_id: doc.snapshotId,
    label: doc.label,
    channel: doc.channel,
    published_at: doc.publishedAt,
    published_by: doc.publishedBy,
    notes: null,
    export_columns: doc.columns,
    export_rows: doc.rows,
    digest: doc.digest,
    row_count: doc.rows.length,
    recorded_at: '2026-10-02T12:00:00+00:00',
    ...extra,
  });
}
