/**
 * The test oracle for `persist_game_schedule`'s identity checks: what the save refuses, computed in plain JavaScript from
 * the stored games and the payload, in the database's order (migration `20261120010000_game_identity.sql`; plan
 * `docs/changes/2026-11-06-games-table-source-of-truth.md`, I1).
 *
 * A TEST HELPER, not shipped core: nothing in the app calls it (the Games page proposes ids and the database decides;
 * lesson 53). It exists so that `tests/mockGameIdentity.test.js` can run one input that reaches every outcome through
 * this and through the mock's own copy of the rules (`frontend/src/lib/mockGameIdentity.js`) and require the two to
 * agree, SQLSTATE and DETAIL included (lesson 77). The two are written independently on purpose: the mock does not
 * import this, so the comparison is never a function with itself. The database's own table is
 * `supabase/tests/game_identity.sql`.
 */
import {
  changesPublishedPlacement,
  publishedOmissions,
} from '../../packages/core/src/gamePublished.js';
import { isHeld } from '../../packages/core/src/gameIdentity.js';

const read = (game, camel, snake) => game?.[camel] ?? game?.[snake];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lower = (value) => String(value).toLowerCase();

/** The matchup tuple (home, away, slot, week) of a row, or null when a part is missing (as in SQL, NULL matches nothing). */
function tupleOf(row) {
  const parts = [
    read(row, 'homeTeamId', 'home_team_id'),
    read(row, 'awayTeamId', 'away_team_id'),
    read(row, 'gameSlotId', 'game_slot_id') ?? read(row, 'slotId', 'slot_id'),
    read(row, 'weekIndex', 'week_index'),
  ];
  return parts.some((part) => part === null || part === undefined || part === '')
    ? null
    : parts.map(lower).join('|');
}

/**
 * The refusal `persist_game_schedule` gives a save that names games by id, or null: the pure twin of the checks in
 * `20261120010000_game_identity.sql`, in the database's order, so the Games page, the mock and a test can say what the
 * database will say. `tests/mockGameIdentity.test.js` holds this and the mock's own copy to the same answers over one
 * input that reaches every outcome (lesson 77).
 *
 * In order: an `id` that is not a uuid (22023 `game_identity_invalid`); a game named twice (22023
 * `game_identity_repeated`); an id that is not a game of the organization, another organization's included, in the same
 * words (23503 `game_not_found`); a game whose stored season is another one than the save's, when the save names one
 * (22023 `game_identity_season`, DETAIL `game_identity_season ids=<first by id>`); a game that would end where another
 * stored game, or another game of the same save, is (22023 `game_identity_conflict`, DETAIL `game_identity_conflict ids=<first>[,<second>]`); a held game the save leaves
 * out (22023 `game_published_omitted count=<n> ids=<first 50>`); a held game moved or flipped (22023 `game_published`).
 * Not here: a completed season (a trigger on the row), the audit, the TIME TBD list.
 *
 * @param {Object} input
 * @param {ReadonlyArray<Record<string, any>>} input.stored - every stored game, of every organization (`organizationId`)
 * @param {ReadonlyArray<Record<string, any>>} input.payload - the save's assignments, with or without an `id`
 * @param {string} input.organizationId - the organization the save is for
 * @param {string | null} [input.seasonId] - the season the save names (none: the season check is skipped)
 * @param {ReadonlyArray<Record<string, any>>} [input.carryable] - the stored games the omission check ranges over (the
 *   caller scopes them to the season, as the database does); default: the organization's stored games
 * @returns {null | { sqlstate: string, detail: string, ids: string[] }}
 */
