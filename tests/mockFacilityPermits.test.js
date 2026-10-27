/**
 * The mock twin of the permit RPCs, their tables' read policies and the `facility-permits` bucket
 * (`frontend/src/lib/mockFacilityPermits.js`). It mirrors the refusals as well as the successes: a
 * mock that accepts what Postgres refuses is the one thing a mock must never do. The cases are the
 * ones `supabase/tests/facility_permits.sql` and `storage_facility_permits_bucket.sql` assert.
 */
import { describe, expect, it } from 'vitest';

import {
  FACILITY_PERMIT_RPCS,
  coachFieldIds,
  createMockStorage,
  handleFacilityPermitRpc,
  permitRowVisible,
  permitsUnlinkedBy,
} from '../frontend/src/lib/mockFacilityPermits.js';

const ORG = 'a1111111-1111-4111-8111-111111111111';
const OTHER_ORG = 'b2222222-2222-4222-8222-222222222222';
const ALICE = 'alice';
const BOB = 'bob';
const CORA = 'cora';
const QUIN = 'quin';
const NOW = new Date('2026-10-27T12:00:00Z');
const V1 = 'f1000000-0000-4000-8000-000000000001';
const V2 = 'f1000000-0000-4000-8000-000000000002';
const F1 = 'f1000000-0000-4000-8000-000000000011';
const F2 = 'f1000000-0000-4000-8000-000000000012';
const F3 = 'f1000000-0000-4000-8000-000000000013';
const F_OTHER = 'f1000000-0000-4000-8000-00000000001b';

const makeDb = () => ({
  organizations: [{ id: ORG }, { id: OTHER_ORG }],
  organization_members: [
    { organization_id: ORG, profile_id: ALICE, role: 'admin' },
    { organization_id: OTHER_ORG, profile_id: BOB, role: 'admin' },
    { organization_id: ORG, profile_id: CORA, role: 'coach' },
    { organization_id: ORG, profile_id: QUIN, role: 'coach' },
  ],
  season_settings: [
    // UTC+14: at 12:00 UTC on the 27th it is already the 28th there.
    { id: 's1', organization_id: ORG, status: 'active', timezone: 'Pacific/Kiritimati' },
  ],
  divisions: [{ id: 'd1', season_settings_id: 's1' }],
  teams: [
    { id: 'tc', organization_id: ORG, division_id: 'd1' },
    { id: 'tq', organization_id: ORG, division_id: 'd1' },
    { id: 'tx', organization_id: ORG, division_id: 'd1' },
  ],
  coaches: [
    { id: 'kc', organization_id: ORG, user_id: CORA },
    { id: 'kq', organization_id: ORG, user_id: QUIN },
  ],
  team_coach_assignments: [
    {
      organization_id: ORG,
      team_id: 'tc',
      coach_id: 'kc',
      effective_from: '2026-01-01',
      effective_to: null,
    },
    {
      organization_id: ORG,
      team_id: 'tq',
      coach_id: 'kq',
      effective_from: '2026-01-01',
      effective_to: null,
    },
  ],
  locations: [
    { id: V1, organization_id: ORG, name: 'Permit Park', effective_to: null },
    { id: V2, organization_id: ORG, name: 'Far Park', effective_to: null },
  ],
  fields: [
    { id: F1, organization_id: ORG, location_id: V1, name: 'Pitch 1', effective_to: null },
    { id: F2, organization_id: ORG, location_id: V1, name: 'Pitch 2', effective_to: null },
    { id: F3, organization_id: ORG, location_id: V2, name: 'Pitch 3', effective_to: null },
    {
      id: F_OTHER,
      organization_id: OTHER_ORG,
      location_id: 'vb',
      name: 'B Pitch',
      effective_to: null,
    },
  ],
  // Cora's team plays at Pitch 1; Quin's practises at Pitch 3.
  game_slots: [{ id: 'gs1', organization_id: ORG, field_id: F1 }],
  games: [
    { id: 'g1', organization_id: ORG, game_slot_id: 'gs1', home_team_id: 'tc', away_team_id: 'tx' },
  ],
  practice_slots: [{ id: 'ps3', organization_id: ORG, field_id: F3 }],
  practice_assignments: [
    { id: 'pa3', organization_id: ORG, team_id: 'tq', practice_slot_id: 'ps3', slot_id: 'ps3' },
  ],
  audit_log: [],
});

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const ctxFor = (db, userId) => ({
  currentUserId: userId,
  now: NOW,
  newId,
  isOrgAdmin: (orgId) =>
    (db.organization_members || []).some(
      (m) =>
        m.organization_id === orgId &&
        m.profile_id === userId &&
        ['admin', 'staff'].includes(m.role)
    ),
});
const call = (db, userId, name, params) =>
  handleFacilityPermitRpc(db, name, params, ctxFor(db, userId));
