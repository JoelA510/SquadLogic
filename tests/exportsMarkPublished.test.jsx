/**
 * PR 3 task C5 of the schedule expansion (docs/changes/2026-11-03-schedule-expansion.md, 3.1 and 3.6; owner decision 3):
 * the Exports panel's upload gets one checkbox, "Mark these games Published", ON by default. The baseline stays the
 * evidence of what went out (it is unchanged by this); the checkbox links the act to the working-state guard, so the
 * games that were told to families are held where they are.
 *
 * What is held: the bulk call carries EXACTLY the games in the uploaded files (not every game the panel was handed:
 * an untimed game and a game of a team the files do not hold are not in them), once the files are in storage and the
 * baseline is recorded; an unticked box makes no call; a failed upload marks nothing; a refusal is said in the
 * database's words and does not pretend the games are Published.
 *
 * Harnessed like tests/exportsStorageUpload.test.jsx: the real panel, a storage double, the mock client for the baseline
 * and the Published RPC (its arm is held to the SQL by tests/mockGamePublished.test.js).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OutputGenerationPanel from '../frontend/src/components/OutputGenerationPanel.jsx';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

vi.mock('../frontend/src/config.js', async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  IS_MOCK_MODE: false,
}));
vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const mock = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mock.mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));
vi.mock('../frontend/src/contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'mock-admin-id' } }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
}));

const ORG = MOCK_ORG_ID;
const TEAMS = [
  { id: 't-1', name: 'Synthetic Comets', division: 'U10' },
  { id: 't-2', name: 'Synthetic Rockets', division: 'U10' },
  { id: 't-3', name: 'Synthetic Meteors', division: 'U10' },
];
const game = (id, home, away, extra = {}) => ({
  id,
  homeTeamId: home,
  awayTeamId: away,
  start: '2026-04-11T09:00:00Z',
  end: '2026-04-11T10:00:00Z',
  fieldId: 'pitch-1',
  slotId: `s-${id}`,
  ...extra,
});
/** Three games the files hold, and two they cannot: no time, and a team the files do not know. */
const GAMES = [
  game('ga-1', 't-1', 't-2'),
  game('ga-2', 't-1', 't-3'),
  game('ga-3', 't-2', 't-3'),
  game('ga-untimed', 't-1', 't-2', { start: null, end: null }),
  game('ga-stranger', 't-1', 't-unknown'),
];
const EXPORTED = ['ga-1', 'ga-2', 'ga-3'];

/** The saved game run the panel's games belong to: completed far in the future, so it is the latest of the club. */
const RUN = 'run-exports-saved';
const NEWER = 'run-exports-newer';
const savedRun = (id, completedAt, extra = {}) => ({
  id,
  organization_id: ORG,
  run_type: 'game',
  status: 'completed',
  completed_at: completedAt,
  results: {},
  ...extra,
});

const dbGame = (id, extra = {}) => ({
  id,
  run_id: RUN,
  organization_id: ORG,
  home_team_id: 't-1',
  away_team_id: 't-2',
  game_slot_id: `s-${id}`,
  slot_id: `s-${id}`,
  week_index: 1,
  start: '2026-04-11T09:00:00Z',
  end: '2026-04-11T10:00:00Z',
  published: false,
  ...extra,
});

