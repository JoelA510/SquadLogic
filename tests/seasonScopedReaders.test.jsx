// Readers filter by the season the header shows (Phase E3a; migration 20261108010000; plan
// docs/changes/2026-10-27-season-enrollment.md). A player and a coach row belong to one season,
// so the Players page and Team Builder (usePlayersData), the roster directory, the sidebar
// badges and the setup checklist each read the selected season's people and no other's. The
// fake below answers an equality filter the way PostgREST does, so a reader that leaves its
// season filter off reads both seasons' rows and fails here. A season filter is not an
// authorization boundary (RLS stays organization-scoped): the fake does not model RLS.
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayersData } from '../frontend/src/hooks/usePlayersData.js';
import { useRosterDirectory } from '../frontend/src/hooks/useRosterDirectory.js';
import { useNavBadges } from '../frontend/src/hooks/useNavBadges.js';
import { useSetupProgress } from '../frontend/src/hooks/useSetupProgress.js';

const ORG = 'org-1';
const FALL = 'season-fall';
const SPRING = 'season-spring';

const mocks = vi.hoisted(() => ({
  tables: {},
  requests: [],
  rpc: vi.fn(),
  seasonId: 'season-fall',
  /** Per season: a promise a read of that season waits for (a response that comes late). */
  gates: /** @type {Record<string, Promise<void>>} */ ({}),
}));

vi.mock('../frontend/src/lib/supabaseClient.js', () => {
  // A builder that records its equality filters and resolves to the rows that satisfy them.
  const builder = (table, options) => {
    const filters = [];
    let range = null;
    const run = () => {
      mocks.requests.push({ table, filters: [...filters] });
      const rows = (mocks.tables[table] || []).filter((row) =>
        filters.every(([column, value]) => String(row[column]) === String(value))
      );
      const page = range ? rows.slice(range[0], range[1] + 1) : rows;
      return {
        data: options?.head ? null : page,
        count: options?.count === 'exact' ? rows.length : null,
        error: null,
      };
    };
    const self = {
      eq: (column, value) => (filters.push([column, value]), self),
      in: () => self,
      order: () => self,
      range: (from, to) => ((range = [from, to]), self),
      then: (resolve, reject) => {
        const gate = mocks.gates[filters.find(([column]) => column === 'season_settings_id')?.[1]];
        return Promise.resolve(gate).then(run).then(resolve, reject);
      },
    };
    return self;
  };
  return {
    supabase: {
      from: (table) => ({ select: (_columns, options) => builder(table, options) }),
      rpc: (...args) => mocks.rpc(...args),
    },
  };
});

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: ORG },
    currentSeasonSetting: mocks.seasonId
      ? { id: mocks.seasonId, status: mocks.seasonId === FALL ? 'active' : 'draft' }
      : null,
    seasonSettingsLoading: false,
    featureFlags: {},
  }),
}));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => ({ team: null, practice: null, game: null, error: null }),
}));

const player = (id, season, extra = {}) => ({
  id,
  organization_id: ORG,
  season_settings_id: season,
  first_name: id,
  last_name: 'Player',
  ...extra,
});

beforeEach(() => {
  mocks.seasonId = FALL;
  mocks.gates = {};
  mocks.requests = [];
  mocks.rpc.mockReset();
  mocks.tables = {
    players: [
      player('fall-1', FALL, { rating: 3 }),
      player('fall-2', FALL),
      player('spring-1', SPRING),
      player('spring-2', SPRING),
      player('spring-3', SPRING),
    ],
    coaches: [
      { id: 'fall-c', organization_id: ORG, season_settings_id: FALL, full_name: 'Fall Coach' },
      {
        id: 'spring-c',
        organization_id: ORG,
        season_settings_id: SPRING,
        full_name: 'Spring Coach',
      },
      { id: 'spring-c2', organization_id: ORG, season_settings_id: SPRING, full_name: 'Other' },
    ],
    divisions: [
      { id: 'fall-d', organization_id: ORG, season_settings_id: FALL, name: 'U8' },
      { id: 'spring-d', organization_id: ORG, season_settings_id: SPRING, name: 'U8' },
    ],
    teams: [{ id: 't1', organization_id: ORG }],
    fields: [],
  };
});

