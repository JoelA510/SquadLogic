/**
 * The mock's practice schedule import (migration `20261123010000_practice_import.sql`; plan
 * `docs/changes/2026-11-03-schedule-expansion.md` 4.11, PR 10, task K3): `map_practice_import_job`,
 * `apply_practice_import_job(job, dry_run)` and `rollback_practice_import_job`, refusals included (LESSONS_LEARNED #13),
 * with the SQL's error codes and the result in the SQL's shape.
 *
 * **One code path for the preview and the apply, as the SQL's sentinel makes it.** The apply runs on a copy of the
 * mock database; a dry run returns the result and drops the copy, an apply puts the copy in place. So the preview and the
 * apply cannot disagree on the same state here either.
 *
 * **What the SQL does and this mirrors, step for step** (the SQL's own words are in the migration): the gates in its
 * order; the staged rows' shape check (a malformed row refuses the whole apply); the season window; the stored
 * decisions (nothing guessed: a label with no decision is `unknown-*`), one creation per (parent, normalised name), a
 * create over a name that exists is no record; core's resolution order (division, location, field, subunit, team); the
 * duplicate after mapping; the slots by the fields import's key, never modified when found, made only when the supply
 * rule finds no overlap (`practice_slot_conflicts`, turnover 0), the groups that hold a team first; the created grounds
 * no written row uses taken out again; the leaving and arriving lists and the probable moves held back unless ticked;
 * team shells in ONE team run (`carryTeamRunResults`); manual practices with no run, inserted only when absent; one
 * application record per row written; the flags (the gate's five rules by a twin of `practice_new_auto_row_refusals`,
 * coach-conflict, team-on-both-halves, hold-over-open-slot, division-not-reserved); the TIME TBD rebuild (a twin of
 * `sync_schedule_tbd_practices`, which reads the date: `ctx.now`); the rollback's refusals, its "gone already" count and
 * its keep-and-report of anything changed or referenced.
 *
 * **Not mirrored:** the advisory locks, the audit failure rollback (SLA01), RLS, the CHECKs on the tables (a seeded row is
 * trusted), and a text ORDER BY's collation (JavaScript compares code units; the SQL its database's collation: the
 * lists are the same rows, and their order can differ for labels that differ only in case or punctuation). The
 * rollback's reference check is a list of the foreign keys onto the six tables it deletes from
 * (`PRACTICE_IMPORT_REFERENCES`), which `tests/mockPracticeImport.test.js` holds to the migrations; the SQL reads the
 * catalogue. Pure over `db`; `mockSupabaseClient.js` saves it.
 */

import { carryTeamRunResults } from '@squadlogic/core/utils/teamRunResults.js';
import { normaliseExternalLabel } from '@squadlogic/core/externalImport/mapping.js';

export const PRACTICE_IMPORT_RPCS = Object.freeze([
  'map_practice_import_job',
  'apply_practice_import_job',
  'rollback_practice_import_job',
]);

/** The SQL's closed list of row refusals (core's PRACTICE_IMPORT_ROW_REFUSALS). */
const ROW_REFUSALS = Object.freeze([
  'bad-use',
  'bad-day',
  'bad-time',
  'bad-length',
  'end-not-after-start',
  'bad-capacity',
  'capacity-not-positive',
  'bad-date',
  'valid-until-before-from',
  'outside-season-window',
  'missing-dates',
  'unknown-division',
  'unknown-team',
  'unknown-location',
  'unknown-field',
  'unknown-subunit',
  'team-in-two-divisions',
  'slot-overlaps-another',
  'duplicate-row',
]);
const STAGED_FLAGS = Object.freeze(['division-not-reserved']);
const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const LISTED_IDS = 50;

/**
 * The foreign keys onto the tables the rollback deletes from, by referenced table: `[child table, column]`. Two are
 * not references (they are derived and go with the row): a team's calendar token, and a practice row of the TIME TBD
 * list (a `schedule_tbd` row counts only when its kind is not `practice`).
 */
export const PRACTICE_IMPORT_REFERENCES = Object.freeze({
  practice_slots: [
    ['practice_assignments', 'practice_slot_id'],
    ['practice_assignments', 'slot_id'],
    ['practice_exceptions', 'practice_slot_id'],
    ['practice_lighting_overrides', 'practice_slot_id'],
  ],
  field_subunits: [['practice_slots', 'field_subunit_id']],
  fields: [
    ['facility_permit_scopes', 'field_id'],
    ['field_availability_profiles', 'field_id'],
    ['field_blackouts', 'field_id'],
    ['field_subunits', 'field_id'],
    ['game_assignments', 'field_id'],
    ['game_slots', 'field_id'],
    ['practice_assignments', 'field_id'],
    ['practice_slots', 'field_id'],
  ],
  locations: [
    ['facility_permit_scopes', 'location_id'],
    ['field_blackouts', 'location_id'],
    ['fields', 'location_id'],
  ],
  teams: [
    ['coach_practice_preferences', 'team_id'],
    ['game_assignments', 'away_team_id'],
    ['game_assignments', 'home_team_id'],
    ['games', 'away_team_id'],
    ['games', 'home_team_id'],
    ['practice_assignments', 'team_id'],
    ['practice_exceptions', 'team_id'],
    ['schedule_tbd', 'away_team_id'],
    ['schedule_tbd', 'home_team_id'],
    ['schedule_tbd', 'team_id'],
    ['team_coach_assignments', 'team_id'],
    ['team_players', 'team_id'],
  ],
  divisions: [
    ['game_slots', 'division_id'],
    ['players', 'division_id'],
    ['practice_slots', 'division_id'],
    ['schedule_tbd', 'division_id'],
    ['teams', 'division_id'],
  ],
  scheduler_runs: [
    ['evaluation_runs', 'scheduler_run_id'],
    ['game_assignments', 'run_id'],
    ['practice_assignments', 'run_id'],
    ['practice_exceptions', 'run_id'],
    ['schedule_tbd', 'run_id'],
  ],
});

const same = (a, b) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
const fail = (code, message, details) => ({
  data: null,
  error: { code, message, details: details ?? null, hint: null },
});
const key = (s) => normaliseExternalLabel(String(s ?? ''));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------- dates and times

const DAY_MS = 86400000;
const toDay = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** ISO weekday, 1 (Monday) to 7 (Sunday). */
const isodow = (n) => ((new Date(n * DAY_MS).getUTCDay() + 6) % 7) + 1;
const dowOf = (day) => DAYS.indexOf(day) + 1;
/** Minutes past midnight of `HH:MM` or `HH:MM:SS`. */
const mins = (t) => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
const clock = (t) => String(t).slice(0, 5);
const isDate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && fromDay(toDay(v)) === v;

/** A daterange literal as `{ lo, hi }` day numbers, `hi` exclusive; null bounds are open; null is no range. */
function rangeOf(text) {
  if (text === null || text === undefined) return null;
  const m = /^([[(])\s*([^,]*)\s*,\s*([^\])]*)\s*([\])])$/.exec(String(text).trim());
  if (!m) return null;
  const lo = m[2] ? toDay(m[2]) + (m[1] === '(' ? 1 : 0) : null;
  const hi = m[3] ? toDay(m[3]) + (m[4] === ']' ? 1 : 0) : null;
  return { lo, hi };
}
/** The canonical text of [from, until] (inclusive), as PostgreSQL stores a daterange. */
const canonicalRange = (from, until) => `[${from},${fromDay(toDay(until) + 1)})`;
const isEmptyRange = (r) => r !== null && r.lo !== null && r.hi !== null && r.hi <= r.lo;

// ---------------------------------------------------------------------------------------------- the twins

/** `practice_slot_conflicts(org, field, subunit, day, start, end, from, until, NULL, 0)`, earliest start first. */
export function mockPracticeSlotConflicts(
  db,
  org,
  fieldId,
  subunitId,
  day,
  start,
  end,
  from,
  until
) {
  const dow = dowOf(day);
  return (db.practice_slots || [])
    .filter((ps) => {
      if (!same(ps.organization_id, org) || !same(ps.field_id, fieldId) || ps.day_of_week !== day)
        return false;
      if (subunitId && ps.field_subunit_id && !same(ps.field_subunit_id, subunitId)) return false;
      const lo = Math.max(
        ps.valid_from ? toDay(ps.valid_from) : -Infinity,
        from ? toDay(from) : -Infinity
      );
      const hi = Math.min(
        ps.valid_until ? toDay(ps.valid_until) : Infinity,
        until ? toDay(until) : Infinity
      );
      if (lo > hi) return false;
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo + ((dow - isodow(lo) + 7) % 7) > hi)
        return false;
      return mins(ps.start_time) < mins(end) && mins(start) < mins(ps.end_time);
    })
    .sort((a, b) => mins(a.start_time) - mins(b.start_time) || cmp(String(a.id), String(b.id)));
}