/** @param {(path: string) => string | null} [refuse] */
function storageClient(refuse = () => null) {
  const calls = [];
  const client = {
    storage: {
      from: () => ({
        upload: async (path) => {
          calls.push(path);
          const message = refuse(path);
          return message ? { data: null, error: { message } } : { data: { path }, error: null };
        },
        remove: async (paths) => ({ data: paths.map((name) => ({ name })), error: null }),
      }),
    },
  };
  return { client, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error [MOCK] - a partial organization context is enough here.
  vi.mocked(useOrganization).mockReturnValue({ currentOrganization: { id: ORG } });
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  window.__saveMockDB__({
    ...window.__MOCK_DB__,
    scheduler_runs: [savedRun(RUN, '2999-01-01T00:00:00Z')],
    game_assignments: [
      ...GAMES.map((g) => dbGame(g.id)),
      dbGame('ga-already', { published: true, published_at: '2026-03-01T00:00:00Z' }),
    ],
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const rpcCalls = (spy) =>
  spy.mock.calls
    .filter(([name]) => name === 'admin_set_games_published')
    .map(([, params]) => params);
const published = () =>
  getMockData('game_assignments')
    .filter((g) => g.published)
    .map((g) => g.id)
    .sort();

async function generate(client, props = {}) {
  const view = render(
    <OutputGenerationPanel
      teams={TEAMS}
      gameAssignments={GAMES}
      supabaseClient={client}
      {...props}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
  await screen.findByText('Generated Files');
  return view;
}
const upload = () => fireEvent.click(screen.getByRole('button', { name: 'Upload to Storage' }));
const checkbox = () => screen.getByRole('checkbox', { name: 'Mark these games Published' });

describe('the checkbox', () => {
  it('is there after the files are generated, and is on by default', async () => {
    await generate(storageClient().client);
    expect(checkbox()).toBeChecked();
  });

  it('says how many games the files hold, which is not how many the panel was handed', async () => {
    await generate(storageClient().client);
    expect(checkbox()).toHaveAccessibleDescription(
      /3 games in these files\. Marked Published, they are held/
    );
    expect(checkbox()).toHaveAccessibleDescription(/the published baseline stays the record/);
  });

  it('is absent when the files hold no game (nothing to mark)', async () => {
    await generate(storageClient().client, {
      gameAssignments: [],
      practiceAssignments: [
        {
          teamId: 't-1',
          start: '2026-04-07T17:00:00Z',
          end: '2026-04-07T18:00:00Z',
          fieldId: 'p',
          slotId: 'ps-1',
        },
      ],
    });
    expect(
      screen.queryByRole('checkbox', { name: 'Mark these games Published' })
    ).not.toBeInTheDocument();
  });
});

describe('uploading with the box ticked', () => {
  it('marks exactly the games in the files Published, once, after the baseline', async () => {
    const { client, calls } = storageClient();
    await generate(client);
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    expect(await screen.findByText(/Uploaded 4 files to 'exports' bucket\./)).toBeInTheDocument();
    expect(calls).toHaveLength(4);

    await waitFor(() => expect(rpcCalls(rpc)).toHaveLength(1));
    const [call] = rpcCalls(rpc);
    expect([...call.p_assignment_ids].sort()).toEqual(EXPORTED);
    expect(call).toMatchObject({
      p_organization_id: ORG,
      p_published: true,
      p_reason_code: null,
      p_note: null,
      p_scope: { kind: 'selection', value: 'Exports panel' },
    });
    // The untimed game and the game of an unknown team are not in the files and are not marked.
    expect(call.p_assignment_ids).not.toContain('ga-untimed');
    expect(call.p_assignment_ids).not.toContain('ga-stranger');
    expect(published()).toEqual(['ga-1', 'ga-2', 'ga-3', 'ga-already']);

    // The baseline is the evidence and is recorded as before.
    expect(getMockData('publication_baselines')).toHaveLength(1);
    const message = await screen.findByText(/Published 3 games\./);
    expect(message.textContent).toMatch(/Recorded as published baseline v1\./);
  });

  it('says how many were already Published', async () => {
    const { client } = storageClient();
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      game_assignments: getMockData('game_assignments').map((g) =>
        g.id === 'ga-2' ? { ...g, published: true, published_at: '2026-03-01T00:00:00Z' } : g
      ),
    });
    await generate(client);
    upload();
    expect(
      await screen.findByText(/Published 2 games\. 1 was already Published\./)
    ).toBeInTheDocument();
  });

  it('carries the games of the files as they were generated, even if the page’s games change before Upload', async () => {
    const { client } = storageClient();
    const view = await generate(client);
    // A game appears in the saved schedule after the files were made: it is not in them.
    view.rerender(
      <OutputGenerationPanel
        teams={TEAMS}
        gameAssignments={[...GAMES, game('ga-late', 't-2', 't-3')]}
        supabaseClient={client}
      />
    );
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    await waitFor(() => expect(rpcCalls(rpc)).toHaveLength(1));
    expect([...rpcCalls(rpc)[0].p_assignment_ids].sort()).toEqual(EXPORTED);
  });
});

describe('uploading with the box unticked', () => {
  it('uploads and records the baseline, and makes no Published call', async () => {
    const { client } = storageClient();
    await generate(client);
    fireEvent.click(checkbox());
    expect(checkbox()).not.toBeChecked();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    expect(await screen.findByText(/Recorded as published baseline v1\./)).toBeInTheDocument();
    expect(rpcCalls(rpc)).toEqual([]);
    expect(published()).toEqual(['ga-already']);
    expect(screen.queryByText(/Published \d+ games?\./)).not.toBeInTheDocument();
  });
});

/** Another tab moved ga-1 and applied: a newer run holds the games that stayed (the same rows) and a NEW row for the moved game. */
function applyElsewhere() {
  window.__saveMockDB__({
    ...window.__MOCK_DB__,
    scheduler_runs: [...getMockData('scheduler_runs'), savedRun(NEWER, '2999-06-01T00:00:00Z')],
    game_assignments: [
      ...getMockData('game_assignments').map((g) =>
        ['ga-2', 'ga-3', 'ga-untimed', 'ga-stranger'].includes(g.id) ? { ...g, run_id: NEWER } : g
      ),
      dbGame('ga-1-moved', { run_id: NEWER, game_slot_id: 's-new', slot_id: 's-new' }),
    ],
  });
}

describe('files made before the saved schedule changed are refused (finding of the Codex review)', () => {
  it('nothing is uploaded, recorded or marked, and it says plainly to generate the files again', async () => {
    const { client, calls } = storageClient();
    await generate(client);
    applyElsewhere();
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    const message = await screen.findByText(/out of date/);
    expect(message.textContent).toMatch(/Nothing was uploaded/);
    expect(message.textContent).toMatch(/Generate the CSVs again/);
    expect(calls).toEqual([]);
    expect(rpcCalls(rpc)).toEqual([]);
    expect(getMockData('publication_baselines')).toHaveLength(0);
    // The old row is a real row of the club: it must never be marked, or the Games page could not release it.
    expect(published()).toEqual(['ga-already']);
    expect(screen.getByRole('button', { name: 'Upload to Storage' })).toBeEnabled();
  });

  it('after generating again from the current schedule the same upload goes through, with the current games', async () => {
    const { client, calls } = storageClient();
    const view = await generate(client);
    applyElsewhere();
    view.rerender(
      <OutputGenerationPanel
        teams={TEAMS}
        gameAssignments={[game('ga-1-moved', 't-1', 't-2'), GAMES[1], GAMES[2]]}
        supabaseClient={client}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
    await screen.findByText('Generated Files');
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    await waitFor(() => expect(rpcCalls(rpc)).toHaveLength(1));
    expect([...rpcCalls(rpc)[0].p_assignment_ids].sort()).toEqual(['ga-1-moved', 'ga-2', 'ga-3']);
    expect(calls.length).toBeGreaterThan(0);
    expect(published()).toEqual(['ga-1-moved', 'ga-2', 'ga-3', 'ga-already']);
  });

  it('a read that is refused is not an answer: nothing is uploaded or marked, and it says so', async () => {
    const { client, calls } = storageClient();
    await generate(client);
    const real = mockSupabase.from.bind(mockSupabase);
    const refusing = new Proxy(
      {},
      {
        get: (_t, method) => () =>
          method === 'maybeSingle'
            ? Promise.resolve({ data: null, error: { code: '42501', message: 'read refused' } })
            : refusing,
      }
    );
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) =>
      table === 'scheduler_runs' ? refusing : real(table)
    );
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    const message = await screen.findByText(/could not be read to check/);
    expect(message.textContent).toMatch(/Nothing was uploaded/);
    expect(message.textContent).toMatch(/read refused/);
    expect(message.textContent).toMatch(/untick/i);
    expect(calls).toEqual([]);
    expect(rpcCalls(rpc)).toEqual([]);
  });

  it('control: with the box unticked there is nothing to mark, so nothing is checked and the upload goes as before', async () => {
    const { client, calls } = storageClient();
    await generate(client);
    applyElsewhere();
    fireEvent.click(checkbox());
    const from = vi.spyOn(mockSupabase, 'from');
    upload();
    expect(await screen.findByText(/Recorded as published baseline v1\./)).toBeInTheDocument();
    expect(calls).toHaveLength(4);
    expect(from.mock.calls.some(([table]) => table === 'scheduler_runs')).toBe(false);
  });

  it('the check is of this season’s schedule: a later run of another season does not make the files stale', async () => {
    vi.mocked(useOrganization).mockReturnValue(
      // @ts-expect-error [MOCK] - a partial organization context is enough here.
      {
        currentOrganization: { id: ORG },
        currentSeasonSetting: { id: MOCK_SEASON_ID, status: 'active' },
      }
    );
    window.__saveMockDB__({
      ...window.__MOCK_DB__,
      scheduler_runs: [
        ...getMockData('scheduler_runs').filter((r) => r.id !== RUN),
        savedRun(RUN, '2998-01-01T00:00:00Z', { season_settings_id: MOCK_SEASON_ID }),
        savedRun('run-exports-other-season', '2999-12-01T00:00:00Z', {
          season_settings_id: 'season-y',
        }),
      ],
    });
    const { client } = storageClient();
    const wired = {
      ...client,
      from: (t) => mockSupabase.from(t),
      rpc: (...a) => mockSupabase.rpc(...a),
    };
    await generate(wired);
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    await waitFor(() => expect(rpcCalls(rpc)).toHaveLength(1));
    expect([...rpcCalls(rpc)[0].p_assignment_ids].sort()).toEqual(EXPORTED);
  });
});

describe('a lost answer to the marking is not "not marked" (finding of the Codex review)', () => {
  it('the games were marked and the answer was lost: it says it is not known, and points to the Games page', async () => {
    const { client } = storageClient();
    await generate(client);
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) => {
      const answer = await real(name, params);
      return name === 'admin_set_games_published'
        ? {
            data: null,
            error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
          }
        : answer;
    });
    upload();
    const message = await screen.findByText(
      /It is not known whether the 3 games were marked Published/
    );
    expect(message.textContent).toMatch(/Open the Game Scheduling page to see which are Published/);
    expect(message.textContent).not.toMatch(/NOT marked/);
    // This panel cannot read the saved flags again, so it does not say it does.
    expect(message.textContent).not.toMatch(/read again/);
    expect(published()).toEqual(['ga-1', 'ga-2', 'ga-3', 'ga-already']);
  });
});

