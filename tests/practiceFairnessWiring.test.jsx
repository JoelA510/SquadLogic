/**
 * The practice page's fairness evaluation examines the page's real schedule
 * (audit finding 13.1, issue #364; remediation plan Oct 2026, M1.1).
 *
 * The defect: the page rendered
 * `<EvaluationPanel practiceData={{ assignments: localAssignments }} />`, and the
 * panel defaults `teams` and `slots` to `[]`, so `fairness-scoring` evaluated an
 * empty roster. The Edge engine builds its team lookup from `teams`
 * (`_shared/engines/scoring-engine.ts`), so every assignment was dropped as an
 * unknown team and no coach was ever found: zero coach conflicts for every
 * schedule -- a clean result after examining nothing (incident 4 of
 * `fixtures/season-2026/README.md`, in the UI). Every other test that mounts
 * this page stubs the panel, which is how it went unseen.
 *
 * Driven through the real path: the real page -> the real `useDashboardData`
 * -> the real season-row and slot reads -> the real mock client -> the real
 * `EvaluationPanel` -> `functions.invoke('fairness-scoring', ...)`. The Edge is
 * stood in for by its own code: the request is parsed with the function's own
 * `ScoringInputSchema`, its slots are placed with `anchorWallTimes`, and it is
 * scored by the Edge `evaluatePracticeSchedule`, aggregated as
 * `fairness-scoring/index.ts` does for a practice-only request. Auth, rate
 * limiting and persistence are the only parts left out.
 *
 * Every expectation is enumerated from the SEED (roster, slots, rows), never
 * from what the page rendered or sent.
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';
import {
  ScoringInputSchema,
  datedSlotsIssue,
  refuseEmptyPracticeRoster,
  undatedExceptionsIssue,
} from '../supabase/functions/_shared/schemas/scoring.ts';
import { practiceOccurrenceDates } from '../packages/core/src/utils/practiceOccurrences.js';
import { anchorWallTimes } from '../supabase/functions/_shared/timing/anchorWallTimes.ts';
import { evaluatePracticeSchedule as edgeEvaluate } from '../supabase/functions/_shared/engines/scoring-engine.js';

// A UUID: the Edge's `ScoringInputSchema` refuses any other organization id.
const ORG = '00000000-0000-4000-8000-0000000000a1';
const SEASON = 'season-fairness';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const TZ = 'America/New_York';

/**
 * The roster the team read hands the page, swapped per test. One stable object
 * per test: a fresh one per render would re-run the page's roster memos.
 */
const TEAM_READ = vi.hoisted(() => ({ value: /** @type {any} */ (null) }));
/** The auto-scheduler hook's state, swapped by the review-path test (M4.7). */
const AUTO = vi.hoisted(() => ({ value: /** @type {any} */ (null) }));
/** The stubbed practice save, per test: `null` keeps the real client (the follow-up's Apply tests). */
const SAVE = vi.hoisted(() => ({
  impl: /** @type {any} */ (null),
  requests: /** @type {any[]} */ ([]),
}));
/** The props the override panel was last rendered with (M4.7, its per-slot count). */
const OVERRIDE_PROPS = vi.hoisted(() => ({ value: /** @type {any} */ (null) }));

/**
 * The planted double-booking: `coach-dup` is Team A's head coach and Team B's
 * assistant, and both teams practise in `slot-mon`. An assistant, on purpose:
 * the conflict is only visible if the teams sent carry `assistantCoachIds`.
 */
