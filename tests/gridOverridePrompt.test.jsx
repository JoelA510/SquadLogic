/**
 * The scheduling grid's override prompt (operator ruling 2;
 * `docs/PLAN_GRID_OVERRIDE_PROMPT.md`, witnesses W2-W7, plants P2/P4-P6).
 * W1 and the W4 unlock-set check run on the #541 seeds in
 * `gridCurrentPracticeRows.test.jsx`; W8 is the pgTAP test
 * `supabase/tests/practice_grid_current_rows.sql`.
 *
 * Driven through the real path: the real page -> the real practice reads ->
 * the real mock client (its fingerprint twin included) -> the real grid list
 * -> the real Apply -> the real dialog -> the real `persistPracticeRepair` ->
 * `fetch`. Only the override panel (a fixed staging button) and panels this
 * file does not test are stubbed. Every expected name, series and id comes
 * from the SEED, never from what the page rendered or sent.
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-gop';
const SEASON = 'season-gop';
const RUN1 = '00000000-0000-4000-8000-000000000031';

const ROSTER = vi.hoisted(() => [
  { id: 'team-a', name: 'Synthetic Hawks', division: 'U10' },
  { id: 'team-b', name: 'Synthetic Owls', division: 'U10' },
]);

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: 'org-gop', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-gop', timezone: 'America/New_York' },
    featureFlags: {},
    permissions: perms[roles.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
  return { useOrganization: () => value };
});
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: { id: 'admin-gop' } }),
}));
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
vi.mock('../frontend/src/components/PracticeOverridePanel.jsx', () => ({
  default: ({ onStageAssignment }) => (
    <>
      <button type="button" onClick={() => onStageAssignment('team-a', 'slot-fri')}>
        Stage Hawks
      </button>
      <button type="button" onClick={() => onStageAssignment('team-a', 'slot-mon')}>
        Stage Hawks Monday
      </button>
    </>
  ),
}));
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => stub('readiness'));
vi.mock('../frontend/src/components/EvaluationPanel.jsx', () => stub('evaluation'));

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { default: PracticeSchedulingPage, toPersistenceAssignment } =
  await import('../frontend/src/pages/PracticeSchedulingPage.jsx');
const { gridOverridePlan, gridOverrideReason, gridOverrideUnlock, samePruneSet } =
  await import('../frontend/src/utils/gridOverridePrompt.js');

const SLOTS = [
  { id: 'slot-mon', day_of_week: 'monday', start_time: '17:00:00', end_time: '18:30:00' },
  { id: 'slot-tue', day_of_week: 'tuesday', start_time: '18:00:00', end_time: '19:00:00' },
  { id: 'slot-wed', day_of_week: 'wednesday', start_time: '16:00:00', end_time: '17:00:00' },
  { id: 'slot-fri', day_of_week: 'friday', start_time: '17:00:00', end_time: '18:00:00' },
].map((s) => ({ ...s, capacity: 4, valid_from: '2026-09-07', valid_until: '2026-11-30' }));

function row(id, team, slot, range, extra = {}) {
  return {
    id,
    team_id: team,
    practice_slot_id: slot,
    slot_id: slot,
    effective_date_range: range,
    run_id: RUN1,
    source: 'auto',
    assigned_via: 'auto',
    organization_id: ORG,
    ...extra,
  };
}

// Hawks: a closed Monday series (history) and a current Wednesday one. Owls:
// a Tuesday series nobody stages.
const SEED = [
  row('pa-a-old', 'team-a', 'slot-mon', '[2026-09-07,2026-10-12)'),
  row('pa-a-new', 'team-a', 'slot-wed', '[2026-10-12,2026-12-01)', {
    assigned_via: 'recommendation',
  }),
  row('pa-b', 'team-b', 'slot-tue', '[2026-09-07,2026-12-01)'),
];

function seed(rows = SEED) {
  seedMockDb({
    season_settings: [{ id: SEASON, organization_id: ORG, timezone: 'America/New_York' }],
    scheduler_runs: [
      {
        id: RUN1,
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
    practice_slots: SLOTS.map((s) => ({ ...s, field_id: 'field-1', organization_id: ORG })),
    practice_assignments: rows,
  });
}

/** What the fetch boundary answers with, per test. */
let answer = { status: 200, body: { runId: 'run-applied', teamsWithoutPractice: [] } };
/** @type {any[]} */
let sent = [];

