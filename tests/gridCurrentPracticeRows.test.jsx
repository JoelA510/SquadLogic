/**
 * The scheduling grid (`PracticeSchedulingPage`) shows, and saves, the
 * season's CURRENT practice rows -- not the latest run's.
 *
 * The #530 follow-up. The exports read rows by the latest run id and dropped
 * two shapes writer v3 leaves under an OLDER run (see
 * `exportCurrentPracticeRows.test.jsx` for the writer line references):
 *
 *  - ENACT: after a re-home enact, the displaced series kept by id through
 *    `closes` keeps its old run id;
 *  - RETAINED: after a save whose payload omitted teams, their `manual` rows
 *    are kept under their old run id.
 *
 * The grid's rows used to come from `usePracticeAssignments(latestRunId)`; now
 * they come from `practice.scheduleAssignments` (`useCurrentPracticeSchedule`,
 * the `loadSeasonPracticeRows` contract the exports use). A manual override is
 * staged on top of those rows, and Apply sends the whole staged list. So the
 * questions are:
 * (1) does the grid show every current row, dated so that a closed series and
 *     its successor are not read as a clash?
 * (2) does the save built from the grid's read ask the writer to remove a row
 *     nobody touched?
 *
 * Driven through the real path: the real page -> the real `useDashboardData`
 * -> the real scheduler-run and practice reads -> the real mock client ->
 * the real grid list -> the real Apply -> the real
 * `persistPracticeScheduleReview` -> `fetch`. Only the override panel and
 * panels this file does not test are stubbed. Every expected row is enumerated
 * from the SEED, never from what the page rendered or sent.
 *
 * The writer is SQL and has no JS twin, so (2) is judged here by
 * `writerPruneSet`, a transcription of the v3 prune rule
 * (20261002000000_practice_exceptions_daylight.sql:717-773). Every row in that
 * set that the save does not `unlock` makes the writer refuse the whole save
 * with 22023 "assignment X is locked" (:775-798). The real writer is checked
 * against the same two shapes in `supabase/tests/practice_grid_current_rows.sql`.
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-pgrid';
const SEASON = 'season-pgrid';
const RUN1 = '00000000-0000-4000-8000-000000000011';
const RUN2 = '00000000-0000-4000-8000-000000000012';

// Team D holds no practice: it is the team the operator stages, so the staged
// change itself removes nothing and any prune is the read's doing.
const ROSTER = vi.hoisted(() => [
  { id: 'team-a', name: 'Team A', division: 'U10' },
  { id: 'team-b', name: 'Team B', division: 'U10' },
  { id: 'team-c', name: 'Team C', division: 'U10' },
  { id: 'team-d', name: 'Team D', division: 'U10' },
]);
const STAGED_TEAM = 'team-d';
const STAGED_SLOT = 'slot-fri';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: 'org-pgrid', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-pgrid', timezone: 'America/New_York' },
    featureFlags: {},
    permissions: perms[roles.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
  return { useOrganization: () => value };
});
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: { id: 'admin-pgrid' } }),
}));
// The roster is the seed's, handed over as the team read would. One stable
// object: a fresh one per render would re-run the page's roster memos.
vi.mock('../frontend/src/hooks/useTeamSummary.js', () => {
  const value = {
    summary: { teams: ROSTER },
    loading: false,
    error: null,
    status: 'completed',
    progress: 100,
    generatedAt: '2026-09-01',
  };
  return { useTeamSummary: () => value };
});
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
vi.mock('../frontend/src/hooks/useAutoScheduler.js', () => {
  const idle = {
    status: 'idle',
    result: null,
    progress: null,
    error: null,
    trigger: async () => {},
    cancel: () => {},
    reset: () => {},
  };
  return { useAutoScheduler: () => idle };
});
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
// The REAL grid list renders, with an id list beside it so a test can name
// the rows it was handed. The override panel is stubbed: it stages one fixed
// (team, slot) through the page's own handler.
vi.mock('../frontend/src/components/PracticeAssignmentList.jsx', async (importOriginal) => {
  const { default: RealList } = /** @type {any} */ (await importOriginal());
  return {
    default: (props) => (
      <>
        <ul aria-label="practice rows">
          {props.assignments.map((a) => (
            <li key={a.id}>{a.id}</li>
          ))}
        </ul>
        <RealList {...props} />
      </>
    ),
  };
});
vi.mock('../frontend/src/components/PracticeOverridePanel.jsx', () => ({
  default: ({ onStageAssignment }) => (
    <>
      <button type="button" onClick={() => onStageAssignment('team-d', 'slot-fri')}>
        Stage Team D
      </button>
      <button type="button" onClick={() => onStageAssignment('team-a', 'slot-fri')}>
        Stage Team A
      </button>
    </>
  ),
}));
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => stub('readiness'));
vi.mock('../frontend/src/components/EvaluationPanel.jsx', () => stub('evaluation'));

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { default: PracticeSchedulingPage } =
  await import('../frontend/src/pages/PracticeSchedulingPage.jsx');

