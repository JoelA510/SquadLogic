import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * The evaluations import through ImportContext (E3c of docs/changes/2026-10-27-season-enrollment.md),
 * against the real mock Supabase client: `startImport` validates and stages the file and stops at
 * "ready to apply" with the server's dry run beside it, whatever options the caller passes; nothing
 * has touched a player until `applyDeferredImport('evaluations')`; cancelling touches none either.
 */
const mocks = vi.hoisted(() => ({ parse: vi.fn(), role: undefined }));

vi.mock('papaparse', () => ({ default: { parse: mocks.parse } }));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    orgMember: { id: 'member-1', role: mocks.role },
    currentSeasonSetting: { id: MOCK_SEASON_ID, name: 'Seed Season', status: 'active' },
  }),
}));

const HEADERS = ['Registration ID', 'Years Played', 'Skill Tier', 'Rating'];
const FILE_ROWS = [
  { 'Registration ID': 'EVC-1', 'Years Played': '4', 'Skill Tier': 'advanced', Rating: '5' },
  { 'Registration ID': 'EVC-2', 'Years Played': '', 'Skill Tier': '', Rating: '2' },
  { 'Registration ID': 'NOBODY-9', 'Years Played': '1', 'Skill Tier': '', Rating: '' },
  { 'Registration ID': 'EVC-1x', 'Years Played': '99', 'Skill Tier': '', Rating: '' },
];

const seedPlayers = () =>
  window.__saveMockDB__({
    ...window.__MOCK_DB__,
    players: [
      ...getMockData('players'),
      ...['EVC-1', 'EVC-2'].map((reg) => ({
        id: `ctx-${reg}`,
        organization_id: MOCK_ORG_ID,
        season_settings_id: MOCK_SEASON_ID,
        first_name: 'Ev',
        last_name: reg,
        external_registration_id: reg,
        years_played: null,
        skill_tier: null,
        rating: reg === 'EVC-2' ? 4 : null,
      })),
    ],
  });
const player = (reg) => getMockData('players').find((p) => p.external_registration_id === reg);

const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;

describe('ImportContext: the evaluations import', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    mocks.parse.mockReset();
    mocks.role = undefined;
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({ data: FILE_ROWS, meta: { fields: HEADERS } });
    });
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
    seedPlayers();
  });

  it('stops at ready to apply with the dry run beside it, and changes no player', async () => {
    const { result } = renderHook(() => useImport(), { wrapper });
    await act(async () => {
      // No `deferApply` option: an evaluations import is always checked first.
      await result.current.startImport(new File(['x'], 'ev.csv'), 'evaluations');
    });

    await waitFor(() => expect(result.current.importStatus).toBe('ready_to_apply'));
    const ready = result.current.importedEvaluations;
    expect(ready.persistence.preview).toMatchObject({
      status: 'preview',
      dry_run: true,
      updated_players: 2,
      unmatched_rows: 1,
    });
    // The row refused upstream (years 99) is the validation's, listed with its row number.
    expect(ready.validationErrors).toEqual([
      expect.objectContaining({ row: 4, field: 'years_played' }),
    ]);
    expect(result.current.importLogs.map((l) => l.message).join('\n')).toMatch(
      /2 player\(s\) would be updated/
    );
    expect(player('EVC-1')).toMatchObject({ years_played: null, skill_tier: null, rating: null });
    expect(player('EVC-2').rating).toBe(4);
  });

  it('applies on confirm and reports what changed, unmatched ids named', async () => {
    const { result } = renderHook(() => useImport(), { wrapper });
    await act(async () => {
      await result.current.startImport(new File(['x'], 'ev.csv'), 'evaluations');
    });
    await waitFor(() => expect(result.current.importStatus).toBe('ready_to_apply'));

    await act(async () => {
      await result.current.applyDeferredImport('evaluations');
    });

    expect(player('EVC-1')).toMatchObject({ years_played: 4, skill_tier: 'advanced', rating: 5 });
    expect(player('EVC-2')).toMatchObject({ years_played: null, rating: 2 });
    expect(getMockData('players').some((p) => p.external_registration_id === 'NOBODY-9')).toBe(
      false
    );
    expect(result.current.importStatus).toBe('completed_with_warnings');
    const done = result.current.importedEvaluations.persistence;
    expect(done.result).toMatchObject({ dry_run: false, updated_players: 2, unmatched_rows: 1 });
    const log = result.current.importLogs.map((l) => l.message).join('\n');
    expect(log).toMatch(/2 player\(s\) updated/);
    expect(log).toMatch(/1 row\(s\) match no player in this season and were skipped.*NOBODY-9/);
    // Nothing offers to roll an evaluations import back.
    await expect(result.current.rollbackImport('evaluations')).rejects.toThrow(
      /not available for evaluations/
    );
  });

  it('cancelling a checked import leaves every player as it was', async () => {
    const { result } = renderHook(() => useImport(), { wrapper });
    await act(async () => {
      await result.current.startImport(new File(['x'], 'ev.csv'), 'evaluations');
    });
    await waitFor(() => expect(result.current.importStatus).toBe('ready_to_apply'));
    await act(async () => {
      await result.current.cancelDeferredImport('evaluations');
    });
    expect(result.current.importStatus).toBe('idle');
    expect(result.current.importedEvaluations).toBeNull();
    expect(player('EVC-1')).toMatchObject({ years_played: null, skill_tier: null, rating: null });
    expect(getMockData('import_jobs').at(-1).status).toBe('failed');
  });

  it('shows the checked import again, with its dry run, when the page is reloaded before the confirm', async () => {
    const first = renderHook(() => useImport(), { wrapper });
    await act(async () => {
      await first.result.current.startImport(new File(['x'], 'ev.csv'), 'evaluations');
    });
    await waitFor(() => expect(first.result.current.importStatus).toBe('ready_to_apply'));
    first.unmount();

    // A new page: nothing in memory but what the server holds. Only an admin's session is offered it.
    mocks.role = 'admin';
    const reloaded = renderHook(() => useImport(), { wrapper });
    await waitFor(() => expect(reloaded.result.current.importedEvaluations).not.toBeNull());
    expect(reloaded.result.current.importStatus).toBe('ready_to_apply');
    expect(reloaded.result.current.importedEvaluations.persistence.preview).toMatchObject({
      dry_run: true,
      updated_players: 2,
      unmatched_rows: 1,
    });
    // The upstream refusal survives the reload with the job, and the apply still works.
    expect(reloaded.result.current.importedEvaluations.validationErrors).toEqual([
      expect.objectContaining({ row: 4, field: 'years_played' }),
    ]);
    await act(async () => {
      await reloaded.result.current.applyDeferredImport('evaluations');
    });
    expect(player('EVC-1')).toMatchObject({ years_played: 4, rating: 5 });
  });

  it('fails a file with an id and no value column before anything is staged', async () => {
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({
        data: [{ 'Registration ID': 'EVC-1' }],
        meta: { fields: ['Registration ID'] },
      });
    });
    const { result } = renderHook(() => useImport(), { wrapper });
    await act(async () => {
      await result.current.startImport(new File(['x'], 'ev.csv'), 'evaluations');
    });
    await waitFor(() => expect(result.current.importStatus).toBe('error'));
    expect(result.current.importLogs.map((l) => l.message).join('\n')).toMatch(
      /Missing required columns: one of years_played, skill_tier, rating/
    );
    expect(
      getMockData('staging_import_rows').filter((r) => r.import_type === 'evaluations')
    ).toHaveLength(0);
  });
});