// "Today" on the season's clock (America/New_York) is 2026-10-20, so yesterday
// is 2026-10-19. Only `Date` is faked: timers stay real for `waitFor`.
const TODAY = '2026-10-20';
const YESTERDAY = '2026-10-19';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T16:00:00Z'));
  sessionStorage.clear();
  // The mock client keeps its last-saved DB on `window` and merges it into
  // every read; the prompt's fingerprint read saves it.
  delete (/** @type {any} */ (window).__MOCK_DB__);
  sent = [];
  answer = { status: 200, body: { runId: 'run-applied', teamsWithoutPractice: [] } };
  vi.spyOn(mockSupabase.auth, 'getSession').mockResolvedValue(
    /** @type {any} */ ({ data: { session: { access_token: 'token-gop' } }, error: null })
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Stage Hawks onto Friday and click Apply; return the open dialog. */
async function openPrompt(rows = SEED, { seeded = false, stage = 'Stage Hawks' } = {}) {
  if (!seeded) seed(rows);
  render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getAllByText('Synthetic Hawks').length).toBeGreaterThan(0));
  fireEvent.click(await screen.findByRole('button', { name: /enter manual override/i }));
  fireEvent.click(await screen.findByRole('button', { name: stage }));
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(apply).toBeEnabled());
  apply.focus();
  fireEvent.click(apply);
  const dialog = await screen.findByRole('dialog');
  return { dialog, apply };
}

const confirmButton = () => screen.getByRole('button', { name: 'Confirm and save' });
const tickAll = () => {
  for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
};
const chooseReason = (code = 'field-change') =>
  fireEvent.change(screen.getByLabelText('Reason for the override'), { target: { value: code } });

/** Insert a stored row "from elsewhere", as another admin's save would. */
async function insertElsewhere(newRow) {
  const { error } = await mockSupabase.from('practice_assignments').insert(newRow);
  expect(error).toBeFalsy();
}

// The mock client does not embed `fields(...)` into the slot read (the E2E
// steps hydrate it by hand for the same reason), so these lines carry no
// field name; the page appends " · <field>" when the read has one.
const HAWKS_WED = 'Wednesday 16:00–17:00, 2026-10-12 to 2026-11-30';
const HAWKS_MON = 'Monday 17:00–18:30, 2026-09-07 to 2026-10-11';
// The new row starts today, not at the slot's start (#546).
const HAWKS_FRI = `Friday 17:00–18:00, ${TODAY} to 2026-11-30`;
const ENDS = `(ends on ${YESTERDAY})`;

describe('W2: the prompt names the team, the series replaced, the new slot and the history', () => {
  it('Hawks: Wednesday replaced by Friday, Monday kept as history', async () => {
    const { dialog } = await openPrompt();
    // Nothing was sent to open it.
    expect(sent).toHaveLength(0);
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const team = within(dialog).getByTestId('grid-override-team');
    expect(team).toHaveAttribute('data-team-id', 'team-a');
    expect(within(team).getByRole('heading', { name: 'Synthetic Hawks' })).toBeInTheDocument();
    expect(within(team).getByTestId('grid-override-replacing').textContent).toBe(
      `Replacing: ${HAWKS_WED} ${ENDS}`
    );
    expect(within(team).getByTestId('grid-override-replacement').textContent).toBe(
      `With: ${HAWKS_FRI}`
    );
    // The past stays, in words.
    expect(within(team).getByTestId('grid-override-past').textContent).toBe(
      `Practices up to ${YESTERDAY} are kept; from ${TODAY} Synthetic Hawks practises ${HAWKS_FRI}.`
    );
    expect(within(team).getByTestId('grid-override-kept').textContent).toBe(
      `Kept (history, unchanged): ${HAWKS_MON}`
    );
    // Owls are not part of this override.
    expect(within(dialog).queryByText(/Synthetic Owls/)).toBeNull();
    expect(
      within(dialog).getByRole('checkbox', {
        name: 'Replace and lock Synthetic Hawks’s practice as shown',
      })
    ).not.toBeChecked();
  });

  it('two live weekdays: both are named as replaced (Q2)', async () => {
    const twoLive = [
      row('pa-a-mon', 'team-a', 'slot-mon', '[2026-09-07,2026-12-01)'),
      row('pa-a-wed', 'team-a', 'slot-wed', '[2026-09-07,2026-12-01)'),
      row('pa-b', 'team-b', 'slot-tue', '[2026-09-07,2026-12-01)'),
    ];
    const { dialog } = await openPrompt(twoLive);
    expect(within(dialog).getByTestId('grid-override-replacing').textContent).toBe(
      `Replacing: Monday 17:00–18:30, 2026-09-07 to 2026-11-30 ${ENDS} and ` +
        `Wednesday 16:00–17:00, 2026-09-07 to 2026-11-30 ${ENDS}`
    );
    expect(within(dialog).queryByTestId('grid-override-kept')).toBeNull();
  });
});

