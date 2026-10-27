/**
 * Mock arms for the permit RPCs of migration `20261102010000_facility_permits.sql` (Phase C;
 * plan `docs/changes/2026-10-22-phase-c-permits.md`), the two tables' SELECT policies, and a
 * `storage` member that stands in for the `facility-permits` bucket.
 *
 * **Refusals included, not just the happy path** (LESSONS_LEARNED #13), with the SQL's codes:
 *   - 42501 no session, or a caller who is not an admin of the organization named (the read: or
 *     a current coach of a team);
 *   - 23502 a missing argument;
 *   - 22023 a bad issuer, number, notes or dates, no scope, a scope that is not in the
 *     organization (one message whether it exists or not), a file whose object is missing, of a
 *     type outside PDF/JPEG/PNG, over 10 MiB, in another permit's folder, or already the file;
 *   - P0002 a permit that is not in the organization.
 * Each success appends one `audit_log` row (`settings.updated` / `facility_permit`, with
 * `setting: 'facility.permit'` and the SQL's operation and metadata); a refusal appends none.
 *
 * A coach reads a permit only for a field where a team they currently coach has a game or a
 * practice, or for the venue of such a field (admin-focus R6), and sees only those scopes.
 *
 * **The `storage` member** mirrors the bucket's rules: private; PDF, JPEG, PNG; 10 MiB; an object is
 * `<organization>/<permit>/<uuid>.<ext>`; an admin of the organization uploads (not for a demo
 * organization, and only for a permit that exists there) and removes; an admin reads any object and a
 * coach only the live file of a permit they may read; there is no UPDATE, so `upsert: true` over an
 * existing object is refused.
 *
 * **Not mirrored** (stated so nobody reads this as the database): the object's bytes are held in
 * memory only, so after a page reload an object's record survives (it is in the mock database) and a
 * signed URL for it opens a placeholder; a signed URL is a `data:` URL that never expires; the
 * Storage API's own error text (the mock's is close, not identical); `record_audit_event`'s own
 * checks (the row is appended directly); and the SQL's row locks.
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js` wires it into `rpc()` and
 * `storage`, and persists `db` afterwards.
 */

import {
  permitStatus,
  PERMIT_FILE_TYPES,
  PERMIT_MAX_FILE_BYTES,
} from '@squadlogic/core/facility/permits.js';
import { createAccessHelpers, localDateIn } from './mockServerSideReads.js';

export const FACILITY_PERMIT_RPCS = Object.freeze([
  'admin_create_facility_permit',
  'admin_update_facility_permit',
  'admin_set_facility_permit_file',
  'admin_delete_facility_permit',
  'get_facility_permits',
]);

export const PERMIT_BUCKET = 'facility-permits';

const ALLOWED_MIME = Object.keys(PERMIT_FILE_TYPES);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT_PATH = new RegExp(`^(${UUID})/(${UUID})/${UUID}\\.(pdf|jpg|jpeg|png)$`, 'i');

const fail = (code, message, detail) => ({
  data: null,
  error: { code, message, ...(detail ? { details: detail } : {}) },
});
const same = (a, b) => String(a) === String(b);
const notAdmin = (orgId) =>
  fail('42501', `Access denied: caller is not an admin of organization ${orgId}`);

/** `org_local_today`: the active season's timezone, UTC when unset or unreadable. */
export function orgLocalToday(db, orgId, now = new Date()) {
  const season = (db.season_settings || []).find(
    (s) => same(s.organization_id, orgId) && s.status === 'active'
  );
  return localDateIn(season?.timezone, now);
}

/**
 * `coach_field_ids_of`: the fields where a team the user currently coaches has a game (through its
 * slot) or a practice (through its practice slot).
 */
export function coachFieldIds(db, orgId, userId, now = new Date()) {
  const access = createAccessHelpers(db, userId, now);
  if (!access.isOrgMember(orgId)) return new Set();
  const teamIds = new Set(
    (db.team_coach_assignments || [])
      .filter(
        (row) =>
          same(row.organization_id, orgId) &&
          access.myCoachIds.has(String(row.coach_id)) &&
          access.isLive(row)
      )
      .map((row) => String(row.team_id))
  );
  const fields = new Set();
  if (teamIds.size === 0) return fields;
  const slotById = (rows, id) => rows.find((row) => same(row.id, id));
  for (const game of db.games || []) {
    if (!same(game.organization_id, orgId)) continue;
    if (!teamIds.has(String(game.home_team_id)) && !teamIds.has(String(game.away_team_id)))
      continue;
    const slot = slotById(db.game_slots || [], game.game_slot_id);
    if (slot?.field_id && same(slot.organization_id ?? orgId, orgId))
      fields.add(String(slot.field_id));
  }
  for (const assignment of db.practice_assignments || []) {
    if (!same(assignment.organization_id, orgId) || !teamIds.has(String(assignment.team_id)))
      continue;
    const slot = (db.practice_slots || []).find(
      (row) => same(row.id, assignment.practice_slot_id) || same(row.id, assignment.slot_id)
    );
    if (slot?.field_id) fields.add(String(slot.field_id));
  }
  return fields;
}

