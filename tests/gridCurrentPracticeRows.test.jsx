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
      <button type="button" onClick={() => onStageAssignment('team-b', 'slot-fri')}>
        Stage Team B
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

// Today on the season's clock is 2026-10-20 (only `Date` is faked).
const TODAY = '2026-10-20';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T16:00:00Z'));
  sessionStorage.clear();
  // The mock client keeps its last-saved DB on `window` (an RPC such as the
  // prompt's fingerprint read saves it) and merges it into every read.
  delete (/** @type {any} */ (window).__MOCK_DB__);
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
  vi.useRealTimers();
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

/**
 * Enter manual override, stage a team, Apply. When the save would replace a
 * saved row, the override prompt opens (ruling 2): accept it for every team,
 * with one reason. Return the rows the save sent and its `unlock`.
 */
async function stageAndApply(seed, stageButton = 'Stage Team D') {
  await renderGrid(seed);
  fireEvent.click(await screen.findByRole('button', { name: /enter manual override/i }));
  fireEvent.click(await screen.findByRole('button', { name: stageButton }));
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
  await waitFor(() =>
    expect(sent.length === 1 || screen.queryByRole('dialog') !== null).toBe(true)
  );
  const prompted = screen.queryByRole('dialog') !== null;
  if (prompted) {
    // Nothing is sent before the admin accepts.
    expect(sent).toHaveLength(0);
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    fireEvent.change(screen.getByLabelText('Reason for the override'), {
      target: { value: 'conflict-fix' },
    });
    const confirm = screen.getByRole('button', { name: 'Confirm and save' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(sent).toHaveLength(1));
  }
  const body = sent[0];
  const rows = body?.snapshot?.payload?.assignmentRows;
  expect(Array.isArray(rows)).toBe(true);
  // The grid unlocks and closes only after the prompt.
  const unlock = body.repair?.unlock ?? [];
  const closes = body.repair?.closes ?? [];
  if (!prompted) {
    expect(unlock).toEqual([]);
    expect(closes).toEqual([]);
  }
  return { rows, unlock, closes, prompted };
}

/**
 * W1 + W4 (docs/PLAN_GRID_OVERRIDE_PROMPT.md §4): the save unlocks exactly
 * the writer's prune set of what it sent -- so the writer has nothing left to
 * refuse -- each with the reason chosen. Never the closed series.
 *
 * #546: no history is rewritten. Each of those rows that started before
 * today is closed on yesterday (`closes`, from the seed's own ranges); the
 * staged row starts today.
 */
function expectUnlocksPruneSet(seed, { rows, unlock, closes }) {
  const pruned = writerPruneSet(seed, rows);
  // Meta: a seed this is asserted on must prune something.
  expect(pruned.length).toBeGreaterThan(0);
  expect(unlock.map((u) => u.assignment_id).sort()).toEqual(pruned);
  for (const u of unlock) expect(u.reason).toMatch(/^grid override( \S+)?: conflict-fix$/);
  const startedBeforeToday = seed
    .filter((r) => pruned.includes(r.id))
    .filter((r) => canonicalRange(r.effective_date_range).slice(1, 11) < TODAY)
    .map((r) => r.id)
    .sort();
  // Meta: every seed asserted here replaces a series with a past to keep, so
  // an empty `closes` cannot pass as "nothing to close".
  expect(startedBeforeToday.length).toBeGreaterThan(0);
  expect(closes.map((c) => c.assignment_id).sort()).toEqual(startedBeforeToday);
  for (const c of closes) expect(c.last_day).toBe('2026-10-19');
  // The staged row starts today: nothing before today is newly claimed.
  const stagedRows = rows.filter(
    (r) => r.source === 'manual' && !seed.some((s) => keyOf(s) === keyOf(r))
  );
  expect(stagedRows.length).toBeGreaterThan(0);
  for (const r of stagedRows) expect(String(r.effective_date_range).slice(1, 11)).toBe(TODAY);
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

  // The read is ordered by id, so the two id spellings put the closed series
  // after (`pa-a-old` > `pa-a-new`) and before (`pa-a-0old`) its successor: a
  // first-row rule would drop it in one and overwrite it in the other.
  const ENACT_CLOSED_FIRST = ENACT.map((r) =>
    r.id === 'pa-a-old' ? { ...r, id: 'pa-a-0old' } : r
  );
  for (const { label, seed, closedId } of [
    { label: 'closed series sorts last', seed: ENACT, closedId: 'pa-a-old' },
    { label: 'closed series sorts first', seed: ENACT_CLOSED_FIRST, closedId: 'pa-a-0old' },
  ]) {
    it(`a re-home enact (${label}): overriding Team A keeps its closed series, replaces only the current one`, async () => {
      const closed = seed.find((r) => r.id === closedId);
      const current = seed.find((r) => r.id === 'pa-a-new');
      // Meta: the seed's ranges make one of them history (ends before the other starts).
      expect(canonicalRange(closed.effective_date_range).slice(-11, -1)).toBe(
        canonicalRange(current.effective_date_range).slice(1, 11)
      );
      const saved = await stageAndApply(seed, 'Stage Team A');
      const { rows } = saved;
      expect(saved.prompted).toBe(true);
      const list = screen.getByRole('list', { name: 'practice rows' });
      const ids = shownIds(list);
      expect(ids).toEqual(
        [
          ...seed.filter((r) => r.id !== 'pa-a-new').map((r) => r.id),
          'staged-team-a-slot-fri',
        ].sort()
      );
      // The closed series goes back exactly as stored: same key, same source.
      const sentClosed = rows.filter((r) => keyOf(r) === keyOf(closed));
      expect(sentClosed).toHaveLength(1);
      expect(sentClosed[0].source).toBe(closed.source);
      // The staged row is sent once, and Team A's current series is not sent.
      expect(rows.filter((r) => r.team_id === 'team-a')).toHaveLength(2);
      expect(rows.some((r) => keyOf(r) === keyOf(current))).toBe(false);
      // What the writer would remove is the replaced current series and
      // nothing else, never the closed history (pgTAP pins both). Ruling 2
      // locks it, so the prompt asked, and the save unlocks exactly it.
      expect(writerPruneSet(seed, rows)).toEqual(['pa-a-new']);
      expectUnlocksPruneSet(seed, saved);
      expect(saved.unlock.some((u) => u.assignment_id === closedId)).toBe(false);
    });
  }

  it('a team with TWO current series (two weekdays): today behaviour, one staged row (pinned)', async () => {
    const TWO_LIVE = [
      row('pa-a-mon', 'team-a', 'slot-mon', FULL, RUN2),
      row('pa-a-wed', 'team-a', 'slot-wed', FULL, RUN2),
      row('pa-b', 'team-b', 'slot-tue', FULL, RUN2),
    ];
    const saved = await stageAndApply(TWO_LIVE, 'Stage Team A');
    const { rows } = saved;
    const ids = shownIds(screen.getByRole('list', { name: 'practice rows' }));
    // Ambiguous which weekday an override replaces, so it is not guessed: the
    // team's current rows collapse to the one staged row, as the old per-row
    // replace did (it sent one key for all of them).
    expect(ids).toEqual(['pa-b', 'staged-team-a-slot-fri']);
    expect(rows.filter((r) => r.team_id === 'team-a')).toHaveLength(1);
    expect(writerPruneSet(TWO_LIVE, rows)).toEqual(['pa-a-mon', 'pa-a-wed']);
    // Q2: both weekdays are replaced together, and both are unlocked.
    expectUnlocksPruneSet(TWO_LIVE, saved);
  });

  it('a save that omitted B and C: the grid shows their retained manual rows', async () => {
    const list = await renderGrid(RETAINED);
    expect(shownIds(list)).toEqual(RETAINED.map((r) => r.id).sort());
  });

  it('a re-home enact: a manual override for another team removes no stored row', async () => {
    const { rows, prompted } = await stageAndApply(ENACT);
    expect(rows.some((r) => r.team_id === STAGED_TEAM)).toBe(true);
    expect(writerPruneSet(ENACT, rows)).toEqual([]);
    // Nothing to unlock, so nothing is asked: the save is today's.
    expect(prompted).toBe(false);
  });

  it('a save that omitted B and C: a manual override removes no stored row', async () => {
    const { rows, prompted } = await stageAndApply(RETAINED);
    expect(rows.some((r) => r.team_id === STAGED_TEAM)).toBe(true);
    expect(writerPruneSet(RETAINED, rows)).toEqual([]);
    expect(prompted).toBe(false);
  });

  it('a save that omitted B and C: overriding B (manual) unlocks exactly its retained row', async () => {
    const saved = await stageAndApply(RETAINED, 'Stage Team B');
    expect(saved.prompted).toBe(true);
    expect(writerPruneSet(RETAINED, saved.rows)).toEqual(['pa-b']);
    expectUnlocksPruneSet(RETAINED, saved);
  });
});