const create = (db, over = {}) =>
  call(db, ALICE, 'admin_create_facility_permit', {
    p_organization_id: ORG,
    p_issuer: ' Parks Dept ',
    p_permit_number: ' 0042 ',
    p_valid_from: '2026-10-01',
    p_valid_to: '2027-10-01',
    p_notes: null,
    p_location_ids: [],
    p_field_ids: [F1],
    ...over,
  });

describe('the permit RPCs', () => {
  it('lists exactly the five RPCs and ignores any other name', () => {
    expect(FACILITY_PERMIT_RPCS).toHaveLength(5);
    expect(call(makeDb(), ALICE, 'admin_create_field', {})).toBeNull();
  });

  it('creates a permit trimmed, with text number, scopes, a status on the organization day, and one audit row', () => {
    const db = makeDb();
    const { data, error } = create(db);
    expect(error).toBeNull();
    expect(data).toMatchObject({ issuer: 'Parks Dept', permit_number: '0042', file: null });
    expect(data.scopes).toEqual([
      expect.objectContaining({
        kind: 'field',
        field_name: 'Pitch 1',
        location_name: 'Permit Park',
        retired: false,
      }),
    ]);
    expect(db.audit_log).toHaveLength(1);
    expect(db.audit_log[0]).toMatchObject({
      action: 'settings.updated',
      resource_type: 'facility_permit',
      metadata: { setting: 'facility.permit', operation: 'created' },
    });
  });

  it('judges status on the organization day, not the UTC day (the season is UTC+14)', () => {
    const db = makeDb();
    // valid_to is 2026-10-27: the last valid day by UTC, already expired on the 28th in Kiritimati.
    const { data } = create(db, { p_valid_to: '2026-10-27' });
    expect(data.status).toBe('expired');
    expect(data.days_left).toBe(-1);
    const read = call(db, ALICE, 'get_facility_permits', { p_organization_id: ORG });
    expect(read.data.today).toBe('2026-10-28');
  });

  it.each([
    ['dates', { p_valid_from: '2026-10-02', p_valid_to: '2026-10-01' }, '22023'],
    ['no scope', { p_field_ids: [] }, '22023'],
    ['a field of another organization', { p_field_ids: [F_OTHER] }, '22023'],
    [
      'an id that exists nowhere',
      { p_field_ids: ['f1000000-0000-4000-8000-0000000000ff'] },
      '22023',
    ],
    ['a blank issuer', { p_issuer: '   ' }, '22023'],
    ['a number over 100', { p_permit_number: '9'.repeat(101) }, '22023'],
    ['a missing date', { p_valid_from: null }, '23502'],
  ])('refuses %s and writes nothing', (_what, over, code) => {
    const db = makeDb();
    const result = create(db, over);
    expect(result.error.code).toBe(code);
    expect(db.facility_permits ?? []).toHaveLength(0);
    expect(db.audit_log).toHaveLength(0);
  });

  it("refuses a non-admin of the organization and another organization's admin with 42501", () => {
    const db = makeDb();
    expect(
      call(db, CORA, 'admin_create_facility_permit', {
        p_organization_id: ORG,
        p_issuer: 'X',
        p_valid_from: '2026-10-01',
        p_valid_to: '2026-10-02',
        p_field_ids: [F1],
      }).error.code
    ).toBe('42501');
    expect(
      call(db, BOB, 'admin_create_facility_permit', {
        p_organization_id: ORG,
        p_issuer: 'X',
        p_valid_from: '2026-10-01',
        p_valid_to: '2026-10-02',
        p_field_ids: [F1],
      }).error.code
    ).toBe('42501');
    expect(call(db, null, 'get_facility_permits', { p_organization_id: ORG }).error.code).toBe(
      '42501'
    );
    expect(call(db, ALICE, 'get_facility_permits', {}).error.code).toBe('23502');
    expect(db.audit_log).toHaveLength(0);
  });

  it('finds no such permit in another organization (P0002) for update, file and delete', () => {
    const db = makeDb();
    const { data } = create(db);
    const asBob = (name, extra) =>
      call(db, BOB, name, { p_organization_id: OTHER_ORG, p_permit_id: data.id, ...extra });
    expect(asBob('admin_delete_facility_permit').error.code).toBe('P0002');
    expect(
      asBob('admin_set_facility_permit_file', { p_object_path: 'x', p_file_name: 'x.pdf' }).error
        .code
    ).toBe('P0002');
    expect(
      asBob('admin_update_facility_permit', {
        p_issuer: 'X',
        p_valid_from: '2026-10-01',
        p_valid_to: '2026-10-02',
        p_field_ids: [F_OTHER],
      }).error.code
    ).toBe('P0002');
  });

  it('update replaces the scope set and audits the previous and the current permit', () => {
    const db = makeDb();
    const { data } = create(db, { p_field_ids: [F1, F3] });
    const updated = call(db, ALICE, 'admin_update_facility_permit', {
      p_organization_id: ORG,
      p_permit_id: data.id,
      p_issuer: 'Parks Dept',
      p_permit_number: '0042',
      p_valid_from: '2026-10-01',
      p_valid_to: '2027-10-01',
      p_notes: null,
      p_location_ids: [V2],
      p_field_ids: [F1],
    });
    expect(updated.data.scopes.map((s) => s.kind)).toEqual(['location', 'field']);
    expect(updated.data.scopes).toHaveLength(2);
    expect(db.facility_permit_scopes.some((s) => s.field_id === F3)).toBe(false);
    const row = db.audit_log.find((a) => a.metadata.operation === 'updated');
    expect(row.metadata.previous.scopes).toHaveLength(2);
    expect(row.metadata.current.scopes).toHaveLength(2);
  });

  it('delete returns the file path and removes the permit and its scopes; the audit row keeps it', () => {
    const db = makeDb();
    const { data } = create(db);
    db.facility_permits[0].file_path = 'p';
    const result = call(db, ALICE, 'admin_delete_facility_permit', {
      p_organization_id: ORG,
      p_permit_id: data.id,
    });
    expect(result.data).toEqual({ id: data.id, deleted: true, file_path: 'p' });
    expect(db.facility_permits).toHaveLength(0);
    expect(db.facility_permit_scopes).toHaveLength(0);
    expect(db.audit_log.at(-1).metadata).toMatchObject({
      operation: 'deleted',
      previous: { issuer: 'Parks Dept' },
    });
  });
});

