/**
 * Mock arms for the Published switch (migration `20261119010000_game_published.sql`), refusals included
 * (LESSONS_LEARNED #13), with the SQL's error codes and `DETAIL`s:
 *
 * - `admin_set_games_published`: 42501 `signed_in_required` (no user) and `admin_required` (not an admin of the
 *   organization, said before the ids are looked at); 22023 `ids_required`, `ids_invalid`, `too_many_ids` (more than
 *   2,400 distinct ids), `published_required`, `reason_only_when_off`, `reason_required`, `reason_unknown`,
 *   `note_too_long` (over 200 characters), `scope_invalid`; 23503 `game_not_found` (an id of another organization
 *   reads as one that does not exist); 22023 `season_completed` for a game of a completed season that WOULD change (a game already at the value is
 *   `unchanged` and never reaches the read-only rule). Returns `{ changed, unchanged, ids }` and writes the audit
 *   rows: `game.published_set` per call, `game.publish_overridden` per game turned off with its before-image.
 * - `get_schedule_audit_log`: admin only; those two actions, a call row without its `ids`, the actor's name, newest
 *   first, 50 by default and at most 500.
 * - The guard ({@link publishedWriteRefusal}) on the mock's direct writes to `game_assignments`: a Published row
 *   cannot be deleted or have its slot, field, teams, week, start or end changed (22023 `game_published`).
 *   `admin_cancel_game_assignment` and `admin_delete_team` call {@link publishedRpcRefusal} for the same refusals.
 *
 * **Written independently of `@squadlogic/core/gamePublished.js` on purpose.** The lists below (reasons, scope kinds,
 * guarded columns, limits) are a second copy, so that `tests/mockGamePublished.test.js` can run one input that reaches
 * every outcome through the mock and the pure helper and require the two to agree (lesson 77); importing the helper
 * here would make that test compare a function with itself.
 *
 * **Not mirrored** (stated so nobody reads this as the database):
 *   - `persist_game_schedule` has no mock arm (the save is an Edge function over SQL), so the save's omission
 *     refusal and the trigger's refusal of a moving save are held by pgTAP and by the pure helper, not here;
 *   - the exemptions of the trigger (a job with no signed-in user, the cascade of a deleted organization): the
 *     mock's direct writes are always the signed-in app's;
 *   - the mock's OWN cascades: `admin_delete_field` (confirmed), the field-import rollback and slot removal delete
 *     or null the field of `game_assignments` without asking the guard, where the database raises 22023
 *     `game_published` from the cascade (after its booking check refuses a booked field first). A screen built or
 *     E2E-tested in mock mode on a Published game must not rely on those deletes succeeding (code review, #707;
 *     not mirrored: the Games page (PR 3) shows Published games but offers no way to delete a field, venue or
 *     slot, and its E2E feature deletes none, so it does not depend on them; the cascades stay unmirrored, statically
 *     reviewed);
 *   - row locking and the per-organization lock, and the SLA01 rollback of a failed audit write.
 *
 * Pure over `db` so a test can drive it directly; `mockSupabaseClient.js` wires it into `rpc()` and the write paths.
 */

import { scheduleWriteRefusal } from './mockSeasons.js';

export const GAME_PUBLISHED_RPCS = Object.freeze([
  'admin_set_games_published',
  'get_schedule_audit_log',
]);

const REASONS = ['field-change', 'coach-request', 'conflict-fix', 'published-in-error', 'other'];
const SCOPE_KINDS = ['all', 'division', 'date', 'venue', 'selection'];
const MAX_IDS = 2400;
const NOTE_MAX = 200;
const SCOPE_VALUE_MAX = 100;
const GUARDED = [
  'game_slot_id',
  'slot_id',
  'field_id',
  'home_team_id',
  'away_team_id',
  'week_index',
  'start',
  'end',
];

const fail = (code, message, detail) => ({
  data: null,
  error: { code, message, details: detail ?? null, hint: null },
});

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// Trimmed of space, tab, CR and LF, as the SQL trims a reason and a note.
const text = (value) => {
  const trimmed = String(value ?? '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  return trimmed === '' ? null : trimmed;
};

// An instant as the database reads it: a time with no zone designator is UTC, not the runtime's local time.
const instant = (value) => {
  const text = String(value).trim();
  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
      text
    );
  if (!m) return Date.parse(text);
  let zone = (m[3] ?? 'Z').toUpperCase();
  if (zone !== 'Z')
    zone =
      zone.length === 3
        ? `${zone}:00`
        : zone.length === 5
          ? `${zone.slice(0, 3)}:${zone.slice(3)}`
          : zone;
  return Date.parse(`${m[1]}T${m[2]}${zone}`);
};

