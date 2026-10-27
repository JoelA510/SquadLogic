/**
 * The mock client's twin of the demo (plan docs/changes/2026-10-22-demo-mode.md, D4; the server side
 * is migration 20261030010000). For the mock E2E suite and the Vitest tests only: the production
 * build never includes the mock, and the demo there runs on the real backend.
 *
 * `signInAnonymously` makes an anonymous session; `start_demo_session()` gives the caller a "Demo
 * league" that expires 30 minutes on, holding a SMALL slice of the real seed (two divisions, one of
 * them the practice-only U4 with its four reserved Saturday sessions), enough for the UI tests. The
 * mock re-merges its whole store on every read, so the real league's 1,259 players would make every
 * call slow. The real counts are asserted against the real backend (`real_backend_demo.feature`).
 *
 * `window`-free: the caller passes the pieces it owns. A test or E2E step can shorten the demo by
 * setting `sessionStorage.__MOCK_DEMO_MS__` before it starts, or make the server refuse with its cap
 * (`sessionStorage.__MOCK_DEMO_FAIL__ = 'capacity'`), to put the entry page in its failed state.
 * `sessionStorage.__MOCK_DEMO_PLAYERS__ = '1100'` makes the slice that many players on more teams
 * (named uniquely), for the scenario that needs a league past the server's 1000-row cap.
 */

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
/** The live-demo cap, as in the server's `start_demo_session()`. */
const MOCK_DEMO_CAP = 10;

/** The server's refusal at the cap: P0001, detail `demo_capacity`. */
const capacityError = () => ({
  code: 'P0001',
  message: 'The demo is busy right now. Try again in a few minutes.',
  details: 'demo_capacity',
});

/** The demo league's slice: two divisions, four teams, 16 players, two coaches, one ground. */
const SLICE = {
  divisions: [
    { key: 'U4', name: 'U4', plays_games: false, size: 4 },
    { key: 'U10', name: 'U10 Boys', plays_games: true, size: 4 },
  ],
  teamsPerDivision: 2,
  playersPerTeam: 4,
  firstNames: ['Avery', 'Blake', 'Casey', 'Drew', 'Emery', 'Finley', 'Harper', 'Jordan'],
  lastNames: ['Alder', 'Birch', 'Cedar', 'Dune', 'Elm', 'Fern', 'Grove', 'Heath'],
};

/**
 * An anonymous session, as GoTrue's `signInAnonymously` gives one: a user with no email and
 * `is_anonymous` true.
 * @param {(prefix?: string) => string} mockId
 */
export function makeAnonymousSession(mockId) {
  const id = mockId('mock-anon-');
  return {
    user: {
      id,
      email: null,
      is_anonymous: true,
      user_metadata: {},
      app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
    },
    access_token: 'mock-token',
  };
}

/**
 * Handles `start_demo_session`; returns `null` for any other name.
 *
 * @param {any} db The mock database (mutated).
 * @param {string} name The RPC name.
 * @param {{
 *   session: any,
 *   mockId: (prefix?: string) => string,
 *   now?: number,
 *   lifespanMs?: number,
 *   failure?: string | null,
 *   playerCount?: number,
 * }} ctx
 */
