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
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

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

const dbGame = (id, extra = {}) => ({
  id,
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
    expect(checkbox()).toHaveAccessibleDescription(/3 games in these files/);
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