function sameInstantOrText(field, a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (field === 'start' || field === 'end') {
    const x = instant(a);
    const y = instant(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x === y;
  }
  return same(a, b);
}

const refusal = (message) => fail('22023', message, 'game_published');

/**
 * The guard for a direct write: `pairs` are `{ before, after }` per row, `after` null for a delete. Only a row that
 * is Published BEFORE the write is judged (so clearing the flag and moving in one write is refused).
 *
 * @param {string} table
 * @param {Array<{ before: Record<string, any>, after: Record<string, any> | null }>} pairs
 * @returns {{ data: null, error: object } | null}
 */
export function publishedWriteRefusal(table, pairs) {
  if (table !== 'game_assignments') return null;
  for (const { before, after } of pairs || []) {
    if (before?.published !== true) continue;
    if (after == null) {
      return refusal(
        `Game ${before.id} is Published and cannot be deleted: allow changes to it first`
      );
    }
    if (
      GUARDED.some(
        (field) => !sameInstantOrText(field, before[field] ?? null, after[field] ?? null)
      )
    ) {
      return refusal(
        `Game ${before.id} is Published and cannot be moved: allow changes to it first`
      );
    }
  }
  return null;
}

/**
 * The refusals of the two RPCs that name a game or its team: cancel (`kind: 'cancel'`, one game id) and delete team
 * (`kind: 'team'`, a team id).
 *
 * @param {any} db
 * @param {{ kind: 'cancel' | 'team', id: string }} what
 */
export function publishedRpcRefusal(db, what) {
  if (what.kind === 'cancel') {
    const game = (db.game_assignments || []).find((row) => same(row.id, what.id));
    if (game?.published === true) {
      return refusal(
        `game ${game.id} is Published and cannot be cancelled: allow changes to it first`
      );
    }
    return null;
  }
  const count = (db.game_assignments || []).filter(
    (row) =>
      row.published === true && (same(row.home_team_id, what.id) || same(row.away_team_id, what.id))
  ).length;
  if (count > 0) {
    return refusal(
      `team ${what.id} has ${count} Published game(s) and cannot be deleted: allow changes to them first`
    );
  }
  return null;
}

function setGamesPublished(db, params, ctx) {
  const p = params || {};
  const org = p.p_organization_id;
  if (!ctx.currentUserId) {
    return fail(
      '42501',
      'admin_set_games_published needs a signed-in caller to audit the change',
      'signed_in_required'
    );
  }
  if (!org || !ctx.isOrgAdmin(org)) {
    return fail(
      '42501',
      'Access denied: only an administrator of the organization sets whether its games are Published',
      'admin_required'
    );
  }

  const given = p.p_assignment_ids;
  if (!Array.isArray(given) || given.length === 0) {
    return fail('22023', 'name at least one game', 'ids_required');
  }
  if (given.some((id) => id == null)) {
    return fail('22023', 'a game id cannot be null', 'ids_invalid');
  }
  const ids = [...new Set(given.map((id) => String(id).toLowerCase()))].sort();
  if (ids.length > MAX_IDS) {
    return fail(
      '22023',
      `at most ${MAX_IDS} games can be set in one call (${ids.length} named)`,
      'too_many_ids'
    );
  }
  // An id of another organization reads exactly as one that does not exist (nothing is leaked of another tenant).
  const rows = ids.map((id) =>
    (db.game_assignments || []).find((row) => same(row.id, id) && same(row.organization_id, org))
  );
  const missing = ids.find((id, at) => !rows[at]);
  if (missing) {
    return fail('23503', `game ${missing} does not exist in this organization`, 'game_not_found');
  }

  const published = p.p_published;
  if (typeof published !== 'boolean') {
    return fail('22023', 'say whether the games are Published or not', 'published_required');
  }
  const reason = text(p.p_reason_code);
  const note = text(p.p_note);
  if (published) {
    if (reason !== null || note !== null) {
      return fail(
        '22023',
        'turning Published on takes no reason and no note: they belong to allowing changes',
        'reason_only_when_off'
      );
    }
  } else {
    if (reason === null) {
      return fail(
        '22023',
        'allowing changes to a Published game needs a reason',
        'reason_required'
      );
    }
    if (!REASONS.includes(reason)) {
      return fail(
        '22023',
        `unknown reason "${reason}": one of ${REASONS.join(', ')}`,
        'reason_unknown'
      );
    }
    if ([...(note ?? '')].length > NOTE_MAX) {
      return fail(
        '22023',
        `the note is at most ${NOTE_MAX} characters (${[...note].length} given)`,
        'note_too_long'
      );
    }
  }
  let scope = { kind: 'selection' };
  if (p.p_scope != null) {
    const s = p.p_scope;
    const bad =
      typeof s !== 'object' ||
      Array.isArray(s) ||
      !SCOPE_KINDS.includes(s.kind) ||
      Object.keys(s).some((key) => key !== 'kind' && key !== 'value') ||
      (s.value != null && typeof s.value !== 'string') ||
      [...(s.value ?? '')].length > SCOPE_VALUE_MAX;
    if (bad) {
      return fail(
        '22023',
        `the scope kind is one of ${SCOPE_KINDS.join(', ')}, with an optional text value of at most ${SCOPE_VALUE_MAX} characters`,
        'scope_invalid'
      );
    }
    scope = { kind: s.kind, ...(s.value ? { value: s.value } : {}) };
  }

  const changedRows = rows.filter((row) => (row.published === true) !== published);
  const unchanged = ids.length - changedRows.length;
  if (changedRows.length === 0) return { data: { changed: 0, unchanged, ids: [] }, error: null };

  // The read-only trigger refuses the UPDATE of a completed season's row, for the rows that would change.
  const completed = scheduleWriteRefusal(db, 'game_assignments', changedRows);
  if (completed) return completed;

  const now = (ctx.now ?? new Date()).toISOString();
  const before = changedRows.map((row) => ({
    id: row.id,
    image: Object.fromEntries(
      [
        'game_slot_id',
        'field_id',
        'home_team_id',
        'away_team_id',
        'week_index',
        'start',
        'end',
      ].map((field) => [field, row[field] ?? null])
    ),
  }));
  for (const row of changedRows) {
    row.published = published;
    if (published) {
      row.published_at = now;
      row.published_by = ctx.currentUserId;
    }
    row.updated_at = now;
  }
  const changedIds = changedRows.map((row) => row.id);
  db.audit_log = db.audit_log || [];
  const audit = (action, resourceId, metadata) =>
    db.audit_log.push({
      id: ctx.newId ? ctx.newId() : globalThis.crypto.randomUUID(),
      organization_id: org,
      user_id: ctx.currentUserId,
      action,
      resource_type: 'game_assignment',
      resource_id: resourceId,
      metadata,
      created_at: now,
    });
  audit('game.published_set', null, {
    published,
    scope,
    count: changedIds.length,
    unchanged,
    ids: changedIds,
    ...(published ? {} : { reason_code: reason }),
  });
  if (!published) {
    for (const { id, image } of before) {
      audit('game.publish_overridden', id, {
        reason_code: reason,
        scope,
        before: image,
        ...(note ? { note } : {}),
      });
    }
  }
  return { data: { changed: changedIds.length, unchanged, ids: changedIds }, error: null };
}

function scheduleAuditLog(db, params, ctx) {
  const p = params || {};
  if (!ctx.currentUserId || !p.p_organization_id || !ctx.isOrgAdmin(p.p_organization_id)) {
    return fail(
      '42501',
      'Access denied: only an administrator of the organization reads its schedule audit log',
      'admin_required'
    );
  }
  // As LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500): a null is 50, a 0 or less is 1, an integer cast that fails fails.
  const asked = p.p_limit ?? 50;
  if (!Number.isFinite(Number(asked)) || String(asked).trim() === '') {
    return fail('22P02', `invalid input syntax for type integer: "${asked}"`, null);
  }
  const limit = Math.min(Math.max(Math.trunc(Number(asked)), 1), 500);
  const game = p.p_assignment_id ?? null;
  const rows = (db.audit_log || [])
    .filter(
      (entry) =>
        same(entry.organization_id, p.p_organization_id) &&
        (entry.action === 'game.published_set' || entry.action === 'game.publish_overridden') &&
        (game === null ||
          same(entry.resource_id ?? '', game) ||
          (entry.action === 'game.published_set' &&
            (entry.metadata?.ids || []).some((id) => same(id, game))))
    )
    .sort(
      (a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)) ||
        // a call row above its per-game rows (they share one created_at), then by id: as the SQL orders them
        Number(b.action === 'game.published_set') - Number(a.action === 'game.published_set') ||
        String(b.id).localeCompare(String(a.id))
    )
    .slice(0, limit)
    .map((entry) => {
      const metadata = { ...entry.metadata };
      delete metadata.ids;
      const profile = (db.profiles || []).find((item) => same(item.id, entry.user_id));
      return {
        id: entry.id,
        created_at: entry.created_at,
        action: entry.action,
        resource_type: entry.resource_type,
        resource_id: entry.resource_id ?? null,
        metadata: entry.action === 'game.published_set' ? metadata : entry.metadata,
        actor_name: profile?.full_name || 'Unknown User',
      };
    });
  return { data: rows, error: null };
}

/**
 * @param {any} db - the mock database; mutated in place
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ currentUserId: string | null, isOrgAdmin: (orgId: string) => boolean, now?: Date, newId?: () => string }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not one of these RPCs
 */
export function handleGamePublishedRpc(db, name, params, ctx) {
  if (!GAME_PUBLISHED_RPCS.includes(name)) return null;
  return name === 'admin_set_games_published'
    ? setGamesPublished(db, params, ctx)
    : scheduleAuditLog(db, params, ctx);
}
