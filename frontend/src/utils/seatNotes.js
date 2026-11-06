/**
 * The notes beside a division's player count that say who moved, so the file's count reconciles with
 * the advice (play-down plan, 2026-11-03, PR 1). The advice counts a player in the division they PLAY
 * in, as generation seats them, and a player the age rule moved to their own age division plays in
 * another division than the one they registered in. One wording, for the overview's Players cell and
 * the settings panel's recommendation. A count of zero has no note.
 *
 * The words say the age rule placed them: that is the only way a seat differs from a registration
 * while the seats come from the placement. A player moved by hand in the roster editor is worded by
 * the roster list (`rosterAgeFlags.js`), not here.
 *
 * PR 2 adds the flags: how many play up or down, and the words for them, once, for the overview's
 * column, its league line, its program headings and the Play-up section (`playUpReview.js`). An
 * unknown is a word of its own, never "None" (lesson 47): the age or the division's band is not
 * known, so nothing was compared.
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

/**
 * The note for the players who asked to play up and have nothing to honour: they registered in the
 * division they play in, so the request moves nobody (owner decision 5: its own line, never a play-up).
 * @param {number} count
 * @returns {string}
 */
export function askedToPlayUpNote(count) {
  return `${count} asked to play up, registered in their own division`;
}

/** Why a seat cannot be compared with its division: said wherever a count of them is. */
export const NOT_CHECKED_REASON = 'no age, or no age band';

/**
 * The flag counts a view shows, taken from a `SeatCounts` (`summarizeSeats`). `checked` is false
 * while the season's divisions have not been read: no band is known then, so every seat would read
 * "not checked" and every request "nothing to honour", which is a statement about the divisions that
 * were never read, not about the players.
 *
 * @param {{ playingUp: number, playingDown: number, askedToPlayUp: number, notChecked: number,
 *   movedIn: number }} counts
 * @param {boolean} checked
 * @returns {{ playingUp: number, playingDown: number, askedToPlayUp: number, notChecked: number,
 *   movedIn: number, checked: boolean }}
 */
export function flagCountsOf(counts, checked) {
  return {
    playingUp: counts.playingUp,
    playingDown: counts.playingDown,
    askedToPlayUp: counts.askedToPlayUp,
    notChecked: counts.notChecked,
    movedIn: counts.movedIn,
    checked,
  };
}

const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * Are the flag counts a row carries something to read? Not when the row has none (a caller that has
 * never heard of them) or when the divisions behind them were not read: nothing was compared, and
 * that is never shown as a clean "None".
 * @param {any} flags
 */
export function flagsAreKnown(flags) {
  return (
    flags !== null &&
    typeof flags === 'object' &&
    flags.checked !== false &&
    isCount(flags.playingUp) &&
    isCount(flags.playingDown) &&
    isCount(flags.notChecked)
  );
}

/** What the column says when there are no counts to read. */
export const NOT_CHECKED_YET = 'Not checked yet';

/**
 * The lines of the overview's "Play-up and play-down" cell: each count that is not zero, in words,
 * or "None" when nobody plays up or down and nothing is unchecked; "Not checked yet" when the counts
 * are not known. An unchecked seat is never folded into "None".
 * @param {any} flags - `flagCountsOf`
 * @returns {Array<{ key: 'up' | 'down' | 'unchecked' | 'none' | 'unknown', text: string }>}
 */
export function flagLines(flags) {
  if (!flagsAreKnown(flags)) return [{ key: 'unknown', text: NOT_CHECKED_YET }];
  /** @type {Array<{ key: 'up' | 'down' | 'unchecked', text: string }>} */
  const lines = [];
  if (flags.playingUp > 0) lines.push({ key: 'up', text: `${flags.playingUp} playing up` });
  if (flags.playingDown > 0) {
    lines.push({ key: 'down', text: `${flags.playingDown} playing down` });
  }
  if (flags.notChecked > 0) {
    lines.push({
      key: 'unchecked',
      text: `${flags.notChecked} not checked (${NOT_CHECKED_REASON})`,
    });
  }
  return lines.length > 0 ? lines : [{ key: 'none', text: 'None' }];
}

/**
 * The counts in one phrase, zero shown as zero: "3 playing up, 0 playing down", with the unchecked
 * and the requests with nothing to honour added only when there are some. For a program heading and
 * the league line. "Not checked yet" when the counts are not known.
 * @param {any} flags - `flagCountsOf`
 * @returns {string}
 */
export function flagSummary(flags) {
  if (!flagsAreKnown(flags)) return NOT_CHECKED_YET.toLowerCase();
  const parts = [`${flags.playingUp} playing up`, `${flags.playingDown} playing down`];
  if (flags.notChecked > 0) parts.push(`${flags.notChecked} not checked`);
  if (isCount(flags.askedToPlayUp) && flags.askedToPlayUp > 0) {
    parts.push(`${flags.askedToPlayUp} asked to play up from their own division`);
  }
  return parts.join(', ');
}

/**
 * The note for the players who registered in another program and play in this one.
 * @param {number} count
 * @returns {string}
 */
export function movedInFromProgramsNote(count) {
  return count === 1 ? '1 moved in from another program' : `${count} moved in from other programs`;
}
