// @vitest-environment jsdom
//
// G5 (PR 6b of docs/changes/2026-11-03-schedule-expansion.md, decision 15): the games import can record the schedule
// it leaves as the publication baseline for "Changes since publication".
//
// Driven through the REAL mock client end to end: the import is staged, mapped, previewed and applied by the mock's
// games RPCs; the baseline is recorded by the mock's `admin_publish_schedule_baseline`; the Exports page that records
// the baseline it is compared with, and "Changes since publication" that reads the import's baseline back, are the
// real page over the same tables (`useDashboardData`, `generateMasterExport`, `usePublicationBaselines`). Only the
// storage upload (no bucket in the mock) and the file save are replaced. Nothing here writes a baseline or a game by
// hand: every row a reader reads was written by a writer of the app.
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  DIVISION,
  FILE_HEADERS,
  ORG,
  SAVED,
  SEASON,
  TEAMS,
  fileCsv,
  seedGameImportWorld,
} from './helpers/gameImportWorld.js';
import { seedMockDb } from './helpers/seedMockDb.js';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: '0a000000-0000-4000-8000-000000000001', name: 'Placeholder League' },
    currentSeasonSetting: {
      id: '0a000000-0000-4000-8000-000000000002',
      name: 'Fall 2026',
      status: 'active',
      season_start: '2026-09-07',
      season_end: '2027-03-31',
      timezone: 'America/Los_Angeles',
    },
  }),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: '0a000000-0000-4000-8000-000000000003' } }),
}));
vi.mock('../frontend/src/utils/scheduleDownloads.js', async (original) => ({
  ...(await original()),
  saveFile: vi.fn(),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

const { default: ScheduleImportPanel } =
  await import('../frontend/src/components/import/ScheduleImportPanel.jsx');
const { default: ExportsPage } = await import('../frontend/src/pages/ExportsPage.jsx');
const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');

// Each case drives a whole import, and two the Exports page after it.
vi.setConfig({ testTimeout: 30000 });

const RECORD = /^Record this schedule as the baseline for Changes since publication/;

/** A table of the mock, this league's rows, read through the client as the app reads it. */
async function table(name) {
  const { data, error } = await mockSupabase.from(name).select('*').eq('organization_id', ORG);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data ?? [];
}
const step = () => screen.getByTestId('schedule-import-step').textContent;
/** @param {string | RegExp} label @returns {HTMLInputElement} */
const checkbox = (label) => /** @type {HTMLInputElement} */ (screen.getByLabelText(label));
const choose = (name, value) =>
  fireEvent.change(screen.getByRole('combobox', { name: `What ${name} is` }), {
    target: { value },
  });
const upload = (csv = fileCsv(), name = 'schedule.csv') =>
  fireEvent.change(screen.getByTestId('schedule-import-file'), {
    target: { files: [new File([csv], name, { type: 'text/csv' })] },
  });

/** Upload the every-outcome file and make the choices that reach every outcome; stop on the confirm step. */
async function toConfirm() {
  upload();
  await waitFor(() => expect(step()).toMatch(/2 of 4/));
  choose('Visiting Club A (U05 Boys)', 'outside');
  choose('Field 9 (Venue A)', 'create');
  choose('U07 Girls', 'create');
  choose('U07G Team 01 (U07 Girls)', 'create');
  choose('U07G Team 02 (U07 Girls)', 'create');
  fireEvent.click(screen.getByRole('button', { name: 'Preview the import' }));
  await waitFor(() => expect(step()).toMatch(/3 of 4/));
  fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
}
async function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and import' }));
  await waitFor(() => expect(step()).toMatch(/4 of 4/));
}
/** Whether the panel shows its result step (the recording runs only there). */
const stepIsResult = () =>
  /4 of 4/.test(screen.queryByTestId('schedule-import-step')?.textContent ?? '');
/** The result's word on the baseline, once the recording has finished. */
async function baselineNotice() {
  const notice = await screen.findByTestId('schedule-import-baseline', {}, { timeout: 5000 });
  await waitFor(() => expect(screen.queryByTestId('schedule-import-busy')).toBeNull());
  return notice;
}

/**
 * The world of the characterization test's cases (tests/exportMasterRowsCharacterization.test.jsx), reached through the
 * import: own team v own team, own team v an outside club (row 5), a TIME TBD game with a date (rows 8 and 9), a TIME
 * TBD game without one (left by the scheduler, below), and a game cancelled before the import (gone from the saved
 * schedule). A team run names the coach of one team, so the run's teams reach the export too.
 */
async function seedWorld() {
  seedGameImportWorld();
  // Appended to the world (the helper's own append-only seeder): the scheduler's TIME TBD game and a team run.
  seedMockDb({
    schedule_tbd: [
      {
        id: '0a000000-0000-4000-8000-000000000090',
        organization_id: ORG,
        season_settings_id: SEASON,
        division_id: DIVISION,
        kind: 'game',
        home_team_id: TEAMS.t5,
        away_team_id: TEAMS.t6,
        week_index: 8,
        reason: 'no-slot-available',
      },
    ],
    scheduler_runs: [
      {
        id: '0a000000-0000-4000-8000-000000000031',
        organization_id: ORG,
        run_type: 'team',
        status: 'completed',
        season_settings_id: SEASON,
        completed_at: '2026-08-20T12:00:00Z',
        created_at: '2026-08-20T12:00:00Z',
        results: {
          teamsByDivision: {
            'U05 Boys': [
              {
                id: TEAMS.t1,
                name: 'U05B Team 01',
                coachName: 'Placeholder Coach',
                coachEmail: 'coach@example.test',
              },
            ],
          },
        },
      },
    ],
  });
  delete window.__MOCK_DB__;
  const cancelled = await mockSupabase.rpc('admin_cancel_game_assignment', {
    p_assignment_id: SAVED.untouched,
  });
  expect(cancelled.error).toBeNull();
}

/** The Exports page, as the app mounts it. */
function renderExports() {
  return render(
    <MemoryRouter>
      <ExportsPage />
    </MemoryRouter>
  );
}

beforeEach(async () => {
  await seedWorld();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('(1) the baseline recorded at import is the Exports page’s baseline for the same schedule, row for row', () => {
  it('records at import, then the Exports page records over the same schedule: the two are equal', async () => {
    const panel = render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    expect((await baselineNotice()).textContent).toMatch(/Recorded .* as published baseline v1\b/);
    panel.unmount();

    const [atImport] = await table('publication_baselines');
    expect(atImport).toMatchObject({ baseline_version: 1, channel: 'schedule import' });

    renderExports();
    const generate = await screen.findByRole('button', { name: 'Generate CSVs' });
    // `aria-disabled` while a read the files need is in flight (the button stays focusable)
    await waitFor(() => expect(generate).not.toHaveAttribute('aria-disabled'), { timeout: 5000 });
    fireEvent.click(generate);
    const status = await screen.findByTestId('output-generation-status');
    await waitFor(() => expect(status).toHaveTextContent('CSVs generated successfully.'));
    // Rows only: the imported games are Published already, and marking is the other test files'.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark these games Published' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload to Storage' }));
    await waitFor(() => expect(status).toHaveTextContent(/Recorded as published baseline v2\./));

    const fromExports = (await table('publication_baselines')).find(
      (b) => b.baseline_version === 2
    );
    expect(status).toHaveTextContent(/^Uploaded \d+ files/);
    // Row for row, and the digest of the rows with them.
    expect(atImport.export_rows).toEqual(fromExports.export_rows);
    expect(atImport.export_columns).toEqual(fromExports.export_columns);
    expect(atImport.digest).toBe(fromExports.digest);

    // Not vacuous: the cases of the characterization fixture are each in the rows.
    const rows = /** @type {Array<Record<string, string>>} */ (atImport.export_rows);
    const games = rows.filter((r) => r['Event Type'] === 'Game');
    expect(games.length).toBeGreaterThanOrEqual(20);
    // an outside club is named as the opponent, and has no rows of its own
    expect(games.some((r) => r.Opponent === 'Visiting Club A' && r.Role === 'Home')).toBe(true);
    expect(rows.some((r) => r['Team Name'] === 'Visiting Club A')).toBe(false);
    // a TIME TBD game with a date (the import's) and one without (the scheduler's)
    const tbd = games.filter((r) => r.Start === 'TIME TBD');
    expect(tbd.some((r) => /\(week \d+, on 2026-10-17\)/.test(r.Notes))).toBe(true);
    expect(tbd.some((r) => /\(week 8\):/.test(r.Notes))).toBe(true);
    // the cancelled game is in neither (its slot was the only one on 2026-09-19)
    expect(rows.some((r) => r.Start.startsWith('2026-09-19'))).toBe(false);
    // the run's own team carries its coach into the rows
    expect(rows.some((r) => r.Coaches === 'Placeholder Coach')).toBe(true);
    // the moved game is where the import put it, not where the preview found it
    expect(rows.some((r) => r.Start === '2026-09-12T17:00:00.000Z')).toBe(true);
  });
});

describe('(2) the option is ticked by default exactly when the games arrive Published, and can be changed', () => {
  it('ticked with "Games arrive Published", unticked without it, while the admin has not set it', async () => {
    render(<ScheduleImportPanel />);
    await toConfirm();
    expect(checkbox(/Games arrive Published/).checked).toBe(true);
    expect(checkbox(RECORD).checked).toBe(true);

    // The STORED mapping changes (the preview is made again): the default follows it, both ways.
    fireEvent.click(checkbox(/Games arrive Published/));
    await waitFor(() => expect(checkbox(/Games arrive Published/).checked).toBe(false));
    expect(checkbox(RECORD).checked).toBe(false);
    fireEvent.click(checkbox(/Games arrive Published/));
    await waitFor(() => expect(checkbox(/Games arrive Published/).checked).toBe(true));
    expect(checkbox(RECORD).checked).toBe(true);
  });

  it('once the admin unticks it, a later stored mapping leaves it unticked, and nothing is recorded', async () => {
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    render(<ScheduleImportPanel />);
    await toConfirm();
    fireEvent.click(checkbox(RECORD));
    expect(checkbox(RECORD).checked).toBe(false);
    // Published off and on again: two stored mappings, and neither resets the admin's choice
    fireEvent.click(checkbox(/Games arrive Published/));
    await waitFor(() => expect(checkbox(/Games arrive Published/).checked).toBe(false));
    expect(checkbox(RECORD).checked).toBe(false);
    fireEvent.click(checkbox(/Games arrive Published/));
    await waitFor(() => expect(checkbox(/Games arrive Published/).checked).toBe(true));
    expect(checkbox(RECORD).checked).toBe(false);
    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    await confirm();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rpc.mock.calls.some(([name]) => name === 'admin_publish_schedule_baseline')).toBe(false);
    expect(await table('publication_baselines')).toHaveLength(0);
    expect(screen.queryByTestId('schedule-import-baseline')).toBeNull();
  });

  it('ticked by hand for games that do not arrive Published: the baseline is recorded', async () => {
    render(<ScheduleImportPanel />);
    await toConfirm();
    fireEvent.click(checkbox(/Games arrive Published/));
    await waitFor(() => expect(checkbox(/Games arrive Published/).checked).toBe(false));
    fireEvent.click(screen.getByLabelText('Create the 5 records listed above'));
    fireEvent.click(checkbox(RECORD));
    await confirm();
    expect((await baselineNotice()).textContent).toMatch(/published baseline v1\b/);
    expect(await table('publication_baselines')).toHaveLength(1);
  });
});

describe('(3) unticked, nothing is recorded', () => {
  it('applies the import and records no baseline, and says nothing about one', async () => {
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    render(<ScheduleImportPanel />);
    await toConfirm();
    fireEvent.click(checkbox(RECORD));
    await confirm();
    expect(screen.getByTestId('schedule-import-applied').textContent).toMatch(/Imported: 7 games/);
    // the CONTROL of (1): what records it is the option, not the apply
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await table('publication_baselines')).toHaveLength(0);
    expect(rpc.mock.calls.some(([name]) => name === 'admin_publish_schedule_baseline')).toBe(false);
    expect(screen.queryByTestId('schedule-import-baseline')).toBeNull();
  });
});

describe('(4) a recording that fails is said, and the import still shows as applied', () => {
  it('the store refuses the baseline: the result says so in words, and the import stands', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation((name, params) =>
      name === 'admin_publish_schedule_baseline'
        ? Promise.resolve({ data: null, error: { code: '42501', message: 'baseline refused' } })
        : real(name, params)
    );
    render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    const notice = await baselineNotice();
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toMatch(
      /The import is applied, but no publication baseline was recorded: baseline refused\./
    );
    // the import is not rolled back for a failed baseline: it is applied, and offered for roll back as any import is
    expect(screen.getByTestId('schedule-import-applied').textContent).toMatch(
      /Imported: 7 games added, 1 changed, 2 TIME TBD games added\./
    );
    expect(step()).toMatch(/the import is applied/);
    expect(screen.getByRole('button', { name: 'Roll back this import' })).toBeEnabled();
    expect(await table('game_assignments')).toHaveLength(9);
    // a clear miss: the write was refused and the check found no baseline, so "not recorded" is said, with the retry
    expect(await table('publication_baselines')).toHaveLength(0);
    expect(within(notice).getByRole('button', { name: 'Record the baseline again' })).toBeEnabled();
  });

  it('C2: the write committed and its answer was lost: the check finds it, and it is said as recorded', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
      if (name !== 'admin_publish_schedule_baseline') return real(name, params);
      await real(name, params); // the database did it...
      return { data: null, error: { message: 'Failed to fetch' } }; // ...and the answer never arrived
    });
    render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    const notice = await baselineNotice();
    expect(notice.textContent).toMatch(/as published baseline v1, for "Changes since publication"/);
    expect(within(notice).queryByRole('button', { name: 'Record the baseline again' })).toBeNull();
    expect(await table('publication_baselines')).toHaveLength(1);
  });

  it('C2: the answer was lost and the check cannot be made: the outcome is unknown, never "none", with where to look', async () => {
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation((name, params) =>
      name === 'admin_publish_schedule_baseline'
        ? Promise.resolve({ data: null, error: { message: 'Failed to fetch' } })
        : real(name, params)
    );
    render(<ScheduleImportPanel />);
    await toConfirm();
    const from = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((name) => {
      if (name === 'publication_baselines') throw new Error('baselines unreadable');
      return from(name);
    });
    await confirm();
    const notice = await baselineNotice();
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toMatch(
      /it is not known whether its publication baseline was recorded: the recording got no clear answer \(Failed to fetch\) and the check for its baseline failed \(baselines unreadable\)/
    );
    expect(notice.textContent).toMatch(
      /"Changes since publication" on the Exports page lists every baseline/
    );
    expect(notice.textContent).not.toMatch(/no publication baseline was recorded/);
    expect(within(notice).getByRole('button', { name: 'Record the baseline again' })).toBeEnabled();
  });

  it('the saved schedule cannot be read for the rows: said, naming what, and nothing is recorded', async () => {
    render(<ScheduleImportPanel />);
    await toConfirm();
    const from = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((name) => {
      if (name === 'teams') throw new Error('teams are unreadable');
      return from(name);
    });
    await confirm();
    const notice = await baselineNotice();
    expect(notice.textContent).toMatch(
      /no publication baseline was recorded: the season's teams could not be read \(teams: teams are unreadable\)/
    );
    expect(screen.getByTestId('schedule-import-applied')).toBeInTheDocument();
    expect(await table('publication_baselines')).toHaveLength(0);
  });
});

