/**
 * Game identity: which saved game a regenerated game continues, and whether a game is held where it is.
 *
 * Plan of record: `docs/changes/2026-11-06-games-table-source-of-truth.md`, "Identity (F11-1)", I2 and I3. A game is
 * its saved row's `id`: `persist_game_schedule` updates a game in place when an assignment names it, so a game keeps
 * its Published flag, its history and (later) its score through a move, a flip or a regeneration. The server checks
 * every id it is sent (it exists in the organization, appears once, may be changed); what this module computes is the
 * page's PROPOSAL (lesson 53), made after the generator has run and before the review is shown.
 *
 * Pure and framework-free: no React, no I/O.
 *
 * @module gameIdentity
 */

import { changesPublishedPlacement, publishedOmissions } from './gamePublished.js';

const read = (game, camel, snake) => game?.[camel] ?? game?.[snake];

const idOf = (game) => {
  const id = game?.id;
  return typeof id === 'string' && id !== '' ? id : null;
};

/** The unordered pair a game is between, or null when it names no pair (a missing team, or a team against itself). */
function pairOf(game) {
  const home = read(game, 'homeTeamId', 'home_team_id');
  const away = read(game, 'awayTeamId', 'away_team_id');
  if (
    typeof home !== 'string' ||
    typeof away !== 'string' ||
    home === '' ||
    away === '' ||
    home === away
  ) {
    return null;
  }
  return home < away ? `${home}\u0000${away}` : `${away}\u0000${home}`;
}

const weekOf = (game) => {
  const week = read(game, 'weekIndex', 'week_index');
  return Number.isFinite(week) ? /** @type {number} */ (week) : 0;
};

/**
 * Whether a game is held where it is: it cannot be moved, cancelled, dropped by a save or re-solved by a regeneration.
 * A game is held when it is Published, or (F11-2) when it has a score. The score is not a column of the saved game, so
 * the caller says whether it has one. The database's twin is `game_is_held` / `game_held_ids`
 * (`20261120010000_game_identity.sql`); this and those are the one definition of "held", each in its own language, and
 * `tests/mockGameIdentity.test.js` holds them to the same answers.
 *
 * Only a boolean `true` holds: a string such as `'true'` is not a flag (the database column is a boolean).
 *
 * @param {{ published?: unknown } | null | undefined} game
 * @param {boolean} [scored] - whether the game has a score (false until scores exist)
 * @returns {boolean}
 */
export function isHeld(game, scored = false) {
  return game?.published === true || scored === true;
}

/**
 * Tell each regenerated game which saved game it continues.
 *
 * A saved game and a regenerated game are the same game when they are between the same two teams (either side hosting:
 * a flipped pair is the same game), preferring the same week and then the nearest week; one saved game goes to one
 * regenerated game and no saved game is claimed twice. A pair that meets twice (a double round robin) is matched meeting
 * to meeting by week, not by the order the games are given in.
 *
 * How the matching is decided, per pair: every (saved, regenerated) combination is ordered by how far apart their
 * weeks are, then by the earlier saved week, then by the earlier regenerated week, then by the order given; the
 * combinations are taken in that order, skipping any whose saved or regenerated game is already taken. The count matched
 * is the smaller of the two counts, and the answer does not depend on the order the games are given in unless two
 * combinations are identical in all three weeks.
 *
 * A regenerated game that already carries the id of a saved game keeps it and that saved game is spent (the generator
 * hands a held game back as itself: it must not lose its id to a free game of the same pair). A regenerated game that
 * carries an id that names no saved game is left alone and takes part in nothing. Two regenerated games carrying one
 * saved id is a caller error and throws.
 *
 * @template {Record<string, any>} G
 * @param {ReadonlyArray<Record<string, any>>} saved - the saved games of the schedule being regenerated (rows with an `id`)
 * @param {ReadonlyArray<G>} generated - the regenerated games, in the generator's order
 * @returns {Array<G & { id?: string }>} one game for each given, in the same order; a matched game is a copy with its
 *   saved `id`, any other is the very object it was given. The inputs are not changed.
 */
