/**
 * **The mock and the migration as one contract.**
 *
 * The mock Supabase client is what the E2E suite -- and therefore PR 3's UI --
 * is written against. Nothing held it and the migration in agreement, and three
 * divergences existed that no test could see: blackout rows lacked
 * `created_by`, the mock's audit entries carried no before/after phase, and
 * `field_closures` had no mock counterpart at all, so PR 3 would have had to
 * either query the two tables directly (reintroducing the two-answers defect
 * the view removes) or ship a view nothing exercises.
 *
 * These derive the contract from the MIGRATION TEXT and hold the mock to it, so
 * a column added to the table without a mock counterpart fails here rather than
 * in production. It is not a substitute for the database -- `scripts/dbharness`
 * executes the real SQL -- it is the seam between the two.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(
  path.join(REPO_ROOT, 'supabase/migrations/20260906000100_field_blackouts.sql'),
  'utf8'
);

const ORG = 'org-1';
const setMockSession = (userId) =>
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));

/** Column names of `CREATE TABLE public.field_blackouts`, from the migration. */
const tableColumns = () => {
  const body = MIGRATION.slice(
    MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS public.field_blackouts ('),
    MIGRATION.indexOf('CREATE INDEX IF NOT EXISTS idx_field_blackouts_field_date')
  );
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+ (uuid|text|date|integer|timestamptz|boolean)\b/.test(line))
    .map((line) => line.split(' ')[0])
    .sort();
};

/** Column aliases of the `field_closures` view's first arm, from the migration. */
const viewColumns = () => {
  const body = MIGRATION.slice(
    MIGRATION.indexOf('CREATE VIEW public.field_closures'),
    MIGRATION.indexOf('  FROM public.field_blackouts b')
  );
  return body
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => /^(b\.|fb\.|NULL::|')/.test(line))
    .map((line) => {
      const alias = line.match(/ AS ([a-z_]+)$/);
      return alias ? alias[1] : line.replace(/^[a-z]+\./, '');
    })
    .sort();
};

describe('blackout mock contract :: the migration is the source of the shape', () => {
  it('parses a non-empty column set out of the migration', () => {
    // The meta-assertion. A parser that matched nothing would make every
    // comparison below pass by comparing two empty lists.
    expect(tableColumns().length).toBeGreaterThanOrEqual(10);
    expect(viewColumns().length).toBeGreaterThanOrEqual(10);
    expect(tableColumns()).toContain('created_by');
    expect(viewColumns()).toContain('closes_location_id');
  });

  it('gives a mock blackout row every column the table declares', async () => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
    const field = getMockData('fields').find((f) => String(f.organization_id) === ORG);
    const { data, error } = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
      p_reason: 'maintenance',
    });
    expect(error).toBeNull();
    // Exact: a column the table has and the mock does not is a row shape the
    // database produces and the E2E suite never sees.
    expect(Object.keys(data).sort()).toEqual(tableColumns());
  });

  it('exposes field_closures with the view s columns, scope split from derivation', async () => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
    const field = getMockData('fields').find((f) => String(f.organization_id) === ORG);
    await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: field.location_id,
      p_field_id: null,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    });
    await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2026-09-01',
      p_blackout_until: '2026-09-02',
    });

    const closures = getMockData('field_closures');
    expect(closures).toHaveLength(2);
    expect(Object.keys(closures[0]).sort()).toEqual(viewColumns());

    // **Scope is not derivation.** Exactly one row closes the site; the
    // field-scoped row carries its field's location without claiming the site
    // as its scope. This is the HIGH the view was rewritten for.
    const siteScoped = closures.filter((c) => c.closes_location_id === field.location_id);
    expect(siteScoped).toHaveLength(1);
    const fieldScoped = closures.find((c) => c.closes_field_id === field.id);
    expect(fieldScoped.closes_location_id).toBeNull();
    expect(fieldScoped.field_location_id).toBe(field.location_id);
  });

  it('records a before and an after audit entry for each blackout write', async () => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    setMockSession('mock-admin-id');
    const field = getMockData('fields').find((f) => String(f.organization_id) === ORG);
    const { data } = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: ORG,
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2026-08-01',
      p_blackout_until: '2026-08-31',
    });
    const phasesFor = (op) =>
      getMockData('audit_log')
        .filter((e) => e.metadata?.operation === op)
        .map((e) => e.metadata.phase)
        .sort();
    expect(phasesFor('admin_create_field_blackout')).toEqual(['after', 'before']);

    await supabase.rpc('admin_delete_field_blackout', {
      p_organization_id: ORG,
      p_blackout_id: data.id,
    });
    expect(phasesFor('admin_delete_field_blackout')).toEqual(['after', 'before']);

    // The migration says both phases, so the mock must too. Checked against the
    // migration text rather than against this file's own expectation.
    expect(MIGRATION).toContain("'phase', 'before'");
    expect(MIGRATION).toContain("'phase', 'after'");
  });
});

describe('field blackout mock contract :: a deleted blackout is tombstoned', () => {
  it('records the tombstone every other hard delete records', async () => {
    // **What this asserts, and what it deliberately does not.**
    //
    // `getDB()` re-merges its sources on every read and only `markMockDeleted`
    // survives that merge, which is why `admin_delete_field` was found
    // reporting `deleted: true` for a SEEDED field that came straight back. Its
    // blackout twin never got the same fix.
    //
    // For blackouts the consequence is not reachable TODAY, and saying so is
    // the point: `initialMockData.field_blackouts` is empty, and `saveDB()`
    // overwrites `window.__MOCK_DB__`, so neither merge source can hold a
    // blackout to resurrect. Two attempts to write a failing behavioural test
    // for it passed without the fix -- they proved the row was gone, which it
    // was either way.
    //
    // So this checks the MECHANISM rather than staging an outcome that cannot
    // happen: the delete records the tombstone, like every other hard delete in
    // this client. That assertion does fail when the call is removed, and it is
    // the thing that keeps this arm consistent with its siblings for the moment
    // a blackout does come from the seed or a re-merged injection.
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: 'mock-admin-id' } }));

    const field = getMockData('fields').find((f) => String(f.organization_id) === 'org-1');
    const { data: created } = await supabase.rpc('admin_create_field_blackout', {
      p_organization_id: 'org-1',
      p_location_id: null,
      p_field_id: field.id,
      p_blackout_from: '2099-08-01',
      p_blackout_until: '2099-08-31',
    });
    expect(getMockData('__deleted__')?.field_blackouts ?? []).not.toContain(created.id);

    const { error } = await supabase.rpc('admin_delete_field_blackout', {
      p_organization_id: 'org-1',
      p_blackout_id: created.id,
    });
    expect(error).toBeNull();
    expect(getMockData('field_blackouts').some((b) => b.id === created.id)).toBe(false);
    expect(getMockData('__deleted__')?.field_blackouts ?? []).toContain(created.id);
  });
});
