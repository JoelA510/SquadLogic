/**
 * Mock Supabase Client
 * Extracted from supabaseClient.js for clean separation between mock (E2E/dev)
 * and real (staging/production) environments.
 *
 * This module provides a sessionStorage-backed in-memory database that mimics
 * the Supabase JS client API surface used by SquadLogic's hooks and pages.
 */
import { logger } from './logger.js';
import { HEADER_ALIASES, RESERVED_KEYS } from '../utils/telemetryUtils.js';
import { selectLatestTeamRunsPerDivision } from '../utils/schedulerRunFilters.js';

const mockId = (prefix = '') =>
  prefix + (crypto.randomUUID?.() || crypto.getRandomValues(new Uint32Array(4)).join('-'));
const SCHEMA_ENTITIES = new Set(['player', 'coach', 'team']);
const SCHEMA_VALUE_TYPES = new Set(['string', 'number', 'boolean', 'date']);
const stableSchemaKey = (schema) =>
  JSON.stringify(
    Object.keys(schema || {})
      .sort()
      .map((key) => [key, schema[key]])
  );

// ── Mock Data Seed ──────────────────────────────────────────────────────────
const initialMockData = {
  organizations: [{ id: 'org-1', name: 'SquadLogic FC', is_onboarded: true }],
  audit_log: [
    {
      id: 'audit-1',
      organization_id: 'org-1',
      action: 'auth.password_updated',
      user_id: 'mock-admin-id',
      metadata: { user_id: 'mock-admin-id' },
      created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    },
    {
      id: 'audit-2',
      organization_id: 'org-1',
      action: 'impersonation.started',
      user_id: 'mock-admin-id',
      metadata: { target_user_id: 'mock-coach-id', admin_email: 'admin@example.com' },
      created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 'audit-3',
      organization_id: 'org-1',
      action: 'settings.flags_updated',
      user_id: 'mock-coach-id',
      metadata: {
        impersonated_by: 'mock-admin-id',
        admin_email: 'admin@example.com',
        flags: { ADVANCED_FAIRNESS: true },
      },
      created_at: new Date(Date.now() - 1800000).toISOString(),
    },
  ],
  profiles: [
    {
      id: 'mock-admin-id',
      first_name: 'Mock',
      last_name: 'Admin',
      full_name: 'Mock Admin',
      email: import.meta.env.VITE_TEST_ADMIN_EMAIL || 'admin@example.com',
      role: 'admin',
      organization_id: 'org-1',
    },
    {
      id: 'mock-coach-id',
      first_name: 'Mock',
      last_name: 'Coach',
      full_name: 'Mock Coach',
      email: import.meta.env.VITE_TEST_COACH_EMAIL || 'coach@example.com',
      role: 'coach',
      organization_id: 'org-1',
    },
    {
      id: 'mock-parent-id',
      first_name: 'Mock',
      last_name: 'Parent',
      full_name: 'Mock Parent',
      email: 'parent@example.com',
      role: 'parent',
      organization_id: 'org-1',
    },
  ],
  organization_members: [
    { organization_id: 'org-1', profile_id: 'mock-admin-id', role: 'admin' },
    { organization_id: 'org-1', profile_id: 'mock-coach-id', role: 'coach' },
    { organization_id: 'org-1', profile_id: 'mock-parent-id', role: 'parent' },
  ],
  season_settings: [
    {
      id: 'season-1',
      organization_id: 'org-1',
      name: 'Fall 2024',
      status: 'active',
      season_start: '2025-01-01',
      season_end: '2025-12-31',
      timezone: 'America/Los_Angeles',
      school_day_end: '16:00',
      created_at: new Date().toISOString(),
    },
  ],
  divisions: [
    {
      id: 'u8-div-id',
      name: 'U8 Coed',
      organization_id: 'org-1',
      season_settings_id: 'season-1',
      max_roster_size: 10,
      min_roster_size: 7,
      target_team_size: 9,
      min_teams: 1,
      max_teams: 4,
    },
    {
      id: 'u10-div-id',
      name: 'U10 Girls',
      organization_id: 'org-1',
      season_settings_id: 'season-1',
      max_roster_size: 14,
      min_roster_size: 10,
      target_team_size: 12,
    },
  ],
  teams: [
    {
      id: 't1',
      name: 'Team A',
      division_id: 'u8-div-id',
      coach_id: 'mock-coach-id',
      organization_id: 'org-1',
    },
    {
      id: 't2',
      name: 'Team B',
      division_id: 'u8-div-id',
      coach_id: 'c2',
      organization_id: 'org-1',
    },
    {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Tigers',
      division_id: 'u8-div-id',
      organization_id: 'org-1',
      calendar_token: 'mock-calendar-token-tigers',
      calendar_token_expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
    },
  ],
  team_players: [
    { team_id: '00000000-0000-0000-0000-000000000001', player_id: 'player-1' },
    { team_id: '00000000-0000-0000-0000-000000000001', player_id: 'player-2' },
  ],
  player_buddies: [],
  players: [
    {
      id: 'player-1',
      first_name: 'Alex',
      last_name: 'Smith',
      organization_id: 'org-1',
      team_id: '00000000-0000-0000-0000-000000000001',
      division_id: 'u8-div-id',
      gender: 'm',
      status: 'active',
      years_played: 2,
      rating: 3,
      jersey_number: 7,
      paid: true,
      waiver_received: true,
      medical_form_received: false,
      willing_to_coach: false,
      buddy_request: 'Jamie Jones',
      guardian_contacts: [{ name: 'Dana Smith', email: 'dana.smith@example.com' }],
    },
    {
      id: 'player-2',
      first_name: 'Jamie',
      last_name: 'Jones',
      organization_id: 'org-1',
      team_id: '00000000-0000-0000-0000-000000000001',
      division_id: 'u8-div-id',
      gender: 'f',
      status: 'waitlist',
      years_played: 0,
      rating: null,
      jersey_number: null,
      paid: false,
      waiver_received: false,
      medical_form_received: false,
      willing_to_coach: true,
      guardian_contacts: [],
    },
  ],
  coaches: [
    {
      id: 'mock-coach-id',
      organization_id: 'org-1',
      profile_id: 'mock-coach-id',
      user_id: 'mock-coach-id',
      full_name: 'Mock Coach',
      email: import.meta.env.VITE_TEST_COACH_EMAIL || 'coach@example.com',
      phone: '555-0101',
      status: 'active',
      import_source: 'coach_import',
      last_imported_at: new Date(Date.now() - 7 * 86400000).toISOString(),
      can_coach_multiple_teams: true,
    },
    {
      id: 'c2',
      organization_id: 'org-1',
      full_name: 'Casey Rivera',
      email: 'casey.rivera@example.com',
      phone: '555-0102',
      status: 'active',
      import_source: 'coach_import',
      last_imported_at: new Date(Date.now() - 12 * 86400000).toISOString(),
      can_coach_multiple_teams: false,
    },
    {
      id: 'coach-lead-1',
      organization_id: 'org-1',
      full_name: 'Morgan Reyes',
      email: 'morgan.reyes@example.com',
      phone: '555-0103',
      status: 'interested',
      import_source: 'player_import_lead',
      last_imported_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      can_coach_multiple_teams: false,
    },
  ],
  coach_interested_programs: [
    {
      id: 'coach-interest-1',
      coach_id: 'coach-lead-1',
      division_id: 'u8-div-id',
      inferred_from_player_id: 'player-1',
      organization_id: 'org-1',
      created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    },
  ],
  profile_players: [
    { profile_id: 'mock-parent-id', player_id: 'player-1' },
    { profile_id: 'mock-parent-id', player_id: 'player-2' },
  ],
  practice_slots: [
    {
      id: 'ps-1',
      day_of_week: 'tue',
      start_time: '18:00',
      end_time: '19:30',
      capacity: 2,
      valid_from: '2025-01-01',
      valid_until: '2025-12-31',
      field_id: 'v1',
      organization_id: 'org-1',
    },
  ],
  practice_assignments: [
    {
      id: 'pa-1',
      organization_id: 'org-1',
      team_id: '00000000-0000-0000-0000-000000000001',
      slot_id: 'ps-1',
      practice_slot_id: 'ps-1',
      run_id: 'run-practice-1',
      day_of_week: 'tue',
      start_time: '18:00',
      end_time: '19:30',
      field_id: 'v1',
      source: 'auto',
      effective_date_range: '[2025-01-01,2025-12-31)',
    },
  ],
  event_rsvps: [
    {
      id: 'rsvp-1',
      organization_id: 'org-1',
      team_id: '00000000-0000-0000-0000-000000000001',
      player_id: 'player-1',
      reference_id: 'pa-1',
      event_type: 'practice',
      occurrence_date: '2025-01-07',
      status: 'attending',
      updated_at: new Date().toISOString(),
    },
    {
      id: 'rsvp-2',
      organization_id: 'org-1',
      team_id: '00000000-0000-0000-0000-000000000001',
      player_id: 'player-2',
      reference_id: 'pa-1',
      event_type: 'practice',
      occurrence_date: '2025-01-07',
      status: 'pending',
      updated_at: new Date().toISOString(),
    },
  ],
  locations: [{ id: 'loc-1', organization_id: 'org-1', name: 'Central Park' }],
  fields: [
    {
      id: 'v1',
      name: 'Field 1',
      location_id: 'loc-1',
      organization_id: 'org-1',
      active: true,
      surface_type: 'Grass',
      size: '11v11',
    },
    {
      id: 'v2',
      name: 'Field 2',
      location_id: 'loc-1',
      organization_id: 'org-1',
      active: true,
      surface_type: 'Turf',
      size: '7v7',
    },
  ],
  game_slots: [
    {
      id: 'gs-1',
      field_id: 'v1',
      start: '2026-04-04T08:00:00Z',
      end: '2026-04-04T09:00:00Z',
      capacity: 1,
      organization_id: 'org-1',
    },
    {
      id: 'gs-2',
      field_id: 'v1',
      start: '2026-04-04T09:30:00Z',
      end: '2026-04-04T10:30:00Z',
      capacity: 1,
      organization_id: 'org-1',
    },
    {
      id: 'gs-3',
      field_id: 'v2',
      start: '2026-04-04T08:00:00Z',
      end: '2026-04-04T09:00:00Z',
      capacity: 1,
      organization_id: 'org-1',
    },
    {
      id: 'gs-4',
      field_id: 'v2',
      start: '2026-04-04T09:30:00Z',
      end: '2026-04-04T10:30:00Z',
      capacity: 1,
      organization_id: 'org-1',
    },
  ],
  game_assignments: [],
  games: [
    {
      id: 'g1',
      organization_id: 'org-1',
      season_id: 'season-1',
      home_team_id: 't1',
      away_team_id: 't2',
      start_time: new Date(Date.now() - 86400000).toISOString(),
      venue_id: 'v1',
      has_conflict: true,
      conflict_reason: 'Double-booked Field',
      score_home: 2,
      score_away: 1,
    },
    {
      id: 'game-2',
      organization_id: 'org-1',
      season_id: 'season-1',
      home_team_id: 't1',
      away_team_id: 't2',
      start_time: new Date(Date.now() - 3600000).toISOString(),
      venue_id: 'v1',
      score_home: null,
      score_away: null,
    },
  ],
  player_registrations: [
    {
      id: 'player-1',
      organization_id: 'org-1',
      season_id: 'season-1',
      first_name: 'Alex',
      last_name: 'Smith',
      status: 'Reviewing',
      gender: 'B',
      birth_year: 2015,
    },
    {
      id: 'player-2',
      organization_id: 'org-1',
      season_id: 'season-1',
      first_name: 'Sam',
      last_name: 'Jones',
      status: 'Approved',
      gender: 'G',
      birth_year: 2016,
    },
  ],
  registration_forms: [
    { id: 'f1', title: 'Spring 2026 Registration', status: 'active', organization_id: 'org-1' },
  ],
  scheduler_runs: [
    {
      id: 'run-practice-1',
      organization_id: 'org-1',
      season_id: 'season-1',
      run_type: 'practice',
      status: 'completed',
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      results: {
        summary: { assignmentRate: 1.0, manualFollowUpRate: 0, unassignedTeams: 0 },
        baseSlotDistribution: [
          { baseSlotId: 'slot_mon_1800', day: 'Monday', totalCapacity: 10, totalAssigned: 1 },
          { baseSlotId: 'slot_wed_1800', day: 'Wednesday', totalCapacity: 10, totalAssigned: 0 },
        ],
      },
    },
    {
      id: 'run-game-1',
      organization_id: 'org-1',
      season_id: 'season-1',
      run_type: 'game',
      status: 'completed',
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      results: {
        summary: { assignmentRate: 1.0, manualFollowUpRate: 0, unassignedTeams: 0 },
      },
    },
    {
      id: 'run-1',
      organization_id: 'org-1',
      season_settings_id: 'season-1',
      run_type: 'team',
      status: 'completed',
      results: {
        teamsByDivision: {
          'U8 Boys': [
            { id: 't1', name: 'Team A', division_id: 'U8 Boys', headCoach: 'Mock Admin' },
            { id: 't2', name: 'Team B', division_id: 'U8 Boys', headCoach: 'Mock Coach' },
          ],
        },
        rosterBalanceByDivision: {
          'U8 Boys': {
            summary: { totalPlayers: 24, totalCapacity: 30, averageFillRate: 0.8 },
            teamStats: [
              { teamId: 't1', slotsRemaining: 3 },
              { teamId: 't2', slotsRemaining: 3 },
            ],
          },
        },
        coachCoverageByDivision: {
          'U8 Boys': { totalTeams: 2, teamsWithCoach: 2, coverageRate: 1.0 },
        },
      },
      started_at: new Date(Date.now() - 3600000).toISOString(),
      completed_at: new Date().toISOString(),
    },
  ],
  registrations: [
    {
      id: 'reg-1',
      organization_id: 'org-1',
      form_id: 'f1',
      player_id: 'player-1',
      profile_id: 'mock-admin-id',
      medical_cleared: false,
      waiver_signed: true,
      created_at: new Date().toISOString(),
    },
  ],
  team_summaries: [
    {
      id: 'summary-1',
      organization_id: 'org-1',
      season_id: 'season-1',
      total_players: 24,
      total_teams: 2,
      unassigned_players: 0,
      skill_balance_score: 92,
      last_updated: new Date().toISOString(),
    },
  ],
  imports: [
    {
      id: 'import-1',
      user_id: 'mock-admin-id',
      organization_id: 'org-1',
      import_type: 'players',
      data: {
        totalRows: 2,
        validRows: 2,
        data: [
          {
            'First Name': 'Alex',
            'Last Name': 'Smith',
            Birthdate: '2015-05-15',
            Gender: 'm',
            'Skill Level': 'advanced',
          },
          {
            'First Name': 'Sam',
            'Last Name': 'Jones',
            Birthdate: '2016-08-20',
            Gender: 'f',
            'Skill Level': 'developing',
          },
        ],
        fileName: 'mock_players.csv',
      },
      created_at: new Date(Date.now() - 86400000).toISOString(),
    },
  ],
  import_jobs: [],
  staging_players: [],
  staging_import_rows: [],
  import_application_records: [],
  field_availability_profiles: [],
  field_availability_profile_formats: [],
  field_blackout_windows: [],
  field_blackouts: [],
  field_equipment_requirements: [],
  field_availability_scenarios: [],
  field_availability_scenario_members: [],
  view_league_standings: [
    {
      organization_id: 'org-1',
      team_id: 't1',
      team_name: 'Team A',
      division: 'U8 Coed',
      wins: 1,
      losses: 0,
      draws: 0,
      games_played: 1,
      goals_for: 2,
      goals_against: 1,
      goal_differential: 1,
      points: 3,
    },
    {
      organization_id: 'org-1',
      team_id: 't2',
      team_name: 'Team B',
      division: 'U8 Coed',
      wins: 0,
      losses: 1,
      draws: 0,
      games_played: 1,
      goals_for: 1,
      goals_against: 2,
      goal_differential: -1,
      points: 0,
    },
  ],
  view_org_metrics: [
    { organization_id: 'org-1', total_players: 150, total_teams: 12, total_users: 25 },
  ],
  view_compliance_stats: [
    {
      organization_id: 'org-1',
      form_title: 'Spring 2026 Registration',
      total_registrations: 45,
      medical_cleared: 38,
    },
  ],
};

// ── Realtime & Auth Event Plumbing ──────────────────────────────────────────
let mockSubscriptionCallback = null;
const realtimeCallbacks = [];
let pendingAuthEvents = [];

const triggerRealtimeEvent = (table, event, payload) => {
  realtimeCallbacks.forEach((cb) => {
    if (cb.table === table && (cb.event === '*' || cb.event === event)) {
      // Include eventType in payload so Supabase Realtime subscription handlers can read it
      cb.callback({ ...payload, eventType: event });
    }
  });
};

const triggerAuthEvent = (event, session) => {
  if (mockSubscriptionCallback) {
    mockSubscriptionCallback(event, session);
  } else {
    pendingAuthEvents.push({ event, session });
  }
};

// ── Mock Data Management ────────────────────────────────────────────────────
const mergeSource = (db, source) => {
  if (!source) return db;
  Object.keys(source).forEach((key) => {
    if (Array.isArray(source[key])) {
      db[key] = db[key] || [];
      source[key].forEach((record) => {
        const idx = db[key].findIndex((r) => {
          if (r.id && record.id) return String(r.id) === String(record.id);
          if (key === 'organization_members')
            return (
              String(r.organization_id) === String(record.organization_id) &&
              String(r.profile_id) === String(record.profile_id)
            );
          if (key === 'player_buddies')
            return (
              String(r.player_id) === String(record.player_id) &&
              String(r.buddy_player_id) === String(record.buddy_player_id)
            );
          if (key === 'view_org_metrics')
            return String(r.organization_id) === String(record.organization_id);
          if (key === 'view_compliance_stats')
            return String(r.form_title) === String(record.form_title);
          if (key === 'view_league_standings') return String(r.team_id) === String(record.team_id);
          return false;
        });
        if (idx >= 0) {
          db[key][idx] = { ...db[key][idx], ...record };
        } else {
          db[key].push(record);
        }
      });
    } else if (source[key] && typeof source[key] === 'object') {
      db[key] = { ...(db[key] || {}), ...source[key] };
    } else {
      db[key] = source[key];
    }
  });
  return db;
};

const getDB = () => {
  let db = JSON.parse(JSON.stringify(initialMockData));

  if (typeof window !== 'undefined') {
    const storedDB = sessionStorage.getItem('__MOCK_DB__');
    if (storedDB) {
      try {
        const parsed = JSON.parse(storedDB);
        db = mergeSource(db, parsed);
      } catch (e) {
        logger.error('[Mock Supabase] SessionStorage parse error:', e);
      }
    }
    if (window.__MOCK_DB__) {
      db = mergeSource(db, window.__MOCK_DB__);
    }
  }
  // mergeSource only adds/updates, so seed rows deleted by an RPC would
  // resurrect on the next read. Tombstones recorded via markMockDeleted
  // keep hard deletes durable across re-merges.
  const tombstones = db.__deleted__ || {};
  for (const [table, keys] of Object.entries(tombstones)) {
    if (Array.isArray(db[table]) && Array.isArray(keys) && keys.length > 0) {
      const removed = new Set(keys.map(String));
      db[table] = db[table].filter((row) => !removed.has(tombstoneKey(table, row)));
    }
  }
  return db;
};

// Tables without a single `id` column get a composite tombstone key here;
// everything else keys on String(row.id).
const TOMBSTONE_KEY_FNS = {
  organization_members: (row) => `${row.organization_id}:${row.profile_id}`,
};
const tombstoneKey = (table, row) =>
  TOMBSTONE_KEY_FNS[table] ? TOMBSTONE_KEY_FNS[table](row) : String(row.id);

// Record hard deletes so getDB's seed re-merge cannot resurrect the rows.
// `keys` are tombstone keys: row ids, or composite keys per TOMBSTONE_KEY_FNS.
const markMockDeleted = (db, table, keys) => {
  db.__deleted__ = db.__deleted__ || {};
  const existing = db.__deleted__[table] || [];
  db.__deleted__[table] = Array.from(new Set([...existing, ...keys.map(String)]));
};

/**
 * `public.fields_retirement_deactivates`, the BEFORE INSERT OR UPDATE trigger.
 *
 * **A trigger fires on every write, and this only fired inside the RPC block.**
 * `from('fields').insert()` and `.update()` bypassed it entirely, so a row
 * written directly could sit `active = true` with a retirement already in the
 * past -- a state the database makes unreachable. The shared scenario table
 * seeds its `before` states through `.insert()`, so a case like
 * `{active: true, effectiveTo: -1}` landed as one thing in Postgres and another
 * in the mock, and the two runners were quietly testing different scenarios.
 *
 * One producer at module scope, called from every write path including the
 * RPCs, rather than a copy per call site.
 *
 * @param {Record<string, any>} row - mutated in place, as a BEFORE trigger does
 * @returns {Record<string, any>} `row`
 */
const applyFieldRetirementTrigger = (row) => {
  const today = new Date().toISOString().slice(0, 10);
  if (row && row.effective_to && String(row.effective_to) < today) row.active = false;
  return row;
};

const saveDB = (db) => {
  if (typeof window !== 'undefined') {
    window.__MOCK_DB__ = db;
    sessionStorage.setItem('__MOCK_DB__', JSON.stringify(db));
  }
};