describe('the coach read', () => {
  const seeded = () => {
    const db = makeDb();
    create(db, { p_issuer: 'P1', p_field_ids: [F1] });
    create(db, { p_issuer: 'P2', p_field_ids: [], p_location_ids: [V1] });
    create(db, { p_issuer: 'P3', p_field_ids: [F3] });
    create(db, { p_issuer: 'P4', p_field_ids: [F1, F3] });
    create(db, { p_issuer: 'P5', p_field_ids: [F2] });
    return db;
  };
  const issuers = (result) => result.data.permits.map((p) => p.issuer).sort();

  it('derives the fields from games (through the slot) and practices (through the practice slot)', () => {
    const db = makeDb();
    expect([...coachFieldIds(db, ORG, CORA, NOW)]).toEqual([F1]);
    expect([...coachFieldIds(db, ORG, QUIN, NOW)]).toEqual([F3]);
    expect([...coachFieldIds(db, ORG, BOB, NOW)]).toEqual([]);
  });

  it("an admin reads all five; a coach reads only the permits for her team's fields and venue, with only those scopes", () => {
    const db = seeded();
    expect(issuers(call(db, ALICE, 'get_facility_permits', { p_organization_id: ORG }))).toEqual([
      'P1',
      'P2',
      'P3',
      'P4',
      'P5',
    ]);
    const cora = call(db, CORA, 'get_facility_permits', { p_organization_id: ORG });
    expect(issuers(cora)).toEqual(['P1', 'P2', 'P4']);
    expect(cora.data.permits.find((p) => p.issuer === 'P4').scopes).toHaveLength(1);
    expect(issuers(call(db, QUIN, 'get_facility_permits', { p_organization_id: ORG }))).toEqual([
      'P3',
      'P4',
    ]);
  });

  it('a coach of a team scheduled elsewhere reads nothing (an empty list, not an error); a non-coach is refused', () => {
    const db = seeded();
    db.practice_assignments = [];
    expect(call(db, QUIN, 'get_facility_permits', { p_organization_id: ORG }).data.permits).toEqual(
      []
    );
    db.organization_members.push({ organization_id: ORG, profile_id: 'mo', role: 'coach' });
    expect(call(db, 'mo', 'get_facility_permits', { p_organization_id: ORG }).error.code).toBe(
      '42501'
    );
    expect(call(db, BOB, 'get_facility_permits', { p_organization_id: ORG }).error.code).toBe(
      '42501'
    );
  });

  it('the table policies agree with the RPC', () => {
    const db = seeded();
    const visible = (table, user) =>
      db[table].filter((row) => permitRowVisible(db, table, row, user, NOW)).length;
    expect(visible('facility_permits', ALICE)).toBe(5);
    expect(visible('facility_permits', CORA)).toBe(3);
    expect(visible('facility_permit_scopes', CORA)).toBe(3);
    expect(visible('facility_permits', BOB)).toBe(0);
  });

  it("a field delete lists the permits scoped directly to the field, not the venue's", () => {
    const db = seeded();
    const rows = permitsUnlinkedBy(db, ORG, F1);
    expect(rows.map((r) => r.issuer).sort()).toEqual(['P1', 'P4']);
    expect(rows.every((r) => r.kind === 'permit' && r.disposition === 'unlinked')).toBe(true);
  });
});