/** The gate, `practice_new_auto_row_refusals(org, ids)`: `{ assignment_id, team_id, practice_slot_id, rule, detail }`. */
export function mockPracticeNewAutoRowRefusals(db, org, ids) {
  const judged = new Set(ids.map(String));
  const all = db.practice_assignments || [];
  const byId = new Map(all.map((pa) => [String(pa.id), pa]));
  const teamsJ = new Set([...judged].map((id) => String(byId.get(id)?.team_id)));
  const slotsJ = new Set([...judged].map((id) => String(byId.get(id)?.practice_slot_id)));
  const slotOf = new Map((db.practice_slots || []).map((s) => [String(s.id), s]));
  const teamOf = new Map((db.teams || []).map((t) => [String(t.id), t]));
  const divOf = new Map((db.divisions || []).map((d) => [String(d.id), d]));
  const live = [];
  for (const pa of all) {
    if (!same(pa.organization_id, org) || !pa.practice_slot_id) continue;
    const ps = slotOf.get(String(pa.practice_slot_id));
    const team = teamOf.get(String(pa.team_id));
    if (!ps || !team) continue;
    const rng = rangeOf(pa.effective_date_range);
    if (isEmptyRange(rng)) continue;
    if (
      !(
        judged.has(String(pa.id)) ||
        teamsJ.has(String(pa.team_id)) ||
        slotsJ.has(String(pa.practice_slot_id))
      )
    )
      continue;
    const lows = [rng?.lo ?? null, ps.valid_from ? toDay(ps.valid_from) : null].filter(
      (v) => v !== null
    );
    if (lows.length === 0) continue;
    const lo = Math.max(...lows);
    const highs = [
      rng && rng.hi !== null ? rng.hi - 1 : null,
      ps.valid_until ? toDay(ps.valid_until) : null,
    ].filter((v) => v !== null);
    const hi = highs.length ? Math.min(...highs) : lo + 366;
    const dow = dowOf(ps.day_of_week);
    const first = lo + ((dow - isodow(lo) + 7) % 7);
    const last = hi - ((isodow(hi) - dow + 7) % 7);
    if (first > last) continue;
    live.push({
      id: String(pa.id),
      team: String(pa.team_id),
      slot: String(pa.practice_slot_id),
      ps,
      dow,
      first,
      last,
      slotDiv: ps.division_id ?? null,
      teamDiv: team.division_id,
    });
  }
  const out = [];
  for (const j of live.filter((l) => judged.has(l.id))) {
    const div = divOf.get(String(j.teamDiv)) ?? {};
    const ppw = div.practices_per_week ?? 1;
    const pm = div.practice_minutes ?? null;
    const push = (rule, detail) =>
      out.push({ assignment_id: j.id, team_id: j.team, practice_slot_id: j.slot, rule, detail });
    // capacity
    const onSlot = live.filter((o) => o.slot === j.slot);
    let peak = 0;
    for (const p of onSlot) {
      if (p.first < j.first || p.first > j.last) continue;
      peak = Math.max(peak, onSlot.filter((o) => o.first <= p.first && p.first <= o.last).length);
    }
    const cap = j.ps.capacity ?? 1;
    if (peak > cap) push('capacity', `the slot holds ${peak} at once, its capacity is ${cap}`);
    if (j.slotDiv && !same(j.slotDiv, j.teamDiv)) push('reservation', '');
    if (pm !== null && mins(j.ps.end_time) - mins(j.ps.start_time) !== pm) {
      push(
        'length',
        `the slot is ${mins(j.ps.end_time) - mins(j.ps.start_time)} minutes, the division's practice is ${pm}`
      );
    }
    for (const o of live) {
      if (
        o.team === j.team &&
        o.id !== j.id &&
        o.ps.day_of_week === j.ps.day_of_week &&
        o.first <= j.last &&
        j.first <= o.last
      ) {
        push('weekday', '');
      }
    }
    const mine = live.filter((o) => o.team === j.team);
    const wk0 = j.first - (isodow(j.first) - 1);
    let top = 0;
    for (let ws = wk0; ws <= j.last; ws += 7) {
      top = Math.max(
        top,
        mine.filter((o) => ws + (o.dow - 1) >= o.first && ws + (o.dow - 1) <= o.last).length
      );
    }
    if (top > ppw)
      push('count', `the team holds ${top} practices in one week, its division's count is ${ppw}`);
  }
  return out;
}

/** `sync_schedule_tbd_practices(org, season, NULL, NULL)`: the season's practice rows of the TIME TBD list, rebuilt. */
export function mockSyncScheduleTbdPractices(db, org, season, today, newId, stamp) {
  const t0 = toDay(today);
  const prev = new Map(
    (db.schedule_tbd || [])
      .filter(
        (s) =>
          same(s.organization_id, org) &&
          same(s.season_settings_id, season) &&
          s.kind === 'practice'
      )
      .map((s) => [String(s.team_id), s])
  );
  db.schedule_tbd = (db.schedule_tbd || []).filter(
    (s) =>
      !(same(s.organization_id, org) && same(s.season_settings_id, season) && s.kind === 'practice')
  );
  const divs = (db.divisions || []).filter(
    (d) => same(d.organization_id, org) && same(d.season_settings_id, season)
  );
  for (const t of db.teams || []) {
    if (!same(t.organization_id, org) || t.is_external === true) continue;
    const d = divs.find((x) => same(x.id, t.division_id));
    if (!d) continue;
    const live = (db.practice_assignments || [])
      .filter((pa) => same(pa.team_id, t.id) && same(pa.organization_id, org))
      .map((pa) => rangeOf(pa.effective_date_range))
      .filter((r) => r === null || (!isEmptyRange(r) && (r.hi === null || r.hi > t0)));
    const starts = [...new Set(live.map((r) => Math.max(r?.lo ?? t0, t0)))];
    const held = Math.max(
      0,
      ...starts.map(
        (s) =>
          live.filter(
            (r) => r === null || ((r.lo === null || r.lo <= s) && (r.hi === null || s < r.hi))
          ).length
      )
    );
    const ppw = d.practices_per_week ?? 1;
    if (ppw <= held) continue;
    const before = prev.get(String(t.id));
    db.schedule_tbd.push({
      id: newId(),
      organization_id: org,
      season_settings_id: season,
      kind: 'practice',
      division_id: d.id,
      team_id: t.id,
      home_team_id: null,
      away_team_id: null,
      week_index: null,
      missing_count: ppw - held,
      reason: before?.reason ?? 'not-scheduled-yet',
      detail: { target: ppw, held },
      run_id: before?.run_id ?? null,
      created_at: stamp,
      external_ref: null,
      game_date: null,
    });
  }
  const rows = db.schedule_tbd.filter(
    (s) =>
      same(s.organization_id, org) && same(s.season_settings_id, season) && s.kind === 'practice'
  );
  return {
    practice_rows: rows.length,
    missing_practices: rows.reduce((n, s) => n + (s.missing_count ?? 0), 0),
    rows,
  };
}

/** The SQL's `practice_import_referenced(table, id)`, over the list of keys above. */
export function mockPracticeImportReferenced(db, table, id) {
  return (PRACTICE_IMPORT_REFERENCES[table] ?? []).some(([child, column]) =>
    (db[child] || []).some(
      (row) => same(row[column], id) && !(child === 'schedule_tbd' && row.kind === 'practice')
    )
  );
}

// ---------------------------------------------------------------------------------------------- the RPCs

const jobSeason = (db, job) =>
  (db.season_settings || []).find(
    (s) => same(s.id, job.season_settings_id) && same(s.organization_id, job.organization_id)
  );

function jobGates(db, jobId, ctx) {
  if (!ctx.currentUserId) return fail('42501', 'a signed-in caller is required');
  if (!jobId) return fail('22023', 'p_import_job_id is required');
  const job = (db.import_jobs || []).find((item) => same(item.id, jobId));
  if (!job) return fail('P0002', `Import job ${jobId} not found`);
  if (!ctx.isOrgAdmin(job.organization_id)) {
    return fail(
      '42501',
      `Access denied: user is not an admin of organization ${job.organization_id}`
    );
  }
  if (job.job_type !== 'practice_schedule') {
    return fail('22023', `Import job ${jobId} is ${job.job_type}, not practice_schedule`);
  }
  return { job };
}

/**
 * @param {any} db
 * @param {string} name
 * @param {Record<string, any>} params
 * @param {{ isOrgAdmin: (organizationId: string) => boolean, currentUserId: string | null,
 *   newId?: () => string, now?: () => string }} ctx
 * @returns {any} `{ data, error }`, or null when `name` is not one of these RPCs
 */
export function handlePracticeImportRpc(db, name, params, ctx) {
  if (!PRACTICE_IMPORT_RPCS.includes(name)) return null;
  const env = {
    newId: ctx.newId ?? (() => globalThis.crypto.randomUUID()),
    now: ctx.now ?? (() => new Date().toISOString()),
  };
  const gated = jobGates(db, params?.p_import_job_id, ctx);
  if (gated.error) return gated;
  if (name === 'map_practice_import_job') return mapJob(db, gated.job, params?.p_mapping, ctx, env);
  if (name === 'rollback_practice_import_job') return rollbackJob(db, gated.job, ctx, env);
  return applyJob(db, gated.job, params?.p_dry_run === true, ctx, env);
}