describe('W3: nothing is sent unaccepted', () => {
  it('no tick: Confirm is disabled, with its reason, and nothing is sent', async () => {
    await openPrompt();
    chooseReason();
    expect(confirmButton()).toBeDisabled();
    expect(confirmButton()).toHaveAttribute('aria-describedby', 'grid-override-confirm-why');
    expect(screen.getByTestId('grid-override-why').textContent).toBe(
      'Tick the box for the team to confirm the override.'
    );
    fireEvent.click(confirmButton());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(0);
  });

  it('no reason: Confirm is disabled and nothing is sent (P4)', async () => {
    await openPrompt();
    tickAll();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('grid-override-why').textContent).toBe(
      'Choose a reason for the override.'
    );
    fireEvent.click(confirmButton());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(0);
  });

  it('Cancel: the dialog closes, focus returns to Apply, nothing is sent, the review stays', async () => {
    const { apply } = await openPrompt();
    // Focus moved into the dialog, to its heading (plan §2.9).
    expect(document.activeElement).toBe(screen.getByTestId('grid-override-heading'));
    tickAll();
    // Ticking a box does not move focus out of the dialog.
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(apply);
    expect(sent).toHaveLength(0);
    // The staged review is still there to Apply again.
    expect(screen.getByRole('button', { name: /apply schedule/i })).toBeEnabled();
  });

  it('a blank reason cannot be built into an unlock (P4, the writer refuses it too)', () => {
    expect(() => gridOverrideUnlock([{ id: 'pa-a-new' }], '  ')).toThrow(/reason is required/);
    expect(() => gridOverrideReason({ runId: RUN1, code: '' })).toThrow(/unknown reason code/);
  });
});

describe('W4: Confirm sends exactly those rows, with the reason and the fingerprint', () => {
  it('unlock = the replaced current series; the payload is the staged one', async () => {
    seed();
    // The fingerprint of the seeded schedule, before anything is staged.
    const before = await mockSupabase.rpc('practice_schedule_fingerprint', {
      p_season_settings_id: SEASON,
    });
    await openPrompt(SEED, { seeded: true });
    tickAll();
    chooseReason('coach-request');
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0];
    // From the seed: Hawks' current series is pa-a-new; pa-a-old is history.
    expect(body.repair.unlock).toEqual([
      { assignment_id: 'pa-a-new', reason: `grid override ${RUN1}: coach-request` },
    ]);
    // #546: the replaced series started before today, so it is ended on
    // yesterday (and is in `unlock`, as the writer requires), never deleted.
    expect(body.repair.closes).toEqual([{ assignment_id: 'pa-a-new', last_day: YESTERDAY }]);
    expect(body.repair.withdrawExceptions).toEqual([]);
    expect(body.repair.exceptions).toEqual([]);
    expect(typeof before.data).toBe('string');
    expect(body.repair.baseFingerprint).toBe(before.data);
    // The payload: every stored row but the replaced one, by its stored key
    // and source -- nothing before today changes -- plus the staged Friday
    // row, which starts today.
    const keys = body.snapshot.payload.assignmentRows
      .map((r) => `${r.team_id}|${r.practice_slot_id}|${r.effective_date_range}|${r.source}`)
      .sort();
    expect(keys).toEqual(
      [
        'team-a|slot-mon|[2026-09-07,2026-10-11]|auto',
        'team-b|slot-tue|[2026-09-07,2026-11-30]|auto',
        `team-a|slot-fri|[${TODAY},2026-11-30]|manual`,
      ].sort()
    );
    // No sent row starts before today except the stored rows re-sent as is.
    const stored = new Set(SEED.map((r) => `${r.team_id}|${r.practice_slot_id}`));
    for (const r of body.snapshot.payload.assignmentRows) {
      if (!stored.has(`${r.team_id}|${r.practice_slot_id}`)) {
        expect(r.effective_date_range.slice(1, 11) >= TODAY).toBe(true);
      }
    }
    // Saved: the dialog closes and the page reports the save.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a series that starts today or later has no past: replaced whole, no close', async () => {
    const future = [
      row('pa-a-next', 'team-a', 'slot-wed', '[2026-10-26,2026-12-01)'),
      row('pa-b', 'team-b', 'slot-tue', '[2026-09-07,2026-12-01)'),
    ];
    const { dialog } = await openPrompt(future);
    expect(within(dialog).getByTestId('grid-override-replacing').textContent).toBe(
      'Replacing: Wednesday 16:00–17:00, 2026-10-26 to 2026-11-30 (not started yet, so ' +
        'replaced whole)'
    );
    expect(within(dialog).queryByTestId('grid-override-past')).toBeNull();
    tickAll();
    chooseReason();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].repair.unlock.map((u) => u.assignment_id)).toEqual(['pa-a-next']);
    expect(sent[0].repair.closes).toEqual([]);
  });

  it('a series that ended before today is not current: left untouched, nothing asked', async () => {
    const ended = [
      row('pa-a-ended', 'team-a', 'slot-wed', '[2026-09-07,2026-10-13)'),
      row('pa-b', 'team-b', 'slot-tue', '[2026-09-07,2026-12-01)'),
    ];
    seed(ended);
    render(
      <MemoryRouter>
        <PracticeSchedulingPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getAllByText('Synthetic Hawks').length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByRole('button', { name: /enter manual override/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stage Hawks' }));
    const apply = await screen.findByRole('button', { name: /apply schedule/i });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sent[0].repair).toBeUndefined();
    const keys = sent[0].snapshot.payload.assignmentRows.map(
      (r) => `${r.team_id}|${r.practice_slot_id}|${r.effective_date_range}`
    );
    // The ended series goes back exactly as stored; the new row starts today.
    expect(keys).toContain('team-a|slot-wed|[2026-09-07,2026-10-12]');
    expect(keys).toContain(`team-a|slot-fri|[${TODAY},2026-11-30]`);
  });
});

