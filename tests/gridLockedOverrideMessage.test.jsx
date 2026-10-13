/**
 * The scheduling grid's Apply, refused by writer v3's lock, says so in words.
 *
 * Operator ruling 2 locks every saved practice row. The grid asks before it
 * replaces one (the override prompt, `gridOverridePrompt.test.jsx`), but the
 * writer can still refuse an ordinary save with 22023 "assignment <id> is
 * locked: ..." when the saved schedule holds a row the page's read did not.
 * The page used to show that text as it came, naming the row only by its
 * UUID. Here the staged team (Wrens) has no saved practice, so the page asks
 * nothing and sends an ordinary save, which the writer refuses.
 *
 * Driven through the real path, as `gridCurrentPracticeRows.test.jsx` is: the
 * real page -> the real practice reads -> the real mock client -> the real
 * grid list -> the real Apply -> the real `persistPracticeScheduleReview` ->
 * `fetch`. `fetch` is the persistence boundary, and it answers as the
 * `practice-persistence` Edge does for an ordinary save: a 500 carrying the
 * RPC's message and no code (`_shared/practice-repair-errors.ts`). The writer
 * text is taken from the migration source, not retyped, so a change to it
 * fails here.
 *
 * Every expected name, weekday, time and date comes from the SEED.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-plock';
const SEASON = 'season-plock';
const RUN1 = '00000000-0000-4000-8000-000000000021';
// Real row ids are UUIDs: the writer's message carries one.
const A_ROW = '00000000-0000-4000-8000-0000000000a1';
const B_ROW = '00000000-0000-4000-8000-0000000000b1';
const UNKNOWN_ROW = '00000000-0000-4000-8000-0000000000ff';

const ROSTER = vi.hoisted(() => [
  { id: 'team-a', name: 'Synthetic Hawks', division: 'U10' },
  { id: 'team-b', name: 'Synthetic Owls', division: 'U10' },
  // No saved practice: staging it replaces nothing, so no prompt opens.
  { id: 'team-d', name: 'Synthetic Wrens', division: 'U10' },
]);

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', async () => {
  const { ROLE_PERMISSIONS: perms, ROLES: roles } =
    await import('../frontend/src/constants/permissions.js');
  const value = {
    currentOrganization: { id: 'org-plock', name: 'Synthetic FC' },
    currentSeasonSetting: { id: 'season-plock', timezone: 'America/New_York' },
    featureFlags: {},
    permissions: perms[roles.ADMIN],
    loading: false,
    seasonSettingsLoading: false,
  };
  return { useOrganization: () => value };
});
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ session: null, user: { id: 'admin-plock' } }),
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
// The override panel is stubbed: it stages one fixed (team, slot) through the
// page's own handler. The grid list is the real one.
vi.mock('../frontend/src/components/PracticeOverridePanel.jsx', () => ({
  default: ({ onStageAssignment }) => (
    <button type="button" onClick={() => onStageAssignment('team-d', 'slot-fri')}>
      Stage Wrens
    </button>
  ),
}));
const stub = (name) => ({ default: () => <div data-testid={`stub-${name}`} /> });
vi.mock('../frontend/src/components/PracticeReadinessPanel.jsx', () => stub('readiness'));
vi.mock('../frontend/src/components/EvaluationPanel.jsx', () => stub('evaluation'));

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { default: PracticeSchedulingPage } =
  await import('../frontend/src/pages/PracticeSchedulingPage.jsx');
const { parsePracticeLockRefusal, PRACTICE_ASSIGNMENT_LOCKED } =
  await import('../frontend/src/utils/practiceLockRefusal.js');

const SLOTS = [
  { id: 'slot-mon', day_of_week: 'monday', start_time: '17:00:00', end_time: '18:30:00' },
  { id: 'slot-tue', day_of_week: 'tuesday', start_time: '18:00:00', end_time: '19:00:00' },
  { id: 'slot-fri', day_of_week: 'friday', start_time: '17:00:00', end_time: '18:00:00' },
].map((s) => ({ ...s, capacity: 4, valid_from: '2026-09-07', valid_until: '2026-11-30' }));

const SEED_ROWS = [
  {
    id: A_ROW,
    team_id: 'team-a',
    practice_slot_id: 'slot-mon',
    slot_id: 'slot-mon',
    effective_date_range: '[2026-09-07,2026-12-01)',
    run_id: RUN1,
    source: 'auto',
    assigned_via: 'auto',
    organization_id: ORG,
  },
  {
    id: B_ROW,
    team_id: 'team-b',
    practice_slot_id: 'slot-tue',
    slot_id: 'slot-tue',
    effective_date_range: '[2026-09-07,2026-12-01)',
    run_id: RUN1,
    source: 'manual',
    assigned_via: 'manual',
    organization_id: ORG,
  },
];

// A season team the roster read does not hand the page (so `teamById` has no
// name for it), holding a saved Wednesday practice.
const OFF_ROSTER = { id: 'team-c', name: 'Synthetic Larks' };
const C_ROW = '00000000-0000-4000-8000-0000000000c1';
const WED = {
  id: 'slot-wed',
  day_of_week: 'wednesday',
  start_time: '16:00:00',
  end_time: '17:00:00',
  capacity: 4,
  valid_from: '2026-09-07',
  valid_until: '2026-11-30',
};

function seed({ offRoster = false } = {}) {
  const teams = offRoster ? [...ROSTER, OFF_ROSTER] : ROSTER;
  const slots = offRoster ? [...SLOTS, WED] : SLOTS;
  const rows = offRoster
    ? [
        ...SEED_ROWS,
        {
          ...SEED_ROWS[0],
          id: C_ROW,
          team_id: OFF_ROSTER.id,
          practice_slot_id: WED.id,
          slot_id: WED.id,
        },
      ]
    : SEED_ROWS;
  seedMockDb({
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
    ],
    divisions: [{ id: 'div-now', organization_id: ORG, season_settings_id: SEASON, name: 'U10' }],
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      organization_id: ORG,
      division_id: 'div-now',
    })),
    fields: [{ id: 'field-1', name: 'Field 1', organization_id: ORG, location_id: 'loc-1' }],
    practice_slots: slots.map((s) => ({ ...s, field_id: 'field-1', organization_id: ORG })),
    practice_assignments: rows,
  });
}

// The writer's lock refusals, from the CURRENT writer: the latest migration
// that (re)defines `persist_practice_schedule`, found, never named here.
const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../supabase/migrations'
);
const WRITER_FILE = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .filter((name) =>
    /CREATE OR REPLACE FUNCTION public\.persist_practice_schedule\s*\(/.test(
      fs.readFileSync(path.join(MIGRATIONS, name), 'utf8')
    )
  )
  .at(-1);
const WRITER = fs.readFileSync(path.join(MIGRATIONS, String(WRITER_FILE)), 'utf8');
const LOCK_FORMATS = [...WRITER.matchAll(/RAISE EXCEPTION '(assignment % is locked:[^']*)'/g)].map(
  (m) => m[1]
);
// The writer's prune reasons (`v_locked_why`), from the same source.
const PRUNE_WHY = {
  replaced: 'the payload no longer carries its (team, slot, range) key',
  absent: 'it is an auto row of a season team absent from the payload',
};
/**
 * The writer's message for `id`, as RAISE renders its format: each `%` takes
 * the next argument, in order. A `%` with no argument left stays a `%`, so an
 * unfilled placeholder shows up (the meta test asserts none does).
 */
