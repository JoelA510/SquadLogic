/**
 * **The scope rule itself, read directly from the producer.**
 *
 * `tests/fieldLifecycleScenarios.test.js` exercises the scopes through the
 * RPCs, which is where they matter. This file reaches
 * `mockFieldBookings` and `mockEstateContainedNodes` directly, for the one
 * thing an RPC cannot express: **every arm passes a literal scope, so no
 * behavioural test can make the unknown-scope guard fire.** A mutation plant
 * that removed it scored NOT CAUGHT, which is the "a guard nothing can make
 * fail is not a guard" rule landing on the guard written to prevent a silent
 * empty set. It is reachable here, so it is enforced here.
 *
 * The scope semantics are pinned against the same estate the SQL smoke uses,
 * with the literals written out rather than derived from the other arm.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mockFieldBookings,
  mockEstateContainedNodes,
} from '../frontend/src/lib/mockSupabaseClient.js';

const ORG = 'org-estate';

/**
 * One venue, two pitches, a sub-surface on the first, three bookings.
 *
 * Built as a plain object rather than through the client, because these two
 * functions take the database as an argument: the point is the reading, not
 * the seeding, and a seeding layer here would only add a second thing that
 * can be wrong.
 */
const estate = () => ({
  locations: [{ id: 'v1', organization_id: ORG, name: 'Estate Park', effective_to: null }],
  fields: [
    { id: 'pa', organization_id: ORG, location_id: 'v1', name: 'Pitch A', active: true },
    { id: 'pb', organization_id: ORG, location_id: 'v1', name: 'Pitch B', active: true },
    // A pitch at ANOTHER venue, carrying a booking. Nothing scoped to `v1`
    // may ever report it, which is what makes the location filter a filter
    // rather than an org-wide sweep.
    { id: 'px', organization_id: ORG, location_id: 'v2', name: 'Other Pitch', active: true },
  ],
  field_subunits: [
    { id: 's1', organization_id: ORG, field_id: 'pa', label: 'Pitch A North', effective_to: null },
  ],
  game_slots: [
    { id: 'gs-a', organization_id: ORG, field_id: 'pa', slot_date: '2026-10-10', week_index: 1 },
    { id: 'gs-x', organization_id: ORG, field_id: 'px', slot_date: '2026-10-10', week_index: 1 },
  ],
  practice_slots: [
    { id: 'ps-b', organization_id: ORG, field_id: 'pb', valid_until: '2026-10-20' },
    // Carries BOTH the parent pitch's id and the sub-surface's, because
    // `practice_slots.field_id` is NOT NULL. This is the row the three scopes
    // disagree about.
    {
      id: 'ps-sub',
      organization_id: ORG,
      field_id: 'pa',
      field_subunit_id: 's1',
      valid_until: '2026-10-30',
    },
  ],
});

let db;
beforeEach(() => {
  db = estate();
});

const ids = (rows) => rows.map((row) => String(row.id)).sort();

describe('mockFieldBookings :: the scope refuses what it cannot answer', () => {
  it('THROWS on a scope it does not recognise, rather than returning nothing', () => {
    // The reason this file exists. An empty result here would be a guard
    // reporting "nothing is booked on this ground" because somebody misspelled
    // the scope -- the loudest possible version of the silent pass.
    expect(() => mockFieldBookings(db, ORG, 'v1', null, 'venue')).toThrow(
      /unknown booking scope venue/
    );
    expect(() => mockFieldBookings(db, ORG, 'v1', null, null)).toThrow(/unknown booking scope/);
    expect(() => mockFieldBookings(db, ORG, 'v1', null, '')).toThrow(/unknown booking scope/);
  });

  it('THROWS on a missing organization or scope id', () => {
    // `public.field_bookings` raises 22023 for both. A mock that answered an
    // empty list would let a caller with an undefined id conclude the ground
    // is free.
    expect(() => mockFieldBookings(db, null, 'v1', null, 'field')).toThrow(
      /requires an organization/
    );
    expect(() => mockFieldBookings(db, ORG, undefined, null, 'location')).toThrow(
      /requires an organization/
    );
  });

  it('defaults to field scope, which is what the three pre-existing callers ask', () => {
    expect(ids(mockFieldBookings(db, ORG, 'pa', null))).toEqual(
      ids(mockFieldBookings(db, ORG, 'pa', null, 'field'))
    );
  });
});

