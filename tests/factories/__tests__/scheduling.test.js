import { describe, it, expect } from 'vitest';
import { makeField, makeGameSlot, makePracticeAssignment } from '../scheduling.js';
import { MOCK_ORG_ID } from '../../../frontend/src/lib/mockSeedIds.js';

describe('makeField', () => {
  it('returns deterministic defaults with no args', () => {
    const f = makeField();
    expect(f.id).toBe('field-1');
    expect(f.location_id).toBe('loc-1');
    expect(f.organization_id).toBe(MOCK_ORG_ID);
    expect(f.name).toBe('Field 1');
    expect(f.surface_type).toBe('grass');
    expect(f.supports_halves).toBe(false);
  });

  it('merges overrides, with override keys winning', () => {
    const f = makeField({ name: 'Turf A', surface_type: 'turf' });
    expect(f.name).toBe('Turf A');
    expect(f.surface_type).toBe('turf');
    expect(f.id).toBe('field-1');
  });

  it('respects explicit undefined overrides', () => {
    const f = makeField({ surface_type: undefined });
    expect(f.surface_type).toBeUndefined();
  });
});

describe('makeGameSlot', () => {
  it('returns deterministic defaults with no args', () => {
    const gs = makeGameSlot();
    expect(gs.id).toBe('gs-1');
    expect(gs.field_id).toBe('field-1');
    expect(gs.slot_date).toBe('2026-09-05');
    expect(gs.start_time).toBe('09:00');
    expect(gs.end_time).toBe('10:00');
    expect(gs.week_index).toBe(1);
  });

  it('merges overrides, with override keys winning', () => {
    const gs = makeGameSlot({ start_time: '10:30', week_index: 3 });
    expect(gs.start_time).toBe('10:30');
    expect(gs.week_index).toBe(3);
    expect(gs.end_time).toBe('10:00');
  });

  it('respects explicit undefined overrides', () => {
    const gs = makeGameSlot({ start_time: undefined });
    expect(gs.start_time).toBeUndefined();
  });
});

describe('makePracticeAssignment', () => {
  it('returns deterministic defaults with no args', () => {
    const pa = makePracticeAssignment();
    expect(pa.id).toBe('pa-1');
    expect(pa.team_id).toBe('team-1');
    expect(pa.practice_slot_id).toBe('ps-1');
    expect(pa.effective_date_range).toBe('[2026-09-01,2026-12-01)');
    expect(pa.source).toBe('auto');
  });

  it('merges overrides, with override keys winning', () => {
    const pa = makePracticeAssignment({ team_id: 'team-2', source: 'manual' });
    expect(pa.team_id).toBe('team-2');
    expect(pa.source).toBe('manual');
    expect(pa.practice_slot_id).toBe('ps-1');
  });

  it('respects explicit undefined overrides', () => {
    const pa = makePracticeAssignment({ source: undefined });
    expect(pa.source).toBeUndefined();
  });
});
