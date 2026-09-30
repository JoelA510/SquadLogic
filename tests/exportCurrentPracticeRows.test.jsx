/**
 * The exports list the season's CURRENT practice rows, not the latest run's.
 *
 * Writer v3 (`persist_practice_schedule`, 20261002000000) keeps rows under the
 * run id that last wrote them, and each enact is its own run
 * (`enact_practice_recommendation`, 20261004000000: run id = enact key). Two
 * states the writer produces leave live rows under an OLDER run than the
 * season's latest, and a latest-run reader silently drops them:
 *
 *  - a re-home enact: the displaced series S is kept BY ID through `closes`
 *    (shortened to end the day before the loss, :847-867) and is not re-sent,
 *    so it keeps its old run id, while every re-sent key is re-stamped with
 *    the enact's (`ON CONFLICT ... DO UPDATE SET run_id`, :1041-1046);
 *  - a save whose payload omits a team: that team's `manual` rows are kept
 *    and reported (:895-911), under their old run id.
 *
 * Driven through the real path: `ExportsPage` -> `useDashboardData` -> the
 * real scheduler-run and practice reads -> the real mock client -> the real
 * `OutputGenerationPanel` builder -> `generateScheduleExports`. Every expected
 * row and team is enumerated from the SEED (the roster and the stored rows),
 * never from what the export returned.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-pexp';
const SEASON = 'season-pexp';
const OTHER_SEASON = 'season-pexp-old';
const RUN1 = '00000000-0000-4000-8000-000000000001';
const RUN2 = '00000000-0000-4000-8000-000000000002';

const ROSTER = vi.hoisted(() => [
  { id: 'team-a', name: 'Team A', division: 'U10' },
  { id: 'team-b', name: 'Team B', division: 'U10' },
  { id: 'team-c', name: 'Team C', division: 'U10' },
]);

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-pexp' },
    currentSeasonSetting: { id: 'season-pexp', timezone: 'America/New_York' },
  }),
}));
// The roster is the seed's, handed over as the team read would.
vi.mock('../frontend/src/hooks/useTeamSummary.js', () => ({
  useTeamSummary: () => ({
    summary: { teams: ROSTER },
    loading: false,
    error: null,
    status: 'completed',
    progress: 100,
    generatedAt: '2026-09-01',
  }),
}));
vi.mock('../frontend/src/hooks/useGameSummary.js', () => ({
  useGameSummary: () => ({
    gameSummary: null,
    gameReadinessSnapshot: null,
    generatedAt: null,
    loading: false,
    error: null,
    runId: null,
  }),
}));
vi.mock('../frontend/src/hooks/useGameAssignments.js', () => ({
  useGameAssignments: () => ({ assignments: [], loading: false, error: null }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'admin-pexp' } }),
}));
vi.mock('../frontend/src/hooks/usePublicationBaselines.js', () => ({
  usePublicationBaselines: () => ({
    baselines: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    publishBaseline: vi.fn(),
    compareWithBaseline: vi.fn(),
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
// Pass-through: the real generator runs; the spy records what it was handed.
vi.mock('../packages/core/src/outputGeneration.js', async () => {
  const actual = /** @type {any} */ (
    await vi.importActual('../packages/core/src/outputGeneration.js')
  );
  return { ...actual, generateScheduleExports: vi.fn(actual.generateScheduleExports) };
});

const { generateScheduleExports } = await import('../packages/core/src/outputGeneration.js');
const { default: ExportsPage } = await import('../frontend/src/pages/ExportsPage.jsx');

// `day_of_week` as the schema's enum spells it (`DAY_OF_WEEK_ENUM`).
const SLOTS = [
  { id: 'slot-mon', day_of_week: 'mon', start_time: '17:00', end_time: '18:00' },
  { id: 'slot-tue', day_of_week: 'tue', start_time: '17:00', end_time: '18:00' },
  { id: 'slot-wed', day_of_week: 'wed', start_time: '17:00', end_time: '18:00' },
  { id: 'slot-thu', day_of_week: 'thu', start_time: '17:00', end_time: '18:00' },
  { id: 'slot-fri', day_of_week: 'fri', start_time: '17:00', end_time: '18:00' },
];

/**
 * A row as the writer stores it. `date` is the export's own date for it --
 * the first weekday of its slot on or after its range's lower bound -- worked
 * out by hand here (2026-09-07 is a Monday), never by the builder.
 */
function row(id, team, slot, range, runId, date, extra = {}) {
  return {
    id,
    team_id: team,
    practice_slot_id: slot,
    slot_id: slot,
    effective_date_range: range,
    run_id: runId,
    source: 'auto',
    assigned_via: 'auto',
    organization_id: ORG,
    date,
    ...extra,
  };
}

