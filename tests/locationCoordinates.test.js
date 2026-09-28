/**
 * 8.9 PR 3: venue coordinates -- the core schema and the mock RPC.
 *
 * The database half (the CHECKs, the real RPC, its audit row and its revert)
 * is proven by `docs/sql/20260930000000_smoke.sql` under
 * `scripts/dbharness/run.sh`, with a plant per claim in `prove.sh`. This file
 * proves the two things the app owns: `LocationCoordinatesSchema` states the
 * same contract as the RPC, and the mock client refuses what the RPC refuses.
 *
 * **Every coordinate here is synthetic** (40.00/-75.00, 41.50/-73.50 and the
 * range boundaries). No venue's real position is in this file.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { LocationCoordinatesSchema } from '../packages/core/src/facility/index.js';
import { mockSupabase as supabase } from '../frontend/src/lib/mockSupabaseClient.js';
import { seedMockDb } from './helpers/seedMockDb.js';

const ok = (value) => LocationCoordinatesSchema.safeParse(value).success;

describe('LocationCoordinatesSchema', () => {
  it('accepts a synthetic pair and the explicit clear', () => {
    expect(LocationCoordinatesSchema.parse({ latitude: 40.0, longitude: -75.0 })).toEqual({
      latitude: 40.0,
      longitude: -75.0,
    });
    expect(ok({ latitude: 41.5, longitude: -73.5 })).toBe(true);
    expect(ok({ latitude: null, longitude: null })).toBe(true);
  });

  it('accepts every range boundary, inclusive', () => {
    for (const latitude of [-90, 90]) {
      for (const longitude of [-180, 180]) {
        expect(ok({ latitude, longitude })).toBe(true);
      }
    }
  });

  it('refuses just past each boundary', () => {
    expect(ok({ latitude: 90.01, longitude: 0 })).toBe(false);
    expect(ok({ latitude: -90.01, longitude: 0 })).toBe(false);
    expect(ok({ latitude: 0, longitude: 180.01 })).toBe(false);
    expect(ok({ latitude: 0, longitude: -180.01 })).toBe(false);
    // Judged as given, before the RPC's rounding -- the RPC's contract too.
    expect(ok({ latitude: 90.004, longitude: 0 })).toBe(false);
  });

  it('refuses a half pair either way round', () => {
    expect(ok({ latitude: 40.0, longitude: null })).toBe(false);
    expect(ok({ latitude: null, longitude: -75.0 })).toBe(false);
  });

  it('refuses an omitted key rather than reading it as a clear', () => {
    expect(ok({})).toBe(false);
    expect(ok({ latitude: 40.0 })).toBe(false);
    expect(ok({ longitude: -75.0 })).toBe(false);
  });

  it('refuses non-numeric input', () => {
    expect(ok({ latitude: '40.00', longitude: '-75.00' })).toBe(false);
    expect(ok({ latitude: Number.NaN, longitude: -75.0 })).toBe(false);
    expect(ok({ latitude: 40.0, longitude: Number.POSITIVE_INFINITY })).toBe(false);
    expect(ok({ latitude: true, longitude: -75.0 })).toBe(false);
    expect(ok({ latitude: undefined, longitude: undefined })).toBe(false);
    expect(ok(null)).toBe(false);
  });

  it('refuses an unknown key (strict, like every facility schema)', () => {
    expect(ok({ latitude: 40.0, longitude: -75.0, address: 'x' })).toBe(false);
  });
});

describe('mock admin_set_location_coordinates', () => {
  const setSession = (userId) =>
    sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));

  beforeEach(() => {
    sessionStorage.clear();
    delete window.__MOCK_DB__;
    seedMockDb({
      organization_members: [
        { organization_id: 'org-c', profile_id: 'coord-admin', role: 'admin' },
        { organization_id: 'org-c', profile_id: 'coord-coach', role: 'coach' },
        { organization_id: 'org-d', profile_id: 'coord-outsider', role: 'admin' },
      ],
      locations: [
        { id: 'loc-c', organization_id: 'org-c', name: 'Coordinate Park' },
        { id: 'loc-d', organization_id: 'org-d', name: 'Elsewhere Park' },
      ],
    });
    setSession('coord-admin');
  });

  const set = (latitude, longitude, locationId = 'loc-c') =>
    supabase.rpc('admin_set_location_coordinates', {
      p_location_id: locationId,
      p_latitude: latitude,
      p_longitude: longitude,
    });

  const coordinateAudit = () =>
    /** @type {Array<Record<string, any>>} */ (
      /** @type {any} */ (window).__MOCK_DB__?.audit_log || []
    ).filter((row) => row.action === 'location.coordinates_set' && row.resource_id === 'loc-c');

  it('rounds to 2 decimals and audits before and after', async () => {
    const { data, error } = await set(40.125, -75.125);
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: 'loc-c', latitude: 40.13, longitude: -75.13 });
    expect(data.coordinates_set_by).toBe('coord-admin');

    const audit = coordinateAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      organization_id: 'org-c',
      resource_type: 'location',
      metadata: {
        operation: 'set',
        before: { latitude: null, longitude: null },
        after: { latitude: 40.13, longitude: -75.13 },
      },
    });
  });

  it('rounds half away from zero, and values under 0.005 to 0, like Postgres round()', async () => {
    expect((await set(1.005, -1.005)).data).toMatchObject({ latitude: 1.01, longitude: -1.01 });
    expect((await set(1e-7, -0.004)).data).toMatchObject({ latitude: 0, longitude: 0 });
  });

  it('refuses a coach and another organisation’s admin (42501), writing nothing', async () => {
    setSession('coord-coach');
    expect((await set(41.5, -73.5)).error?.code).toBe('42501');
    setSession('coord-outsider');
    expect((await set(41.5, -73.5)).error?.code).toBe('42501');
    expect(coordinateAudit()).toHaveLength(0);
    // The positive control: the outsider is an admin, of their own venue.
    const own = await set(41.5, -73.5, 'loc-d');
    expect(own.error).toBeNull();
  });

  it('refuses a half pair and an out-of-range pair (22023)', async () => {
    const refusals = [
      [41.5, null],
      [null, -73.5],
      [90.01, 0],
      [-90.01, 0],
      [0, 180.01],
      [0, -180.01],
      [90.004, 0],
      [Number.NaN, 0],
      ['40.00', '-75.00'],
    ];
    for (const [latitude, longitude] of refusals) {
      const { data, error } = await set(latitude, longitude);
      expect(error?.code, `${latitude}/${longitude}`).toBe('22023');
      expect(data).toBeNull();
    }
    expect(coordinateAudit()).toHaveLength(0);
    // The positive control: the boundaries are accepted.
    expect((await set(90, 180)).error).toBeNull();
    expect((await set(-90, -180)).error).toBeNull();
  });

  it('clears with NULL, NULL and audits the clear', async () => {
    await set(40.0, -75.0);
    const { data, error } = await set(null, null);
    expect(error).toBeNull();
    expect(data).toMatchObject({ latitude: null, longitude: null });
    const audit = coordinateAudit();
    expect(audit).toHaveLength(2);
    expect(audit[1].metadata).toEqual({
      operation: 'cleared',
      before: { latitude: 40, longitude: -75 },
      after: { latitude: null, longitude: null },
    });
  });

  it('refuses a missing location (P0002) and a missing id (23502)', async () => {
    expect((await set(40.0, -75.0, 'loc-nowhere')).error?.code).toBe('P0002');
    expect((await set(40.0, -75.0, null)).error?.code).toBe('23502');
  });
});
