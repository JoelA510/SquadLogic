/**
 * A score the database will not take from a page that still lists the earlier `games` table (Scores, and the
 * Standings page's "Recent Games").
 *
 * Since migration 20261122010000 a score is kept against the SAVED schedule (`game_scores`, keyed by the saved game)
 * and both scores of a game are entered together. Those two pages list rows of the earlier table and save as each
 * cell is typed, so the database answers "Game not found" or "one score without the other", and trying again cannot
 * work. F11-3 of `docs/changes/2026-11-06-games-table-source-of-truth.md` repoints them (its task C3, which is
 * blocking for turning score entry on); until then the page says so in words that stay on the page.
 */

/** What the page says. One sentence for both pages, so they cannot drift. */
export const SCORE_NOT_SAVED_HERE =
  'The score was not saved. Scores are now kept against the saved schedule, and this page still lists games from the earlier games table, so it cannot save a score yet. Nothing was changed.';

/**
 * Whether a refused save is one these pages cannot make as they stand: the database does not find the game (the id is
 * a row of the earlier table, and a score names a saved game), or was sent one score without the other.
 *
 * @param {any} err - the RPC's error
 * @returns {boolean}
 */
export function isScoreNotSavableHere(err) {
  return (
    err?.details === 'score_one_sided' ||
    (err?.code === '42501' && /^Game not found/.test(String(err?.message ?? '')))
  );
}
