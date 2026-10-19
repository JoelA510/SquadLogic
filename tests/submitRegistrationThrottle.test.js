import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID } from '../frontend/src/lib/mockSeedIds.js';

/**
 * DS-5: the mock `submit_registration` throttles like the RPC.
 *
 * The limit lives in the migration (`v_limit`, `v_window`); the mock copies it.
 * This reads the number the mock actually enforces (by calling it until it
 * refuses) and the number the migration declares, and requires them equal, so
 * neither can move alone.
 */
const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20261019010000_submit_registration_throttle.sql'),
  'utf8'
);

const call = (form, name) =>
  mockSupabase.rpc('submit_registration', {
    p_organization_id: MOCK_ORG_ID,
    p_form_id: form,
    p_profile_id: 'throttle-parent',
    p_responses: {},
    p_player_id: null,
    p_first_name: name,
    p_last_name: 'Throttle',
  });

describe('mock submit_registration throttle', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.__MOCK_DB__ = undefined;
  });

  it('refuses the registration after the migration limit with PT429, per form', async () => {
    const limit = Number(/v_limit\s+constant integer := (\d+);/.exec(MIGRATION)?.[1]);
    expect(limit).toBeGreaterThan(0);
    expect(MIGRATION).toMatch(/v_window\s+constant interval := interval '60 seconds';/);

    let accepted = 0;
    let refusal = null;
    for (let i = 0; i < limit + 5 && !refusal; i += 1) {
      const { error } = await call('form-one', `Child${i}`);
      if (error) refusal = error;
      else accepted += 1;
    }
    expect(accepted).toBe(limit);
    expect(refusal.code).toBe('PT429');

    // A refusal wrote nothing; another form is a separate allowance.
    const { error: otherForm } = await call('form-two', 'Other');
    expect(otherForm).toBeNull();
  });
});
