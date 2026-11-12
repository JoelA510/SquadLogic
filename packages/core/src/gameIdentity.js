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

/** The slot a game is in (either spelling of it), or null when it names none. */
const slotOf = (game) => {
  const slot = read(game, 'gameSlotId', 'game_slot_id') ?? read(game, 'slotId', 'slot_id');
  return typeof slot === 'string' && slot !== '' ? slot : null;
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
 * Since 20261122010000 (F11-2) a game with a score is held too. Whether it has one is the game's own `scored` flag,
 * which `useGameAssignments` sets from `game_scores` for every game it loads. There is ONE argument on purpose: a
 * second, optional one would be filled by an array callback's index (`games.filter(isHeld)` hands `(game, index)`),
 * and a scored game at index 0 would read as not held. Only a boolean `true` counts, for either flag.
 *
 * @param {{ published?: unknown, scored?: unknown } | null | undefined} game
 * @returns {boolean}
 */
export function isHeld(game) {
  return game?.published === true || game?.scored === true;
}

/**
 * Why a held game is held, for the words of a refusal: the database's `game_hold_code`. A held game that is Published is
 * `'published'` (changes to it must be allowed first, whether or not it also has a score); one that is not is held by
 * its score. Null when the game is not held: this never decides whether a game is held. One argument, as `isHeld`.
 *
 * @param {{ published?: unknown, scored?: unknown } | null | undefined} game
 * @returns {'published' | 'scored' | null}
 */
export function holdReason(game) {
  if (!isHeld(game)) return null;
  return game?.published === true ? 'published' : 'scored';
}

/**
 * Tell each regenerated game which saved game it continues.
 *
 * A saved game and a regenerated game are the same game when they are between the same two teams (either side hosting:
 * a flipped pair is the same game), preferring the same week and then the nearest week; one saved game goes to one
 * regenerated game and no saved game is claimed twice. A pair that meets twice (a double round robin) is matched meeting
 * to meeting by week, not by the order the games are given in.
 *
 * How the matching is decided, per pair: every (saved, regenerated) combination is ordered first by whether the two are
 * at the same place (the same slot AND the same week: a combination that is, comes before any that is not), then by how
 * far apart their weeks are, then by the earlier saved week, then by the earlier regenerated week, then by the order
 * given; the combinations are taken in that order, skipping any whose saved or regenerated game is already taken. The
 * count matched is the smaller of the two counts, and the answer does not depend on the order the games are given in
 * unless two combinations are identical in all four. The exact place comes first because the save updates a game in
 * place: a game that takes the id of a saved game of its pair that is somewhere else MOVES that game, and if another
 * saved game of the pair already holds that place the save refuses the whole Apply (`game_identity_conflict`). A pair
 * with two saved games in one week, at slots s1 and s2, and one regenerated meeting at s2 therefore gives it to the
 * saved game at s2, whichever of the two is listed first.
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
        const slot = slotOf(s.game);
        candidates.push({
          s,
          g,
          // The same slot and the same week: the place the saved game is already at.
          exact: slot !== null && slot === slotOf(g.game) && weekOf(s.game) === weekOf(g.game),
          distance: Math.abs(weekOf(s.game) - weekOf(g.game)),
          savedWeek: weekOf(s.game),
          generatedWeek: weekOf(g.game),
        });
      }
    }
    candidates.sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
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
