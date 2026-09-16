import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { ImportProvider, useImport } from '../frontend/src/contexts/ImportContext.jsx';
import { getMockData, mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';

/**
 * **A refused rollback record reaches the operator, or it reaches nobody.**
 *
 * `rollback_field_import_job` has always returned `blocked_records`, and this
 * context turned its result into a log line naming only what was DELETED. So
 * an operator rolling back an import whose ground is booked read
 * "Field import rolled back: 0 fields, 0 practice slots, 0 game slots
 * deleted" -- a sentence that says "there was nothing to remove" where the
 * truth is "we refused to remove it". LIVE-3 gave each refusal a table, an id
 * and a reason so that line could say which and why; this file is what makes
 * the line load-bearing rather than optional.
 *
 * It is LIVE-2's round-1 finding one import along: recording a refusal in
 * three places in the database and no screen is the same silence one level up.
 *
 * Driven against the real mock Supabase client rather than `vi.fn()` stubs, so
 * the refusal under test is produced by the code under test.
 */
const mocks = vi.hoisted(() => ({ parse: vi.fn() }));

vi.mock('papaparse', () => ({
  default: { parse: mocks.parse },
}));

vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-1' },
    orgMember: { id: 'member-1' },
  }),
}));

const HEADERS = ['Location', 'Field', 'Type', 'Day', 'Start', 'End', 'Valid From', 'Valid Until'];

const ROW = {
  Location: 'Rollback Park',
  Field: 'Rollback Pitch',
  Type: 'practice',
  Day: 'Mon',
  Start: '17:30',
  End: '18:30',
  'Valid From': '2026-03-01',
  'Valid Until': '2026-05-31',
};

const renderImport = () => {
  const wrapper = ({ children }) => <ImportProvider>{children}</ImportProvider>;
  return renderHook(() => useImport(), { wrapper });
};

/** Import one field row and hand back the field the import created. */
const importOneField = async (result) => {
  mocks.parse.mockImplementation((_file, options) => {
    options.complete({ data: [ROW], meta: { fields: HEADERS } });
  });
  await act(async () => {
    await result.current.startImport(new File(['x'], 'fields.csv'), 'fields');
  });
  await waitFor(() => {
    expect(getMockData('fields').some((f) => f.name === 'Rollback Pitch')).toBe(true);
    // **The job id, not only the row.** `rollbackImport` reads it off context
    // state, which settles after the mock table does -- waiting on the table
    // alone made the first call in this file throw "no completed fields import
    // job is available" while the second passed, which is a race, not a
    // result.
    expect(result.current.importedFields?.importJobId).toBeTruthy();
  });
  return getMockData('fields').find((f) => f.name === 'Rollback Pitch');
};

describe('ImportContext rollback :: a refused record reaches the operator', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
    mocks.parse.mockReset();
    // `startImport` refuses without an authenticated user, so the flow under
    // test is only reachable from a signed-in session.
    await mockSupabase.auth.signInWithPassword({
      email: 'admin@example.com',
      password: 'test-password-123',
    });
  });

  it('names the blocked record, its reason and what holds it', async () => {
    const { result } = renderImport();
    const field = await importOneField(result);

    // **A booking the pre-LIVE-3 guard could not see**: a free-standing
    // practice assignment -- a field_id and no slot behind it. The import's
    // own practice slot rolls back first and takes nothing with it, so what
    // blocks the field is this row and only this row.
    await mockSupabase.from('practice_assignments').insert([
      {
        id: 'ctx-practice-assignment',
        organization_id: 'org-1',
        team_id: 'ctx-team',
        field_id: field.id,
        effective_date_range: '[2026-03-01,2026-05-31]',
      },
    ]);

    /** @type {any} */
    let rollback;
    await act(async () => {
      rollback = await result.current.rollbackImport('fields');
    });

    // **TWO refusals, and the second one is the interesting one.** The booking
    // blocks the field, and the surviving field then blocks the LOCATION the
    // same import created -- a refusal that cascades up the ordering the loop
    // walks. A test expecting one would have been asserting against a reading
    // of the RPC rather than against the RPC.
    expect(rollback.blocked_records).toBe(2);
    expect(getMockData('fields').some((f) => String(f.id) === String(field.id))).toBe(true);
    expect(rollback.blocked.map((b) => b.kind).sort()).toEqual(['fields', 'locations']);
    expect(rollback.blocked.map((b) => b.reason).sort()).toEqual([
      'bookings_exist',
      'location_has_fields',
    ]);

    await waitFor(() => {
      const messages = result.current.importLogs.map((entry) => entry.message);
      const line = messages.find((m) => m.startsWith('Field import rolled back:'));
      expect(line, 'the rollback logged nothing at all').toBeDefined();
      // Each fact the operator needs, asserted separately, so a line carrying
      // some of them fails rather than passing on a substring of itself.
      expect(line).toContain('2 record(s) refused');
      expect(line).toContain('fields');
      expect(line).toContain(String(field.id));
      expect(line).toContain('bookings_exist');
      expect(line).toContain('1 booking(s)');
      // The second refusal reaches the same line with its own reason, so a
      // renderer that printed only the first entry fails here.
      expect(line).toContain('locations');
      expect(line).toContain('location_has_fields');
    });

    // The status the operator's screen branches on is the warning one, not
    // idle: a rollback that refused something is not a rollback that finished.
    expect(result.current.importStatus).toBe('completed_with_warnings');
  });

  it('says nothing about refusals when the rollback took everything', async () => {
    // The negative control. A summary that fires on zero is how "0 records
    // refused" ends up alarming people, and it would also make the assertions
    // above pass for a helper that appended its sentence unconditionally.
    const { result } = renderImport();
    await importOneField(result);

    /** @type {any} */
    let rollback;
    await act(async () => {
      rollback = await result.current.rollbackImport('fields');
    });
    expect(rollback.blocked_records).toBe(0);
    expect(rollback.blocked).toEqual([]);

    await waitFor(() => {
      const messages = result.current.importLogs.map((entry) => entry.message);
      const line = messages.find((m) => m.startsWith('Field import rolled back:'));
      expect(line).toBeDefined();
      expect(line).not.toContain('refused');
      // ... and the line still carries its counts, so "not refused" is not
      // satisfied by an empty log line.
      expect(line).toContain('1 fields');
    });
  });
});