describe('W5: the auto-scheduler review computes an empty set', () => {
  it('season rows re-sent as they are, plus placements for teams with none: nothing to unlock', () => {
    const seasonRows = SEED.map((r) => ({
      id: r.id,
      teamId: r.team_id,
      slotId: r.practice_slot_id,
      effectiveDateRange: r.effective_date_range,
      source: r.source,
    }));
    const slotById = new Map(
      SLOTS.map((s) => [s.id, { effectiveFrom: s.valid_from, effectiveUntil: s.valid_until }])
    );
    // The page's review: each season row (persisted, by its own range), and
    // one new placement for a team with no row.
    const review = [
      ...seasonRows.map((r) => toPersistenceAssignment({ ...r, persisted: true })),
      toPersistenceAssignment({
        id: 'review-team-c',
        persisted: false,
        teamId: 'team-c',
        slotId: 'slot-fri',
        effectiveDateRange: '[2026-10-13,2026-11-30]',
      }),
    ];
    const plan = gridOverridePlan({ seasonRows, assignments: review, slotById, stagedTeamIds: [] });
    expect(plan).toEqual({ prune: [], strays: [], overlaps: [] });
    // Meta (it can fail): the same rule finds both writer arms. Owls left
    // out entirely -- the absent-team arm, their `auto` row -- and Hawks'
    // current row re-ranged -- the payload arm. Neither team was staged, so
    // both are strays.
    const broken = gridOverridePlan({
      seasonRows,
      assignments: review
        .filter((a) => a.id !== 'pa-b')
        .map((a) => (a.id === 'pa-a-new' ? { ...a, effectiveFrom: '2026-10-19' } : a)),
      slotById,
      stagedTeamIds: [],
    });
    expect(broken.prune.map((r) => r.id)).toEqual(['pa-a-new', 'pa-b']);
    expect(broken.strays.map((r) => r.id)).toEqual(['pa-a-new', 'pa-b']);
    // A manual row of an absent team is kept by the writer, so not pruned.
    const manualOwls = seasonRows.map((r) => (r.id === 'pa-b' ? { ...r, source: 'manual' } : r));
    expect(
      gridOverridePlan({
        seasonRows: manualOwls,
        assignments: review.filter((a) => a.id !== 'pa-b'),
        slotById,
        stagedTeamIds: [],
      }).prune
    ).toEqual([]);
  });
});

describe('W6: a row of an untouched team refuses by name and sends nothing', () => {
  it('another current Owls row appears before Confirm: listed, Confirm stays disabled', async () => {
    await openPrompt();
    await insertElsewhere(row('pa-b-fri', 'team-b', 'slot-fri', '[2026-09-07,2026-12-01)'));
    tickAll();
    chooseReason();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    // The prompt reopens on the fresh read, naming the stray.
    const stray = await screen.findByTestId('grid-override-stray');
    expect(stray.textContent).toBe(
      'Synthetic Owls’s practice (Friday 17:00–18:00, 2026-09-07 to 2026-11-30) would be removed'
    );
    tickAll();
    chooseReason();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('grid-override-why').textContent).toMatch(
      /^It cannot be saved here: a saved practice of a team with no staged override/
    );
    fireEvent.click(confirmButton());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(0);
  });
});

