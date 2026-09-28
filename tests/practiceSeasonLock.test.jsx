/**
 * 8.6 PR 3b PR 7 -- the scheduling page's locked set is a SEASON read.
 *
 * Writer v3 (#461) is add-only: rows from every earlier save stay in the
 * season under their own `run_id`. The auto-scheduler Edge Function loads the
 * season's rows and refuses the run when the page's `lockedAssignments`
 * differ. A page that read only the latest run would therefore be refused on
 * every run from the second one on.
 *
 * These cases render the real page against one in-memory season, capture the
 * payload the page sends to the auto-scheduler, and judge it with the Edge's
 * own loader and cross-check (`_shared/engines/practice-lock.ts`) over the SAME
 * rows -- enumerated from that store, never from what the page sent.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createChainMock } from './helpers/index.js';
import { ROLE_PERMISSIONS, ROLES } from '../frontend/src/constants/permissions.js';
import {
  crossCheckLockedAssignments,
  loadSeasonPracticeLock,
} from '../supabase/functions/_shared/engines/practice-lock.js';
import { loadSeasonPracticeAssignments } from '../packages/core/src/practiceSupabase.js';

const state = vi.hoisted(() => ({
  /** @type {any[]} */ rows: [],
  /** @type {any[]} */ triggers: [],
  /** @type {any[]} */ placements: [],
  failSeasonRead: false,
  nextId: 1,
  /** @type {any} */ dashboard: null,
  slotRow: {
    id: 'slot-1',
    day_of_week: 'mon',
    start_time: '18:00',
    end_time: '19:30',
    capacity: 5,
    valid_from: '2026-09-01',
    valid_until: '2026-11-30',
    field_id: 'field-1',
    fields: { id: 'field-1', name: 'Pitch 1', location_id: 'loc-1' },
  },
}));

const ORG = 'org-1';
const SEASON = 'season-1';

/**
 * A PostgREST-shaped query over `state.rows`: `eq` on a column or on an
 * embedded path, `order`, `range`. Rows carry their `teams.divisions` embed.
 */
function seasonTable() {
  const filters = [];
  let window = null;
  const q = {
    select: () => q,
    eq: (col, val) => {
      filters.push([col, val]);
      return q;
    },
    is: () => q,
    order: () => q,
    range: (from, to) => {
      window = [from, to];
      return q;
    },
    then: (resolve, reject) => {
      if (state.failSeasonRead) {
        return Promise.resolve({ data: null, error: { message: 'permission denied' } }).then(
          resolve,
          reject
        );
      }
      const read = (row, col) => col.split('.').reduce((cur, part) => cur?.[part], row);
      const matched = [...state.rows]
        .filter((row) => filters.every(([col, val]) => String(read(row, col)) === String(val)))
        .sort((a, b) => a.id.localeCompare(b.id));
      const data = window ? matched.slice(window[0], window[1] + 1) : matched;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return q;
}

/** @type {any} */
const fakeDb = {
  from: (table) =>
    table === 'practice_assignments' ? seasonTable() : createChainMock({ data: [], error: null }),
};

function dbRow(id, teamId, runId, season = SEASON) {
  return {
    id,
    organization_id: ORG,
    team_id: teamId,
    practice_slot_id: 'slot-1',
    slot_id: 'slot-1',
    effective_date_range: '[2026-09-01,2026-12-01)',
    assigned_via: 'auto',
    source: 'auto',
    run_id: runId,
    teams: { divisions: { season_settings_id: season } },
  };
}

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    from: (table) =>
      table === 'practice_assignments'
        ? seasonTable()
        : createChainMock({ data: table === 'practice_slots' ? [state.slotRow] : [], error: null }),
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getSession: async () => ({ data: { session: { access_token: 't' } }, error: null }),
    },
  },
}));

vi.mock('../frontend/src/hooks/useAutoScheduler.js', async () => {
  const { useState } = await import('react');
  return {
    useAutoScheduler: () => {
      const [s, setS] = useState({ status: 'idle', result: null });
      return {
        ...s,
        progress: null,
        error: null,
        trigger: async (payload) => {
          state.triggers.push(payload);
          setS({
            status: 'completed',
            result: {
              runId: `edge-run-${state.triggers.length}`,
              assignments: state.placements,
              unassigned: [],
            },
          });
        },
        cancel: () => {},
        reset: () => setS({ status: 'idle', result: null }),
      };
    },
  };
});