describe('a completed season is history: its games are not marked (finding of the Codex review)', () => {
  const completed = () =>
    vi.mocked(useOrganization).mockReturnValue(
      // @ts-expect-error [MOCK] - a partial organization context is enough here.
      {
        currentOrganization: { id: ORG },
        currentSeasonSetting: { id: MOCK_SEASON_ID, status: 'completed' },
      }
    );
  const wire = (client) => ({
    ...client,
    from: (t) => mockSupabase.from(t),
    rpc: (...a) => mockSupabase.rpc(...a),
  });

  it('the option is there, off and disabled, and says why', async () => {
    completed();
    await generate(wire(storageClient().client));
    expect(checkbox()).not.toBeChecked();
    expect(checkbox()).toBeDisabled();
    expect(checkbox()).toHaveAccessibleDescription(/This season is completed/);
    expect(checkbox()).toHaveAccessibleDescription(/cannot be marked Published/);
  });

  it('the historical export finishes: the files go out, the baseline is recorded, and no Published call is made', async () => {
    completed();
    const { client, calls } = storageClient();
    await generate(wire(client));
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    const message = await screen.findByText(/Uploaded 4 files to 'exports' bucket\./);
    expect(message.textContent).toMatch(/Recorded as published baseline v1\./);
    expect(message.textContent).not.toMatch(/NOT marked|Game Scheduling page/);
    expect(calls).toHaveLength(4);
    expect(rpcCalls(rpc)).toEqual([]);
    expect(published()).toEqual(['ga-already']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Said as a success, not as an error.
    expect(
      message.closest('[role="status"], [role="alert"]')?.getAttribute('role') ?? 'status'
    ).not.toBe('alert');
  });

  it('control: an active season still has the option on and enabled', async () => {
    vi.mocked(useOrganization).mockReturnValue(
      // @ts-expect-error [MOCK] - a partial organization context is enough here.
      {
        currentOrganization: { id: ORG },
        currentSeasonSetting: { id: MOCK_SEASON_ID, status: 'active' },
      }
    );
    await generate(wire(storageClient().client));
    expect(checkbox()).toBeChecked();
    expect(checkbox()).toBeEnabled();
  });
});

describe('when something fails', () => {
  it('a refused upload marks nothing and records no baseline', async () => {
    const { client } = storageClient((path) => (path.includes('/teams/t-3-') ? 'refused' : null));
    await generate(client);
    const rpc = vi.spyOn(mockSupabase, 'rpc');
    upload();
    expect(await screen.findByText(/^Upload failed:/)).toBeInTheDocument();
    expect(rpcCalls(rpc)).toEqual([]);
    expect(published()).toEqual(['ga-already']);
  });

  it('a refused Published call is said in the database’s words and the games are not claimed Published', async () => {
    const { client } = storageClient();
    await generate(client);
    const real = mockSupabase.rpc.bind(mockSupabase);
    vi.spyOn(mockSupabase, 'rpc').mockImplementation(async (name, params) =>
      name === 'admin_set_games_published'
        ? {
            data: null,
            error: {
              code: '42501',
              message:
                'Access denied: only an administrator of the organization sets whether its games are Published',
              details: 'admin_required',
            },
          }
        : real(name, params)
    );
    upload();
    const message = await screen.findByText(/were NOT marked Published/);
    expect(message.textContent).toMatch(/Access denied: only an administrator/);
    expect(message.textContent).toMatch(/Uploaded 4 files to 'exports' bucket\./);
    expect(message.textContent).toMatch(/Game Scheduling page/);
    expect(message.textContent).not.toMatch(/Published 3 games\./);
    expect(published()).toEqual(['ga-already']);
  });
});
