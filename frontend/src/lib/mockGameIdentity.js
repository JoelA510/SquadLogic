/**
 * Mock arms for a game's identity (migration `20261120010000_game_identity.sql`; plan
 * `docs/changes/2026-11-06-games-table-source-of-truth.md`, I1 and I3), refusals included (LESSONS_LEARNED #13), with the
 * SQL's error codes and `DETAIL`s:
 *
 * - {@link mockGameIsHeld} / {@link mockGameHeldIds}: the one predicate "this game is held where it is" (today:
 *   Published). Internal in the database (no client role may execute them), so the mock exposes them as functions and
 *   not as `rpc()` names.
 * - {@link mockPersistGameSchedule}, `persist_game_schedule`: an assignment that names a saved game by `id` UPDATES that
 *   row in place (its slot, field, teams, week, start, end, source, run and season), so the game keeps its id, its flag
 *   and its history; an assignment without an id is upserted on the matchup tuple (home, away, slot, week) as it always
 *   was. Refused, in the database's order and writing nothing: an id that is not a uuid (22023
 *   `game_identity_invalid`), a game named twice (22023 `game_identity_repeated`), an id that is not a game of the
 *   organization, another organization's included, in the same words (23503 `game_not_found`), a game that would end
 *   where another stored game or another game of the save is (22023 `game_identity_conflict`, DETAIL `ids=<first>[,
 *   <second>]`), a held game of the season the save leaves out, counted present by its id OR its tuple (22023
 *   `game_published_omitted count=<n> ids=<first 50>`), a held game that would be moved (22023 `game_published`, the
 *   guard), a game of a completed season (22023 `season_completed`). Two games that swap places in one save work.
 *
 * **Written independently of `@squadlogic/core/gameIdentity.js` on purpose.** The predicate, the id shape and the
 * clash rule below are a second copy, so that `tests/mockGameIdentity.test.js` can run one input that reaches every
 * outcome through the mock and the pure helper and require the two to agree (lesson 77); importing the helper here
 * would make that test compare a function with itself.
 *
 * **Not mirrored** (stated so nobody reads this as the database): the organization's advisory lock and the row locks,
 * the `game.saved` audit row and its SLA01 rollback, the TIME TBD list the save also records, and the exemptions of the
 * triggers for a job with no signed-in user (the mock's writes are always the signed-in app's).
 *
 * Pure over `db`; `mockSupabaseClient.js` wires {@link mockPersistGameSchedule} into `rpc('persist_game_schedule')`.
 */

import { isRowHeld, publishedWriteRefusal } from './mockGamePublished.js';
import { scheduleWriteRefusal } from './mockSeasons.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const fail = (code, message, detail) => ({
  data: null,
  error: { code, message, details: detail ?? null, hint: null },
});

/**
 * Whether a game is held where it is: the database's `game_is_held` (false for an unknown or null id, never null).
 *
 * @param {any} db
 * @param {string | null | undefined} id
 */
export function mockGameIsHeld(db, id) {
  if (id === null || id === undefined) return false;
  return mockGameHeldIds(db, [id]).length > 0;
}

/**
 * The ids, among those given, of the games that are held: the database's `game_held_ids`.
 *
 * @param {any} db
 * @param {Array<string | null | undefined>} ids
 * @returns {string[]}
 */
export function mockGameHeldIds(db, ids) {
  const wanted = new Set(
    (ids || [])
      .filter((id) => id !== null && id !== undefined)
      .map((id) => String(id).toLowerCase())
  );
  return (db.game_assignments || [])
    .filter((row) => wanted.has(String(row.id).toLowerCase()) && isRowHeld(row))
    .map((row) => row.id);
}

const tupleOf = (row) => {
  const parts = [
    row.home_team_id,
    row.away_team_id,
    row.game_slot_id ?? row.slot_id,
    row.week_index,
  ];
  return parts.some((part) => part === null || part === undefined || part === '')
    ? null
    : parts.map((part) => String(part).toLowerCase()).join('|');
};