export function carryGameIds(saved, generated) {
  if (!Array.isArray(saved)) throw new TypeError('saved must be an array');
  if (!Array.isArray(generated)) throw new TypeError('generated must be an array');

  const savedById = new Map();
  for (const game of saved) {
    const id = idOf(game);
    if (id !== null && !savedById.has(id)) savedById.set(id, game);
  }

  // Saved games spent by a regenerated game that already carries their id.
  const spent = new Set();
  for (const game of generated) {
    const id = idOf(game);
    if (id === null || !savedById.has(id)) continue;
    if (spent.has(id)) {
      throw new Error(`two regenerated games carry the saved game ${id}`);
    }
    spent.add(id);
  }

  // Group what is left by unordered pair.
  /** @type {Map<string, { saved: Array<{ game: Record<string, any>, order: number }>, generated: Array<{ game: G, index: number }> }>} */
  const groups = new Map();
  const groupFor = (key) => {
    let group = groups.get(key);
    if (!group) {
      group = { saved: [], generated: [] };
      groups.set(key, group);
    }
    return group;
  };
  let order = 0;
  for (const game of saved) {
    const id = idOf(game);
    const key = pairOf(game);
    order += 1;
    if (id === null || key === null || spent.has(id) || savedById.get(id) !== game) continue;
    groupFor(key).saved.push({ game, order });
  }
  generated.forEach((game, index) => {
    if (idOf(game) !== null) return; // carries an id already: kept as it is, takes part in nothing
    const key = pairOf(game);
    if (key === null) return;
    groupFor(key).generated.push({ game, index });
  });

  const claimed = new Map(); // generated index -> saved id
  for (const group of groups.values()) {
    if (group.saved.length === 0 || group.generated.length === 0) continue;
    const candidates = [];
    for (const s of group.saved) {
      for (const g of group.generated) {
        candidates.push({
          s,
          g,
          distance: Math.abs(weekOf(s.game) - weekOf(g.game)),
          savedWeek: weekOf(s.game),
          generatedWeek: weekOf(g.game),
        });
      }
    }
    candidates.sort(
      (a, b) =>
        a.distance - b.distance ||
        a.savedWeek - b.savedWeek ||
        a.generatedWeek - b.generatedWeek ||
        a.s.order - b.s.order ||
        a.g.index - b.g.index
    );
    const takenSaved = new Set();
    const takenGenerated = new Set();
    for (const { s, g } of candidates) {
      if (takenSaved.has(s.order) || takenGenerated.has(g.index)) continue;
      takenSaved.add(s.order);
      takenGenerated.add(g.index);
      claimed.set(g.index, /** @type {string} */ (idOf(s.game)));
    }
  }

  return generated.map((game, index) => {
    const id = claimed.get(index);
    return id === undefined ? game : { ...game, id };
  });
}

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
 * words (23503 `game_not_found`); a game that would end where another stored game, or another game of the same save, is
 * (22023 `game_identity_conflict`, DETAIL `game_identity_conflict ids=<first>[,<second>]`); a held game the save leaves
 * out (22023 `game_published_omitted count=<n> ids=<first 50>`); a held game moved or flipped (22023 `game_published`).
 * Not here: a completed season (a trigger on the row), the audit, the TIME TBD list.
 *
 * @param {Object} input
 * @param {ReadonlyArray<Record<string, any>>} input.stored - every stored game, of every organization (`organizationId`)
 * @param {ReadonlyArray<Record<string, any>>} input.payload - the save's assignments, with or without an `id`
 * @param {string} input.organizationId - the organization the save is for
 * @param {ReadonlyArray<Record<string, any>>} [input.carryable] - the stored games the omission check ranges over (the
 *   caller scopes them to the season, as the database does); default: the organization's stored games
 * @returns {null | { sqlstate: string, detail: string, ids: string[] }}
 */
export function gameIdentityRefusal({ stored, payload, organizationId, carryable }) {
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
