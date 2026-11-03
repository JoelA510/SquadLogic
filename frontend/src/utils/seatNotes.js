/**
 * The notes beside a division's player count that say who moved, so the file's count reconciles with
 * the advice (play-down plan, 2026-11-03, PR 1). The advice counts a player in the division they PLAY
 * in, as generation seats them, and a player the age rule moved to their own age division plays in
 * another division than the one they registered in. One wording, for the overview's Players cell and
 * the settings panel's recommendation. A count of zero has no note.
 *
 * The words say the age rule placed them: that is the only way a seat differs from a registration
 * while the seats come from the placement. A player moved by hand in the roster editor is worded by
 * the roster list (PR 2), not here.
 */

/**
 * The note for the players registered in other divisions who play in this one.
 * @param {number} count
 * @returns {string}
 */
export function movedHereNote(count) {
  return count === 1
    ? '1 moved here from another division'
    : `${count} moved here from other divisions`;
}

/**
 * The note for the players registered in this division who play in another, in their own age
 * division.
 * @param {number} count
 * @returns {string}
 */
export function movedAwayNote(count) {
  return `${count} registered here, placed in their own age division`;
}