// A STABLE value per test (built in beforeEach): a fresh object per render
// would re-fire the page's `practice.assignments` effect forever.
vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => state.dashboard,
}));

function dashboardData() {
  return {
    loading: { team: false, practice: false, game: false },
    error: null,
    errors: { team: null, practice: null, game: null },
    roadmap: { sections: [], stats: { completed: 0, pending: 0 } },
    team: {
      teams: ['team-a', 'team-b', 'team-c'].map((id) => ({ id, name: id, division: 'U10' })),
    },
    // The run-scoped reader: ONLY the latest run's rows. The season holds more.
    practice: {
      summary: null,
      snapshot: null,
      generatedAt: null,
      runId: 'run-2',
      assignments: state.rows.filter((r) => r.run_id === 'run-2'),
    },
    game: { summary: null, snapshot: null, warnings: [], generatedAt: null, runId: null },
  };
}

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1', name: 'Smoke FC' },
    currentSeasonSetting: { id: 'season-1', timezone: 'America/New_York' },
    featureFlags: {},
    permissions: ROLE_PERMISSIONS[ROLES.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: null }),
}));
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/lib/pagedFetch.js', () => ({ fetchAllPages: async () => [] }));
vi.mock('../frontend/src/components/PracticeAssignmentList.jsx', () => ({
  default: ({ assignments }) => (
    <ul aria-label="practice rows">
      {assignments.map((a) => (
        <li key={a.id}>{a.id}</li>
      ))}
    </ul>
  ),
}));
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/PracticeOverridePanel.jsx', () => stub('override'));
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => stub('readiness'));
vi.mock('../frontend/src/components/EvaluationPanel.jsx', () => stub('evaluation'));

const { default: PracticeSchedulingPage } =
  await import('../frontend/src/pages/PracticeSchedulingPage.jsx');

/** Every object in a JSON body that looks like a practice_assignments row. */
function rowsIn(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => rowsIn(v, out));
  else if (value && typeof value === 'object') {
    if (value.team_id && value.practice_slot_id && value.effective_date_range) out.push(value);
    else Object.values(value).forEach((v) => rowsIn(v, out));
  }
  return out;
}

async function runScheduler() {
  const button = await screen.findByRole('button', { name: /run auto-scheduler optimization/i });
  await waitFor(() => expect(button).not.toBeDisabled());
  const before = state.triggers.length;
  fireEvent.click(button);
  await waitFor(() => expect(state.triggers.length).toBe(before + 1));
  return state.triggers[state.triggers.length - 1];
}

/** The Edge's verdict on a payload: its own loader, over the same store. */
async function edgeVerdict(payload) {
  const lock = await loadSeasonPracticeLock(fakeDb, {
    organizationId: ORG,
    seasonSettingsId: SEASON,
  });
  expect(lock.ok).toBe(true);
  if (!lock.ok) throw new Error('unreachable');
  return { lock, check: crossCheckLockedAssignments(lock.rows, payload.lockedAssignments) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T16:00:00Z'));
  state.triggers = [];
  state.placements = [];
  state.failSeasonRead = false;
  state.rows = [
    dbRow('r-a', 'team-a', 'run-1'),
    dbRow('r-b', 'team-b', 'run-2'),
    // Another season's row: the season read must leave it out.
    dbRow('r-other', 'team-x', 'run-0', 'season-0'),
  ];
  state.dashboard = dashboardData();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a season with rows from two runs', () => {
  it('sends both runs rows as locked, and the Edge cross-check passes', async () => {
    render(
      <MemoryRouter>
        <PracticeSchedulingPage />
      </MemoryRouter>
    );
    const payload = await runScheduler();
    const { lock, check } = await edgeVerdict(payload);

    // Enumerated from the store, not from the payload.
    const seasonIds = lock.rows.map((r) => r.id).sort();
    expect(seasonIds).toEqual(['r-a', 'r-b']);
    expect(new Set(state.rows.map((r) => r.run_id)).size).toBeGreaterThan(1);
    expect(check).toMatchObject({ ok: true, missingFromClient: [], unknownToServer: [] });
    expect(payload.lockedAssignments.map((r) => r.id).sort()).toEqual(seasonIds);

    // Both runs' rows appear in the page's review, locked and unchanged.
    const list = await screen.findByRole('list', { name: 'practice rows' });
    for (const id of seasonIds) expect(list.textContent).toContain(id);
  });
});