describe('usePlayersData (the Players page and Team Builder)', () => {
  it("lists the selected season's players and divisions only", async () => {
    const { result } = renderHook(() => usePlayersData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.players.map((p) => p.id).sort()).toEqual(['fall-1', 'fall-2']);
    expect(result.current.divisions.map((d) => d.id)).toEqual(['fall-d']);
  });

  it('shows the other season when the header is switched to it', async () => {
    const { result, rerender } = renderHook(() => usePlayersData());
    await waitFor(() => expect(result.current.players).toHaveLength(2));
    mocks.seasonId = SPRING;
    rerender();
    await waitFor(() => expect(result.current.players).toHaveLength(3));
    expect(result.current.players.every((p) => p.season_settings_id === SPRING)).toBe(true);
    expect(result.current.divisions.map((d) => d.id)).toEqual(['spring-d']);
  });

  it('never lets a late response for the season left replace the season shown', async () => {
    // Fall's read is held; the header is switched to Spring, whose read answers at once.
    /** @type {() => void} */
    let release = () => {};
    mocks.gates[FALL] = new Promise((resolve) => {
      release = resolve;
    });
    const { result, rerender } = renderHook(() => usePlayersData());
    mocks.seasonId = SPRING;
    rerender();
    await waitFor(() => expect(result.current.players).toHaveLength(3));
    // Fall answers now, after Spring: it must change nothing.
    release();
    await act(async () => {
      await mocks.gates[FALL];
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.players.every((p) => p.season_settings_id === SPRING)).toBe(true);
    expect(result.current.players).toHaveLength(3);
    expect(result.current.divisions.map((d) => d.id)).toEqual(['spring-d']);
    expect(result.current.loading).toBe(false);
  });

  it('serves none of the season left while the season now shown loads', async () => {
    const { result, rerender } = renderHook(() => usePlayersData());
    await waitFor(() => expect(result.current.players).toHaveLength(2));
    /** @type {() => void} */
    let release = () => {};
    mocks.gates[SPRING] = new Promise((resolve) => {
      release = resolve;
    });
    mocks.seasonId = SPRING;
    rerender();
    expect(result.current.players).toEqual([]);
    expect(result.current.loading).toBe(true);
    release();
    await waitFor(() => expect(result.current.players).toHaveLength(3));
  });

  it('has no players to show for an organization with no season', async () => {
    mocks.seasonId = null;
    const { result } = renderHook(() => usePlayersData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.players).toEqual([]);
    expect(mocks.requests).toEqual([]);
  });

  it('adds a player with the call it always had when the active season is shown, and names a season otherwise', async () => {
    mocks.rpc.mockResolvedValue({ data: player('new', FALL), error: null });
    const { result, rerender } = renderHook(() => usePlayersData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.createPlayer({ first_name: 'New' });
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith('admin_create_player', {
      p_organization_id: ORG,
      p_fields: { first_name: 'New' },
    });
    mocks.seasonId = SPRING;
    rerender();
    await waitFor(() => expect(result.current.players).toHaveLength(3));
    await act(async () => {
      await result.current.createPlayer({ first_name: 'Next' });
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith('admin_create_player', {
      p_organization_id: ORG,
      p_fields: { first_name: 'Next' },
      p_season_settings_id: SPRING,
    });
  });
});

describe('useRosterDirectory', () => {
  it("names the selected season's players and coaches only", async () => {
    const { result } = renderHook(() => useRosterDirectory({ enabled: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect([...result.current.players.keys()].sort()).toEqual(['fall-1', 'fall-2']);
    expect([...result.current.coaches.keys()]).toEqual(['fall-c']);
  });
});

describe('useNavBadges', () => {
  it("counts the selected season's players and coaches", async () => {
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.players).toBe(2));
    expect(result.current.coaches).toBe(1);
    expect(result.current.teams).toBe(1);
  });

  it('shows no people badge while no season is shown, and the other season on a switch', async () => {
    mocks.seasonId = SPRING;
    const { result } = renderHook(() => useNavBadges());
    await waitFor(() => expect(result.current.players).toBe(3));
    expect(result.current.coaches).toBe(2);
  });
});

describe('useSetupProgress', () => {
  it("counts the selected season's players for the import step", async () => {
    const { result } = renderHook(() => useSetupProgress());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.steps.find((s) => s.id === 'import').count).toBe('2 players');
  });

  it('reads an empty season as not started', async () => {
    mocks.tables.players = [player('spring-1', SPRING)];
    const { result } = renderHook(() => useSetupProgress());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.steps.find((s) => s.id === 'import').done).toBe(false);
  });
});
