/**
 * The Edge half of the demo's expiry and import fence (plan
 * `docs/changes/2026-10-22-demo-mode.md`, D3): `supabase/functions/_shared/demo.ts`, which
 * `_shared/auth.ts` asks after its membership and admin checks and `import-validation` asks before it
 * stages anything. A fake client stands in for the service-role one, as the database's own half is held
 * by `supabase/tests/demo_sessions.sql`.
 *
 * Statically out of reach, and so not claimed: that `auth.ts` and `import-validation/index.ts` call it
 * (`deno check` and the wiring pins at the bottom hold the call sites by reading them; no Deno test
 * executes the functions).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { liveOrganizationIds, readDemoState } from '../supabase/functions/_shared/demo.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');

/** A client whose `organizations` table holds `rows`, or fails with `error`. */
function fakeClient(rows, error = null) {
  const calls = [];
  const client = {
    from(table) {
      calls.push(table);
      const filtered = { rows: [...rows] };
      const result = () => (error ? { data: null, error } : { data: filtered.rows, error: null });
      return {
        select: () => ({
          eq: (_col, value) => ({
            maybeSingle: async () => {
              if (error) return { data: null, error };
              return { data: rows.find((r) => r.id === value) ?? null, error: null };
            },
          }),
          in: async (_col, values) => {
            filtered.rows = rows.filter((r) => values.includes(r.id));
            return result();
          },
        }),
      };
    },
  };
  return { client, calls };
}

describe('readDemoState', () => {
  it('reads a real organization as no demo and never expired', async () => {
    const { client } = fakeClient([{ id: 'real', demo_expires_at: null }]);
    expect(await readDemoState(client, 'real', NOW)).toEqual({ isDemo: false, expired: false });
  });

  it('reads a live demo and an ended one, the instant of expiry already ended', async () => {
    const { client } = fakeClient([
      { id: 'live', demo_expires_at: '2026-10-26T12:00:01Z' },
      { id: 'ended', demo_expires_at: '2026-10-26T11:59:00Z' },
      { id: 'now', demo_expires_at: '2026-10-26T12:00:00Z' },
    ]);
    expect(await readDemoState(client, 'live', NOW)).toEqual({ isDemo: true, expired: false });
    expect(await readDemoState(client, 'ended', NOW)).toEqual({ isDemo: true, expired: true });
    expect(await readDemoState(client, 'now', NOW)).toEqual({ isDemo: true, expired: true });
  });

  it('reads an expiry that is not a date as ended, not as live', async () => {
    const { client } = fakeClient([{ id: 'odd', demo_expires_at: 'soon' }]);
    expect(await readDemoState(client, 'odd', NOW)).toEqual({ isDemo: true, expired: true });
  });

  it('treats a project without the column yet as having no demos, and only that error', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client: before } = fakeClient([], { code: '42703', message: 'column does not exist' });
    expect(await readDemoState(before, 'x', NOW)).toEqual({ isDemo: false, expired: false });
    expect(quiet).not.toHaveBeenCalled();
    const { client: broken } = fakeClient([], { code: '57014', message: 'timeout' });
    expect(await readDemoState(broken, 'x', NOW)).toBeNull();
    expect(quiet).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it('reads a missing organization as no demo (the membership check already refused it)', async () => {
    const { client } = fakeClient([]);
    expect(await readDemoState(client, 'gone', NOW)).toEqual({ isDemo: false, expired: false });
  });
});

describe('liveOrganizationIds', () => {
  const rows = [
    { id: 'real', demo_expires_at: null },
    { id: 'live', demo_expires_at: '2026-10-26T12:10:00Z' },
    { id: 'ended', demo_expires_at: '2026-10-26T11:00:00Z' },
  ];

  it('drops the ended demo and keeps the rest, in order', async () => {
    const { client } = fakeClient(rows);
    expect(await liveOrganizationIds(client, ['ended', 'live', 'real'], NOW)).toEqual([
      'live',
      'real',
    ]);
  });

  it('asks nothing for no ids', async () => {
    const { client, calls } = fakeClient(rows);
    expect(await liveOrganizationIds(client, [], NOW)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('returns none when the read fails, and every id before the column exists', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client: broken } = fakeClient(rows, { code: '57014', message: 'timeout' });
    expect(await liveOrganizationIds(broken, ['real'], NOW)).toEqual([]);
    const { client: before } = fakeClient(rows, { code: '42703', message: 'no column' });
    expect(await liveOrganizationIds(before, ['real', 'live'], NOW)).toEqual(['real', 'live']);
    quiet.mockRestore();
  });
});

describe('the Edge wiring (read, not executed)', () => {
  const auth = readFileSync('supabase/functions/_shared/auth.ts', 'utf8');
  const imports = readFileSync('supabase/functions/import-validation/index.ts', 'utf8');

  it('asks the demo state after the membership, admin and organization-list reads', () => {
    expect(auth).toMatch(
      /import \{ asDemoClient, liveOrganizationIds, readDemoState \} from '\.\/demo\.ts'/
    );
    expect(
      auth.match(/await readDemoState\(asDemoClient\(serviceClient\), organizationId\)/g)
    ).toHaveLength(2);
    expect(auth).toMatch(/return await liveOrganizationIds\(asDemoClient\(serviceClient\), ids\)/);
    // Both checks refuse an organization they could not read the state of.
    expect(auth.match(/return demo !== null && !demo\.expired/g)).toHaveLength(2);
  });

  it('import-validation refuses a demo before it reads a job or stages a row', () => {
    const asks = imports.indexOf(
      'await readDemoState(asDemoClient(serviceClient), body.organization_id)'
    );
    const firstRead = imports.indexOf(".from('import_jobs')");
    expect(asks).toBeGreaterThan(0);
    expect(firstRead).toBeGreaterThan(asks);
    expect(imports).toMatch(/demo === null \|\| demo\.isDemo/);
    expect(imports).toMatch(/demo_import_refused/);
  });
});
