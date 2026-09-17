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
import {
  isFieldOfferableOn,
  venueOf,
  venueRegistry,
} from '../frontend/src/utils/fieldLifecycle.js';

/** An open venue. Named so every call below says which half it is exercising. */
const OPEN = { id: 'v1', effective_to: null };

describe('isFieldOfferableOn', () => {
  it('offers live, undated ground', () => {
    expect(isFieldOfferableOn({ active: true, effective_to: null }, '2026-09-16', OPEN)).toBe(true);
    expect(isFieldOfferableOn({ active: true }, '2026-09-16', OPEN)).toBe(true);
  });

  it('is inclusive on the end date, matching field_is_live_on', () => {
    const field = { active: true, effective_to: '2026-09-30' };
    // `effective_to` is the LAST DAY the ground is usable. The SQL predicate is
    // `effective_to >= d`; disagreeing with it here would make the client offer
    // ground the guard refuses to retire around, or hide ground it allows.
    expect(isFieldOfferableOn(field, '2026-09-30', OPEN)).toBe(true);
    expect(isFieldOfferableOn(field, '2026-10-01', OPEN)).toBe(false);
  });

  it('still offers ground whose retirement is in the future', () => {
    // The case the whole change exists for: `active` is written `true` for a
    // future-dated retirement and goes STALE on the day it lands. The date is
    // the authority on both sides of that day.
    const field = { active: true, effective_to: '2026-12-31' };
    expect(isFieldOfferableOn(field, '2026-09-16', OPEN)).toBe(true);
    expect(isFieldOfferableOn(field, '2027-01-01', OPEN)).toBe(false);
  });

  it('refuses a null `active`, which the previous server-side filter excluded', () => {
    // `fields.active` is `boolean DEFAULT true` and NULLABLE. `.eq('active',
    // true)` excluded NULL; `row.active !== false` would admit it. Moving a
    // filter from the server to the client must not change what it selects.
    for (const active of [null, undefined, false]) {
      expect([
        active,
        isFieldOfferableOn({ active, effective_to: null }, '2026-09-16', OPEN),
      ]).toEqual([active, false]);
    }
  });

  it('refuses a deactivated field whatever its dates say', () => {
    // One-directional, as the migration states: `active = false` with a NULL
    // `effective_to` is ordinary deactivation and is a healthy state.
    expect(
      isFieldOfferableOn({ active: false, effective_to: '2099-01-01' }, '2026-09-16', OPEN)
    ).toBe(false);
  });

  it('refuses a missing row rather than throwing', () => {
    expect(isFieldOfferableOn(/** @type {any} */ (null), '2026-09-16', OPEN)).toBe(false);
  });
});

/**
 * **Containment: a pitch at a closed site is closed.**
 *
 * 20260911000000 retires a venue by writing one date on one row and copying
 * nothing onto its children, so this is the ONLY place the decision takes
 * effect for the scheduler. Every case below fails against the implementation
 * that ignores the third argument, which is what makes it a test of the
 * decision rather than a restatement of it.
 */
describe('isFieldOfferableOn, containment from the venue', () => {
  /** A pitch with no window of its own. Its whole liveness comes from the site. */
  const undatedPitch = { active: true, effective_to: null };

  it('closes an undated pitch when its venue has closed', () => {
    const closedVenue = { id: 'v1', effective_to: '2026-09-30' };
    // Inclusive on the venue's last day, exactly as on the field's.
    expect(isFieldOfferableOn(undatedPitch, '2026-09-30', closedVenue)).toBe(true);
    expect(isFieldOfferableOn(undatedPitch, '2026-10-01', closedVenue)).toBe(false);
  });

  it('keeps offering a pitch whose venue closes in the future', () => {
    const closingVenue = { id: 'v1', effective_to: '2026-12-31' };
    expect(isFieldOfferableOn(undatedPitch, '2026-09-16', closingVenue)).toBe(true);
  });

  it('takes the NEAREST bound: a pitch retired before its venue is closed first', () => {
    // The lineage answer, not a max. `packages/core/src/facility/lifecycle.js`
    // walks self plus ancestors and requires all of them; taking the venue's
    // date alone would resurrect a pitch its own operator retired in June.
    const pitch = { active: true, effective_to: '2026-06-30' };
    const venue = { id: 'v1', effective_to: '2026-12-31' };
    expect(isFieldOfferableOn(pitch, '2026-07-01', venue)).toBe(false);
    // And the other way round.
    const latePitch = { active: true, effective_to: '2026-12-31' };
    const earlyVenue = { id: 'v1', effective_to: '2026-06-30' };
    expect(isFieldOfferableOn(latePitch, '2026-07-01', earlyVenue)).toBe(false);
  });

  it('refuses a pitch whose venue the read did not produce', () => {
    // `fields.location_id` is `uuid NOT NULL`, so `null` here cannot come from
    // a healthy read: it means the locations query failed or was filtered.
    // Reading that as "unbounded" would offer ground at a site nobody checked.
    expect(isFieldOfferableOn(undatedPitch, '2026-09-16', null)).toBe(false);
  });

  it('THROWS when no venue argument is passed at all', () => {
    // The positive control for the decision itself. A third parameter that
    // defaulted to "unbounded" would let every pre-containment call site keep
    // its old answer while reading as though it had been updated -- the
    // quietest possible way to ship a venue retirement that retires nothing.
    expect(() => /** @type {any} */ (isFieldOfferableOn)(undatedPitch, '2026-09-16')).toThrow(
      /needs the field/
    );
  });
});

describe('venueRegistry / venueOf', () => {
  it('keys venues by id and resolves a field to its own', () => {
    const registry = venueRegistry([
      { id: 'v1', effective_to: null },
      { id: 'v2', effective_to: '2026-06-30' },
    ]);
    expect(venueOf({ location_id: 'v2' }, registry)).toEqual({
      id: 'v2',
      effective_to: '2026-06-30',
    });
  });

  it('returns null for a field whose venue is absent from the read', () => {
    // Enumerated from `locations`, never from the fields: a registry built out
    // of the fields would make every field its own authority and the
    // containment rule unfalsifiable.
    expect(venueOf({ location_id: 'gone' }, venueRegistry([{ id: 'v1' }]))).toBeNull();
    expect(venueOf({ location_id: null }, venueRegistry([{ id: 'v1' }]))).toBeNull();
  });

  it('survives an empty or missing locations read without inventing a venue', () => {
    expect(venueRegistry(/** @type {any} */ (undefined))).toEqual({});
    expect(venueOf({ location_id: 'v1' }, venueRegistry([]))).toBeNull();
  });
});