function dbOf(assignments, exceptions = []) {
  return {
    scheduler_runs: [
      {
        id: RUN1,
        organization_id: ORG,
        run_type: 'practice',
        status: 'completed',
        completed_at: '2026-09-01T12:00:00Z',
        season_settings_id: SEASON,
        results: {},
      },
      {
        id: RUN2,
        organization_id: ORG,
        run_type: 'practice',
        status: 'completed',
        completed_at: '2026-10-05T12:00:00Z',
        season_settings_id: SEASON,
        results: {},
      },
    ],
    divisions: [
      { id: 'div-now', organization_id: ORG, season_settings_id: SEASON, name: 'U10' },
      { id: 'div-old', organization_id: ORG, season_settings_id: OTHER_SEASON, name: 'U10' },
    ],
    teams: [
      ...ROSTER.map((t) => ({
        id: t.id,
        name: t.name,
        organization_id: ORG,
        division_id: 'div-now',
      })),
      { id: 'team-old', name: 'Team Old', organization_id: ORG, division_id: 'div-old' },
    ],
    fields: [{ id: 'field-1', name: 'Field 1', organization_id: ORG }],
    practice_slots: SLOTS.map((s) => ({ ...s, organization_id: ORG, field_id: 'field-1' })),
    practice_assignments: assignments.map(({ date: _d, ...a }) => a),
    practice_exceptions: exceptions.map((e) => ({ ...e, organization_id: ORG })),
  };
}

const FULL = '[2026-09-07,2026-12-01)';

/** Re-home enact of A's Monday series on 2026-10-12 (a Monday), as the writer leaves it. */
const ENACT = [
  // S: kept by id through `closes`, shortened, NOT re-sent: its run id stays RUN1.
  row('pa-a-old', 'team-a', 'slot-mon', '[2026-09-07,2026-10-12)', RUN1, '2026-09-07'),
  // The re-home, and every re-sent key, carry the enact's run id.
  row('pa-a-new', 'team-a', 'slot-thu', '[2026-10-12,2026-12-01)', RUN2, '2026-10-15', {
    assigned_via: 'recommendation',
  }),
  row('pa-b', 'team-b', 'slot-tue', FULL, RUN2, '2026-09-08'),
  row('pa-c', 'team-c', 'slot-wed', FULL, RUN2, '2026-09-09'),
];

/** RUN2's payload named A only; B's and C's manual rows are retained under RUN1. */
const RETAINED = [
  row('pa-a', 'team-a', 'slot-mon', FULL, RUN2, '2026-09-07'),
  row('pa-b', 'team-b', 'slot-tue', FULL, RUN1, '2026-09-08', { source: 'manual' }),
  row('pa-c', 'team-c', 'slot-wed', FULL, RUN1, '2026-09-09', { source: 'manual' }),
];

/**
 * RUN2 moved B from Tuesday to Friday: the writer DELETED the Tuesday row
 * (the prune, :883-893), so the store holds only the Friday one. Another
 * season's row is in the organisation and is not this season's schedule.
 */
const SUPERSEDED = [
  row('pa-a', 'team-a', 'slot-mon', FULL, RUN2, '2026-09-07'),
  row('pa-b-new', 'team-b', 'slot-fri', FULL, RUN2, '2026-09-11'),
  row('pa-c', 'team-c', 'slot-wed', FULL, RUN1, '2026-09-09', { source: 'manual' }),
  row('pa-old-season', 'team-old', 'slot-tue', '[2025-09-01,2025-12-01)', RUN1, '2025-09-02'),
];

/** The rows of THIS season, from the seed's own teams -> divisions. */
function seasonRowsOf(seed) {
  const now = new Set(
    dbOf([])
      .teams.filter((t) => t.division_id === 'div-now')
      .map((t) => t.id)
  );
  return seed.filter((r) => now.has(r.team_id));
}
const keyOf = (teamId, slotId, date) => `${teamId}|${slotId}|${date}`;
const expectedKeys = (seed) =>
  seasonRowsOf(seed)
    .map((r) => keyOf(r.team_id, r.practice_slot_id, r.date))
    .sort();
/** Season rows a latest-run (RUN2) reader cannot see: what makes a case bite. */
const olderRunRows = (seed) => seasonRowsOf(seed).filter((r) => r.run_id !== RUN2);