export function gameIdentityRefusal({ stored, payload, organizationId, seasonId, carryable }) {
  const rows = Array.isArray(payload) ? payload : [];
  const mine = (stored ?? []).filter(
    (game) => lower(read(game, 'organizationId', 'organization_id')) === lower(organizationId)
  );

  // 1. an id is a uuid (absent, null and empty are no id)
  for (const row of rows) {
    const id = row?.id;
    if (id === undefined || id === null || id === '') continue;
    if (typeof id !== 'string' || !UUID.test(id)) {
      return { sqlstate: '22023', detail: 'game_identity_invalid', ids: [] };
    }
  }
  const named = rows
    .map((row) => (typeof row?.id === 'string' && row.id !== '' ? lower(row.id) : null))
    .filter((id) => id !== null);

  // 2. each game once
  // (Set#add returns the set, so an unchanged size means the id was already there.)
  const seen = new Set();
  const repeated = [...named].sort().find((id) => seen.size === seen.add(id).size);
  if (repeated !== undefined)
    return { sqlstate: '22023', detail: 'game_identity_repeated', ids: [repeated] };

  // 3. each id is a game of this organization
  const mineById = new Map(mine.map((game) => [lower(game.id), game]));
  const missing = [...named].sort().find((id) => !mineById.has(id));
  if (missing !== undefined) return { sqlstate: '23503', detail: 'game_not_found', ids: [missing] };

  // 3b. a save that names a season names only games of that season (a game with no stored season, and a save with no
  //     season, are not refused); the first game by id is the one named
  if (seasonId !== undefined && seasonId !== null && seasonId !== '') {
    const elsewhere = [...named].sort().find((id) => {
      const stored = read(mineById.get(id), 'seasonSettingsId', 'season_settings_id');
      return (
        stored !== undefined &&
        stored !== null &&
        stored !== '' &&
        lower(stored) !== lower(seasonId)
      );
    });
    if (elsewhere !== undefined) {
      return {
        sqlstate: '22023',
        detail: `game_identity_season ids=${elsewhere}`,
        ids: [elsewhere],
      };
    }
  }

  // 4. no two games end the save at one place
  const namedIds = new Set(named);
  const ends = rows.map((row) => ({
    id: typeof row?.id === 'string' && row.id !== '' ? lower(row.id) : null,
    tuple: tupleOf(row),
  }));
  const clashes = [];
  for (const a of ends) {
    if (a.id === null || a.tuple === null) continue;
    for (const b of ends) {
      if (b.id !== null && b.id > a.id && b.tuple === a.tuple) clashes.push([a.id, b.id]);
    }
    for (const game of stored ?? []) {
      if (lower(game.id) !== a.id && !namedIds.has(lower(game.id)) && tupleOf(game) === a.tuple) {
        clashes.push([a.id, lower(game.id)]);
      }
    }
    if (ends.some((b) => b.id === null && b.tuple === a.tuple)) clashes.push([a.id]);
  }
  if (clashes.length > 0) {
    // The first by id, a clash with no second game last: the order the database takes it in.
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    clashes.sort((x, y) => cmp(x[0], y[0]) || cmp(x[1] ?? '\uffff', y[1] ?? '\uffff'));
    const ids = clashes[0];
    return { sqlstate: '22023', detail: `game_identity_conflict ids=${ids.join(',')}`, ids };
  }

  // 5. a held game the save leaves out
  const omitted = publishedOmissions([...(carryable ?? mine)], rows);
  if (omitted.length > 0) {
    const ids = omitted.slice(0, 50).map((game) => game.id);
    return {
      sqlstate: '22023',
      detail: `game_published_omitted count=${omitted.length} ids=${ids.join(',')}`,
      ids,
    };
  }

  // 6. a held game moved or flipped (judged on the stored row; by id, or by tuple for an assignment without one)
  for (const row of rows) {
    const stored1 =
      typeof row?.id === 'string' && row.id !== ''
        ? mineById.get(lower(row.id))
        : mine.find((game) => tupleOf(game) !== null && tupleOf(game) === tupleOf(row));
    // As the database stores it: the slot is both columns, and an assignment that names no field keeps the one it has
    // (the database would take the slot's, which this helper cannot see).
    const slot = read(row, 'gameSlotId', 'game_slot_id') ?? read(row, 'slotId', 'slot_id');
    const after = stored1
      ? {
          ...row,
          game_slot_id: slot,
          slot_id: slot,
          field_id: read(row, 'fieldId', 'field_id') ?? read(stored1, 'fieldId', 'field_id'),
        }
      : row;
    if (stored1 && isHeld(stored1) && changesPublishedPlacement(stored1, after)) {
      return { sqlstate: '22023', detail: 'game_published', ids: [stored1.id] };
    }
  }
  return null;
}
