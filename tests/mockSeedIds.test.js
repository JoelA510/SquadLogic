/**
 * The mock seed's organization and season ids pass the two schemas that once
 * refused them: core's `SlotSchema` (`organization_id`) and the auto-scheduler's
 * request schema (`organizationId`, `seasonSettingsId`). With `org-1` and
 * `season-1` every seeded game slot was refused, so Generate Schedule never
 * succeeded in mock mode (remediation plan, Wave 0).
 *
 * The ids are read from the seeded store, not only from the constants, so a seed
 * that drifts from `mockSeedIds.js` fails here too.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getMockData } from '../frontend/src/lib/mockSupabaseClient.js';
import { MOCK_ORG_ID, MOCK_SEASON_ID } from '../frontend/src/lib/mockSeedIds.js';
import { SlotSchema } from '../packages/core/src/schemas/index.js';
import { AutoSchedulerInputSchema } from '../supabase/functions/_shared/schemas/auto-scheduler.js';

/** A request the practice page could send, for the given organization and season. */
const autoSchedulerRequest = (organizationId, seasonSettingsId) => ({
  organizationId,
  seasonSettingsId,
  teams: [{ id: 't1', division: 'U8 Coed', coachId: 'mock-coach-id' }],
  slots: [{ id: 'ps-1', start: '2026-09-01T17:00:00Z', end: '2026-09-01T18:30:00Z', capacity: 2 }],
});

describe('the mock seed ids', () => {
  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
  });

  it('are the ids the mock seeds its organization and season with', () => {
    expect(getMockData('organizations').map((row) => row.id)).toEqual([MOCK_ORG_ID]);
    expect(getMockData('season_settings')).toEqual([
      expect.objectContaining({ id: MOCK_SEASON_ID, organization_id: MOCK_ORG_ID }),
    ]);
  });

  it("pass core's SlotSchema on every seeded game slot", () => {
    const slots = getMockData('game_slots');
    // Meta-assertion: there are slots to examine, and each carries the id
    // (`organization_id` is optional in the schema, so a row without one would
    // pass without its id ever being read).
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.organization_id).toBe(MOCK_ORG_ID);
      const parsed = SlotSchema.safeParse(slot);
      expect(parsed.success, `${slot.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("pass the auto-scheduler's request schema", () => {
    const [organization] = getMockData('organizations');
    const [season] = getMockData('season_settings');
    const parsed = AutoSchedulerInputSchema.safeParse(
      autoSchedulerRequest(organization.id, season.id)
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  // The control: both schemas still refuse the ids the seed used to carry, so
  // the two tests above pass because the ids changed, not because a schema
  // stopped checking them.
  it('the ids the seed used to carry are refused by both schemas', () => {
    const [slot] = getMockData('game_slots');
    const slotParse = SlotSchema.safeParse({ ...slot, organization_id: 'org-1' });
    expect(slotParse.success).toBe(false);
    expect(slotParse.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'organization_id',
    ]);

    const requestParse = AutoSchedulerInputSchema.safeParse(
      autoSchedulerRequest('org-1', 'season-1')
    );
    expect(requestParse.success).toBe(false);
    expect(requestParse.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual([
      'organizationId',
      'seasonSettingsId',
    ]);
  });
});