describe('C1: the whole recording is bounded, and a recording that timed out can be made again', () => {
  afterEach(() => vi.useRealTimers());

  it('the write gets no answer within a minute: unknown, said; "Record the baseline again" checks, then records', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const real = mockSupabase.rpc.bind(mockSupabase);
    let writes = 0;
    vi.spyOn(mockSupabase, 'rpc').mockImplementation((name, params) => {
      if (name !== 'admin_publish_schedule_baseline') return real(name, params);
      writes += 1;
      // the first write hangs (it never reached the database); the second is the database's
      return writes === 1 ? new Promise(() => {}) : real(name, params);
    });
    render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    await waitFor(() => expect(writes).toBe(1));
    expect(screen.getByTestId('schedule-import-busy')).toBeInTheDocument();
    vi.advanceTimersByTime(60000);
    const notice = await baselineNotice();
    expect(notice.textContent).toMatch(
      /not known whether its publication baseline was recorded: the recording sent its baseline and no answer came within a minute/
    );
    expect(screen.getByRole('button', { name: 'Roll back this import' })).toBeEnabled();

    fireEvent.click(within(notice).getByRole('button', { name: 'Record the baseline again' }));
    await waitFor(() =>
      expect(screen.getByTestId('schedule-import-baseline').textContent).toMatch(
        /as published baseline v1, for/
      )
    );
    expect(writes).toBe(2);
    expect(await table('publication_baselines')).toHaveLength(1);
  });

  it('the write committed but its answer never came: the retry finds it first and writes nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const real = mockSupabase.rpc.bind(mockSupabase);
    let writes = 0;
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
      if (name !== 'admin_publish_schedule_baseline') return real(name, params);
      writes += 1;
      await real(name, params);
      return new Promise(() => {}); // the database did it; the answer is lost on the way back
    });
    render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    await waitFor(() => expect(writes).toBe(1));
    vi.advanceTimersByTime(60000);
    const notice = await baselineNotice();
    expect(notice.textContent).toMatch(/not known whether its publication baseline was recorded/);
    fireEvent.click(within(notice).getByRole('button', { name: 'Record the baseline again' }));
    await waitFor(() =>
      expect(screen.getByTestId('schedule-import-baseline').textContent).toMatch(
        /as published baseline v1, for/
      )
    );
    // found by its snapshot id: no second write was sent
    expect(writes).toBe(1);
    expect(await table('publication_baselines')).toHaveLength(1);
  });

  it('the reads stall past a minute (a slow league): not recorded, no write after the screen said so, and the retry records', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const real = mockSupabase.rpc.bind(mockSupabase);
    /** @type {() => void} */
    let release = () => {};
    let held = false;
    const publish = vi.fn();
    vi.spyOn(mockSupabase, 'rpc').mockImplementation((name, params) => {
      if (name === 'admin_publish_schedule_baseline') publish();
      // the TIME TBD list's first read after the apply is slow: it answers only when released
      if (
        name === 'get_schedule_tbd' &&
        !held &&
        publish.mock.calls.length === 0 &&
        stepIsResult()
      ) {
        held = true;
        return new Promise((resolve) => {
          release = () => resolve(real(name, params));
        });
      }
      return real(name, params);
    });
    render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    await waitFor(() => expect(held).toBe(true));
    vi.advanceTimersByTime(60000);
    const notice = await baselineNotice();
    expect(notice.textContent).toMatch(
      /no publication baseline was recorded: the saved schedule was still being read or made into rows after a minute \(nothing was written\)/
    );
    // the slow read answers after all: the recording that was given up writes nothing
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(publish).not.toHaveBeenCalled();
    expect(await table('publication_baselines')).toHaveLength(0);

    fireEvent.click(within(notice).getByRole('button', { name: 'Record the baseline again' }));
    await waitFor(() =>
      expect(screen.getByTestId('schedule-import-baseline').textContent).toMatch(
        /as published baseline v1, for/
      )
    );
    expect(await table('publication_baselines')).toHaveLength(1);
  });
});