describe('the files', () => {
  const folder = (permitId) => `${ORG}/${permitId}`;
  const objectPath = (permitId, n = 1, ext = 'pdf') =>
    `${folder(permitId)}/c0000000-0000-4000-8000-00000000000${n}.${ext}`;
  const pdf = (size = 100, type = 'application/pdf') =>
    new File([new Uint8Array(size)], 'permit.pdf', { type });
  const storageFor = (db, user) =>
    createMockStorage({
      getDB: () => db,
      saveDB: () => {},
      currentUserId: () => user,
      now: () => NOW,
    });
  const setFile = (db, permitId, path, name = 'permit.pdf') =>
    call(db, ALICE, 'admin_set_facility_permit_file', {
      p_organization_id: ORG,
      p_permit_id: permitId,
      p_object_path: path,
      p_file_name: name,
    });

  it('an admin uploads under a real permit; the object is then attachable, and a replace returns the first path', async () => {
    const db = makeDb();
    const { data } = create(db);
    const admin = storageFor(db, ALICE).from('facility-permits');
    expect((await admin.upload(objectPath(data.id, 1), pdf())).error).toBeNull();
    expect(
      (await admin.upload(objectPath(data.id, 2, 'png'), pdf(100, 'image/png'))).error
    ).toBeNull();
    expect(setFile(db, data.id, objectPath(data.id, 1)).data.previous_path).toBeNull();
    expect(setFile(db, data.id, objectPath(data.id, 2, 'png')).data.previous_path).toBe(
      objectPath(data.id, 1)
    );
    expect(
      db.audit_log
        .filter((a) => a.metadata.operation?.startsWith('file_'))
        .map((a) => a.metadata.operation)
    ).toEqual(['file_attached', 'file_replaced']);
    expect(setFile(db, data.id, objectPath(data.id, 2, 'png')).error.details).toBe(
      'already_attached'
    );
  });

  it('refuses what the bucket and the RPC refuse', async () => {
    const db = makeDb();
    const { data } = create(db);
    const other = create(db, { p_issuer: 'Other' }).data;
    const admin = storageFor(db, ALICE).from('facility-permits');
    // never uploaded
    expect(setFile(db, data.id, objectPath(data.id, 9)).error.details).toBe('object_missing');
    // a permit folder that holds no permit; a coach; the other organization's admin; a bad extension
    expect(
      (await admin.upload(objectPath('f6000000-0000-4000-8000-0000000000ee', 1), pdf())).error
        .statusCode
    ).toBe('403');
    expect(
      (await storageFor(db, CORA).from('facility-permits').upload(objectPath(data.id, 3), pdf()))
        .error.statusCode
    ).toBe('403');
    expect(
      (await storageFor(db, BOB).from('facility-permits').upload(objectPath(data.id, 3), pdf()))
        .error.statusCode
    ).toBe('403');
    expect(
      (await admin.upload(`${folder(data.id)}/c0000000-0000-4000-8000-000000000004.html`, pdf()))
        .error.statusCode
    ).toBe('403');
    // type and size
    expect(
      (await admin.upload(objectPath(data.id, 5), pdf(100, 'text/html'))).error.statusCode
    ).toBe('415');
    const big = new File([new Uint8Array(1)], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    expect((await admin.upload(objectPath(data.id, 6), big)).error.statusCode).toBe('413');
    // an object in another permit's folder exists but cannot be attached here
    expect((await admin.upload(objectPath(other.id, 7), pdf())).error).toBeNull();
    expect(setFile(db, data.id, objectPath(other.id, 7)).error.details).toBe('object_path');
    // a stored object of an unlisted type is refused by the RPC even if the bucket let it in
    db.storage_objects.push({
      bucket_id: 'facility-permits',
      name: objectPath(data.id, 8),
      metadata: { size: 10, mimetype: 'text/html' },
    });
    expect(setFile(db, data.id, objectPath(data.id, 8)).error.details).toBe('file_type');
    expect(db.storage_objects.map((o) => o.name)).not.toContain(objectPath(data.id, 3));
  });

  it('no UPDATE: an upsert over an existing object is refused', async () => {
    const db = makeDb();
    const { data } = create(db);
    const admin = storageFor(db, ALICE).from('facility-permits');
    await admin.upload(objectPath(data.id, 1), pdf());
    expect(
      (await admin.upload(objectPath(data.id, 1), pdf(), { upsert: true })).error.statusCode
    ).toBe('403');
    expect(
      (await admin.upload(objectPath(data.id, 1), pdf(), { upsert: false })).error.statusCode
    ).toBe('409');
  });

  it('a demo organization takes no object', async () => {
    const db = makeDb();
    const { data } = create(db);
    db.organizations[0].demo_expires_at = '2026-10-27T13:00:00Z';
    const admin = storageFor(db, ALICE).from('facility-permits');
    expect((await admin.upload(objectPath(data.id, 1), pdf())).error.statusCode).toBe('403');
  });

  it('signed URLs: an admin gets any object, a coach only the live file of a permit she may read', async () => {
    const db = makeDb();
    const mine = create(db, { p_issuer: 'Mine', p_field_ids: [F1] }).data;
    const theirs = create(db, { p_issuer: 'Theirs', p_field_ids: [F3] }).data;
    const admin = storageFor(db, ALICE).from('facility-permits');
    for (const [permit, n] of [
      [mine, 1],
      [mine, 2],
      [theirs, 3],
    ])
      await admin.upload(objectPath(permit.id, n), pdf());
    setFile(db, mine.id, objectPath(mine.id, 1));
    setFile(db, mine.id, objectPath(mine.id, 2)); // the first file is now replaced
    setFile(db, theirs.id, objectPath(theirs.id, 3));
    const cora = storageFor(db, CORA).from('facility-permits');
    expect((await cora.createSignedUrl(objectPath(mine.id, 2), 120)).data.signedUrl).toMatch(
      /^data:/
    );
    expect((await cora.createSignedUrl(objectPath(mine.id, 1), 120)).error.statusCode).toBe('404'); // replaced
    expect((await cora.createSignedUrl(objectPath(theirs.id, 3), 120)).error.statusCode).toBe(
      '404'
    ); // another field
    expect((await cora.createSignedUrl(objectPath(mine.id, 4), 120)).error.statusCode).toBe('404'); // never uploaded
    expect(
      (
        await storageFor(db, BOB)
          .from('facility-permits')
          .createSignedUrl(objectPath(mine.id, 2), 120)
      ).error
    ).not.toBeNull();
    expect((await admin.createSignedUrl(objectPath(mine.id, 1), 120)).data.signedUrl).toMatch(
      /^data:/
    );
    expect((await admin.createSignedUrl(objectPath(mine.id, 2), 0)).error.statusCode).toBe('400');
  });

  it("remove is the admin's: a coach removes nothing, an admin removes the object", async () => {
    const db = makeDb();
    const { data } = create(db);
    await storageFor(db, ALICE).from('facility-permits').upload(objectPath(data.id, 1), pdf());
    expect(
      (
        await storageFor(db, CORA)
          .from('facility-permits')
          .remove([objectPath(data.id, 1)])
      ).data
    ).toEqual([]);
    expect(db.storage_objects).toHaveLength(1);
    expect(
      (
        await storageFor(db, ALICE)
          .from('facility-permits')
          .remove([objectPath(data.id, 1)])
      ).data
    ).toHaveLength(1);
    expect(db.storage_objects).toHaveLength(0);
  });

  it('refuses a bucket it does not know', async () => {
    const db = makeDb();
    expect(
      (await storageFor(db, ALICE).from('exports').upload('a/b.csv', pdf())).error.statusCode
    ).toBe('404');
  });
});
