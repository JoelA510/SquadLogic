/**
 * One small league for the Games page tests of the Published switch (PR 3 of the schedule expansion): six teams in two
 * divisions, two venues, eight game slots, and six saved games that reach every Published state. Placeholder names
 * only. The tests mount the real page over the real mock client and read what it does; this file only seeds.
 *
 * | game  | division | week | date       | local | field      | state            |
 * | ----- | -------- | ---- | ---------- | ----- | ---------- | ---------------- |
 * | ga-1  | U10 Boys | 1    | 2026-10-03 | 09:00 | f-north    | Published        |
 * | ga-2  | U10 Boys | 2    | 2026-10-10 | 09:00 | f-north    | not published    |
 * | ga-3  | U10 Boys | 2    | 2026-10-10 | 11:00 | f-south    | changes allowed  |
 * | ga-4  | U12 Girls| 1    | 2026-10-03 | 11:00 | f-south    | not published    |
 * | ga-5  | U12 Girls| 2    | 2026-10-10 | 13:00 | f-south    | Published        |
 * | ga-6  | U12 Girls| 1    | 2026-10-03 | 13:00 | f-north    | not published    |
 *
 * Two empty slots (gs-7 on f-north, gs-8 on f-south, week 3) are the targets of a move.
 */
import { seedMockDb } from './seedMockDb.js';

export const ORG = '00000000-0000-4000-8000-0000000000f1';
export const SEASON = 'season-pubui';
export const RUN = '00000000-0000-4000-8000-0000000000d5';
export const TZ = 'America/New_York';
export const ADMIN_ID = 'mock-admin-id';

/** The teams the page schedules (a hoisted copy is needed where `vi.mock` factories read it). */
export const ROSTER = [
  { id: 'team-1', name: 'Synthetic Comets', division: 'U10 Boys' },
  { id: 'team-2', name: 'Synthetic Rockets', division: 'U10 Boys' },
  { id: 'team-3', name: 'Synthetic Meteors', division: 'U10 Boys' },
  { id: 'team-4', name: 'Synthetic Planets', division: 'U12 Girls' },
  { id: 'team-5', name: 'Synthetic Moons', division: 'U12 Girls' },
  { id: 'team-6', name: 'Synthetic Stars', division: 'U12 Girls' },
];

const LOCAL_UTC_HOUR = { '09:00': '13', '11:00': '15', '13:00': '17' };
const at = (date, local, plusHour = 0) =>
  `${date}T${String(Number(LOCAL_UTC_HOUR[local]) + plusHour).padStart(2, '0')}:00:00+00:00`;

/** @type {Array<[string, string, string, string, number, string, string, string, string, string]>} */
// [id, division, home, away, week, date, local, field, slot, state]
const GAMES = [
  [
    'ga-1',
    'U10 Boys',
    'team-1',
    'team-2',
    1,
    '2026-10-03',
    '09:00',
    'f-north',
    'gs-1',
    'published',
  ],
  ['ga-2', 'U10 Boys', 'team-1', 'team-3', 2, '2026-10-10', '09:00', 'f-north', 'gs-2', 'not'],
  ['ga-3', 'U10 Boys', 'team-2', 'team-3', 2, '2026-10-10', '11:00', 'f-south', 'gs-3', 'allowed'],
  ['ga-4', 'U12 Girls', 'team-4', 'team-5', 1, '2026-10-03', '11:00', 'f-south', 'gs-4', 'not'],
  [
    'ga-5',
    'U12 Girls',
    'team-4',
    'team-6',
    2,
    '2026-10-10',
    '13:00',
    'f-south',
    'gs-5',
    'published',
  ],
  ['ga-6', 'U12 Girls', 'team-5', 'team-6', 1, '2026-10-03', '13:00', 'f-north', 'gs-6', 'not'],
];

const SLOT_DEFS = [
  ...GAMES.map(([, , , , week, date, local, field, slot]) => ({
    id: slot,
    field,
    week,
    date,
    local,
  })),
  { id: 'gs-7', field: 'f-north', week: 3, date: '2026-10-17', local: '09:00' },
  { id: 'gs-8', field: 'f-south', week: 3, date: '2026-10-17', local: '09:00' },
];

export const SLOTS = SLOT_DEFS.map(({ id, field, week, date, local }) => ({
  id,
  organization_id: ORG,
  field_id: field,
  slot_date: date,
  start_time: `${local}:00`,
  end_time: `${String(Number(local.slice(0, 2)) + 1).padStart(2, '0')}:00:00`,
  week_index: week,
  capacity: 1,
}));

/** The saved games. `overrides` maps a game id to fields to change, or `null` to leave the game out. */
export function savedGames(overrides = {}) {
  return GAMES.flatMap(([id, division, home, away, week, date, local, field, slot, state]) => {
    if (overrides[id] === null) return [];
    return [
      {
        id,
        run_id: RUN,
        organization_id: ORG,
        division,
        week_index: week,
        slot_id: slot,
        game_slot_id: slot,
        field_id: field,
        start: at(date, local),
        end: at(date, local, 1),
        home_team_id: home,
        away_team_id: away,
        assignment_source: 'auto',
        published: state === 'published',
        published_at: state === 'not' ? null : '2026-10-01T12:00:00+00:00',
        published_by: state === 'not' ? null : ADMIN_ID,
        ...(overrides[id] ?? {}),
      },
    ];
  });
}

/**
 * Seed the mock database from nothing: the club, its admin, two venues and two fields,
 * the slots, one completed game run and its games.
 *
 * @param {{ games?: Array<Record<string, any>>, members?: boolean, scoredIds?: string[] }} [options] - `scoredIds`:
 *   the games that have a score (a row of `game_scores` each, 2-1)
 */
export function seedWorld({ games = savedGames(), members = true, scoredIds = [] } = {}) {
  // The mock keeps the state its last write saved on `window`, and merges it over whatever is stored: a game a
  // previous test published would still be published here. Dropping it leaves the seed and nothing else.
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [{ id: ORG, name: 'Synthetic FC', is_onboarded: true }],
    organization_members: members
      ? [{ organization_id: ORG, profile_id: ADMIN_ID, role: 'admin' }]
      : [],
    profiles: [{ id: ADMIN_ID, full_name: 'Synthetic Admin' }],
    locations: [
      { id: 'loc-north', organization_id: ORG, name: 'North Park', effective_to: null },
      { id: 'loc-south', organization_id: ORG, name: 'South Park', effective_to: null },
    ],
    fields: [
      {
        id: 'f-north',
        name: 'North Field',
        organization_id: ORG,
        location_id: 'loc-north',
        active: true,
      },
      {
        id: 'f-south',
        name: 'South Field',
        organization_id: ORG,
        location_id: 'loc-south',
        active: true,
      },
    ],
    game_slots: SLOTS,
    scheduler_runs: [
      {
        id: RUN,
        organization_id: ORG,
        run_type: 'game',
        status: 'completed',
        season_settings_id: SEASON,
        completed_at: '2026-10-14T12:00:00Z',
        results: {},
      },
    ],
    game_assignments: games,
    game_scores: games
      .filter((game) => scoredIds.includes(game.id))
      .map((game) => ({
        game_id: game.id,
        organization_id: ORG,
        home_team_id: game.home_team_id,
        away_team_id: game.away_team_id,
        score_home: 2,
        score_away: 1,
      })),
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN_ID } }));
}
