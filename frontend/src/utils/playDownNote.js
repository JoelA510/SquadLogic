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

const FLAGS_NOT_DECISIONS =
  'Play-up is by request. These are flags: nothing here is approved or refused.';

/**
 * The note under the Division Overview's heading. Off is the default and the words the overview
 * carried before the setting existed.
 * @param {boolean} allowed - the Play-down setting is on
 * @returns {string}
 */
export function playDownOverviewNote(allowed) {
  return allowed
    ? `Play-down is on: a player registered in a younger division plays there, and is flagged. ${FLAGS_NOT_DECISIONS}`
    : `Play-down is not available: a player registered in a younger division is placed in their own age division and shown as moved. ${FLAGS_NOT_DECISIONS}`;
}