describe('run -> apply -> run again', () => {
  it('re-reads the season after Apply, so the second run is not refused', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      // The writer: add every row the payload carries that the season lacks.
      const body = JSON.parse(String(init?.body ?? '{}'));
      for (const row of rowsIn(body)) {
        const exists = state.rows.some(
          (r) => r.team_id === row.team_id && r.practice_slot_id === row.practice_slot_id
        );
        if (!exists) state.rows.push(dbRow(`r-new-${state.nextId++}`, row.team_id, 'run-3'));
      }
      return new Response(
        JSON.stringify({ status: 'success', runId: 'run-3', teamsWithoutPractice: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    render(
      <MemoryRouter>
        <PracticeSchedulingPage />
      </MemoryRouter>
    );

    state.placements = [{ teamId: 'team-c', slotId: 'slot-1', source: 'auto' }];
    const first = await runScheduler();
    expect((await edgeVerdict(first)).check.ok).toBe(true);

    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    await waitFor(() => expect(apply).not.toBeDisabled());
    fireEvent.click(apply);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    // The save created a row the page knew only by a review id.
    expect(state.rows.some((r) => r.team_id === 'team-c')).toBe(true);

    state.placements = [];
    const second = await runScheduler();
    const { check } = await edgeVerdict(second);
    expect(check).toMatchObject({ ok: true, missingFromClient: [] });
    expect(second.lockedAssignments.map((r) => r.teamId)).toContain('team-c');
  });
});

describe('a failed season read', () => {
  it('disables the run and says why, rather than running with no lock set', async () => {
    state.failSeasonRead = true;
    render(
      <MemoryRouter>
        <PracticeSchedulingPage />
      </MemoryRouter>
    );
    expect(await screen.findByText(/current practices could not be read/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /run auto-scheduler optimization/i })).toBeDisabled();
  });
});

describe('the page loader and the Edge loader read one set, one way', () => {
  it('issue the same query and return the same rows', async () => {
    const record = () => {
      const calls = [];
      return {
        calls,
        from: (table) => {
          const call = { table, ops: [] };
          calls.push(call);
          const q = seasonTable();
          const wrap = /** @type {any} */ ({});
          for (const op of ['select', 'eq', 'is', 'order', 'range']) {
            wrap[op] = (...args) => {
              if (op !== 'select') call.ops.push([op, ...args]);
              q[op](...args);
              return wrap;
            };
          }
          wrap.then = (a, b) => q.then(a, b);
          return wrap;
        },
      };
    };
    const pageClient = record();
    const edgeClient = record();
    const page = await loadSeasonPracticeAssignments(pageClient, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
      pageSize: 1,
    });
    const edge = await loadSeasonPracticeLock(edgeClient, {
      organizationId: ORG,
      seasonSettingsId: SEASON,
      pageSize: 1,
    });
    const assignmentCalls = (c) => c.calls.filter((x) => x.table === 'practice_assignments');
    expect(assignmentCalls(pageClient).map((c) => c.ops)).toEqual(
      assignmentCalls(edgeClient).map((c) => c.ops)
    );
    // Paged one row at a time: a page per row, then the empty page that ends it.
    expect(assignmentCalls(pageClient)).toHaveLength(3);
    expect(page.ok && edge.ok).toBe(true);
    if (!page.ok || !edge.ok) return;
    const key = ({ id, teamId, slotId, effectiveDateRange, assignedVia }) => ({
      id,
      teamId,
      slotId,
      effectiveDateRange,
      assignedVia,
    });
    expect(page.rows.map(key)).toEqual(edge.rows.map(key));
  });
});
