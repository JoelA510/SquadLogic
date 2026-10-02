/**
 * The mock client no longer pretends: an RPC with no arm is refused
 * (PGRST202), and the four RPCs that used to fall through to the silent
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-02T16:00:00Z');

const makeDb = () => ({
  organization_members: [
    { organization_id: 'org-1', profile_id: 'admin-1', role: 'admin' },
    { organization_id: 'org-1', profile_id: 'coach-1', role: 'coach' },
  ],
  registration_forms: [{ id: 'f1', organization_id: 'org-1' }],
  registrations: [{ id: 'r1', organization_id: 'org-1', form_id: 'f1', medical_cleared: false }],
  season_settings: [
    { id: 's1', organization_id: 'org-1' },
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

describe('admin_update_registration_medical_status', () => {
  it('sets the status and reports the change', () => {
    const db = makeDb();
    const res = call(db, 'admin_update_registration_medical_status', {
      p_organization_id: 'org-1',
      p_registration_id: 'r1',
      p_medical_cleared: true,
    });
    expect(res.data).toMatchObject({
      medical_cleared: true,
      previous_status: false,
      changed: true,
    });
    expect(db.registrations[0].medical_cleared).toBe(true);
  });

  it('refuses a coach (42501), a missing flag (23502), array metadata (22023) and a foreign registration (42501)', () => {
    const db = makeDb();
    const base = { p_organization_id: 'org-1', p_registration_id: 'r1', p_medical_cleared: true };
    expect(
      call(db, 'admin_update_registration_medical_status', base, ctxFor(db, 'coach-1')).error.code
    ).toBe('42501');
    expect(
      call(db, 'admin_update_registration_medical_status', { ...base, p_medical_cleared: null })
        .error.code
    ).toBe('23502');
    expect(
      call(db, 'admin_update_registration_medical_status', { ...base, p_metadata: [] }).error.code
    ).toBe('22023');
    expect(
      call(db, 'admin_update_registration_medical_status', { ...base, p_registration_id: 'nope' })
        .error.code
    ).toBe('42501');
    expect(db.registrations[0].medical_cleared).toBe(false);
  });
});

describe('admin_upsert_division_settings', () => {
  it('creates by name, then updates by id, reporting changed', () => {
    const db = makeDb();
    const created = call(db, 'admin_upsert_division_settings', {
      p_organization_id: 'org-1',
      p_season_settings_id: 's1',
      p_name: ' U10 ',
      p_max_roster_size: 12,
    });
    expect(created.data).toMatchObject({ name: 'U10', max_roster_size: 12, changed: true });
    const same = call(db, 'admin_upsert_division_settings', {
      p_organization_id: 'org-1',
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
        p_organization_id: 'org-1',
        p_season_settings_id: 's2',
        p_name: 'X',
      }).error.code
    ).toBe('42501');
    expect(
      call(
        db,
        'admin_upsert_division_settings',
        { p_organization_id: 'org-1', p_season_settings_id: 's1', p_name: 'X' },
        ctxFor(db, 'coach-1')
      ).error.code
    ).toBe('42501');
    expect(
      call(db, 'admin_upsert_division_settings', {
        p_organization_id: 'org-1',
        p_season_settings_id: 's1',
        p_name: '  ',
      }).error.code
    ).toBe('23502');
  });
});

describe('create_org_invite and redeem_org_invite', () => {
  it('an admin creates a code that a new user redeems once', () => {
    const db = makeDb();
    const created = call(db, 'create_org_invite', {
      p_org_id: 'org-1',
      p_role: 'coach',
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
    expect(redeemed.data).toBe('org-1');
    expect(db.organization_members).toContainEqual({
      organization_id: 'org-1',
      profile_id: 'new-user',
      role: 'coach',
    });
    expect(
      call(db, 'redeem_org_invite', { p_code: code }, ctxFor(db, 'other')).error.message
    ).toMatch(/already been used/);
  });

  it('refuses a non-admin creator, a bad role, no session, an unknown code and an expired code', () => {
    const db = makeDb();
    expect(
      call(db, 'create_org_invite', { p_org_id: 'org-1', p_role: 'coach' }, ctxFor(db, 'coach-1'))
        .error.code
    ).toBe('42501');
    expect(call(db, 'create_org_invite', { p_org_id: 'org-1', p_role: 'owner' }).error.code).toBe(
      '22023'
    );
    expect(call(db, 'redeem_org_invite', { p_code: 'X' }, ctxFor(db, 'u', false)).error.code).toBe(
      '28000'
    );
    expect(call(db, 'redeem_org_invite', { p_code: 'NOPE' }).error.message).toMatch(/not found/);
    const [{ code }] = call(db, 'create_org_invite', {
      p_org_id: 'org-1',
      p_role: 'parent',
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
      call(db, 'create_org_invite', { p_org_id: 'org-1', p_role: 'coach', p_expires_in: null })
        .data[0].expires_at
    ).toBeNull();
    expect(
      call(db, 'create_org_invite', { p_org_id: 'org-1', p_role: 'coach' }).data[0].expires_at
    ).toBe('2026-10-09T16:00:00.000Z');
  });

  it('claims exactly the four RPCs', () => {
    expect([...ADMIN_WRITE_RPCS].sort()).toEqual([
      'admin_update_registration_medical_status',
      'admin_upsert_division_settings',
      'create_org_invite',
      'redeem_org_invite',
    ]);
  });
});