describe('(5) a roll back does not silently leave a baseline that describes games that are gone', () => {
  const ROLLED_NOTE =
    /Published baseline v1, recorded from this import, still describes the imported schedule/;

  it('rolled back from the result: the baseline stays (it is never changed), and the result says what it describes', async () => {
    render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    await baselineNotice();
    // From here, every read of the baselines table, with the filters it is given.
    const reads = /** @type {Array<Array<[string, any]>>} */ ([]);
    const from = mockSupabase.from.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'from').mockImplementation((name) => {
      const builder = from(name);
      if (name !== 'publication_baselines') return builder;
      const filters = /** @type {Array<[string, any]>} */ ([]);
      reads.push(filters);
      const wrap = (b) =>
        new Proxy(b, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (key === 'eq') {
              return (column, v) => {
                filters.push([column, v]);
                return wrap(value.call(target, column, v));
              };
            }
            return typeof value === 'function' && key === 'select'
              ? (...args) => wrap(value.apply(target, args))
              : typeof value === 'function'
                ? value.bind(target)
                : value;
          },
        });
      return wrap(builder);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Roll back this import' }));
    await screen.findByTestId('schedule-import-rolled-back');
    const note = await screen.findByTestId('schedule-import-baseline-rolled-back');
    expect(note.textContent).toMatch(ROLLED_NOTE);
    // the look-up read ONE row, by the import's snapshot id, and not the whole list
    expect(reads).toHaveLength(1);
    expect(reads[0].map(([column]) => column)).toEqual(['organization_id', 'snapshot_id']);
    expect(String(reads[0][1][1])).toMatch(/^schedule-import-/);
    vi.mocked(mockSupabase.from).mockRestore();
    expect(note.textContent).toMatch(/choose another baseline there/);
    // nothing was recorded again: the one baseline is the import's
    const baselines = await table('publication_baselines');
    expect(baselines).toHaveLength(1);
    expect(baselines[0].channel).toBe('schedule import');
  });

  it('rolled back later, from the upload step of a panel opened again: said the same way', async () => {
    const first = render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    await baselineNotice();
    first.unmount();
    render(<ScheduleImportPanel />);
    const last = await screen.findByTestId('schedule-import-last');
    fireEvent.click(within(last).getByRole('button', { name: 'Roll back the last import' }));
    await screen.findByTestId('schedule-import-rolled-back');
    expect((await screen.findByTestId('schedule-import-baseline-rolled-back')).textContent).toMatch(
      ROLLED_NOTE
    );
  });

  it('CONTROL: an import that recorded no baseline says nothing about one when it is rolled back', async () => {
    // a baseline of something else exists, so "none found" is about THIS import, not an empty table
    await mockSupabase.rpc('admin_publish_schedule_baseline', {
      p_organization_id: ORG,
      p_document: await otherBaselineDocument(),
    });
    render(<ScheduleImportPanel />);
    await toConfirm();
    fireEvent.click(checkbox(RECORD));
    await confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Roll back this import' }));
    await screen.findByTestId('schedule-import-rolled-back');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('schedule-import-baseline-rolled-back')).toBeNull();
  });
});

