/**
 * The mock client's twins of `practice_schedule_fingerprint` (20260929000000)
 * and `enact_practice_recommendation` (20261004000000, 8.6 3b PR 11b), for
 * the enact UI's E2E (3b PR 11c). Behind the DEV/mock guard in
 * `mockSupabaseClient.js`, like the other late arms.
 *
 * **Mirrored**, in the SQL's order:
 * - the admin check (42501), and a NULL base fingerprint (22023, "an enact is
 *   never blind");
 * - `run_data.id = enact.enact_key = enact.run_id`, a retirement cause only;
 * - the commit gate: the cause field's STORED `effective_to` must be set
 *   (22023 "not committed"), equal `cause.loss.from - 1` (22023 "a different
 *   date"), and equal the record's `cause.stored_effective_to`;
 * - idempotency on the enact's own audit row (`metadata.enact_key`): a
 *   second call returns `{ idempotent: true }` and writes nothing;
 * - stale: a base fingerprint that is not the season's current one is
 *   40001, with nothing written;
 * - only S: `unlock`, `closes` and `exceptions` name S alone, S is a row of
 *   the season held by the record's team, and every new row the call sends
 *   (`assigned_via = 'recommendation'`) is that team's (22023);
 * - the lock: S is closed or replaced only when `unlock` names it (22023
 *   "... is locked");
 * - the write: S closed at `last_day` or removed, the recommendation rows
 *   inserted, the exceptions recorded, one `practice.unlock_accepted` row per
 *   unlock and the `practice.recommendation_enacted` row, whose metadata is
 *   the record with `stored_effective_to` and `result_fingerprint` filled.
 *
 * **NOT mirrored** (the SQL and the DB harness are the witnesses for these):
 * - the writer's whole-season key matching and its prune of superseded rows
 *   (only S's close or replacement and the new rows are applied; the rest
 *   of `assignments` is not diffed against the season);
 * - the strict record key set and the cross-checks of `writes`, `unlock` and
 *   `closes` against the record (the core schema parse is the client's);
 * - the post-write "touched only S" check (the arguments are checked before
 *   the write instead) and the writer's exception-lost and mid-range
 *   daylight checks;
 * - the `scheduler_runs` row, "run id already names another run", and the
 *   `practice.saved` audit row;
 * - advisory locks and transactional rollback (the mock applies nothing
 *   until every check has passed);
 * - md5: the fingerprint is a deterministic 32-hex digest of the same fields
 *   (id, team, slot, range, source, `assigned_via`, and each exception's id
 *   and `withdrawn_at`), not the SQL's md5, so it only equals itself.
 *
 * @module lib/mockPracticeEnact
 */

const lower = (value) => String(value ?? '').toLowerCase();

