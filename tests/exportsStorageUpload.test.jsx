/**
 * "Upload to Storage" writes to the `exports` bucket, under the active
 * organization's folder, and says what happened to every file.
 *
 * The bucket's policies (`20261017000000_exports_bucket.sql`) accept an object
 * only under `<organization_id>/` from an administrator of that organization, and have
 * no UPDATE policy, so the panel must send org-prefixed paths without upsert.
 * The upload goes through the real panel and `uploadScheduleExport` to a
 * storage client double that records what it was asked and answers as
 * Supabase Storage does; the baseline goes to the mock Supabase client, as in
 * `outputGenerationBaselineUi.test.jsx`. Mock mode is off here: in mock mode
 * the panel never calls storage (the mock client has none).
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OutputGenerationPanel from '../frontend/src/components/OutputGenerationPanel.jsx';
import { getMockData } from '../frontend/src/lib/mockSupabaseClient.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';
import { logger } from '../frontend/src/lib/logger.js';
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
  { id: 't-1', name: 'Blue Bears', division: 'U10' },
  { id: 't-2', name: 'Red Foxes', division: 'U10' },
];
const GAME = {
  homeTeamId: 't-1',
  awayTeamId: 't-2',
  start: '2026-04-11T09:00:00Z',
  end: '2026-04-11T10:00:00Z',
  fieldId: 'pitch-1',
  slotId: 's-1',
};
const RLS_REFUSAL = 'new row violates row-level security policy';

/**
 * A Supabase Storage double: records every upload and answers each with the
 * refusal `refuse(path)` returns, or success; and every removal, answered
 * as Storage answers one: the objects it removed (each path `keep` does not
 * hold back, as an object RLS hides is silently not removed), or a refusal
 * when `removeError` is set.
 *
 * @param {(path: string) => string | null} [refuse]
 * @param {{ keep?: (path: string) => boolean, removeError?: string }} [removal]
 */
function storageClient(refuse = () => null, { keep = () => false, removeError } = {}) {
  const calls = [];
  const removals = [];
  const client = {
    storage: {
      from: (bucket) => ({
        upload: async (path, file, options) => {
          calls.push({ bucket, path, options, size: String(file).length });
          const message = refuse(path);
          return message ? { data: null, error: { message } } : { data: { path }, error: null };
        },
        remove: async (paths) => {
          removals.push({ bucket, paths: [...paths] });
          if (removeError) return { data: null, error: { message: removeError } };
          return {
            data: paths.filter((path) => !keep(path)).map((name) => ({ name, bucket_id: bucket })),
            error: null,
          };
        },
      }),
    },
  };
  return { client, calls, removals };
}

async function generateAndUpload(client) {
  render(<OutputGenerationPanel teams={TEAMS} gameAssignments={[GAME]} supabaseClient={client} />);
  fireEvent.click(screen.getByRole('button', { name: 'Generate CSVs' }));
  await screen.findByText('Generated Files');
  fireEvent.click(screen.getByRole('button', { name: 'Upload to Storage' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error [MOCK] - a partial organization context is enough here.
  vi.mocked(useOrganization).mockReturnValue({ currentOrganization: { id: ORG } });
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));
});

