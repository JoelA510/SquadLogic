/**
 * One small league whose schedule is written by the REAL writers of the mock database (F11-3): the game save
 * (`persist_game_schedule`) and the score entry (`update_game_score`), never by putting rows in the tables a reader
 * reads. The readers F11-3 repoints (the team page and its files, the Dashboard, the Player record, Scores,
 * Standings) are then run over what the writers wrote. Placeholder names only.
 *
 * Four teams in one division, one venue with two fields, six slots on two days. New York time; October, so local
 * 09:00 is 13:00 UTC.
 */
import { seedMockDb } from './seedMockDb.js';

export const ORG = '00000000-0000-4000-8000-0000000000a3';
export const OTHER_ORG = '00000000-0000-4000-8000-0000000000b3';
export const SEASON = '00000000-0000-4000-8000-00000000a301';
export const DIVISION = '00000000-0000-4000-8000-00000000a302';
export const ADMIN_ID = 'mock-admin-id';
export const TZ = 'America/New_York';
export const TEAMS = {
  comets: '00000000-0000-4000-8000-00000000a311',
  rockets: '00000000-0000-4000-8000-00000000a312',
  meteors: '00000000-0000-4000-8000-00000000a313',
  planets: '00000000-0000-4000-8000-00000000a314',
};
export const TEAM_NAMES = {
  comets: 'Synthetic Comets',
  rockets: 'Synthetic Rockets',
  meteors: 'Synthetic Meteors',
  planets: 'Synthetic Planets',
};

/** [slot id, field, date, local start hour] */
const SLOT_DEFS = [
  ['slot-1', 'field-north', '2026-10-03', 9],
  ['slot-2', 'field-south', '2026-10-03', 9],
  ['slot-3', 'field-north', '2026-10-03', 11],
  ['slot-4', 'field-north', '2026-10-10', 9],
  ['slot-5', 'field-south', '2026-10-10', 9],
  ['slot-6', 'field-south', '2026-10-10', 13],
];
const two = (n) => String(n).padStart(2, '0');
/** The UTC instant of a local New York hour in October (UTC-4). */
export const at = (date, hour, minute = 0) => `${date}T${two(hour + 4)}:${two(minute)}:00+00:00`;
const slotOf = (id) => SLOT_DEFS.find(([slot]) => slot === id);

/**
 * One assignment of the save's payload: `home` v `away` in `slot`, an hour long unless told otherwise
 * (`minutes`: an imported game can end at another time than its slot).
 */
export function assignment(home, away, slot, { id, week = 1, minutes = 60 } = {}) {
  const [, field, date, hour] = slotOf(slot);
  return {
    ...(id ? { id } : {}),
    home_team_id: TEAMS[home],
    away_team_id: TEAMS[away],
    game_slot_id: slot,
    field_id: field,
    week_index: week,
    start: at(date, hour),
    end: at(date, hour + Math.floor(minutes / 60), minutes % 60),
  };
}

/** Seed the league with no schedule, and sign the admin in. `flags` are the organization's feature flags. */
export function seedLeague({ flags = { score_entry: true, standings: true } } = {}) {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [
      { id: ORG, name: 'Synthetic FC', is_onboarded: true, feature_flags: flags },
      { id: OTHER_ORG, name: 'Synthetic Other', is_onboarded: true, feature_flags: flags },
    ],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN_ID, role: 'admin' }],
    profiles: [{ id: ADMIN_ID, full_name: 'Synthetic Admin' }],
    season_settings: [
      {
        id: SEASON,
        organization_id: ORG,
        season_label: 'Fall 2026',
        status: 'active',
        timezone: TZ,
        season_start: '2026-09-01',
        season_end: '2026-11-30',
      },
    ],
    divisions: [{ id: DIVISION, organization_id: ORG, season_settings_id: SEASON, name: 'U10' }],
    teams: Object.entries(TEAMS).map(([key, id]) => ({
      id,
      organization_id: ORG,
      division_id: DIVISION,
      name: TEAM_NAMES[key],
    })),
    locations: [{ id: 'venue-1', organization_id: ORG, name: 'Example Park' }],
    fields: [
      { id: 'field-north', organization_id: ORG, location_id: 'venue-1', name: 'North Pitch' },
      { id: 'field-south', organization_id: ORG, location_id: 'venue-1', name: 'South Pitch' },
    ],
    game_slots: SLOT_DEFS.map(([id, field, date, hour]) => ({
      id,
      organization_id: ORG,
      field_id: field,
      division_id: DIVISION,
      slot_date: date,
      start_time: `${two(hour)}:00:00`,
      end_time: `${two(hour + 1)}:00:00`,
      week_index: 1,
    })),
    scheduler_runs: [],
    game_assignments: [],
    game_scores: [],
    games: [],
    practice_assignments: [],
    practice_exceptions: [],
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN_ID } }));
}

/** The mock client (imported late, after the seed). */
export async function client() {
  const { mockSupabase } = await import('../../frontend/src/lib/mockSupabaseClient.js');
  return mockSupabase;
}

/**
 * Save a schedule through the real save. Each save is a new run, a second later than the last.
 * @returns {Promise<string>} the run id
 */
let saves = 0;
export async function save(assignments, { season = SEASON } = {}) {
  saves += 1;
  const supabase = await client();
  const { data, error } = await supabase.rpc('persist_game_schedule', {
    run_data: {
      run_type: 'game',
      organization_id: ORG,
      season_settings_id: season,
      completed_at: new Date(Date.UTC(2026, 8, 1, 0, 0, saves)).toISOString(),
    },
    assignments,
  });
  if (error) throw new Error(`save refused: ${error.message}`);
  return data;
}

/** Enter (or with nulls, clear) a score through the real RPC. */
export async function score(gameId, home, away) {
  const supabase = await client();
  const { error } = await supabase.rpc('update_game_score', {
    p_organization_id: ORG,
    p_game_id: gameId,
    p_score_home: home,
    p_score_away: away,
  });
  if (error) throw new Error(`score refused: ${error.message}`);
}

/** The stored games of a run (ids are the save's own), by reading the table as an admin would. */
export async function gamesOfRun(runId) {
  const supabase = await client();
  const { data, error } = await supabase.from('game_assignments').select('*').eq('run_id', runId);
  if (error) throw error;
  return data;
}

/** The id of the stored game of a run with these sides. */
export async function gameId(runId, home, away) {
  const games = await gamesOfRun(runId);
  const found = games.find((g) => g.home_team_id === TEAMS[home] && g.away_team_id === TEAMS[away]);
  if (!found) throw new Error(`no game ${home} v ${away} in run ${runId}`);
  return found.id;
}
