import { describe, expect, it } from 'vitest';
import { isSlotOnField } from '../frontend/src/utils/gameGridCells.js';

describe('isSlotOnField: the one rule for where a game can go in the grid', () => {
  it("accepts a slot on its own field, by value, whatever the ids' types", () => {
    expect(isSlotOnField({ fieldId: 'v1' }, 'v1')).toBe(true);
    expect(isSlotOnField({ fieldId: 7 }, '7')).toBe(true);
  });

  it("refuses another field's slot", () => {
    expect(isSlotOnField({ fieldId: 'v2' }, 'v1')).toBe(false);
  });

  it('offers a slot with no field under every field', () => {
    expect(isSlotOnField({ fieldId: null }, 'v1')).toBe(true);
    expect(isSlotOnField({}, 'v2')).toBe(true);
  });

  it('refuses a cell whose slot is not known', () => {
    expect(isSlotOnField(undefined, 'v1')).toBe(false);
    expect(isSlotOnField(null, 'v1')).toBe(false);
  });
});