describe('OutputGenerationPanel :: Upload to Storage', () => {
  it("uploads every file to the exports bucket under the organization's folder, without upsert", async () => {
    const { client, calls } = storageClient();
    await generateAndUpload(client);

    expect(await screen.findByText(/Uploaded 3 files to 'exports' bucket\./)).toBeInTheDocument();
    expect(screen.getByText(/Recorded as published baseline v1\./)).toBeInTheDocument();

    // The master CSV and one per team: three, every one under the org folder.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.bucket).toBe('exports');
      expect(call.path.startsWith(`${ORG}/`), call.path).toBe(true);
      expect(call.options).toEqual({ contentType: 'text/csv', upsert: false });
      expect(call.size).toBeGreaterThan(0);
    }
    const paths = calls.map((call) => call.path.slice(ORG.length + 1)).sort();
    expect(paths[0]).toMatch(/^master-schedule-[\dT-]+Z\.csv$/);
    expect(paths[1]).toMatch(/^teams\/t-1-[\dT-]+Z\.csv$/);
    expect(paths[2]).toMatch(/^teams\/t-2-[\dT-]+Z\.csv$/);

    expect(getMockData('publication_baselines')).toHaveLength(1);
  });

  it('removes what a refused publish did upload, says so, and records no baseline', async () => {
    const { client, calls, removals } = storageClient((path) =>
      path.includes('/teams/t-2-') ? RLS_REFUSAL : null
    );
    await generateAndUpload(client);

    const message = await screen.findByText(/^Upload failed:/);
    expect(message.textContent).toMatch(
      new RegExp(
        `^Upload failed: 1 of 3 files were not uploaded \\(Failed to upload ${ORG}/teams/t-2-`
      )
    );
    expect(message.textContent).toContain(RLS_REFUSAL);
    expect(message.textContent).toContain(
      'The 2 that uploaded were removed, so nothing was published. No published baseline was recorded.'
    );
    // Every file was attempted: one refusal does not hide what the others did.
    expect(calls).toHaveLength(3);
    // The two that went out are removed again, in one call to the same bucket.
    const uploaded = calls
      .map((call) => call.path)
      .filter((path) => !path.includes('/teams/t-2-'))
      .sort();
    expect(removals).toEqual([{ bucket: 'exports', paths: expect.any(Array) }]);
    expect([...removals[0].paths].sort()).toEqual(uploaded);
    expect(getMockData('publication_baselines') ?? []).toHaveLength(0);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'Upload error:',
      expect.stringContaining('/teams/t-2-'),
      expect.any(Error)
    );
    expect(screen.queryByText(/Uploaded 3 files/)).toBeNull();
  });

  it('names every file a refused removal leaves in the bucket, and logs each', async () => {
    const { client, calls, removals } = storageClient(
      (path) => (path.includes('/teams/t-2-') ? RLS_REFUSAL : null),
      { removeError: 'storage unavailable' }
    );
    await generateAndUpload(client);

    const message = await screen.findByText(/^Upload failed:/);
    const left = calls.map((call) => call.path).filter((path) => !path.includes('/teams/t-2-'));
    expect(removals).toHaveLength(1);
    expect(message.textContent).toContain(
      'Of the 2 that uploaded, 0 were removed and 2 could not be (storage unavailable) and are still in the ' +
        "'exports' bucket: "
    );
    for (const path of left) {
      expect(message.textContent).toContain(path);
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Upload cleanup left a file in the exports bucket:',
        path,
        'storage unavailable'
      );
    }
    expect(message.textContent).toContain('No published baseline was recorded.');
    expect(getMockData('publication_baselines') ?? []).toHaveLength(0);
  });

  it('names the file a removal silently kept (Storage answers only what it removed)', async () => {
    const { client } = storageClient(
      (path) => (path.includes('/teams/t-2-') ? RLS_REFUSAL : null),
      {
        keep: (path) => path.includes('/master-schedule-'),
      }
    );
    await generateAndUpload(client);

    const message = await screen.findByText(/^Upload failed:/);
    expect(message.textContent).toMatch(
      new RegExp(
        `Of the 2 that uploaded, 1 was removed and 1 could not be and is still in the 'exports' bucket: ${ORG}/master-schedule-[\\dT-]+Z\\.csv\\.`
      )
    );
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'Upload cleanup left a file in the exports bucket:',
      expect.stringMatching(new RegExp(`^${ORG}/master-schedule-`)),
      null
    );
  });

  it('says nothing reached the bucket when every file is refused, and removes nothing', async () => {
    const { client, removals } = storageClient(() => RLS_REFUSAL);
    await generateAndUpload(client);

    const message = await screen.findByText(/^Upload failed:/);
    expect(message.textContent).toMatch(/^Upload failed: 3 of 3 files were not uploaded/);
    expect(message.textContent).toContain("Nothing reached the 'exports' bucket.");
    expect(removals).toHaveLength(0);
    expect(getMockData('publication_baselines') ?? []).toHaveLength(0);
  });

  it('uploads nothing, and says why, with no active organization', async () => {
    // @ts-expect-error [MOCK] - no organization chosen yet.
    vi.mocked(useOrganization).mockReturnValue({ currentOrganization: null });
    const { client, calls } = storageClient();
    await generateAndUpload(client);

    const message = await screen.findByText(/^Upload failed:/);
    expect(message.textContent).toMatch(
      /^Upload failed: nothing was uploaded\. Cannot build an export path without an organization id/
    );
    expect(calls).toHaveLength(0);
    expect(getMockData('publication_baselines') ?? []).toHaveLength(0);
  });
});
