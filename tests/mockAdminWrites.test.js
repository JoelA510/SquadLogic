/**
 * The mock client no longer pretends: an RPC with no arm is refused
 * (PGRST202), and the three RPCs that used to fall through to the silent
 * catch-all have arms mirroring their SQL, refusals included.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import {
  ADMIN_WRITE_RPCS,
  handleAdminWriteRpc,
  unmockedRpcError,
} from '../frontend/src/lib/mockAdminWrites.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-02T16:00:00Z');

const makeDb = () => ({
  organization_members: [{ organization_id: MOCK_ORG_ID, profile_id: 'admin-1', role: 'admin' }],
  season_settings: [
    { id: 's1', organization_id: MOCK_ORG_ID },
    { id: 's2', organization_id: 'org-2' },
  ],
  divisions: [],
});

const ctxFor = (db, user = 'admin-1', session = true) => ({
  currentUserId: user,
  sessionUserId: session ? user : null,
  isOrgAdmin: (orgId) =>
    db.organization_members.some(
      (m) => m.organization_id === orgId && m.profile_id === user && m.role === 'admin'
    ),
  now: NOW,
  newId: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
});

const call = (db, name, params, ctx = ctxFor(db)) => handleAdminWriteRpc(db, name, params, ctx);

describe('the mock client refuses an RPC it has no arm for', () => {
  it('returns PGRST202, not a silent success', async () => {
    const { data, error } = await mockSupabase.rpc('definitely_not_a_function', {});
    expect(data).toBeNull();
    expect(error).toMatchObject({ code: 'PGRST202' });
    expect(error.message).toMatch(/public\.definitely_not_a_function/);
    expect(unmockedRpcError('x').error.code).toBe('PGRST202');
  });

  it('every RPC the frontend calls by literal name has an arm', () => {
    const files = [];
    const walk = (dir) =>
      readdirSync(dir).forEach((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(js|jsx)$/.test(name) && !/mock/i.test(name)) files.push(full);
      });
    walk(path.join(ROOT, 'frontend/src'));
    const called = new Set();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\.rpc\(\s*['"]([a-z_0-9]+)['"]/g)) called.add(m[1]);
      for (const m of text.matchAll(/(?:retireRpc|unretireRpc)\s*:\s*['"]([a-z_0-9]+)['"]/g))
        called.add(m[1]);
    }
    const mocks = readdirSync(path.join(ROOT, 'frontend/src/lib'))
      .filter((n) => /^mock.*\.js$/.test(n))
      .map((n) => readFileSync(path.join(ROOT, 'frontend/src/lib', n), 'utf8'))
      .join('\n');
    const armed = (n) =>
      new RegExp(
        `name\\s*===\\s*['"]${n}['"]|name\\s*!==\\s*['"]${n}['"]|['"]${n}['"]\\s*[,\\]]`
      ).test(mocks);
    expect(called.size).toBeGreaterThan(40);
    expect([...called].filter((n) => !armed(n))).toEqual([]);
    // The check can fail: a name nobody arms is reported.
    expect(armed('definitely_not_a_function')).toBe(false);
  });
});

describe('admin_upsert_division_settings', () => {
  it('creates by name, then updates by id, reporting changed', () => {
    const db = makeDb();
    const created = call(db, 'admin_upsert_division_settings', {
      p_organization_id: MOCK_ORG_ID,
      p_season_settings_id: 's1',
      p_name: ' U10 ',
      p_max_roster_size: 12,
    });
    expect(created.data).toMatchObject({ name: 'U10', max_roster_size: 12, changed: true });
    const same = call(db, 'admin_upsert_division_settings', {
      p_organization_id: MOCK_ORG_ID,
      p_season_settings_id: 's1',
      p_division_id: created.data.id,
      p_max_roster_size: 12,
    });
    expect(same.data.changed).toBe(false);
    expect(db.divisions).toHaveLength(1);
  });

  it("refuses another org's season and a non-admin (42501), and a missing name (23502)", () => {
    const db = makeDb();
    expect(
      call(db, 'admin_upsert_division_settings', {
        p_organization_id: MOCK_ORG_ID,
        p_season_settings_id: 's2',
        p_name: 'X',
      }).error.code
    ).toBe('42501');
    expect(
      call(
        db,
        'admin_upsert_division_settings',
        { p_organization_id: MOCK_ORG_ID, p_season_settings_id: 's1', p_name: 'X' },
        ctxFor(db, 'outsider-1')
      ).error.code
    ).toBe('42501');
    expect(
      call(db, 'admin_upsert_division_settings', {
        p_organization_id: MOCK_ORG_ID,
        p_season_settings_id: 's1',
        p_name: '  ',
      }).error.code
    ).toBe('23502');
  });
});

describe('admin_upsert_division_settings: practices per week and practice length (20261105010000)', () => {
  const upsert = (db, extra) =>
    call(db, 'admin_upsert_division_settings', {
      p_organization_id: MOCK_ORG_ID,
      p_season_settings_id: 's1',
      p_name: 'U10',
      ...extra,
    });

  it('a new division takes one a week and any length; NULL keeps; 0 clears the length', () => {
    const db = makeDb();
    const created = upsert(db, {});
    expect(created.data).toMatchObject({ practices_per_week: 1, practice_minutes: null });
    const set = upsert(db, {
      p_division_id: created.data.id,
      p_practices_per_week: 2,
      p_practice_minutes: 60,
    });
    expect(set.data).toMatchObject({ practices_per_week: 2, practice_minutes: 60, changed: true });
    // A save that names neither keeps both, and reports no change.
    const kept = upsert(db, { p_division_id: created.data.id });
    expect(kept.data).toMatchObject({
      practices_per_week: 2,
      practice_minutes: 60,
      changed: false,
    });
    const cleared = upsert(db, { p_division_id: created.data.id, p_practice_minutes: 0 });
    expect(cleared.data).toMatchObject({
      practices_per_week: 2,
      practice_minutes: null,
      changed: true,
    });
    // Zero practices a week is a value, not "unset".
    const none = upsert(db, { p_division_id: created.data.id, p_practices_per_week: 0 });
    expect(none.data).toMatchObject({ practices_per_week: 0, changed: true });
  });

  it('refuses out-of-range values with 23514, as the table check does, and writes nothing', () => {
    const db = makeDb();
    const created = upsert(db, {});
    for (const extra of [
      { p_practices_per_week: 8 },
      { p_practices_per_week: -1 },
      { p_practices_per_week: 1.5 },
      { p_practice_minutes: 14 },
      { p_practice_minutes: 241 },
    ]) {
      expect(
        upsert(db, { p_division_id: created.data.id, ...extra }).error?.code,
        JSON.stringify(extra)
      ).toBe('23514');
    }
    expect(db.divisions[0]).toMatchObject({ practices_per_week: 1, practice_minutes: null });
  });
});

describe('create_org_invite and redeem_org_invite', () => {
  it('an admin creates a code that a new user redeems once', () => {
    const db = makeDb();
    const created = call(db, 'create_org_invite', {
      p_org_id: MOCK_ORG_ID,
      p_role: 'staff',
      p_expires_in: '7 days',
    });
    const [{ code, expires_at }] = created.data;
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(expires_at).toBe('2026-10-09T16:00:00.000Z');
    const redeemed = call(
      db,
      'redeem_org_invite',
      { p_code: ` ${code.toLowerCase()} ` },
      ctxFor(db, 'new-user')
    );
    expect(redeemed.data).toBe(MOCK_ORG_ID);
    expect(db.organization_members).toContainEqual({
      organization_id: MOCK_ORG_ID,
      profile_id: 'new-user',
      role: 'staff',
    });
    expect(
      call(db, 'redeem_org_invite', { p_code: code }, ctxFor(db, 'other')).error.message
    ).toMatch(/already been used/);
  });

  it('refuses a non-admin creator, a bad role, no session, an unknown code and an expired code', () => {
    const db = makeDb();
    expect(
      call(
        db,
        'create_org_invite',
        { p_org_id: MOCK_ORG_ID, p_role: 'staff' },
        ctxFor(db, 'outsider-1')
      ).error.code
    ).toBe('42501');
    // No coach, parent or player role (20261024010000, R3; docs/changes/2026-10-27-admin-only.md),
    // as the SQL's whitelist.
    for (const role of ['owner', 'coach', 'parent', 'player']) {
      expect(
        call(db, 'create_org_invite', { p_org_id: MOCK_ORG_ID, p_role: role }).error?.code,
        role
      ).toBe('22023');
    }
    expect(call(db, 'redeem_org_invite', { p_code: 'X' }, ctxFor(db, 'u', false)).error.code).toBe(
      '28000'
    );
    expect(call(db, 'redeem_org_invite', { p_code: 'NOPE' }).error.message).toMatch(/not found/);
    const [{ code }] = call(db, 'create_org_invite', {
      p_org_id: MOCK_ORG_ID,
      p_role: 'staff',
      p_expires_in: '1 hours',
    }).data;
    const later = { ...ctxFor(db, 'u'), now: new Date('2026-10-02T18:00:00Z') };
    expect(
      handleAdminWriteRpc(db, 'redeem_org_invite', { p_code: code }, later).error.message
    ).toMatch(/expired/);
  });

  it('a null expiry means no expiry; an absent one means 7 days', () => {
    const db = makeDb();
    expect(
      call(db, 'create_org_invite', { p_org_id: MOCK_ORG_ID, p_role: 'staff', p_expires_in: null })
        .data[0].expires_at
    ).toBeNull();
    expect(
      call(db, 'create_org_invite', { p_org_id: MOCK_ORG_ID, p_role: 'staff' }).data[0].expires_at
    ).toBe('2026-10-09T16:00:00.000Z');
  });

  it('claims exactly the four RPCs', () => {
    expect([...ADMIN_WRITE_RPCS].sort()).toEqual([
      'admin_set_practice_slot_division',
      'admin_upsert_division_settings',
      'create_org_invite',
      'redeem_org_invite',
    ]);
  });
});