/** Four FNV-1a passes with different seeds: 32 hex characters, deterministic. */
function digest(text) {
  let out = '';
  for (const seed of [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]) {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/** The season's practice rows: team -> division -> season, in the org. */
function seasonRows(db, seasonId) {
  const divisions = new Map((db.divisions || []).map((d) => [lower(d.id), d]));
  const teamSeason = new Map(
    (db.teams || []).map((t) => [
      lower(t.id),
      lower(divisions.get(lower(t.division_id))?.season_settings_id),
    ])
  );
  return (db.practice_assignments || []).filter(
    (a) => teamSeason.get(lower(a.team_id)) === lower(seasonId)
  );
}

/** `practice_schedule_fingerprint(season)`'s fields, digested. */
export function mockPracticeFingerprint(db, seasonId) {
  const rows = [...seasonRows(db, seasonId)]
    .sort((a, b) => lower(a.id).localeCompare(lower(b.id)))
    .map((a) =>
      [
        lower(a.id),
        lower(a.team_id),
        lower(a.practice_slot_id ?? a.slot_id),
        a.effective_date_range ?? '',
        a.source ?? 'auto',
        a.assigned_via ?? 'auto',
      ].join('|')
    );
  const exceptions = (db.practice_exceptions || [])
    .filter((e) => lower(e.season_settings_id) === lower(seasonId))
    .sort((a, b) => lower(a.id).localeCompare(lower(b.id)))
    .map((e) => `${lower(e.id)}|${e.withdrawn_at ?? ''}`);
  return digest(`${rows.join(',')}#${exceptions.join(',')}`);
}

/** @param {string} iso @param {number} days */
function shiftIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const refuse = (code, message) => ({ data: null, error: { code, message } });

/**
 * @param {any} db - the mock DB (mutated on success; the caller saves it)
 * @param {string} name
 * @param {any} params
 * @param {{ currentUserId: string, isOrgAdmin: (orgId: string) => boolean, newId: () => string }} ctx
 * @returns {{ data: any, error: any } | null} null when `name` is not handled here
 */
export function handlePracticeEnactRpc(db, name, params, ctx) {
  if (name === 'practice_schedule_fingerprint') {
    return { data: mockPracticeFingerprint(db, params?.p_season_settings_id), error: null };
  }
  if (name !== 'enact_practice_recommendation') return null;

  const p = params || {};
  const runData = p.run_data || {};
  const enact = p.enact || {};
  const seasonId = lower(runData.season_settings_id);
  const season = (db.season_settings || []).find((s) => lower(s.id) === seasonId);
  const orgId = season?.organization_id;
  // 1. Admin with a uid.
  if (!season || !ctx.currentUserId || !ctx.isOrgAdmin(orgId)) {
    return refuse(
      '42501',
      `enact_practice_recommendation: only an organization admin with a uid can enact a recommendation (season ${seasonId})`
    );
  }
  // 2. Never blind.
  if (!p.base_fingerprint) {
    return refuse('22023', 'an enact is never blind: base_fingerprint is required');
  }
  // 3. The record describes this run, and a retirement.
  const key = lower(enact.enact_key);
  if (
    !key ||
    lower(enact.run_id) !== key ||
    lower(runData.id) !== key ||
    enact.cause?.kind !== 'retirement' ||
    enact.base_fingerprint !== p.base_fingerprint
  ) {
    return refuse(
      '22023',
      'enact record is malformed or does not describe the write sent (run id, season, base fingerprint)'
    );
  }
  // 2a. The commit gate.
  const fieldId = lower(enact.cause.id);
  const field = (db.fields || []).find(
    (f) => lower(f.id) === fieldId && String(f.organization_id) === String(orgId)
  );
  const stored = field?.effective_to ?? null;
  const lossFrom = enact.cause.loss?.from;
  if (stored === null) {
    return refuse(
      '22023',
      `retirement of field ${fieldId} is not committed: no effective_to is stored; save the retirement first`
    );
  }
  if (String(stored) !== shiftIso(lossFrom, -1)) {
    return refuse(
      '22023',
      `retirement of field ${fieldId} is committed with a different date: ${stored} stored, ${shiftIso(lossFrom, -1)} expected (the day before ${lossFrom})`
    );
  }
  if (enact.cause.stored_effective_to !== String(stored)) {
    return refuse(
      '22023',
      `enact record claims stored_effective_to ${enact.cause.stored_effective_to}, but ${stored} is stored`
    );
  }
  // 5. Idempotency, on the enact's own audit row.
  const already = (db.audit_log || []).some(
    (row) =>
      String(row.organization_id) === String(orgId) &&
      row.action === 'practice.recommendation_enacted' &&
      lower(row.metadata?.enact_key) === key
  );
  if (already) {
    return {
      data: {
        idempotent: true,
        run_id: key,
        fingerprint: mockPracticeFingerprint(db, seasonId),
        audited: true,
        enact_audited: true,
      },
      error: null,
    };
  }
  // The writer's fingerprint check (40001), before anything is written.
  const current = mockPracticeFingerprint(db, seasonId);
  if (p.base_fingerprint !== current) {
    return refuse(
      '40001',
      `practice schedule of season ${seasonId} changed since it was read: base fingerprint ${p.base_fingerprint}, current ${current}`
    );
  }
  // S is a row of this season, held by the record's team.
  const s = lower(enact.series?.assignment_id);
  const team = lower(enact.series?.team_id);
  const row = seasonRows(db, seasonId).find((a) => lower(a.id) === s);
  if (!row || lower(row.team_id) !== team) {
    return refuse(
      '22023',
      `enact series ${s} is not a row of season ${seasonId} held by team ${team}`
    );
  }
  const unlock = Array.isArray(p.unlock) ? p.unlock : [];
  const closes = Array.isArray(p.closes) ? p.closes : [];
  const exceptions = Array.isArray(p.exceptions) ? p.exceptions : [];
  const assignments = Array.isArray(p.assignments) ? p.assignments : [];
  const newRows = assignments.filter((a) => a.assigned_via === 'recommendation');
  const strays = [
    ...unlock.map((u) => lower(u.assignment_id)),
    ...closes.map((c) => lower(c.assignment_id)),
    ...exceptions.map((e) => lower(e.assignment_id ?? s)),
  ].filter((id) => id !== s);
  if (strays.length > 0 || newRows.some((a) => lower(a.team_id) !== team)) {
    return refuse('22023', `enact of series ${s} touched more than it: ${strays.join(', ')}`);
  }
  // The lock: S is re-ranged or replaced only under an unlock naming it.
  const close = closes.find((c) => lower(c.assignment_id) === s) ?? null;
  const replaced = !close && newRows.length > 0;
  if ((close || replaced) && !unlock.some((u) => lower(u.assignment_id) === s)) {
    return refuse('22023', `practice assignment ${s} is locked: name it in unlock to change it`);
  }
  if (!close && !replaced) {
    return refuse(
      '22023',
      `enact of series ${s} neither closed nor replaced it: nothing was enacted`
    );
  }

  // The write.
  const now = new Date().toISOString();
  const before = { ...row };
  if (close) {
    const from = String(row.effective_date_range).slice(1).split(',')[0];
    row.effective_date_range = `[${from},${close.last_day}]`;
  } else {
    db.practice_assignments = (db.practice_assignments || []).filter((a) => a !== row);
  }
  for (const added of newRows) {
    db.practice_assignments.push({
      id: ctx.newId(),
      organization_id: orgId,
      team_id: added.team_id,
      practice_slot_id: added.practice_slot_id,
      slot_id: added.practice_slot_id,
      effective_date_range: added.effective_date_range,
      source: added.source ?? 'auto',
      assigned_via: 'recommendation',
      run_id: key,
      created_at: now,
    });
  }
  db.practice_exceptions = db.practice_exceptions || [];
  for (const exception of exceptions) {
    db.practice_exceptions.push({
      id: ctx.newId(),
      organization_id: orgId,
      season_settings_id: seasonId,
      assignment_id: s,
      window: exception.window,
      kind: exception.kind,
      tbd_reason: exception.tbd_reason ?? null,
      cause_kind: exception.cause_kind ?? null,
      cause_id: exception.cause_id ?? null,
      withdrawn_at: null,
      created_at: now,
    });
  }
  const fingerprint = mockPracticeFingerprint(db, seasonId);
  db.audit_log = db.audit_log || [];
  const audit = (action, metadata) =>
    db.audit_log.push({
      id: ctx.newId(),
      organization_id: orgId,
      user_id: ctx.currentUserId,
      action,
      resource_type: 'practice_assignment',
      resource_id: s,
      metadata,
      created_at: now,
    });
  for (const u of unlock) {
    audit('practice.unlock_accepted', { run_id: key, reason: u.reason, before });
  }
  audit('practice.recommendation_enacted', {
    ...enact,
    cause: { ...enact.cause, stored_effective_to: String(stored) },
    result_fingerprint: fingerprint,
  });
  return {
    data: {
      run_id: key,
      fingerprint,
      closed: close ? [s] : [],
      unlocked: unlock.map((u) => lower(u.assignment_id)),
      exceptions_recorded: exceptions.map(() => s),
      audited: true,
      enact_audited: true,
      idempotent: false,
    },
    error: null,
  };
}
