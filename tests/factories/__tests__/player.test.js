import { describe, it, expect } from 'vitest';
import { makePlayer } from '../player.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

describe('makePlayer', () => {
  it('returns deterministic defaults with no args', () => {
    const p = makePlayer();
    expect(p.id).toBe('player-1');
    expect(p.division_id).toBe('div-1');
    expect(p.organization_id).toBe(MOCK_ORG_ID);
    expect(p.external_registration_id).toBe('ext-reg-1');
    expect(p.first_name).toBe('Test');
    expect(p.last_name).toBe('Player');
    expect(p.guardian_contacts).toEqual([]);
    expect(p.coach_volunteer).toBe(false);
  });

  it('merges overrides, with override keys winning', () => {
    const p = makePlayer({ first_name: 'Alex', skill_tier: 'advanced' });
    expect(p.first_name).toBe('Alex');
    expect(p.skill_tier).toBe('advanced');
    expect(p.last_name).toBe('Player');
  });

  it('respects explicit undefined overrides', () => {
    const p = makePlayer({ first_name: undefined });
    expect(p.first_name).toBeUndefined();
  });
});
