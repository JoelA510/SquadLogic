/**
 * The `exports` bucket's object paths and its uploader
 * (`packages/core/src/storageSupabase.js`).
 *
 * The bucket's policies (`supabase/migrations/20261017000000_exports_bucket.sql`)
 * accept an upload only under the folder of an organization the caller is an
 * administrator of, and refuse a first folder that is not a UUID. `exportObjectPath`
 * is the one place the app builds such a path, so it refuses what the
 * database would, before anything is sent.
 */
import { describe, expect, it, vi } from 'vitest';

import { exportObjectPath, uploadScheduleExport } from '@squadlogic/core/storageSupabase.js';

const ORG = '5eed0000-0000-4000-8000-000000000001';

describe('exportObjectPath', () => {
  it('puts the file under the organization folder', () => {
    expect(exportObjectPath(ORG, 'master-schedule-2026.csv')).toBe(
      `${ORG}/master-schedule-2026.csv`
    );
    expect(exportObjectPath(ORG, 'teams/t-1-2026.csv')).toBe(`${ORG}/teams/t-1-2026.csv`);
  });

  it('takes any hex UUID, as the policy and the uuid type do, not only RFC versions', () => {
    // The pgTAP fixtures' organization ids have version and variant nibble 1.
    const fixtureOrg = 'a1111111-1111-1111-1111-111111111111';
    expect(exportObjectPath(fixtureOrg, 'x.csv')).toBe(`${fixtureOrg}/x.csv`);
    expect(exportObjectPath(ORG.toUpperCase(), 'x.csv')).toBe(`${ORG.toUpperCase()}/x.csv`);
  });

  it.each([
    ['no organization', undefined],
    ['a null organization', null],
    ['an empty organization', ''],
    ['the mock seed id of old', 'org-1'],
    ['a UUID with a trailing folder', `${ORG}/x`],
  ])('refuses %s', (_label, organizationId) => {
    expect(() => exportObjectPath(organizationId, 'x.csv')).toThrow(/organization id \(a UUID\)/);
  });

  it.each([
    ['an empty name', ''],
    ['an absolute name', '/x.csv'],
    ['a parent segment', '../other-org/x.csv'],
    ['a parent segment further in', 'teams/../../x.csv'],
    ['a dot segment', './x.csv'],
    ['an empty segment', 'teams//x.csv'],
    ['a trailing slash', 'teams/'],
    ['a backslash', 'teams\\x.csv'],
    ['a non-string', 42],
  ])('refuses %s', (_label, fileName) => {
    expect(() => exportObjectPath(ORG, /** @type {any} */ (fileName))).toThrow(
      /Not a relative export file name/
    );
  });
});

describe('uploadScheduleExport', () => {
  const clientWith = (result) => {
    const upload = vi.fn(async () => result);
    const from = vi.fn(() => ({ upload }));
    return { client: { storage: { from } }, from, upload };
  };

  it('passes upsert through, and keeps upserting by default', async () => {
    const { client, from, upload } = clientWith({ data: { path: 'p' }, error: null });
    await uploadScheduleExport({ supabaseClient: client, path: 'p', file: 'a,b', upsert: false });
    expect(from).toHaveBeenCalledWith('exports');
    expect(upload).toHaveBeenLastCalledWith('p', 'a,b', { contentType: 'text/csv', upsert: false });

    await uploadScheduleExport({ supabaseClient: client, path: 'p', file: 'a,b' });
    expect(upload).toHaveBeenLastCalledWith('p', 'a,b', { contentType: 'text/csv', upsert: true });
  });

  it("throws the storage refusal with the object's path", async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = clientWith({
      data: null,
      error: { message: 'new row violates row-level security policy' },
    });
    await expect(
      uploadScheduleExport({ supabaseClient: client, path: `${ORG}/x.csv`, file: 'a' })
    ).rejects.toThrow(`Failed to upload ${ORG}/x.csv: new row violates row-level security policy`);
    consoleError.mockRestore();
  });
});