describe('(6) "Changes since publication", read after the import, over the baseline the import recorded', () => {
  /** Open the Changes view on the Exports page and compare with baseline `version`; return its summary line. */
  async function changesAgainst(version) {
    const page = renderExports();
    const reports = await screen.findByTestId('schedule-reports', {}, { timeout: 5000 });
    fireEvent.click(
      await within(reports).findByRole(
        'tab',
        { name: 'Changes since publication' },
        { timeout: 5000 }
      )
    );
    const select = await within(reports).findByLabelText('Compare with baseline');
    const baseline = (await table('publication_baselines')).find(
      (b) => b.baseline_version === version
    );
    fireEvent.change(select, { target: { value: baseline.id } });
    const summary = (await within(reports).findByTestId('changes-summary', {}, { timeout: 5000 }))
      .textContent;
    page.unmount();
    return summary;
  }

  it('shows no change right after the import, and a change once one game moves', async () => {
    const panel = render(<ScheduleImportPanel />);
    await toConfirm();
    await confirm();
    await baselineNotice();
    panel.unmount();

    const right = await changesAgainst(1);
    expect(right).toMatch(
      /: (\d+) games then, \1 now: \1 unchanged, 0 changed, 0 no longer saved, 0 new\./
    );
    expect(right).toMatch(/TIME TBD: 3 then, 3 now\./);
    expect(right).not.toMatch(/: 0 games then/);

    // One game moves, by the app's own writers: changes to it are allowed, then a second import moves it.
    const moved = (await table('game_assignments')).find((g) => g.external_ref === 'N-1');
    const allowed = await mockSupabase.rpc('admin_set_games_published', {
      p_organization_id: ORG,
      p_assignment_ids: [moved.id],
      p_published: false,
      p_reason_code: 'field-change',
      p_note: null,
      p_scope: { kind: 'selection', value: 'test' },
    });
    expect(allowed.error).toBeNull();
    const second = render(<ScheduleImportPanel />);
    const row = [
      'N-1',
      '2026-09-26',
      '11:00',
      '12:00',
      'Venue A',
      'Field 1',
      'U05 Boys',
      'U05B Team 01',
      'U05B Team 03',
      '3',
      '',
    ];
    upload([FILE_HEADERS.join(','), row.join(',')].join('\n'), 'move.csv');
    await waitFor(() => expect(step()).toMatch(/2 of 4/));
    fireEvent.click(screen.getByRole('button', { name: 'Preview the import' }));
    await waitFor(() => expect(step()).toMatch(/3 of 4/));
    // this import is the writer of the move only: it records no baseline of its own
    expect(checkbox(RECORD).checked).toBe(true);
    fireEvent.click(checkbox(RECORD));
    await confirm();
    expect(screen.getByTestId('schedule-import-applied').textContent).toMatch(/1 changed/);
    second.unmount();

    const after = await changesAgainst(1);
    // the moved game is one game no longer saved (at its old time) and one new (at its new time); the rest stand
    expect(after).toMatch(/0 changed, 1 no longer saved, 1 new\./);
    expect(await table('publication_baselines')).toHaveLength(1);
  });
});

/** A valid baseline document that is not an import's (the Exports page's shape), for the roll back's control. */
async function otherBaselineDocument() {
  const { makePublicationSnapshot, serialisePublicationSnapshot } =
    await import('../packages/core/src/publication/index.js');
  const { SCHEDULE_EXPORT_COLUMNS } = await import('../packages/core/src/outputGeneration.js');
  const row = Object.fromEntries(SCHEDULE_EXPORT_COLUMNS.map((c) => [c, '']));
  const { snapshot } = makePublicationSnapshot({
    snapshotId: 'master-schedule-earlier',
    label: 'Master schedule, 1 rows',
    channel: 'exports bucket',
    publishedAt: '2026-09-01T09:00:00',
    publishedBy: ADMIN,
    rows: [{ ...row, 'Team ID': TEAMS.t1, 'Event Type': 'Practice' }],
    notes: null,
  });
  return serialisePublicationSnapshot(snapshot);
}
