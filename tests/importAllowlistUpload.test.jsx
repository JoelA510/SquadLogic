import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * A people import keeps only allowlisted columns, end to end through the
 * browser path (plan docs/changes/2026-10-22-admin-focus.md, R0): the rows the
 * browser sends to import-validation, what the mock stages, and what the mock
 * finalizer stores. The rows are synthetic, with placeholder values only; each
 * value that must not survive carries a `NOPE-` marker so one search of the
 * mock database finds any copy of it.
 */
const mocks = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock('papaparse', () => ({
  default: { parse: mocks.parse },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: MOCK_ORG_ID },
    orgMember: { id: 'member-1', role: 'admin' },
  }),
}));

const COACH_ROW = {
  'Full Name': 'First1 Last1',
  Email: 'email1@example.com',
  Phone: 'NOPE-555-100-0001',
  'Guardian 1 Email Address': 'NOPE-email2@example.com',
  'Guardian 1 Mobile Phone Number': 'NOPE-555-100-0002',
  'Guardian 1 Address': 'NOPE-1 Placeholder Way',
  "What is your player's birth date?": 'NOPE-2016-02-02',
  'Player First Name': 'NOPE-First2',
  'Payment Status': 'NOPE-PAID',
  'Playing Up': 'NOPE-yes',
  'Shirt Size': 'AL',
};

describe('a people import keeps only allowlisted columns', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    mocks.parse.mockReset();
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends, stages and stores a coach row without its unlisted columns, keeping a declared field', async () => {
    const { error: schemaError } = await mockSupabase.rpc('admin_upsert_organization_schema', {
      p_organization_id: MOCK_ORG_ID,
      p_entity_type: 'coach',
      p_schema_definition: { shirt_size: 'string' },
    });
    expect(schemaError).toBeNull();

    mocks.parse.mockImplementation((_file, options) => {
      options.complete({ data: [COACH_ROW], meta: { fields: Object.keys(COACH_ROW) } });
    });
    const invoke = vi.spyOn(mockSupabase.functions, 'invoke');

    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });
    // The provider reads the organization's declared fields on mount.
    await waitFor(() => {
      expect(result.current.organizationSchemas?.coach).toEqual({ shirt_size: 'string' });
    });

    await act(async () => {
      await result.current.startImport(new File(['x'], 'coaches.csv'), 'coaches');
    });
    await waitFor(() => {
      expect(getMockData('coaches').filter((c) => c.email === 'email1@example.com')).toHaveLength(
        1
      );
    });

    // What left the browser.
    const calls = invoke.mock.calls.filter(([name]) => name === 'import-validation');
    expect(calls).toHaveLength(1);
    const sent = /** @type {{ body: { rows: Array<Record<string, unknown>> } }} */ (calls[0][1])
      .body.rows;
    expect(sent).toEqual([
      { 'Full Name': 'First1 Last1', Email: 'email1@example.com', 'Shirt Size': 'AL' },
    ]);

    // What was stored.
    const coach = getMockData('coaches').find((c) => c.email === 'email1@example.com');
    expect(coach.phone).toBeNull();
    expect(coach.contact_info).toEqual({ email: 'email1@example.com' });
    expect(coach.custom_attributes).toEqual({ shirt_size: 'AL' });
    const stored = JSON.stringify({
      staging: getMockData('staging_import_rows'),
      coaches: getMockData('coaches'),
      records: getMockData('import_application_records'),
      jobs: getMockData('import_jobs'),
      audit: getMockData('audit_log'),
    });
    expect(stored).toContain('email1@example.com');
    expect(stored).not.toContain('NOPE-');
  });

  it('fails the import, sending and storing nothing, when the declared fields cannot be read', async () => {
    const realFrom = mockSupabase.from.bind(mockSupabase);
    const refused = { data: null, error: { message: 'MOCK-SCHEMA-READ-REFUSED' } };
    const failingQuery = {
      select: () => failingQuery,
      eq: () => failingQuery,
      maybeSingle: async () => refused,
      then: (resolve, reject) => Promise.resolve(refused).then(resolve, reject),
    };
    vi.spyOn(mockSupabase, 'from').mockImplementation((table) =>
      table === 'organization_schemas' ? failingQuery : realFrom(table)
    );
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({ data: [COACH_ROW], meta: { fields: Object.keys(COACH_ROW) } });
    });
    const invoke = vi.spyOn(mockSupabase.functions, 'invoke');

    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });
    await act(async () => {
      await result.current.startImport(new File(['x'], 'coaches.csv'), 'coaches');
    });

    expect(result.current.importStatus).toBe('error');
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([name]) => name === 'import-validation')).toHaveLength(0);
    const job = getMockData('import_jobs').at(-1);
    expect(job.status).toBe('failed');
    expect(JSON.stringify(job)).toContain('schema_lookup');
    expect(
      result.current.importLogs.some((entry) =>
        /Could not read the organization's custom coach fields/.test(entry.message)
      )
    ).toBe(true);
    expect(getMockData('coaches').filter((c) => c.email === 'email1@example.com')).toHaveLength(0);
  });

  it('a player row loses its contact, guardian and payment columns and keeps team placement', async () => {
    const row = {
      'First Name': 'First3',
      'Last Name': 'Last3',
      'Date of Birth': '2016-03-03',
      'Registration ID': 'REG-3',
      Gender: 'F',
      'Team Name': 'Team 3',
      Email: 'NOPE-email3@example.com',
      Phone: 'NOPE-555-100-0003',
      'Guardian 1 First Name': 'NOPE-First4',
      'Guardian 1 Email Address': 'NOPE-email4@example.com',
      'Payment Status': 'NOPE-PAID',
    };
    mocks.parse.mockImplementation((_file, options) => {
      options.complete({ data: [row], meta: { fields: Object.keys(row) } });
    });
    const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
    const { result } = renderHook(() => useImport(), { wrapper });

    await act(async () => {
      await result.current.startImport(new File(['x'], 'players.csv'), 'players');
    });
    await waitFor(() => {
      expect(
        getMockData('players').filter((p) => p.external_registration_id === 'REG-3')
      ).toHaveLength(1);
    });

    const player = getMockData('players').find((p) => p.external_registration_id === 'REG-3');
    expect(player.guardian_contacts).toEqual([]);
    expect(player.contact_info).toEqual({});
    expect(player.paid).toBe(false);
    expect(player.custom_attributes).toEqual({ team_name: 'Team 3' });
    expect(
      JSON.stringify({
        staging: getMockData('staging_players'),
        players: getMockData('players'),
        jobs: getMockData('import_jobs'),
      })
    ).not.toContain('NOPE-');
  });
});
