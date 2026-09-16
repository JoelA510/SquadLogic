/**
 * `isFieldOfferableOn` — the reading that replaced the scheduler's
 * `.eq('active', true)`.
 *
 * This is the guarantee 8.4's retire path is for: an end date the operator sets
 * has to actually remove the ground from the scheduler's list on the day it
 * takes effect. `fields.active` cannot do that on its own, because the trigger
 * that maintains it fires on write and reads `current_date`.
 */

import { describe, it, expect } from 'vitest';
import { isFieldOfferableOn } from '../frontend/src/utils/fieldLifecycle.js';

describe('isFieldOfferableOn', () => {
  it('offers live, undated ground', () => {
    expect(isFieldOfferableOn({ active: true, effective_to: null }, '2026-09-16')).toBe(true);
    expect(isFieldOfferableOn({ active: true }, '2026-09-16')).toBe(true);
  });

  it('is inclusive on the end date, matching field_is_live_on', () => {
    const field = { active: true, effective_to: '2026-09-30' };
    // `effective_to` is the LAST DAY the ground is usable. The SQL predicate is
    // `effective_to >= d`; disagreeing with it here would make the client offer
    // ground the guard refuses to retire around, or hide ground it allows.
    expect(isFieldOfferableOn(field, '2026-09-30')).toBe(true);
    expect(isFieldOfferableOn(field, '2026-10-01')).toBe(false);
  });

  it('still offers ground whose retirement is in the future', () => {
    // The case the whole change exists for: `active` is written `true` for a
    // future-dated retirement and goes STALE on the day it lands. The date is
    // the authority on both sides of that day.
    const field = { active: true, effective_to: '2026-12-31' };
    expect(isFieldOfferableOn(field, '2026-09-16')).toBe(true);
    expect(isFieldOfferableOn(field, '2027-01-01')).toBe(false);
  });

  it('refuses a null `active`, which the previous server-side filter excluded', () => {
    // `fields.active` is `boolean DEFAULT true` and NULLABLE. `.eq('active',
    // true)` excluded NULL; `row.active !== false` would admit it. Moving a
    // filter from the server to the client must not change what it selects.
    for (const active of [null, undefined, false]) {
      expect([active, isFieldOfferableOn({ active, effective_to: null }, '2026-09-16')]).toEqual([
        active,
        false,
      ]);
    }
  });

  it('refuses a deactivated field whatever its dates say', () => {
    // One-directional, as the migration states: `active = false` with a NULL
    // `effective_to` is ordinary deactivation and is a healthy state.
    expect(isFieldOfferableOn({ active: false, effective_to: '2099-01-01' }, '2026-09-16')).toBe(
      false
    );
  });

  it('refuses a missing row rather than throwing', () => {
    expect(isFieldOfferableOn(/** @type {any} */ (null), '2026-09-16')).toBe(false);
  });
});