const pick = (item, ...keys) => {
  for (const key of keys) {
    const value = item?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

/**
 * `persist_game_schedule(run_data, assignments)`. Returns `{ data: <run id>, error: null }`, or `{ data: null, error }`
 * with the database's SQLSTATE, message and DETAIL, and then nothing has changed in `db`.
 *
 * @param {any} db - the mock database; changed only when the save is accepted
 * @param {Record<string, any>} runData
 * @param {any} assignments
 * @param {{ currentUserId: string | null, isOrgAdmin: (orgId: string) => boolean, now?: Date, newId?: () => string }} ctx
 */
export function mockPersistGameSchedule(db, runData, assignments, ctx) {
  const newId = ctx.newId ?? (() => globalThis.crypto.randomUUID());
  const now = (ctx.now ?? new Date()).toISOString();
  if (runData === null || typeof runData !== 'object' || Array.isArray(runData)) {
    return fail('22023', 'run_data must be a JSON object');
  }
  const items = assignments === null || assignments === undefined ? [] : assignments;
  if (!Array.isArray(items)) return fail('22023', 'assignments must be a JSON array');
  if ((runData.run_type || 'game') !== 'game')
    return fail('22023', 'persist_game_schedule only accepts game runs');
  if (!ctx.currentUserId) {
    return fail('42501', 'persist_game_schedule needs a signed-in caller to audit the save');
  }

  const seasonId = pick(runData, 'season_id') ?? pick(runData, 'season_settings_id');
  let orgId = pick(runData, 'organization_id');
  if (seasonId) {
    const season = (db.season_settings || []).find((row) => same(row.id, seasonId));
    if (!season) return fail('23503', `season_settings_id ${seasonId} does not exist`);
    if (orgId && !same(orgId, season.organization_id)) {
      return fail(
        '42501',
        `season_settings_id ${seasonId} does not belong to organization ${orgId}`
      );
    }
    orgId = orgId || season.organization_id;
  }
  if (!orgId) return fail('23502', 'organization_id or season_settings_id is required');
  if (!ctx.isOrgAdmin(orgId))
    return fail('42501', `caller is not an admin of organization ${orgId}`);

  if (items.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
    return fail('22023', 'each assignment must be a JSON object');
  }

  // An id is a uuid; absent, null and empty are no id.
  for (const item of items) {
    const id = item.id;
    if (id === undefined || id === null || id === '') continue;
    if (typeof id !== 'string' || !UUID.test(id)) {
      return fail(
        '22023',
        `assignment id "${String(id).slice(0, 60)}" is not a game id (a uuid)`,
        'game_identity_invalid'
      );
    }
  }

  // The rows as they will be stored.
  const teamOf = (id) => (db.teams || []).find((row) => same(row.id, id));
  const slotOf = (id) => (db.game_slots || []).find((row) => same(row.id, id));
  const rows = [];
  for (const [ordinal, item] of items.entries()) {
    const home = pick(item, 'home_team_id', 'homeTeamId');
    const away = pick(item, 'away_team_id', 'awayTeamId');
    const slot = pick(item, 'game_slot_id', 'gameSlotId', 'slot_id', 'slotId');
    const week = pick(item, 'week_index', 'weekIndex');
    const start = pick(item, 'start', 'kickoff');
    const end = pick(item, 'end');
    if (!home) return fail('23502', 'assignment home_team_id is required');
    if (!away) return fail('23502', 'assignment away_team_id is required');
    if (!slot) return fail('23502', 'assignment game_slot_id or slot_id is required');
    if (week === null) return fail('23502', 'assignment week_index is required');
    if (!start || !end) return fail('23502', 'assignment start and end are required');
    if (same(home, away)) return fail('22023', 'home_team_id and away_team_id must differ');
    if (Date.parse(end) <= Date.parse(start))
      return fail('22023', 'assignment end must be after start');
    const source = String(pick(item, 'assignment_source', 'source') ?? 'auto').toLowerCase();
    const assignmentSource = source === 'locked' ? 'manual' : source;
    if (!['auto', 'manual'].includes(assignmentSource))
      return fail('22023', 'invalid game assignment source');
    if (!(Number(week) > 0)) return fail('22023', 'assignment week_index must be positive');
    const homeTeam = teamOf(home);
    const awayTeam = teamOf(away);
    const slotRow = slotOf(slot);
    if (!homeTeam) return fail('23503', `home team ${home} does not exist`);
    if (!awayTeam) return fail('23503', `away team ${away} does not exist`);
    if (!slotRow) return fail('23503', `game slot ${slot} does not exist`);
    if (!same(homeTeam.organization_id, orgId))
      return fail('42501', `home team ${home} belongs to another organization`);
    if (!same(awayTeam.organization_id, orgId))
      return fail('42501', `away team ${away} belongs to another organization`);
    if (!same(slotRow.organization_id, orgId))
      return fail('42501', `game slot ${slot} belongs to another organization`);
    const division = (db.divisions || []).find((row) => same(row.id, homeTeam.division_id));
    const slotDivision = (db.divisions || []).find((row) => same(row.id, slotRow.division_id));
    rows.push({
      ordinal,
      id: item.id ? String(item.id).toLowerCase() : null,
      home_team_id: home,
      away_team_id: away,
      game_slot_id: slot,
      slot_id: slot,
      field_id: pick(item, 'field_id', 'fieldId') ?? slotRow.field_id ?? null,
      division:
        pick(item, 'division', 'division_name') ?? division?.name ?? slotDivision?.name ?? null,
      week_index: Math.trunc(Number(week)),
      start,
      end,
      assignment_source: assignmentSource,
    });
  }

  // Each game once.
  const named = rows.filter((row) => row.id !== null).map((row) => row.id);
  const repeated = [...named].sort().find((id, index, all) => all.indexOf(id) !== index);
  if (repeated !== undefined) {
    return fail(
      '22023',
      `game ${repeated} is named more than once in this save`,
      'game_identity_repeated'
    );
  }
  // Each id is a game of THIS organization; another organization's reads as one that does not exist.
  const stored = db.game_assignments || [];
  const mineById = new Map(
    stored
      .filter((row) => same(row.organization_id, orgId))
      .map((row) => [String(row.id).toLowerCase(), row])
  );
  const unknown = [...named].sort().find((id) => !mineById.has(id));
  if (unknown !== undefined) {
    return fail('23503', `game ${unknown} does not exist in this organization`, 'game_not_found');
  }
  // No two games end at one place.
  const clashes = [];
  for (const a of rows.filter((row) => row.id !== null)) {
    const place = tupleOf(a);
    for (const b of rows) {
      if (b.id !== null && b.id > a.id && tupleOf(b) === place) clashes.push([a.id, b.id]);
    }
    for (const game of stored) {
      const id = String(game.id).toLowerCase();
      if (id !== a.id && !named.includes(id) && tupleOf(game) === place) clashes.push([a.id, id]);
    }
    if (rows.some((b) => b.id === null && tupleOf(b) === place)) clashes.push([a.id]);
  }
  if (clashes.length > 0) {
    clashes.sort((x, y) =>
      x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : String(x[1] ?? '￿').localeCompare(String(y[1] ?? '￿'))
    );
    const [first, second] = clashes[0];
    return fail(
      '22023',
      `game ${first} would end where ${second ?? 'a new game of this save'} already is: one place holds one game of a pair (the unique matchup, slot and week)`,
      `game_identity_conflict ids=${[first, second].filter(Boolean).join(',')}`
    );
  }

  // A held game the save leaves out. A game a save can carry: a complete key, in a season that is not completed, in the
  // run's season (the organization's seasons when the run names none).
  const seasonOfGame = (game) => {
    const team = teamOf(game.home_team_id);
    const division = (db.divisions || []).find((row) => same(row.id, team?.division_id));
    return (db.season_settings || []).find((row) => same(row.id, division?.season_settings_id));
  };
  const tuples = new Set(rows.map(tupleOf));
  const omitted = [...mineById.values()]
    .filter((game) => isRowHeld(game) && tupleOf(game) !== null)
    .filter((game) => seasonOfGame(game)?.status !== 'completed')
    .filter((game) => !seasonId || same(seasonOfGame(game)?.id ?? '', seasonId))
    .filter((game) => !named.includes(String(game.id).toLowerCase()) && !tuples.has(tupleOf(game)))
    .map((game) => game.id)
    .sort();
  if (omitted.length > 0) {
    return fail(
      '22023',
      `this save leaves out ${omitted.length} Published game(s): a save carries every Published game of its season, unchanged (allow changes to a game first to move or drop it)`,
      `game_published_omitted count=${omitted.length} ids=${omitted.slice(0, 50).join(',')}`
    );
  }

  // The writes, on copies: nothing changes unless every row is accepted. Named games are updated in place (and may swap
  // places), the rest are upserted on the tuple.
  const next = stored.map((row) => ({ ...row }));
  const runId = pick(runData, 'id') ?? newId();
  const written = [];
  for (const row of rows.filter((r) => r.id !== null)) {
    const at = next.findIndex((game) => same(game.id, row.id));
    const before = next[at];
    const after = {
      ...before,
      run_id: runId,
      game_slot_id: row.game_slot_id,
      slot_id: row.slot_id,
      field_id: row.field_id,
      home_team_id: row.home_team_id,
      away_team_id: row.away_team_id,
      division: row.division,
      week_index: row.week_index,
      start: row.start,
      end: row.end,
      assignment_source: row.assignment_source,
      season_settings_id: seasonId ?? before.season_settings_id ?? null,
      updated_at: now,
    };
    written.push({ before, after });
    next[at] = after;
  }
  for (const row of rows.filter((r) => r.id === null)) {
    const place = tupleOf(row);
    const at = next.findIndex((game) => tupleOf(game) === place);
    if (at >= 0) {
      const before = next[at];
      const after = {
        ...before,
        organization_id: orgId,
        run_id: runId,
        slot_id: row.slot_id,
        field_id: row.field_id,
        division: row.division,
        start: row.start,
        end: row.end,
        assignment_source: row.assignment_source,
        season_settings_id: seasonId ?? before.season_settings_id ?? null,
        updated_at: now,
      };
      written.push({ before, after });
      next[at] = after;
    } else {
      const created = {
        id: newId(),
        organization_id: orgId,
        run_id: runId,
        game_slot_id: row.game_slot_id,
        slot_id: row.slot_id,
        field_id: row.field_id,
        home_team_id: row.home_team_id,
        away_team_id: row.away_team_id,
        division: row.division,
        week_index: row.week_index,
        start: row.start,
        end: row.end,
        assignment_source: row.assignment_source,
        published: false,
        published_at: null,
        published_by: null,
        season_settings_id: seasonId ?? null,
        created_at: now,
        updated_at: now,
      };
      written.push({ before: null, after: created });
      next.push(created);
    }
  }
  // The triggers: a completed season (old and new row), then a held game that would change.
  const completed = scheduleWriteRefusal(
    db,
    'game_assignments',
    written.flatMap(({ before, after }) => (before ? [before, after] : [after]))
  );
  if (completed) return completed;
  const held = publishedWriteRefusal(
    'game_assignments',
    written.filter(({ before }) => before).map(({ before, after }) => ({ before, after }))
  );
  if (held) return held;

  db.game_assignments = next;
  const existingRun = (db.scheduler_runs || []).find((run) => same(run.id, runId));
  const runRow = {
    ...(existingRun || {}),
    id: runId,
    organization_id: orgId,
    season_id: seasonId ?? null,
    season_settings_id: seasonId ?? null,
    run_type: 'game',
    status: runData.status || 'completed',
    parameters: runData.parameters || {},
    metrics: runData.metrics || {},
    results: runData.results || {},
    created_by: ctx.currentUserId,
    started_at: runData.started_at || now,
    completed_at: runData.completed_at || now,
    created_at: existingRun?.created_at || now,
    updated_at: now,
  };
  db.scheduler_runs = existingRun
    ? db.scheduler_runs.map((run) => (same(run.id, runId) ? runRow : run))
    : [...(db.scheduler_runs || []), runRow];
  return { data: runId, error: null };
}
