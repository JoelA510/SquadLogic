import { carryGameIds } from '@squadlogic/core/gameIdentity.js';

/**
 * The staged review matched again to the saved schedule as it is now (F11-3, review R1).
 *
 * A save refused for a game's identity (409 `GAME_IDENTITY`: a game removed, of another season, named twice, or
 * colliding) means the review names saved games by ids the database no longer has where the review thinks. After the
 * saved schedule is read again, each staged game is matched again: one whose saved id still exists keeps it; one whose
 * id is gone, and every new game, is matched by `carryGameIds` (the same pair, the nearest week) to a saved game no
 * other staged game holds, or stays a new game. `changed` says whether any id moved: an unchanged review would be
 * refused again, so the page discards it instead.
 *
 * @param {ReadonlyArray<Record<string, any>>} review - the staged games, as the page displays them (`persisted`, `id`)
 * @param {ReadonlyArray<Record<string, any>>} saved - the saved games of the current run, as read now
 * @returns {{ review: Array<Record<string, any>>, changed: boolean }}
 */
export function rekeyReview(review, saved) {
  const savedIds = new Set(saved.map((row) => String(row.id)));
  const prepared = review.map((game) =>
    game.persisted === true && savedIds.has(String(game.id)) ? game : { ...game, id: undefined }
  );
  const carried = carryGameIds([...saved], prepared);
  let changed = false;
  const next = carried.map((game, index) => {
    const before = review[index];
    const savedId = typeof game.id === 'string' && savedIds.has(game.id) ? game.id : null;
    const was = before.persisted === true ? String(before.id) : null;
    if (savedId !== was) changed = true;
    if (savedId !== null) return { ...before, id: savedId, persisted: true };
    return {
      ...before,
      id: before.persisted === true ? `review-rekeyed-${index}-${String(before.id)}` : before.id,
      persisted: false,
    };
  });
  return { review: next, changed };
}
