/**
 * The mock refuses an ambiguous `practice_slots` embed the way PostgREST does
 * (fix #64).
 *
 * It used to resolve `practice_slots(...)` off `practice_assignments` through
 * `slot_id` and never err, so every unhinted reader passed E2E while failing
 * with PGRST201 in production. The seeded row below carries DIFFERENT values
 * in the two FK columns, so a hinted embed that joined on the wrong one would
 * return the wrong slot rather than pass by coincidence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockSupabase } from '../frontend/src/lib/mockSupabaseClient.js';

const ORG = 'org-embed-test';

const slotRow = (id, day) => ({
  id,
  day_of_week: day,
  start_time: '17:00',
  end_time: '18:30',
  field_id: 'f-x',
  organization_id: ORG,
});

beforeEach(() => {
  sessionStorage.clear();
  // Through the sanctioned producer (`tests/mockDeleteTombstones.test.js`).
  window.__saveMockDB__({
    practice_slots: [slotRow('ps-legacy', 'tue'), slotRow('ps-live', 'mon')],
    practice_assignments: [
      {
        id: 'pa-embed',
        organization_id: ORG,
        team_id: 'team-embed',
        slot_id: 'ps-legacy',
        practice_slot_id: 'ps-live',
        effective_date_range: '[2026-11-02,2026-11-17)',
      },
    ],
  });
});

afterEach(() => {
  delete window.__MOCK_DB__;
  sessionStorage.clear();
});

describe('mock: practice_assignments -> practice_slots embed', () => {
  it('an unhinted embed errs with PGRST201 and returns no data', async () => {
    const { data, error } = await mockSupabase
      .from('practice_assignments')
      .select('id, slot:practice_slots (day_of_week)')
      .eq('team_id', 'team-embed');
    expect(data).toBeNull();
    expect(error?.code).toBe('PGRST201');
    expect(error?.message).toContain('practice_slots!practice_slot_id');
  });

  it('errs even when no row matches: the ambiguity is in the schema, not the data', async () => {
    const { error } = await mockSupabase
      .from('practice_assignments')
      .select('id, practice_slots ( day_of_week )')
      .eq('team_id', 'no-such-team');
    expect(error?.code).toBe('PGRST201');
  });

  it('a column hint resolves through THAT column, under its alias', async () => {
    const { data, error } = await mockSupabase
      .from('practice_assignments')
      .select('id, slot:practice_slots!practice_slot_id (day_of_week)')
      .eq('team_id', 'team-embed');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data[0].slot?.id).toBe('ps-live');
    expect(data[0].slot?.day_of_week).toBe('mon');

    const legacy = await mockSupabase
      .from('practice_assignments')
      .select('id, practice_slots!slot_id (day_of_week)')
      .eq('team_id', 'team-embed');
    expect(legacy.error).toBeNull();
    expect(legacy.data[0].practice_slots?.id).toBe('ps-legacy');
  });

  it('a join modifier is not a hint: !inner alone errs, a column hint plus !inner resolves', async () => {
    const bare = await mockSupabase
      .from('practice_assignments')
      .select('id, practice_slots!inner (day_of_week)');
    expect(bare.error?.code).toBe('PGRST201');
    const hinted = await mockSupabase
      .from('practice_assignments')
      .select('id, slot:practice_slots!practice_slot_id!inner (day_of_week)')
      .eq('team_id', 'team-embed');
    expect(hinted.error).toBeNull();
    expect(hinted.data[0].slot?.id).toBe('ps-live');
  });

  it('a hint naming no FK column errs (PGRST200) rather than guessing', async () => {
    const { data, error } = await mockSupabase
      .from('practice_assignments')
      .select('id, practice_slots!team_id (day_of_week)');
    expect(data).toBeNull();
    expect(error?.code).toBe('PGRST200');
  });
});
