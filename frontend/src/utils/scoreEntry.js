/**
 * Entering a score, one box at a time, for a database that takes both numbers of a game together (F11-2, decision
 * D10: a score is both or none; `update_game_score` refuses one without the other). The Scores page and the Standings
 * page's "Recent Games" share this, so the two cannot drift.
 *
 * A game's score on screen is the saved one with a DRAFT over it: what was typed and is not saved yet. One number
 * with the other empty is a draft and nothing is sent; both numbers is a result, both empty is a clear, and either is
 * sent when it differs from what is saved.
 */

/** A box as typed: empty is `null`; anything that is not a whole number is `null` too. */
export function parseScore(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * What typing `value` into one side means.
 *
 * @param {{ score_home: number | null, score_away: number | null }} saved - the score as stored
 * @param {{ score_home: number | null, score_away: number | null } | undefined} draft - what is typed and unsaved
 * @param {'score_home' | 'score_away'} side
 * @param {unknown} value
 * @returns {{ entry: { score_home: number | null, score_away: number | null }, send: boolean }} `entry` is what the
 *   boxes now hold; `send` says it is a whole result (or a whole clear) that differs from the saved score
 */
export function typeScore(saved, draft, side, value) {
  const shown = draft ?? {
    score_home: saved.score_home ?? null,
    score_away: saved.score_away ?? null,
  };
  const entry = { ...shown, [side]: parseScore(value) };
  const whole = (entry.score_home === null) === (entry.score_away === null);
  const changed =
    entry.score_home !== (saved.score_home ?? null) ||
    entry.score_away !== (saved.score_away ?? null);
  return { entry, send: whole && changed };
}

/** Whether what the boxes hold is one number without the other. */
export function isHalfEntered(entry) {
  return Boolean(entry) && (entry.score_home === null) !== (entry.score_away === null);
}

/**
 * Why the database did not take a score, in words for the page (never a code). Each ends by saying nothing changed.
 *
 * @param {any} err - the RPC's error
 * @returns {string}
 */
export function scoreRefusalText(err) {
  const details = String(err?.details ?? '');
  if (details === 'game_not_current' || /^Game not found/.test(String(err?.message ?? ''))) {
    return 'The score was not saved. This game is no longer in the saved schedule: reload the page to see the schedule as it is now. Nothing was changed.';
  }
  if (details === 'season_completed') {
    return 'The score was not saved. This game belongs to a completed season, whose scores are history. Nothing was changed.';
  }
  if (err?.code === '55000') {
    return 'The score was not saved. Score entry is turned off for this league: an admin turns it on in Settings, under Features. Nothing was changed.';
  }
  if (details === 'score_one_sided') {
    return 'The score was not saved. A result needs both scores: enter both, or clear both. Nothing was changed.';
  }
  return 'The score was not saved. Try again. Nothing was changed.';
}