describe('W7: a change between open and Confirm reopens the prompt and sends nothing', () => {
  it('a second current Hawks series appears: the prompt lists both, nothing sent', async () => {
    await openPrompt();
    await insertElsewhere(row('pa-a-tue', 'team-a', 'slot-tue', '[2026-10-12,2026-12-01)'));
    tickAll();
    chooseReason();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/^The saved schedule changed while this prompt was open/);
    expect(screen.getByRole('dialog').contains(notice)).toBe(true);
    expect(screen.getByTestId('grid-override-replacing').textContent).toBe(
      // In the writer's order (by id): pa-a-new, then pa-a-tue.
      `Replacing: ${HAWKS_WED} ${ENDS} and Tuesday 18:00–19:00, 2026-10-12 to 2026-11-30 ${ENDS}`
    );
    // The ticks did not carry over to the new list.
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    expect(sent).toHaveLength(0);
  });

  it('a series re-ranged in place (same id) before Confirm: reopens with its new dates', async () => {
    await openPrompt();
    const { error } = await mockSupabase
      .from('practice_assignments')
      .update({ effective_date_range: '[2026-10-12,2026-11-16)' })
      .eq('id', 'pa-a-new');
    expect(error).toBeFalsy();
    tickAll();
    chooseReason();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await screen.findByRole('alert');
    expect(screen.getByTestId('grid-override-replacing').textContent).toBe(
      `Replacing: Wednesday 16:00–17:00, 2026-10-12 to 2026-11-15 ${ENDS}`
    );
    expect(sent).toHaveLength(0);
  });

  it('the rule compares the rows, not their order', () => {
    expect(samePruneSet([{ id: 'A' }, { id: 'b' }], [{ id: 'B' }, { id: 'a' }])).toBe(true);
    expect(samePruneSet([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toBe(false);
  });
});

describe('refusals after Confirm stay in the prompt (plan §2.8, §2.9, Q4)', () => {
  async function confirmWith(status, body) {
    answer = { status, body };
    await openPrompt();
    tickAll();
    chooseReason();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(sent).toHaveLength(1));
    return screen.findByRole('alert');
  }

  it("the writer's admin gate (42501) reads as its own message", async () => {
    const alert = await confirmWith(403, {
      status: 'error',
      message: 'unlock requires an org admin with a uid to audit: 1 assignment(s) named',
    });
    expect(alert.textContent).toBe('Only an organization admin can replace a saved practice.');
    expect(screen.getByRole('dialog').contains(alert)).toBe(true);
    // Focus came back into the dialog, to the refusal (plan §2.9).
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it("a double-booking of the team's kept history is refused before Confirm", async () => {
    // Hawks' Monday series ends 2026-10-24, before their Wednesday series
    // starts, so staging keeps it as history (#541's rule). A new Monday
    // 17:00 row from today overlaps it (the writer's :920-956).
    const kept = [
      row('pa-a-mon', 'team-a', 'slot-mon', '[2026-09-07,2026-10-25)'),
      row('pa-a-wed', 'team-a', 'slot-wed', '[2026-10-25,2026-12-01)'),
      row('pa-b', 'team-b', 'slot-tue', '[2026-09-07,2026-12-01)'),
    ];
    await openPrompt(kept, { stage: 'Stage Hawks Monday' });
    tickAll();
    chooseReason();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('grid-override-why').textContent).toBe(
      'The new practice for Synthetic Hawks overlaps its kept series (Monday 17:00–18:30, ' +
        '2026-09-07 to 2026-10-24) on the same weekday and time, which cannot be saved. Cancel ' +
        'and choose another slot.'
    );
    expect(sent).toHaveLength(0);
  });

  it('a stale fingerprint reopens the prompt on a fresh read, and does not resend', async () => {
    const alert = await confirmWith(409, {
      status: 'stale',
      code: 'PRACTICE_SCHEDULE_STALE',
      message: 'stale',
    });
    expect(alert.textContent).toMatch(/^The saved schedule changed since this prompt opened/);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
  });

  it('an unreadable fingerprint blocks Confirm: the override is never blind', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(
      /** @type {any} */ (
        (name, params) =>
          name === 'practice_schedule_fingerprint'
            ? Promise.resolve({ data: null, error: { message: 'denied' } })
            : real(name, params)
      )
    );
    await openPrompt();
    tickAll();
    chooseReason();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByTestId('grid-override-why').textContent).toMatch(
      /fingerprint could not be read/
    );
  });
});