const GROUPS = Object.freeze({
  divisions: 'division',
  locations: 'location',
  fields: 'field',
  subunits: 'subunit',
  teams: 'team',
});

function mapJob(db, job, mapping, ctx, env) {
  if (!['importing', 'ready_to_apply'].includes(job.status)) {
    return fail(
      '22023',
      `Import job ${job.id} is ${job.status}: its mapping can no longer be changed`
    );
  }
  const season = jobSeason(db, job);
  if (!season)
    return fail('22023', `Import job ${job.id} has no season to import into`, 'season_missing');
  if (season.status === 'completed') {
    return fail(
      '22023',
      `Season ${season.id} is completed and takes no import`,
      'season_completed'
    );
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
    return fail('22023', 'the mapping must be an object');
  if (Object.keys(mapping).some((k) => !(k in GROUPS) && k !== 'options')) {
    return fail(
      '22023',
      'the mapping holds options, divisions, locations, fields, subunits and teams and nothing else'
    );
  }
  let add = [];
  if ('options' in mapping) {
    const o = mapping.options;
    const list = o?.add_moved_rows;
    if (
      !o ||
      typeof o !== 'object' ||
      Array.isArray(o) ||
      Object.keys(o).some((k) => k !== 'add_moved_rows') ||
      ('add_moved_rows' in o &&
        (!Array.isArray(list) ||
          list.length > 2400 ||
          list.some((e) => typeof e !== 'string' || e.length < 1 || e.length > 100)))
    ) {
      return fail(
        '22023',
        'the options are { add_moved_rows: the row keys of the moved rows to add, at most 2400 }'
      );
    }
    add = [...new Set(list ?? [])].sort(cmp);
  }
  const org = job.organization_id;
  const clean = {};
  const counts = {};
  const decisions = {};
  for (const [group, kind] of Object.entries(GROUPS)) {
    const entries = mapping[group] ?? {};
    if (typeof entries !== 'object' || Array.isArray(entries))
      return fail('22023', `the ${group} of the mapping must be an object`);
    const out = {};
    for (const k of Object.keys(entries).sort(cmp)) {
      const d = entries[k];
      if (k.length === 0 || k.length > 1000)
        return fail('22023', `a decision key of ${group} is empty or over 1000 characters`);
      if (!d || typeof d !== 'object' || Array.isArray(d))
        return fail('22023', `a decision of ${group} must be an object`);
      if (!['map', 'create', 'skip'].includes(d.action))
        return fail(
          '22023',
          `a decision of ${group} is not one of its actions (map, create, skip)`
        );
      const source = d.source ?? 'admin';
      if (!['exact', 'alias', 'previous', 'admin'].includes(source))
        return fail('22023', "a decision's source is one of exact, alias, previous, admin");
      const name =
        typeof d.name === 'string' ? d.name.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') : null;
      if (
        d.name !== undefined &&
        d.name !== null &&
        (typeof d.name !== 'string' || (name ?? '').length > 200)
      ) {
        return fail('22023', `a name of a created ${kind} is text of at most 200 characters`);
      }
      if (d.action === 'map') {
        if (typeof d.id !== 'string' || !UUID.test(d.id))
          return fail('22023', `a map decision of ${group} names a record by its id`);
        const known =
          kind === 'division'
            ? (db.divisions || []).some(
                (x) =>
                  same(x.id, d.id) &&
                  same(x.organization_id, org) &&
                  same(x.season_settings_id, job.season_settings_id)
              )
            : kind === 'location'
              ? (db.locations || []).some((x) => same(x.id, d.id) && same(x.organization_id, org))
              : kind === 'field'
                ? (db.fields || []).some((x) => same(x.id, d.id) && same(x.organization_id, org))
                : kind === 'subunit'
                  ? (db.field_subunits || []).some(
                      (x) => same(x.id, d.id) && same(x.organization_id, org)
                    )
                  : (db.teams || []).some(
                      (t) =>
                        same(t.id, d.id) &&
                        same(t.organization_id, org) &&
                        t.is_external !== true &&
                        (db.divisions || []).some(
                          (x) =>
                            same(x.id, t.division_id) &&
                            same(x.season_settings_id, job.season_settings_id)
                        )
                    );
        if (!known) {
          return fail(
            '22023',
            `the ${kind} ${d.id} is not a record of this organization and season (an outside club has no practice)`
          );
        }
        out[k] = { action: 'map', id: d.id.toLowerCase(), source };
      } else {
        out[k] = { action: d.action, source, ...(d.action === 'create' && name ? { name } : {}) };
      }
    }
    clean[group] = out;
    counts[group] = Object.keys(out).length;
    decisions[group] = {};
    for (const d of Object.values(out)) {
      const tag = `${d.action}:${d.source}`;
      decisions[group][tag] = (decisions[group][tag] ?? 0) + 1;
    }
  }
  clean.options = { add_moved_rows: add };
  job.warning_summary = { ...(job.warning_summary || {}), practice_mapping: clean };
  (db.audit_log = db.audit_log || []).push({
    id: env.newId(),
    organization_id: org,
    user_id: ctx.currentUserId,
    action: 'import.mapped',
    resource_type: 'import_job',
    resource_id: job.id,
    metadata: { import_type: 'practice_schedule', add_moved_rows: add.length, decisions },
    created_at: env.now(),
  });
  return { data: { job_id: job.id, add_moved_rows: add.length, ...counts }, error: null };
}

// ------------------------------------------------------------------------------------------------- the apply

function applyJob(db, job, dry, ctx, env) {
  if (['completed', 'completed_with_warnings'].includes(job.status)) {
    if (job.warning_summary?.practice_import) {
      return { data: { ...job.warning_summary.practice_import, replayed: true }, error: null };
    }
    return fail('22023', `Import job ${job.id} is already ${job.status}`);
  }
  if (['failed', 'needs_fix'].includes(job.status)) {
    return fail('22023', `Import job ${job.id} cannot be applied: a new file is a new job`);
  }
  const season = jobSeason(db, job);
  if (!season)
    return fail('22023', `Import job ${job.id} has no season to import into`, 'season_missing');
  if (season.status === 'completed')
    return fail(
      '22023',
      `Season ${season.id} is completed and takes no import`,
      'season_completed'
    );
  if (season.status !== 'active') {
    return fail(
      '22023',
      `Season ${season.id} is ${season.status} and takes no practice schedule import: only the active season does`,
      'season_not_active'
    );
  }
  const map = job.warning_summary?.practice_mapping;
  if (!map)
    return fail(
      '22023',
      `Import job ${job.id} has no mapping: confirm what each label of the file is first`,
      'mapping_required'
    );

  // The one code path: on a copy. A dry run drops it (the SQL's sentinel); an apply puts it in place.
  const work = structuredClone(db);
  const done = planAndWrite(work, job.id, season, map, ctx, env);
  if (done.error) return done;
  if (!dry) for (const k of Object.keys(work)) db[k] = work[k];
  return {
    data: { ...done.result, dry_run: dry, ids: { team_run_id: dry ? null : done.teamRunId } },
    error: null,
  };
}

function planAndWrite(db, jobId, season, map, ctx, env) {
  const job = db.import_jobs.find((j) => same(j.id, jobId));
  const org = job.organization_id;
  const seasonId = season.id;
  const stamp = env.now();
  const add = new Set(map.options?.add_moved_rows ?? []);

  // 1. The staged rows, read once, and their shape.
  const rows = (db.staging_import_rows || [])
    .filter(
      (s) =>
        same(s.import_job_id, jobId) &&
        same(s.organization_id, org) &&
        s.import_type === 'practice_schedule'
    )
    .map((s) => {
      const p = s.normalized_payload;
      const errors = Array.isArray(s.validation_errors) ? s.validation_errors : [];
      const refused = p === null || p === undefined || errors.length > 0;
      const text = (v) => String(v ?? '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
      return {
        rowno: s.source_row_number ?? null,
        parse_refused: refused,
        parse_reason: errors[0]?.code ?? null,
        parse_message: errors[0]?.message ?? null,
        row_key: p?.row_key ?? null,
        status: p?.status ?? null,
        day: DAYS.includes(p?.day) ? p.day : null,
        start: CLOCK.test(String(p?.start_time ?? '')) ? p.start_time : null,
        end: CLOCK.test(String(p?.end_time ?? '')) ? p.end_time : null,
        from: isDate(p?.valid_from) ? p.valid_from : null,
        until: isDate(p?.valid_until) ? p.valid_until : null,
        capacity:
          Number.isInteger(p?.capacity) && p.capacity >= 1 && p.capacity <= 32767
            ? p.capacity
            : null,
        flags: Array.isArray(p?.flags) ? p.flags.map(String) : null,
        division_label: text(p?.division),
        division_key: String(p?.division_key ?? ''),
        location_label: text(p?.location),
        location_key: String(p?.location_key ?? ''),
        field_label: text(p?.field),
        field_key: String(p?.field_key ?? ''),
        subunit_label: text(p?.subunit),
        subunit_key: String(p?.subunit_key ?? ''),
        team_label: text(p?.team),
        team_key: String(p?.team_key ?? ''),
      };
    })
    .sort((a, b) => (a.rowno ?? -Infinity) - (b.rowno ?? -Infinity));
  if (rows.length === 0)
    return fail('22023', `Import job ${jobId} has no staged practice rows`, 'no_rows');
  const bad = rows.find(
    (r) =>
      r.rowno === null ||
      (r.parse_refused && !ROW_REFUSALS.includes(r.parse_reason ?? '')) ||
      (!r.parse_refused &&
        !(
          ['placement', 'open', 'hold'].includes(r.status) &&
          r.row_key &&
          String(r.row_key).length <= 100 &&
          r.day &&
          r.start &&
          r.end &&
          mins(r.end) > mins(r.start) &&
          r.from &&
          r.until &&
          r.until >= r.from &&
          (r.status === 'hold' || r.capacity !== null) &&
          r.location_label &&
          r.location_key &&
          r.field_label &&
          r.field_key &&
          (r.subunit_label === '') === (r.subunit_key === '') &&
          (r.status === 'placement'
            ? r.division_label && r.division_key && r.team_label && r.team_key
            : r.team_label === '' && r.team_key === '' && r.division_key === '') &&
          r.flags !== null &&
          r.flags.every((f) => STAGED_FLAGS.includes(f))
        ))
  );
  if (bad)
    return fail(
      '22023',
      `staged row ${bad.rowno} is not a practice row`,
      'practice_import_staged_invalid'
    );
  const keys = rows.filter((r) => !r.parse_refused).map((r) => r.row_key);
  if (
    new Set(keys).size !== keys.length ||
    new Set(rows.map((r) => r.rowno)).size !== rows.length
  ) {
    return fail(
      '22023',
      'two staged rows share a row key or a row number',
      'practice_import_staged_invalid'
    );
  }
  for (const r of rows) {
    Object.assign(
      r,
      r.parse_refused
        ? { outcome: 'refused', reason: r.parse_reason, message: r.parse_message }
        : { outcome: 'ok', reason: null, message: null }
    );
    if (
      r.outcome === 'ok' &&
      ((season.season_start && r.from < season.season_start) ||
        (season.season_end && r.until > season.season_end))
    ) {
      r.outcome = 'refused';
      r.reason = 'outside-season-window';
      r.message = `The dates ${r.from} to ${r.until} are outside the season (${season.season_start ?? 'open'} to ${season.season_end ?? 'open'}).`;
    }
  }

  // 2. Decisions and what each label is.
  const decOf = (group, k) => {
    const d = map[group]?.[k];
    return d && ['map', 'create', 'skip'].includes(d.action) ? d : null;
  };
  const okRows = () => rows.filter((r) => r.outcome === 'ok');
  /** One table per kind, as the SQL's `_pi_div`, `_pi_loc`, ...: key -> { action, ref, cname, creator }. */
  const resolve = (keysOf, decGroup, existing, siblings) => {
    const entries = [];
    for (const [k, info] of keysOf) {
      const d = decOf(decGroup, k);
      const e = {
        key: k,
        action: d?.action ?? null,
        parent: info.parent ?? null,
        ref: null,
        cname: null,
        can_create: false,
        creator: false,
      };
      if (d?.action === 'map') e.ref = existing(d.id, info) ?? null;
      if (d?.action === 'create' && (info.parent !== undefined ? info.parent !== null : true)) {
        e.cname = d.name ?? info.label;
        e.can_create = !siblings(info).some((x) => key(x) === key(e.cname));
      }
      entries.push(e);
    }
    // One creation per (parent, normalised name): the first key (code-unit order, as the SQL's ORDER BY on the key) makes it.
    const groups = new Map();
    for (const e of [...entries].sort((a, b) => cmp(a.key, b.key))) {
      if (!e.can_create) continue;
      const g = JSON.stringify([String(e.parent ?? ''), key(e.cname)]);
      if (!groups.has(g)) {
        groups.set(g, env.newId());
        e.creator = true;
      }
      e.ref = groups.get(g);
    }
    return new Map(entries.map((e) => [e.key, e]));
  };
  const firstBy = (list, keyFn, labelFn, parentFn) => {
    const m = new Map();
    for (const r of list)
      if (!m.has(keyFn(r)))
        m.set(keyFn(r), { label: labelFn(r), parentKey: parentFn ? parentFn(r) : null });
    return m;
  };
  const divTable = resolve(
    firstBy(
      okRows().filter((r) => r.status === 'placement'),
      (r) => r.division_key,
      (r) => r.division_label
    ),
    'divisions',
    (id) =>
      (db.divisions || []).find(
        (d) =>
          same(d.id, id) && same(d.organization_id, org) && same(d.season_settings_id, seasonId)
      )?.id,
    () =>
      (db.divisions || [])
        .filter((d) => same(d.organization_id, org) && same(d.season_settings_id, seasonId))
        .map((d) => d.name)
  );
  const locTable = resolve(
    firstBy(
      okRows(),
      (r) => r.location_key,
      (r) => r.location_label
    ),
    'locations',
    (id) => (db.locations || []).find((l) => same(l.id, id) && same(l.organization_id, org))?.id,
    () => (db.locations || []).filter((l) => same(l.organization_id, org)).map((l) => l.name)
  );
  const withParent = (m, table) => {
    for (const info of m.values()) {
      const p = table.get(info.parentKey);
      info.parent = p && ['map', 'create'].includes(p.action) ? p.ref : null;
    }
    return m;
  };
  const fldTable = resolve(
    withParent(
      firstBy(
        okRows(),
        (r) => r.field_key,
        (r) => r.field_label,
        (r) => r.location_key
      ),
      locTable
    ),
    'fields',
    (id, info) =>
      info.parent
        ? (db.fields || []).find(
            (f) =>
              same(f.id, id) && same(f.organization_id, org) && same(f.location_id, info.parent)
          )?.id
        : null,
    (info) =>
      (db.fields || [])
        .filter((f) => same(f.organization_id, org) && same(f.location_id, info.parent))
        .map((f) => f.name)
  );
  const subTable = resolve(
    withParent(
      firstBy(
        okRows().filter((r) => r.subunit_key !== ''),
        (r) => r.subunit_key,
        (r) => r.subunit_label,
        (r) => r.field_key
      ),
      fldTable
    ),
    'subunits',
    (id, info) =>
      info.parent
        ? (db.field_subunits || []).find(
            (s) => same(s.id, id) && same(s.organization_id, org) && same(s.field_id, info.parent)
          )?.id
        : null,
    (info) =>
      (db.field_subunits || [])
        .filter((s) => same(s.organization_id, org) && same(s.field_id, info.parent))
        .map((s) => s.label)
  );
  const teamTable = resolve(
    withParent(
      firstBy(
        okRows().filter((r) => r.status === 'placement'),
        (r) => r.team_key,
        (r) => r.team_label,
        (r) => r.division_key
      ),
      divTable
    ),
    'teams',
    (id, info) =>
      info.parent
        ? (db.teams || []).find(
            (t) =>
              same(t.id, id) &&
              same(t.organization_id, org) &&
              same(t.division_id, info.parent) &&
              t.is_external !== true
          )?.id
        : null,
    (info) =>
      (db.teams || [])
        .filter((t) => same(t.organization_id, org) && same(t.division_id, info.parent))
        .map((t) => t.name)
  );
  const usable = (e) => (e && ['map', 'create'].includes(e.action) ? e.ref : null);
  for (const r of okRows().filter((x) => x.status !== 'hold')) {
    const dv = r.status === 'placement' ? divTable.get(r.division_key) : null;
    const l = locTable.get(r.location_key);
    const f = fldTable.get(r.field_key);
    const s = r.subunit_key ? subTable.get(r.subunit_key) : null;
    const t = r.status === 'placement' ? teamTable.get(r.team_key) : null;
    const step =
      r.status === 'placement' && dv?.action === 'skip'
        ? 'skip:division'
        : r.status === 'placement' && !dv?.ref
          ? 'unknown-division'
          : l?.action === 'skip'
            ? 'skip:location'
            : !l?.ref
              ? 'unknown-location'
              : f?.action === 'skip'
                ? 'skip:field'
                : !f?.ref
                  ? 'unknown-field'
                  : r.subunit_key && s?.action === 'skip'
                    ? 'skip:subunit'
                    : r.subunit_key && !s?.ref
                      ? 'unknown-subunit'
                      : r.status === 'placement' && t?.action === 'skip'
                        ? 'skip:team'
                        : r.status === 'placement' && !t?.ref
                          ? 'unknown-team'
                          : null;
    if (step === null) {
      Object.assign(r, {
        div_ref: dv?.ref ?? null,
        loc_ref: l.ref,
        fld_ref: f.ref,
        sub_ref: s?.ref ?? null,
        team_ref: t?.ref ?? null,
      });
    } else if (step.startsWith('skip:')) {
      const kind = step.slice(5);
      r.outcome = 'skipped';
      r.skip_kind = kind;
      r.skip_label = r[`${kind}_label`];
    } else {
      r.outcome = 'refused';
      r.reason = step;
      r.message = {
        'unknown-division': `The division "${r.division_label}" has no decision this import can use: map it, create it, or skip its rows.`,
        'unknown-location': `The location "${r.location_label}" has no decision this import can use: map it, create it, or skip its rows.`,
        'unknown-field': `The field "${r.field_label}" of "${r.location_label}" has no decision this import can use: map it, create it, or skip its rows.`,
        'unknown-subunit': `The half or side "${r.subunit_label}" of "${r.field_label}" has no decision this import can use. Leave Subunit blank for the whole field.`,
        'unknown-team': `The team "${r.team_label}" of "${r.division_label}" has no decision this import can use: map it, create it, or skip its rows.`,
      }[step];
    }
  }
  for (const r of okRows().filter((x) => x.status === 'hold')) {
    r.loc_ref = usable(locTable.get(r.location_key));
    r.fld_ref = usable(fldTable.get(r.field_key));
    r.sub_ref = r.subunit_key ? usable(subTable.get(r.subunit_key)) : null;
    if (r.subunit_key && !r.sub_ref) r.fld_ref = null;
  }
  const dupSeen = new Set();
  for (const r of okRows().filter((x) => x.status === 'placement' || x.status === 'open')) {
    const k = JSON.stringify([
      r.status,
      r.team_ref ?? null,
      r.fld_ref,
      r.sub_ref ?? null,
      r.day,
      r.start,
      r.end,
      r.from,
      r.until,
      r.capacity,
    ]);
    if (dupSeen.has(k)) {
      Object.assign(r, {
        outcome: 'refused',
        reason: 'duplicate-row',
        message:
          'After mapping, this is the same practice as an earlier row; the earlier row is the one imported.',
      });
    } else dupSeen.add(k);
  }

  // 3. The grounds the admin chose to create.
  const used = (field, notHold = false) =>
    new Set(
      okRows()
        .filter((r) => !notHold || r.status !== 'hold')
        .map((r) => r[field])
        .filter(Boolean)
        .map(String)
    );
  const usedDiv = used('div_ref');
  for (const e of divTable.values()) {
    if (e.creator && usedDiv.has(String(e.ref))) {
      (db.divisions = db.divisions || []).push({
        id: e.ref,
        organization_id: org,
        season_settings_id: seasonId,
        name: e.cname,
        practices_per_week: 1,
        practice_minutes: null,
        created_at: stamp,
        updated_at: stamp,
      });
    }
  }
  const usedLoc = used('loc_ref', true);
  for (const e of locTable.values()) {
    if (e.creator && usedLoc.has(String(e.ref))) {
      (db.locations = db.locations || []).push({
        id: e.ref,
        organization_id: org,
        name: e.cname,
        address: null,
        lighting_available: null,
        created_at: stamp,
        updated_at: stamp,
        effective_to: null,
        latitude: null,
        longitude: null,
        coordinates_set_at: null,
        coordinates_set_by: null,
      });
    }
  }
  const usedFld = used('fld_ref', true);
  for (const e of fldTable.values()) {
    if (e.creator && usedFld.has(String(e.ref))) {
      (db.fields = db.fields || []).push({
        id: e.ref,
        organization_id: org,
        location_id: e.parent,
        name: e.cname,
        surface_type: null,
        size: null,
        supports_halves: okRows().some((r) => same(r.fld_ref, e.ref) && r.subunit_key !== ''),
        max_age: null,
        priority_rating: null,
        active: true,
        created_at: stamp,
        updated_at: stamp,
        effective_to: null,
      });
    }
  }
  const usedSub = used('sub_ref', true);
  for (const e of subTable.values()) {
    if (e.creator && usedSub.has(String(e.ref))) {
      (db.field_subunits = db.field_subunits || []).push({
        id: e.ref,
        organization_id: org,
        field_id: e.parent,
        label: e.cname,
        created_at: stamp,
        updated_at: stamp,
        effective_to: null,
      });
    }
  }

  // 4. The slots.
  const gkey = (r) =>
    JSON.stringify([String(r.fld_ref), String(r.sub_ref ?? ''), r.day, r.start, r.from]);
  const groups = new Map();
  for (const r of okRows().filter((x) => x.status === 'placement' || x.status === 'open')) {
    if (!groups.has(gkey(r)))
      groups.set(gkey(r), {
        key: gkey(r),
        first: r,
        holds_team: false,
        slot_id: null,
        created: false,
        clash_id: null,
      });
  }
  for (const r of okRows().filter((x) => x.status === 'placement' || x.status === 'open')) {
    const g = groups.get(gkey(r)).first;
    if (r.end !== g.end || r.until !== g.until || r.capacity !== g.capacity) {
      Object.assign(r, {
        outcome: 'refused',
        reason: 'slot-overlaps-another',
        message: `This is the same slot as row ${g.rowno} with a different End, Valid Until or Capacity. A slot is one of each: make the rows agree.`,
      });
    }
  }
  for (const g of groups.values()) {
    g.holds_team = okRows().some((r) => r.status === 'placement' && gkey(r) === g.key);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => Number(!a.holds_team) - Number(!b.holds_team) || a.first.rowno - b.first.rowno
  );
  for (const g of ordered) {
    const f = g.first;
    const found = (db.practice_slots || [])
      .filter(
        (ps) =>
          same(ps.organization_id, org) &&
          same(ps.field_id, f.fld_ref) &&
          ((!f.sub_ref && !ps.field_subunit_id) || same(ps.field_subunit_id, f.sub_ref)) &&
          ps.day_of_week === f.day &&
          clock(ps.start_time) === f.start &&
          ps.valid_from === f.from
      )
      .sort(
        (a, b) =>
          cmp(String(a.created_at ?? ''), String(b.created_at ?? '')) ||
          cmp(String(a.id), String(b.id))
      )[0];
    if (found) {
      g.slot_id = found.id;
      continue;
    }
    const clash = mockPracticeSlotConflicts(
      db,
      org,
      f.fld_ref,
      f.sub_ref,
      f.day,
      f.start,
      f.end,
      f.from,
      f.until
    )[0];
    if (clash) {
      g.clash_id = clash.id;
      continue;
    }
    const row = {
      id: env.newId(),
      organization_id: org,
      field_id: f.fld_ref,
      field_subunit_id: f.sub_ref ?? null,
      day_of_week: f.day,
      start_time: `${f.start}:00`,
      end_time: `${f.end}:00`,
      capacity: f.capacity,
      valid_from: f.from,
      valid_until: f.until,
      label: null,
      created_at: stamp,
      updated_at: stamp,
      division_id: null,
    };
    (db.practice_slots = db.practice_slots || []).push(row);
    g.slot_id = row.id;
    g.created = true;
  }
  for (const g of groups.values()) {
    if (!g.clash_id) continue;
    const other = [...groups.values()].find((o) => o.created && same(o.slot_id, g.clash_id));
    for (const r of okRows().filter(
      (x) => (x.status === 'placement' || x.status === 'open') && gkey(x) === g.key
    )) {
      Object.assign(r, {
        outcome: 'refused',
        reason: 'slot-overlaps-another',
        message: other
          ? `This slot overlaps the slot of row ${other.first.rowno} on the same ground at the same time. Two slots cannot claim one ground: the one a team is placed in is imported, else the earlier row.`
          : `This slot overlaps the saved slot ${g.clash_id} on the same ground at the same time (a slot that exists is never changed by an import). Fix the slot on Field Management, or set this row's dates to the slot's.`,
      });
    }
  }
  const liveGroups = [...groups.values()].filter((g) => g.slot_id);
  const creators = (table) =>
    [...table.values()].filter((e) => e.creator).map((e) => String(e.ref));
  db.field_subunits = (db.field_subunits || []).filter(
    (s) =>
      !creators(subTable).includes(String(s.id)) ||
      liveGroups.some((g) => same(g.first.sub_ref, s.id))
  );
  db.fields = (db.fields || []).filter(
    (f) =>
      !creators(fldTable).includes(String(f.id)) ||
      liveGroups.some((g) => same(g.first.fld_ref, f.id))
  );
  db.locations = (db.locations || []).filter(
    (l) =>
      !creators(locTable).includes(String(l.id)) || db.fields.some((f) => same(f.location_id, l.id))
  );

  // 5. The rows as practices, what is leaving, and the probable moves.
  const asg = [];
  for (const r of okRows().filter((x) => x.status === 'placement')) {
    const g = groups.get(gkey(r));
    if (!g?.slot_id) continue;
    const rng = canonicalRange(r.from, r.until);
    const existing = (db.practice_assignments || []).find(
      (pa) =>
        same(pa.team_id, r.team_ref) &&
        same(pa.practice_slot_id, g.slot_id) &&
        String(pa.effective_date_range) === rng
    );
    asg.push({
      rowno: r.rowno,
      row_key: r.row_key,
      team_ref: r.team_ref,
      team_label: r.team_label,
      slot_id: g.slot_id,
      rng,
      row: r,
      existing_id: existing?.id ?? null,
      new_id: null,
      probable_move: false,
      held_back: false,
    });
  }
  const seasonTeams = new Set(
    (db.teams || [])
      .filter(
        (t) =>
          t.is_external !== true &&
          (db.divisions || []).some(
            (d) => same(d.id, t.division_id) && same(d.season_settings_id, seasonId)
          )
      )
      .map((t) => String(t.id).toLowerCase())
  );
  const matched = new Set(asg.filter((a) => a.existing_id).map((a) => String(a.existing_id)));
  const slotById = new Map((db.practice_slots || []).map((s) => [String(s.id), s]));
  const leave = (db.practice_assignments || [])
    .filter(
      (pa) =>
        same(pa.organization_id, org) &&
        seasonTeams.has(String(pa.team_id).toLowerCase()) &&
        slotById.has(String(pa.practice_slot_id)) &&
        !matched.has(String(pa.id))
    )
    .map((pa) => {
      const ps = slotById.get(String(pa.practice_slot_id));
      return {
        id: pa.id,
        team_id: pa.team_id,
        team: (db.teams || []).find((t) => same(t.id, pa.team_id))?.name ?? null,
        day: ps.day_of_week,
        start: `${clock(ps.start_time)}:00`,
        end: `${clock(ps.end_time)}:00`,
        field_id: ps.field_id,
        field_subunit_id: ps.field_subunit_id ?? null,
        rng: pa.effective_date_range ?? null,
      };
    });
  const leavingTeams = new Set(leave.map((l) => String(l.team_id).toLowerCase()));
  for (const a of asg) {
    if (a.existing_id === null && leavingTeams.has(String(a.team_ref).toLowerCase())) {
      a.probable_move = true;
      a.held_back = !add.has(a.row_key);
    }
  }

  // 6. Team shells in ONE team run.
  const usedTeams = new Set(asg.map((a) => String(a.team_ref)));
  const shells = [...teamTable.values()].filter((e) => e.creator && usedTeams.has(String(e.ref)));
  const shellDivs = new Set(shells.map((e) => String(e.parent)));
  db.divisions = db.divisions.filter(
    (d) => !creators(divTable).includes(String(d.id)) || shellDivs.has(String(d.id))
  );
  let teamRunId = null;
  const shellIds = shells.map((e) => e.ref).sort(cmp);
  if (shells.length > 0) {
    const divisions = [...shellDivs].sort(cmp).map((id) => ({
      id,
      name: (db.divisions || []).find((d) => same(d.id, id))?.name,
      teams: shells
        .filter((e) => same(e.parent, id))
        .sort((a, b) => cmp(a.cname, b.cname) || cmp(a.ref, b.ref))
        .map((e) => ({ id: e.ref, name: e.cname })),
    }));
    for (const e of shells) {
      (db.teams = db.teams || []).push({
        id: e.ref,
        organization_id: org,
        division_id: e.parent,
        name: e.cname,
        coach_id: null,
        assistant_coach_ids: [],
        practice_slot_id: null,
        notes: null,
        created_at: stamp,
        updated_at: stamp,
        custom_attributes: {},
        is_external: false,
      });
    }
    const prev = (db.scheduler_runs || [])
      .filter(
        (sr) =>
          same(sr.organization_id, org) &&
          sr.run_type === 'team' &&
          sr.status === 'completed' &&
          (same(sr.season_settings_id, seasonId) || same(sr.season_id, seasonId))
      )
      .sort(
        (a, b) => cmp(String(b.created_at), String(a.created_at)) || cmp(String(b.id), String(a.id))
      )[0];
    teamRunId = env.newId();
    (db.scheduler_runs = db.scheduler_runs || []).push({
      id: teamRunId,
      organization_id: org,
      season_id: seasonId,
      season_settings_id: seasonId,
      run_type: 'team',
      status: 'completed',
      parameters: {
        source: 'import',
        import_type: 'practice_schedule',
        import_job_id: jobId,
        shell_ids: shellIds,
      },
      metrics: null,
      results: carryTeamRunResults({
        base: prev?.results ?? null,
        divisions,
        ownTeams: (db.teams || []).filter(
          (t) => t.is_external !== true && !shellIds.some((id) => same(id, t.id))
        ),
      }),
      created_by: ctx.currentUserId,
      started_at: stamp,
      completed_at: stamp,
      created_at: stamp,
      updated_at: stamp,
    });
  }

  // 7. The practices: additive, manual, no run.
  for (const a of asg
    .filter((x) => x.existing_id === null && !x.held_back)
    .sort((x, y) => x.rowno - y.rowno)) {
    const ps =
      slotById.get(String(a.slot_id)) ?? db.practice_slots.find((s) => same(s.id, a.slot_id));
    const row = {
      id: env.newId(),
      organization_id: org,
      team_id: a.team_ref,
      slot_id: a.slot_id,
      practice_slot_id: a.slot_id,
      day_of_week: ps.day_of_week,
      start_time: `${clock(ps.start_time)}:00`,
      end_time: `${clock(ps.end_time)}:00`,
      field_id: ps.field_id,
      effective_date_range: a.rng,
      source: 'manual',
      created_at: stamp,
      updated_at: stamp,
      run_id: null,
      assigned_via: 'manual',
    };
    (db.practice_assignments = db.practice_assignments || []).push(row);
    a.new_id = row.id;
  }
  const records = (db.import_application_records = db.import_application_records || []);
  const record = (table, row) =>
    records.push({
      id: env.newId(),
      organization_id: org,
      import_job_id: jobId,
      import_type: 'practice_schedule',
      target_table: table,
      target_id: row.id,
      operation: 'inserted',
      previous_payload: null,
      applied_payload: structuredClone(row),
      applied_at: stamp,
      applied_by: ctx.currentUserId,
      rolled_back_at: null,
      rolled_back_by: null,
      rollback_payload: null,
      created_at: stamp,
    });
  const createdIds = (table) =>
    new Set([...table.values()].filter((e) => e.creator).map((e) => String(e.ref)));
  /** @type {Array<[string, Set<string>]>} */
  const written = [
    ['divisions', createdIds(divTable)],
    ['locations', createdIds(locTable)],
    ['fields', createdIds(fldTable)],
    ['field_subunits', createdIds(subTable)],
    ['teams', new Set(shellIds.map(String))],
    ['practice_slots', new Set(liveGroups.filter((g) => g.created).map((g) => String(g.slot_id)))],
    ['practice_assignments', new Set(asg.filter((a) => a.new_id).map((a) => String(a.new_id)))],
  ];
  for (const [table, ids] of written) {
    for (const row of db[table] || []) if (ids.has(String(row.id))) record(table, row);
  }

  // 8. The flags.
  const flags = [];
  const fileIds = asg
    .map((a) => a.existing_id ?? a.new_id)
    .filter(Boolean)
    .map(String);
  const asgById = new Map(asg.map((a) => [String(a.existing_id ?? a.new_id), a]));
  for (const g of mockPracticeNewAutoRowRefusals(db, org, fileIds)) {
    const a = asgById.get(String(g.assignment_id));
    flags.push({
      rowno: a.rowno,
      row_key: a.row_key,
      team_id: a.team_ref,
      code: g.rule,
      detail: ['capacity', 'length', 'count'].includes(g.rule)
        ? g.detail
        : g.rule === 'weekday'
          ? 'the team has another practice on this weekday on a shared date'
          : 'the slot is reserved to another division',
    });
  }
  const tca = db.team_coach_assignments || [];
  const coachSeen = new Set();
  const paById = new Map((db.practice_assignments || []).map((pa) => [String(pa.id), pa]));
  for (const a of [...asg].sort((x, y) => x.rowno - y.rowno)) {
    const pa = paById.get(String(a.existing_id ?? a.new_id));
    if (!pa) continue;
    const ps = db.practice_slots.find((s) => same(s.id, pa.practice_slot_id));
    const ra = rangeOf(pa.effective_date_range);
    const hits = [];
    for (const ca of tca.filter((c) => same(c.team_id, a.team_ref))) {
      for (const cb of tca.filter(
        (c) => same(c.coach_id, ca.coach_id) && !same(c.team_id, a.team_ref)
      )) {
        const ot = (db.teams || []).find((t) => same(t.id, cb.team_id) && t.is_external !== true);
        if (!ot) continue;
        for (const pb of (db.practice_assignments || []).filter(
          (x) => same(x.team_id, cb.team_id) && same(x.organization_id, org)
        )) {
          const pbs = db.practice_slots.find((s) => same(s.id, pb.practice_slot_id));
          if (
            !pbs ||
            pbs.day_of_week !== ps.day_of_week ||
            !(mins(pbs.start_time) < mins(ps.end_time) && mins(ps.start_time) < mins(pbs.end_time))
          )
            continue;
          const rb = rangeOf(pb.effective_date_range);
          if (isEmptyRange(rb)) continue;
          const lo = Math.max(
            ra.lo,
            rb?.lo ?? (pbs.valid_from ? toDay(pbs.valid_from) : -Infinity),
            toDay(ca.effective_from),
            toDay(cb.effective_from)
          );
          const hi = Math.min(
            ra.hi - 1,
            rb && rb.hi !== null ? rb.hi - 1 : pbs.valid_until ? toDay(pbs.valid_until) : Infinity,
            ca.effective_to ? toDay(ca.effective_to) : Infinity,
            cb.effective_to ? toDay(cb.effective_to) : Infinity
          );
          if (!Number.isFinite(lo) || lo > hi) continue;
          if (lo + ((dowOf(ps.day_of_week) - isodow(lo) + 7) % 7) > hi) continue;
          hits.push({ coach: String(ca.coach_id), other: ot.name });
        }
      }
    }
    hits.sort((x, y) => cmp(x.coach, y.coach) || cmp(x.other, y.other));
    for (const h of hits) {
      const k = `${a.rowno}|${h.coach}`;
      if (coachSeen.has(k)) continue;
      coachSeen.add(k);
      flags.push({
        rowno: a.rowno,
        row_key: a.row_key,
        team_id: a.team_ref,
        code: 'coach-conflict',
        detail: `a coach of this team (${h.coach}) also coaches ${h.other} at an overlapping time on this weekday`,
      });
    }
  }
  for (const a of asg) {
    const ra = a.row;
    const partners = asg
      .filter((b) => b !== a && same(b.team_ref, a.team_ref))
      .filter((b) => {
        const rb = b.row;
        if (
          !same(ra.fld_ref, rb.fld_ref) ||
          !ra.sub_ref ||
          !rb.sub_ref ||
          same(ra.sub_ref, rb.sub_ref) ||
          ra.day !== rb.day
        )
          return false;
        if (!(mins(ra.start) < mins(rb.end) && mins(rb.start) < mins(ra.end))) return false;
        const lo = Math.max(toDay(ra.from), toDay(rb.from));
        const hi = Math.min(toDay(ra.until), toDay(rb.until));
        return lo + ((dowOf(ra.day) - isodow(lo) + 7) % 7) <= hi;
      });
    if (partners.length) {
      flags.push({
        rowno: a.rowno,
        row_key: a.row_key,
        team_id: a.team_ref,
        code: 'team-on-both-halves',
        detail: `the team is on both halves of this field at the same time (rows ${partners
          .map((b) => b.rowno)
          .sort((x, y) => x - y)
          .join(', ')}). That is the whole field: leave Subunit blank for the whole field.`,
      });
    }
  }
  for (const r of okRows().filter(
    (x) => x.status === 'hold' && x.fld_ref && db.fields.some((f) => same(f.id, x.fld_ref))
  )) {
    const over = mockPracticeSlotConflicts(
      db,
      org,
      r.fld_ref,
      r.sub_ref,
      r.day,
      r.start,
      r.end,
      r.from,
      r.until
    );
    if (over.length === 0) continue;
    const usedOne = over.some((s) =>
      (db.practice_assignments || []).some((pa) => same(pa.practice_slot_id, s.id))
    );
    flags.push({
      rowno: r.rowno,
      row_key: r.row_key,
      team_id: null,
      code: 'hold-over-open-slot',
      detail: `This cell is held for a non-team activity, but ${over.length} slot(s) are there${usedOne ? ', with a team in one' : ''}. The hold makes no slot, and removes or moves nothing.`,
    });
  }
  for (const r of okRows().filter((x) => x.flags.includes('division-not-reserved'))) {
    flags.push({
      rowno: r.rowno,
      row_key: r.row_key,
      team_id: null,
      code: 'division-not-reserved',
      detail:
        'A Division on a row with no team reserves nothing in this import (an admin sets reservations on Field Management).',
    });
  }

  // 9. The TIME TBD list.
  const tbd = mockSyncScheduleTbdPractices(
    db,
    org,
    seasonId,
    env.now().slice(0, 10),
    env.newId,
    stamp
  );
  const fileTeams = new Set(
    okRows()
      .map((r) => r.team_ref)
      .filter(Boolean)
      .map((t) => String(t).toLowerCase())
  );

  // 10. The result.
  const count = (pred) => rows.filter(pred).length;
  const refusedByReason = {};
  for (const r of rows.filter((x) => x.outcome === 'refused'))
    refusedByReason[r.reason] = (refusedByReason[r.reason] ?? 0) + 1;
  const flagSummary = {};
  for (const code of [...new Set(flags.map((f) => f.code))]) {
    const mine = flags.filter((f) => f.code === code);
    flagSummary[code] = {
      rows: new Set(mine.map((f) => f.rowno)).size,
      teams: new Set(
        mine
          .map((f) => f.team_id)
          .filter(Boolean)
          .map(String)
      ).size,
    };
  }
  const result = {
    job_id: jobId,
    counts: {
      rows: rows.length,
      placements: count((r) => !r.parse_refused && r.status === 'placement'),
      open: count((r) => !r.parse_refused && r.status === 'open'),
      holds: count((r) => !r.parse_refused && r.status === 'hold'),
      refused: count((r) => r.outcome === 'refused'),
      skipped: count((r) => r.outcome === 'skipped'),
      inserted: asg.filter((a) => a.new_id).length,
      unchanged: asg.filter((a) => a.existing_id).length,
      held_back: asg.filter((a) => a.held_back).length,
      slots_created: liveGroups.filter((g) => g.created).length,
      slots_found: liveGroups.filter((g) => !g.created).length,
      divisions_created: [...createdIds(divTable)].filter((id) =>
        db.divisions.some((d) => same(d.id, id))
      ).length,
      locations_created: [...createdIds(locTable)].filter((id) =>
        db.locations.some((l) => same(l.id, id))
      ).length,
      fields_created: [...createdIds(fldTable)].filter((id) =>
        db.fields.some((f) => same(f.id, id))
      ).length,
      subunits_created: [...createdIds(subTable)].filter((id) =>
        db.field_subunits.some((s) => same(s.id, id))
      ).length,
      team_shells_created: shellIds.length,
      leaving: leave.length,
      arriving: asg.filter((a) => a.existing_id === null).length,
      probable_move_teams: new Set(
        asg.filter((a) => a.probable_move).map((a) => String(a.team_ref))
      ).size,
    },
    refused_by_reason: refusedByReason,
    refused: rows
      .filter((r) => r.outcome === 'refused')
      .map((r) => ({ row: r.rowno, row_key: r.row_key, reason: r.reason, message: r.message })),
    skipped: rows
      .filter((r) => r.outcome === 'skipped')
      .map((r) => ({ row: r.rowno, row_key: r.row_key, kind: r.skip_kind, label: r.skip_label })),
    flags: flagSummary,
    flagged: flags
      .map((f) => ({ row: f.rowno, row_key: f.row_key, code: f.code, detail: f.detail }))
      .sort((a, b) => a.row - b.row || cmp(a.code, b.code) || cmp(a.detail, b.detail)),
    arriving: asg
      .filter((a) => a.existing_id === null)
      .sort((a, b) => a.rowno - b.rowno)
      .map((a) => ({
        row: a.rowno,
        row_key: a.row_key,
        team_id: a.team_ref,
        team: a.team_label,
        probable_move: a.probable_move,
        added: !a.held_back,
      })),
    leaving: leave
      .sort(
        (a, b) =>
          cmp(a.team ?? '', b.team ?? '') ||
          cmp(a.day, b.day) ||
          cmp(a.start, b.start) ||
          cmp(String(a.id), String(b.id))
      )
      .map((l) => ({
        assignment_id: l.id,
        team_id: l.team_id,
        team: l.team,
        day: l.day,
        start_time: clock(l.start),
        end_time: clock(l.end),
        field_id: l.field_id,
        field_subunit_id: l.field_subunit_id,
        range: l.rng,
      })),
    holds: okRows()
      .filter((r) => r.status === 'hold')
      .map((r) => ({ row: r.rowno, row_key: r.row_key, ground_known: Boolean(r.fld_ref) })),
    time_tbd: {
      practice_rows: tbd.practice_rows,
      missing_practices: tbd.missing_practices,
      teams: tbd.rows
        .map((s) => ({
          team_id: s.team_id,
          missing_count: s.missing_count,
          in_file: fileTeams.has(String(s.team_id).toLowerCase()),
        }))
        .sort((a, b) => cmp(String(a.team_id), String(b.team_id))),
    },
    coverage: {
      checked: [
        'capacity',
        'reservation',
        'length',
        'weekday',
        'count',
        'coach-conflict',
        'team-on-both-halves',
        'hold-over-open-slot',
      ],
      not_checked: [
        'coach preference rules',
        'daylight and sunset',
        'field closures and permits',
        'travel or turnover between fields',
      ],
      coach_judged_teams: new Set(
        asg
          .filter((a) => tca.some((c) => same(c.team_id, a.team_ref)))
          .map((a) => String(a.team_ref))
      ).size,
      file_teams: new Set(asg.map((a) => String(a.team_ref))).size,
    },
  };
  result.status =
    result.counts.refused > 0 ||
    result.counts.skipped > 0 ||
    Object.keys(flagSummary).length > 0 ||
    result.counts.held_back > 0
      ? 'completed_with_warnings'
      : 'completed';
  (db.audit_log = db.audit_log || []).push({
    id: env.newId(),
    organization_id: org,
    user_id: ctx.currentUserId,
    action: 'import.completed',
    resource_type: 'import_job',
    resource_id: jobId,
    metadata: {
      import_type: 'practice_schedule',
      status: result.status,
      ...result.counts,
      flags: flagSummary,
      refused_by_reason: refusedByReason,
    },
    created_at: stamp,
  });
  Object.assign(job, {
    status: result.status,
    processed_rows: rows.length,
    progress_percent: 100,
    completed_at: stamp,
    warning_summary: { ...(job.warning_summary || {}), practice_import: result },
  });
  return { result, teamRunId };
}

// ------------------------------------------------------------------------------------------------- the rollback

/** The SQL's `game_import_row_unchanged`: every column the apply recorded still holds that value (instants aside). */
function rowUnchanged(now, applied) {
  if (!now || !applied || Object.keys(applied).length === 0) return false;
  const keys = new Set([...Object.keys(applied), ...Object.keys(now)]);
  keys.delete('created_at');
  keys.delete('updated_at');
  return [...keys].every(
    (k) => JSON.stringify(now[k] ?? null) === JSON.stringify(applied[k] ?? null)
  );
}

function rollbackJob(db, job, ctx, env) {
  const org = job.organization_id;
  const season = jobSeason(db, job);
  if (season?.status === 'completed') {
    return fail(
      '22023',
      `Season ${season.id} is completed: its practices are read-only`,
      'season_completed'
    );
  }
  const mine = (db.import_application_records || []).filter(
    (r) =>
      same(r.import_job_id, job.id) && r.import_type === 'practice_schedule' && !r.rolled_back_at
  );
  if (mine.length === 0) {
    return fail(
      '22023',
      `Import job ${job.id} has no practice application records to roll back`,
      'nothing_to_roll_back'
    );
  }
  const asgRecords = mine.filter((r) => r.target_table === 'practice_assignments');
  const changed = asgRecords
    .filter((r) => {
      const pa = (db.practice_assignments || []).find((x) => same(x.id, r.target_id));
      if (!pa) return false;
      const a = r.applied_payload;
      return (
        String(pa.team_id) !== String(a.team_id) ||
        String(pa.practice_slot_id) !== String(a.practice_slot_id) ||
        String(pa.effective_date_range) !== String(a.effective_date_range) ||
        pa.source !== a.source ||
        pa.assigned_via !== a.assigned_via ||
        (db.practice_exceptions || []).some((e) => same(e.assignment_id, pa.id))
      );
    })
    .map((r) => String(r.target_id))
    .sort(cmp);
  if (changed.length > 0) {
    return fail(
      '22023',
      `practice_import_changed count=${changed.length} ids=${changed.slice(0, LISTED_IDS).join(',')}`,
      'practice_import_changed'
    );
  }
  const gone = asgRecords.filter(
    (r) => !(db.practice_assignments || []).some((x) => same(x.id, r.target_id))
  ).length;
  const asgIds = new Set(asgRecords.map((r) => String(r.target_id)));
  const before = (db.practice_assignments || []).length;
  db.practice_assignments = (db.practice_assignments || []).filter(
    (pa) => !asgIds.has(String(pa.id))
  );
  const nAsg = before - db.practice_assignments.length;

  const named = new Set();
  for (const sr of db.scheduler_runs || []) {
    if (
      sr.run_type !== 'team' ||
      !same(sr.organization_id, org) ||
      same(sr.parameters?.import_job_id, job.id)
    )
      continue;
    for (const m of JSON.stringify(sr.results ?? null).matchAll(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
    ))
      named.add(m[0].toLowerCase());
  }
  const deleted = {};
  for (const table of [
    'practice_slots',
    'field_subunits',
    'fields',
    'locations',
    'teams',
    'divisions',
  ]) {
    let n = 0;
    for (const r of mine.filter((x) => x.target_table === table)) {
      const row = (db[table] || []).find((x) => same(x.id, r.target_id));
      if (
        !row ||
        !rowUnchanged(row, r.applied_payload) ||
        mockPracticeImportReferenced(db, table, row.id)
      )
        continue;
      if (
        table === 'teams' &&
        ((db.players || []).some((p) => same(p.team_id, row.id)) ||
          named.has(String(row.id).toLowerCase()))
      )
        continue;
      db[table] = db[table].filter((x) => x !== row);
      if (table === 'teams') {
        db.team_calendar_tokens = (db.team_calendar_tokens || []).filter(
          (t) => !same(t.team_id, row.id)
        );
        db.schedule_tbd = (db.schedule_tbd || []).filter(
          (s) => !(s.kind === 'practice' && same(s.team_id, row.id))
        );
      }
      if (table === 'divisions')
        db.schedule_tbd = (db.schedule_tbd || []).filter(
          (s) => !(s.kind === 'practice' && same(s.division_id, row.id))
        );
      n += 1;
    }
    deleted[table] = n;
  }
  const teamExists = (id) => (db.teams || []).some((t) => same(t.id, id));
  let teamRunsDeleted = 0;
  db.scheduler_runs = (db.scheduler_runs || []).filter((sr) => {
    if (
      !(
        same(sr.organization_id, org) &&
        sr.run_type === 'team' &&
        same(sr.parameters?.import_job_id, job.id)
      )
    )
      return true;
    if (
      (sr.parameters?.shell_ids ?? []).some(teamExists) ||
      mockPracticeImportReferenced(db, 'scheduler_runs', sr.id)
    )
      return true;
    teamRunsDeleted += 1;
    return false;
  });
  for (const sr of db.scheduler_runs) {
    if (
      !(
        same(sr.organization_id, org) &&
        sr.run_type === 'team' &&
        same(sr.parameters?.import_job_id, job.id)
      )
    )
      continue;
    const shells = sr.parameters?.shell_ids ?? [];
    if (!shells.some(teamExists)) {
      sr.status = 'failed';
      sr.parameters = { ...sr.parameters, rolled_back: true };
    }
    const goneIds = shells.filter((id) => !teamExists(id)).map(String);
    if (goneIds.length > 0) {
      sr.parameters = { ...sr.parameters, shell_ids: shells.filter(teamExists) };
      const keep = (list) => list.filter((t) => !goneIds.includes(String(t?.id)));
      if (sr.results?.teamsByDivision && typeof sr.results.teamsByDivision === 'object') {
        sr.results = {
          ...sr.results,
          teamsByDivision: Object.fromEntries(
            Object.entries(sr.results.teamsByDivision)
              .map(([k, v]) => [k, keep(Array.isArray(v) ? v : [])])
              .filter(([, v]) => v.length > 0)
          ),
        };
      }
      if (Array.isArray(sr.results?.teams))
        sr.results = { ...sr.results, teams: keep(sr.results.teams) };
    }
  }
  const kept = mine
    .filter(
      (r) =>
        r.target_table !== 'practice_assignments' &&
        (db[r.target_table] || []).some((x) => same(x.id, r.target_id))
    )
    .map((r) => ({ table: r.target_table, id: r.target_id }))
    .sort((a, b) => cmp(a.table, b.table) || cmp(String(a.id), String(b.id)));
  const stamp = env.now();
  for (const r of mine)
    Object.assign(r, {
      rolled_back_at: stamp,
      rolled_back_by: ctx.currentUserId,
      rollback_payload: { rolled_back: true },
    });
  const tbd = mockSyncScheduleTbdPractices(
    db,
    org,
    job.season_settings_id,
    stamp.slice(0, 10),
    env.newId,
    stamp
  );
  const result = {
    job_id: job.id,
    assignments_deleted: nAsg,
    assignments_already_gone: gone,
    deleted,
    team_runs_deleted: teamRunsDeleted,
    kept,
    time_tbd: { practice_rows: tbd.practice_rows, missing_practices: tbd.missing_practices },
  };
  (db.audit_log = db.audit_log || []).push({
    id: env.newId(),
    organization_id: org,
    user_id: ctx.currentUserId,
    action: 'import.rolled_back',
    resource_type: 'import_job',
    resource_id: job.id,
    metadata: { import_type: 'practice_schedule', ...result },
    created_at: stamp,
  });
  Object.assign(job, {
    status: 'needs_fix',
    warning_summary: { ...(job.warning_summary || {}), practice_import_rollback: result },
  });
  return { data: result, error: null };
}
