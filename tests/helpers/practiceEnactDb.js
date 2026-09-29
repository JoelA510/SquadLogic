/**
 * 8.6 3b PR 11c: a synthetic DB for the enact UI's tests, and a fake
 * supabase client over it. Reads filter like PostgREST (`eq` on plain
 * columns; the embedded season filter is the server's, and every row here is
 * in the season). RPCs go to the mock client's own twins
 * (`frontend/src/lib/mockPracticeEnact.js`), so a write lands in `db` and
 * the next read sees it, as it would in the database.
 *
 * Every call is logged in order (`rpc:<name>`, or the table read), so a test
 * can witness that the fingerprint is read before any row.
 *
 * Synthetic rows only (`tests/helpers/practiceEnactWorld.js`).
 */
import { handlePracticeEnactRpc } from '../../frontend/src/lib/mockPracticeEnact.js';
import { SEASON, uuid } from './practiceEnactWorld.js';

export const ORG = uuid(1);
export const USER = uuid(2);
export const DIVISION = uuid(950);

/**
 * @param {Record<string, any[]>} rows - `rowsOf()` loader-shaped rows
 * @param {{ role?: string }} [options]
 */
export function enactDbOf(rows, { role = 'admin' } = {}) {
  const tag = (list) => (list ?? []).map((row) => ({ ...row, organization_id: ORG }));
  const teamIds = [...new Set((rows.practiceAssignments ?? []).map((a) => a.team_id))].sort();
  return {
    season_settings: [{ id: SEASON, organization_id: ORG, timezone: 'America/New_York' }],
    divisions: [{ id: DIVISION, organization_id: ORG, season_settings_id: SEASON }],
    organization_members: [{ organization_id: ORG, profile_id: USER, role }],
    teams: teamIds.map((id) => ({
      id,
      organization_id: ORG,
      division_id: DIVISION,
      name: `Team ${Number(id.slice(-3))}`,
    })),
    locations: tag(rows.locations),
    fields: tag(rows.fields),
    field_subunits: tag(rows.fieldSubunits),
    practice_slots: tag(rows.practiceSlots),
    team_coach_assignments: tag(rows.teamCoachAssignments),
    coach_practice_preferences: [],
    field_closures: tag(rows.fieldClosures),
    practice_assignments: tag(rows.practiceAssignments).map((a) => ({
      assigned_via: 'auto',
      ...a,
    })),
    practice_exceptions: [],
    audit_log: [],
  };
}

let counter = 0;

/**
 * @param {any} db
 * @param {string[]} log - every call, in order
 * @param {{ beforeRead?: (table: string) => void }} [hooks]
 */
export function fakeClientOf(db, log, hooks = {}) {
  const from = (table) => {
    const filters = [];
    const q = {
      select: () => q,
      eq: (col, val) => {
        if (!col.includes('.')) filters.push([col, val]);
        return q;
      },
      order: () => q,
      range: (lo, hi) => {
        log.push(table);
        hooks.beforeRead?.(table);
        const rows = (db[table] ?? []).filter((row) =>
          filters.every(([col, val]) => String(row[col]) === String(val))
        );
        return Promise.resolve({ data: structuredClone(rows.slice(lo, hi + 1)), error: null });
      },
    };
    return q;
  };
  const rpc = (name, params) => {
    log.push(`rpc:${name}`);
    const out = handlePracticeEnactRpc(db, name, structuredClone(params), {
      currentUserId: USER,
      isOrgAdmin: (orgId) =>
        db.organization_members.some(
          (m) => m.organization_id === orgId && m.profile_id === USER && m.role === 'admin'
        ),
      newId: () => uuid(800000 + (counter += 1)),
    });
    return Promise.resolve(out ?? { data: null, error: null });
  };
  return { from, rpc };
}

/** Every practice row's comparable content, for "nothing changed" witnesses. */
export function practiceRowsOf(db) {
  return JSON.stringify(
    [...db.practice_assignments]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => [a.id, a.team_id, a.practice_slot_id, a.effective_date_range, a.assigned_via])
  );
}

/**
 * `persistPracticeEnact` as the Edge would route it: the mock twin of the
 * wrapper RPC on `client`, with the Edge's 409 for a stale base.
 *
 * @param {ReturnType<typeof fakeClientOf>} client
 */
export function sendThroughMock(client) {
  return (body) =>
    client
      .rpc('enact_practice_recommendation', {
        run_data: {
          id: body.runMetadata.runId,
          season_settings_id: body.runMetadata.seasonSettingsId,
        },
        assignments: body.payload.assignmentRows,
        unlock: body.payload.repair.unlock,
        closes: body.payload.repair.closes,
        exceptions: body.payload.repair.exceptions,
        base_fingerprint: body.payload.repair.baseFingerprint ?? null,
        enact: body.enact,
      })
      .then(({ data, error }) => {
        if (error?.code === '40001') {
          return { status: 'stale', code: 'PRACTICE_SCHEDULE_STALE', message: error.message };
        }
        if (error) throw Object.assign(new Error(error.message), { code: error.code });
        return { status: 'success', ...data };
      });
}