const SLOTS = ['mon', 'tue', 'wed', 'thu', 'fri'].map((day) => ({
  id: `slot-${day}`,
  day_of_week: day,
  start_time: '17:00:00',
  end_time: '18:00:00',
  capacity: 4,
  valid_from: '2026-09-07',
  valid_until: '2026-11-30',
  field_id: 'field-1',
}));

/** A row as the writer stores it. */
function row(id, team, slot, range, runId, extra = {}) {
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
    ...extra,
  };
}

const FULL = '[2026-09-07,2026-12-01)';

/** Re-home enact of A's Monday series on 2026-10-12, as the writer leaves it. */
const ENACT = [
  // Kept by id through `closes`, shortened, NOT re-sent: its run id stays RUN1.
  row('pa-a-old', 'team-a', 'slot-mon', '[2026-09-07,2026-10-12)', RUN1),
  row('pa-a-new', 'team-a', 'slot-thu', '[2026-10-12,2026-12-01)', RUN2, {
    assigned_via: 'recommendation',
  }),
  row('pa-b', 'team-b', 'slot-tue', FULL, RUN2),
  row('pa-c', 'team-c', 'slot-wed', FULL, RUN2),
];

/** RUN2's payload named A only; B's and C's manual rows are retained under RUN1. */
const RETAINED = [
  row('pa-a', 'team-a', 'slot-mon', FULL, RUN2),
  row('pa-b', 'team-b', 'slot-tue', FULL, RUN1, { source: 'manual' }),
  row('pa-c', 'team-c', 'slot-wed', FULL, RUN1, { source: 'manual' }),
];

function dbOf(assignments) {
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
    divisions: [{ id: 'div-now', organization_id: ORG, season_settings_id: SEASON, name: 'U10' }],
    teams: ROSTER.map((t) => ({
      id: t.id,
      name: t.name,
      organization_id: ORG,
      division_id: 'div-now',
    })),
    fields: [{ id: 'field-1', name: 'Field 1', organization_id: ORG, location_id: 'loc-1' }],
    practice_slots: SLOTS.map((s) => ({ ...s, organization_id: ORG })),
    practice_assignments: assignments,
  };
}

/** The season's teams, from the seed's teams -> divisions, not from any row. */
const SEASON_TEAMS = new Set(
  dbOf([])
    .teams.filter((t) => t.division_id === 'div-now')
    .map((t) => t.id)
);

const DAY_MS = 86400000;
const plusDay = (iso) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** A daterange literal in Postgres' canonical `[lower,upper)` form. */
function canonicalRange(text) {
  const m = /^([[(])(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})([\])])$/.exec(String(text));
  if (!m) throw new Error(`not a daterange literal: ${text}`);
  const lower = m[1] === '[' ? m[2] : plusDay(m[2]);
  const upper = m[4] === ')' ? m[3] : plusDay(m[3]);
  return `[${lower},${upper})`;
}
const keyOf = (r) =>
  `${r.team_id}|${r.practice_slot_id ?? r.slot_id}|${canonicalRange(r.effective_date_range)}`;

