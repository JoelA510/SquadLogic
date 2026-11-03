/**
 * What the Teams page says about whether play-down is available (play-down plan, 2026-11-03, PR 3).
 * One place, so every surface that states the rule says the same thing as the Play-down setting it
 * describes. The page reads the setting once and hands each surface a boolean. Off is the default.
 */

/**
 * The clause of the Play-up section's sentence that says who plays where.
 * @param {boolean} allowed - the Play-down setting is on
 * @returns {string}
 */
export function playUpPlaysWhereNote(allowed) {
  return allowed
    ? 'players play in their own age division unless a play-up was requested or, with Play-down on, they registered in a younger division'
    : 'players play in their own age division unless a play-up was requested';
}
