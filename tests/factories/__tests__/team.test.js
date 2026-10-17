import { describe, it, expect } from 'vitest';
import { makeTeam, makeTeamPlayer } from '../team.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

describe('makeTeam', () => {
  it('returns deterministic defaults with no args', () => {
    const t = makeTeam();
    expect(t.id).toBe('team-1');
    expect(t.division_id).toBe('div-1');
    expect(t.organization_id).toBe(MOCK_ORG_ID);
    expect(t.name).toBe('Test Team');
    expect(t.coach_id).toBeNull();
    expect(t.assistant_coach_ids).toEqual([]);
    expect(t.practice_slot_id).toBeNull();
  });

  it('merges overrides, with override keys winning', () => {
    const t = makeTeam({ name: 'Tigers', coach_id: 'coach-1' });
    expect(t.name).toBe('Tigers');
    expect(t.coach_id).toBe('coach-1');
    expect(t.id).toBe('team-1');
  });

  it('respects explicit undefined overrides', () => {
    const t = makeTeam({ name: undefined });
    expect(t.name).toBeUndefined();
  });
});

describe('makeTeamPlayer', () => {
  it('returns deterministic defaults with no args', () => {
    expect(makeTeamPlayer()).toEqual({
      team_id: 'team-1',
      player_id: 'player-1',
      role: 'player',
      source: 'auto',
      added_at: '2026-01-01T00:00:00Z',
    });
  });

  it('merges overrides, with override keys winning', () => {
    const tp = makeTeamPlayer({ team_id: 'team-2', source: 'manual' });
    expect(tp.team_id).toBe('team-2');
    expect(tp.source).toBe('manual');
    expect(tp.role).toBe('player');
  });

  it('respects explicit undefined overrides', () => {
    const tp = makeTeamPlayer({ role: undefined });
    expect(tp.role).toBeUndefined();
  });
});