describe('mockFieldBookings :: what each scope reaches', () => {
  it('field scope takes everything on that pitch and nothing on its neighbour', () => {
    // Pitch A carries the game slot AND the sub-surface practice, because the
    // latter's `field_id` is the parent's.
    expect(ids(mockFieldBookings(db, ORG, 'pa', null, 'field'))).toEqual(['gs-a', 'ps-sub']);
    expect(ids(mockFieldBookings(db, ORG, 'pb', null, 'field'))).toEqual(['ps-b']);
  });

  it('location scope spans EVERY pitch at the venue, and no other venue', () => {
    // **The assertion the whole migration exists for.** A field-scoped answer
    // to this question returns one pitch worth and is wrong by exactly the
    // rows an operator would then lose without warning.
    expect(ids(mockFieldBookings(db, ORG, 'v1', null, 'location'))).toEqual([
      'gs-a',
      'ps-b',
      'ps-sub',
    ]);
    // `gs-x` sits at v2 and must never appear.
    expect(ids(mockFieldBookings(db, ORG, 'v1', null, 'location'))).not.toContain('gs-x');
    expect(ids(mockFieldBookings(db, ORG, 'v2', null, 'location'))).toEqual(['gs-x']);
  });

  it('subunit scope is NARROWER than the pitch it sits on', () => {
    // A game on the full pitch is not a booking on its half. Reporting it
    // would refuse retirements that strand nothing, and an operator who has
    // learned to confirm past a guard has no guard.
    expect(ids(mockFieldBookings(db, ORG, 's1', null, 'subunit'))).toEqual(['ps-sub']);
  });

  it('reports the pitch on every row, so a venue-scoped list is attributable', () => {
    const byId = Object.fromEntries(
      mockFieldBookings(db, ORG, 'v1', null, 'location').map((row) => [row.id, row.field_id])
    );
    expect(byId).toEqual({ 'gs-a': 'pa', 'ps-b': 'pb', 'ps-sub': 'pa' });
  });

  it('is inclusive on p_after, in every scope', () => {
    // The last booking at this venue runs to 2026-10-30.
    expect(mockFieldBookings(db, ORG, 'v1', '2026-10-30', 'location')).toHaveLength(0);
    expect(ids(mockFieldBookings(db, ORG, 'v1', '2026-10-29', 'location'))).toEqual(['ps-sub']);
    expect(mockFieldBookings(db, ORG, 's1', '2026-10-30', 'subunit')).toHaveLength(0);
    expect(ids(mockFieldBookings(db, ORG, 's1', '2026-10-29', 'subunit'))).toEqual(['ps-sub']);
  });

  it('is organization-scoped in every scope', () => {
    expect(mockFieldBookings(db, 'other-org', 'v1', null, 'location')).toHaveLength(0);
    expect(mockFieldBookings(db, 'other-org', 'pa', null, 'field')).toHaveLength(0);
    expect(mockFieldBookings(db, 'other-org', 's1', null, 'subunit')).toHaveLength(0);
  });
});

describe('mockEstateContainedNodes :: what a venue holds', () => {
  it('enumerates from the estate, not from anything a retirement writes', () => {
    const rows = mockEstateContainedNodes(db, ORG, 'v1', '2026-09-01');
    expect(rows.map((row) => `${row.kind}:${row.id}`)).toEqual([
      'field:pa',
      'field:pb',
      'field_subunit:s1',
    ]);
    // Nothing is already retired: a venue retirement writes no child state, so
    // a set gathered from child state would be empty for every venue.
    expect(rows.every((row) => row.already_retired === false)).toBe(true);
  });

  it('marks a child whose own window already ends no later than this date', () => {
    db.field_subunits[0].effective_to = '2026-08-01';
    const rows = mockEstateContainedNodes(db, ORG, 'v1', '2026-09-01');
    expect(rows.filter((row) => row.already_retired).map((row) => row.id)).toEqual(['s1']);
    // ... and NOT one whose window ends later: this retirement really does
    // close it, so claiming otherwise would understate what the operator did.
    db.field_subunits[0].effective_to = '2026-12-01';
    expect(
      mockEstateContainedNodes(db, ORG, 'v1', '2026-09-01').filter((row) => row.already_retired)
    ).toHaveLength(0);
  });

  it('marks nothing already retired when no date is being applied', () => {
    // The unretire arm passes null: a child with its own window stays retired
    // by that window, and this call does not claim to have restored it.
    db.field_subunits[0].effective_to = '2026-08-01';
    expect(
      mockEstateContainedNodes(db, ORG, 'v1', null).filter((row) => row.already_retired)
    ).toHaveLength(0);
  });

  it('holds nothing of another venue or another organization', () => {
    expect(mockEstateContainedNodes(db, ORG, 'v2', null).map((row) => row.id)).toEqual(['px']);
    expect(mockEstateContainedNodes(db, 'other-org', 'v1', null)).toHaveLength(0);
  });
});