const ROSTER = [
  { id: 'team-a', name: 'Team A', division: 'U10', coach_id: 'coach-dup' },
  {
    id: 'team-b',
    name: 'Team B',
    division: 'U10',
    coach_id: 'coach-b',
    assistant_coach_ids: ['coach-dup'],
  },
  { id: 'team-c', name: 'Team C', division: 'U12', coach_id: 'coach-c' },
  { id: 'team-d', name: 'Team D', division: 'U12', coach_id: 'coach-d' },
];
const DOUBLE_BOOKED_COACH = 'coach-dup';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: '00000000-0000-4000-8000-0000000000a1', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-fairness', timezone: 'America/New_York' },
    featureFlags: {},
    permissions: perms[roles.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
  return { useOrganization: () => value };
});
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: { id: 'admin-fairness' } }),
}));
vi.mock('../frontend/src/hooks/useTeamSummary.js', () => ({
  useTeamSummary: () => TEAM_READ.value,
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
vi.mock('../frontend/src/hooks/useAutoScheduler.js', () => ({
  useAutoScheduler: () => AUTO.value,
}));
const AUTO_IDLE = {
  status: 'idle',
  result: null,
  progress: null,
  error: null,
  trigger: async () => {},
  cancel: () => {},
  reset: () => {},
};
vi.mock('../frontend/src/hooks/useAutoRunOnNavigate.js', () => ({
  useAutoRunOnNavigate: () => {},
}));
vi.mock('../frontend/src/hooks/useFieldClosures.js', () => ({
  useFieldClosures: () => ({ closures: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn(), info: vi.fn() },
}));
// Panels this file does not test. `EvaluationPanel` is deliberately NOT here.
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => stub('readiness'));
vi.mock('../frontend/src/components/PracticeOverridePanel.jsx', () => ({
  default: (props) => {
    OVERRIDE_PROPS.value = props;
    return <div data-testid="stub-override" />;
  },
}));

vi.mock('../frontend/src/utils/practicePersistenceClient.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  const stubbed = (name) => (request) => {
    SAVE.requests.push({ name, request });
    return SAVE.impl ? SAVE.impl(name, request) : actual[name](request);
  };
  return {
    ...actual,
    persistPracticeRepair: stubbed('persistPracticeRepair'),
    persistPracticeScheduleReview: stubbed('persistPracticeScheduleReview'),
  };
});

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { edgeFunctionCache } = await import('../frontend/src/lib/cache.js');
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

const FULL = '[2026-09-07,2026-12-01)';
function row(id, team, slot, extra = {}) {
  return {
    id,
    team_id: team,
    practice_slot_id: slot,
    slot_id: slot,
    effective_date_range: FULL,
    run_id: RUN,
    source: 'auto',
    assigned_via: 'auto',
    organization_id: ORG,
    ...extra,
  };
}

/** Team D holds no practice, so coverage is 3 of 4 and not vacuously full. */
const ROWS = [
  row('pa-a', 'team-a', 'slot-mon'),
  row('pa-b', 'team-b', 'slot-mon'),
  // Stored with `practice_slot_id` alone, as an older writer left it: the page
  // must resolve the slot the way its grid does, or the Edge refuses the request.
  row('pa-c', 'team-c', 'slot-tue', { slot_id: null }),
];

function dbOf({ roster, slots, rows, exceptions = [] }) {
  return {
    practice_exceptions: exceptions,
    scheduler_runs: [
      {
        id: RUN,
        organization_id: ORG,
        run_type: 'practice',
        status: 'completed',
        completed_at: '2026-09-01T12:00:00Z',
        season_settings_id: SEASON,
        results: {},
      },
    ],
    divisions: [{ id: 'div-now', organization_id: ORG, season_settings_id: SEASON, name: 'U10' }],
    teams: roster.map((t) => ({
      id: t.id,
      name: t.name,
      organization_id: ORG,
      division_id: 'div-now',
    })),
    fields: [{ id: 'field-1', name: 'Field 1', organization_id: ORG, location_id: 'loc-1' }],
    practice_slots: slots.map((s) => ({ ...s, organization_id: ORG })),
    practice_assignments: rows,
  };
}

/**
 * `fairness-scoring/index.ts` for a practice-only request, minus auth, rate
 * limiting and persistence: validate, refuse an empty roster, anchor, score,
 * aggregate.
 */
function fairnessScoringEdge(body) {
  const parsed = ScoringInputSchema.safeParse(body);
  if (!parsed.success) {
    return { data: null, error: { message: 'Validation failed', details: parsed.error.format() } };
  }
  const { practice } = parsed.data;
  const emptyRoster = refuseEmptyPracticeRoster(practice);
  if (emptyRoster) return { data: null, error: { message: emptyRoster.error } };
  // The handler's 3a': a half-dated slot list is a 422 (M4.7, plan Q8).
  const datedIssue = practice ? datedSlotsIssue(practice.slots) : null;
  if (datedIssue !== null) return { data: null, error: { message: datedIssue } };
  // And its exceptions gate: exceptions on an undated call are a 422.
  const exceptionsIssue = practice
    ? undatedExceptionsIssue(practice.slots, practice.exceptions)
    : null;
  if (exceptionsIssue !== null) return { data: null, error: { message: exceptionsIssue } };
  // `any`: the handler makes the same two calls; only Node's zod typings differ from Deno's.
  const anchored = anchorWallTimes(
    /** @type {any} */ (practice?.slots ?? []),
    TZ,
    'practice.slots'
  );
  if (anchored.blocking.length > 0) {
    return { data: null, error: { message: 'times could not be placed' } };
  }
  const result = practice
    ? edgeEvaluate({
        assignments: practice.assignments,
        teams: practice.teams,
        slots: /** @type {any} */ (anchored.rows),
        unassigned: practice.unassigned,
        exceptions: practice.exceptions,
      })
    : null;
  const practiceFairness = result?.summary?.fairnessScore ?? 1.0;
  return {
    data: {
      status: result?.status ?? 'ok',
      issues: result?.issues ?? [],
      practice: result,
      games: null,
      metrics: { fairnessScore: practiceFairness, combinedScore: (practiceFairness + 1.0) / 2 },
    },
    error: null,
  };
}

/** Every `fairness-scoring` request body the page sent, in order. */
/** @type {any[]} */
let scoringRequests = [];
/** What the stand-in Edge answered, so a test can tell a refusal from a score. */
/** @type {any[]} */
let scoringResponses = [];
/** Set by a test to make the stand-in Edge refuse every request. */
let edgeRefuses = false;
const REFUSAL_REASON = 'practice.slots[2]: the time does not exist on the season clock';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T16:00:00Z'));
  sessionStorage.clear();
  delete (/** @type {any} */ (window).__MOCK_DB__);
  // The panel caches identical requests for 60s; a hit would hide a request.
  edgeFunctionCache.clear();
  scoringRequests = [];
  scoringResponses = [];
  edgeRefuses = false;
  AUTO.value = AUTO_IDLE;
  SAVE.impl = null;
  SAVE.requests = [];
  const realInvoke = mockSupabase.functions.invoke;
  vi.spyOn(mockSupabase.functions, 'invoke').mockImplementation(async (name, options) => {
    if (name !== 'fairness-scoring') return realInvoke(name, options);
    // A deep copy: the body is what went over the wire, not a live reference.
    const body = JSON.parse(JSON.stringify(/** @type {any} */ (options)?.body ?? null));
    scoringRequests.push(body);
    // A refusal as supabase-js reports one: a generic message, and the
    // function's own reason in the response body on `context`.
    const response = edgeRefuses
      ? {
          data: null,
          error: {
            message: 'Edge Function returned a non-2xx status code',
            context: new Response(JSON.stringify({ error: REFUSAL_REASON }), { status: 422 }),
          },
        }
      : fairnessScoringEdge(body);
    scoringResponses.push(response);
    return response;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function teamRead(teams) {
  return {
    summary: { teams },
    loading: false,
    error: null,
    status: 'completed',
    progress: 100,
    generatedAt: '2026-09-01',
  };
}

async function renderPage({ roster = ROSTER, slots = SLOTS, rows = ROWS, exceptions = [] } = {}) {
  TEAM_READ.value = teamRead(roster);
  seedMockDb(dbOf({ roster, slots, rows, exceptions }));
  return render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
}

/** The last request once the page's reads have settled and the panel has debounced. */
async function settledRequest() {
  await waitFor(
    () => {
      const last = scoringRequests.at(-1);
      expect(last?.practice?.assignments?.length ?? 0).toBeGreaterThan(0);
    },
    { timeout: 4000 }
  );
  return scoringRequests.at(-1);
}

describe('the practice page evaluates its real schedule (13.1)', () => {
  it('the seed plants a coach double-booking and an unassigned team (meta, can fail)', () => {
    // The planted conflict exists in the seed: two rows in one slot whose teams
    // share a coach through head or assistant.
    const coachesOf = (t) => [t.coach_id, ...(t.assistant_coach_ids ?? [])].filter(Boolean);
    const teamsOfCoach = ROSTER.filter((t) => coachesOf(t).includes(DOUBLE_BOOKED_COACH));
    expect(teamsOfCoach.map((t) => t.id)).toEqual(['team-a', 'team-b']);
    const slotsOf = (teamId) =>
      ROWS.filter((r) => r.team_id === teamId).map((r) => r.practice_slot_id);
    expect(slotsOf('team-a')).toEqual(slotsOf('team-b'));
    // Only an assistant link makes it, so a request without assistants misses it.
    expect(ROSTER.find((t) => t.id === 'team-b').coach_id).not.toBe(DOUBLE_BOOKED_COACH);
    // Some team holds no practice, so coverage below 100% is a real reading.
    const assigned = new Set(ROWS.map((r) => r.team_id));
    expect(ROSTER.filter((t) => !assigned.has(t.id)).length).toBeGreaterThan(0);
  });

  it('sends the page roster and slot list, not empty lists, and they pass the Edge schema', async () => {
    await renderPage();
    const body = await settledRequest();

    // Enumerated from the seed, not from what the page rendered.
    expect(body.practice.teams.map((t) => t.id).sort()).toEqual(ROSTER.map((t) => t.id).sort());
    expect(body.practice.slots.map((s) => s.id).sort()).toEqual(SLOTS.map((s) => s.id).sort());
    expect(body.practice.assignments.map((a) => `${a.teamId}@${a.slotId}`).sort()).toEqual(
      ROWS.map((r) => `${r.team_id}@${r.practice_slot_id}`).sort()
    );
    // The scheduler's team shape: assistants carried, which the conflict needs.
    expect(body.practice.teams.find((t) => t.id === 'team-b').assistantCoachIds).toEqual([
      DOUBLE_BOOKED_COACH,
    ]);
    // Slots carry instants on the season's clock, which the engine compares.
    for (const slot of body.practice.slots) {
      expect(slot.start).toMatch(/^2026-\d{2}-\d{2}T17:00:00(\.000)?-04:00$/);
      expect(slot.end).toMatch(/^2026-\d{2}-\d{2}T18:00:00(\.000)?-04:00$/);
    }
    // The Edge accepted it: a refusal would show nothing and prove nothing.
    expect(scoringResponses.at(-1).error).toBeNull();
  });

  it('the panel shows the real team count and flags the planted coach double-booking', async () => {
    await renderPage();
    await settledRequest();

    // The engine examined the roster: four teams, three placed, one conflict.
    const scored = scoringResponses.at(-1).data.practice;
    expect(scored.summary.totalTeams).toBe(ROSTER.length);
    expect(scored.summary.assignedTeams).toBe(new Set(ROWS.map((r) => r.team_id)).size);
    expect(scored.coachConflicts).toHaveLength(1);
    expect(scored.coachConflicts[0].coachIds).toEqual([DOUBLE_BOOKED_COACH]);

    // And the page says so.
    const panel = await screen.findByRole('region', { name: 'Fairness Scoring Engine' });
    await waitFor(() => expect(panel).toHaveTextContent(`Teams evaluated: ${ROSTER.length}`));
    expect(panel).toHaveTextContent(`With a practice: ${new Set(ROWS.map((r) => r.team_id)).size}`);
    expect(panel).toHaveTextContent('Coach conflicts: 1');
    expect(
      await screen.findByText(new RegExp(`Coach ${DOUBLE_BOOKED_COACH} has overlapping practices`))
    ).toBeInTheDocument();
  });

  it("a failed evaluation says so, in the function's words, with no score", async () => {
    edgeRefuses = true;
    await renderPage();
    await settledRequest();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `The evaluation failed, so nothing was checked: ${REFUSAL_REASON}`
    );
    expect(screen.queryByText(/Fairness Index/)).not.toBeInTheDocument();
  });

  it('a failure after a score clears the score, which no longer describes the schedule', async () => {
    const view = await renderPage();
    await settledRequest();
    await screen.findByText(/Fairness Index/);
    const scored = scoringRequests.length;

    // The roster changes (one team leaves), and the next evaluation fails.
    edgeRefuses = true;
    TEAM_READ.value = teamRead(ROSTER.slice(0, 3));
    view.rerender(
      <MemoryRouter>
        <PracticeSchedulingPage />
      </MemoryRouter>
    );
    // Meta: a new request really went out, for the changed roster.
    await waitFor(() => expect(scoringRequests.length).toBeGreaterThan(scored), {
      timeout: 4000,
    });
    expect(scoringRequests.at(-1).practice.teams).toHaveLength(3);

    expect(await screen.findByRole('alert')).toHaveTextContent('The evaluation failed');
    expect(screen.queryByText(/Fairness Index/)).not.toBeInTheDocument();
  });

  it('with no teams, says there is nothing to evaluate and never calls fairness-scoring', async () => {
    await renderPage({ roster: [], rows: [] });

    expect(
      await screen.findByText(`Nothing to evaluate: 0 teams / ${SLOTS.length} slots`)
    ).toBeInTheDocument();
    // Past the panel's 800 ms debounce, with time to spare: still no request.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(scoringRequests).toHaveLength(0);
    expect(screen.queryByText(/Fairness Index/)).not.toBeInTheDocument();
  });

  it('with teams but no practice slots, says so and never calls fairness-scoring', async () => {
    await renderPage({ slots: [], rows: [] });

    expect(
      await screen.findByText(`Nothing to evaluate: ${ROSTER.length} teams / 0 slots`)
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(scoringRequests).toHaveLength(0);
    expect(screen.queryByText(/Fairness Index/)).not.toBeInTheDocument();
  });
});

// ---- M4.7: the page scores dated occurrences (docs/PLAN_SCORING_DATE_MODEL.md §3.5) ----

/** `valid_from` 2026-09-07 is a Monday: each seeded slot's first occurrence. */
const FIRST_DATE = {
  'slot-mon': '2026-09-07',
  'slot-tue': '2026-09-08',
  'slot-wed': '2026-09-09',
  'slot-thu': '2026-09-10',
  'slot-fri': '2026-09-11',
};

describe('the practice page sends its dates and is scored dated (M4.7)', () => {
  it('every slot carries its dating, every row its stored range, and the Edge runs dated', async () => {
    await renderPage();
    const body = await settledRequest();

    // Enumerated from the seed: one entry per seeded slot and row.
    expect(Object.keys(FIRST_DATE).sort()).toEqual(SLOTS.map((s) => s.id).sort());
    expect(body.practice.slots).toHaveLength(SLOTS.length);
    for (const seeded of SLOTS) {
      const sent = body.practice.slots.find((s) => s.id === seeded.id);
      expect(sent, seeded.id).toMatchObject({
        firstDate: FIRST_DATE[seeded.id],
        lastDate: seeded.valid_until,
        startTime: seeded.start_time,
        endTime: seeded.end_time,
      });
    }
    expect(body.practice.assignments).toHaveLength(ROWS.length);
    for (const seeded of ROWS) {
      const sent = body.practice.assignments.find((a) => a.teamId === seeded.team_id);
      expect(sent.effectiveDateRange, seeded.id).toBe(seeded.effective_date_range);
    }
    // P5's witness: a page that stopped sending the dates would read 'undated' here.
    expect(scoringResponses.at(-1).data.practice.summary.dateModel).toBe('dated');
  });

  it('a closed series and its successor sharing a coach are not a conflict', async () => {
    // W2's shape on the page: team A's Monday series ends 10-04 and team B's
    // starts 10-05; they share coach-dup and never meet.
    const rows = [
      row('pa-a', 'team-a', 'slot-mon', { effective_date_range: '[2026-09-07,2026-10-05)' }),
      row('pa-b', 'team-b', 'slot-mon', { effective_date_range: '[2026-10-05,2026-12-01)' }),
      row('pa-c', 'team-c', 'slot-tue', { slot_id: null }),
    ];
    await renderPage({ rows });
    await settledRequest();

    const scored = scoringResponses.at(-1).data.practice;
    expect(scored.summary.dateModel).toBe('dated');
    // Meta: both rows were scored (so "no conflict" is not "nothing read").
    expect(scored.summary.assignedTeams).toBe(3);
    expect(scored.coachConflicts).toEqual([]);
    const panel = await screen.findByRole('region', { name: 'Fairness Scoring Engine' });
    await waitFor(() => expect(panel).toHaveTextContent('Coach conflicts: 0'));

    // The override panel's count (Q5): from today (2026-10-20) on, team A's
    // series has ended, so slot-mon holds one team, not two.
    fireEvent.click(screen.getByRole('button', { name: /Enter Manual Override/ }));
    await waitFor(() => expect(OVERRIDE_PROPS.value?.baseSlots?.length).toBe(SLOTS.length));
    const mon = OVERRIDE_PROPS.value.baseSlots.find((b) => b.baseSlotId === 'slot-mon');
    expect(mon.totalAssigned).toBe(1);
    expect(rows.filter((r) => r.practice_slot_id === 'slot-mon')).toHaveLength(2);
  });

  it('the planted conflict names its first date', async () => {
    await renderPage();
    await settledRequest();
    const [conflict] = scoringResponses.at(-1).data.practice.coachConflicts;
    expect(conflict.firstDate).toBe('2026-09-07');
    expect(
      await screen.findByText(
        /Coach coach-dup has overlapping practices on Monday, from 2026-09-07/
      )
    ).toBeInTheDocument();
  });

  it("the auto-scheduler review sends a staged placement's range from today", async () => {
    // The run completes after the page has its slots, as a real run does (the
    // scheduler is only enabled once they are read).
    const view = await renderPage();
    await settledRequest();
    AUTO.value = {
      ...AUTO_IDLE,
      status: 'completed',
      result: {
        runId: 'run-review',
        assignments: [{ teamId: 'team-d', slotId: 'slot-wed', source: 'auto' }],
        unassigned: [],
      },
    };
    view.rerender(
      <MemoryRouter>
        <PracticeSchedulingPage />
      </MemoryRouter>
    );

    await waitFor(
      () => {
        const last = scoringRequests.at(-1);
        expect(last?.practice?.assignments?.some((a) => a.teamId === 'team-d')).toBe(true);
      },
      { timeout: 4000 }
    );
    const staged = scoringRequests.at(-1).practice.assignments.find((a) => a.teamId === 'team-d');
    // The page's `newPlacementRange`: today on the season's clock (the fake
    // clock is 2026-10-20 12:00 in New York) to the slot's validity end.
    expect(staged.effectiveDateRange).toBe('[2026-10-20,2026-11-30]');
    expect(scoringResponses.at(-1).data.practice.summary.dateModel).toBe('dated');
  });
});

// ---- The M4.7 follow-up: saved practice exceptions (plan Q1) --------------
//
// The page reads the season's live exceptions and sends them with each stored
// row's id; the stand-in Edge applies them as `fairness-scoring` does. Every
// expected date is enumerated from the seed through core's series reader,
// never from what the engine answered.

/** A `practice_exceptions` row as the table stores it. */
function exceptionRow(id, assignmentId, teamId, window, kind, extra = {}) {
  return {
    id,
    organization_id: ORG,
    season_settings_id: SEASON,
    team_id: teamId,
    assignment_id: assignmentId,
    window,
    kind,
    practice_slot_id: null,
    tbd_reason: null,
    cause_kind: 'blackout',
    withdrawn_at: null,
    ...extra,
  };
}

const TBD_WINDOW = '[2026-09-07,2026-09-21)';
const MOVED_WINDOW = '[2026-10-05,2026-10-12)';
const EXCEPTIONS = [
  // Team B's first two Mondays are TIME TBD.
  exceptionRow('pe-tbd', 'pa-b', 'team-b', TBD_WINDOW, 'time_tbd', {
    tbd_reason: 'past-sunset',
    cause_kind: 'daylight',
  }),
  // Team A's Monday of 10-05 moves to Tuesday 10-06 at slot-tue.
  exceptionRow('pe-moved', 'pa-a', 'team-a', MOVED_WINDOW, 'relocated', {
    practice_slot_id: 'slot-tue',
  }),
  // Withdrawn: never read as live, so it changes nothing.
  exceptionRow('pe-gone', 'pa-a', 'team-a', '[2026-11-02,2026-11-09)', 'time_tbd', {
    tbd_reason: 'contended',
    withdrawn_at: '2026-10-01T00:00:00Z',
  }),
];

/** Mondays of a range, by core's series reader (the seed's truth, not the engine's). */
/** @type {(range: string) => string[]} */
const mondaysIn = (range) => practiceOccurrenceDates({ range, dayOfWeek: 'mon' }).dates;

describe('the practice page sends saved exceptions and is scored with them (M4.7 follow-up)', () => {
  it('sends each stored row by id and the live exceptions, and the Edge applies them', async () => {
    await renderPage({ exceptions: EXCEPTIONS });
    const body = await waitFor(
      () => {
        const last = scoringRequests.at(-1);
        expect(last?.practice?.exceptions?.length ?? 0).toBeGreaterThan(0);
        return last;
      },
      { timeout: 4000 }
    );

    // Every stored row by its id, and only the live exceptions (as stored).
    expect(body.practice.assignments.map((a) => a.id).sort()).toEqual(ROWS.map((r) => r.id).sort());
    const live = EXCEPTIONS.filter((e) => e.withdrawn_at === null);
    expect(body.practice.exceptions.map((e) => e.id).sort()).toEqual(live.map((e) => e.id).sort());
    expect(body.practice.exceptions.find((e) => e.id === 'pe-moved')).toMatchObject({
      assignment_id: 'pa-a',
      window: MOVED_WINDOW,
      kind: 'relocated',
      practice_slot_id: 'slot-tue',
    });

    // The planted Monday clash loses the TIME TBD Mondays and the moved one.
    const all = mondaysIn(FULL);
    const tbd = mondaysIn(TBD_WINDOW);
    const moved = mondaysIn(MOVED_WINDOW);
    expect(tbd).toHaveLength(2);
    expect(moved).toHaveLength(1);
    const kept = all.filter((d) => !tbd.includes(d) && !moved.includes(d));
    const scored = scoringResponses.at(-1).data.practice;
    expect(scored.summary.dateModel).toBe('dated');
    expect(scored.coachConflicts).toHaveLength(1);
    expect(scored.coachConflicts[0].firstDate).toBe(kept[0]);
    expect(scored.coachConflicts[0].sharedDates).toBe(kept.length);
    // The moved Monday is held at slot-tue, beside team C, on its Tuesday.
    expect(scored.slotUtilization.find((u) => u.slotId === 'slot-tue').assignedCount).toBe(2);
    // The TIME TBD Mondays are reported, not dropped.
    expect(scored.timeTbd).toEqual([
      {
        teamId: 'team-b',
        slotId: 'slot-mon',
        exceptionId: 'pe-tbd',
        code: 'past-sunset',
        dates: tbd,
      },
    ]);
    const panel = await screen.findByRole('region', { name: 'Fairness Scoring Engine' });
    await waitFor(() =>
      expect(panel).toHaveTextContent(
        `Practice for team team-b at slot slot-mon is TIME TBD on 2 date(s) from ${tbd[0]} (past-sunset)`
      )
    );
  });

  it('with no exceptions sent, the planted clash keeps every Monday (control)', async () => {
    await renderPage();
    await settledRequest();
    const [conflict] = scoringResponses.at(-1).data.practice.coachConflicts;
    expect(conflict.sharedDates).toBe(mondaysIn(FULL).length);
    expect(scoringResponses.at(-1).data.practice.timeTbd).toEqual([]);
  });

  it('an exceptions read that fails withholds the evaluation and says why', async () => {
    const realFrom = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) => {
      if (table !== 'practice_exceptions') return realFrom(table);
      /** @type {any} */
      const failing = new Proxy(
        {},
        {
          get: (_target, prop) =>
            prop === 'then'
              ? (resolve) => resolve({ data: null, error: { message: 'permission denied' } })
              : () => failing,
        }
      );
      return failing;
    });
    await renderPage({ exceptions: EXCEPTIONS });

    expect(
      await screen.findByText(
        /saved practice changes \(moved and TIME TBD practices\) could not be read, so the schedule is not evaluated \(permission denied\)/
      )
    ).toBeInTheDocument();
    // Past the panel's debounce: nothing was scored as if there were none.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(scoringRequests).toEqual([]);
  });
});