/** `coach_covers_permit_scope`. */
function coachCoversScope(db, scope, fieldIds) {
  if (scope.field_id && fieldIds.has(String(scope.field_id))) return true;
  if (scope.location_id) {
    return (db.fields || []).some(
      (field) =>
        fieldIds.has(String(field.id)) &&
        same(field.location_id, scope.location_id) &&
        same(field.organization_id, scope.organization_id)
    );
  }
  return false;
}

/**
 * The tables' SELECT policies for the signed-in caller: an admin or staff member of the row's
 * organization, or a coach whose fields the permit (or the scope) concerns.
 * @returns {boolean}
 */
export function permitRowVisible(db, table, row, currentUserId, now = new Date()) {
  const access = createAccessHelpers(db, currentUserId, now);
  if (access.isOrgAdmin(row.organization_id)) return true;
  const fields = coachFieldIds(db, row.organization_id, currentUserId, now);
  if (fields.size === 0) return false;
  if (table === 'facility_permit_scopes') return coachCoversScope(db, row, fields);
  return (db.facility_permit_scopes || []).some(
    (scope) => same(scope.permit_id, row.id) && coachCoversScope(db, scope, fields)
  );
}

/** `facility_permit_json`. `coachFields` is a Set to narrow the scopes to, or null for an admin. */
export function permitView(db, permit, today, coachFields = null) {
  const venueOf = (id) => (db.locations || []).find((l) => same(l.id, id));
  const live = (effectiveTo) =>
    effectiveTo === null || effectiveTo === undefined || String(effectiveTo) >= today;
  const scopes = (db.facility_permit_scopes || [])
    .filter((s) => same(s.permit_id, permit.id))
    .filter((s) => coachFields === null || coachCoversScope(db, s, coachFields))
    .map((s) => {
      const field = s.field_id ? (db.fields || []).find((f) => same(f.id, s.field_id)) : null;
      const venue = venueOf(s.location_id ?? field?.location_id);
      return {
        id: s.id,
        kind: s.field_id ? 'field' : 'location',
        field_id: s.field_id ?? null,
        location_id: s.location_id ?? field?.location_id ?? null,
        field_name: field?.name ?? null,
        location_name: venue?.name ?? null,
        retired: !(live(field?.effective_to) && live(venue?.effective_to)),
      };
    })
    .sort(
      (a, b) =>
        String(a.location_name ?? '').localeCompare(String(b.location_name ?? '')) ||
        (a.field_name === null
          ? -1
          : b.field_name === null
            ? 1
            : String(a.field_name).localeCompare(String(b.field_name))) ||
        String(a.id).localeCompare(String(b.id))
    );
  const { status, daysLeft } = permitStatus(permit.valid_from, permit.valid_to, today);
  return {
    id: permit.id,
    organization_id: permit.organization_id,
    issuer: permit.issuer,
    permit_number: permit.permit_number ?? null,
    valid_from: permit.valid_from,
    valid_to: permit.valid_to,
    notes: permit.notes ?? null,
    status,
    days_left: daysLeft,
    file: permit.file_path
      ? {
          path: permit.file_path,
          name: permit.file_name,
          mime: permit.file_mime,
          size: permit.file_size,
        }
      : null,
    scopes,
    created_at: permit.created_at,
    updated_at: permit.updated_at,
  };
}