const syncMockFieldSubunits = (db, field, supportsHalves) => {
  db.field_subunits = db.field_subunits || [];

  if (supportsHalves) {
    ['A', 'B'].forEach((label) => {
      const exists = db.field_subunits.some(
        (subunit) =>
          String(subunit.field_id) === String(field.id) && String(subunit.label) === label
      );
      if (exists) return;

      const subunit = {
        id: `sub-${field.id}-${label.toLowerCase()}`,
        field_id: field.id,
        label,
        organization_id: field.organization_id || 'org-1',
      };
      db.field_subunits.push(subunit);
      triggerRealtimeEvent('field_subunits', 'INSERT', { new: subunit, old: null });
    });
    return;
  }

  db.field_subunits = db.field_subunits.filter((subunit) => {
    if (String(subunit.field_id) !== String(field.id)) return true;

    triggerRealtimeEvent('field_subunits', 'DELETE', { new: null, old: subunit });
    return false;
  });
};

// Initial state load
if (typeof window !== 'undefined') {
  window.__MOCK_DB__ = getDB();
}

/**
 * `public.field_closures`, derived the way the SQL view derives it.
 *
 * **Without this, PR 3 has no way to obey the single-reader rule in the mock.**
 * The view is the only sanctioned answer to "is this ground closed on this
 * date", and a mock with no counterpart forces the UI either to query the two
 * tables directly -- reintroducing the two-answers defect the view exists to
 * remove -- or to ship a view nothing exercises.
 *
 * The column split is the SQL's, deliberately: `closes_*` is SCOPE, and
 * `field_location_id` is the site the closed field sits on, which is a
 * different fact. They were one column once and a location filter closed every
 * other pitch on the site.
 *
 * @param {Object} db
 * @returns {Array<Object>}
 */
const deriveFieldClosures = (db) => {
  const fields = db.fields || [];
  const profiles = db.field_availability_profiles || [];
  const fieldById = new Map(fields.map((f) => [String(f.id), f]));

  const admin = (db.field_blackouts || []).map((b) => ({
    id: b.id,
    organization_id: b.organization_id,
    closes_location_id: b.location_id ?? null,
    closes_field_id: b.field_id ?? null,
    field_location_id: b.field_id ? (fieldById.get(String(b.field_id))?.location_id ?? null) : null,
    blackout_from: b.blackout_from,
    blackout_until: b.blackout_until,
    start_minutes: b.start_minutes ?? null,
    end_minutes: b.end_minutes ?? null,
    reason: b.reason ?? null,
    note: b.note ?? null,
    source_reason_text: null,
    source: 'field_blackouts',
  }));

  const imported = (db.field_blackout_windows || []).flatMap((w) => {
    const profile = profiles.find((p) => String(p.id) === String(w.profile_id));
    if (!profile) return [];
    const field = profile.field_id ? fieldById.get(String(profile.field_id)) : undefined;
    return [
      {
        id: w.id,
        organization_id: w.organization_id,
        // NULL, not the field's site: an import window closes its profile's
        // ground and is not site-scoped.
        closes_location_id: null,
        closes_field_id: profile.field_id ?? null,
        field_location_id: field?.location_id ?? null,
        blackout_from: w.blackout_from,
        blackout_until: w.blackout_until,
        start_minutes: null,
        end_minutes: null,
        // No structured reason on this arm; its own words are their own column.
        reason: null,
        note: null,
        source_reason_text: w.reason ?? null,
        source: 'field_blackout_windows',
      },
    ];
  });

  return [...admin, ...imported];
};

export const getMockData = (table, col, val) => {
  const db = getDB();
  let results = table === 'field_closures' ? deriveFieldClosures(db) : db[table] || [];

  if (col && val) {
    results = results.filter((item) => {
      const itemVal = item[col] !== undefined ? String(item[col]) : 'undefined';
      const filterVal = String(val);
      return itemVal === filterVal;
    });
  }

  return results;
};

// ── Chainable Mock Query Builder ────────────────────────────────────────────
const createMockQuery = (table, data = null) => {
  let results = data || getMockData(table);
  let isSingle = false;
  let isMaybeSingle = false;
  let queryContent = '';

  const proxy = {
    select: (query) => {
      queryContent = query;
      if (results && results.length > 0 && queryContent) {
        if (table === 'organization_members' && queryContent.includes('organizations')) {
          const orgs = getMockData('organizations');
          results = results.map((item) => ({
            ...item,
            organizations: orgs.find((o) => String(o.id) === String(item.organization_id)) || null,
          }));
        }
        if (table === 'registrations') {
          if (queryContent.includes('players')) {
            const players = getMockData('players');
            results = results.map((item) => {
              const p = players.find((player) => String(player.id) === String(item.player_id));
              return { ...item, players: p || null };
            });
          }
          if (queryContent.includes('profiles')) {
            const profiles = getMockData('profiles');
            results = results.map((item) => {
              const p = profiles.find((profile) => String(profile.id) === String(item.profile_id));
              return { ...item, profiles: p || null };
            });
          }
        }
        if (table === 'organization_members') {
          if (queryContent.includes('organizations')) {
            const orgs = getMockData('organizations');
            results = results.map((item) => {
              const org = orgs.find((o) => String(o.id) === String(item.organization_id));
              return { ...item, organizations: org || null };
            });
          }
        }
        if (table === 'fields') {
          if (queryContent.includes('field_subunits')) {
            const subunits = getMockData('field_subunits');
            results = results.map((item) => ({
              ...item,
              field_subunits: subunits.filter((s) => String(s.field_id) === String(item.id)) || [],
            }));
          }
          if (queryContent.includes('practice_slots')) {
            const slots = getMockData('practice_slots');
            results = results.map((item) => ({
              ...item,
              practice_slots: slots.filter((s) => String(s.field_id) === String(item.id)) || [],
            }));
          }
        }
        if (
          (table === 'team_players' || table === 'profile_players') &&
          (queryContent.includes('players') || queryContent.includes('player'))
        ) {
          const players = getMockData('players');
          results = results.map((item) => {
            const player = players.find((p) => String(p.id) === String(item.player_id)) || null;
            return { ...item, player: player, players: player };
          });
        }
        if (table === 'teams' && queryContent.includes('event_rsvps')) {
          const rsvps = getMockData('event_rsvps');
          results = results.map((item) => ({
            ...item,
            event_rsvps: rsvps.filter((r) => String(r.team_id) === String(item.id)) || [],
          }));
        }
        if (
          table === 'games' &&
          (queryContent.includes('home_team') || queryContent.includes('away_team'))
        ) {
          const teams = getMockData('teams');
          results = results.map((item) => ({
            ...item,
            home_team: teams.find((t) => String(t.id) === String(item.home_team_id)) || {
              id: item.home_team_id,
              name: 'Home Team',
              division: 'U10',
            },
            away_team: teams.find((t) => String(t.id) === String(item.away_team_id)) || {
              id: item.away_team_id,
              name: 'Away Team',
              division: 'U10',
            },
          }));
        }
        if (
          table === 'practice_assignments' &&
          (queryContent.includes('practice_slots') || queryContent.includes('teams'))
        ) {
          const slots = getMockData('practice_slots');
          const fields = getMockData('fields');
          const teams = getMockData('teams');
          const divisions = getMockData('divisions');

          results = results.map((item) => {
            const slot = slots.find((s) => String(s.id) === String(item.slot_id));
            const team = teams.find((t) => String(t.id) === String(item.team_id));

            let enrichedSlot = slot ? { ...slot } : null;
            if (enrichedSlot) {
              enrichedSlot.fields =
                fields.find((f) => String(f.id) === String(slot.field_id)) || null;
            }

            let enrichedTeam = team ? { ...team } : null;
            if (enrichedTeam) {
              enrichedTeam.divisions =
                divisions.find(
                  (d) =>
                    String(d.id) === String(team.division_id) ||
                    String(d.name) === String(team.division)
                ) || null;
            }

            return { ...item, practice_slots: enrichedSlot, teams: enrichedTeam };
          });
        }
      }
      return proxy;
    },
    eq: (col, val) => {
      results = results.filter((item) => {
        // Handle JSONB path navigation (e.g. 'metadata->user_id')
        if (col.includes('->')) {
          const parts = col.split('->');
          let current = item;
          for (const part of parts) {
            current = current?.[part];
          }
          return String(current) === String(val);
        }
        const itemVal = item[col] !== undefined ? String(item[col]) : 'undefined';
        return itemVal === String(val);
      });
      return proxy;
    },
    not: (col, op, val) => {
      results = results.filter((item) => {
        let current = item;
        if (col.includes('->')) {
          const parts = col.split('->');
          for (const part of parts) {
            current = current?.[part];
          }
        } else {
          current = item[col];
        }

        if (op === 'is' && val === null) {
          return current !== null && current !== undefined;
        }
        return String(current) !== String(val);
      });
      return proxy;
    },
    range: (from, to) => {
      results = results.slice(from, to + 1);
      return proxy;
    },
    lte: (col, val) => {
      results = results.filter((item) => {
        if (item[col] === undefined) return false;
        const itemDate = new Date(item[col]).getTime();
        const valDate = new Date(val).getTime();
        if (!isNaN(itemDate) && !isNaN(valDate)) {
          if (col === 'start_time' && item.id && item.id.startsWith('game-')) {
            return true;
          }
          return itemDate <= valDate;
        }
        return item[col] <= val;
      });
      return proxy;
    },
    neq: (col, val) => {
      results = results.filter((item) => String(item[col]) !== String(val));
      return proxy;
    },
    in: (col, vals) => {
      const valStrings = Array.isArray(vals) ? vals.map(String) : [];
      results = results.filter((item) => valStrings.includes(String(item[col])));
      return proxy;
    },
    order: (col, { ascending } = { ascending: true }) => {
      results = [...results].sort((a, b) => {
        if (a[col] < b[col]) return ascending ? -1 : 1;
        if (a[col] > b[col]) return ascending ? 1 : -1;
        return 0;
      });
      return proxy;
    },
    limit: (n) => {
      results = results.slice(0, n);
      return proxy;
    },
    or: (condition) => {
      const matchesClause = (item, { column, operator, value }) => {
        const current = item[column];
        if (operator === 'eq') return String(current) === String(value);
        if (operator === 'neq') return String(current) !== String(value);
        if (operator === 'is') {
          if (value === 'null') return current === null || current === undefined;
          if (value === 'not.null') return current !== null && current !== undefined;
          return String(current) === String(value);
        }
        if (operator === 'in') {
          const values = value
            .replace(/^\(/, '')
            .replace(/\)$/, '')
            .split(',')
            .map((entry) => entry.trim());
          return values.includes(String(current));
        }

        logger.warn(`[Mock Supabase] Unsupported OR operator "${operator}" in ${condition}`);
        return true;
      };

      const clauses = String(condition || '')
        .split(',')
        .map((clause) => clause.trim())
        .filter(Boolean)
        .map((clause) => {
          const [column, operator, ...valueParts] = clause.split('.');
          return {
            column,
            operator,
            value: valueParts.join('.'),
          };
        })
        .filter(({ column, operator, value }) => column && operator && value);

      if (clauses.length === 0) return proxy;

      results = results.filter(
        (item) =>
          clauses.every(({ column }) => !(column in item)) ||
          clauses.some((clause) => matchesClause(item, clause))
      );
      return proxy;
    },
    abortSignal: () => proxy,
    single: () => {
      isSingle = true;
      return proxy;
    },
    maybeSingle: () => {
      isMaybeSingle = true;
      return proxy;
    },
    then: (onFulfilled, onRejected) => {
      let finalData = JSON.parse(JSON.stringify(results));
      let error = null;

      if (isSingle) {
        if (results.length > 0) {
          finalData = results[0];
        } else {
          finalData = null;
          error = { code: 'PGRST116', message: 'No rows found' };
        }
      } else if (isMaybeSingle) {
        finalData = results.length > 0 ? results[0] : null;
      }

      return Promise.resolve({ data: finalData, error }).then(onFulfilled, onRejected);
    },
    catch: (onRejected) =>
      Promise.resolve({ data: null, error: 'Mock error' }).then(null, onRejected),
  };
  return proxy;
};

// ── Mock Supabase Client ────────────────────────────────────────────────────

