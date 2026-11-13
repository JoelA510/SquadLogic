// @vitest-environment jsdom
/**
 * F11-4b task B2 (docs/changes/2026-11-13-settings-scope.md, "Audit"): the Settings audit page shows a scoped setting
 * change (`admin_set_scoped_setting`, a `settings.updated` row with `metadata.setting = 'scoped_setting'`) as a diff,
 * and a null side, which there means "no value at that level", reads "Inherited", not "None".
 *
 * The rows are written by the real mock setter (which holds the SQL's metadata: tests/mockScopedSettings.test.js) and
 * read back through the mock's get_settings_audit_log, as the page reads them.
 */
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedMockDb } from './helpers/seedMockDb.js';

const ORG = 'org-audit-scoped';
const ADMIN = 'admin-audit-scoped';
const KEY = 'standings_count_outside_results';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mockSupabase, supabaseReady: Promise.resolve() };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({
    currentOrganization: { id: 'org-audit-scoped', name: 'Synthetic FC' },
    orgMember: { role: 'admin' },
  }),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { mockSupabase } = await import('../frontend/src/lib/mockSupabaseClient.js');
const { default: SettingsAuditLog } =
  await import('../frontend/src/components/settings/SettingsAuditLog.jsx');

async function set(value) {
  const { error } = await mockSupabase.rpc('admin_set_scoped_setting', {
    p_key: KEY,
    p_scope: 'organization',
    p_scope_id: ORG,
    p_value: value,
  });
  expect(error).toBe(null);
}

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  seedMockDb({
    organizations: [{ id: ORG, name: 'Synthetic FC' }],
    organization_members: [{ organization_id: ORG, profile_id: ADMIN, role: 'admin' }],
    season_settings: [],
    audit_log: [],
  });
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: ADMIN } }));
});
afterEach(() => cleanup());

/** The "Change Details" cell of every row, as text, in the order shown. */
async function changes() {
  const t = await screen.findByRole('table');
  return within(t)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell').at(-1)?.textContent?.trim());
}

describe('SettingsAuditLog :: a scoped setting row', () => {
  it('reads a null side as "Inherited": set from inherited, then back to inherited', async () => {
    await set(true);
    await set(null);
    render(<SettingsAuditLog />);
    expect(await changes()).toEqual([
      `Property: ${KEY}InheritedEnabled`,
      `Property: ${KEY}EnabledInherited`,
    ]);
  });

  it('CONTROL: a field diff that is not a scoped setting still reads a null side as "None"', async () => {
    const { error } = await mockSupabase.rpc('record_audit_event', {
      p_organization_id: ORG,
      p_action: 'settings.updated',
      p_metadata: { field: 'league_name', old: null, new: 'Synthetic FC' },
    });
    expect(error).toBe(null);
    render(<SettingsAuditLog />);
    expect(await changes()).toEqual(['Property: league_nameNoneSynthetic FC']);
  });
});