function audit(db, ctx, orgId, resourceId, metadata) {
  db.audit_log = db.audit_log || [];
  db.audit_log.push({
    id: ctx.newId(),
    organization_id: orgId,
    user_id: ctx.currentUserId,
    action: 'settings.updated',
    resource_type: 'facility_permit',
    resource_id: resourceId,
    metadata: { setting: 'facility.permit', ...metadata },
    created_at: (ctx.now ?? new Date()).toISOString(),
  });
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** `facility_permit_check`: returns the refusal or null. */
function checkPermit(db, orgId, v) {
  const refuse = (message, detail) => fail('22023', message, detail);
  if (v.issuer.length < 1 || v.issuer.length > 200)
    return refuse('the issuer must be 1 to 200 characters', 'issuer');
  if (v.number !== null && v.number.length > 100)
    return refuse('the permit number must be at most 100 characters', 'permit_number');
  if (v.notes !== null && v.notes.length > 2000)
    return refuse('the notes must be at most 2000 characters', 'notes');
  if (v.validTo < v.validFrom)
    return refuse(`a permit cannot end (${v.validTo}) before it begins (${v.validFrom})`, 'dates');
  const total = v.locations.length + v.fields.length;
  if (total === 0) return refuse('a permit covers at least one venue or field', 'no_scope');
  if (total > 200)
    return refuse('a permit covers at most 200 venues and fields', 'too_many_scopes');
  const ownLocations = new Set(
    (db.locations || []).filter((l) => same(l.organization_id, orgId)).map((l) => String(l.id))
  );
  const ownFields = new Set(
    (db.fields || []).filter((f) => same(f.organization_id, orgId)).map((f) => String(f.id))
  );
  if (
    v.locations.some((id) => !ownLocations.has(id)) ||
    v.fields.some((id) => !ownFields.has(id))
  ) {
    return refuse(
      'a venue or field named is not in this organization',
      'scope_not_in_organization'
    );
  }
  return null;
}

const ids = (list) => [
  ...new Set((list ?? []).filter((x) => x !== null && x !== undefined).map(String)),
];
const blank = (text) => {
  const trimmed = String(text ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * @param {any} db - the mock database; mutated in place
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string|null, isOrgAdmin: (orgId: string) => boolean, now?: Date,
 *   newId?: () => string, markDeleted?: (db: any, table: string, keys: string[]) => void }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not one of these RPCs
 */
export function handleFacilityPermitRpc(db, name, params, ctx) {
  if (!FACILITY_PERMIT_RPCS.includes(name)) return null;
  const p = params || {};
  const c = {
    ...ctx,
    newId: ctx.newId ?? (() => globalThis.crypto.randomUUID()),
    markDeleted: ctx.markDeleted ?? (() => {}),
  };
  const now = c.now ?? new Date();
  db.facility_permits = db.facility_permits || [];
  db.facility_permit_scopes = db.facility_permit_scopes || [];
  if (!c.currentUserId) return fail('42501', 'authenticated user is required');
  const orgId = p.p_organization_id;
  if (!orgId) return fail('23502', 'p_organization_id is required');

  if (name === 'get_facility_permits') {
    const admin = c.isOrgAdmin(orgId);
    const fields = coachFieldIds(db, orgId, c.currentUserId, now);
    const access = createAccessHelpers(db, c.currentUserId, now);
    const isCoach = access.isOrgMember(orgId) && currentCoachHasTeam(db, orgId, access);
    if (!admin && !isCoach) {
      return fail(
        '42501',
        'Access denied: permits are read by an administrator or a coach of a team'
      );
    }
    const today = orgLocalToday(db, orgId, now);
    const permits = db.facility_permits
      .filter((permit) => same(permit.organization_id, orgId))
      .filter(
        (permit) => admin || permitRowVisible(db, 'facility_permits', permit, c.currentUserId, now)
      )
      .sort(
        (a, b) =>
          String(a.valid_to).localeCompare(String(b.valid_to)) ||
          String(a.issuer).localeCompare(String(b.issuer)) ||
          String(a.id).localeCompare(String(b.id))
      )
      .map((permit) => permitView(db, permit, today, admin ? null : fields));
    return { data: { today, lead_days: 30, permits }, error: null };
  }

  if (!c.isOrgAdmin(orgId)) return notAdmin(orgId);
  const today = orgLocalToday(db, orgId, now);

  if (name === 'admin_create_facility_permit' || name === 'admin_update_facility_permit') {
    const creating = name === 'admin_create_facility_permit';
    if (!creating && !p.p_permit_id)
      return fail('23502', 'p_organization_id and p_permit_id are required');
    if (!p.p_valid_from || !p.p_valid_to)
      return fail('23502', 'a permit needs the dates it is valid from and to');
    const v = {
      issuer: String(p.p_issuer ?? '').trim(),
      number: blank(p.p_permit_number),
      notes: blank(p.p_notes),
      validFrom: String(p.p_valid_from),
      validTo: String(p.p_valid_to),
      locations: ids(p.p_location_ids),
      fields: ids(p.p_field_ids),
    };
    if (!ISO.test(v.validFrom) || !ISO.test(v.validTo))
      return fail('22007', 'invalid input syntax for type date');
    let permit = null;
    if (!creating) {
      permit = db.facility_permits.find(
        (row) => same(row.id, p.p_permit_id) && same(row.organization_id, orgId)
      );
      if (!permit)
        return fail('P0002', `permit ${p.p_permit_id} was not found in organization ${orgId}`);
    }
    const refusal = checkPermit(db, orgId, v);
    if (refusal) return refusal;
    const stamp = now.toISOString();
    const previous = creating ? null : permitView(db, permit, today);
    if (creating) {
      permit = {
        id: c.newId(),
        organization_id: orgId,
        issuer: v.issuer,
        permit_number: v.number,
        valid_from: v.validFrom,
        valid_to: v.validTo,
        notes: v.notes,
        file_path: null,
        file_name: null,
        file_mime: null,
        file_size: null,
        created_by: c.currentUserId,
        created_at: stamp,
        updated_at: stamp,
      };
      db.facility_permits.push(permit);
    } else {
      Object.assign(permit, {
        issuer: v.issuer,
        permit_number: v.number,
        valid_from: v.validFrom,
        valid_to: v.validTo,
        notes: v.notes,
        updated_at: stamp,
      });
      const doomed = db.facility_permit_scopes.filter(
        (s) =>
          same(s.permit_id, permit.id) &&
          !(s.location_id && v.locations.includes(String(s.location_id))) &&
          !(s.field_id && v.fields.includes(String(s.field_id)))
      );
      db.facility_permit_scopes = db.facility_permit_scopes.filter((s) => !doomed.includes(s));
      c.markDeleted(
        db,
        'facility_permit_scopes',
        doomed.map((s) => String(s.id))
      );
    }
    const has = (key, value) =>
      db.facility_permit_scopes.some((s) => same(s.permit_id, permit.id) && same(s[key], value));
    for (const id of v.locations) {
      if (!has('location_id', id)) {
        db.facility_permit_scopes.push({
          id: c.newId(),
          permit_id: permit.id,
          organization_id: orgId,
          location_id: id,
          field_id: null,
          created_at: stamp,
        });
      }
    }
    for (const id of v.fields) {
      if (!has('field_id', id)) {
        db.facility_permit_scopes.push({
          id: c.newId(),
          permit_id: permit.id,
          organization_id: orgId,
          location_id: null,
          field_id: id,
          created_at: stamp,
        });
      }
    }
    const view = permitView(db, permit, today);
    audit(
      db,
      c,
      orgId,
      permit.id,
      creating
        ? { operation: 'created', current: view }
        : { operation: 'updated', previous, current: view }
    );
    return { data: view, error: null };
  }

  if (name === 'admin_set_facility_permit_file') {
    if (!p.p_permit_id) return fail('23502', 'p_organization_id and p_permit_id are required');
    const fileName = String(p.p_file_name ?? '').trim();
    if (p.p_object_path === null || p.p_object_path === undefined || fileName === '') {
      return fail('23502', 'p_object_path and p_file_name are required');
    }
    if (fileName.length > 255 || /[/\\]/.test(fileName)) {
      return fail('22023', 'the file name must be 1 to 255 characters with no slash', 'file_name');
    }
    const permit = db.facility_permits.find(
      (row) => same(row.id, p.p_permit_id) && same(row.organization_id, orgId)
    );
    if (!permit)
      return fail('P0002', `permit ${p.p_permit_id} was not found in organization ${orgId}`);
    const path = String(p.p_object_path);
    const match = OBJECT_PATH.exec(path);
    // The folders are compared exactly, as the RPC does; the file's name and extension are not.
    if (!match || !same(match[1], orgId) || !same(match[2], permit.id)) {
      return fail(
        '22023',
        "the object must be <organization>/<permit>/<uuid>.<pdf|jpg|jpeg|png> in this permit's folder",
        'object_path'
      );
    }
    if (permit.file_path === path)
      return fail('22023', "that object is already this permit's file", 'already_attached');
    const object = (db.storage_objects || []).find(
      (o) => o.bucket_id === PERMIT_BUCKET && o.name === path
    );
    if (!object) return fail('22023', `no uploaded object ${path}`, 'object_missing');
    const mime = object.metadata?.mimetype;
    if (!mime || !ALLOWED_MIME.includes(mime)) {
      return fail(
        '22023',
        `the object is ${mime ?? 'of unknown type'}, not a PDF, JPEG or PNG`,
        'file_type'
      );
    }
    const size = Number(object.metadata?.size);
    if (!Number.isInteger(size))
      return fail('22023', 'the object has no readable size', 'file_size');
    if (size < 1 || size > PERMIT_MAX_FILE_BYTES) {
      return fail(
        '22023',
        `the object is ${size} bytes; a permit file is 1 byte to 10 MiB`,
        'file_size'
      );
    }
    const previous = permitView(db, permit, today);
    const previousPath = permit.file_path;
    Object.assign(permit, {
      file_path: path,
      file_name: fileName,
      file_mime: mime,
      file_size: size,
      updated_at: now.toISOString(),
    });
    const view = permitView(db, permit, today);
    audit(db, c, orgId, permit.id, {
      operation: previousPath === null ? 'file_attached' : 'file_replaced',
      previous_file: previous.file,
      current_file: view.file,
    });
    return { data: { permit: view, previous_path: previousPath }, error: null };
  }

  // admin_delete_facility_permit
  if (!p.p_permit_id) return fail('23502', 'p_organization_id and p_permit_id are required');
  const permit = db.facility_permits.find(
    (row) => same(row.id, p.p_permit_id) && same(row.organization_id, orgId)
  );
  if (!permit)
    return fail('P0002', `permit ${p.p_permit_id} was not found in organization ${orgId}`);
  const previous = permitView(db, permit, today);
  const doomedScopes = db.facility_permit_scopes.filter((s) => same(s.permit_id, permit.id));
  db.facility_permit_scopes = db.facility_permit_scopes.filter((s) => !doomedScopes.includes(s));
  c.markDeleted(
    db,
    'facility_permit_scopes',
    doomedScopes.map((s) => String(s.id))
  );
  db.facility_permits = db.facility_permits.filter((row) => row !== permit);
  c.markDeleted(db, 'facility_permits', [String(permit.id)]);
  audit(db, c, orgId, permit.id, { operation: 'deleted', previous });
  return { data: { id: permit.id, deleted: true, file_path: permit.file_path }, error: null };
}

/** Does the caller currently coach a team in the organization? (the read's second gate) */
function currentCoachHasTeam(db, orgId, access) {
  return (db.team_coach_assignments || []).some(
    (row) =>
      same(row.organization_id, orgId) &&
      access.myCoachIds.has(String(row.coach_id)) &&
      access.isLive(row)
  );
}

/**
 * `admin_delete_field`'s additions: the permits scoped directly to the field, as `affected` rows
 * (`kind: 'permit'`, `disposition: 'unlinked'`).
 */
export function permitsUnlinkedBy(db, orgId, fieldId) {
  const permitIds = new Set(
    (db.facility_permit_scopes || [])
      .filter((s) => same(s.field_id, fieldId))
      .map((s) => String(s.permit_id))
  );
  return (db.facility_permits || [])
    .filter((permit) => same(permit.organization_id, orgId) && permitIds.has(String(permit.id)))
    .sort(
      (a, b) =>
        String(a.valid_to).localeCompare(String(b.valid_to)) ||
        String(a.id).localeCompare(String(b.id))
    )
    .map((permit) => ({
      kind: 'permit',
      id: permit.id,
      on_date: permit.valid_to,
      week_index: null,
      undated: false,
      unbounded: false,
      disposition: 'unlinked',
      issuer: permit.issuer,
      permit_number: permit.permit_number ?? null,
    }));
}

// ── The storage member ────────────────────────────────────────────────────

/** Object bytes by path, in memory only (see the header). */
const bytesByPath = new Map();

const storageError = (statusCode, message) => ({
  data: null,
  error: {
    statusCode: String(statusCode),
    message,
    error: statusCode === 403 ? 'Unauthorized' : 'Error',
  },
});

/**
 * @param {{ getDB: () => any, saveDB: (db: any) => void, currentUserId: () => string | null,
 *   now?: () => Date }} deps
 */
export function createMockStorage({ getDB, saveDB, currentUserId, now = () => new Date() }) {
  const bucketRefusal = (bucket) =>
    bucket === PERMIT_BUCKET ? null : storageError(404, `Bucket not found: ${bucket}`);
  const parts = (path) => {
    const match = OBJECT_PATH.exec(String(path));
    return match ? { org: match[1].toLowerCase(), permit: match[2].toLowerCase() } : null;
  };
  const toDataUrl = async (file) => {
    const buffer = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`;
  };

  return {
    from(bucket) {
      return {
        async upload(path, file, options = {}) {
          const refused = bucketRefusal(bucket);
          if (refused) return refused;
          const db = getDB();
          const userId = currentUserId();
          const access = createAccessHelpers(db, userId, now());
          const where = parts(path);
          const permit = where
            ? (db.facility_permits || []).find(
                (p) => same(p.id, where.permit) && same(p.organization_id, where.org)
              )
            : null;
          const org = where ? (db.organizations || []).find((o) => same(o.id, where.org)) : null;
          const allowed = Boolean(
            userId && where && permit && access.isOrgAdmin(where.org) && !org?.demo_expires_at
          );
          if (!allowed) return storageError(403, 'new row violates row-level security policy');
          const mimetype = options.contentType ?? file?.type ?? 'application/octet-stream';
          if (!ALLOWED_MIME.includes(mimetype))
            return storageError(415, `mime type ${mimetype} is not supported`);
          const size = Number(file?.size ?? 0);
          if (size > PERMIT_MAX_FILE_BYTES)
            return storageError(413, 'The object exceeded the maximum allowed size');
          db.storage_objects = db.storage_objects || [];
          const existing = db.storage_objects.find(
            (o) => o.bucket_id === bucket && o.name === path
          );
          // No UPDATE policy: an upsert over an existing object is refused, as is a plain duplicate.
          if (existing)
            return storageError(
              options.upsert ? 403 : 409,
              options.upsert
                ? 'new row violates row-level security policy'
                : 'The resource already exists'
            );
          db.storage_objects.push({
            id: globalThis.crypto.randomUUID(),
            bucket_id: bucket,
            name: path,
            owner: userId,
            metadata: { size, mimetype },
            created_at: now().toISOString(),
          });
          bytesByPath.set(path, await toDataUrl(file));
          saveDB(db);
          return {
            data: { path, id: db.storage_objects.at(-1).id, fullPath: `${bucket}/${path}` },
            error: null,
          };
        },

        async remove(paths) {
          const refused = bucketRefusal(bucket);
          if (refused) return refused;
          const db = getDB();
          const userId = currentUserId();
          const access = createAccessHelpers(db, userId, now());
          const removed = [];
          for (const path of paths) {
            const where = parts(path);
            if (!userId || !where || !access.isOrgAdmin(where.org)) continue;
            const before = (db.storage_objects || []).length;
            db.storage_objects = (db.storage_objects || []).filter(
              (o) => !(o.bucket_id === bucket && o.name === path)
            );
            if (db.storage_objects.length !== before) {
              removed.push({ name: path, bucket_id: bucket });
              bytesByPath.delete(path);
            }
          }
          saveDB(db);
          return { data: removed, error: null };
        },

        async createSignedUrl(path, expiresIn) {
          const refused = bucketRefusal(bucket);
          if (refused) return refused;
          if (!(expiresIn > 0))
            return storageError(400, 'expiresIn must be a positive number of seconds');
          const db = getDB();
          const userId = currentUserId();
          const where = parts(path);
          const object = (db.storage_objects || []).find(
            (o) => o.bucket_id === bucket && o.name === path
          );
          const access = createAccessHelpers(db, userId, now());
          let readable = false;
          if (userId && where && object) {
            if (access.isOrgAdmin(where.org)) readable = true;
            else {
              // A coach reads only the LIVE file of a permit they may read.
              const permit = (db.facility_permits || []).find(
                (p) => same(p.file_path, path) && same(p.organization_id, where.org)
              );
              readable = Boolean(
                permit && permitRowVisible(db, 'facility_permits', permit, userId, now())
              );
            }
          }
          if (!readable) return storageError(404, 'Object not found');
          const signedUrl =
            bytesByPath.get(path) ??
            `data:text/plain;charset=utf-8,${encodeURIComponent('Mock storage: the file was uploaded before this page loaded.')}`;
          return { data: { signedUrl }, error: null };
        },

        async download(path) {
          const signed = await this.createSignedUrl(path, 60);
          if (signed.error) return signed;
          const response = await fetch(signed.data.signedUrl);
          return { data: await response.blob(), error: null };
        },
      };
    },
  };
}