/**
 * The v3 prune set (:717-773), transcribed: for a season team IN the payload,
 * every stored row whose (team, slot, range) key the payload does not carry;
 * for a season team ABSENT from it, its `auto` rows. `closes` is empty here
 * (asserted per save), so its exemption is not modelled.
 */
function writerPruneSet(stored, payloadRows) {
  const payloadTeams = new Set(payloadRows.map((r) => r.team_id));
  const payloadKeys = new Set(payloadRows.map(keyOf));
  return stored
    .filter((r) => SEASON_TEAMS.has(r.team_id))
    .filter((r) => (payloadTeams.has(r.team_id) ? !payloadKeys.has(keyOf(r)) : r.source === 'auto'))
    .map((r) => r.id)
    .sort();
}

/** Season rows a latest-run (RUN2) reader cannot see: what makes a case bite. */
const olderRunRows = (seed) => seed.filter((r) => SEASON_TEAMS.has(r.team_id) && r.run_id !== RUN2);

/** @type {any[]} */
let sent = [];

beforeEach(() => {
  sessionStorage.clear();
  sent = [];
  vi.spyOn(mockSupabase.auth, 'getSession').mockResolvedValue(
    /** @type {any} */ ({ data: { session: { access_token: 'token-pgrid' } }, error: null })
  );
  // The Edge, as far as this file needs it: record the body, answer success.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify({ runId: 'run-applied', teamsWithoutPractice: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function renderGrid(seed) {
  seedMockDb(dbOf(seed));
  render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
  // Let every read settle: this file is about WHICH rows are read.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const list = await screen.findByRole('list', { name: 'practice rows' });
  await waitFor(() => expect(list.children.length).toBeGreaterThan(0));
  return list;
}

const shownIds = (list) => [...list.querySelectorAll('li')].map((li) => li.textContent).sort();

/** Enter manual override, stage Team D, Apply; return the rows the save sent. */
async function stageAndApply(seed) {
  await renderGrid(seed);
  fireEvent.click(await screen.findByRole('button', { name: /enter manual override/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stage Team D' }));
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
  await waitFor(() => expect(sent).toHaveLength(1));
  const body = sent[0];
  const rows = body?.snapshot?.payload?.assignmentRows;
  expect(Array.isArray(rows)).toBe(true);
  // The grid never unlocks or closes: whatever the prune set holds, the
  // writer refuses the save over it rather than deleting it (:775-798).
  expect(body.repair?.unlock ?? []).toEqual([]);
  expect(body.repair?.closes ?? []).toEqual([]);
  return rows;
}

describe('the scheduling grid reads the current practice schedule, not the latest run', () => {
  it('each case holds a live row a latest-run reader cannot see (meta, can fail)', () => {
    for (const seed of [ENACT, RETAINED]) expect(olderRunRows(seed).length).toBeGreaterThan(0);
    const restamped = ENACT.map((r) => ({ ...r, run_id: RUN2 }));
    expect(olderRunRows(restamped)).toHaveLength(0);
    // The staged team holds no row, so staging it removes nothing by itself.
    for (const seed of [ENACT, RETAINED]) {
      expect(seed.some((r) => r.team_id === STAGED_TEAM)).toBe(false);
    }
    expect(SLOTS.some((s) => s.id === STAGED_SLOT)).toBe(true);
  });

  it('the prune transcription can fail (meta)', () => {
    // A payload that re-sends every stored row prunes nothing...
    expect(writerPruneSet(ENACT, ENACT)).toEqual([]);
    // ...one shaped like a latest-run read prunes the closed series...
    expect(
      writerPruneSet(
        ENACT,
        ENACT.filter((r) => r.run_id === RUN2)
      )
    ).toEqual(['pa-a-old']);
    // ...an inclusive upper bound is the same key as its exclusive twin...
    const inclusive = ENACT.map((r) =>
      r.id === 'pa-a-old' ? { ...r, effective_date_range: '[2026-09-07,2026-10-11]' } : r
    );
    expect(writerPruneSet(ENACT, inclusive)).toEqual([]);
    // ...an absent team loses its auto rows and keeps its manual ones.
    expect(
      writerPruneSet(
        ENACT,
        ENACT.filter((r) => r.team_id !== 'team-b')
      )
    ).toEqual(['pa-b']);
    expect(
      writerPruneSet(
        RETAINED,
        RETAINED.filter((r) => r.run_id === RUN2)
      )
    ).toEqual([]);
  });

  it('a re-home enact: the grid shows the closed series', async () => {
    const list = await renderGrid(ENACT);
    expect(shownIds(list)).toEqual(ENACT.map((r) => r.id).sort());
  });

  it('a re-home enact: the closed and the new series read as two dated rows, not a clash', async () => {
    await renderGrid(ENACT);
    // From the seed: Team A's rows, each with its weekday and stored range.
    const seedRows = ENACT.filter((r) => r.team_id === 'team-a');
    expect(seedRows).toHaveLength(2);
    // Not a double booking: the two ranges do not overlap (canonical `[)`).
    const [first, second] = seedRows
      .map((r) => canonicalRange(r.effective_date_range).slice(1, -1).split(','))
      .sort((a, b) => a[0].localeCompare(b[0]));
    expect(first[1] <= second[0]).toBe(true);
    // The real grid list renders one row per series, each with its own weekday
    // and its own date range, so the ended series is told apart by its range.
    const rendered = screen
      .getAllByRole('row')
      .filter((tr) => tr.textContent.includes('Team A'))
      .map((tr) => tr.textContent);
    expect(rendered).toHaveLength(seedRows.length);
    for (const r of seedRows) {
      const day = SLOTS.find((s) => s.id === r.practice_slot_id).day_of_week;
      expect(
        rendered.filter((t) => t.includes(day) && t.includes(r.effective_date_range))
      ).toHaveLength(1);
    }
  });

  it('a re-home enact: overriding the re-homed team stages ONE row for it, not two', async () => {
    const list = await renderGrid(ENACT);
    fireEvent.click(await screen.findByRole('button', { name: /enter manual override/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stage Team A' }));
    await waitFor(() => expect(shownIds(list)).toContain('staged-team-a-slot-fri'));
    const ids = shownIds(list);
    // Meta: Team A held two rows in the seed, so a per-row replace would double it.
    expect(ENACT.filter((r) => r.team_id === 'team-a')).toHaveLength(2);
    expect(ids.filter((id) => id === 'staged-team-a-slot-fri')).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    // The other teams' rows are untouched; Team A's two series are replaced.
    expect(ids).toEqual(
      [
        ...ENACT.filter((r) => r.team_id !== 'team-a').map((r) => r.id),
        'staged-team-a-slot-fri',
      ].sort()
    );
  });

  it('a save that omitted B and C: the grid shows their retained manual rows', async () => {
    const list = await renderGrid(RETAINED);
    expect(shownIds(list)).toEqual(RETAINED.map((r) => r.id).sort());
  });

  it('a re-home enact: a manual override for another team removes no stored row', async () => {
    const rows = await stageAndApply(ENACT);
    expect(rows.some((r) => r.team_id === STAGED_TEAM)).toBe(true);
    expect(writerPruneSet(ENACT, rows)).toEqual([]);
  });

  it('a save that omitted B and C: a manual override removes no stored row', async () => {
    const rows = await stageAndApply(RETAINED);
    expect(rows.some((r) => r.team_id === STAGED_TEAM)).toBe(true);
    expect(writerPruneSet(RETAINED, rows)).toEqual([]);
  });
});