const writerLockMessage = (format, id, why = PRUNE_WHY.replaced) => {
  const args = [id, why];
  let i = 0;
  return format.replace(/%/g, () => String(args[i++] ?? '%'));
};

/** What the fetch boundary answers with, per test. */
let answer = { status: 200, body: {} };
/** @type {any[]} */
let sent = [];

beforeEach(() => {
  sessionStorage.clear();
  sent = [];
  vi.spyOn(mockSupabase.auth, 'getSession').mockResolvedValue(
    /** @type {any} */ ({ data: { session: { access_token: 'token-plock' } }, error: null })
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
});

/** Stage Synthetic Wrens onto Friday, Apply, and return the alert the page shows. */
async function overrideAndApply(seedOptions = {}) {
  seed(seedOptions);
  render(
    <MemoryRouter>
      <PracticeSchedulingPage />
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.getAllByText('Synthetic Hawks').length).toBeGreaterThan(0));
  fireEvent.click(await screen.findByRole('button', { name: /enter manual override/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stage Wrens' }));
  const apply = await screen.findByRole('button', { name: /apply schedule/i });
  await waitFor(() => expect(apply).toBeEnabled());
  fireEvent.click(apply);
  await waitFor(() => expect(sent).toHaveLength(1));
  // Nothing staged replaces a saved row: no prompt, an ordinary save.
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(sent[0].repair).toBeUndefined();
  return screen.findByRole('alert');
}

const UNSUPPORTED = 'Reload the page to read the current schedule, then Apply again.';

describe("the grid's Apply, refused because a saved practice is locked", () => {
  it('the writer has the lock refusals this file renders (meta, can fail)', () => {
    // The current writer is a real file, and it is not an older one.
    expect(WRITER_FILE).toMatch(/^\d{14}_.+\.sql$/);
    expect(String(WRITER_FILE) >= '20261002000000').toBe(true);
    // Both lock sites: the prune and the same-weekday overlap.
    expect(LOCK_FORMATS).toHaveLength(2);
    // Placeholders per site, as RAISE counts them: the prune passes id and
    // reason, the overlap passes id. No `%%` literal to unescape.
    expect(LOCK_FORMATS.map((format) => format.split('%').length - 1)).toEqual([2, 1]);
    for (const format of LOCK_FORMATS) {
      expect(format).not.toContain('%%');
      // Every placeholder is filled: nothing of the format's `%` is left.
      expect(writerLockMessage(format, A_ROW)).not.toContain('%');
    }
    for (const format of LOCK_FORMATS) {
      expect(parsePracticeLockRefusal({ message: writerLockMessage(format, A_ROW) })).toEqual(
        expect.objectContaining({ assignmentId: A_ROW })
      );
    }
    // The prune reasons this file sends are the writer's own.
    for (const why of Object.values(PRUNE_WHY)) expect(WRITER).toContain(`'${why}'`);
  });

  const HAWKS = "Synthetic Hawks's practice (Monday 17:00–18:30, 2026-09-07 to 2026-11-30)";
  for (const [i, label, cause] of [
    [0, 'prune', 'this save would replace it'],
    [1, 'overlap', 'a new practice for the team overlaps it'],
  ]) {
    it(`names the team, its series and the cause, never the id (${label} refusal)`, async () => {
      answer = {
        status: 500,
        body: { status: 'error', message: writerLockMessage(LOCK_FORMATS[i], A_ROW) },
      };
      const alert = await overrideAndApply();
      // From the seed: Hawks' saved row is slot-mon, 17:00-18:30, [2026-09-07,2026-12-01).
      expect(alert.textContent).toBe(
        `${HAWKS} is locked, and ${cause}, so nothing was saved. ${UNSUPPORTED}`
      );
      expect(alert.textContent).not.toContain(A_ROW);
    });
  }

  it('a team the roster read does not name is named from the grid row, never by id', async () => {
    answer = {
      status: 500,
      body: {
        status: 'error',
        message: writerLockMessage(LOCK_FORMATS[0], C_ROW, PRUNE_WHY.absent),
      },
    };
    const alert = await overrideAndApply({ offRoster: true });
    expect(alert.textContent).toBe(
      "Synthetic Larks's practice (Wednesday 16:00–17:00, 2026-09-07 to 2026-11-30) is locked, " +
        `and this save leaves it out, so nothing was saved. ${UNSUPPORTED}`
    );
    expect(alert.textContent).not.toContain(C_ROW);
    expect(alert.textContent).not.toContain(OFF_ROSTER.id);
  });

  it('resolves the row the writer named, not the team being staged', async () => {
    // The writer names Owls' row: the page reports Owls, from its own rows.
    answer = {
      status: 500,
      body: { status: 'error', message: writerLockMessage(LOCK_FORMATS[0], B_ROW) },
    };
    const alert = await overrideAndApply();
    expect(alert).toHaveTextContent(
      `Synthetic Owls's practice (Tuesday 18:00–19:00, 2026-09-07 to 2026-11-30) is locked`
    );
  });

  it('an id the page cannot resolve gets an honest generic message, without the UUID', async () => {
    answer = {
      status: 500,
      body: { status: 'error', message: writerLockMessage(LOCK_FORMATS[0], UNKNOWN_ROW) },
    };
    const alert = await overrideAndApply();
    expect(alert.textContent).toBe(
      'A saved practice in this schedule is locked, and this save would replace it, so nothing ' +
        `was saved. ${UNSUPPORTED}`
    );
    expect(alert.textContent).not.toContain(UNKNOWN_ROW);
  });

  it('an unrelated refusal is passed through unchanged', async () => {
    const message = 'Access denied: only an organization admin can replace a practice schedule';
    answer = { status: 403, body: { status: 'error', message } };
    const alert = await overrideAndApply();
    expect(alert.textContent).toBe(message);
  });

  it('another 22023 refusal from the writer is passed through unchanged', async () => {
    const message = `exceptions names assignment ${A_ROW}, which this save removes`;
    answer = { status: 500, body: { status: 'error', message } };
    const alert = await overrideAndApply();
    expect(alert.textContent).toBe(message);
  });
});

describe('parsePracticeLockRefusal', () => {
  const message = () => writerLockMessage(LOCK_FORMATS[0], A_ROW);

  it("a repair save's 409 reaches the page with its code (the client keeps it)", async () => {
    const { persistPracticeRepair } =
      await import('../frontend/src/utils/practicePersistenceClient.js');
    answer = {
      status: 409,
      body: { status: 'error', code: PRACTICE_ASSIGNMENT_LOCKED, message: message() },
    };
    const err = await persistPracticeRepair({
      assignments: [],
      slots: [],
      runId: undefined,
      baseFingerprint: undefined,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(PRACTICE_ASSIGNMENT_LOCKED);
    expect(err.status).toBe(409);
    expect(parsePracticeLockRefusal(err)).toEqual(FOUND);
  });

  const FOUND = { assignmentId: A_ROW, cause: PRUNE_WHY.replaced };

  it("reads the Edge's repair-save 409 code, the raw SQLSTATE and the ordinary 500", () => {
    expect(
      parsePracticeLockRefusal({ code: PRACTICE_ASSIGNMENT_LOCKED, message: message() })
    ).toEqual(FOUND);
    expect(parsePracticeLockRefusal({ code: '22023', message: message() })).toEqual(FOUND);
    expect(parsePracticeLockRefusal({ code: null, status: 500, message: message() })).toEqual(
      FOUND
    );
    // The code is certain even when the text names no row.
    expect(parsePracticeLockRefusal({ code: PRACTICE_ASSIGNMENT_LOCKED, message: '' })).toEqual({
      assignmentId: null,
      cause: null,
    });
  });

  it('is not fooled by another code or status, or a message that only mentions a lock', () => {
    expect(parsePracticeLockRefusal({ code: '42501', message: message() })).toBeNull();
    expect(parsePracticeLockRefusal({ code: null, status: 403, message: message() })).toBeNull();
    expect(parsePracticeLockRefusal({ code: null, status: 422, message: message() })).toBeNull();
    expect(
      parsePracticeLockRefusal({ code: '22023', message: 'every unlock entry needs a reason' })
    ).toBeNull();
    expect(
      parsePracticeLockRefusal({ message: `note: assignment ${A_ROW} is locked: x` })
    ).toBeNull();
    expect(parsePracticeLockRefusal(new Error('Practice persistence failed: 500'))).toBeNull();
    expect(parsePracticeLockRefusal(null)).toBeNull();
  });
});