async function exportedFor(seed, exceptions = []) {
  seedMockDb(dbOf(seed, exceptions));
  render(
    <MemoryRouter>
      <ExportsPage />
    </MemoryRouter>
  );
  const button = await screen.findByRole('button', { name: 'Generate CSVs' });
  // Let every read settle before judging what the export lists: this file is
  // about WHICH rows are read, not about the gate's timing.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText('CSVs generated successfully.');
  const calls = /** @type {any} */ (generateScheduleExports).mock.calls;
  const practices = calls[calls.length - 1][0].practiceAssignments;
  return practices.map((p) => keyOf(p.teamId, p.slotId, p.start.slice(0, 10))).sort();
}

beforeEach(() => {
  sessionStorage.clear();
  /** @type {any} */ (generateScheduleExports).mockClear();
});

describe('exports read the current practice schedule, not the latest run', () => {
  it('each case holds a live row a latest-run reader cannot see (meta, can fail)', () => {
    for (const seed of [ENACT, RETAINED, SUPERSEDED]) {
      expect(olderRunRows(seed).length).toBeGreaterThan(0);
    }
    // The meter fails when every row carries the latest run: nothing to catch.
    const restamped = ENACT.map((r) => ({ ...r, run_id: RUN2 }));
    expect(olderRunRows(restamped)).toHaveLength(0);
    // And every roster team holds a row in every case.
    for (const seed of [ENACT, RETAINED, SUPERSEDED]) {
      const held = new Set(seasonRowsOf(seed).map((r) => r.team_id));
      expect(ROSTER.filter((t) => !held.has(t.id))).toEqual([]);
    }
  });

  it('a re-home enact: the closed series stays in the export, at its own date', async () => {
    const exported = await exportedFor(ENACT);
    expect(exported).toEqual(expectedKeys(ENACT));
    // Closed is not superseded: it is exported, dated inside its shortened range.
    expect(exported).toContain(keyOf('team-a', 'slot-mon', '2026-09-07'));
    expect(exported).toContain(keyOf('team-a', 'slot-thu', '2026-10-15'));
  });

  it('a save that omitted B and C: every roster team is still exported', async () => {
    const exported = await exportedFor(RETAINED);
    expect(exported).toEqual(expectedKeys(RETAINED));
    const teams = new Set(exported.map((k) => k.split('|')[0]));
    expect(ROSTER.map((t) => t.id).filter((id) => !teams.has(id))).toEqual([]);
  });

  it('a superseded row is not exported, and another season is not this one', async () => {
    const exported = await exportedFor(SUPERSEDED);
    expect(exported).toEqual(expectedKeys(SUPERSEDED));
    expect(exported.some((k) => k.startsWith('team-b|slot-tue|'))).toBe(false);
    expect(exported.some((k) => k.startsWith('team-old|'))).toBe(false);
  });

  it('both export call sites hand the panel the season schedule, not the run rows', () => {
    // `DashboardWorkflow` is not rendered here (`exportGateOnFailedRead` renders
    // it); this pins that it is fed from the same field `ExportsPage` is.
    const sources = {
      'frontend/src/pages/ExportsPage.jsx': 'practice?.scheduleAssignments',
      'frontend/src/components/DashboardWorkflow.jsx': 'practiceData?.scheduleAssignments',
    };
    for (const [file, field] of Object.entries(sources)) {
      const text = readFileSync(resolve(process.cwd(), file), 'utf8');
      const fed = [...text.matchAll(/practiceAssignments=\{([^}]*)\}/g)].map((m) => m[1]);
      expect(fed.length, file).toBeGreaterThan(0);
      for (const expr of fed) expect(expr, file).toBe(`${field} || []`);
    }
  });

  it('the temporary-changes note counts over the rows the export now holds', async () => {
    // By hand: two Mondays of the closed series (09-14, 09-21) are TIME TBD,
    // one Wednesday of C (09-16) is moved; the exception on the other
    // season's row is not this export's. Three.
    const exceptions = [
      {
        id: 'e1',
        assignment_id: 'pa-a-old',
        window: '[2026-09-14,2026-09-22)',
        kind: 'time_tbd',
        tbd_reason: 'contended',
        withdrawn_at: null,
      },
      {
        id: 'e2',
        assignment_id: 'pa-c',
        window: '[2026-09-16,2026-09-17)',
        kind: 'relocated',
        tbd_reason: null,
        withdrawn_at: null,
      },
      {
        id: 'e3',
        assignment_id: 'pa-old-season',
        window: '[2025-09-02,2025-09-10)',
        kind: 'time_tbd',
        tbd_reason: 'contended',
        withdrawn_at: null,
      },
    ];
    await exportedFor(ENACT, exceptions);
    expect(await screen.findByRole('status')).toHaveTextContent(
      '3 practices have temporary changes not shown in this export.'
    );
  });
});