/** @type {any} */
export const mockSupabase = {
  auth: {
    signInWithPassword: async ({ email, password }) => {
      const testPassword = import.meta.env.VITE_TEST_PASSWORD || 'test-password-123';
      if (password === testPassword) {
        const role = email.split('@')[0];
        const userId = `mock-${role}-id`;
        const session = {
          user: {
            id: userId,
            email,
            user_metadata: { full_name: `Mock ${role.charAt(0).toUpperCase() + role.slice(1)}` },
            app_metadata: { role: role === 'admin' || role === 'coach' ? role : 'parent' },
          },
          access_token: 'mock-token',
        };

        const db = (typeof window !== 'undefined' && window.__MOCK_DB__) || initialMockData;

        const typedDb = /** @type {any} */ (db);

        if (!typedDb.profiles.find((p) => p.id === userId)) {
          typedDb.profiles.push({
            id: userId,
            full_name: session.user.user_metadata.full_name,
            role: session.user.app_metadata.role,
          });
        }

        if (!typedDb.organization_members.find((m) => m.profile_id === userId)) {
          typedDb.organization_members.push({
            organization_id: 'org-1',
            profile_id: userId,
            role: session.user.app_metadata.role,
          });
        }

        if (typeof window !== 'undefined') {
          sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify(session));
          window.__MOCK_DB__ = db;
        }

        setTimeout(() => triggerAuthEvent('SIGNED_IN', session), 50);
        return { data: { session, user: session.user }, error: null };
      }
      return { data: { session: null, user: null }, error: { message: 'Invalid credentials' } };
    },
    signOut: async () => {
      if (typeof window !== 'undefined') {
        sessionStorage.removeItem('__MOCK_SESSION__');
      }
      setTimeout(() => triggerAuthEvent('SIGNED_OUT', null), 50);
      return { error: null };
    },
    onAuthStateChange: (callback) => {
      mockSubscriptionCallback = callback;
      let session = null;
      if (typeof window !== 'undefined') {
        const stored = sessionStorage.getItem('__MOCK_SESSION__');
        if (stored) session = JSON.parse(stored);
      }
      setTimeout(() => callback(session ? 'SIGNED_IN' : 'INITIAL_SESSION', session), 0);
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              mockSubscriptionCallback = null;
            },
          },
        },
      };
    },
    getSession: async () => {
      let session = null;
      if (typeof window !== 'undefined') {
        const stored = sessionStorage.getItem('__MOCK_SESSION__');
        if (stored) session = JSON.parse(stored);
      }
      return { data: { session }, error: null };
    },
    getUser: async () => {
      let session = null;
      if (typeof window !== 'undefined') {
        const stored = sessionStorage.getItem('__MOCK_SESSION__');
        if (stored) session = JSON.parse(stored);
      }
      return { data: { user: session?.user || null }, error: null };
    },
    signUp: async ({ email, password, options: _options }) => {
      if (password.length < 12) {
        return {
          data: { user: null, session: null },
          error: {
            message:
              'Database error: Password must be at least 12 characters long (Postgres Trigger Enforcement)',
          },
        };
      }
      // Simple mock signup
      return { data: { user: { id: 'new-user', email }, session: null }, error: null };
    },
    updateUser: async ({ password, data: _data }) => {
      if (password && password.length < 12) {
        return {
          data: { user: null },
          error: {
            message:
              'Database error: Password must be at least 12 characters long (Postgres Trigger Enforcement)',
          },
        };
      }
      return { data: { user: { id: 'mock-admin-id' } }, error: null };
    },
  },
  from: (table) => {
    const query = createMockQuery(table);
    return {
      ...query,
      insert: (records) => {
        const db = getDB();
        const newRecords = (Array.isArray(records) ? records : [records]).map((r) => {
          const id = r.id || mockId();
          if (table === 'fields' && r.supports_halves) {
            db.field_subunits = db.field_subunits || [];
            db.field_subunits.push({
              id: `sub-${id}-a`,
              field_id: id,
              label: 'A',
              organization_id: r.organization_id || 'org-1',
            });
            db.field_subunits.push({
              id: `sub-${id}-b`,
              field_id: id,
              label: 'B',
              organization_id: r.organization_id || 'org-1',
            });
          }
          const built = { id, created_at: new Date().toISOString(), ...r };
          if (table === 'fields') applyFieldRetirementTrigger(built);
          return built;
        });
        db[table] = [...(db[table] || []), ...newRecords];
        saveDB(db);
        const res = { data: Array.isArray(records) ? newRecords : newRecords[0], error: null };
        const chainable = {
          select: () => chainable,
          single: () =>
            Promise.resolve({
              data: newRecords[0] || null,
              error: null,
            }),
          maybeSingle: () =>
            Promise.resolve({
              data: newRecords[0] || null,
              error: null,
            }),
          then: (onFulfilled, onRejected) => Promise.resolve(res).then(onFulfilled, onRejected),
        };
        return chainable;
      },
      upsert: (records) => {
        const db = getDB();
        const newRecords = (Array.isArray(records) ? records : [records]).map((r) => ({
          id: r.id || mockId(),
          created_at: r.created_at || new Date().toISOString(),
          ...r,
        }));
        const existing = db[table] || [];
        const eventsToFire = [];

        newRecords.forEach((rec) => {
          let idx = -1;
          if (table === 'event_rsvps') {
            idx = existing.findIndex(
              (item) =>
                String(item.player_id) === String(rec.player_id) &&
                String(item.reference_id) === String(rec.reference_id) &&
                String(item.occurrence_date) === String(rec.occurrence_date)
            );
          } else {
            idx = existing.findIndex((item) => String(item.id) === String(rec.id));
          }

          const oldRecord = idx >= 0 ? { ...existing[idx] } : null;
          if (idx >= 0) {
            existing[idx] = { ...existing[idx], ...rec };
            if (table === 'fields') applyFieldRetirementTrigger(existing[idx]);
          } else {
            if (table === 'fields') applyFieldRetirementTrigger(rec);
            existing.push(rec);
          }

          eventsToFire.push({
            table,
            event: idx >= 0 ? 'UPDATE' : 'INSERT',
            payload: { new: rec, old: oldRecord },
          });

          if (table === 'fields' && rec.supports_halves !== undefined) {
            if (rec.supports_halves) {
              db.field_subunits = db.field_subunits || [];
              if (!db.field_subunits.some((s) => String(s.field_id) === String(rec.id))) {
                db.field_subunits.push({
                  id: `sub-${rec.id}-a`,
                  field_id: rec.id,
                  label: 'A',
                  organization_id: rec.organization_id || 'org-1',
                });
                db.field_subunits.push({
                  id: `sub-${rec.id}-b`,
                  field_id: rec.id,
                  label: 'B',
                  organization_id: rec.organization_id || 'org-1',
                });
              }
            } else {
              db.field_subunits = (db.field_subunits || []).filter((s) => {
                if (String(s.field_id) === String(rec.id)) {
                  triggerRealtimeEvent('field_subunits', 'DELETE', { new: null, old: s });
                  return false;
                }
                return true;
              });
            }
          }
        });

        db[table] = existing;
        saveDB(db);

        eventsToFire.forEach((e) => triggerRealtimeEvent(e.table, e.event, e.payload));

        const res = { data: newRecords, error: null };
        const chainable = {
          select: () => chainable,
          single: () =>
            Promise.resolve({
              data: newRecords[0] || null,
              error: null,
            }),
          maybeSingle: () =>
            Promise.resolve({
              data: newRecords[0] || null,
              error: null,
            }),
          then: (onFulfilled, onRejected) => Promise.resolve(res).then(onFulfilled, onRejected),
        };
        return chainable;
      },
      update: (updates) => {
        return {
          eq: (col, val) => {
            const db = getDB();
            let updatedItem = null;
            if (db[table]) {
              db[table] = db[table].map((item) => {
                if (String(item[col]) === String(val)) {
                  updatedItem = { ...item, ...updates };
                  if (table === 'fields') applyFieldRetirementTrigger(updatedItem);

                  if (table === 'games' && updates.score_home !== undefined) {
                    db.view_league_standings = db.view_league_standings || [];
                    const home = db.view_league_standings.find(
                      (s) => String(s.team_id) === String(item.home_team_id)
                    );
                    const away = db.view_league_standings.find(
                      (s) => String(s.team_id) === String(item.away_team_id)
                    );
                    if (home && away) {
                      const sh = Number(updates.score_home);
                      const sa = Number(updates.score_away);
                      if (
                        !(
                          isNaN(sh) ||
                          isNaN(sa) ||
                          updates.score_home === null ||
                          updates.score_away === null
                        )
                      ) {
                        if (sh > sa) {
                          home.wins++;
                          away.losses++;
                          home.points += 3;
                        } else if (sa > sh) {
                          away.wins++;
                          home.losses++;
                          away.points += 3;
                        } else {
                          home.draws++;
                          away.draws++;
                          home.points += 1;
                          away.points += 1;
                        }
                        home.games_played++;
                        away.games_played++;
                        home.goals_for += sh;
                        home.goals_against += sa;
                        away.goals_for += sa;
                        away.goals_against += sh;
                        home.goal_differential += sh - sa;
                        away.goal_differential += sa - sh;
                      }
                    }
                  }

                  if (table === 'fields' && updates.supports_halves !== undefined) {
                    if (updates.supports_halves) {
                      db.field_subunits = db.field_subunits || [];
                      if (!db.field_subunits.some((s) => String(s.field_id) === String(item.id))) {
                        const subA = {
                          id: `sub-${item.id}-a`,
                          field_id: item.id,
                          label: 'A',
                          organization_id: item.organization_id || 'org-1',
                        };
                        const subB = {
                          id: `sub-${item.id}-b`,
                          field_id: item.id,
                          label: 'B',
                          organization_id: item.organization_id || 'org-1',
                        };
                        db.field_subunits.push(subA, subB);
                        triggerRealtimeEvent('field_subunits', 'INSERT', { new: subA, old: null });
                        triggerRealtimeEvent('field_subunits', 'INSERT', { new: subB, old: null });
                      }
                    } else {
                      db.field_subunits = (db.field_subunits || []).filter((s) => {
                        if (String(s.field_id) === String(item.id)) {
                          triggerRealtimeEvent('field_subunits', 'DELETE', { new: null, old: s });
                          return false;
                        }
                        return true;
                      });
                    }
                  }
                  return updatedItem;
                }
                return item;
              });
              saveDB(db);
            }
            const res = { data: updatedItem, error: null };
            const chainable = {
              select: () => chainable,
              single: () => Promise.resolve({ data: updatedItem, error: null }),
              maybeSingle: () => Promise.resolve({ data: updatedItem, error: null }),
              then: (onFulfilled, onRejected) => Promise.resolve(res).then(onFulfilled, onRejected),
            };
            return chainable;
          },
        };
      },
      delete: () => {
        return {
          eq: (col, val) => {
            const db = getDB();
            if (db[table]) {
              db[table] = db[table].filter((item) => String(item[col]) !== String(val));
              saveDB(db);
            }
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
    };
  },
  channel: (name) => {
    const table = name.split(':')[0];
    return {
      on: (type, config, callback) => {
        realtimeCallbacks.push({
          table: config.table || table,
          event: config.event || '*',
          callback,
        });
        return {
          subscribe: () => ({
            unsubscribe: () => {
              const idx = realtimeCallbacks.findIndex((cb) => cb.callback === callback);
              if (idx >= 0) realtimeCallbacks.splice(idx, 1);
            },
          }),
        };
      },
      send: ({ type, event, payload }) => {
        realtimeCallbacks.forEach((cb) => {
          // If the listener is for this channel name (or table) and event type
          if (cb.table === name || cb.table === table) {
            cb.callback({ event, payload, type });
          }
        });
        return Promise.resolve('ok');
      },
      subscribe: (statusCallback) => {
        if (statusCallback) setTimeout(() => statusCallback('SUBSCRIBED'), 0);
        return {
          unsubscribe: () => {
            // Cleanup if needed
          },
        };
      },
    };
  },
  removeChannel: (channel) => {
    if (channel && channel.unsubscribe) channel.unsubscribe();
  },
  rpc: async (name, params) => {
    const db = getDB();
    const storedSession =
      typeof window !== 'undefined' ? sessionStorage.getItem('__MOCK_SESSION__') : null;
    const currentUserId = storedSession
      ? JSON.parse(storedSession)?.user?.id || 'mock-admin-id'
      : 'mock-admin-id';
    const isOrgAdmin = (organizationId) => {
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(organizationId) &&
          String(item.profile_id) === String(currentUserId)
      );
      return ['admin', 'tenant_admin'].includes(String(member?.role || ''));
    };

    if (name === 'initialize_new_tenant') {
      const { p_name, p_slug, p_timezone, p_season_year } = params || {};
      const storedSession =
        typeof window !== 'undefined' ? sessionStorage.getItem('__MOCK_SESSION__') : null;
      const userId = storedSession ? JSON.parse(storedSession)?.user?.id : 'mock-admin-id';

      if (!userId) {
        return { data: null, error: { message: 'User authentication is required' } };
      }
      if (!p_name || typeof p_name !== 'string' || !p_name.trim()) {
        return { data: null, error: { message: 'Organization name is required' } };
      }
      if (
        !p_slug ||
        typeof p_slug !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p_slug.trim())
      ) {
        return { data: null, error: { message: 'Organization slug format is invalid' } };
      }
      if (!p_timezone || typeof p_timezone !== 'string' || !p_timezone.trim()) {
        return { data: null, error: { message: 'Organization timezone is required' } };
      }
      if (!Number.isInteger(p_season_year) || p_season_year < 2000 || p_season_year > 3000) {
        return { data: null, error: { message: 'Season year must be between 2000 and 3000' } };
      }

      const normalizedSlug = p_slug.trim();
      const existing = (db.organizations || []).some(
        (org) => String(org.slug || '').toLowerCase() === normalizedSlug.toLowerCase()
      );
      if (existing) {
        return { data: null, error: { message: 'duplicate key value' } };
      }

      const orgId = mockId();
      const seasonId = mockId();
      db.organizations = db.organizations || [];
      db.organization_members = db.organization_members || [];
      db.season_settings = db.season_settings || [];
      db.audit_log = db.audit_log || [];

      db.organizations.push({
        id: orgId,
        name: p_name.trim(),
        slug: normalizedSlug,
        contact_info: { timezone: p_timezone.trim() },
      });
      db.organization_members.push({ organization_id: orgId, profile_id: userId, role: 'admin' });
      db.season_settings.push({
        id: seasonId,
        organization_id: orgId,
        name: `${p_season_year} Season`,
        status: 'active',
        season_year: p_season_year,
        season_label: `${p_season_year} Season`,
        created_at: new Date().toISOString(),
      });
      db.audit_log.push({
        id: mockId(),
        organization_id: orgId,
        action: 'settings.updated',
        user_id: userId,
        metadata: { action: 'initialization', creator: userId },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: orgId, error: null };
    }

    if (name === 'submit_registration') {
      const {
        p_organization_id,
        p_form_id,
        p_profile_id,
        p_responses,
        p_player_id,
        p_first_name,
        p_last_name,
      } = params;

      let playerId = p_player_id;
      if (!playerId && p_first_name && p_last_name) {
        playerId = mockId();
        db.players.push({
          id: playerId,
          first_name: p_first_name,
          last_name: p_last_name,
          organization_id: p_organization_id,
        });
        db.profile_players.push({
          profile_id: p_profile_id,
          player_id: playerId,
        });
      }

      const registration = {
        id: mockId(),
        organization_id: p_organization_id,
        form_id: p_form_id,
        player_id: playerId,
        profile_id: p_profile_id,
        responses: p_responses,
        waiver_signed: true,
        medical_cleared: false,
        created_at: new Date().toISOString(),
      };

      db.registrations = db.registrations || [];
      db.registrations.push(registration);
      saveDB(db);

      return { data: registration.id, error: null };
    }

    if (name === 'admin_create_registration_form') {
      const created = {
        id: mockId(),
        organization_id: params.p_organization_id,
        title: params.p_title,
        description: params.p_description ?? null,
        season_id: params.p_season_id ?? null,
        fields: params.p_fields ?? [],
        status: params.p_status || 'open',
        waiver_text: params.p_waiver_text ?? null,
        created_at: new Date().toISOString(),
      };
      db.registration_forms.unshift(created);
      saveDB(db);

      return { data: created, error: null };
    }

    if (name === 'get_organization_members') {
      const { p_organization_id } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const caller = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(p_organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!caller) {
        return { data: null, error: { message: 'Access denied: membership required' } };
      }
      const rows = (db.organization_members || [])
        .filter((item) => String(item.organization_id) === String(p_organization_id))
        .map((item) => {
          const profile = (db.profiles || []).find((p) => String(p.id) === String(item.profile_id));
          return {
            profile_id: item.profile_id,
            role: item.role,
            created_at: item.created_at || new Date().toISOString(),
            email: profile?.email ?? null,
            full_name: profile?.full_name ?? null,
            first_name: profile?.first_name ?? null,
            last_name: profile?.last_name ?? null,
          };
        });
      return { data: rows, error: null };
    }

    if (name === 'revoke_org_invite') {
      const { p_invite_id: inviteId, p_organization_id: orgId } = params || {};
      const invite = db.organization_invites?.find(({ id }) => id === inviteId);

      if (!invite || invite.organization_id !== orgId || invite.used_at) {
        return { data: null, error: { message: 'Invite cannot be revoked' } };
      }

      db.organization_invites = db.organization_invites.filter(({ id }) => id !== inviteId);
      saveDB(db);

      return { data: inviteId, error: null };
    }

    if (
      (import.meta.env.DEV || import.meta.env.VITE_USE_MOCK_SUPABASE === 'true') &&
      name === 'admin_upsert_organization_schema'
    ) {
      const p = params || {};
      const entityType = String(p.p_entity_type || '')
        .trim()
        .toLowerCase();
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(p.p_organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );

      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Admin role is required' } };
      }
      if (!SCHEMA_ENTITIES.has(entityType)) {
        return { data: null, error: { message: `Invalid schema entity type: ${p.p_entity_type}` } };
      }
      if (
        !p.p_schema_definition ||
        Array.isArray(p.p_schema_definition) ||
        typeof p.p_schema_definition !== 'object'
      ) {
        return { data: null, error: { message: 'Schema definition must be a JSON object' } };
      }

      const normalized = {};
      for (const [fieldName, rawType] of Object.entries(p.p_schema_definition)) {
        if (!String(fieldName).trim()) {
          return { data: null, error: { message: 'Schema field names must not be blank' } };
        }
        if (RESERVED_KEYS.has(fieldName)) {
          return { data: null, error: { message: `Schema field ${fieldName} is reserved` } };
        }
        if (typeof rawType !== 'string') {
          return { data: null, error: { message: `Schema field ${fieldName} must map to text` } };
        }
        const fieldType = rawType.trim().toLowerCase();
        if (!SCHEMA_VALUE_TYPES.has(fieldType)) {
          return {
            data: null,
            error: { message: `Schema field ${fieldName} has unsupported type ${fieldType}` },
          };
        }
        normalized[fieldName] = fieldType;
      }

      const rows = db.organization_schemas || (db.organization_schemas = []);
      let row = rows.find(
        (item) =>
          String(item.organization_id) === String(p.p_organization_id) &&
          String(item.entity_type) === entityType
      );
      let changed = true;

      if (!row) {
        row = {
          id: mockId(),
          organization_id: p.p_organization_id,
          entity_type: entityType,
        };
        rows.push(row);
      } else {
        changed = stableSchemaKey(row.schema_definition) !== stableSchemaKey(normalized);
      }
      row.schema_definition = normalized;

      if (changed) {
        db.audit_log = db.audit_log || [];
        db.audit_log.push({
          id: mockId(),
          organization_id: p.p_organization_id,
          user_id: session?.user?.id,
          action: 'settings.updated',
          resource_type: 'organization_schema',
          resource_id: row.id,
          metadata: {
            setting: 'organization_schema',
            entity_type: entityType,
            current: normalized,
          },
          created_at: new Date().toISOString(),
        });
      }
      saveDB(db);

      return { data: { ...row, changed }, error: null };
    }

    if (
      (import.meta.env.DEV || import.meta.env.VITE_USE_MOCK_SUPABASE === 'true') &&
      ['upsert_team_event_rsvp', 'create_team_message'].includes(name)
    ) {
      const p = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const userId = session?.user?.id;
      const team = (db.teams || []).find((item) => String(item.id) === String(p.p_team_id));
      const orgId = team?.organization_id;
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(orgId) &&
          String(item.profile_id) === String(userId)
      );
      const isAdmin = ['admin', 'tenant_admin'].includes(String(member?.role || ''));
      const isParentOnTeam = () =>
        (db.profile_players || []).some(
          (profilePlayer) =>
            String(profilePlayer.profile_id) === String(userId) &&
            (db.team_players || []).some(
              (teamPlayer) =>
                String(teamPlayer.team_id) === String(p.p_team_id) &&
                String(teamPlayer.player_id) === String(profilePlayer.player_id)
            )
        );
      const isAssignedCoach = () =>
        (db.coaches || []).some(
          (coach) =>
            String(coach.organization_id) === String(orgId) &&
            [coach.user_id, coach.profile_id].map(String).includes(String(userId)) &&
            (String(coach.id) === String(team?.coach_id) ||
              (team?.assistant_coach_ids || []).map(String).includes(String(coach.id)))
        );
      const audit = (action, resourceType, resourceId, metadata) => {
        db.audit_log = db.audit_log || [];
        db.audit_log.push({
          id: mockId(),
          organization_id: orgId,
          user_id: userId,
          action,
          resource_type: resourceType,
          resource_id: resourceId,
          metadata,
          created_at: new Date().toISOString(),
        });
      };

      if (!userId || !team || !member) {
        return { data: null, error: { message: 'Team is outside the caller organization' } };
      }

      if (name === 'upsert_team_event_rsvp') {
        if (!['game', 'practice'].includes(p.p_event_type)) {
          return { data: null, error: { message: 'event_type must be game or practice' } };
        }
        if (!['attending', 'declined', 'maybe'].includes(p.p_status)) {
          return { data: null, error: { message: 'status must be attending, declined, or maybe' } };
        }

        const playerOnTeam = (db.players || []).some(
          (player) =>
            String(player.id) === String(p.p_player_id) &&
            String(player.organization_id) === String(orgId) &&
            (db.team_players || []).some(
              (teamPlayer) =>
                String(teamPlayer.team_id) === String(p.p_team_id) &&
                String(teamPlayer.player_id) === String(p.p_player_id)
            )
        );
        if (!playerOnTeam) {
          return { data: null, error: { message: 'Player is outside the requested team' } };
        }

        const canManagePlayer =
          isAdmin ||
          (db.profile_players || []).some(
            (profilePlayer) =>
              String(profilePlayer.profile_id) === String(userId) &&
              String(profilePlayer.player_id) === String(p.p_player_id)
          );
        if (!canManagePlayer) {
          return { data: null, error: { message: 'Caller cannot manage RSVP for this player' } };
        }

        const normalizeDate = (value) => String(value || '').slice(0, 10);
        const rangeContainsDate = (range, date) => {
          const [start, end] = String(range || '')
            .replace(/[()[\]]/g, '')
            .split(',');
          return Boolean(start && end && date >= start && date < end);
        };
        const dayCodeForDate = (date) => {
          const day = new Date(`${date}T00:00:00Z`).getUTCDay();
          return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day];
        };
        const slotDayForAssignment = (assignment) => {
          const slot =
            assignment.slot ||
            (db.practice_slots || []).find(
              (practiceSlot) =>
                String(practiceSlot.id) ===
                String(assignment.practice_slot_id || assignment.slot_id)
            );
          return String(assignment.day_of_week || slot?.day_of_week || '').toLowerCase();
        };

        const referenceAllowed =
          p.p_event_type === 'game'
            ? (db.games || []).some((game) => {
                const gameSlot = (db.game_slots || []).find(
                  (slot) => String(slot.id) === String(game.game_slot_id)
                );
                const gameDate = normalizeDate(
                  gameSlot?.slot_date || gameSlot?.start || game.start_time
                );
                return (
                  String(game.id) === String(p.p_reference_id) &&
                  String(game.organization_id) === String(orgId) &&
                  [game.home_team_id, game.away_team_id]
                    .map(String)
                    .includes(String(p.p_team_id)) &&
                  gameDate === normalizeDate(p.p_occurrence_date)
                );
              })
            : (db.practice_assignments || []).some(
                (assignment) =>
                  String(assignment.id) === String(p.p_reference_id) &&
                  String(assignment.team_id) === String(p.p_team_id) &&
                  rangeContainsDate(assignment.effective_date_range, p.p_occurrence_date) &&
                  slotDayForAssignment(assignment) === dayCodeForDate(p.p_occurrence_date)
              );
        if (!referenceAllowed) {
          return {
            data: null,
            error: { message: 'Event reference is outside the requested team' },
          };
        }

        db.event_rsvps = db.event_rsvps || [];
        const existingIndex = db.event_rsvps.findIndex(
          (rsvp) =>
            String(rsvp.player_id) === String(p.p_player_id) &&
            String(rsvp.reference_id) === String(p.p_reference_id) &&
            String(rsvp.occurrence_date) === String(p.p_occurrence_date)
        );
        const previous = existingIndex >= 0 ? { ...db.event_rsvps[existingIndex] } : null;
        const rsvp = {
          ...(previous || {}),
          id: previous?.id || mockId(),
          organization_id: orgId,
          team_id: p.p_team_id,
          player_id: p.p_player_id,
          reference_id: p.p_reference_id,
          event_type: p.p_event_type,
          occurrence_date: p.p_occurrence_date,
          status: p.p_status,
          updated_at: new Date().toISOString(),
        };
        const changed = !previous || previous.status !== rsvp.status;
        if (existingIndex >= 0) {
          db.event_rsvps[existingIndex] = rsvp;
        } else {
          db.event_rsvps.push(rsvp);
        }
        if (changed) {
          audit('team.rsvp_updated', 'event_rsvp', rsvp.id, {
            team_id: p.p_team_id,
            player_id: p.p_player_id,
            reference_id: p.p_reference_id,
            event_type: p.p_event_type,
            occurrence_date: p.p_occurrence_date,
            previous_status: previous?.status || null,
            status: rsvp.status,
          });
        }
        saveDB(db);
        triggerRealtimeEvent('event_rsvps', previous ? 'UPDATE' : 'INSERT', {
          new: rsvp,
          old: previous,
        });
        return { data: { rsvp, changed }, error: null };
      }

      const content = String(p.p_content || '').trim();
      if (!content) {
        return { data: null, error: { message: 'Message content is required' } };
      }
      if (content.length > 4000) {
        return { data: null, error: { message: 'Message content exceeds 4000 characters' } };
      }
      if (!isAdmin && !isAssignedCoach() && !isParentOnTeam()) {
        return { data: null, error: { message: 'Caller cannot post messages for this team' } };
      }

      const message = {
        id: mockId(),
        organization_id: orgId,
        team_id: p.p_team_id,
        author_id: userId,
        content,
        created_at: new Date().toISOString(),
      };
      db.team_messages = db.team_messages || [];
      db.team_messages.push(message);
      audit('team.message_created', 'team_message', message.id, {
        team_id: p.p_team_id,
        content_length: content.length,
      });
      saveDB(db);
      triggerRealtimeEvent('team_messages', 'INSERT', { new: message, old: null });
      return { data: { message }, error: null };
    }

    if (
      (import.meta.env.DEV || import.meta.env.VITE_USE_MOCK_SUPABASE === 'true') &&
      [
        'admin_create_location',
        'admin_create_field',
        'admin_update_field',
        'admin_delete_field',
        'admin_retire_field',
        'admin_unretire_field',
        'admin_create_field_blackout',
        'admin_delete_field_blackout',
      ].includes(name)
    ) {
      const p = params || {};
      const orgId = p.p_organization_id;
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(orgId) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Admin role is required' } };
      }

      // **The retirement trigger, mirrored.** Without this an ordinary field
      // edit un-retires ground in the mock while the real database silently
      // refuses -- and PR 3's UI would be built against the fiction.
      const todayIso = () => new Date().toISOString().slice(0, 10);

      // `public.field_is_live_on(p_effective_to)` with the default `p_on`.
      // Inclusive on the end date; NULL means unbounded and therefore live.
      const fieldIsLiveOn = (effectiveTo) =>
        effectiveTo === null || effectiveTo === undefined || String(effectiveTo) >= todayIso();

      // Delegates to the module-scope producer rather than reimplementing it;
      // two copies of a trigger is how one write path came to have it and the
      // others did not.
      const applyRetirementTrigger = applyFieldRetirementTrigger;

      // **`upper()` on a daterange, mirrored.** PostgreSQL normalizes a
      // discrete range to `[lower, upper)`, so `upper('[a,b]')` is b + 1 and
      // `upper('[a,b)')` is b. Both spellings appear in this repo's fixtures,
      // and reading the closing literal as "the last day covered" would judge
      // an inclusive range one day short -- an assignment on the retirement
      // date itself would be reported unaffected. Returns null when there is
      // no upper bound at all, which is what `upper_inf` is true for.
      const rangeUpperBound = (range) => {
        const text = String(range || '');
        const match = /^[[(]([^,]*),([^,]*)([\])])$/.exec(text);
        if (match === null) return null;
        const end = match[2].trim();
        if (end === '') return null;
        if (match[3] === ')') return end;
        const next = new Date(`${end}T00:00:00Z`);
        if (Number.isNaN(next.getTime())) return null;
        next.setUTCDate(next.getUTCDate() + 1);
        return next.toISOString().slice(0, 10);
      };

      const audit = (resourceType, resourceId, operation, payload) => {
        db.audit_log = db.audit_log || [];
        db.audit_log.push({
          id: mockId(),
          organization_id: orgId,
          user_id: session?.user?.id,
          action: 'settings.updated',
          resource_type: resourceType,
          resource_id: resourceId,
          metadata: { setting: `facility.${resourceType}`, operation, ...payload },
          created_at: new Date().toISOString(),
        });
      };

      if (name === 'admin_create_location') {
        const locationName = String(p.p_name || '').trim();
        if (!locationName) {
          return { data: null, error: { message: 'location name is required' } };
        }
        const location = {
          id: mockId(),
          organization_id: orgId,
          name: locationName,
          address: p.p_address || null,
          lighting_available: Boolean(p.p_lighting_available),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        db.locations = db.locations || [];
        db.locations.push(location);
        audit('location', location.id, 'created', { current: location });
        saveDB(db);
        return { data: location, error: null };
      }

      const location = (db.locations || []).find(
        (item) =>
          String(item.id) === String(p.p_location_id) &&
          String(item.organization_id) === String(orgId)
      );
      // **Only the RPCs that take a location are held to one.** This guard used
      // to be "every name in the block except admin_delete_field", which was
      // correct while the block held four names that all carried a
      // p_location_id. The 8.4 lifecycle RPCs do not: a retirement names a
      // field, and a blackout may be scoped to a field instead. Naming the
      // RPCs that require a location is the reading that stays true as the
      // block grows.
      const REQUIRES_LOCATION = ['admin_create_field', 'admin_update_field'];
      if (REQUIRES_LOCATION.includes(name) && !location) {
        return { data: null, error: { message: 'Location is outside organization' } };
      }

      if (name === 'admin_create_field') {
        const fieldName = String(p.p_name || '').trim();
        if (!fieldName) return { data: null, error: { message: 'field name is required' } };
        const priorityRating = p.p_priority_rating ?? 1;
        if (priorityRating < 1) {
          return { data: null, error: { message: 'priority_rating must be at least 1' } };
        }
        const field = {
          id: mockId(),
          organization_id: orgId,
          location_id: p.p_location_id,
          name: fieldName,
          surface_type: p.p_surface_type || null,
          size: p.p_size || null,
          supports_halves: Boolean(p.p_supports_halves),
          priority_rating: priorityRating,
          active: p.p_active !== false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        db.fields = db.fields || [];
        db.fields.push(field);
        syncMockFieldSubunits(db, field, field.supports_halves);
        audit('field', field.id, 'created', { current: field });
        saveDB(db);
        return { data: field, error: null };
      }

      if (name === 'admin_create_field_blackout') {
        // Mirrors the RPC's scope rule: exactly one of location or field. The
        // mock enforces it because the E2E suite is the only place this path
        // runs, so a mock that accepted both would let a defect the database
        // would refuse pass every test.
        const scopeCount = [p.p_location_id, p.p_field_id].filter(
          (value) => value !== null && value !== undefined
        ).length;
        if (scopeCount !== 1) {
          return {
            data: null,
            error: {
              code: '22023',
              message: 'exactly one of p_location_id and p_field_id must be set',
            },
          };
        }
        if (
          p.p_location_id &&
          !(db.locations || []).some(
            (item) =>
              String(item.id) === String(p.p_location_id) &&
              String(item.organization_id) === String(orgId)
          )
        ) {
          return {
            data: null,
            error: { code: 'P0002', message: 'Location not found in organization' },
          };
        }
        if (
          p.p_field_id &&
          !(db.fields || []).some(
            (item) =>
              String(item.id) === String(p.p_field_id) &&
              String(item.organization_id) === String(orgId)
          )
        ) {
          return {
            data: null,
            error: { code: 'P0002', message: 'Field not found in organization' },
          };
        }
        // **The table's constraints, mirrored -- all of them.** The E2E suite is
        // the only place this path runs, and the mock is the contract PR 3 is
        // written against, so a mock looser than the database is a defect
        // generator for the next PR. The first draft mirrored three CHECKs and
        // missed the reason enum and the NOT NULL dates.
        if (!p.p_blackout_from || !p.p_blackout_until) {
          return {
            data: null,
            error: { code: '22023', message: 'blackout_from and blackout_until are required' },
          };
        }
        const REASONS = ['maintenance', 'weather', 'event', 'permit', 'closed', 'other'];
        if (p.p_reason !== null && p.p_reason !== undefined && !REASONS.includes(p.p_reason)) {
          return {
            data: null,
            error: { code: '23514', message: `reason must be one of ${REASONS.join(', ')}` },
          };
        }
        if (String(p.p_blackout_until) < String(p.p_blackout_from)) {
          return {
            data: null,
            error: { code: '23514', message: 'blackout_until must not precede blackout_from' },
          };
        }
        const timeCount = [p.p_start_minutes, p.p_end_minutes].filter(
          (value) => value !== null && value !== undefined
        ).length;
        if (timeCount === 1) {
          return {
            data: null,
            error: { code: '23514', message: 'start_minutes and end_minutes are both-or-neither' },
          };
        }
        if (
          timeCount === 2 &&
          !(
            p.p_start_minutes >= 0 &&
            p.p_start_minutes <= 1440 &&
            p.p_end_minutes >= 0 &&
            p.p_end_minutes <= 1440 &&
            p.p_end_minutes > p.p_start_minutes
          )
        ) {
          return {
            data: null,
            error: { code: '23514', message: 'blackout times must be within 0..1440 and ordered' },
          };
        }
        const hasTimes =
          p.p_start_minutes !== null &&
          p.p_start_minutes !== undefined &&
          p.p_end_minutes !== null &&
          p.p_end_minutes !== undefined;
        const blackout = {
          id: mockId(),
          organization_id: orgId,
          location_id: p.p_location_id ?? null,
          field_id: p.p_field_id ?? null,
          blackout_from: p.p_blackout_from,
          blackout_until: p.p_blackout_until,
          start_minutes: hasTimes ? p.p_start_minutes : null,
          end_minutes: hasTimes ? p.p_end_minutes : null,
          reason: p.p_reason || 'other',
          note: p.p_note ?? null,
          // The migration's column, which the mock omitted -- a row shape the
          // database produces and the mock did not.
          created_by: session?.user?.id ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        db.field_blackouts = db.field_blackouts || [];
        // Before/after phases, matching the RPC. The mock recorded a single
        // undifferentiated entry, so nothing exercised the audit shape the
        // migration is explicit about.
        audit('field_blackout', null, 'created', {
          operation: 'admin_create_field_blackout',
          phase: 'before',
          requested: {
            location_id: p.p_location_id ?? null,
            field_id: p.p_field_id ?? null,
            blackout_from: p.p_blackout_from,
            blackout_until: p.p_blackout_until,
          },
        });
        db.field_blackouts.push(blackout);
        audit('field_blackout', blackout.id, 'created', {
          operation: 'admin_create_field_blackout',
          phase: 'after',
          current: blackout,
        });
        saveDB(db);
        return { data: blackout, error: null };
      }

      if (name === 'admin_delete_field_blackout') {
        const existing = (db.field_blackouts || []).find(
          (item) =>
            String(item.id) === String(p.p_blackout_id) &&
            String(item.organization_id) === String(orgId)
        );
        if (!existing) {
          return { data: null, error: { message: 'Blackout not found in organization' } };
        }
        // **Tombstoned, like every other hard delete.** `getDB()` re-merges the
        // seed on each read and only `markMockDeleted` survives it, so a
        // blackout that came from an E2E injection resurrected on the next
        // call. `admin_delete_field` got this fix and its blackout twin did
        // not -- the same sibling gap, one function along.
        markMockDeleted(db, 'field_blackouts', [existing.id]);
        db.field_blackouts = (db.field_blackouts || []).filter(
          (item) => String(item.id) !== String(p.p_blackout_id)
        );
        audit('field_blackout', existing.id, 'deleted', {
          operation: 'admin_delete_field_blackout',
          phase: 'before',
          previous: existing,
        });
        audit('field_blackout', existing.id, 'deleted', {
          operation: 'admin_delete_field_blackout',
          phase: 'after',
          deleted: true,
        });
        saveDB(db);
        return { data: { deleted: true, blackout: existing }, error: null };
      }

      const field = (db.fields || []).find(
        (item) =>
          String(item.id) === String(p.p_field_id) && String(item.organization_id) === String(orgId)
      );
      if (!field) {
        return {
          data: null,
          error: { code: 'P0002', message: 'Field not found in organization' },
        };
      }

      // **One enumerator for "what is booked on this field", used by both
      // admin_retire_field and admin_delete_field.**
      //
      // The booking tables were written out twice in the SQL -- once in
      // each RPC -- and writing them out twice HERE as well is the shape that
      // produced every HIGH in three consecutive rounds of PR 2: a correction
      // landing on one arm and not its twin. The two callers differ in exactly
      // one thing, the date, so that is the parameter.
      //
      // `after` is an ISO date: bookings on or before it are unaffected. `null`
      // means NO date applies -- a deletion takes everything on the ground,
      // dated or not -- which is a different answer from an empty filter.
      //
      // `undated` means the row records no date at all, so it cannot be judged
      // (and, for a deletion, cannot be shown to the operator). `unbounded`
      // means it runs forever and is therefore CERTAINLY affected. Two
      // different answers, never collapsed into one.
      //
      // **One enumerator, no options -- both callers see the same five kinds.**
      //
      // An earlier version made `games` and slot-reached assignments DELETE-only
      // on the reasoning that a retirement destroys nothing. That was wrong in
      // the same way the SQL was: a retirement that cannot see the fixture on
      // its ground UNDER-REPORTS, and the operator confirms against an
      // incomplete list. What differs between the two callers is the DATE and
      // nothing else, so that is the only parameter.
      //
      // Mirrors `public.field_bookings(p_organization_id, p_field_id, p_after)`.
      //
      // @param {string} fieldId
      // @param {string|null} after `null` means no date applies -- a deletion
      //   takes everything on the ground, which is not the same as an empty
      //   filter.
      const fieldBookings = (fieldId, after) => {
        // A row with no date of its own is affected whatever `after` says.
        // **An empty string is "no date", not a date before every date.** The
        // field-import apply path writes `valid_until: ''` for an open-ended
        // practice slot, and `'' <= anything` is true -- so a slot that is
        // certainly stranded was being dropped from the affected list while
        // the same row still reported `unbounded: true`. The pre-diff filters
        // used `!slot.valid_until`, which treats '' as absent; this restores
        // that meaning for every kind at once.
        const undatedValue = (value) =>
          value === null || value === undefined || String(value) === '';
        const past = (value) => after !== null && !undatedValue(value) && String(value) <= after;
        const gameDate = (slot) =>
          slot.slot_date || (slot.start ? String(slot.start).slice(0, 10) : null);
        const mine = (row) =>
          String(row.organization_id) === String(orgId) && String(row.field_id) === String(fieldId);

        const slotIdsOn = (table) =>
          new Set(
            (db[table] || [])
              .filter((row) => String(row.field_id) === String(fieldId))
              .map((row) => String(row.id))
          );
        const gameSlotIds = slotIdsOn('game_slots');
        const practiceSlotIds = slotIdsOn('practice_slots');
        const onGameSlot = (row) =>
          gameSlotIds.has(String(row.game_slot_id)) || gameSlotIds.has(String(row.slot_id));
        const onPracticeSlot = (row) =>
          practiceSlotIds.has(String(row.practice_slot_id)) ||
          practiceSlotIds.has(String(row.slot_id));
        const inScope = (row, viaSlot) =>
          String(row.organization_id) === String(orgId) &&
          (String(row.field_id) === String(fieldId) || viaSlot(row));

        return [
          ...(db.game_slots || [])
            .filter((slot) => mine(slot) && !past(gameDate(slot)))
            .map((slot) => ({
              kind: 'game_slot',
              id: slot.id,
              on_date: gameDate(slot),
              week_index: slot.week_index ?? null,
              undated: !gameDate(slot),
              unbounded: false,
              cascades: true,
            })),
          ...(db.practice_slots || [])
            .filter((slot) => mine(slot) && !past(slot.valid_until ?? null))
            .map((slot) => ({
              kind: 'practice_slot',
              id: slot.id,
              // **`undatedValue` is the single reading, projection included.**
              // The filter above already treats `valid_until: ''` -- what the
              // field-import apply path writes for an open-ended slot -- as no
              // date, but the projection still passed the `''` through, so this
              // row read `{on_date: '', unbounded: true}` here and
              // `{on_date: null, unbounded: true}` in Postgres, where an empty
              // string is not a storable date. A consumer branching on
              // `on_date === null` took different paths on the two arms for
              // precisely the row this hunk was written for.
              on_date: undatedValue(slot.valid_until) ? null : slot.valid_until,
              week_index: null,
              // Unbounded, therefore CERTAINLY stranded -- not unjudged.
              undated: false,
              unbounded: undatedValue(slot.valid_until),
              cascades: true,
            })),
          // **The assignment tables.** The mock enumerated the two SLOT tables
          // only, so the E2E client reported `affected_count: 0` for a field
          // with every game assigned to it -- the migration's own header calls
          // that out as gutting the acceptance criterion, and the mock
          // reproduced the defect the SQL had already been fixed for. A mock
          // that disagrees with the database about who is affected is a second
          // answer to a question that is supposed to have one.
          // `games` carries no field_id and dies with the slot, score and all.
          // A census by column name could not see it; this list comes from the
          // cascade closure instead. Its date is its slot's, so a retirement
          // judges it against the same day the slot is judged against.
          ...(db.games || [])
            .filter((row) => {
              if (!gameSlotIds.has(String(row.game_slot_id))) return false;
              const slot = (db.game_slots || []).find(
                (candidate) => String(candidate.id) === String(row.game_slot_id)
              );
              return !past(slot ? gameDate(slot) : null);
            })
            .map((row) => {
              const slot = (db.game_slots || []).find(
                (candidate) => String(candidate.id) === String(row.game_slot_id)
              );
              return {
                kind: 'game',
                id: row.id,
                on_date: slot ? gameDate(slot) : null,
                week_index: slot?.week_index ?? null,
                undated: !(slot && gameDate(slot)),
                unbounded: false,
                cascades: true,
              };
            }),
          ...(db.game_assignments || [])
            .filter(
              (row) =>
                inScope(row, onGameSlot) && !past(row.start ? String(row.start).slice(0, 10) : null)
            )
            .map((row) => ({
              kind: 'game_assignment',
              id: row.id,
              on_date: row.start ? String(row.start).slice(0, 10) : null,
              week_index: row.week_index ?? null,
              undated: !row.start,
              unbounded: false,
              // **Per row, not per table.** `field_id` is SET NULL, but the
              // slot columns are CASCADE, so a scheduler-produced assignment is
              // destroyed while a free-standing one survives venueless. The
              // producer computes it for both callers; retire ignores it,
              // because a retirement destroys nothing.
              cascades: onGameSlot(row),
            })),
          ...(db.practice_assignments || [])
            .filter(
              (row) =>
                inScope(row, onPracticeSlot) && !past(rangeUpperBound(row.effective_date_range))
            )
            .map((row) => {
              // `null` upper covers both "no range at all" and an unbounded
              // one; the SQL treats both as running forever.
              const upper = rangeUpperBound(row.effective_date_range);
              return {
                kind: 'practice_assignment',
                id: row.id,
                on_date: upper,
                week_index: null,
                undated: false,
                unbounded: upper === null,
                cascades: onPracticeSlot(row),
              };
            }),
        ];
      };

      // **The audit row is BOUNDED, here as in the database.** A refusal writes
      // the affected list into `audit_log.metadata`, and a delete refused on a
      // busy field would otherwise write an arbitrarily large row on every
      // attempt. `public.field_bookings_digest` caps it at a sample plus the
      // totals the sample is a sample of, and this is that function -- same
      // keys, same limit, same reading of an empty list.
      //
      // Writing the raw array here while the database wrote the digest is the
      // exact divergence this PR exists to remove, one level up: a consumer
      // reading `metadata.affected.total` would get `undefined` under the mock
      // and a number in production, or read `.length` and get the reverse.
      const fieldBookingsDigest = (affected, limit = 25) => {
        const rows = Array.isArray(affected) ? affected : [];
        const byKind = {};
        for (const row of rows) {
          byKind[row.kind] = (byKind[row.kind] || 0) + 1;
        }
        return {
          total: rows.length,
          omitted: Math.max(rows.length - limit, 0),
          by_kind: byKind,
          sample: rows.slice(0, limit),
        };
      };

      if (name === 'admin_retire_field') {
        if (!p.p_effective_to) {
          return { data: null, error: { message: 'p_effective_to is required' } };
        }
        // **The refusal is here, not in the UI.** A slot with no start date
        // cannot be judged against the retirement date, so it counts as
        // affected rather than being dropped -- the same reading the SQL takes.
        // The enumeration itself is the shared one above, so a correction to
        // who counts as booked reaches retire and delete together.
        // The shared enumerator, then the six keys retire's payload carries:
        // `cascades` is the producer's answer to "would a delete destroy this",
        // which a retirement has no use for and whose SQL twin never emits.
        const affected = fieldBookings(p.p_field_id, String(p.p_effective_to)).map(
          ({ cascades: _cascades, ...row }) => row
        );
        // `p_confirm` NULL or undefined reads as UNCONFIRMED, matching
        // `NOT COALESCE(p_confirm, false)`. The SQL used a bare `NOT p_confirm`
        // until this PR, so `p_confirm => NULL` retired booked ground with
        // nobody confirming while the mock refused it -- the two arms
        // disagreeing on the one input that turns the guard off.
        if (affected.length > 0 && p.p_confirm !== true) {
          audit('field', field.id, 'updated', {
            operation: 'admin_retire_field',
            phase: 'refused',
            affected_count: affected.length,
            affected: fieldBookingsDigest(affected),
            previous: { ...field },
          });
          saveDB(db);
          return {
            data: {
              retired: false,
              reason: 'bookings_after_effective_to',
              affected_count: affected.length,
              affected,
            },
            error: null,
          };
        }
        const previous = { ...field };
        audit('field', field.id, 'updated', {
          operation: 'admin_retire_field',
          phase: 'before',
          effective_to: p.p_effective_to,
          confirmed: Boolean(p.p_confirm),
          affected_count: affected.length,
          affected: fieldBookingsDigest(affected),
          before: previous,
        });
        // **A retirement can only ever REMOVE activity. It never grants it.**
        // `v_before.active AND field_is_live_on(p_effective_to)`, exactly as
        // the SQL writes it. This said `active: true` unconditionally, so
        // retiring an ALREADY-DEACTIVATED field with a future date handed it
        // back to the scheduler -- while `docs/sql/20260906000000_smoke.sql`
        // asserted the opposite in Postgres. The mock was the arm that did not
        // get round 2's fix.
        Object.assign(field, {
          effective_to: p.p_effective_to,
          active: previous.active !== false && fieldIsLiveOn(p.p_effective_to),
          updated_at: new Date().toISOString(),
        });
        applyRetirementTrigger(field);
        audit('field', field.id, 'updated', {
          operation: 'admin_retire_field',
          phase: 'after',
          effective_to: p.p_effective_to,
          confirmed: Boolean(p.p_confirm),
          affected_count: affected.length,
          previous,
          current: field,
        });
        saveDB(db);
        return {
          // **The successful retirement reports what it stranded, too.** Its
          // SQL twin returns `'affected', v_affected` on this path as well as
          // on the refusal, and dropping the key here left a confirmed
          // retirement unable to tell the operator WHICH bookings it just
          // closed over -- the same list, one confirmation later. Found by the
          // mechanism census: every site writing `affected`, not the twin of
          // any one fix.
          data: { retired: true, affected_count: affected.length, affected, field },
          error: null,
        };
      }

      if (name === 'admin_unretire_field') {
        const previous = { ...field };
        audit('field', field.id, 'updated', {
          operation: 'admin_unretire_field',
          phase: 'before',
          before: previous,
        });
        // **Unretiring clears the date and leaves `active` exactly as it was.**
        // `active = v_before.active` in the SQL. This wrote `active: true`, so
        // unretiring an ORDINARILY deactivated field -- one nobody ever retired
        // -- silently reactivated it. Worse than a divergence: the suite
        // asserted `after.active === true` right after an unretire, so a
        // passing test certified the bug rather than catching it.
        Object.assign(field, {
          effective_to: null,
          active: previous.active !== false,
          updated_at: new Date().toISOString(),
        });
        applyRetirementTrigger(field);
        audit('field', field.id, 'updated', {
          operation: 'admin_unretire_field',
          phase: 'after',
          previous,
          current: field,
        });
        saveDB(db);
        return { data: { retired: false, field }, error: null };
      }

      if (name === 'admin_update_field') {
        const fieldName = String(p.p_name || '').trim();
        if (!fieldName) return { data: null, error: { message: 'field name is required' } };
        const priorityRating = p.p_priority_rating ?? 1;
        if (priorityRating < 1) {
          return { data: null, error: { message: 'priority_rating must be at least 1' } };
        }
        const previous = { ...field };
        Object.assign(field, {
          location_id: p.p_location_id,
          name: fieldName,
          surface_type: p.p_surface_type || null,
          size: p.p_size || null,
          supports_halves: Boolean(p.p_supports_halves),
          priority_rating: priorityRating,
          active: p.p_active !== false,
          updated_at: new Date().toISOString(),
        });
        applyRetirementTrigger(field);
        syncMockFieldSubunits(db, field, field.supports_halves);
        audit('field', field.id, 'updated', { previous, current: field });
        saveDB(db);
        return { data: field, error: null };
      }

      // **Named, not reached by falling off the end of the block.** This arm
      // used to be the implicit `else`: every RPC name in the list above that
      // no branch had claimed performed a field DELETE. It was correct while
      // the list held four names; PR 2 added four more, and the only reason
      // none of them deleted a field is that each happened to return first. A
      // silent default arm on a destructive operation is not a thing to leave
      // standing, so the name is checked and an unclaimed one is a loud error.
      if (name === 'admin_delete_field') {
        // **What deleting the field does to each row.** The slot tables and
        // `games` are reached only by CASCADE, so they are always destroyed.
        // The assignment tables reach the field TWICE -- SET NULL on field_id
        // and CASCADE through their slot columns -- so they decide per row, and
        // the enumerator has already worked out which by setting `cascades`. A
        // flat per-kind map was the first version of this, and it told the
        // operator every assignment would survive: false for every row the
        // scheduler writes, since `persist_game_schedule` and
        // `persist_practice_schedule` always populate the slot columns.
        const ALWAYS_DELETED = ['game_slot', 'practice_slot', 'game'];
        const DECIDES_PER_ROW = ['game_assignment', 'practice_assignment'];
        // No date: a deletion takes everything on the ground. Games and
        // via-slot assignments are delete-only, so retire never sees them.
        const affected = fieldBookings(p.p_field_id, null).map((row) => {
          // Every switch over a union throws on the value it does not know. A
          // sixth booking kind must stop here rather than be reported to the
          // operator with an undefined consequence.
          // `cascades` is stripped on EVERY arm, not just the per-row ones.
          // Leaving it on the always-deleted kinds put a key in the payload
          // that the SQL never emits -- the same leak as retire's, one branch
          // along, and caught only once something asserted the key set.
          const { cascades, ...rest } = row;
          if (ALWAYS_DELETED.includes(row.kind)) return { ...rest, disposition: 'deleted' };
          if (DECIDES_PER_ROW.includes(row.kind)) {
            return { ...rest, disposition: cascades ? 'deleted' : 'unassigned' };
          }
          throw new Error(`unknown booking kind "${row.kind}"`);
        });

        // **The refusal, in the same shape admin_retire_field uses**: it
        // RETURNS rather than raising, and it records the decision it refused.
        // A caller that only checks PostgREST's `error` sees this as success,
        // which is why `useFields.deleteField` reads `data.deleted`.
        if (affected.length > 0 && p.p_confirm !== true) {
          audit('field', field.id, 'deleted', {
            operation: 'admin_delete_field',
            phase: 'refused',
            reason: 'bookings_exist',
            affected_count: affected.length,
            affected: fieldBookingsDigest(affected),
            previous: { ...field },
          });
          saveDB(db);
          return {
            data: {
              deleted: false,
              reason: 'bookings_exist',
              affected_count: affected.length,
              affected,
            },
            error: null,
          };
        }

        const previous = { ...field };
        audit('field', field.id, 'deleted', {
          operation: 'admin_delete_field',
          phase: 'before',
          confirmed: Boolean(p.p_confirm),
          affected_count: affected.length,
          affected: fieldBookingsDigest(affected),
          previous,
        });

        // **The schema's own consequences, mirrored.** The mock removed the
        // field and its blackouts and left everything else pointing at it, so
        // a confirmed delete looked harmless here and lost a schedule in
        // Postgres -- the fiction PR 3's UI would have been built against.
        // `field_subunits`, `field_blackouts`, `game_slots` and
        // `practice_slots` are ON DELETE CASCADE; `game_assignments` and
        // `practice_assignments` are ON DELETE SET NULL, so the booking
        // survives with its venue visibly gone.
        //
        // **Every cascade is TOMBSTONED, and that is not tidiness.** `getDB()`
        // re-merges the seed on every read and only `markMockDeleted` survives
        // it, so a delete that merely filtered the array resurrected any
        // SEEDED row on the next call. The previous arm did exactly that: it
        // reported `deleted: true` for a seeded field that was still there
        // afterwards, and nothing noticed because the only test that deleted a
        // field deleted one it had just created.
        const destroy = (table, doomed) => {
          if (doomed.length === 0) return;
          const ids = new Set(doomed.map((item) => String(item.id)));
          markMockDeleted(db, table, [...ids]);
          db[table] = (db[table] || []).filter((item) => !ids.has(String(item.id)));
        };
        const onField = (table) =>
          (db[table] || []).filter((item) => String(item.field_id) === String(p.p_field_id));
        // The rows the RPC just reported as `deleted` are the rows destroyed
        // here -- read out of `affected` rather than recomputed, so the report
        // and the effect cannot disagree.
        //
        // Keyed by KIND, not pooled into one id set: a pooled set is correct
        // only while ids never collide across `games`, `game_assignments` and
        // `practice_assignments`, which is an assumption about test fixtures
        // rather than a property of the data.
        const TABLE_FOR_KIND = {
          game_slot: 'game_slots',
          practice_slot: 'practice_slots',
          game: 'games',
          game_assignment: 'game_assignments',
          practice_assignment: 'practice_assignments',
        };
        /** @type {Record<string, Set<string>>} */
        const doomedByTable = {};
        for (const row of affected) {
          if (row.disposition !== 'deleted') continue;
          const table = TABLE_FOR_KIND[row.kind];
          if (table === undefined) throw new Error(`no table known for booking kind "${row.kind}"`);
          (doomedByTable[table] ??= new Set()).add(String(row.id));
        }
        const reported = (table) =>
          (db[table] || []).filter((item) => doomedByTable[table]?.has(String(item.id)));

        destroy('field_subunits', onField('field_subunits'));
        destroy('field_blackouts', onField('field_blackouts'));
        destroy('games', reported('games'));
        destroy('game_assignments', reported('game_assignments'));
        destroy('practice_assignments', reported('practice_assignments'));
        destroy('game_slots', onField('game_slots'));
        destroy('practice_slots', onField('practice_slots'));

        // Whatever survived keeps its row and loses its venue. That covers the
        // free-standing assignments and `field_availability_profiles`, whose
        // field_id is ON DELETE SET NULL (20260522120000) and which the mock
        // left pointing at a deleted field -- visible on the /fields page,
        // which renders those profiles.
        for (const table of [
          'game_assignments',
          'practice_assignments',
          'field_availability_profiles',
        ]) {
          for (const row of db[table] || []) {
            if (String(row.field_id) === String(p.p_field_id)) row.field_id = null;
          }
        }
        markMockDeleted(db, 'fields', [field.id]);
        db.fields = (db.fields || []).filter((item) => String(item.id) !== String(p.p_field_id));

        audit('field', field.id, 'deleted', {
          operation: 'admin_delete_field',
          phase: 'after',
          confirmed: Boolean(p.p_confirm),
          affected_count: affected.length,
          deleted: true,
          previous,
        });
        saveDB(db);
        return {
          data: {
            id: field.id,
            organization_id: orgId,
            deleted: true,
            affected_count: affected.length,
            affected,
          },
          error: null,
        };
      }

      throw new Error(`mock facility RPC "${name}" is listed but has no arm`);
    }

    if (
      (import.meta.env.DEV || import.meta.env.VITE_USE_MOCK_SUPABASE === 'true') &&
      name === 'update_game_score'
    ) {
      await mockSupabase
        .from('games')
        .update({ score_home: params?.p_score_home, score_away: params?.p_score_away })
        .eq('id', params?.p_game_id);
      return {
        data: {
          score_home: params?.p_score_home,
          score_away: params?.p_score_away,
        },
        error: null,
      };
    }

    if (name === 'record_audit_event') {
      const { p_organization_id, p_action, p_user_id, p_metadata } = params;

      const event = {
        id: mockId(),
        organization_id: p_organization_id,
        action: p_action,
        user_id: p_user_id,
        metadata: p_metadata,
        created_at: new Date().toISOString(),
      };

      db.audit_log = db.audit_log || [];
      db.audit_log.push(event);
      saveDB(db);

      return { data: true, error: null };
    }

    if (name === 'create_import_job') {
      const { p_organization_id, p_import_type, p_file_name } = params || {};
      const importType = String(p_import_type || '')
        .trim()
        .toLowerCase();
      const fileName = String(p_file_name || '')
        .trim()
        .replace(/[/\\:]+/g, '_');

      if (!p_organization_id) {
        return { data: null, error: { message: 'organization_id is required' } };
      }
      if (!isOrgAdmin(p_organization_id)) {
        return {
          data: null,
          error: { message: 'Only organization admins can create import jobs' },
        };
      }
      if (!['players', 'coaches', 'fields', 'field_availability'].includes(importType)) {
        return { data: null, error: { message: `invalid import type: ${p_import_type}` } };
      }
      if (!fileName) {
        return { data: null, error: { message: 'file_name is required' } };
      }

      const now = new Date().toISOString();
      const jobType =
        importType === 'fields'
          ? 'fields'
          : importType === 'field_availability'
            ? 'field_availability'
            : 'registration';
      const job = {
        id: mockId('import-job-'),
        organization_id: p_organization_id,
        job_type: jobType,
        storage_path: `imports/${currentUserId}/${fileName}`,
        status: 'importing',
        total_rows: 0,
        processed_rows: 0,
        progress_percent: 0,
        error_summary: {},
        warning_summary: {},
        efficiency_metadata: {},
        created_by: currentUserId,
        started_at: now,
        created_at: now,
        completed_at: null,
        last_heartbeat_at: now,
      };

      db.import_jobs = db.import_jobs || [];
      db.import_jobs.push(job);
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId('audit-import-started-'),
        organization_id: p_organization_id,
        action: 'import.started',
        user_id: currentUserId,
        resource_type: 'import_job',
        resource_id: job.id,
        metadata: {
          import_type: importType,
          job_type: jobType,
          file_name: fileName,
          status: 'importing',
        },
        created_at: now,
      });
      saveDB(db);

      return { data: job, error: null };
    }

    if (name === 'update_import_job_progress') {
      const {
        p_import_job_id,
        p_progress_percent,
        p_processed_rows,
        p_total_rows,
        p_efficiency_metadata,
      } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );

      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }
      if (!isOrgAdmin(job.organization_id)) {
        return {
          data: null,
          error: { message: 'Only organization admins can update import job progress' },
        };
      }
      if (!['queued', 'processing', 'importing'].includes(job.status)) {
        return { data: null, error: { message: `Import job is ${job.status}, not active` } };
      }
      if (
        p_progress_percent !== null &&
        p_progress_percent !== undefined &&
        (p_progress_percent < 0 || p_progress_percent > 100)
      ) {
        return { data: null, error: { message: 'progress_percent must be between 0 and 100' } };
      }
      if (p_processed_rows !== null && p_processed_rows !== undefined && p_processed_rows < 0) {
        return { data: null, error: { message: 'processed_rows cannot be negative' } };
      }
      if (p_total_rows !== null && p_total_rows !== undefined && p_total_rows < 0) {
        return { data: null, error: { message: 'total_rows cannot be negative' } };
      }
      if (
        p_efficiency_metadata !== null &&
        p_efficiency_metadata !== undefined &&
        (Array.isArray(p_efficiency_metadata) || typeof p_efficiency_metadata !== 'object')
      ) {
        return { data: null, error: { message: 'efficiency_metadata must be an object' } };
      }

      const nextTotalRows =
        p_total_rows !== null && p_total_rows !== undefined ? p_total_rows : job.total_rows || 0;
      const nextProcessedRows =
        p_processed_rows !== null && p_processed_rows !== undefined
          ? p_processed_rows
          : job.processed_rows || 0;
      if (nextTotalRows > 0 && nextProcessedRows > nextTotalRows) {
        return { data: null, error: { message: 'processed_rows cannot exceed total_rows' } };
      }

      Object.assign(job, {
        progress_percent:
          p_progress_percent !== null && p_progress_percent !== undefined
            ? p_progress_percent
            : job.progress_percent,
        processed_rows: nextProcessedRows,
        total_rows: nextTotalRows,
        efficiency_metadata:
          p_efficiency_metadata !== null && p_efficiency_metadata !== undefined
            ? p_efficiency_metadata
            : job.efficiency_metadata,
        last_heartbeat_at: new Date().toISOString(),
      });
      saveDB(db);

      return { data: job, error: null };
    }

    if (name === 'fail_import_job') {
      const { p_import_job_id, p_message, p_error_summary } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      const message = String(p_message || '').trim();
      const errorSummary =
        p_error_summary && !Array.isArray(p_error_summary) && typeof p_error_summary === 'object'
          ? p_error_summary
          : {};

      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }
      if (!isOrgAdmin(job.organization_id)) {
        return { data: null, error: { message: 'Only organization admins can fail import jobs' } };
      }
      if (!message) {
        return { data: null, error: { message: 'failure message is required' } };
      }
      if (['completed', 'completed_with_warnings'].includes(job.status)) {
        return { data: null, error: { message: 'Completed import job cannot be failed' } };
      }

      const now = new Date().toISOString();
      const previousStatus = job.status;
      Object.assign(job, {
        status: 'failed',
        completed_at: now,
        last_heartbeat_at: now,
        error_summary: {
          ...(job.error_summary || {}),
          ...errorSummary,
          message,
        },
      });
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId('audit-import-failed-'),
        organization_id: job.organization_id,
        action: 'import.failed',
        user_id: currentUserId,
        resource_type: 'import_job',
        resource_id: p_import_job_id,
        metadata: {
          stage: errorSummary.stage || 'client_lifecycle',
          previous_status: previousStatus,
          message,
          failed_at: now,
        },
        created_at: now,
      });
      saveDB(db);

      return { data: job, error: null };
    }

    if (name === 'fail_stale_import_jobs') {
      const { p_organization_id, p_stale_before } = params || {};
      if (!p_organization_id) {
        return { data: null, error: { message: 'Organization id is required' } };
      }

      const staleBefore = p_stale_before
        ? new Date(p_stale_before)
        : new Date(Date.now() - 5 * 60 * 1000);
      const now = new Date().toISOString();
      const failedJobIds = [];

      db.import_jobs = db.import_jobs || [];
      db.import_jobs.forEach((job) => {
        if (String(job.organization_id) !== String(p_organization_id)) return;
        if (!['queued', 'processing', 'importing'].includes(job.status)) return;

        const heartbeat = new Date(
          job.last_heartbeat_at || job.started_at || job.created_at || now
        );
        if (!(heartbeat < staleBefore)) return;

        const cleanup = {
          status: 'failed',
          previous_status: job.status,
          last_heartbeat_at: heartbeat.toISOString(),
          stale_before: staleBefore.toISOString(),
          failed_at: now,
          message: 'Import job heartbeat expired and was marked failed for retry',
        };

        job.status = 'failed';
        job.completed_at = now;
        job.error_summary = {
          ...(job.error_summary || {}),
          stale_cleanup: cleanup,
        };
        failedJobIds.push(job.id);
      });

      const result = {
        status: 'completed',
        failed_jobs: failedJobIds.length,
        job_ids: failedJobIds,
        stale_before: staleBefore.toISOString(),
        cleaned_at: now,
      };

      if (failedJobIds.length > 0) {
        db.audit_log = db.audit_log || [];
        db.audit_log.push({
          id: mockId('audit-stale-'),
          organization_id: p_organization_id,
          action: 'import.failed',
          user_id: 'mock-admin-id',
          resource_type: 'import_job',
          resource_id: null,
          metadata: {
            stage: 'stale_cleanup',
            failed_jobs: failedJobIds.length,
            job_ids: failedJobIds,
            stale_before: staleBefore.toISOString(),
            cleaned_at: now,
          },
          created_at: now,
        });

        saveDB(db);
      }

      return { data: result, error: null };
    }

    if (name === 'get_team_portal_medical_status') {
      const teamId = params?.p_team_id;
      const team = (db.teams || []).find((item) => String(item.id) === String(teamId));
      const rosterPlayerIds = (db.team_players || [])
        .filter((row) => String(row.team_id) === String(teamId))
        .map((row) => String(row.player_id));
      const registrations = db.registrations || [];

      return {
        data: rosterPlayerIds.map((playerId) => {
          const registration = registrations.find(
            (row) =>
              String(row.organization_id) === String(team?.organization_id) &&
              String(row.player_id) === String(playerId)
          );

          return {
            player_id: playerId,
            medical_cleared: registration?.medical_cleared === true,
          };
        }),
        error: null,
      };
    }

    if (name === 'rotate_calendar_token') {
      const newToken = mockId('mock-calendar-token-');
      const teamId = params?.p_team_id;
      if (teamId) {
        const teams = db.teams || [];
        const team = teams.find((t) => String(t.id) === String(teamId));
        if (team) {
          team.calendar_token = newToken;
          team.calendar_token_expires_at = new Date(Date.now() + 90 * 86400000).toISOString();
          saveDB(db);
        }
      }
      return {
        data: { status: 'ok', calendar_token: newToken, message: 'Token rotated' },
        error: null,
      };
    }

    if (name === 'update_org_feature_flags') {
      return { data: true, error: null };
    }

    if (name === 'log_telemetry_event') {
      return { data: true, error: null };
    }

    if (name === 'finalize_onboarding') {
      return { data: true, error: null };
    }

    if (name === 'get_settings_audit_log') {
      const logs = (db.audit_log || [])
        .filter((e) => String(e.organization_id) === String(params?.p_organization_id))
        .map((e) => ({
          actor_name: 'Mock Admin',
          actor_email: 'admin@example.com',
          action: e.action,
          metadata: e.metadata,
          created_at: e.created_at,
        }));
      return { data: logs, error: null };
    }

    if (name === 'mark_import_job_ready_to_apply') {
      const { p_import_job_id, p_import_type, p_validation_errors } = params || {};
      const importType = String(p_import_type || '').toLowerCase();
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }
      if (!['coaches', 'fields', 'field_availability'].includes(importType)) {
        return {
          data: null,
          error: {
            message: 'Only coach, field, and field_availability imports support deferred apply',
          },
        };
      }
      if (importType === 'coaches' && job.job_type !== 'registration') {
        return { data: null, error: { message: 'Import job is not registration' } };
      }
      if (importType === 'fields' && job.job_type !== 'fields') {
        return { data: null, error: { message: 'Import job is not fields' } };
      }
      if (importType === 'field_availability' && job.job_type !== 'field_availability') {
        return { data: null, error: { message: 'Import job is not field_availability' } };
      }
      if (['completed', 'completed_with_warnings', 'failed'].includes(job.status)) {
        return { data: null, error: { message: `Import job is ${job.status}` } };
      }

      const validationErrors = Array.isArray(p_validation_errors) ? p_validation_errors : [];
      const stagedRows = (db.staging_import_rows || []).filter(
        (row) =>
          String(row.import_job_id) === String(p_import_job_id) && row.import_type === importType
      ).length;
      const result = {
        status: 'ready_to_apply',
        import_type: importType,
        staged_rows: stagedRows,
        validation_error_rows: validationErrors.length,
        ready_at: new Date().toISOString(),
      };

      Object.assign(job, {
        status: 'ready_to_apply',
        processed_rows: stagedRows,
        progress_percent: 100,
        completed_at: null,
        error_summary: { rowErrors: validationErrors },
        warning_summary: {
          ...(job.warning_summary || {}),
          deferred_apply: result,
        },
      });
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId('audit-ready-'),
        organization_id: job.organization_id,
        action: 'import.validated',
        user_id: 'mock-admin-id',
        resource_type: 'import_job',
        resource_id: p_import_job_id,
        metadata: result,
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: result, error: null };
    }

    if (name === 'cancel_ready_import_job') {
      const { p_import_job_id, p_import_type } = params || {};
      const importType = String(p_import_type || '').toLowerCase();
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }
      if (!['coaches', 'fields', 'field_availability'].includes(importType)) {
        return {
          data: null,
          error: {
            message:
              'Only coach, field, and field_availability imports support deferred cancellation',
          },
        };
      }
      if (job.status !== 'ready_to_apply') {
        return { data: null, error: { message: `Import job is ${job.status}` } };
      }

      const stagedRows = (db.staging_import_rows || []).filter(
        (row) =>
          String(row.import_job_id) === String(p_import_job_id) && row.import_type === importType
      ).length;
      const result = {
        status: 'canceled',
        import_type: importType,
        staged_rows: stagedRows,
        canceled_at: new Date().toISOString(),
      };

      Object.assign(job, {
        status: 'failed',
        completed_at: result.canceled_at,
        error_summary: {
          ...(job.error_summary || {}),
          deferred_apply: result,
        },
        warning_summary: {
          ...(job.warning_summary || {}),
          deferred_apply: result,
        },
      });
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId('audit-cancel-'),
        organization_id: job.organization_id,
        action: 'import.canceled',
        user_id: 'mock-admin-id',
        resource_type: 'import_job',
        resource_id: p_import_job_id,
        metadata: result,
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: result, error: null };
    }

    if (name === 'upsert_division_for_import') {
      const { p_organization_id, p_season_settings_id, p_name, p_gender } = params || {};
      db.divisions = db.divisions || [];
      let division = db.divisions.find(
        (item) =>
          String(item.organization_id) === String(p_organization_id) &&
          String(item.name).toLowerCase() === String(p_name).toLowerCase()
      );
      if (division) {
        if (p_gender) division.gender_policy = p_gender;
      } else {
        division = {
          id: mockId(),
          organization_id: p_organization_id,
          season_settings_id: p_season_settings_id,
          name: p_name,
          gender_policy: p_gender || 'coed',
          created_at: new Date().toISOString(),
        };
        db.divisions.push(division);
      }
      saveDB(db);
      return { data: { ...division }, error: null };
    }

    if (name === 'admin_update_player' || name === 'coach_update_player_compliance') {
      const { p_player_id, p_patch } = params || {};
      const player = (db.players || []).find((item) => String(item.id) === String(p_player_id));
      if (!player) {
        return { data: null, error: { message: `player ${p_player_id} not found` } };
      }
      const allowed =
        name === 'coach_update_player_compliance'
          ? ['paid', 'waiver_received', 'medical_form_received']
          : [
              'first_name',
              'last_name',
              'preferred_name',
              'gender',
              'grade',
              'notes',
              'buddy_request',
              'status',
              'rating',
              'years_played',
              'jersey_number',
              'paid',
              'waiver_received',
              'medical_form_received',
              'willing_to_coach',
              'division_id',
              'team_id',
              'date_of_birth',
              'guardian_contacts',
            ];
      const rejected = Object.keys(p_patch || {}).find((key) => !allowed.includes(key));
      if (rejected) {
        return { data: null, error: { message: `field ${rejected} is not editable` } };
      }
      const patch = { ...(p_patch || {}) };
      const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);
      // Mirror admin_update_player: changing division invalidates the team
      // unless the patch names a replacement, and a team must belong to the
      // player's effective division.
      if (
        has('division_id') &&
        !has('team_id') &&
        String(patch.division_id ?? '') !== String(player.division_id ?? '')
      ) {
        patch.team_id = null;
      }
      if (patch.team_id) {
        const effectiveDivision = has('division_id') ? patch.division_id : player.division_id;
        const team = (db.teams || []).find((t) => String(t.id) === String(patch.team_id));
        if (!team || String(team.division_id ?? '') !== String(effectiveDivision ?? '')) {
          return {
            data: null,
            error: { message: "team does not belong to the player's division" },
          };
        }
      }
      Object.assign(player, patch, { updated_at: new Date().toISOString() });
      // Mirror apply_player_patch: team_players is the relational roster
      // source of truth, kept in sync with the denormalized team_id.
      if (has('team_id')) {
        db.team_players = (db.team_players || []).filter(
          (row) => String(row.player_id) !== String(p_player_id)
        );
        if (patch.team_id) {
          db.team_players.push({
            team_id: patch.team_id,
            player_id: player.id,
            organization_id: player.organization_id,
            role: 'player',
            source: 'manual',
          });
        }
      }
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: player.organization_id,
        action: name === 'admin_update_player' ? 'player.updated' : 'player.compliance_updated',
        metadata: { patch: p_patch, player_id: p_player_id },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: { ...player }, error: null };
    }

    if (name === 'admin_bulk_update_players') {
      const { p_player_ids, p_patch } = params || {};
      const ids = (p_player_ids || []).map(String);
      let count = 0;
      (db.players || []).forEach((player) => {
        if (ids.includes(String(player.id))) {
          Object.assign(player, p_patch, { updated_at: new Date().toISOString() });
          count += 1;
        }
      });
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: 'org-1',
        action: 'player.bulk_updated',
        metadata: { patch: p_patch, player_count: count },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: count, error: null };
    }

    if (name === 'admin_create_player') {
      const { p_organization_id, p_fields } = params || {};
      const now = new Date().toISOString();
      const player = {
        id: mockId(),
        organization_id: p_organization_id,
        first_name: p_fields?.first_name || 'New',
        last_name: p_fields?.last_name || 'Player',
        status: p_fields?.status || 'pending',
        paid: false,
        waiver_received: false,
        medical_form_received: false,
        created_at: now,
        updated_at: now,
        ...p_fields,
      };
      db.players = db.players || [];
      db.players.push(player);
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: p_organization_id,
        action: 'player.created',
        metadata: { fields: p_fields },
        created_at: now,
      });
      saveDB(db);
      return { data: { ...player }, error: null };
    }

    if (name === 'admin_delete_players') {
      const { p_player_ids } = params || {};
      const ids = (p_player_ids || []).map(String);
      const before = (db.players || []).length;
      db.players = (db.players || []).filter((player) => !ids.includes(String(player.id)));
      db.team_players = (db.team_players || []).filter(
        (row) => !ids.includes(String(row.player_id))
      );
      markMockDeleted(db, 'players', ids);
      const count = before - db.players.length;
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: 'org-1',
        action: 'player.deleted',
        metadata: { player_count: count, player_ids: ids },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: count, error: null };
    }

    if (name === 'finalize_import_job') {
      const { p_import_job_id, p_validation_errors } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }

      const validationErrors = Array.isArray(p_validation_errors) ? p_validation_errors : [];
      const now = new Date().toISOString();
      const stagedRows = (db.staging_players || []).filter(
        (row) => String(row.import_job_id) === String(p_import_job_id) && !row.promoted_at
      );

      let insertedPlayers = 0;
      let updatedPlayers = 0;
      db.players = db.players || [];

      // Org division format ('split' default): derived division names are
      // gendered (U8B/U8G) under split, age-only (U8) under coed.
      const orgRow = (db.organizations || []).find(
        (item) => String(item.id) === String(job.organization_id)
      );
      const genderModel = orgRow?.feature_flags?.gender_model === 'coed' ? 'coed' : 'split';
      const waitlistEnabled = orgRow?.feature_flags?.waitlist !== false;
      const seasonRow = (db.season_settings || []).find(
        (item) =>
          String(item.organization_id) === String(job.organization_id) && item.status === 'active'
      );

      const deriveDivision = (payload) => {
        const ageText = String(payload.age_group ?? payload['age group'] ?? payload.age ?? '');
        if (!/^[0-9]+$/.test(ageText)) return null;
        const base = `U${Number(ageText) + 1}`;
        if (genderModel === 'coed') return { name: base, gender_policy: 'coed' };
        const g = String(payload.gender || '')
          .toLowerCase()
          .charAt(0);
        if (g === 'm' || g === 'b') return { name: `${base}B`, gender_policy: 'boys' };
        if (g === 'f' || g === 'g') return { name: `${base}G`, gender_policy: 'girls' };
        return { name: base, gender_policy: 'coed' };
      };

      const truthy = (value) =>
        ['true', 't', 'yes', 'y', '1'].includes(String(value ?? '').toLowerCase());

      stagedRows.forEach((row) => {
        const payload = row.normalized_payload || {};
        const externalId =
          payload.external_registration_id ||
          payload.gotsport_id ||
          payload.registration_id ||
          payload.player_id ||
          null;
        const derived = deriveDivision(payload);
        let division = (db.divisions || []).find(
          (item) =>
            String(item.organization_id) === String(job.organization_id) &&
            [String(payload.division_name || '').toLowerCase(), derived?.name?.toLowerCase()]
              .filter(Boolean)
              .includes(String(item.name).toLowerCase())
        );
        if (!division && derived && seasonRow) {
          division = {
            id: mockId(),
            organization_id: job.organization_id,
            season_settings_id: seasonRow.id,
            name: derived.name,
            gender_policy: derived.gender_policy,
          };
          db.divisions = db.divisions || [];
          db.divisions.push(division);
        }
        const existing =
          externalId &&
          db.players.find(
            (player) =>
              String(player.organization_id) === String(job.organization_id) &&
              String(player.external_registration_id) === String(externalId)
          );
        const willingToCoach = [
          'true',
          't',
          'yes',
          'y',
          '1',
          'maybe',
          'coach',
          'head coach',
          'assistant coach',
          'volunteer',
          'willing',
        ].includes(String(payload.willing_to_coach || '').toLowerCase());
        const yearsText = String(payload.years_played ?? '');
        const guardians = [];
        const g1Name = [payload.guardian_1_first_name, payload.guardian_1_last_name]
          .filter(Boolean)
          .join(' ');
        if (g1Name || payload.guardian_1_email) {
          guardians.push({
            name: g1Name || undefined,
            email: payload.guardian_1_email || undefined,
            alternate_email: payload.guardian_1_alternate_email || undefined,
          });
        }
        const g2Name = [payload.guardian_2_first_name, payload.guardian_2_last_name]
          .filter(Boolean)
          .join(' ');
        if (g2Name || payload.guardian_2_email) {
          guardians.push({
            name: g2Name || undefined,
            email: payload.guardian_2_email || undefined,
            alternate_email: payload.guardian_2_alternate_email || undefined,
          });
        }
        if (guardians.length === 0 && (payload.guardian_name || payload.guardian_email)) {
          guardians.push({
            name: payload.guardian_name || undefined,
            email: payload.guardian_email || undefined,
            phone: payload.guardian_phone || undefined,
          });
        }
        const basePlayer = {
          organization_id: job.organization_id,
          division_id: division?.id || payload.division_id || existing?.division_id || null,
          first_name: payload.first_name,
          last_name: payload.last_name,
          preferred_name: payload.preferred_name || payload.nickname || null,
          external_registration_id: externalId,
          date_of_birth: payload.date_of_birth,
          grade: payload.grade || null,
          gender: payload.gender || null,
          birth_year: payload.date_of_birth
            ? Number.parseInt(String(payload.date_of_birth).slice(0, 4), 10)
            : null,
          skill_tier: ['novice', 'developing', 'advanced'].includes(
            String(payload.skill_tier || '').toLowerCase()
          )
            ? String(payload.skill_tier).toLowerCase()
            : null,
          years_played: /^[0-9]{1,2}$/.test(yearsText) ? Number(yearsText) : null,
          // No Payment Status column -> keep the existing paid flag
          ...(payload.payment_status != null && String(payload.payment_status) !== ''
            ? {
                paid:
                  truthy(payload.payment_status) ||
                  String(payload.payment_status).toLowerCase() === 'paid',
              }
            : existing
              ? {}
              : { paid: false }),
          status: waitlistEnabled && truthy(payload.waitlist) ? 'waitlist' : 'active',
          coach_volunteer: willingToCoach,
          willing_to_coach: willingToCoach,
          buddy_request: payload.buddy_request || null,
          mutual_buddy_code: payload.mutual_buddy_code || payload.buddy_code || null,
          guardian_contacts: guardians,
          custom_attributes: {
            ...(payload.play_up ? { play_up: payload.play_up } : {}),
          },
          import_source: 'gotsport',
          last_imported_at: now,
        };

        if (existing) {
          Object.assign(existing, basePlayer);
          updatedPlayers += 1;
        } else {
          db.players.push({
            id: mockId(),
            created_at: now,
            ...basePlayer,
          });
          insertedPlayers += 1;
        }

        row.promoted_at = now;
        row.promoted_by = 'mock-admin-id';
      });

      const status = validationErrors.length > 0 ? 'completed_with_warnings' : 'completed';
      Object.assign(job, {
        status,
        processed_rows: stagedRows.length,
        progress_percent: 100,
        completed_at: now,
        error_summary: { rowErrors: validationErrors },
        warning_summary: {
          ...(job.warning_summary || {}),
          finalize: {
            staged_rows: stagedRows.length,
            valid_staged_rows: stagedRows.length,
            promoted_rows: stagedRows.length,
            inserted_players: insertedPlayers,
            updated_players: updatedPlayers,
            validation_error_rows: validationErrors.length,
            status,
            total_promoted_rows: (db.staging_players || []).filter(
              (row) => String(row.import_job_id) === String(p_import_job_id) && row.promoted_at
            ).length,
          },
        },
      });

      saveDB(db);
      return { data: job.warning_summary.finalize, error: null };
    }

    if (name === 'materialize_import_buddy_pairs') {
      const { p_import_job_id } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }
      if (job.job_type !== 'registration') {
        return { data: null, error: { message: 'Import job is not registration' } };
      }

      const normalizeKey = (value) =>
        String(value || '')
          .trim()
          .toLowerCase();
      const readPayload = (payload, keys) => {
        for (const key of keys) {
          const value = payload?.[key];
          if (value !== undefined && String(value).trim() !== '') return String(value).trim();
        }
        return '';
      };
      const promotedRows = (db.staging_players || []).filter(
        (row) =>
          String(row.import_job_id) === String(p_import_job_id) &&
          String(row.organization_id) === String(job.organization_id) &&
          row.promoted_at
      );
      const promotedPayloads = promotedRows.map((row) => {
        const payload = row.normalized_payload || {};
        return {
          row,
          externalKey: normalizeKey(
            readPayload(payload, [
              'external_registration_id',
              'gotsport_id',
              'registration_id',
              'player_id',
            ])
          ),
          buddyRequestKey: normalizeKey(
            readPayload(payload, [
              'buddy_request',
              'buddy_id',
              'buddy_external_registration_id',
              'buddy_registration_id',
              'friend_request',
            ])
          ),
          mutualCodeKey: normalizeKey(
            readPayload(payload, ['mutual_buddy_code', 'buddy_code', 'friend_code'])
          ),
        };
      });
      const matchedSources = promotedPayloads
        .map((source) => {
          const player = (db.players || []).find(
            (item) =>
              String(item.organization_id) === String(job.organization_id) &&
              normalizeKey(item.external_registration_id) === source.externalKey
          );
          if (!player || (!source.buddyRequestKey && !source.mutualCodeKey)) return null;
          return {
            ...source,
            playerId: player.id,
            divisionId: player.division_id || null,
          };
        })
        .filter(Boolean);
      const byExternalKey = new Map(matchedSources.map((source) => [source.externalKey, source]));
      const pairKeys = new Map();
      let unmatchedRequestRows = 0;
      let selfRequestRows = 0;
      let nonreciprocalRequestRows = 0;
      let crossDivisionRequestRows = 0;

      matchedSources.forEach((source) => {
        if (!source.buddyRequestKey) return;
        const buddy = byExternalKey.get(source.buddyRequestKey);
        if (!buddy) {
          unmatchedRequestRows += 1;
          return;
        }
        if (String(buddy.playerId) === String(source.playerId)) {
          selfRequestRows += 1;
          return;
        }
        if (buddy.buddyRequestKey !== source.externalKey) {
          nonreciprocalRequestRows += 1;
          return;
        }
        if (String(buddy.divisionId || '') !== String(source.divisionId || '')) {
          crossDivisionRequestRows += 1;
          return;
        }
        const ids = [source.playerId, buddy.playerId].sort();
        pairKeys.set(ids.join(':'), ids);
      });

      const codeGroups = new Map();
      matchedSources.forEach((source) => {
        if (!source.mutualCodeKey) return;
        const group = codeGroups.get(source.mutualCodeKey) || [];
        group.push(source);
        codeGroups.set(source.mutualCodeKey, group);
      });

      let invalidCodeGroups = 0;
      for (const group of codeGroups.values()) {
        const uniqueByPlayer = Array.from(
          new Map(group.map((source) => [String(source.playerId), source])).values()
        );
        const divisions = new Set(uniqueByPlayer.map((source) => String(source.divisionId || '')));
        if (uniqueByPlayer.length !== 2 || divisions.size !== 1) {
          invalidCodeGroups += 1;
          continue;
        }
        const ids = uniqueByPlayer.map((source) => source.playerId).sort();
        pairKeys.set(ids.join(':'), ids);
      }

      db.player_buddies = db.player_buddies || [];
      let insertedRelationships = 0;
      for (const ids of pairKeys.values()) {
        const directional = [
          { player_id: ids[0], buddy_player_id: ids[1] },
          { player_id: ids[1], buddy_player_id: ids[0] },
        ];
        directional.forEach((relationship) => {
          const exists = db.player_buddies.some(
            (item) =>
              String(item.player_id) === String(relationship.player_id) &&
              String(item.buddy_player_id) === String(relationship.buddy_player_id)
          );
          if (!exists) {
            db.player_buddies.push({
              ...relationship,
              organization_id: job.organization_id,
              source_import_job: p_import_job_id,
              is_mutual: true,
              created_at: new Date().toISOString(),
            });
            insertedRelationships += 1;
          }
        });
      }

      const requestedRows = matchedSources.length;
      const missingExternalIdRows = promotedPayloads.filter(
        (source) => (source.buddyRequestKey || source.mutualCodeKey) && !source.externalKey
      ).length;
      const unmatchedPromotedRows = promotedPayloads.filter(
        (source) =>
          source.externalKey &&
          (source.buddyRequestKey || source.mutualCodeKey) &&
          !matchedSources.some((matched) => matched.externalKey === source.externalKey)
      ).length;
      const warningCount =
        missingExternalIdRows +
        unmatchedPromotedRows +
        unmatchedRequestRows +
        selfRequestRows +
        nonreciprocalRequestRows +
        crossDivisionRequestRows +
        invalidCodeGroups;
      const candidateRelationships = pairKeys.size * 2;
      const result = {
        status: warningCount > 0 ? 'completed_with_warnings' : 'completed',
        promoted_rows: promotedPayloads.length,
        requested_rows: requestedRows,
        materialized_pairs: pairKeys.size,
        candidate_relationships: candidateRelationships,
        inserted_relationships: insertedRelationships,
        existing_relationships: candidateRelationships - insertedRelationships,
        missing_external_id_rows: missingExternalIdRows,
        unmatched_promoted_rows: unmatchedPromotedRows,
        unmatched_request_rows: unmatchedRequestRows,
        self_request_rows: selfRequestRows,
        nonreciprocal_request_rows: nonreciprocalRequestRows,
        cross_division_request_rows: crossDivisionRequestRows,
        invalid_code_groups: invalidCodeGroups,
      };

      Object.assign(job, {
        status: warningCount > 0 ? 'completed_with_warnings' : job.status,
        warning_summary: {
          ...(job.warning_summary || {}),
          buddy_pairs: result,
        },
      });
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId('audit-buddy-'),
        organization_id: job.organization_id,
        action: 'import.completed',
        user_id: 'mock-admin-id',
        resource_type: 'import_job',
        resource_id: p_import_job_id,
        metadata: { ...result, stage: 'buddy_pairs' },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: result, error: null };
    }

    if (name === 'finalize_coach_import_job') {
      const { p_import_job_id, p_validation_errors } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }

      const validationErrors = Array.isArray(p_validation_errors) ? p_validation_errors : [];
      const now = new Date().toISOString();
      const stagedRows = (db.staging_import_rows || []).filter(
        (row) =>
          String(row.import_job_id) === String(p_import_job_id) &&
          row.import_type === 'coaches' &&
          !row.applied_at &&
          (!row.validation_errors || row.validation_errors.length === 0)
      );

      db.coaches = db.coaches || [];
      db.import_application_records = db.import_application_records || [];

      let insertedCoaches = 0;
      let updatedCoaches = 0;
      let invalidRows = 0;
      let crossOrgConflictRows = 0;

      stagedRows.forEach((row) => {
        const payload = row.normalized_payload || {};
        const email = String(payload.email || '')
          .trim()
          .toLowerCase();
        const fullName = String(payload.full_name || '').trim();
        const status = String(payload.status || 'active').toLowerCase();

        if (
          !email ||
          !fullName ||
          !['active', 'pending-confirmation', 'inactive'].includes(status)
        ) {
          invalidRows += 1;
          row.validation_errors = [
            {
              message: 'Coach row is missing full_name/email or has an invalid status',
              source_row_number: row.source_row_number,
            },
          ];
          return;
        }

        const existing = db.coaches.find(
          (coach) => String(coach.email || '').toLowerCase() === email
        );
        if (existing && String(existing.organization_id) !== String(job.organization_id)) {
          crossOrgConflictRows += 1;
          row.validation_errors = [
            {
              message: 'Coach email already belongs to another organization',
              source_row_number: row.source_row_number,
            },
          ];
          return;
        }

        if (existing) {
          const previous = { ...existing };
          const canCoachMultipleTeams =
            payload.can_coach_multiple_teams === undefined
              ? Boolean(existing.can_coach_multiple_teams)
              : ['true', 'yes', '1', 'y'].includes(
                  String(payload.can_coach_multiple_teams || '').toLowerCase()
                );
          Object.assign(existing, {
            full_name: fullName,
            email,
            phone: payload.phone || payload.contact_phone || null,
            status,
            can_coach_multiple_teams: canCoachMultipleTeams,
            contact_info: {
              email,
              phone: payload.phone || payload.contact_phone || null,
            },
            import_source: 'coach_csv',
            last_imported_at: now,
            custom_attributes: payload,
            updated_at: now,
          });
          db.import_application_records.push({
            id: mockId(),
            organization_id: job.organization_id,
            import_job_id: p_import_job_id,
            import_type: 'coaches',
            target_table: 'coaches',
            target_id: existing.id,
            operation: 'updated',
            previous_payload: previous,
            applied_payload: { ...existing },
            applied_at: now,
            applied_by: 'mock-admin-id',
            rolled_back_at: null,
          });
          updatedCoaches += 1;
        } else {
          const coach = {
            id: mockId(),
            organization_id: job.organization_id,
            full_name: fullName,
            email,
            phone: payload.phone || payload.contact_phone || null,
            status,
            can_coach_multiple_teams: ['true', 'yes', '1', 'y'].includes(
              String(payload.can_coach_multiple_teams || '').toLowerCase()
            ),
            contact_info: {
              email,
              phone: payload.phone || payload.contact_phone || null,
            },
            import_source: 'coach_csv',
            last_imported_at: now,
            custom_attributes: payload,
            created_at: now,
            updated_at: now,
          };
          db.coaches.push(coach);
          db.import_application_records.push({
            id: mockId(),
            organization_id: job.organization_id,
            import_job_id: p_import_job_id,
            import_type: 'coaches',
            target_table: 'coaches',
            target_id: coach.id,
            operation: 'inserted',
            previous_payload: null,
            applied_payload: { ...coach },
            applied_at: now,
            applied_by: 'mock-admin-id',
            rolled_back_at: null,
          });
          insertedCoaches += 1;
        }

        row.applied_at = now;
        row.applied_by = 'mock-admin-id';
      });

      const status =
        validationErrors.length > 0 || invalidRows > 0 || crossOrgConflictRows > 0
          ? 'completed_with_warnings'
          : 'completed';
      const result = {
        status,
        staged_rows: (db.staging_import_rows || []).filter(
          (row) =>
            String(row.import_job_id) === String(p_import_job_id) && row.import_type === 'coaches'
        ).length,
        inserted_coaches: insertedCoaches,
        updated_coaches: updatedCoaches,
        invalid_rows: invalidRows,
        cross_org_conflict_rows: crossOrgConflictRows,
        blocked_assignment_rows: 0,
        validation_error_rows: validationErrors.length,
        total_applied_rows: (db.import_application_records || []).filter(
          (record) =>
            String(record.import_job_id) === String(p_import_job_id) &&
            record.import_type === 'coaches'
        ).length,
      };

      Object.assign(job, {
        status,
        processed_rows: result.total_applied_rows,
        progress_percent: 100,
        completed_at: now,
        error_summary: { rowErrors: validationErrors },
        warning_summary: {
          ...(job.warning_summary || {}),
          coach_finalize: result,
        },
      });

      saveDB(db);
      return { data: result, error: null };
    }

    if (name === 'rollback_coach_import_job') {
      const { p_import_job_id } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }

      const now = new Date().toISOString();
      const records = (db.import_application_records || []).filter(
        (record) =>
          String(record.import_job_id) === String(p_import_job_id) &&
          record.import_type === 'coaches' &&
          !record.rolled_back_at
      );
      if (records.length === 0) {
        return {
          data: null,
          error: { message: 'Import job has no coach application records to roll back' },
        };
      }

      let deletedCoaches = 0;
      let restoredCoaches = 0;

      records
        .slice()
        .reverse()
        .forEach((record) => {
          if (record.operation === 'inserted') {
            db.coaches = (db.coaches || []).filter(
              (coach) => String(coach.id) !== String(record.target_id)
            );
            deletedCoaches += 1;
          } else if (record.operation === 'updated') {
            const coach = (db.coaches || []).find(
              (item) => String(item.id) === String(record.target_id)
            );
            if (coach && record.previous_payload) {
              Object.assign(coach, record.previous_payload, { updated_at: now });
              restoredCoaches += 1;
            }
          }
          record.rolled_back_at = now;
          record.rolled_back_by = 'mock-admin-id';
        });

      const result = {
        status: 'rolled_back',
        deleted_coaches: deletedCoaches,
        restored_coaches: restoredCoaches,
        blocked_assigned_coaches: 0,
      };
      Object.assign(job, {
        status: 'needs_fix',
        warning_summary: {
          ...(job.warning_summary || {}),
          coach_rollback: result,
        },
      });

      saveDB(db);
      return { data: result, error: null };
    }

    if (name === 'finalize_field_import_job') {
      const { p_import_job_id, p_validation_errors } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }

      const validationErrors = Array.isArray(p_validation_errors) ? p_validation_errors : [];
      const now = new Date().toISOString();
      const stagedRows = (db.staging_import_rows || []).filter(
        (row) =>
          String(row.import_job_id) === String(p_import_job_id) &&
          row.import_type === 'fields' &&
          !row.applied_at &&
          (!row.validation_errors || row.validation_errors.length === 0)
      );

      db.locations = db.locations || [];
      db.fields = db.fields || [];
      db.field_subunits = db.field_subunits || [];
      db.practice_slots = db.practice_slots || [];
      db.game_slots = db.game_slots || [];
      db.import_application_records = db.import_application_records || [];

      let insertedLocations = 0;
      let insertedFields = 0;
      let insertedSubunits = 0;
      let insertedPracticeSlots = 0;
      let insertedGameSlots = 0;
      let invalidRows = 0;

      const makeId = () => mockId();
      const boolFromText = (value, fallback = false) => {
        if (value === undefined || value === null || value === '') return fallback;
        return ['true', 't', 'yes', 'y', '1'].includes(String(value).trim().toLowerCase());
      };
      const ledger = (targetTable, target, operation, previousPayload = null) => {
        if (
          db.import_application_records.some(
            (record) =>
              String(record.import_job_id) === String(p_import_job_id) &&
              record.target_table === targetTable &&
              String(record.target_id) === String(target.id)
          )
        ) {
          return;
        }
        db.import_application_records.push({
          id: makeId(),
          organization_id: job.organization_id,
          import_job_id: p_import_job_id,
          import_type: 'fields',
          target_table: targetTable,
          target_id: target.id,
          operation,
          previous_payload: previousPayload,
          applied_payload: { ...target },
          applied_at: now,
          applied_by: 'mock-admin-id',
          rolled_back_at: null,
        });
      };

      stagedRows.forEach((row) => {
        const payload = row.normalized_payload || {};
        const locationName = String(payload.location || payload.location_name || '').trim();
        const fieldName = String(payload.name || payload.field || payload.field_name || '').trim();
        const slotType = String(payload.type || payload.slot_type || '').toLowerCase();
        const start = String(payload.start || payload.start_time || '').trim();
        const end = String(payload.end || payload.end_time || '').trim();
        const day = String(payload.day || payload.day_of_week || '')
          .trim()
          .toLowerCase();
        const validFrom = payload.valid_from || payload.start_date || '';
        const validUntil = payload.valid_until || payload.end_date || '';
        const slotDate = payload.slot_date || payload.date || validFrom || '';

        if (
          !locationName ||
          !fieldName ||
          !['practice', 'game'].includes(slotType) ||
          !start ||
          !end ||
          (slotType === 'practice' && (!day || !validFrom || !validUntil)) ||
          (slotType === 'game' && !slotDate)
        ) {
          invalidRows += 1;
          row.validation_errors = [
            {
              message: 'Field row is missing required location/field/slot data or slot window',
              source_row_number: row.source_row_number,
            },
          ];
          return;
        }

        let location = db.locations.find(
          (item) =>
            String(item.organization_id) === String(job.organization_id) &&
            String(item.name || '').toLowerCase() === locationName.toLowerCase()
        );
        if (!location) {
          location = {
            id: makeId(),
            organization_id: job.organization_id,
            name: locationName,
            address: payload.address || null,
            lighting_available: boolFromText(payload.lighting_available, false),
            created_at: now,
            updated_at: now,
          };
          db.locations.push(location);
          ledger('locations', location, 'inserted');
          insertedLocations += 1;
        }

        let field = db.fields.find(
          (item) =>
            String(item.organization_id) === String(job.organization_id) &&
            String(item.location_id) === String(location.id) &&
            String(item.name || '').toLowerCase() === fieldName.toLowerCase()
        );
        if (!field) {
          field = {
            id: makeId(),
            organization_id: job.organization_id,
            location_id: location.id,
            name: fieldName,
            surface_type: payload.surface_type || payload.surface || null,
            size: payload.size || null,
            supports_halves:
              Boolean(payload.subunit) || boolFromText(payload.supports_halves, false),
            max_age: payload.max_age || null,
            priority_rating: Number.parseInt(String(payload.priority_rating || '1'), 10) || 1,
            active: boolFromText(payload.active, true),
            created_at: now,
            updated_at: now,
          };
          db.fields.push(field);
          ledger('fields', field, 'inserted');
          insertedFields += 1;
        }

        let subunit = null;
        if (payload.subunit) {
          subunit = db.field_subunits.find(
            (item) =>
              String(item.field_id) === String(field.id) &&
              String(item.label || '').toLowerCase() === String(payload.subunit).toLowerCase()
          );
          if (!subunit) {
            subunit = {
              id: makeId(),
              organization_id: job.organization_id,
              field_id: field.id,
              label: String(payload.subunit),
              created_at: now,
              updated_at: now,
            };
            db.field_subunits.push(subunit);
            ledger('field_subunits', subunit, 'inserted');
            insertedSubunits += 1;
          }
        }

        if (slotType === 'practice') {
          const slot = {
            id: makeId(),
            organization_id: job.organization_id,
            field_id: field.id,
            field_subunit_id: subunit?.id || null,
            day_of_week: day.slice(0, 3),
            start_time: start,
            end_time: end,
            capacity: Number.parseInt(String(payload.capacity || '1'), 10) || 1,
            valid_from: validFrom,
            valid_until: validUntil,
            label: payload.label || null,
            created_at: now,
            updated_at: now,
          };
          db.practice_slots.push(slot);
          ledger('practice_slots', slot, 'inserted');
          insertedPracticeSlots += 1;
        } else {
          const slot = {
            id: makeId(),
            organization_id: job.organization_id,
            field_id: field.id,
            division_id: payload.division_id || null,
            slot_date: slotDate,
            start_time: start,
            end_time: end,
            week_index: Number.parseInt(String(payload.week_index || '1'), 10) || 1,
            capacity: Number.parseInt(String(payload.capacity || '1'), 10) || 1,
            created_at: now,
            updated_at: now,
          };
          db.game_slots.push(slot);
          ledger('game_slots', slot, 'inserted');
          insertedGameSlots += 1;
        }

        row.applied_at = now;
        row.applied_by = 'mock-admin-id';
      });

      const status =
        validationErrors.length > 0 || invalidRows > 0 ? 'completed_with_warnings' : 'completed';
      const result = {
        status,
        staged_rows: (db.staging_import_rows || []).filter(
          (row) =>
            String(row.import_job_id) === String(p_import_job_id) && row.import_type === 'fields'
        ).length,
        inserted_locations: insertedLocations,
        updated_locations: 0,
        inserted_fields: insertedFields,
        updated_fields: 0,
        inserted_field_subunits: insertedSubunits,
        inserted_practice_slots: insertedPracticeSlots,
        updated_practice_slots: 0,
        inserted_game_slots: insertedGameSlots,
        updated_game_slots: 0,
        invalid_rows: invalidRows,
        validation_error_rows: validationErrors.length,
        total_applied_rows: (db.import_application_records || []).filter(
          (record) =>
            String(record.import_job_id) === String(p_import_job_id) &&
            record.import_type === 'fields'
        ).length,
      };

      Object.assign(job, {
        status,
        processed_rows: result.total_applied_rows,
        progress_percent: 100,
        completed_at: now,
        error_summary: { rowErrors: validationErrors },
        warning_summary: {
          ...(job.warning_summary || {}),
          field_finalize: result,
        },
      });

      saveDB(db);
      return { data: result, error: null };
    }

    if (name === 'finalize_field_availability_import_job') {
      const { p_import_job_id, p_validation_errors } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) return { data: null, error: { message: 'Import job not found' } };
      const now = new Date().toISOString();
      const stagedRows = (db.staging_import_rows || []).filter(
        (row) =>
          String(row.import_job_id) === String(p_import_job_id) &&
          row.import_type === 'field_availability' &&
          !row.applied_at
      );
      db.field_availability_profiles = db.field_availability_profiles || [];
      db.field_availability_profile_formats = db.field_availability_profile_formats || [];
      db.field_blackout_windows = db.field_blackout_windows || [];
      db.field_equipment_requirements = db.field_equipment_requirements || [];
      db.field_availability_scenarios = db.field_availability_scenarios || [];
      db.field_availability_scenario_members = db.field_availability_scenario_members || [];
      db.import_application_records = db.import_application_records || [];

      const parseMonthWindows = (text) => {
        const t = String(text || '').toLowerCase();
        const out = [];
        if (/\baug(ust)?\b/.test(t)) out.push(['2026-08-01', '2026-08-31']);
        if (/\bsep(t|tember)?\b/.test(t)) out.push(['2026-09-01', '2026-09-30']);
        if (/\boct(ober)?\b/.test(t)) out.push(['2026-10-01', '2026-10-31']);
        if (/\bnov(ember)?\b/.test(t)) out.push(['2026-11-01', '2026-11-30']);
        return out;
      };
      const norm = (v) =>
        String(v || '')
          .trim()
          .toLowerCase()
          .replace(/[-\s]+/g, '_');
      const normApproval = (v, record) => {
        const n = norm(v);
        if (['approved', 'pending', 'not_approved', 'not_applicable'].includes(n)) return n;
        if (['notapproved'].includes(n)) return 'not_approved';
        if (['potential', 'conditional'].includes(norm(record))) return 'pending';
        return 'approved';
      };
      const normRecord = (v) => {
        const n = norm(v);
        return ['active', 'inactive', 'potential', 'conditional', 'excluded'].includes(n)
          ? n
          : 'active';
      };
      const normReq = (v) => {
        const n = norm(v);
        if (
          [
            'required',
            'recommended',
            'blocked',
            'not_approved',
            'needs_purchase',
            'available',
          ].includes(n)
        )
          return n;
        if (['needs_purchase', 'needssturdygoals', 'needs_sturdy_goals'].includes(n))
          return 'needs_purchase';
        if (['needed'].includes(n)) return 'required';
        return n || null;
      };

      let inserted = 0;
      let invalid = 0;
      let formats = 0;
      let blackouts = 0;
      let reqs = 0;
      let members = 0;
      stagedRows.forEach((row) => {
        const payload = row.normalized_payload || {};
        const location = payload.location;
        const fieldName = payload.field_name || payload.name;
        const af = payload.available_from;
        const au = payload.available_until;
        const t1 = af ? Date.parse(af) : NaN;
        const t2 = au ? Date.parse(au) : NaN;
        const tph = payload.teams_per_hour ? parseInt(payload.teams_per_hour, 10) : null;
        const atph = payload.aggregate_teams_per_hour
          ? parseInt(payload.aggregate_teams_per_hour, 10)
          : null;
        if (
          !location ||
          !fieldName ||
          !af ||
          !au ||
          Number.isNaN(t1) ||
          Number.isNaN(t2) ||
          t2 < t1 ||
          (tph !== null && tph < 1) ||
          (atph !== null && atph < 1)
        ) {
          invalid += 1;
          row.validation_errors = [
            {
              message:
                'Availability row missing required location/field/date range or has invalid capacities',
              source_row_number: row.source_row_number,
            },
          ];
          return;
        }
        const profile = {
          id: mockId(),
          organization_id: job.organization_id,
          season_label: payload.season_label || 'Unspecified Season',
          field_id: null,
          location,
          field_name: fieldName,
          surface_type: payload.surface_type || null,
          record_status: normRecord(payload.record_status),
          approval_status: normApproval(payload.approval_status, payload.record_status),
          available_from: af,
          available_until: au,
          availability_rule: payload.availability_rule || null,
          teams_per_hour: tph,
          aggregate_teams_per_hour: atph,
          capacity_basis: payload.capacity_basis || null,
          lighted: payload.lighted || null,
          restroom_potty: payload.restroom_potty || null,
          goal_status: payload.goal_status || null,
          use_context: payload.use_context || null,
          day_constraints: payload.day_constraints || null,
          move_to_location: payload.move_to_location || null,
          current_app_import_status: payload.current_app_import_status || null,
          notes: payload.notes || null,
          created_at: now,
          updated_at: now,
        };
        db.field_availability_profiles.push(profile);
        if (payload.primary_format) {
          db.field_availability_profile_formats.push({
            id: mockId(),
            organization_id: job.organization_id,
            profile_id: profile.id,
            format_code: payload.primary_format,
            format_quantity: parseInt(payload.format_quantity || '1', 10),
            format_order: 1,
          });
          formats += 1;
        }
        if (payload.secondary_format) {
          db.field_availability_profile_formats.push({
            id: mockId(),
            organization_id: job.organization_id,
            profile_id: profile.id,
            format_code: payload.secondary_format,
            format_quantity: parseInt(payload.format_quantity || '1', 10),
            format_order: 2,
          });
          formats += 1;
        }
        parseMonthWindows(payload.blackout_months).forEach(([from, to]) => {
          db.field_blackout_windows.push({
            id: mockId(),
            organization_id: job.organization_id,
            profile_id: profile.id,
            blackout_from: from,
            blackout_until: to,
            reason: String(payload.blackout_months),
          });
          blackouts += 1;
        });
        if (payload.goal_equipment || payload.goal_status) {
          db.field_equipment_requirements.push({
            id: mockId(),
            organization_id: job.organization_id,
            profile_id: profile.id,
            goal_equipment: payload.goal_equipment || null,
            requirement_status: normReq(payload.goal_status),
            notes: null,
          });
          reqs += 1;
        }
        if (payload.scenario_name) {
          let scenario = db.field_availability_scenarios.find(
            (s) =>
              String(s.organization_id) === String(job.organization_id) &&
              s.season_label === (payload.season_label || 'Unspecified Season') &&
              s.name === payload.scenario_name
          );
          if (!scenario) {
            scenario = {
              id: mockId(),
              organization_id: job.organization_id,
              season_label: payload.season_label || 'Unspecified Season',
              name: payload.scenario_name,
              exclusivity_group: payload.scenario_group || null,
              is_active: false,
              created_at: now,
            };
            db.field_availability_scenarios.push(scenario);
          }
          db.field_availability_scenario_members.push({
            id: mockId(),
            organization_id: job.organization_id,
            scenario_id: scenario.id,
            profile_id: profile.id,
            membership_status: 'included',
            created_at: now,
          });
          members += 1;
        }
        db.import_application_records.push({
          id: mockId(),
          organization_id: job.organization_id,
          import_job_id: p_import_job_id,
          import_type: 'field_availability',
          target_table: 'field_availability_profiles',
          target_id: profile.id,
          operation: 'inserted',
          previous_payload: null,
          applied_payload: { ...profile },
          applied_at: now,
          applied_by: 'mock-admin-id',
          rolled_back_at: null,
        });
        row.applied_at = now;
        row.applied_by = 'mock-admin-id';
        inserted += 1;
      });
      const status =
        (Array.isArray(p_validation_errors) && p_validation_errors.length) || invalid > 0
          ? 'completed_with_warnings'
          : 'completed';
      Object.assign(job, {
        status,
        completed_at: now,
        progress_percent: 100,
        processed_rows: inserted,
      });
      saveDB(db);
      return {
        data: {
          status,
          inserted_profiles: inserted,
          inserted_formats: formats,
          inserted_blackouts: blackouts,
          inserted_requirements: reqs,
          inserted_scenario_members: members,
          invalid_rows: invalid,
        },
        error: null,
      };
    }

    if (name === 'rollback_field_availability_import_job') {
      const { p_import_job_id } = params || {};
      const now = new Date().toISOString();
      const records = (db.import_application_records || []).filter(
        (r) =>
          String(r.import_job_id) === String(p_import_job_id) &&
          r.import_type === 'field_availability' &&
          !r.rolled_back_at
      );
      records.forEach((record) => {
        db.field_availability_profiles = (db.field_availability_profiles || []).filter(
          (p) => String(p.id) !== String(record.target_id)
        );
        db.field_availability_profile_formats = (
          db.field_availability_profile_formats || []
        ).filter((f) => String(f.profile_id) !== String(record.target_id));
        db.field_blackout_windows = (db.field_blackout_windows || []).filter(
          (b) => String(b.profile_id) !== String(record.target_id)
        );
        db.field_equipment_requirements = (db.field_equipment_requirements || []).filter(
          (e) => String(e.profile_id) !== String(record.target_id)
        );
        db.field_availability_scenario_members = (
          db.field_availability_scenario_members || []
        ).filter((m) => String(m.profile_id) !== String(record.target_id));
        record.rolled_back_at = now;
      });
      saveDB(db);
      return { data: { status: 'rolled_back', deleted_profiles: records.length }, error: null };
    }

    if (name === 'rollback_field_import_job') {
      const { p_import_job_id } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }

      const now = new Date().toISOString();
      const records = (db.import_application_records || []).filter(
        (record) =>
          String(record.import_job_id) === String(p_import_job_id) &&
          record.import_type === 'fields' &&
          !record.rolled_back_at
      );
      if (records.length === 0) {
        return {
          data: null,
          error: { message: 'Import job has no field application records to roll back' },
        };
      }

      let deletedLocations = 0;
      let deletedFields = 0;
      let deletedSubunits = 0;
      let deletedPracticeSlots = 0;
      let deletedGameSlots = 0;
      const order = {
        game_slots: 1,
        practice_slots: 2,
        field_subunits: 3,
        fields: 4,
        locations: 5,
      };

      records
        .slice()
        .sort((a, b) => (order[a.target_table] || 99) - (order[b.target_table] || 99))
        .forEach((record) => {
          if (record.operation === 'inserted') {
            if (record.target_table === 'game_slots') {
              db.game_slots = (db.game_slots || []).filter(
                (item) => String(item.id) !== String(record.target_id)
              );
              deletedGameSlots += 1;
            } else if (record.target_table === 'practice_slots') {
              db.practice_slots = (db.practice_slots || []).filter(
                (item) => String(item.id) !== String(record.target_id)
              );
              deletedPracticeSlots += 1;
            } else if (record.target_table === 'field_subunits') {
              db.field_subunits = (db.field_subunits || []).filter(
                (item) => String(item.id) !== String(record.target_id)
              );
              deletedSubunits += 1;
            } else if (record.target_table === 'fields') {
              db.fields = (db.fields || []).filter(
                (item) => String(item.id) !== String(record.target_id)
              );
              deletedFields += 1;
            } else if (record.target_table === 'locations') {
              db.locations = (db.locations || []).filter(
                (item) => String(item.id) !== String(record.target_id)
              );
              deletedLocations += 1;
            }
          }
          record.rolled_back_at = now;
          record.rolled_back_by = 'mock-admin-id';
        });

      const result = {
        status: 'rolled_back',
        deleted_locations: deletedLocations,
        deleted_fields: deletedFields,
        deleted_field_subunits: deletedSubunits,
        deleted_practice_slots: deletedPracticeSlots,
        deleted_game_slots: deletedGameSlots,
        restored_records: 0,
        blocked_records: 0,
      };
      Object.assign(job, {
        status: 'needs_fix',
        warning_summary: {
          ...(job.warning_summary || {}),
          field_rollback: result,
        },
      });

      saveDB(db);
      return { data: result, error: null };
    }

    if (name === 'set_import_job_coach_lead_summary') {
      const { p_import_job_id, p_summary, p_status } = params || {};
      const job = (db.import_jobs || []).find(
        (item) => String(item.id) === String(p_import_job_id)
      );
      if (!job) {
        return { data: null, error: { message: 'Import job not found' } };
      }

      job.warning_summary = {
        ...(job.warning_summary || {}),
        coach_leads: p_summary || {},
      };
      if (p_status) job.status = p_status;
      saveDB(db);
      return { data: true, error: null };
    }

    if (name === 'upsert_coach_leads') {
      const leads = Array.isArray(params?.p_leads) ? params.p_leads : null;
      if (!leads) {
        return { data: null, error: { message: 'p_leads must be an array' } };
      }

      const normalizeEmail = (email) =>
        String(email || '')
          .trim()
          .toLowerCase();
      const validLeads = leads
        .map((lead) => ({
          email: normalizeEmail(lead.email),
          full_name: String(lead.full_name || '').trim(),
          organization_id: lead.organization_id,
          division_id: lead.division_id || null,
          player_id: lead.player_id || null,
        }))
        .filter((lead) => lead.email && lead.full_name && lead.organization_id);

      db.coaches = db.coaches || [];
      db.coach_interested_programs = db.coach_interested_programs || [];

      for (const lead of validLeads) {
        if (
          lead.division_id &&
          !(db.divisions || []).some(
            (division) =>
              String(division.id) === String(lead.division_id) &&
              String(division.organization_id) === String(lead.organization_id)
          )
        ) {
          return {
            data: null,
            error: { message: 'Coach lead references a division outside its organization' },
          };
        }

        if (
          lead.player_id &&
          !(db.players || []).some(
            (player) =>
              String(player.id) === String(lead.player_id) &&
              String(player.organization_id) === String(lead.organization_id)
          )
        ) {
          return {
            data: null,
            error: { message: 'Coach lead references a player outside its organization' },
          };
        }
      }

      let leadsCreated = 0;
      let programsLinked = 0;
      const coachCandidateEmails = new Set();

      validLeads.forEach((lead) => {
        if (coachCandidateEmails.has(lead.email)) return;
        coachCandidateEmails.add(lead.email);

        const existingGlobalCoach = db.coaches.find(
          (coach) => normalizeEmail(coach.email) === lead.email
        );
        if (!existingGlobalCoach) {
          db.coaches.push({
            id: mockId(),
            organization_id: lead.organization_id,
            full_name: lead.full_name,
            email: lead.email,
            status: 'interested',
            import_source: 'player_import_lead',
            last_imported_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          });
          leadsCreated += 1;
        } else if (String(existingGlobalCoach.organization_id) === String(lead.organization_id)) {
          existingGlobalCoach.last_imported_at = new Date().toISOString();
        }
      });

      validLeads.forEach((lead) => {
        const coach = db.coaches.find(
          (item) =>
            normalizeEmail(item.email) === lead.email &&
            String(item.organization_id) === String(lead.organization_id)
        );
        if (!coach || !lead.division_id) return;

        const existingLink = db.coach_interested_programs.find(
          (item) =>
            String(item.coach_id) === String(coach.id) &&
            String(item.division_id) === String(lead.division_id) &&
            String(item.inferred_from_player_id || '') === String(lead.player_id || '')
        );
        if (existingLink) return;

        db.coach_interested_programs.push({
          id: mockId(),
          coach_id: coach.id,
          division_id: lead.division_id,
          inferred_from_player_id: lead.player_id,
          organization_id: lead.organization_id,
          created_at: new Date().toISOString(),
        });
        programsLinked += 1;
      });

      saveDB(db);
      return {
        data: {
          leads_created: leadsCreated,
          programs_linked: programsLinked,
          skipped_existing: validLeads.length - leadsCreated,
        },
        error: null,
      };
    }

    if (name === 'admin_delete_coaches') {
      const { p_coach_ids } = params || {};
      const ids = (p_coach_ids || []).map(String);
      if (ids.length === 0) {
        return { data: null, error: { message: 'p_coach_ids must be a non-empty array' } };
      }

      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const idSet = new Set(ids);
      const targets = (db.coaches || []).filter((coach) => idSet.has(String(coach.id)));
      const orgIds = new Set(targets.map((coach) => String(coach.organization_id)));
      if (orgIds.size !== 1) {
        return {
          data: null,
          error: { message: 'coaches must belong to exactly one organization' },
        };
      }
      const orgId = [...orgIds][0];
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === orgId &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }

      for (const team of db.teams || []) {
        if (idSet.has(String(team.coach_id))) team.coach_id = null;
        if (Array.isArray(team.assistant_coach_ids)) {
          team.assistant_coach_ids = team.assistant_coach_ids.filter(
            (coachId) => !idSet.has(String(coachId))
          );
        }
      }
      const droppedInterests = (db.coach_interested_programs || []).filter((row) =>
        idSet.has(String(row.coach_id))
      );
      db.coach_interested_programs = (db.coach_interested_programs || []).filter(
        (row) => !idSet.has(String(row.coach_id))
      );
      const droppedRequests = (db.coach_team_requests || []).filter((row) =>
        idSet.has(String(row.coach_id))
      );
      db.coach_team_requests = (db.coach_team_requests || []).filter(
        (row) => !idSet.has(String(row.coach_id))
      );
      const before = (db.coaches || []).length;
      db.coaches = (db.coaches || []).filter((coach) => !idSet.has(String(coach.id)));
      const count = before - db.coaches.length;
      markMockDeleted(db, 'coaches', ids);
      markMockDeleted(
        db,
        'coach_interested_programs',
        droppedInterests.map((row) => row.id).filter(Boolean)
      );
      markMockDeleted(
        db,
        'coach_team_requests',
        droppedRequests.map((row) => row.id).filter(Boolean)
      );

      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: orgId,
        user_id: session?.user?.id,
        action: 'coach.deleted',
        resource_type: 'coach',
        metadata: { coach_count: count, coach_ids: ids },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: count, error: null };
    }

    if (name === 'admin_update_coach_status') {
      const { p_organization_id, p_coach_id, p_status } = params || {};
      const validStatuses = new Set(['active', 'pending-confirmation', 'inactive', 'interested']);
      if (!validStatuses.has(p_status)) {
        return { data: null, error: { message: `invalid coach status: ${p_status}` } };
      }

      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(p_organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }

      const coach = (db.coaches || []).find(
        (item) =>
          String(item.id) === String(p_coach_id) &&
          String(item.organization_id) === String(p_organization_id)
      );
      if (!coach) {
        return { data: null, error: { message: 'Coach not found in organization' } };
      }

      const assignedTeamCount = (db.teams || []).filter(
        (team) =>
          String(team.organization_id) === String(p_organization_id) &&
          String(team.coach_id) === String(p_coach_id)
      ).length;
      if (['inactive', 'interested'].includes(p_status) && assignedTeamCount > 0) {
        return {
          data: null,
          error: { message: `Cannot set an assigned coach to status ${p_status}` },
        };
      }

      const previousStatus = coach.status;
      coach.status = p_status;
      coach.updated_at = new Date().toISOString();
      db.audit_log = db.audit_log || [];
      if (previousStatus !== p_status) {
        db.audit_log.push({
          id: mockId(),
          organization_id: p_organization_id,
          user_id: session?.user?.id,
          action:
            previousStatus === 'interested' && p_status === 'active'
              ? 'coach.promoted'
              : 'coach.status_updated',
          resource_type: 'coach',
          resource_id: p_coach_id,
          metadata: {
            coach_id: p_coach_id,
            previous_status: previousStatus,
            status: p_status,
            assigned_team_count: assignedTeamCount,
          },
          created_at: new Date().toISOString(),
        });
      }
      saveDB(db);
      return {
        data: {
          coach_id: p_coach_id,
          organization_id: p_organization_id,
          previous_status: previousStatus,
          status: p_status,
          changed: previousStatus !== p_status,
        },
        error: null,
      };
    }

    if (name === 'admin_assign_team_coach') {
      const { p_organization_id, p_team_id, p_coach_id } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(p_organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }

      const team = (db.teams || []).find(
        (item) =>
          String(item.id) === String(p_team_id) &&
          String(item.organization_id) === String(p_organization_id)
      );
      if (!team) {
        return { data: null, error: { message: 'Team not found in organization' } };
      }

      const previousCoachId = team.coach_id || null;
      if (p_coach_id) {
        const coach = (db.coaches || []).find(
          (item) =>
            String(item.id) === String(p_coach_id) &&
            String(item.organization_id) === String(p_organization_id)
        );
        if (!coach) {
          return { data: null, error: { message: 'Coach not found in organization' } };
        }
        if (!['active', 'pending-confirmation'].includes(String(coach.status))) {
          return {
            data: null,
            error: { message: 'Coach must be active or pending-confirmation before assignment' },
          };
        }

        const otherAssignments = (db.teams || []).filter(
          (item) =>
            String(item.organization_id) === String(p_organization_id) &&
            String(item.coach_id) === String(p_coach_id) &&
            String(item.id) !== String(p_team_id)
        );
        if (!coach.can_coach_multiple_teams && otherAssignments.length > 0) {
          return { data: null, error: { message: 'Coach is already assigned to another team' } };
        }
      }

      if (String(previousCoachId || '') === String(p_coach_id || '')) {
        return {
          data: {
            team_id: p_team_id,
            organization_id: p_organization_id,
            previous_coach_id: previousCoachId,
            coach_id: p_coach_id || null,
            changed: false,
          },
          error: null,
        };
      }

      team.coach_id = p_coach_id || null;
      team.updated_at = new Date().toISOString();
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: p_organization_id,
        user_id: session?.user?.id,
        action: p_coach_id
          ? previousCoachId
            ? 'team.coach_swapped'
            : 'team.coach_assigned'
          : 'team.coach_unassigned',
        resource_type: 'team',
        resource_id: p_team_id,
        metadata: {
          team_id: p_team_id,
          previous_coach_id: previousCoachId,
          coach_id: p_coach_id || null,
        },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return {
        data: {
          team_id: p_team_id,
          organization_id: p_organization_id,
          previous_coach_id: previousCoachId,
          coach_id: p_coach_id || null,
          changed: true,
        },
        error: null,
      };
    }

    if (name === 'persist_evaluation_run') {
      return { data: { id: mockId('eval-') }, error: null };
    }

    if (name === 'get_latest_team_runs_per_division') {
      // Org/season scope, then defer to the shared mirror of the SQL DISTINCT ON
      // (newest run per division; empty-results runs skipped; selectedProgramId →
      // first team's division/division_id) so mock and tests share one contract.
      const orgId = params?.p_organization_id;
      const seasonId = params?.p_season_settings_id ?? null;
      const runs = (db.scheduler_runs || []).filter(
        (run) =>
          run.run_type === 'team' &&
          String(run.organization_id) === String(orgId) &&
          (seasonId === null ||
            String(run.season_settings_id) === String(seasonId) ||
            String(run.season_id) === String(seasonId))
      );
      return { data: selectLatestTeamRunsPerDivision(runs), error: null };
    }

    if (name === 'admin_update_registration_form') {
      const { p_form_id, p_patch } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const form = (db.registration_forms || []).find((f) => String(f.id) === String(p_form_id));
      if (!form) return { data: null, error: { message: 'Form not found' } };
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(form.organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }
      const allowed = ['title', 'description', 'status', 'waiver_text', 'fields', 'season_id'];
      for (const key of Object.keys(p_patch || {})) {
        if (!allowed.includes(key)) {
          return { data: null, error: { message: `Disallowed patch key: ${key}` } };
        }
      }
      // Match the real RPC's status whitelist so invalid values fail in mock
      // mode too instead of only in production.
      if ('status' in (p_patch || {}) && !['draft', 'open', 'closed'].includes(p_patch.status)) {
        return { data: null, error: { message: `invalid status: ${p_patch.status}` } };
      }
      Object.assign(form, p_patch, { updated_at: new Date().toISOString() });
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: form.organization_id,
        user_id: session?.user?.id,
        action: 'registration.form_updated',
        resource_type: 'registration_form',
        resource_id: p_form_id,
        metadata: { patch: p_patch },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: { id: form.id }, error: null };
    }

    if (name === 'admin_delete_registration_form') {
      const { p_form_id } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const form = (db.registration_forms || []).find((f) => String(f.id) === String(p_form_id));
      if (!form) return { data: null, error: { message: 'Form not found' } };
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(form.organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }
      const subCount = (db.registrations || []).filter(
        (r) => String(r.form_id) === String(p_form_id)
      ).length;
      db.registrations = (db.registrations || []).filter(
        (r) => String(r.form_id) !== String(p_form_id)
      );
      db.registration_forms = (db.registration_forms || []).filter(
        (f) => String(f.id) !== String(p_form_id)
      );
      markMockDeleted(db, 'registration_forms', [p_form_id]);
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: form.organization_id,
        user_id: session?.user?.id,
        action: 'registration.form_deleted',
        resource_type: 'registration_form',
        resource_id: p_form_id,
        metadata: { submission_count: subCount },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: { deleted_submissions: subCount }, error: null };
    }

    if (name === 'admin_remove_member') {
      const { p_organization_id, p_profile_id } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      if (String(session?.user?.id) === String(p_profile_id)) {
        return { data: null, error: { message: 'Cannot remove yourself' } };
      }
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(p_organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }
      const target = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(p_organization_id) &&
          String(item.profile_id) === String(p_profile_id)
      );
      if (!target) return { data: null, error: { message: 'Member not found' } };
      if (['admin', 'tenant_admin'].includes(target.role)) {
        const adminCount = (db.organization_members || []).filter(
          (item) =>
            String(item.organization_id) === String(p_organization_id) &&
            ['admin', 'tenant_admin'].includes(item.role)
        ).length;
        if (adminCount <= 1) {
          return { data: null, error: { message: 'Cannot remove the last admin' } };
        }
      }
      db.organization_members = (db.organization_members || []).filter(
        (item) =>
          !(
            String(item.organization_id) === String(p_organization_id) &&
            String(item.profile_id) === String(p_profile_id)
          )
      );
      markMockDeleted(db, 'organization_members', [`${p_organization_id}:${p_profile_id}`]);
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: p_organization_id,
        user_id: session?.user?.id,
        action: 'member.removed',
        resource_type: 'organization_member',
        resource_id: p_profile_id,
        metadata: { removed_role: target.role },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: null, error: null };
    }

    if (name === 'admin_change_member_role') {
      const { p_organization_id, p_profile_id, p_role } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(p_organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }
      const target = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(p_organization_id) &&
          String(item.profile_id) === String(p_profile_id)
      );
      if (!target) return { data: null, error: { message: 'Member not found' } };
      if (
        ['admin', 'tenant_admin'].includes(target.role) &&
        !['admin', 'tenant_admin'].includes(p_role)
      ) {
        const adminCount = (db.organization_members || []).filter(
          (item) =>
            String(item.organization_id) === String(p_organization_id) &&
            ['admin', 'tenant_admin'].includes(item.role)
        ).length;
        if (adminCount <= 1) {
          return { data: null, error: { message: 'Cannot demote the last admin' } };
        }
      }
      const previousRole = target.role;
      target.role = p_role;
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: p_organization_id,
        user_id: session?.user?.id,
        action: 'member.role_changed',
        resource_type: 'organization_member',
        resource_id: p_profile_id,
        metadata: { previous_role: previousRole, new_role: p_role },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: null, error: null };
    }

    if (name === 'admin_cancel_game_assignment') {
      const { p_assignment_id } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const assignment = (db.game_assignments || []).find(
        (a) => String(a.id) === String(p_assignment_id)
      );
      if (!assignment) return { data: null, error: { message: 'Game assignment not found' } };
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(assignment.organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied' } };
      }
      db.game_assignments = (db.game_assignments || []).filter(
        (a) => String(a.id) !== String(p_assignment_id)
      );
      markMockDeleted(db, 'game_assignments', [p_assignment_id]);
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: assignment.organization_id,
        user_id: session?.user?.id,
        action: 'game.cancelled',
        resource_type: 'game_assignment',
        resource_id: p_assignment_id,
        metadata: {},
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: null, error: null };
    }

    if (name === 'admin_cancel_practice_assignment') {
      const { p_assignment_id } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const assignment = (db.practice_assignments || []).find(
        (a) => String(a.id) === String(p_assignment_id)
      );
      if (!assignment) return { data: null, error: { message: 'Practice assignment not found' } };
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(assignment.organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied' } };
      }
      db.practice_assignments = (db.practice_assignments || []).filter(
        (a) => String(a.id) !== String(p_assignment_id)
      );
      markMockDeleted(db, 'practice_assignments', [p_assignment_id]);
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: assignment.organization_id,
        user_id: session?.user?.id,
        action: 'practice.cancelled',
        resource_type: 'practice_assignment',
        resource_id: p_assignment_id,
        metadata: {},
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: null, error: null };
    }

    if (name === 'admin_update_team') {
      const { p_team_id, p_patch } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const team = (db.teams || []).find((t) => String(t.id) === String(p_team_id));
      if (!team) return { data: null, error: { message: 'Team not found' } };
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(team.organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }
      const patch = p_patch || {};
      const allowed = ['name', 'notes'];
      for (const key of Object.keys(patch)) {
        if (!allowed.includes(key)) {
          return { data: null, error: { message: `Disallowed patch key: ${key}` } };
        }
      }
      if (Object.keys(patch).length === 0) {
        return { data: null, error: { message: 'p_patch must contain at least one field' } };
      }
      if ('name' in patch) {
        const nextName = String(patch.name || '').trim();
        if (!nextName) {
          return { data: null, error: { message: 'team name must not be empty' } };
        }
        const duplicate = (db.teams || []).some(
          (t) =>
            String(t.division_id) === String(team.division_id) &&
            String(t.id) !== String(p_team_id) &&
            String(t.name) === nextName
        );
        if (duplicate) {
          return {
            data: null,
            error: { message: `a team named "${nextName}" already exists in this division` },
          };
        }
        team.name = nextName;
      }
      if ('notes' in patch) team.notes = patch.notes;
      team.updated_at = new Date().toISOString();
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: team.organization_id,
        user_id: session?.user?.id,
        action: 'team.updated',
        resource_type: 'teams',
        resource_id: p_team_id,
        metadata: { patch },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: { id: p_team_id }, error: null };
    }

    if (name === 'admin_delete_team') {
      const { p_team_id } = params || {};
      const session =
        typeof window !== 'undefined'
          ? JSON.parse(sessionStorage.getItem('__MOCK_SESSION__') || 'null')
          : null;
      const team = (db.teams || []).find((t) => String(t.id) === String(p_team_id));
      if (!team) return { data: null, error: { message: 'Team not found' } };
      const member = (db.organization_members || []).find(
        (item) =>
          String(item.organization_id) === String(team.organization_id) &&
          String(item.profile_id) === String(session?.user?.id)
      );
      if (!['admin', 'tenant_admin'].includes(String(member?.role || ''))) {
        return { data: null, error: { message: 'Access denied: admin role required' } };
      }
      // Cascade: unset team_id on players
      for (const player of db.players || []) {
        if (String(player.team_id) === String(p_team_id)) player.team_id = null;
      }
      // Cascade: remove team_players, game_assignments, practice_assignments
      db.team_players = (db.team_players || []).filter(
        (tp) => String(tp.team_id) !== String(p_team_id)
      );
      db.game_assignments = (db.game_assignments || []).filter(
        (a) =>
          String(a.home_team_id) !== String(p_team_id) &&
          String(a.away_team_id) !== String(p_team_id)
      );
      db.practice_assignments = (db.practice_assignments || []).filter(
        (a) => String(a.team_id) !== String(p_team_id)
      );
      db.teams = (db.teams || []).filter((t) => String(t.id) !== String(p_team_id));
      markMockDeleted(db, 'teams', [p_team_id]);
      db.audit_log = db.audit_log || [];
      db.audit_log.push({
        id: mockId(),
        organization_id: team.organization_id,
        user_id: session?.user?.id,
        action: 'team.deleted',
        resource_type: 'team',
        resource_id: p_team_id,
        metadata: { team_name: team.name },
        created_at: new Date().toISOString(),
      });
      saveDB(db);
      return { data: null, error: null };
    }

    return { data: null, error: null };
  },
  functions: {
    invoke: async (name, options) => {
      if (name === 'import-validation') {
        const body = options?.body || {};
        const aliases = HEADER_ALIASES;
        const requiredFields = {
          players: ['first_name', 'last_name', 'date_of_birth'],
          coaches: ['full_name', 'email'],
          fields: ['location', 'name', 'type', 'start', 'end'],
          field_availability: [
            'season_label',
            'location',
            'name',
            'available_from',
            'available_until',
          ],
        };
        const normalizeHeader = (header) => aliases[String(header).toLowerCase().trim()] || header;
        const sanitize = (value) =>
          value === null || value === undefined
            ? ''
            : String(value).trim().slice(0, 500).replaceAll('<', '').replaceAll('>', '');

        const validatedData = [];
        const stagedRows = [];
        const stagedImportRows = [];
        const validationErrors = [];
        const required = requiredFields[body.import_type] || [];

        (body.rows || []).forEach((rawRow, index) => {
          const row = {};
          Object.entries(rawRow).forEach(([key, value]) => {
            row[normalizeHeader(key)] = sanitize(value);
          });

          required.forEach((field) => {
            if (!row[field]) {
              validationErrors.push({
                row: index + 1,
                field,
                message: `Missing required field: ${field}`,
              });
            }
          });

          if (body.import_type === 'players' && row.date_of_birth) {
            const dob = new Date(row.date_of_birth);
            if (Number.isNaN(dob.getTime())) {
              validationErrors.push({
                row: index + 1,
                field: 'date_of_birth',
                message: `Invalid date format: ${row.date_of_birth}`,
              });
            }
          }

          const hasRowError = validationErrors.some((error) => error.row === index + 1);
          if (!hasRowError) {
            validatedData.push(row);
            if (body.import_type === 'players' && body.import_job_id) {
              stagedRows.push({
                id: mockId(),
                organization_id: body.organization_id,
                import_job_id: body.import_job_id,
                source_row_number: (body.row_offset || 0) + index + 1,
                raw_payload: rawRow,
                normalized_payload: row,
                validation_errors: [],
                created_at: new Date().toISOString(),
              });
            } else if (body.import_type !== 'players' && body.import_job_id) {
              stagedImportRows.push({
                id: mockId(),
                organization_id: body.organization_id,
                import_job_id: body.import_job_id,
                import_type: body.import_type,
                source_row_number: (body.row_offset || 0) + index + 1,
                raw_payload: rawRow,
                normalized_payload: row,
                validation_errors: [],
                created_at: new Date().toISOString(),
              });
            }
          }
        });

        if (stagedRows.length > 0 || stagedImportRows.length > 0) {
          const db = getDB();
          if (stagedRows.length > 0) {
            const rowNumbers = new Set(stagedRows.map((row) => String(row.source_row_number)));
            db.staging_players = (db.staging_players || []).filter(
              (row) =>
                String(row.import_job_id) !== String(body.import_job_id) ||
                !rowNumbers.has(String(row.source_row_number))
            );
            db.staging_players.push(...stagedRows);
          }
          if (stagedImportRows.length > 0) {
            const rowNumbers = new Set(
              stagedImportRows.map((row) => String(row.source_row_number))
            );
            db.staging_import_rows = (db.staging_import_rows || []).filter(
              (row) =>
                String(row.import_job_id) !== String(body.import_job_id) ||
                !rowNumbers.has(String(row.source_row_number))
            );
            db.staging_import_rows.push(...stagedImportRows);
          }
          saveDB(db);
        }

        return {
          data: {
            status: 'success',
            import_type: body.import_type,
            total_rows: body.rows?.length || 0,
            valid_rows: validatedData.length,
            error_rows: validationErrors.length,
            staged_rows: stagedRows.length + stagedImportRows.length,
            validated_data: validatedData,
            validation_errors: validationErrors,
          },
          error: null,
        };
      }
      // Return a plausible empty success for any edge function call
      return { data: null, error: null };
    },
  },
};