export function handleDemoRpc(
  db,
  name,
  { session, mockId, now = Date.now(), lifespanMs, failure = null, playerCount }
) {
  if (name !== 'start_demo_session') return null;

  const user = session?.user;
  if (!user?.id) {
    return {
      data: null,
      error: { code: '42501', message: 'start_demo_session requires a signed-in caller' },
    };
  }
  if (user.is_anonymous !== true) {
    return {
      data: null,
      error: {
        code: '42501',
        message: 'The demo is for anonymous visitors',
        details: 'demo_requires_anonymous',
      },
    };
  }

  if (failure === 'capacity') return { data: null, error: capacityError() };

  db.organizations = db.organizations || [];
  const live = db.organizations.filter(
    (org) => org.demo_expires_at && Date.parse(org.demo_expires_at) > now
  );
  const mine = live.find((org) => org.demo_owner === user.id);
  if (mine) {
    return {
      data: { organization_id: mine.id, expires_at: mine.demo_expires_at, existing: true },
      error: null,
    };
  }
  if (live.length >= MOCK_DEMO_CAP) return { data: null, error: capacityError() };

  const expiresAt = new Date(now + (lifespanMs || THIRTY_MINUTES_MS)).toISOString();
  const orgId = mockId();
  const seasonId = mockId();
  const created = new Date(now).toISOString();
  const year = new Date(now).getUTCFullYear();

  db.organizations.push({
    id: orgId,
    name: 'Demo league',
    slug: `demo-${orgId.slice(0, 12)}`,
    is_onboarded: true,
    contact_info: { timezone: 'America/Los_Angeles' },
    demo_expires_at: expiresAt,
    demo_owner: user.id,
    created_at: created,
  });

  db.profiles = db.profiles || [];
  if (!db.profiles.some((profile) => profile.id === user.id)) {
    db.profiles.push({ id: user.id, email: null, full_name: null, role: 'user' });
  }
  db.organization_members = db.organization_members || [];
  db.organization_members.push({ organization_id: orgId, profile_id: user.id, role: 'admin' });

  db.season_settings = db.season_settings || [];
  db.season_settings.push({
    id: seasonId,
    organization_id: orgId,
    name: `${year} Season`,
    status: 'active',
    season_year: year,
    season_label: `${year} Season`,
    timezone: 'America/Los_Angeles',
    created_at: created,
  });

  db.divisions = db.divisions || [];
  db.teams = db.teams || [];
  db.players = db.players || [];
  db.coaches = db.coaches || [];
  db.team_coach_assignments = db.team_coach_assignments || [];
  db.locations = db.locations || [];
  db.fields = db.fields || [];
  db.practice_slots = db.practice_slots || [];
  const divisionIds = new Map();
  let playerNumber = 0;
  let teamNumber = 0;
  // A larger league on request: about 18 players a team, every name unique, so a test can find
  // the last player (the one a read cut at 1000 rows never returns).
  const scaled = Number.isInteger(playerCount) && playerCount > 16;
  const teamsPerDivision = scaled
    ? Math.ceil(playerCount / (SLICE.divisions.length * 18))
    : SLICE.teamsPerDivision;
  const playersPerTeam = scaled
    ? Math.ceil(playerCount / (SLICE.divisions.length * teamsPerDivision))
    : SLICE.playersPerTeam;

  SLICE.divisions.forEach((slice) => {
    const divisionId = mockId();
    divisionIds.set(slice.key, divisionId);
    db.divisions.push({
      id: divisionId,
      organization_id: orgId,
      season_settings_id: seasonId,
      name: slice.name,
      plays_games: slice.plays_games,
      min_roster_size: 4,
      max_roster_size: 8,
      target_team_size: 4,
    });
    for (let t = 0; t < teamsPerDivision; t += 1) {
      teamNumber += 1;
      const teamId = mockId();
      const coachId = mockId();
      db.teams.push({
        id: teamId,
        organization_id: orgId,
        division_id: divisionId,
        name: `${slice.key} Team ${teamNumber}`,
        coach_id: coachId,
      });
      db.coaches.push({
        id: coachId,
        organization_id: orgId,
        full_name: `Coach ${SLICE.lastNames[(teamNumber - 1) % SLICE.lastNames.length]}`,
        email: `coach${teamNumber}-${orgId.slice(0, 6)}@example.test`,
        status: 'active',
        import_source: 'demo',
        can_coach_multiple_teams: false,
      });
      db.team_coach_assignments.push({
        id: mockId(),
        organization_id: orgId,
        team_id: teamId,
        coach_id: coachId,
        role: 'lead',
        effective_from: `${year}-01-01`,
        effective_to: null,
        started_via: 'demo',
      });
      for (let p = 0; p < playersPerTeam; p += 1) {
        playerNumber += 1;
        if (scaled && playerNumber > playerCount) break;
        db.players.push({
          id: mockId(),
          organization_id: orgId,
          team_id: teamId,
          division_id: divisionId,
          first_name: scaled
            ? `Player${playerNumber}`
            : SLICE.firstNames[(playerNumber - 1) % SLICE.firstNames.length],
          last_name: scaled
            ? `Demo${playerNumber}`
            : SLICE.lastNames[(playerNumber + 3) % SLICE.lastNames.length],
          gender: playerNumber % 2 === 0 ? 'f' : 'm',
          status: 'active',
          years_played: playerNumber % 3,
          rating: (playerNumber % 5) + 1,
          jersey_number: p + 1,
          willing_to_coach: false,
        });
      }
    }
  });

  // The team run the Teams, Practices and Games pages read their teams from (the server's
  // start_demo_session writes one: without it they treat the league as a cold start).
  const teamsByDivision = {};
  for (const team of db.teams.filter((entry) => entry.organization_id === orgId)) {
    const division = db.divisions.find((entry) => entry.id === team.division_id);
    (teamsByDivision[division.name] ??= []).push({
      id: team.id,
      name: team.name,
      division: division.name,
      divisionId: team.division_id,
      coachId: team.coach_id,
      assistantCoachIds: [],
    });
  }
  db.scheduler_runs = db.scheduler_runs || [];
  db.scheduler_runs.push({
    id: mockId(),
    organization_id: orgId,
    season_id: seasonId,
    season_settings_id: seasonId,
    run_type: 'team',
    status: 'completed',
    parameters: { source: 'demo_seed' },
    metrics: {},
    results: {
      teamsByDivision,
      team_players: db.players
        .filter((player) => player.organization_id === orgId)
        .map((player) => ({ team_id: player.team_id, player_id: player.id })),
    },
    created_by: user.id,
    started_at: created,
    completed_at: created,
    created_at: created,
  });

  const locationId = mockId();
  const fieldId = mockId();
  db.locations.push({ id: locationId, organization_id: orgId, name: 'Orchard Park' });
  db.fields.push({
    id: fieldId,
    organization_id: orgId,
    location_id: locationId,
    name: 'Tot Lot',
    active: true,
    surface_type: 'Grass',
    size: '7v7',
  });
  // U4's four 30-minute Saturday sessions, 15 minutes apart, reserved to it; and one open weekday slot.
  const u4 = divisionIds.get('U4');
  [
    ['09:00', '09:30'],
    ['09:45', '10:15'],
    ['10:30', '11:00'],
    ['11:15', '11:45'],
  ].forEach(([start, end]) => {
    db.practice_slots.push({
      id: mockId(),
      organization_id: orgId,
      field_id: fieldId,
      day_of_week: 'sat',
      start_time: start,
      end_time: end,
      capacity: 1,
      division_id: u4,
    });
  });
  db.practice_slots.push({
    id: mockId(),
    organization_id: orgId,
    field_id: fieldId,
    day_of_week: 'tue',
    start_time: '16:00',
    end_time: '16:45',
    capacity: 1,
    division_id: null,
  });

  return {
    data: { organization_id: orgId, expires_at: expiresAt, existing: false },
    error: null,
  };
}
